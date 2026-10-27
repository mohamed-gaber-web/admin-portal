import {
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards
} from "@nestjs/common";
import type { Request } from "express";
import {
  API_ROUTES,
  createTenantSchema,
  pageQuerySchema,
  type ActivityEntry,
  type CreateTenantInput,
  type Page,
  type PageQuery,
  type ProvisionedTenant,
  type TenantDetail,
  type TenantSummary
} from "@growpath/contracts";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { PlatformGuard, RequiresPlatformPermission } from "../auth/platform.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { TenantService } from "./tenant.service";
import { actorFrom } from "../common/actor";

/**
 * Tenant provisioning and administration.
 *
 * The guard is applied per route rather than to the controller, because the
 * routes here answer to two different authorities: the reads are the caller's
 * own tenant, while provisioning creates a tenant that belongs to nobody yet and
 * is a platform operation.
 *
 * There is deliberately no lifecycle transition here. Whether a workspace runs
 * is the operator's decision, like which modules it holds — a tenant-scoped
 * `PATCH /tenants/:id/status` let any signed-in member, a viewer included,
 * suspend or archive their own organisation and lock everyone out with no way
 * back. Suspend, reactivate, archive and restore live only at
 * `PATCH /platform/tenants/:id/status`.
 */
@Controller()
export class TenantController {
  constructor(private readonly tenants: TenantService) {}

  /**
   * Provisions a tenant. Platform administrators only.
   *
   * This route was unauthenticated until the platform tier existed, on the
   * argument that a fresh installation has nobody who could hold a token —
   * which was true, and which also meant anyone who could reach the port could
   * create tenants, and a signed-in tenant administrator could create more.
   * Bootstrapping now happens through `pnpm platform-admin`, which mints the
   * first operator from a shell on the machine that already holds the database
   * credentials. That is a better bootstrap than an open endpoint, so the
   * argument for leaving this public no longer holds.
   */
  @Post(API_ROUTES.tenants)
  @HttpCode(201)
  @UseGuards(AccessTokenGuard, PlatformGuard)
  @RequiresPlatformPermission("platform.tenant.write")
  create(
    @Body(new ZodValidationPipe(createTenantSchema)) dto: CreateTenantInput,
    @Req() request: Request,
    @Ip() ip: string
  ): Promise<ProvisionedTenant> {
    // Provisioning creates the tenant, its default roles and its first admin
    // user in one transaction; a duplicate slug surfaces as 409. The actor is
    // the operator's verified identity rather than the fixed "platform-admin"
    // label this used to record — the route was unauthenticated then, so there
    // was no identity to name (US-015).
    return this.tenants.create(dto, actorFrom(request, ip));
  }

  /**
   * One page of tenants.
   *
   * Authenticated, unlike provisioning: the list names every tenant on the
   * platform, which is the kind of thing that must not be readable by anyone
   * who can reach the port.
   */
  @Get(API_ROUTES.tenants)
  @UseGuards(AccessTokenGuard)
  list(
    @Query(new ZodValidationPipe(pageQuerySchema)) query: PageQuery
  ): Promise<Page<TenantSummary>> {
    return this.tenants.list(query);
  }

  @Get(API_ROUTES.tenant)
  @UseGuards(AccessTokenGuard)
  async get(@Param("id") id: string): Promise<TenantDetail> {
    const tenant = await this.tenants.find(id);
    if (!tenant) {
      throw new NotFoundException({ message: "Tenant not found." });
    }
    return tenant;
  }

  /** One tenant's recent audit entries. */
  @Get(API_ROUTES.tenantActivity)
  @UseGuards(AccessTokenGuard)
  async activity(@Param("id") id: string): Promise<ActivityEntry[]> {
    const entries = await this.tenants.activity(id);
    if (!entries) {
      throw new NotFoundException({ message: "Tenant not found." });
    }
    return entries;
  }
}
