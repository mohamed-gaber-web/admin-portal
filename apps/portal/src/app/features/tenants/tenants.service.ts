import { Injectable, inject } from "@angular/core";
import type { Observable } from "rxjs";
import {
  API_ROUTES,
  activityEntrySchema,
  tenantDetailSchema,
  tenantPageSchema
} from "@growpath/contracts";
import { z } from "@growpath/contracts";
import { ApiService, pathFor } from "@core/http/api.service";
import { nullOnNotFound } from "@core/http/not-found";
import type {
  ActivityEntry,
  Page,
  PageQuery,
  TenantDetail,
  TenantStatus,
  TenantSummary
} from "@core/models";

/**
 * Tenants.
 *
 * Every method is a real request. The list, the detail and the lifecycle
 * transition are served by `GET /tenants`, `GET /tenants/:id` and
 * `PATCH /tenants/:id/status`; the lifecycle route is the one that finally
 * claims the `tenant.soft_deleted` and `tenant.restored` audit actions that
 * `softDeleteTenant()` and `restoreTenant()` had been writing since US-010 with
 * no endpoint to reach them.
 *
 * Responses are parsed through the shared contract schemas rather than trusted:
 * these screens drive destructive actions, and a silently-renamed field
 * surfacing as `undefined` in a confirmation dialog is the failure worth being
 * loud about.
 */
@Injectable({ providedIn: "root" })
export class TenantsService {
  private readonly api = inject(ApiService);

  /**
   * One page of tenants.
   *
   * Filtering, sorting and paging are query parameters rather than work done
   * here: the server holds every tenant, so a client-side filter could only
   * ever search the page it had already been given.
   */
  list(query: PageQuery): Observable<Page<TenantSummary>> {
    return this.api.getValidated(API_ROUTES.tenants, tenantPageSchema, {
      page: query.page,
      pageSize: query.pageSize,
      search: query.search,
      sort: query.sort,
      direction: query.direction
    });
  }

  /** One tenant with its environments, or null when there is no such tenant. */
  get(id: string): Observable<TenantDetail | null> {
    return this.api
      .getValidated(pathFor(API_ROUTES.tenant, { id }), tenantDetailSchema)
      .pipe(nullOnNotFound());
  }

  /** Audit entries for one tenant, newest first. */
  activity(id: string): Observable<ActivityEntry[]> {
    return this.api.getValidated(
      pathFor(API_ROUTES.tenantActivity, { id }),
      z.array(activityEntrySchema)
    );
  }

  /**
   * Applies a lifecycle transition — suspend, reactivate, archive or restore.
   *
   * The target state travels rather than the verb, which is what makes a
   * retried request a no-op instead of a second transition. `archived` maps to
   * the soft delete, so nothing is removed and a restore is a genuine recovery.
   *
   * Writes `tenant.soft_deleted`, `tenant.restored`, `tenant.suspended` or
   * `tenant.reactivated` to the audit log, depending on which transition
   * actually occurred.
   */
  setStatus(id: string, status: TenantStatus): Observable<TenantSummary> {
    return this.api.patchValidated(
      pathFor(API_ROUTES.tenantStatus, { id }),
      // `pending` is derived from whether anyone has accepted an invitation, so
      // it is not a state an operator can move a tenant to. The screen never
      // offers it — see TENANT_ACTION_RESULT — and the schema rejects it.
      { status },
      tenantDetailSchema
    );
  }

  /*
   * Provisioning is deliberately absent.
   *
   * `POST /tenants` is a platform-administrator operation — a tenant creating
   * further tenants was never intended, and the API refuses it — so it lives on
   * `PlatformService` instead. Leaving a `create()` here would be a method whose
   * every call 403s, and the first person to find that out would be a user.
   */
}
