import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool, type PoolClient } from "pg";
import migrate from "node-pg-migrate";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { repoRoot } from "./helpers";
import { createThrowawayDatabase, type ThrowawayDatabase } from "./pg-helpers";
import {
  findTablesMissingRlsPolicies,
  PROTECTED_TABLES,
  TENANT_SCOPED_TABLES
} from "../packages/db/src/rls";

const MIGRATIONS_DIR = join(repoRoot, "packages/db/migrations");
const MIGRATIONS_TABLE = "pgmigrations";

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  // Don't silently skip coverage.
  console.warn(
    "[US-011] DATABASE_URL not set — the row level security tests are SKIPPED. Set DATABASE_URL to a Postgres admin connection to run them."
  );
}

/**
 * Runs `fn` as `app_user` — a role with neither superuser nor BYPASSRLS.
 *
 * This is the whole point: the admin connection is a superuser that owns every
 * table, and superusers bypass RLS unconditionally. Querying as `postgres`
 * would make every assertion below pass while proving nothing.
 *
 * Everything happens inside a transaction that is always rolled back, so the
 * role and tenant context are transaction-local and no writes survive.
 */
async function asAppUser<T>(
  pool: Pool,
  tenantId: string | null,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE app_user");
    if (tenantId) {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    }
    const result = await fn(client);
    await client.query("ROLLBACK");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function countAs(client: PoolClient, table: string): Promise<number> {
  // Table names come from this file's own constants, never user input.
  const res = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM "${table}"`);
  return res.rows[0]?.count ?? 0;
}

describe.skipIf(!hasDb)("US-011 - row level security on tenant tables", () => {
  let db: ThrowawayDatabase | undefined;
  let pool: Pool;
  let tenantA: string;
  let tenantB: string;
  let companyB: string;
  let environmentB: string;

  beforeAll(async () => {
    db = await createThrowawayDatabase(adminUrl!);
    await migrate({
      databaseUrl: db.url,
      dir: MIGRATIONS_DIR,
      direction: "up",
      count: Infinity,
      migrationsTable: MIGRATIONS_TABLE,
      log: () => {}
    });

    // The seed populates every tenant table for two tenants, which is exactly
    // the shape these tests need. It runs as the admin user and so bypasses RLS.
    execSync("pnpm --filter @growpath/db build && pnpm --filter @growpath/db seed", {
      cwd: repoRoot,
      stdio: "pipe",
      env: { ...process.env, DATABASE_URL: db.url }
    });

    pool = new Pool({ connectionString: db.url });

    const tenants = await pool.query<{ id: string; slug: string }>(
      "SELECT id, slug FROM tenant ORDER BY slug"
    );
    tenantA = tenants.rows[0].id; // acme
    tenantB = tenants.rows[1].id; // globex

    const companies = await pool.query<{ id: string; environment_id: string }>(
      "SELECT id, environment_id FROM company WHERE tenant_id = $1 LIMIT 1",
      [tenantB]
    );
    companyB = companies.rows[0].id;
    environmentB = companies.rows[0].environment_id;
  });

  afterAll(async () => {
    await pool?.end();
    await db?.drop();
    db = undefined;
  });

  // AC1: Given a session without a tenant context, when a tenant table is
  // queried, then zero rows return.
  it("AC1: a session with no tenant context sees zero rows in every tenant table", async () => {
    // Guard against a vacuous pass: the tables genuinely hold rows.
    for (const table of PROTECTED_TABLES) {
      const seeded = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM "${table}"`
      );
      expect(seeded.rows[0].count, `${table} must hold seeded rows for this test to mean anything`)
        .toBeGreaterThan(0);
    }

    await asAppUser(pool, null, async (client) => {
      for (const table of PROTECTED_TABLES) {
        expect(
          await countAs(client, table),
          `${table} must return zero rows without a tenant context`
        ).toBe(0);
      }
    });
  });

  // AC2: Given a session set to tenant A, when tenant B rows are queried
  // directly in SQL, then zero rows return.
  it("AC2: a session scoped to tenant A cannot read tenant B rows", async () => {
    await asAppUser(pool, tenantA, async (client) => {
      // Tenant A's own rows are visible — isolation, not a blanket denial.
      const own = await client.query<{ tenant_id: string }>("SELECT tenant_id FROM company");
      expect(own.rowCount).toBeGreaterThan(0);
      expect(own.rows.every((r) => r.tenant_id === tenantA)).toBe(true);

      // Asking for tenant B explicitly returns nothing...
      const byTenant = await client.query("SELECT * FROM company WHERE tenant_id = $1", [tenantB]);
      expect(byTenant.rowCount).toBe(0);

      // ...and neither does going straight at a known primary key.
      const byId = await client.query("SELECT * FROM company WHERE id = $1", [companyB]);
      expect(byId.rowCount).toBe(0);

      // The root tenant table is scoped too.
      const tenants = await client.query<{ id: string }>("SELECT id FROM tenant");
      expect(tenants.rows.map((r) => r.id)).toEqual([tenantA]);

      // Every other tenant-scoped table holds only tenant A rows.
      for (const table of TENANT_SCOPED_TABLES) {
        const rows = await client.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM "${table}"`
        );
        expect(
          rows.rows.every((r) => r.tenant_id === tenantA),
          `${table} leaked rows from another tenant`
        ).toBe(true);
      }
    });

    // Writes are fenced by the same policy, not just reads.
    await expect(
      asAppUser(pool, tenantA, (client) =>
        client.query(
          "INSERT INTO company (tenant_id, environment_id, name, data_area_id) VALUES ($1, $2, $3, $4)",
          [tenantB, environmentB, "Smuggled Ltd", "smug"]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  // AC3: Given a new tenant table, when added without a policy, then CI fails.
  it("AC3: a tenant table without a policy is reported, which fails CI", async () => {
    // The real schema is clean.
    expect(await findTablesMissingRlsPolicies(pool)).toEqual([]);

    // Negative control. Without this the test would pass just as happily
    // against an audit that always returns an empty array.
    await pool.query(
      "CREATE TABLE rls_guard_probe (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL)"
    );
    // A table with RLS switched on but no policy is equally unprotected.
    await pool.query(
      "CREATE TABLE rls_policyless_probe (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL)"
    );
    await pool.query("ALTER TABLE rls_policyless_probe ENABLE ROW LEVEL SECURITY");

    try {
      const missing = await findTablesMissingRlsPolicies(pool);
      const names = missing.map((t) => t.table);
      expect(names, "a new tenant_id table with no RLS must be flagged").toContain(
        "rls_guard_probe"
      );
      expect(names, "RLS enabled with no policy must also be flagged").toContain(
        "rls_policyless_probe"
      );

      const policyless = missing.find((t) => t.table === "rls_policyless_probe");
      expect(policyless?.rlsEnabled).toBe(true);
      expect(policyless?.policyCount).toBe(0);
    } finally {
      await pool.query("DROP TABLE rls_guard_probe");
      await pool.query("DROP TABLE rls_policyless_probe");
    }

    // ...and clean again once the probes are gone.
    expect(await findTablesMissingRlsPolicies(pool)).toEqual([]);
  });
});
