import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Pool } from "pg";
import migrate from "node-pg-migrate";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { repoRoot } from "./helpers";
import { createThrowawayDatabase, type ThrowawayDatabase } from "./pg-helpers";
import { startApi, type RunningApi } from "./api-server";
import { seedPlatformAdmin, type PlatformAdminFixture } from "./tenant-fixtures";
import {
  withRequestTenantScope,
  withoutTenantScope,
  MissingTenantContextError,
  UnscopedAccessError,
  APPLICATION_ROLE
} from "../packages/db/src/scoping";
import {
  CORRELATION_ID_HEADER,
  createLogger,
  runWithRequestContext
} from "../packages/observability/src/index";

const MIGRATIONS_DIR = join(repoRoot, "packages/db/migrations");
const MIGRATIONS_TABLE = "pgmigrations";
const PORT = 34819;
const JWT_SECRET = "us012-suite-signing-key-at-least-32-characters";

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  // Don't silently skip coverage.
  console.warn(
    "[US-012] DATABASE_URL not set — the tenant scoping tests are SKIPPED. Set DATABASE_URL to a Postgres admin connection to run them."
  );
}

describe.skipIf(!hasDb)("US-012 - automatic tenant scoping in the data layer", () => {
  let db: ThrowawayDatabase | undefined;
  let pool: Pool;
  let api: RunningApi | undefined;
  let operator: PlatformAdminFixture;
  let tenantA: string;
  let tenantB: string;

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

    // The seed gives two tenants with rows in every tenant table — one tenant
    // would let a broken filter pass unnoticed.
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

    api = await startApi(
      PORT,
      { DATABASE_URL: db.url, AUTH_JWT_SECRET: JWT_SECRET },
      { captureLogs: true }
    );

    // Provisioning is platform-only, so AC2's assertion about the escape
    // hatch's log line needs a caller the guard lets through.
    operator = await seedPlatformAdmin(pool, api.baseUrl);
  });

  afterAll(async () => {
    api?.stop();
    await pool?.end();
    await db?.drop();
    db = undefined;
  });

  // AC1: Given any query, when executed, then the tenant filter is injected
  // from the request context.
  it("AC1: the same query returns a different tenant's rows purely from the request context", async () => {
    // Identical query, no tenant argument anywhere in it.
    const listCompanies = (): Promise<{ tenant_id: string }[]> =>
      withRequestTenantScope(pool, async (client) => {
        const res = await client.query<{ tenant_id: string }>("SELECT tenant_id FROM company");
        return res.rows;
      });

    const asA = await runWithRequestContext({ tenantId: tenantA }, listCompanies);
    const asB = await runWithRequestContext({ tenantId: tenantB }, listCompanies);

    expect(asA.length, "the seed must give tenant A companies").toBeGreaterThan(0);
    expect(asB.length, "the seed must give tenant B companies").toBeGreaterThan(0);
    expect(asA.every((r) => r.tenant_id === tenantA)).toBe(true);
    expect(asB.every((r) => r.tenant_id === tenantB)).toBe(true);

    // The filter is the database's, not the caller's: asking for the other
    // tenant explicitly still returns nothing.
    const smuggled = await runWithRequestContext({ tenantId: tenantA }, () =>
      withRequestTenantScope(pool, (client) =>
        client.query("SELECT * FROM company WHERE tenant_id = $1", [tenantB])
      )
    );
    expect(smuggled.rowCount).toBe(0);

    // Which only means anything because the session is not a superuser —
    // superusers bypass row level security unconditionally.
    const role = await runWithRequestContext({ tenantId: tenantA }, () =>
      withRequestTenantScope(pool, async (client) => {
        const res = await client.query<{ role: string }>("SELECT current_user AS role");
        return res.rows[0].role;
      })
    );
    expect(role).toBe(APPLICATION_ROLE);

    // The tenant cannot be supplied by the caller at all: there is no parameter
    // for it, so no header or route param can reach it.
    expect(withRequestTenantScope.length).toBe(2);

    // Fails closed. Forgetting authentication is an error, not an unscoped read.
    await expect(
      runWithRequestContext({}, () => withRequestTenantScope(pool, (c) => c.query("SELECT 1")))
    ).rejects.toThrow(MissingTenantContextError);

    // And outside a request context entirely.
    await expect(withRequestTenantScope(pool, (c) => c.query("SELECT 1"))).rejects.toThrow(
      MissingTenantContextError
    );
  });

  // AC2: Given a query that deliberately bypasses scoping, when run, then it
  // requires an explicit escape hatch that is logged.
  it("AC2: bypassing scoping requires a stated reason and writes a warning", async () => {
    const REASON = "Cross-tenant platform report (US-012 test).";

    // The default logger writes to stdout; spying on it proves the real path
    // logs, rather than a logger the test handed in for the purpose.
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    let rows: { tenant_id: string }[];
    try {
      rows = await runWithRequestContext({ correlationId: "corr-bypass-9999" }, () =>
        withoutTenantScope(pool, { reason: REASON }, async (client) => {
          const res = await client.query<{ tenant_id: string }>("SELECT tenant_id FROM company");
          return res.rows;
        })
      );
    } finally {
      spy.mockRestore();
    }

    // It genuinely bypasses: both tenants come back.
    const seen = new Set(rows.map((r) => r.tenant_id));
    expect(seen.has(tenantA)).toBe(true);
    expect(seen.has(tenantB)).toBe(true);

    const warning = written
      .flatMap((chunk) => chunk.split("\n"))
      .filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line.msg === "tenant.scope.bypassed");

    expect(warning, `expected a bypass warning. Captured:\n${written.join("")}`).toBeDefined();
    expect(warning).toMatchObject({
      level: "warn",
      reason: REASON,
      // Traceable to the request that caused it (US-007).
      correlationId: "corr-bypass-9999"
    });
    expect(warning!.callSite, "the warning should point at the bypass").toContain(
      "us012-tenant-scoping"
    );

    // An unexplained bypass is refused, and refused before it runs.
    const silent = createLogger({ name: "db", sink: () => undefined });
    let ran = false;
    await expect(
      withoutTenantScope(pool, { reason: "   ", logger: silent }, async () => {
        ran = true;
      })
    ).rejects.toThrow(UnscopedAccessError);
    expect(ran, "the callback must not run when the reason is missing").toBe(false);
  });

  // AC2, on the real path: the one endpoint that legitimately bypasses scoping
  // goes through the escape hatch, so the bypass is in the log with the
  // request's correlation ID rather than being an unremarked admin query.
  it("AC2: the provisioning endpoint's bypass is logged against the request", async () => {
    const correlationId = "us012-provisioning-request";
    const res = await fetch(`${api!.baseUrl}/tenants`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CORRELATION_ID_HEADER]: correlationId,
        // Provisioning is platform-only now; without this the request never
        // reaches the escape hatch whose log line this test is looking for.
        ...operator.headers
      },
      body: JSON.stringify({ name: "Soylent", slug: "soylent" })
    });
    expect(res.status).toBe(201);

    const deadline = Date.now() + 5000;
    let bypass: Record<string, unknown> | undefined;
    while (Date.now() < deadline && !bypass) {
      bypass = api!
        .logs()
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("{"))
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>];
          } catch {
            return [];
          }
        })
        /*
         * Matched on the reason as well as the correlation ID.
         *
         * A provisioning request now logs two bypasses, both legitimate: the
         * platform guard resolves the reserved tenant — which by definition is
         * not the tenant of any scoped session — and then provisioning creates
         * the tenant there is no context for. Taking whichever landed first
         * would make this assertion depend on the order.
         */
        .find(
          (line) =>
            line.msg === "tenant.scope.bypassed" &&
            line.correlationId === correlationId &&
            /provisioning/i.test(String(line.reason))
        );
      if (!bypass) await new Promise((r) => setTimeout(r, 50));
    }

    expect(bypass, `expected a logged bypass. Captured:\n${api!.logs()}`).toBeDefined();
    expect(bypass!.level).toBe("warn");
    expect(String(bypass!.reason)).toMatch(/provisioning/i);
  });
});
