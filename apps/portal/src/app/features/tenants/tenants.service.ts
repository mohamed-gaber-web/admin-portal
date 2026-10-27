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
  TenantSummary
} from "@core/models";

/**
 * Tenants.
 *
 * Every method is a real request, served by `GET /tenants`, `GET /tenants/:id`
 * and `GET /tenants/:id/activity`.
 *
 * Read-only on purpose. Suspending, archiving and restoring a workspace is the
 * operator's decision and lives on `PlatformService` — a tenant able to switch
 * itself off could lock out every one of its own users with no way back.
 *
 * Responses are parsed through the shared contract schemas rather than trusted:
 * a silently-renamed field surfacing as `undefined` on screen is the failure
 * worth being loud about.
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

  /*
   * Provisioning is deliberately absent.
   *
   * `POST /tenants` is a platform-administrator operation — a tenant creating
   * further tenants was never intended, and the API refuses it — so it lives on
   * `PlatformService` instead. Leaving a `create()` here would be a method whose
   * every call 403s, and the first person to find that out would be a user.
   */
}
