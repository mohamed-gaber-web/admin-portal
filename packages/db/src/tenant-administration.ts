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
  /**
   * The contract period, as `YYYY-MM-DD`, or null where not recorded.
   *
   * Strings rather than `Date`, unlike every other date on this record. These
   * are `date` columns, not `timestamptz`: a calendar day, not an instant. Wrapping
   * one in a `Date` gives it a midnight and a timezone it does not have, and the
   * first thing that formats it in a zone behind UTC renders the previous day.
   */
  contractStartDate: string | null;
  contractEndDate: string | null;
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
  contract_start_date: string | null;
  contract_end_date: string | null;
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
  contractStartDate: row.contract_start_date,
  contractEndDate: row.contract_end_date,
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
            -- to_char rather than the raw column: node-postgres parses a date
            -- column into a local-midnight Date, which is the one representation
            -- these must never take. See the note on the record type.
            to_char(t.contract_start_date, 'YYYY-MM-DD') AS contract_start_date,
            to_char(t.contract_end_date, 'YYYY-MM-DD') AS contract_end_date,
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
            -- to_char rather than the raw column: node-postgres parses a date
            -- column into a local-midnight Date, which is the one representation
            -- these must never take. See the note on the record type.
            to_char(t.contract_start_date, 'YYYY-MM-DD') AS contract_start_date,
            to_char(t.contract_end_date, 'YYYY-MM-DD') AS contract_end_date,
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
 * Records a Dynamics environment for a tenant.
 *
 * The missing half of provisioning. `provisionTenantOnClient` creates a tenant
 * with no environment, `findErpBlocker` reports `no_environment`, and every
 * user of that tenant is sent to the mobile app's setup screen — while nothing
 * in the API or the portal could create the row that clears it. The function in
 * `tenancy.ts` that inserts one has only ever been called by the seed.
 *
 * Distinct from that one rather than a call to it, for two reasons: this
 * accepts `kind`, and this writes an audit entry. The seed helper deliberately
 * does neither — a seed is not somebody's decision, and attributing one to an
 * actor would put fiction in the log.
 *
 * Carries no credential. `client_id` and the sealed secret are attached
 * afterwards by `PUT /connections/:id`, which verifies them against Entra
 * before persisting, so `connection_state` starts at its column default of
 * `not_configured` and only a real token request can move it.
 *
 * Returns null for an unknown tenant, so the caller answers 404 rather than
 * failing on a foreign key.
 */
export async function createTenantEnvironment(
  db: Queryable,
  input: {
    tenantId: string;
    name: string;
    url: string;
    /** Omitted takes the column default, `sandbox`. */
    kind?: string;
    actor: AuditActor;
  }
): Promise<{ id: string; name: string; url: string; kind: string } | null> {
  if (!isUuid(input.tenantId)) return null;

  const tenant = await db.query<{ id: string }>("SELECT id FROM tenant WHERE id = $1", [
    input.tenantId
  ]);
  if (!tenant.rows[0]) return null;

  /*
   * Two statements rather than one with a coalesce, matching how provisioning
   * handles an omitted plan: leaving `kind` out of the INSERT lets the
   * *database's* default apply, so there is one place the default is written
   * down rather than a copy here that can drift from it.
   */
  const res = input.kind
    ? await db.query<{ id: string; name: string; url: string; kind: string }>(
        `INSERT INTO d365_environment (tenant_id, name, url, kind)
         VALUES ($1, $2, $3, $4) RETURNING id, name, url, kind`,
        [input.tenantId, input.name, input.url, input.kind]
      )
    : await db.query<{ id: string; name: string; url: string; kind: string }>(
        `INSERT INTO d365_environment (tenant_id, name, url)
         VALUES ($1, $2, $3) RETURNING id, name, url, kind`,
        [input.tenantId, input.name, input.url]
      );

  const environment = res.rows[0];

  await recordAuditEntry(db, {
    tenantId: input.tenantId,
    action: "environment.created",
    entityType: "d365_environment",
    entityId: environment.id,
    actor: input.actor,
    before: null,
    after: { name: environment.name, url: environment.url, kind: environment.kind }
  });

  return environment;
}

/**
 * Records a legal entity inside one of the tenant's environments.
 *
 * The step after the one above, and needed just as much: an environment with a
 * working credential and no company still leaves `findErpBlocker` reporting
 * `no_company`, because there is nothing to scope an OData query to. Adding
 * only the environment would move the dead end rather than remove it.
 *
 * The composite foreign key on `(environment_id, tenant_id)` is what stops a
 * company being attached to another tenant's environment — the check is in the
 * database rather than in a `WHERE` here, so it holds against every caller
 * rather than against this one.
 *
 * Returns null for an unknown tenant, and throws
 * `EnvironmentNotInTenantError` when the environment belongs to somebody else
 * or does not exist, so the caller can tell those two apart.
 */
export async function createTenantCompany(
  db: Queryable,
  input: {
    tenantId: string;
    environmentId: string;
    name: string;
    dataAreaId: string;
    actor: AuditActor;
  }
): Promise<{ id: string; name: string; dataAreaId: string; environmentId: string } | null> {
  if (!isUuid(input.tenantId) || !isUuid(input.environmentId)) return null;

  const tenant = await db.query<{ id: string }>("SELECT id FROM tenant WHERE id = $1", [
    input.tenantId
  ]);
  if (!tenant.rows[0]) return null;

  /*
   * Checked here as well as by the foreign key, so the caller gets a message
   * naming the problem instead of a constraint violation. The key remains the
   * authority — this is the better error, not the security boundary.
   */
  const environment = await db.query<{ id: string }>(
    "SELECT id FROM d365_environment WHERE id = $1 AND tenant_id = $2",
    [input.environmentId, input.tenantId]
  );
  if (!environment.rows[0]) {
    throw new EnvironmentNotInTenantError(input.environmentId);
  }

  const res = await db.query<{
    id: string;
    name: string;
    data_area_id: string;
    environment_id: string;
  }>(
    `INSERT INTO company (tenant_id, environment_id, name, data_area_id)
     VALUES ($1, $2, $3, $4) RETURNING id, name, data_area_id, environment_id`,
    [input.tenantId, input.environmentId, input.name, input.dataAreaId]
  );

  const company = res.rows[0];

  await recordAuditEntry(db, {
    tenantId: input.tenantId,
    action: "company.created",
    entityType: "company",
    entityId: company.id,
    actor: input.actor,
    before: null,
    after: { name: company.name, dataAreaId: company.data_area_id },
    context: { environmentId: company.environment_id }
  });

  return {
    id: company.id,
    name: company.name,
    dataAreaId: company.data_area_id,
    environmentId: company.environment_id
  };
}

/** Raised when a company names an environment the tenant does not own. */
export class EnvironmentNotInTenantError extends Error {
  constructor(readonly environmentId: string) {
    super(`No environment ${environmentId} belongs to this tenant.`);
    this.name = "EnvironmentNotInTenantError";
  }
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
