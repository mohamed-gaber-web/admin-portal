import type { Pool, PoolClient } from "pg";
import { recordAuditEntry, type AuditActor } from "./audit";

/** Anything that can run a query — a pool, a client, or a transaction. */
export type Queryable = Pick<Pool | PoolClient, "query">;

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  /** Set when soft-deleted; null while active. */
  deletedAt: Date | null;
}

export interface Environment {
  id: string;
  tenantId: string;
  name: string;
  url: string;
}

export interface Company {
  id: string;
  tenantId: string;
  environmentId: string;
  name: string;
  /** D365 legal-entity identifier, unique within its environment. */
  dataAreaId: string;
}

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  deleted_at: Date | null;
}

interface EnvironmentRow {
  id: string;
  tenant_id: string;
  name: string;
  url: string;
}

interface CompanyRow {
  id: string;
  tenant_id: string;
  environment_id: string;
  name: string;
  data_area_id: string;
}

const toTenant = (row: TenantRow): Tenant => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  deletedAt: row.deleted_at
});

const toEnvironment = (row: EnvironmentRow): Environment => ({
  id: row.id,
  tenantId: row.tenant_id,
  name: row.name,
  url: row.url
});

const toCompany = (row: CompanyRow): Company => ({
  id: row.id,
  tenantId: row.tenant_id,
  environmentId: row.environment_id,
  name: row.name,
  dataAreaId: row.data_area_id
});

export async function createTenant(
  db: Queryable,
  input: { name: string; slug: string }
): Promise<Tenant> {
  const res = await db.query<TenantRow>(
    `INSERT INTO tenant (name, slug) VALUES ($1, $2)
     RETURNING id, name, slug, deleted_at`,
    [input.name, input.slug]
  );
  return toTenant(res.rows[0]);
}

export async function createEnvironment(
  db: Queryable,
  input: { tenantId: string; name: string; url: string }
): Promise<Environment> {
  const res = await db.query<EnvironmentRow>(
    `INSERT INTO d365_environment (tenant_id, name, url) VALUES ($1, $2, $3)
     RETURNING id, tenant_id, name, url`,
    [input.tenantId, input.name, input.url]
  );
  return toEnvironment(res.rows[0]);
}

/**
 * Creates a legal entity inside one environment. The composite foreign key on
 * (environment_id, tenant_id) rejects an environment belonging to another
 * tenant, so a mismatch fails in the database rather than leaking across.
 */
export async function createCompany(
  db: Queryable,
  input: { tenantId: string; environmentId: string; name: string; dataAreaId: string }
): Promise<Company> {
  const res = await db.query<CompanyRow>(
    `INSERT INTO company (tenant_id, environment_id, name, data_area_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, tenant_id, environment_id, name, data_area_id`,
    [input.tenantId, input.environmentId, input.name, input.dataAreaId]
  );
  return toCompany(res.rows[0]);
}

/** Every legal entity held by one environment. */
export async function listCompaniesForEnvironment(
  db: Queryable,
  environmentId: string
): Promise<Company[]> {
  const res = await db.query<CompanyRow>(
    `SELECT id, tenant_id, environment_id, name, data_area_id
     FROM company WHERE environment_id = $1 ORDER BY name`,
    [environmentId]
  );
  return res.rows.map(toCompany);
}

/** Every environment held by one tenant. */
export async function listEnvironmentsForTenant(
  db: Queryable,
  tenantId: string
): Promise<Environment[]> {
  const res = await db.query<EnvironmentRow>(
    `SELECT id, tenant_id, name, url
     FROM d365_environment WHERE tenant_id = $1 ORDER BY name`,
    [tenantId]
  );
  return res.rows.map(toEnvironment);
}

export async function listActiveTenants(db: Queryable): Promise<Tenant[]> {
  const res = await db.query<TenantRow>(
    `SELECT id, name, slug, deleted_at
     FROM tenant WHERE deleted_at IS NULL ORDER BY slug`
  );
  return res.rows.map(toTenant);
}

export async function findTenant(
  db: Queryable,
  tenantId: string,
  options: { includeDeleted?: boolean } = {}
): Promise<Tenant | null> {
  const res = await db.query<TenantRow>(
    `SELECT id, name, slug, deleted_at
     FROM tenant
     WHERE id = $1 ${options.includeDeleted ? "" : "AND deleted_at IS NULL"}`,
    [tenantId]
  );
  return res.rows[0] ? toTenant(res.rows[0]) : null;
}

/**
 * Marks a tenant deleted without removing anything. Environments and companies
 * stay exactly where they are, which is what makes restore a recovery.
 * Returns null if the tenant does not exist or is already deleted.
 */
export async function softDeleteTenant(
  db: Queryable,
  tenantId: string,
  actor?: AuditActor
): Promise<Tenant | null> {
  const res = await db.query<TenantRow>(
    `UPDATE tenant SET deleted_at = now(), updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING id, name, slug, deleted_at`,
    [tenantId]
  );
  const tenant = res.rows[0] ? toTenant(res.rows[0]) : null;
  if (tenant && actor) {
    await recordAuditEntry(db, {
      tenantId: tenant.id,
      action: "tenant.soft_deleted",
      entityType: "tenant",
      entityId: tenant.id,
      actor,
      before: { deletedAt: null },
      after: { deletedAt: tenant.deletedAt }
    });
  }
  return tenant;
}

/** Reverses a soft delete. Returns null if the tenant is not currently deleted. */
export async function restoreTenant(
  db: Queryable,
  tenantId: string,
  actor?: AuditActor
): Promise<Tenant | null> {
  const previous = await findTenant(db, tenantId, { includeDeleted: true });
  const res = await db.query<TenantRow>(
    `UPDATE tenant SET deleted_at = NULL, updated_at = now()
     WHERE id = $1 AND deleted_at IS NOT NULL
     RETURNING id, name, slug, deleted_at`,
    [tenantId]
  );
  const tenant = res.rows[0] ? toTenant(res.rows[0]) : null;
  if (tenant && actor) {
    await recordAuditEntry(db, {
      tenantId: tenant.id,
      action: "tenant.restored",
      entityType: "tenant",
      entityId: tenant.id,
      actor,
      before: { deletedAt: previous?.deletedAt ?? null },
      after: { deletedAt: null }
    });
  }
  return tenant;
}
