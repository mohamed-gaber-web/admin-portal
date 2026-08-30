import { recordAuditEntry, type AuditActor } from "./audit";
import {
  likeArgument,
  limitOffset,
  orderByClause,
  toPage,
  type PageRequest,
  type PagedResult
} from "./paging";
import { restoreTenant, softDeleteTenant, type Queryable } from "./tenancy";

/**
 * Reads and lifecycle transitions for the tenant administration screens
 * (US-063).
 *
 * Everything here is platform-level: it spans tenants, so it cannot run inside
 * a tenant-scoped session. The API reaches it through `withoutTenantScope`,
 * which records the bypass with the request's correlation ID.
 */

export type TenantStatus = "active" | "pending" | "suspended" | "archived";
export type TenantPlan = "trial" | "starter" | "growth" | "enterprise";
export type EnvironmentKind = "production" | "sandbox";

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  plan: TenantPlan;
  userCount: number;
  /**
   * Seats the tenant's package includes.
   *
   * Joined from `plan` rather than stored on the tenant: the allowance belongs
   * to the package, and a copy on the tenant row would be one an operator could
   * move a customer's package without updating.
   */
  userLimit: number;
  /** The tenant's own negotiated allowance, or null when it inherits its package. */
  seatLimitOverride: number | null;
  /** The tenant's admin address. Empty when the tenant has no users at all. */
  adminEmail: string;
  createdAt: Date;
}

export interface TenantCompanyRecord {
  id: string;
  name: string;
  dataAreaId: string;
  environmentId: string;
}

export interface TenantEnvironmentRecord {
  id: string;
  name: string;
  kind: EnvironmentKind;
  url: string;
  /**
   * Whether the last credential check reached D365 (US-040).
   *
   * Read from the column rather than reported as a constant. Until the
   * connection migration there was nothing that could answer this, so the API
   * returned `not_configured` for every environment — truthfully, because no
   * connection could exist. It can now, and a stored answer beats a hardcoded
   * one for the obvious reason.
   */
  connection: ConnectionState;
  companies: TenantCompanyRecord[];
}

/** Mirrors the contract's `CONNECTION_STATES`. */
export type ConnectionState = "connected" | "failing" | "not_configured";

export interface TenantDetail extends TenantSummary {
  environments: TenantEnvironmentRecord[];
}

/**
 * Status, derived in SQL rather than stored.
 *
 * The order of the branches is the precedence, and it is deliberate: a tenant
 * that was suspended and then archived is archived, because archiving is the
 * state that hides it from every other screen. Reversing the first two would
 * leave a deleted tenant reporting as merely suspended.
 *
 * `pending` is "provisioned, but nobody has accepted their invitation yet",
 * which is exactly the state a freshly created tenant is in — its admin user
 * exists with no credential.
 */
const STATUS_EXPRESSION = `
  CASE
    WHEN t.deleted_at IS NOT NULL THEN 'archived'
    WHEN t.suspended_at IS NOT NULL THEN 'suspended'
    WHEN count(u.id) FILTER (WHERE u.status = 'active') = 0 THEN 'pending'
    ELSE 'active'
  END`;

/**
 * The address an operator needs when a tenant is stuck.
 *
 * Prefers a holder of the admin role, and falls back to the earliest user when
 * nobody holds it. The fallback is the point: a tenant whose last admin was
 * demoted is exactly the tenant someone is looking at a screen to repair, and
 * answering with an empty string there would withhold the one field that helps.
 *
 * Two correlated subqueries rather than joins to `user_role` and `role`, which
 * is what the detail query used to do. Those joins multiply the result by each
 * user's role count, and the same statement does `count(u.id)` for the user
 * total — so a tenant where one person held two roles reported twice as many
 * users as it had. Nobody holds two roles today, which is why it had not
 * surfaced; the seat limit now reads that count, so it would have.
 */
