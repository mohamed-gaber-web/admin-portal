import { Injectable, inject } from "@angular/core";
import type { Observable } from "rxjs";
import {
  API_ROUTES,
  activityEntrySchema,
  catalogPermissionListSchema,
  platformAdminCreatedSchema,
  platformAdminListSchema,
  provisionedTenantSchema,
  tenantDetailSchema,
  tenantModuleListSchema,
  tenantPageSchema,
  userDetailSchema,
  userPageSchema,
  type CatalogPermission,
  type CreatePlatformAdminInput,
  type CreateTenantInput,
  type ModuleKey,
  type PlatformAdmin,
  type PlatformAdminCreated,
  type ProvisionedTenant,
  type TenantModule,
  type TenantPlan,
  z
} from "@growpath/contracts";
import { ApiService, pathFor } from "@core/http/api.service";
import { nullOnNotFound } from "@core/http/not-found";
import type {
  ActivityEntry,
  Page,
  PageQuery,
  TenantDetail,
  TenantStatus,
  TenantSummary,
  UserDetail,
  UserStatus,
  UserSummary
} from "@core/models";

export interface PlatformUserQuery extends PageQuery {
  status?: UserStatus | "all";
}

/**
 * The cross-tenant screens' data.
 *
 * Deliberately a separate service from `TenantsService` and `UsersService`
 * rather than a flag on them. Those answer "my tenant" and these answer "every
 * tenant", and a single service whose reach depended on a boolean is one
 * mistaken default away from showing an ordinary administrator the whole
 * installation — which is the regression US-063 was written to fix, and it
 * would be reintroduced in the client this time.
 *
 * Responses are parsed through the shared contract schemas, as everywhere else:
 * these screens drive suspensions across tenant boundaries, and a renamed field
 * surfacing as `undefined` in a confirmation dialog is the failure worth being
 * loud about.
 */
@Injectable({ providedIn: "root" })
export class PlatformService {
  private readonly api = inject(ApiService);

  /** Every tenant on the installation. */
  listTenants(query: PageQuery): Observable<Page<TenantSummary>> {
    return this.api.getValidated(API_ROUTES.platformTenants, tenantPageSchema, {
      page: query.page,
      pageSize: query.pageSize,
      search: query.search,
      sort: query.sort,
      direction: query.direction
    });
  }

  getTenant(id: string): Observable<TenantDetail | null> {
    return this.api
      .getValidated(pathFor(API_ROUTES.platformTenant, { id }), tenantDetailSchema)
      .pipe(nullOnNotFound());
  }

  /**
   * One tenant's audit trail, whichever tenant it is.
   *
   * Empty on failure rather than an error state, matching the tenant-scoped
   * screen: the feed is supplementary, and a page that refuses to render its
   * subscription controls because an audit query timed out is a page that stops
   * being usable for the thing it exists to do.
   */
  tenantActivity(id: string): Observable<ActivityEntry[]> {
    return this.api.getValidated(
      pathFor(API_ROUTES.platformTenantActivity, { id }),
      z.array(activityEntrySchema)
    );
  }

  /**
   * A lifecycle transition on any tenant.
   *
   * The target state travels rather than the verb, so a retried request is a
   * no-op rather than a second transition. The API writes the audit entry into
   * the *target* tenant's log naming the operator, which is what keeps this
   * accountable to the people it acts on.
   */
  setTenantStatus(id: string, status: TenantStatus): Observable<TenantDetail> {
    return this.api.patchValidated(
      pathFor(API_ROUTES.platformTenantStatus, { id }),
      { status },
      tenantDetailSchema
    );
  }

  /** Every user, in every tenant. */
  listUsers(query: PlatformUserQuery): Observable<Page<UserSummary>> {
    return this.api.getValidated(API_ROUTES.platformUsers, userPageSchema, {
      page: query.page,
      pageSize: query.pageSize,
      search: query.search,
      sort: query.sort,
      direction: query.direction,
      status: query.status
    });
  }

  getUser(id: string): Observable<UserDetail | null> {
    return this.api
      .getValidated(pathFor(API_ROUTES.platformUser, { id }), userDetailSchema)
      .pipe(nullOnNotFound());
  }

