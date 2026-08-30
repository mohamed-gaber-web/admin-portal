import { ConflictException, Inject, Injectable } from "@nestjs/common";
import {
  findTenantDetail,
  listAuditEntriesForTenant,
  listTenants,
  provisionTenantOnClient,
  setTenantStatus,
  TenantAlreadyExistsError,
  withoutTenantScope,
  withRequestTenantScope,
  type AuditActor,
  type AuditEntry,
  type PageRequest,
  type TenantDetail as TenantDetailRecord,
  type TenantStatusTarget,
  type TenantSummary as TenantSummaryRecord
} from "@growpath/db";
import {
  severityForAction,
  type ActivityEntry,
  type CreateTenantInput,
  type Page,
  type ProvisionedTenant,
  type TenantDetail,
  type TenantSummary
} from "@growpath/contracts";
import type { Pool } from "pg";
import { DATABASE_POOL } from "../database/database.module";

/**
 * Why the reads here are scoped rather than platform-wide.
 *
 * They used to run through `withoutTenantScope`, on the assumption that the
 * portal was a platform console. It is not: a tenant sees its own organisation
 * and nothing else, so `GET /tenants` returning every tenant on the
 * installation disclosed the customer list — names, slugs, plans and headcounts
 * — to anyone who could sign in anywhere.
 *
 * `withRequestTenantScope` sets the tenant from the access token's claims and
 * drops the session to `app_user`, so the `tenant` table's own RLS policy
 * (`id = current_tenant_id()`) does the filtering. There is deliberately no
 * WHERE clause here doing it in application code: the boundary is in the
 * database, so a query added later cannot forget it.
 *
 * Provisioning is the one exception and still bypasses scoping — the tenant it
 * creates does not exist yet, so there is nothing to scope to.
 */

const toSummary = (record: TenantSummaryRecord): TenantSummary => ({
  id: record.id,
  name: record.name,
  slug: record.slug,
  status: record.status,
  plan: record.plan,
  userCount: record.userCount,
  userLimit: record.userLimit,
  seatLimitOverride: record.seatLimitOverride,
  adminEmail: record.adminEmail,
  createdAt: record.createdAt.toISOString()
});

const toDetail = (record: TenantDetailRecord): TenantDetail => ({
  ...toSummary(record),
  environments: record.environments.map((environment) => ({
    id: environment.id,
    name: environment.name,
    kind: environment.kind,
    url: environment.url,
    // The stored result of the last credential check (US-040). This was pinned
    // to `not_configured` while nothing could store a connection; it now
    // reports what `POST /connections/:id/test` last found, so an environment
    // reads `connected` only because a token request actually succeeded.
    connection: environment.connection,
    companies: environment.companies
  }))
});

const toActivity = (entry: AuditEntry): ActivityEntry => ({
  id: entry.id,
  action: entry.action,
  actor: entry.actorLabel,
  target: activityTarget(entry),
  at: entry.createdAt.toISOString(),
  severity: severityForAction(entry.action)
});

/**
 * What an entry was about, in the most human terms available.
 *
 * The audit row records an entity id, which is correct but unreadable in a
 * feed. The recorded values usually carry something better — a slug, an email —
 * so those are preferred and the id is the fallback.
 */
function activityTarget(entry: AuditEntry): string {
  const values = { ...entry.beforeValues, ...entry.afterValues } as Record<string, unknown>;
  for (const key of ["slug", "email", "userEmail", "role", "name"]) {
    const value = values[key];
    if (typeof value === "string" && value) return value;
  }
  return entry.entityId ?? entry.entityType;
}

@Injectable()
export class TenantService {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  /**
   * The caller's own tenant.
   *
   * Answers a page rather than a single object because the screen is a list and
   * pages the same way the others do — it simply never holds more than one row.
   * `search` and `sort` still apply, so a search matching nothing correctly
   * returns an empty page rather than ignoring the filter.
   */
  async list(request: PageRequest): Promise<Page<TenantSummary>> {
    const page = await withRequestTenantScope(this.pool, (client) =>
      listTenants(client, request)
    );
    return { ...page, items: page.items.map(toSummary) };
  }

  /** The caller's own tenant, or null for any other id. */
  async find(id: string): Promise<TenantDetail | null> {
    const record = await withRequestTenantScope(this.pool, (client) =>
      findTenantDetail(client, id)
    );
    return record ? toDetail(record) : null;
  }

  /** The caller's own tenant's recent audit entries, newest first. */
  async activity(id: string): Promise<ActivityEntry[] | null> {
    return withRequestTenantScope(this.pool, async (client) => {
      // Checked first so an unknown — or simply invisible — tenant is a 404
      // rather than an empty feed, which would look like a tenant that has
      // never done anything and would confirm the id exists.
      const tenant = await findTenantDetail(client, id);
      if (!tenant) return null;

      const entries = await listAuditEntriesForTenant(client, id);
      return entries.map(toActivity);
    });
  }

  /**
   * Applies a lifecycle transition to the caller's own tenant.
   *
   * Another tenant's id is invisible inside the scoped session, so it lands as
   * a 404 rather than a 403 — and, more to the point, the UPDATE it would have
   * run matches no row.
   */
  async setStatus(
    id: string,
    status: TenantStatusTarget,
    actor: AuditActor
  ): Promise<TenantDetail | null> {
    const record = await withRequestTenantScope(this.pool, (client) =>
      setTenantStatus(client, id, status, actor)
    );
    return record ? toDetail(record) : null;
  }

  async create(input: CreateTenantInput, actor: AuditActor): Promise<ProvisionedTenant> {
    try {
      // Deliberately unscoped, and deliberately loud about it: the tenant being
      // created is the one there is no context for yet, so this is the one
      // operation that cannot be filtered by tenant. The escape hatch logs the
      // bypass with the request's correlation ID (US-012).
      const result = await withoutTenantScope(
        this.pool,
        {
          reason:
            "Tenant provisioning creates the tenant row itself, so there is no tenant to scope to (US-014)."
        },
        (client) =>
          // The operator's own identity, from the verified token claims. This
          // route was unauthenticated until the platform tier existed, so the
          // actor used to be the fixed label "platform-admin" — truthful then,
          // and unhelpful now that there is a real person behind it.
          provisionTenantOnClient(client, input, actor)
      );

      return {
        ...result,
        invitation: {
          ...result.invitation,
          // The contract carries a string: a Date would be serialised by
          // JSON.stringify anyway, and saying so in the schema is what lets a
          // consumer rely on it.
          expiresAt: result.invitation.expiresAt.toISOString()
        }
      };
    } catch (err) {
      if (err instanceof TenantAlreadyExistsError) {
        // 409, not a 500: the caller can fix this by choosing another slug.
        throw new ConflictException({ message: err.message, slug: err.slug });
      }
      throw err;
    }
  }
}
