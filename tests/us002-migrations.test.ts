import { describe, it, expect, afterEach } from "vitest";
import { Client } from "pg";
import migrate from "node-pg-migrate";
import { join } from "node:path";
import { repoRoot } from "./helpers";
import { createThrowawayDatabase, type ThrowawayDatabase } from "./pg-helpers";

const MIGRATIONS_DIR = join(repoRoot, "packages/db/migrations");
const MIGRATIONS_TABLE = "pgmigrations";
const CORE_TABLES = [
  "tenant",
  "d365_environment",
  "company",
  "user",
  "role",
  "permission",
  "user_role",
  "audit_log"
];

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  // Don't silently skip coverage.
  console.warn(
    "[US-002] DATABASE_URL not set — AC1/AC2 migration tests are SKIPPED. Set DATABASE_URL to a Postgres admin connection to run them."
  );
}

async function runMigrations(url: string, direction: "up" | "down"): Promise<void> {
  await migrate({
    databaseUrl: url,
    dir: MIGRATIONS_DIR,
    direction,
    count: Infinity,
    migrationsTable: MIGRATIONS_TABLE,
    log: () => {}
  });
}

async function listPublicTables(url: string): Promise<string[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const res = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
    );
    return res.rows.map((r) => r.table_name);
  } finally {
    await client.end();
  }
}

describe.skipIf(!hasDb)("US-002 - core schema migrations", () => {
  let current: ThrowawayDatabase | undefined;

  afterEach(async () => {
    await current?.drop();
    current = undefined;
  });

  // AC1: Given a fresh database, when migrations run, then all core tables exist.
  it("AC1: migrating up on a fresh database creates all core tables", async () => {
    current = await createThrowawayDatabase(adminUrl!);
    await runMigrations(current.url, "up");

    const tables = await listPublicTables(current.url);
    for (const table of CORE_TABLES) {
      expect(tables, `expected core table "${table}" to exist after migrate up`).toContain(table);
    }
  });

  // AC2: Given a migration, when it is applied, then a rollback path exists and is tested.
  it("AC2: rolling the migration back removes the core tables", async () => {
    current = await createThrowawayDatabase(adminUrl!);
    await runMigrations(current.url, "up");
    await runMigrations(current.url, "down");

    const tables = await listPublicTables(current.url);
    for (const table of CORE_TABLES) {
      expect(tables, `expected core table "${table}" to be gone after rollback`).not.toContain(table);
    }
  });
});
