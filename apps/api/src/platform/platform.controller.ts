import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Ip,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Body,
  Query,
  Req,
  UseGuards
} from "@nestjs/common";
import type { Request } from "express";
import {
  API_ROUTES,
  createPlatformAdminSchema,
  pageQuerySchema,
  setTenantModulesSchema,
  setTenantPlanSchema,
  updatePlanSchema,
  updateTenantSchema,
  updateTenantSeatsSchema,
  updateTenantStatusSchema,
  updateUserStatusSchema,
  userQuerySchema,
  type ActivityEntry,
  type CatalogPermission,
  type CreatePlatformAdminInput,
  type Page,
  type PageQuery,
  type Plan,
  type PlatformAdmin,
  type PlatformAdminCreated,
  type ReissuedInvitation,
  type SetTenantModulesInput,
  type SetTenantPlanInput,
  type TenantDetail,
  type TenantModule,
  type TenantSummary,
  type UpdatePlanInput,
  type UpdateTenantInput,
  type UpdateTenantSeatsInput,
  type UpdateTenantStatusInput,
  type UpdateUserStatusInput,
  type UserDetail,
  type UserQuery,
  type UserSummary
} from "@growpath/contracts";
import {
  PlatformTenantMissingError,
  UserAlreadyActiveError,
  UserHasNoCredentialError
} from "@growpath/db";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { PlatformGuard, RequiresPlatformPermission } from "../auth/platform.guard";
import { actorFrom } from "../common/actor";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { PlatformService, SelfSuspensionError } from "./platform.service";

/**
 * The cross-tenant screens.
 *
 * Every route is a deliberate sibling of a tenant-scoped one rather than a
 * widening of it. `GET /tenants` answers "my tenant" and `GET /platform/tenants`
 * answers "all of them"; one route whose meaning depended on the caller's
 * permissions would be a route where forgetting the check silently hands the
 * customer list to every tenant — the regression US-063 exists to prevent.
 *
 * Both guards are applied at the controller so a route added later inherits
 * them. Order matters and is the declared order: `AccessTokenGuard` establishes
 * the verified claims, `PlatformGuard` reads them. The second fails closed if
 * the first is ever removed.
 */
