import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { Client } from "pg";
import migrate from "node-pg-migrate";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { repoRoot, readJson, readText, type PackageJson } from "./helpers";
import { createThrowawayDatabase, type ThrowawayDatabase } from "./pg-helpers";
import { checkDatabase } from "../packages/db/src/preflight";
import { DEMO_TENANTS, DEMO_PERMISSIONS } from "../packages/db/src/seed";

const MIGRATIONS_DIR = join(repoRoot, "packages/db/migrations");
const MIGRATIONS_TABLE = "pgmigrations";

/** A port nothing listens on, for the unreachable-database case. */
const CLOSED_PORT_URL = "postgresql://postgres:postgres@127.0.0.1:1/postgres";

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  // Don't silently skip coverage.
  console.warn(
    "[US-006] DATABASE_URL not set — the live Postgres check (AC1) and the seed test (AC2) are SKIPPED. Set DATABASE_URL to a Postgres admin connection to run them."
  );
}

async function runMigrations(url: string): Promise<void> {
  await migrate({
    databaseUrl: url,
    dir: MIGRATIONS_DIR,
    direction: "up",
    count: Infinity,
    migrationsTable: MIGRATIONS_TABLE,
    log: () => {}
  });
}

/** Runs the real seed script the way a developer would, against `url`. */
function runSeedScript(url: string): string {
  return execSync("pnpm --filter @growpath/db seed", {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: url }
  });
}

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function countRows(client: Client, table: string, tenantId?: string): Promise<number> {
  // Table names are literals from this file, never user input.
  const sql = tenantId
    ? `SELECT count(*)::int AS count FROM "${table}" WHERE tenant_id = $1`
    : `SELECT count(*)::int AS count FROM "${table}"`;
  const res = await client.query<{ count: number }>(sql, tenantId ? [tenantId] : []);
  return res.rows[0]?.count ?? 0;
}

describe("US-006 - local development stack and seed data", () => {
  // AC1: Given a new machine, when the local stack starts, then Postgres runs locally.
  // (Redis is deliberately out of scope — see the US-006 report.)
  it("AC1: `pnpm bootstrap` verifies a running Postgres before migrating and seeding", async () => {
    const rootPkg = readJson<PackageJson>("package.json");
    // Not "setup": that is a built-in pnpm command and would shadow the script.
    expect(rootPkg.scripts?.bootstrap, "root package.json must expose the one-command setup").toBe(
      "node scripts/bootstrap.mjs"
    );
    expect(rootPkg.scripts?.setup, "`setup` is a pnpm built-in — do not use it").toBeUndefined();

    // The order matters: an unreachable database must fail before anything migrates.
    const setupScript = readText("scripts/bootstrap.mjs");
    const preflightAt = setupScript.indexOf("preflight-cli.js");
    const migrateAt = setupScript.indexOf("migrate:up");
    const seedAt = setupScript.indexOf("seed-cli.js");
    expect(preflightAt, "setup must run the preflight check").toBeGreaterThan(-1);
    expect(migrateAt, "setup must migrate after preflight").toBeGreaterThan(preflightAt);
    expect(seedAt, "setup must seed after migrating").toBeGreaterThan(migrateAt);

    // A stopped/absent server fails with guidance, not a bare driver error.
    await expect(checkDatabase(CLOSED_PORT_URL)).rejects.toThrow(/Cannot reach Postgres/);

    // And with a real connection, Postgres is genuinely running locally.
    if (hasDb) {
      const info = await checkDatabase(adminUrl);
      expect(info.version, "expected a live PostgreSQL server").toMatch(/PostgreSQL/);
      expect(
        info.canCreateDatabase,
        "the configured account needs CREATEDB for the throwaway-database tests"
      ).toBe(true);
    }
  });
});

describe.skipIf(!hasDb)("US-006 - seed data", () => {
  let db: ThrowawayDatabase | undefined;

  beforeAll(() => {
    // The seed script runs from dist, so build it once up front.
    execSync("pnpm --filter @growpath/db build", { cwd: repoRoot, stdio: "inherit" });
  });

  afterEach(async () => {
    await db?.drop();
    db = undefined;
  });

  // AC2: Given the seed script, when run, then two demo tenants with sample data exist.
  it("AC2: running the seed script creates two demo tenants with sample data", async () => {
    db = await createThrowawayDatabase(adminUrl!);
    await runMigrations(db.url);

    runSeedScript(db.url);

    await withClient(db.url, async (client) => {
      const tenants = await client.query<{ id: string; slug: string; name: string }>(
        // The reserved platform tenant is excluded: it is created by the
        // platform-administration migration, not by the seed, and it is not demo
        // data — a deployment with no platform tenant is one where no tenant can
        // ever be created. This assertion is about what `runSeedScript` produced.
        "SELECT id, slug, name FROM tenant WHERE NOT is_platform ORDER BY slug"
      );

      // Two tenants, not one — every isolation test needs a second tenant.
      expect(tenants.rowCount, "expected exactly two demo tenants").toBe(2);
      expect(tenants.rows.map((r) => r.slug)).toEqual(DEMO_TENANTS.map((t) => t.slug).sort());

      // The global permission catalogue is seeded too.
      expect(await countRows(client, "permission")).toBeGreaterThanOrEqual(
        DEMO_PERMISSIONS.length
      );

      // Each tenant carries sample data across every tenant-scoped table.
      for (const row of tenants.rows) {
        const expected = DEMO_TENANTS.find((t) => t.slug === row.slug);
        expect(expected, `unexpected tenant "${row.slug}"`).toBeDefined();
        expect(row.name).toBe(expected!.name);

        expect(await countRows(client, "d365_environment", row.id), `${row.slug}: environments`).toBe(1);
        expect(await countRows(client, "company", row.id), `${row.slug}: companies`).toBe(
          expected!.companies.length
        );
        expect(await countRows(client, "role", row.id), `${row.slug}: roles`).toBe(
          expected!.roles.length
        );
        expect(await countRows(client, "user", row.id), `${row.slug}: users`).toBe(
          expected!.users.length
        );
        expect(await countRows(client, "user_role", row.id), `${row.slug}: role assignments`).toBe(
          expected!.users.reduce((n, u) => n + u.roles.length, 0)
        );
        expect(await countRows(client, "audit_log", row.id), `${row.slug}: audit entries`).toBe(
          expected!.auditLog.length
        );
      }
    });

    // Re-running must not duplicate anything — `pnpm setup` seeds every time.
    //
    // Compared before and after rather than against absolute totals. The
    // criterion is "re-seeding adds nothing", and a hardcoded count answers it
    // only until something other than the seed writes a row — the reserved
    // platform tenant and its operator account both arrive by migration, and
    // each one broke this assertion in turn while saying nothing about
    // idempotency.
    const COUNTED_TABLES = ["tenant", "user", "company", "audit_log", "tenant_mobile_config"];

    const totals = async (): Promise<Record<string, number>> =>
      withClient(db!.url, async (client) => {
        const counts: Record<string, number> = {};
        for (const table of COUNTED_TABLES) {
          counts[table] = await countRows(client, table);
        }
        return counts;
      });

    const before = await totals();
    runSeedScript(db.url);
    const after = await totals();

    expect(after, "re-seeding must not duplicate any seeded row").toEqual(before);

    // Guard against a vacuous pass: the tables must have held something to
    // begin with, or "unchanged" would be a statement about nothing.
    for (const table of COUNTED_TABLES) {
      expect(before[table], `${table} must be seeded for this to mean anything`).toBeGreaterThan(0);
    }
  });
});
