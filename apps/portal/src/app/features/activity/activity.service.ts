import { Injectable, inject } from "@angular/core";
import type { Observable } from "rxjs";
import { activityPageSchema, API_ROUTES } from "@growpath/contracts";
import { ApiService } from "@core/http/api.service";
import type { ActivityEntry, ActivitySeverity, Page, PageQuery } from "@core/models";

export interface ActivityQuery extends PageQuery {
  severity?: ActivitySeverity | "all";
}

/**
 * The audit log for the caller's tenant.
 *
 * `action` carries the API's own audit action names — `tenant.provisioned`,
 * `invitation.issued`, `role.assigned` — rather than display text, because the
 * feed renders in two languages. `severity` is derived server-side from the
 * action, so the portal and anything else that grows a feed agree on how
 * alarming each entry is.
 */
@Injectable({ providedIn: "root" })
export class ActivityService {
  private readonly api = inject(ApiService);

  list(query: ActivityQuery): Observable<Page<ActivityEntry>> {
    return this.api.getValidated(API_ROUTES.activity, activityPageSchema, {
      page: query.page,
      pageSize: query.pageSize,
      search: query.search,
      sort: query.sort,
      direction: query.direction,
      severity: query.severity
    });
  }
}
