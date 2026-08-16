import { Inject, Injectable } from "@nestjs/common";
import {
  listAuditPage,
  withRequestTenantScope,
  type AuditEntry,
  type PageRequest
} from "@growpath/db";
import {
  severityForAction,
  type ActivityEntry,
  type ActivitySeverity,
  type Page
} from "@growpath/contracts";
import type { Pool } from "pg";
import { DATABASE_POOL } from "../database/database.module";

export interface ActivityRequest extends PageRequest {
  severity?: ActivitySeverity | "all";
}

/**
 * What an entry was about, in the most human terms available.
 *
 * The audit row records an entity id, which is correct and unreadable. The
 * recorded values usually carry something better — a slug, an email — so those
 * are preferred, and the id is the fallback rather than the first choice.
 */
function activityTarget(entry: AuditEntry): string {
  const values = { ...entry.beforeValues, ...entry.afterValues } as Record<string, unknown>;
  for (const key of ["slug", "email", "userEmail", "role", "name"]) {
    const value = values[key];
    if (typeof value === "string" && value) return value;
  }
  return entry.entityId ?? entry.entityType;
}

const toActivity = (entry: AuditEntry): ActivityEntry => ({
  id: entry.id,
  action: entry.action,
  actor: entry.actorLabel,
  target: activityTarget(entry),
  at: entry.createdAt.toISOString(),
  severity: severityForAction(entry.action)
});

/**
 * The caller's tenant's audit trail.
 *
 * Scoped like every other tenant read: `audit_log` carries a tenant isolation
 * policy, so the session's tenant is what decides which entries exist at all.
 */
@Injectable()
export class ActivityService {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async list(request: ActivityRequest): Promise<Page<ActivityEntry>> {
    const page = await withRequestTenantScope(this.pool, (client) =>
      listAuditPage(client, request)
    );

    const items = page.items.map(toActivity);
    if (!request.severity || request.severity === "all") {
      return { ...page, items };
    }

    /**
     * Severity is filtered here rather than in SQL, and the cost is admitted:
     * it is derived from the action name in the contracts package, so the
     * database has no column to filter on, and filtering after paging means a
     * filtered page can come back shorter than `pageSize`.
     *
     * The alternative — duplicating the action → severity table into SQL —
     * would put the same mapping in two places, and the copy that drifts is
     * the one nobody is looking at. Pushing it into the schema properly is a
     * migration that belongs with a story about audit search.
     */
    const filtered = items.filter((entry) => entry.severity === request.severity);
    return { ...page, items: filtered };
  }
}