const ADMIN_EMAIL_EXPRESSION = `
  coalesce(
    (SELECT min(admin_user.email)
       FROM "user" admin_user
       JOIN user_role ur ON ur.user_id = admin_user.id
       JOIN role r ON r.id = ur.role_id
      WHERE admin_user.tenant_id = t.id AND r.name = 'admin'),
    (SELECT first.email FROM "user" first
      WHERE first.tenant_id = t.id
      ORDER BY first.created_at, first.id
      LIMIT 1)
  )`;

/**
 * Seats the tenant may hold: its own negotiated figure, or its package's.
 *
 * Computed at every read rather than stored, so raising a package's allowance
 * lifts every tenant that inherits it and leaves the negotiated ones alone.
 */
const SEAT_LIMIT_EXPRESSION = `coalesce(t.seat_limit, p.user_limit)`;

/** Sortable columns, whitelisted — `sort` arrives on a query string. */
const TENANT_SORT_COLUMNS: Record<string, string> = {
  name: "t.name",
  slug: "t.slug",
  plan: "t.plan",
  createdAt: "t.created_at",
  userCount: "count(u.id)",
  status: STATUS_EXPRESSION
};

interface TenantSummaryRow {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  plan: TenantPlan;
  user_count: string;
  user_limit: string;
  seat_limit_override: number | null;
  admin_email: string | null;
  created_at: Date;
  total_count: string;
}

const toSummary = (row: TenantSummaryRow): TenantSummary => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  status: row.status,
  plan: row.plan,
  userCount: Number(row.user_count),
  userLimit: Number(row.user_limit),
  seatLimitOverride: row.seat_limit_override === null ? null : Number(row.seat_limit_override),
  adminEmail: row.admin_email ?? "",
  createdAt: row.created_at
});

export interface ListTenantsOptions {
  /**
   * Leave the reserved platform tenant out of the results.
   *
   * Only meaningful unscoped: inside a tenant session row level security has
   * already hidden every tenant but the caller's own. The cross-tenant screen
   * passes it, because the platform tenant is the operators' own workspace
   * rather than a customer — listing it invites someone to archive it, and an
   * archived platform tenant is one nobody can create a tenant from again.
   */
  excludePlatform?: boolean;
}

/**
 * One page of tenants.
 *
 * Archived tenants are included rather than filtered out — this is the screen
 * an operator uses to find one and restore it, and a list that hides them makes
 * the restore action unreachable.
 */
export async function listTenants(
  db: Queryable,
  request: PageRequest,
  options: ListTenantsOptions = {}
): Promise<PagedResult<TenantSummary>> {
  const like = likeArgument(request.search);
  const { limit, offset } = limitOffset(request);

  const res = await db.query<TenantSummaryRow>(
    `SELECT t.id, t.name, t.slug, t.plan, t.created_at,
            t.seat_limit AS seat_limit_override,
            ${SEAT_LIMIT_EXPRESSION} AS user_limit,
            ${ADMIN_EMAIL_EXPRESSION} AS admin_email,
            ${STATUS_EXPRESSION} AS status,
            count(u.id) AS user_count,
            count(*) OVER () AS total_count
     FROM tenant t
     JOIN plan p ON p.key = t.plan
     LEFT JOIN "user" u ON u.tenant_id = t.id
     WHERE ($1::text IS NULL OR t.name ILIKE $1 ESCAPE '\\' OR t.slug ILIKE $1 ESCAPE '\\')
       AND ($4::boolean IS NOT TRUE OR NOT t.is_platform)
     GROUP BY t.id, p.user_limit
     ${orderByClause(request, TENANT_SORT_COLUMNS, "name")}
     LIMIT $2 OFFSET $3`,
    [like, limit, offset, options.excludePlatform ?? false]
  );

  return toPage(res.rows, request, toSummary);
}

type TenantDetailRow = Omit<TenantSummaryRow, "total_count">;