  /**
   * Suspends or reactivates any account.
   *
   * The API refuses the operator's own account with a 400 — self-suspension
   * locks the tier out with no screen that could undo it — so the caller can
   * surface that message rather than guessing at it.
   */
  setUserStatus(id: string, status: UserStatus): Observable<UserDetail> {
    return this.api.patchValidated(
      pathFor(API_ROUTES.platformUserStatus, { id }),
      { status },
      userDetailSchema
    );
  }

  /**
   * Provisions a tenant.
   *
   * This lives here rather than on `TenantsService` because `POST /tenants` is
   * a platform operation: a tenant administrator creating tenants was never
   * intended and is now refused by the API. The response carries the first
   * admin's invitation token, readable exactly once — the API stores a digest,
   * so a lost token is reissued rather than recovered, and the dialog has to
   * surface it at that moment or not at all.
   */
  createTenant(input: CreateTenantInput): Observable<ProvisionedTenant> {
    return this.api.postValidated(API_ROUTES.tenants, input, provisionedTenantSchema);
  }

  // ── Commercial administration (US-072) ───────────────────────────────────

  /**
   * Moves a tenant onto a plan.
   *
   * Returns the whole tenant rather than the plan alone, so the screen renders
   * what the server now holds instead of patching its own copy — which is how a
   * screen starts quietly disagreeing with the database.
   */
  setTenantPlan(id: string, plan: TenantPlan): Observable<TenantDetail> {
    return this.api.patchValidated(
      pathFor(API_ROUTES.platformTenantPlan, { id }),
      { plan },
      tenantDetailSchema
    );
  }

  /**
   * Cancels a tenant's subscription.
   *
   * The same endpoint and the same resulting column — what differs is the audit
   * entry, and that difference is the whole reason this is a separate method
   * rather than `setTenantPlan(id, "trial")`. Afterwards, only the log can say
   * whether a customer was downgraded or left.
   *
   * It does *not* suspend them. Cancelling a subscription and cutting off access
   * are different decisions, and a customer whose renewal lapsed should not lose
   * the ability to export their own data at the moment they most need it.
   */
  unsubscribeTenant(id: string, plan: TenantPlan): Observable<TenantDetail> {
    return this.api.patchValidated(
      pathFor(API_ROUTES.platformTenantPlan, { id }),
      { plan, unsubscribe: true },
      tenantDetailSchema
    );
  }

  /** The module catalogue, marked with what this tenant holds. */
  listTenantModules(id: string): Observable<TenantModule[]> {
    return this.api.getValidated(
      pathFor(API_ROUTES.platformTenantModules, { id }),
      tenantModuleListSchema
    );
  }

  /** Replaces the whole set, so a retry cannot half-apply. */
  setTenantModules(id: string, modules: ModuleKey[]): Observable<TenantModule[]> {
    return this.api.putValidated(
      pathFor(API_ROUTES.platformTenantModules, { id }),
      { modules },
      tenantModuleListSchema
    );
  }

  // ── The operator tier's own administration ───────────────────────────────

  /** Everybody holding the platform role. */
  listAdmins(): Observable<PlatformAdmin[]> {
    return this.api.getValidated(API_ROUTES.platformAdmins, platformAdminListSchema);
  }

  /**
   * Mints another operator.
   *
   * The invitation token in the response is readable exactly once — the API
   * stores a digest, so a lost token is reissued rather than recovered, and the
   * dialog has to surface it at that moment or not at all. `invitation` is null
   * when the address already belonged to an active operator, which is a success
   * and must be shown as one.
   */
  createAdmin(input: CreatePlatformAdminInput): Observable<PlatformAdminCreated> {
    return this.api.postValidated(
      API_ROUTES.platformAdmins,
      input,
      platformAdminCreatedSchema
    );
  }

  /** Every permission the installation defines. Read-only, everywhere. */
  listPermissions(): Observable<CatalogPermission[]> {
    return this.api.getValidated(
      API_ROUTES.platformPermissions,
      catalogPermissionListSchema
    );
  }
}