@Controller()
@UseGuards(AccessTokenGuard, PlatformGuard)
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  /** Every tenant, paged, searchable and sortable like the scoped list. */
  @Get(API_ROUTES.platformTenants)
  @RequiresPlatformPermission("platform.tenant.read")
  listTenants(
    @Query(new ZodValidationPipe(pageQuerySchema)) query: PageQuery
  ): Promise<Page<TenantSummary>> {
    return this.platform.listTenants(query);
  }

  @Get(API_ROUTES.platformTenant)
  @RequiresPlatformPermission("platform.tenant.read")
  async findTenant(@Param("id") id: string): Promise<TenantDetail> {
    const tenant = await this.platform.findTenant(id);
    if (!tenant) {
      throw new NotFoundException({ message: "Tenant not found." });
    }
    return tenant;
  }

  @Get(API_ROUTES.platformTenantActivity)
  @RequiresPlatformPermission("platform.tenant.read")
  async tenantActivity(@Param("id") id: string): Promise<ActivityEntry[]> {
    const entries = await this.platform.tenantActivity(id);
    if (!entries) {
      throw new NotFoundException({ message: "Tenant not found." });
    }
    return entries;
  }

  /**
   * A lifecycle transition on any tenant.
   *
   * Takes the state to reach rather than the verb to apply, so a retried request
   * is a no-op instead of a second transition — the same contract as the
   * tenant-scoped route, because an operator and an administrator pressing the
   * same button should not get different semantics.
   */
  @Patch(API_ROUTES.platformTenantStatus)
  @RequiresPlatformPermission("platform.tenant.write")
  async setTenantStatus(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateTenantStatusSchema)) dto: UpdateTenantStatusInput,
    @Req() request: Request,
    @Ip() ip: string
  ): Promise<TenantDetail> {
    const tenant = await this.platform.setTenantStatus(id, dto.status, actorFrom(request, ip));
    if (!tenant) {
      throw new NotFoundException({ message: "Tenant not found." });
    }
    return tenant;
  }

  /**
   * A tenant's commercial plan, and cancelling it (US-072).
   *
   * A distinct permission from the lifecycle route above, because the two are
   * distinct decisions: suspending a tenant locks their people out, and
   * unsubscribing one need not. An installation that wants a support operator
   * who can do the first but not the second can now express that.
   */
  @Patch(API_ROUTES.platformTenantPlan)
  @RequiresPlatformPermission("platform.plan.write")
  async setTenantPlan(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(setTenantPlanSchema)) dto: SetTenantPlanInput,
    @Req() request: Request,
    @Ip() ip: string
  ): Promise<TenantDetail> {
    const tenant = await this.platform.setTenantPlan(
      id,
      dto.plan,
      dto.unsubscribe ?? false,
      actorFrom(request, ip)
    );
    if (!tenant) {
      throw new NotFoundException({ message: "Tenant not found." });
    }
    return tenant;
  }

  /**
   * A fresh invitation for a tenant's administrator.
   *
   * The operator's remedy for a tenant stuck at `pending` — a status derived
   * from "nobody here has signed in yet", which no lifecycle transition can
   * clear. Under `platform.tenant.write`, beside the lifecycle transitions,
   * because it is the same kind of operational repair.
   *
   * 409 when the administrator already has a password: they do not need an
   * invitation, and issuing one would be a password reset wearing the wrong
   * name. The check lives in `issueInvitation` so every caller inherits it.
   */
  @Post(API_ROUTES.platformTenantAdminInvitation)
  @HttpCode(201)
  @RequiresPlatformPermission("platform.tenant.write")
  async reissueAdminInvitation(
    @Param("id") id: string,
    @Req() request: Request,
    @Ip() ip: string
  ): Promise<ReissuedInvitation> {
    try {
      const result = await this.platform.reissueAdminInvitation(
        id,
        actorFrom(request, ip)
      );
      if (!result) {
        throw new NotFoundException({ message: "Tenant not found." });
      }
      return result;
    } catch (err) {
      if (err instanceof UserAlreadyActiveError) {
        throw new ConflictException({ message: err.message });
      }
      throw err;
    }
  }

  /**
   * A tenant's editable details — its name.
   *
   * Under `platform.tenant.write`, the same key as the lifecycle transitions
   * beside it: renaming is an operational correction, not a commercial
   * decision. The slug is not editable; see `updateTenantSchema`.
   */
  @Patch(API_ROUTES.platformTenantUpdate)
  @RequiresPlatformPermission("platform.tenant.write")
  async updateTenant(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateTenantSchema)) dto: UpdateTenantInput,
    @Req() request: Request,
    @Ip() ip: string
  ): Promise<TenantDetail> {
    const tenant = await this.platform.setTenantName(id, dto.name, actorFrom(request, ip));
    if (!tenant) {
      throw new NotFoundException({ message: "Tenant not found." });
    }
    return tenant;
  }

  /**
   * A tenant's negotiated seat allowance, or `null` to inherit its package.
   *
   * Under `platform.plan.write` rather than `platform.tenant.write`: this is a
   * commercial decision about what a customer may have, the same kind of
   * decision as moving them between packages — not an operational one like
   * suspending them. An installation that wants a support operator who can
   * suspend a tenant but not re-sell to them can express that.
   */
  @Patch(API_ROUTES.platformTenantSeats)
  @RequiresPlatformPermission("platform.plan.write")
  async setTenantSeats(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateTenantSeatsSchema)) dto: UpdateTenantSeatsInput,
    @Req() request: Request,
    @Ip() ip: string
  ): Promise<TenantDetail> {
    const tenant = await this.platform.setTenantSeats(
      id,
      dto.seatLimit,
      actorFrom(request, ip)
    );
    if (!tenant) {
      throw new NotFoundException({ message: "Tenant not found." });
    }
    return tenant;
  }

  /** The module catalogue, marked with what this tenant holds. */
  @Get(API_ROUTES.platformTenantModules)
  @RequiresPlatformPermission("platform.tenant.read")
  async tenantModules(@Param("id") id: string): Promise<TenantModule[]> {
    const modules = await this.platform.listTenantModules(id);
    if (!modules) {
      throw new NotFoundException({ message: "Tenant not found." });
    }
    return modules;
  }

  /**
   * Replaces the set of modules a tenant holds.
   *
   * `PUT`, not `PATCH`: the body is the complete set the tenant should hold
   * afterwards, so the request is idempotent and a retry cannot half-apply. The
   * same shape as replacing a role's permissions, for the same reason.
   */
  @Put(API_ROUTES.platformTenantModules)
  @RequiresPlatformPermission("platform.module.write")
  async setTenantModules(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(setTenantModulesSchema)) dto: SetTenantModulesInput,
    @Req() request: Request,
    @Ip() ip: string
  ): Promise<TenantModule[]> {
    const modules = await this.platform.setTenantModules(
      id,
      dto.modules,
      actorFrom(request, ip)
    );
    if (!modules) {
      throw new NotFoundException({ message: "Tenant not found." });
    }
    return modules;
  }

  /** Every user across every tenant. Each row carries the tenant it belongs to. */
  @Get(API_ROUTES.platformUsers)
  @RequiresPlatformPermission("platform.user.read")
  listUsers(
    @Query(new ZodValidationPipe(userQuerySchema)) query: UserQuery
  ): Promise<Page<UserSummary>> {
    return this.platform.listUsers(query);
  }

  @Get(API_ROUTES.platformUser)
  @RequiresPlatformPermission("platform.user.read")
  async findUser(@Param("id") id: string): Promise<UserDetail> {
    const user = await this.platform.findUser(id);
    if (!user) {
      throw new NotFoundException({ message: "User not found." });
    }
    return user;
  }

  @Patch(API_ROUTES.platformUserStatus)
  @RequiresPlatformPermission("platform.user.write")
  async setUserStatus(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateUserStatusSchema)) dto: UpdateUserStatusInput,
    @Req() request: Request,
    @Ip() ip: string
  ): Promise<UserDetail> {
    let user: UserDetail | null;
    try {
      user = await this.platform.setUserStatus(id, dto.status, actorFrom(request, ip));
    } catch (err) {
      if (err instanceof SelfSuspensionError || err instanceof UserHasNoCredentialError) {
        // 400 with the reason. Both are things the caller can act on — sign in
        // as someone else, or reissue the invitation — and a bare 500 from the
        // check constraint would say neither.
        throw new BadRequestException({ message: err.message });
      }
      throw err;
    }

    if (!user) {
      throw new NotFoundException({ message: "User not found." });
    }
    return user;
  }

  // ── The operator tier's own administration ───────────────────────────────

  /**
   * Everybody holding the platform role.
   *
   * Gated on `platform.user.read` rather than a key of its own. Any operator can
   * already list every user in every tenant, and the operators live in one of
   * those tenants — a separate read permission here would withhold a subset of
   * what the caller can already fetch from `GET /platform/users`.
   */
  @Get(API_ROUTES.platformAdmins)
  @RequiresPlatformPermission("platform.user.read")
  listAdmins(): Promise<PlatformAdmin[]> {
    return this.platform.listAdmins();
  }

  /**
   * Mints another operator and returns their one-time invitation.
   *
   * The most consequential write in the system — it hands somebody reach over
   * every tenant — so it carries its own permission rather than riding on
   * `platform.user.write`, which is about suspending accounts.
   *
   * Returns 201 with `invitation: null` when the address already belongs to an
   * active operator. Deliberately not a 409: nothing failed, nothing changed,
   * and the caller's stated goal ("this person should be an operator") is
   * already true. Reissuing an invitation instead would be an account takeover
   * available to anyone who can reach this route.
   */
  @Post(API_ROUTES.platformAdmins)
  @RequiresPlatformPermission("platform.admin.write")
  async createAdmin(
    @Body(new ZodValidationPipe(createPlatformAdminSchema)) dto: CreatePlatformAdminInput,
    @Req() request: Request,
    @Ip() ip: string
  ): Promise<PlatformAdminCreated> {
    try {
      return await this.platform.createAdmin(dto, actorFrom(request, ip));
    } catch (err) {
      if (err instanceof PlatformTenantMissingError) {
        // The database is behind the code — the reserved tenant is created by
        // migration, not by this call. Saying so beats a bare 500, because the
        // fix is "run the migrations" and nothing else would suggest it.
        throw new BadRequestException({ message: err.message });
      }
      throw err;
    }
  }

  /**
   * Every permission the installation defines.
   *
   * Read-only, and there is no writing counterpart anywhere: `permission` is a
   * global table the application holds `SELECT` on and nothing else. What is
   * editable is which permissions a *role* holds, which is a tenant-scoped
   * screen.
   */
  @Get(API_ROUTES.platformPermissions)
  @RequiresPlatformPermission("platform.tenant.read")
  listPermissions(): Promise<CatalogPermission[]> {
    return this.platform.listPermissions();
  }

  /**
   * Every package on offer, and the seats each includes.
   *
   * Gated on `platform.tenant.read` rather than `platform.plan.write`, because
   * reading the catalogue and changing a customer's package are different acts.
   * An operator who may look at tenants but not re-sell to them still needs the
   * numbers — the tenant list renders "24 of 25 users" from them, and withholding
   * that would leave the read-only screens unable to say why an invitation was
   * refused.
   */
  @Get(API_ROUTES.platformPlans)
  @RequiresPlatformPermission("platform.tenant.read")
  listPlans(): Promise<Plan[]> {
    return this.platform.listPlans();
  }

  /**
   * Changes how many users a package includes.
   *
   * Under `platform.plan.write`, the same key that moves one tenant between
   * packages and that sets one tenant's negotiated figure. All three are the
   * same kind of decision — what a customer may have — and an installation that
   * separated them would be inventing a distinction it then had to staff.
   *
   * The reach is what makes this the sharpest edge on that permission: a
   * per-tenant override touches one customer, and this touches every tenant on
   * the package that has not negotiated one. The response carries the whole
   * catalogue with its tenant counts so the screen can show what just moved.
   */
  @Patch(API_ROUTES.platformPlan)
  @RequiresPlatformPermission("platform.plan.write")
  async setPlanUserLimit(
    @Param("key") key: string,
    @Body(new ZodValidationPipe(updatePlanSchema)) dto: UpdatePlanInput,
    @Req() request: Request,
    @Ip() ip: string
  ): Promise<Plan[]> {
    const plans = await this.platform.setPlanUserLimit(
      key,
      dto.userLimit,
      actorFrom(request, ip)
    );
    if (!plans) {
      throw new NotFoundException({ message: "Package not found." });
    }
    return plans;
  }
}