/**
 * One tenant with its environments and their legal entities.
 *
 * Three queries rather than one join: a tenant → environment → company join
 * multiplies rows by both child levels, and reassembling that in application
 * code is where the hierarchy usually gets flattened by accident.
 *
 * Returns null for an unknown id, including a malformed one — the uuid cast is
 * guarded so a bad id is "not found" rather than a 500, which would tell a
 * caller their guess was at least well-formed.
 */
export async function findTenantDetail(
  db: Queryable,
  tenantId: string
): Promise<TenantDetail | null> {
  if (!isUuid(tenantId)) return null;

  const res = await db.query<TenantDetailRow>(
    `SELECT t.id, t.name, t.slug, t.plan, t.created_at,
            t.seat_limit AS seat_limit_override,
            ${SEAT_LIMIT_EXPRESSION} AS user_limit,
            ${ADMIN_EMAIL_EXPRESSION} AS admin_email,
            ${STATUS_EXPRESSION} AS status,
            count(u.id) AS user_count
     FROM tenant t
     JOIN plan p ON p.key = t.plan
     LEFT JOIN "user" u ON u.tenant_id = t.id
     WHERE t.id = $1
     GROUP BY t.id, p.user_limit`,
    [tenantId]
  );

  const row = res.rows[0];
  if (!row) return null;

  const environments = await listEnvironmentsWithCompanies(db, tenantId);

  return {
    ...toSummary({ ...row, total_count: "1" }),
    environments
  };
}

interface EnvironmentRow {
  id: string;
  name: string;
  kind: EnvironmentKind;
  url: string;
  connection_state: ConnectionState;
}

interface CompanyRow {
  id: string;
  name: string;
  data_area_id: string;
  environment_id: string;
}

async function listEnvironmentsWithCompanies(
  db: Queryable,
  tenantId: string
): Promise<TenantEnvironmentRecord[]> {
  const environments = await db.query<EnvironmentRow>(
    `SELECT id, name, kind, url, connection_state FROM d365_environment
     WHERE tenant_id = $1 ORDER BY name`,
    [tenantId]
  );
  if (environments.rows.length === 0) return [];

  const companies = await db.query<CompanyRow>(
    `SELECT id, name, data_area_id, environment_id FROM company
     WHERE tenant_id = $1 AND environment_id = ANY($2::uuid[]) ORDER BY name`,
    [tenantId, environments.rows.map((row) => row.id)]
  );

  const byEnvironment = new Map<string, TenantCompanyRecord[]>();
  for (const row of companies.rows) {
    const list = byEnvironment.get(row.environment_id) ?? [];
    list.push({
      id: row.id,
      name: row.name,
      dataAreaId: row.data_area_id,
      environmentId: row.environment_id
    });
    byEnvironment.set(row.environment_id, list);
  }

  return environments.rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    url: row.url,
    connection: row.connection_state,
    companies: byEnvironment.get(row.id) ?? []
  }));
}

/** The states an operator can move a tenant to. `pending` is derived, not set. */
export type TenantStatusTarget = "active" | "suspended" | "archived";

/**
 * Applies a lifecycle transition and returns the tenant as it now stands.
 *
 * Expressed as the state to reach rather than as a verb, which makes it
 * idempotent: asking twice for `suspended` is a no-op that writes no second
 * audit entry, because the UPDATE matches no row the second time.
 *
 * `active` clears both suspension and deletion. Restoring a tenant that was
 * suspended before it was archived to a still-suspended state would be
 * defensible, but it would mean the restore button leaves the tenant unusable
 * with no indication why — so `active` means active.
 */
export async function setTenantStatus(
  db: Queryable,
  tenantId: string,
  target: TenantStatusTarget,
  actor: AuditActor
): Promise<TenantDetail | null> {
  if (!isUuid(tenantId)) return null;

  const existing = await db.query<{ id: string }>("SELECT id FROM tenant WHERE id = $1", [
    tenantId
  ]);
  if (!existing.rows[0]) return null;

  if (target === "archived") {
    // Writes tenant.soft_deleted, and only if the tenant was not already
    // deleted — the UPDATE inside is conditioned on deleted_at IS NULL.
    await softDeleteTenant(db, tenantId, actor);
  } else if (target === "suspended") {
    await suspendTenant(db, tenantId, actor);
  } else {
    // Order matters: a tenant can be both archived and suspended, and leaving
    // the suspension in place would make the restore look like it failed.
    await restoreTenant(db, tenantId, actor);
    await reactivateTenant(db, tenantId, actor);
  }

  return findTenantDetail(db, tenantId);
}

