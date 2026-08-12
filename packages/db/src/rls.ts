import type { PoolClient } from "pg";
import type { Queryable } from "./tenancy";

/** The root tenancy table. Its policy keys on `id`, not `tenant_id`. */
export const ROOT_TENANT_TABLE = "tenant";

/** Tenant-scoped tables, each carrying a non-null `tenant_id`. */
export const TENANT_SCOPED_TABLES = [
  "d365_environment",
  "company",
  "user",
  "role",
  "user_role",
  "audit_log",
  "role_permission",
  "user_invitation",
  "refresh_token"
] as const;

/**
 * Tables carrying a *nullable* `tenant_id`, which are therefore covered by the
 * schema-derived audit but cannot be asserted on like the list above.
 *
 * `auth_event` is the only one: a failed sign-in for an unknown email has no
 * tenant, and that is precisely the event worth recording. Its reads are
 * scoped; its writes deliberately are not. See the S3 migration.
 */
export const PARTIALLY_SCOPED_TABLES = ["auth_event"] as const;

/** Every table that must carry a tenant isolation policy. */
export const PROTECTED_TABLES: readonly string[] = [
  ROOT_TENANT_TABLE,
  ...TENANT_SCOPED_TABLES,
  ...PARTIALLY_SCOPED_TABLES
];

/** Session GUC holding the current tenant. */
export const TENANT_CONTEXT_SETTING = "app.tenant_id";

/**
 * Scopes the current transaction to one tenant. `set_config(..., true)` is
 * transaction-local, so the context cannot leak to the next borrower of a
 * pooled connection.
 *
 * Must be called inside a transaction; `withTenantContext` handles that.
 */
export async function setTenantContext(client: PoolClient, tenantId: string): Promise<void> {
  await client.query("SELECT set_config($1, $2, true)", [TENANT_CONTEXT_SETTING, tenantId]);
}

/**
 * Runs `fn` in a transaction scoped to one tenant. Every tenant table read
 * inside sees only that tenant's rows, enforced by the database rather than by
 * remembering to write the right WHERE clause.
 */
export async function withTenantContext<T>(
  client: PoolClient,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  await client.query("BEGIN");
  try {
    await setTenantContext(client, tenantId);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

export interface UnprotectedTable {
  table: string;
  rlsEnabled: boolean;
  policyCount: number;
}

/**
 * Returns every tenant table lacking row level security or a policy.
 *
 * The rule is derived from the schema — any public table carrying a
 * `tenant_id` column, plus the root `tenant` table — so a table added later is
 * covered automatically instead of relying on someone updating a list.
 */
export async function findTablesMissingRlsPolicies(db: Queryable): Promise<UnprotectedTable[]> {
  const res = await db.query<{ table: string; rls_enabled: boolean; policy_count: number }>(
    `SELECT c.relname AS table,
            c.relrowsecurity AS rls_enabled,
            (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND (
         c.relname = $1
         OR EXISTS (
           SELECT 1 FROM pg_attribute a
           WHERE a.attrelid = c.oid
             AND a.attname = 'tenant_id'
             AND a.attnum > 0
             AND NOT a.attisdropped
         )
       )
     ORDER BY c.relname`,
    [ROOT_TENANT_TABLE]
  );

  return res.rows
    .filter((row) => !row.rls_enabled || row.policy_count === 0)
    .map((row) => ({
      table: row.table,
      rlsEnabled: row.rls_enabled,
      policyCount: row.policy_count
    }));
}