async function suspendTenant(
  db: Queryable,
  tenantId: string,
  actor: AuditActor
): Promise<void> {
  const res = await db.query<{ id: string; suspended_at: Date }>(
    `UPDATE tenant SET suspended_at = now(), updated_at = now()
     WHERE id = $1 AND suspended_at IS NULL
     RETURNING id, suspended_at`,
    [tenantId]
  );
  const row = res.rows[0];
  if (!row) return;

  await recordAuditEntry(db, {
    tenantId,
    action: "tenant.suspended",
    entityType: "tenant",
    entityId: tenantId,
    actor,
    before: { suspendedAt: null },
    after: { suspendedAt: row.suspended_at }
  });
}

async function reactivateTenant(
  db: Queryable,
  tenantId: string,
  actor: AuditActor
): Promise<void> {
  // RETURNING yields the row as it now is, so the cleared value cannot be read
  // from it. The CTE captures the previous timestamp in the same statement,
  // which keeps the read and the write atomic — reading it first with a
  // separate SELECT would leave a window for a concurrent transition.
  const res = await db.query<{ previous: Date }>(
    `WITH previous AS (
       SELECT id, suspended_at FROM tenant WHERE id = $1 FOR UPDATE
     )
     UPDATE tenant SET suspended_at = NULL, updated_at = now()
     FROM previous
     WHERE tenant.id = previous.id AND previous.suspended_at IS NOT NULL
     RETURNING previous.suspended_at AS previous`,
    [tenantId]
  );
  if (!res.rows[0]) return;

  await recordAuditEntry(db, {
    tenantId,
    action: "tenant.reactivated",
    entityType: "tenant",
    entityId: tenantId,
    actor,
    before: { suspendedAt: res.rows[0].previous },
    after: { suspendedAt: null }
  });
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guards the uuid cast.
 *
 * Postgres rejects a malformed uuid with an error, which would surface as a
 * 500 — and a 500 for "abc" against a 404 for a well-formed guess is itself a
 * signal about which ids are worth trying.
 */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Renames a tenant.
 *
 * Name only — see `updateTenantSchema` for why the slug is not editable. The
 * name is display text: it appears on screens and in the audit log, and nothing
 * authenticates or routes by it, so changing it is safe in a way changing the
 * slug is not.
 *
 * Trims, and refuses a name that is empty once trimmed. A tenant called " "
 * renders as a blank row that an operator cannot click on with any confidence,
 * and the schema's `min(1)` passes a string of spaces.
 *
 * Returns null for an unknown tenant, and `changed: false` when the name
 * already matches — so a retried request writes no second audit entry.
 */
export async function setTenantName(
  db: Queryable,
  input: { tenantId: string; name: string; actor: AuditActor }
): Promise<{ name: string; changed: boolean } | null> {
  if (!isUuid(input.tenantId)) return null;

  const name = input.name.trim();
  if (name === "") return null;

  const existing = await db.query<{ name: string }>(
    "SELECT name FROM tenant WHERE id = $1",
    [input.tenantId]
  );
  const current = existing.rows[0];
  if (!current) return null;

  if (current.name === name) {
    return { name, changed: false };
  }

  await db.query("UPDATE tenant SET name = $2, updated_at = now() WHERE id = $1", [
    input.tenantId,
    name
  ]);

  await recordAuditEntry(db, {
    tenantId: input.tenantId,
    action: "tenant.renamed",
    entityType: "tenant",
    entityId: input.tenantId,
    actor: input.actor,
    before: { name: current.name },
    after: { name }
  });

  return { name, changed: true };
}
