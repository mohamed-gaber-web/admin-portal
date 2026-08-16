import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import migrate from "node-pg-migrate";
import { join } from "node:path";
import { repoRoot } from "../helpers";
import { createThrowawayDatabase, type ThrowawayDatabase } from "../pg-helpers";
import { startApi, type RunningApi } from "../api-server";
import { coversRoute } from "../route-guard";
import { seedTenant, type TenantFixture } from "../tenant-fixtures";

/**
 * Cross-tenant isolation for module entitlements (US-013, US-072).
 *
 * The interesting property here is not the usual one. `GET /modules` returns a
 * row for *every* module in the catalogue whichever tenant asks — the catalogue
 * is global, like the permission table. What must not cross the boundary is
 * which of them are marked **held**.
 *
 * That makes the failure mode quieter than a leaked list: a broken join would
 * return the same shape with the wrong flags, and a test that only counted rows
 * would pass. So these assertions are about `enabled`, not about length.
 */

const MIGRATIONS_DIR = join(repoRoot, "packages/db/migrations");
const PORT = 34829;
const JWT_SECRET = "isolation-modules-signing-key-at-least-32-chars";

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  // Don't silently skip coverage — this is the Alpha gate.
  console.warn(
    "[US-013] DATABASE_URL not set — the module entitlement isolation suite is SKIPPED. Set DATABASE_URL to a Postgres admin connection to run it."
  );
}

interface ModuleRow {
  key: string;
  enabled: boolean;
  enabledAt: string | null;
}

describe.skipIf(!hasDb)("US-013 - cross-tenant isolation of module entitlements", () => {
  let db: ThrowawayDatabase | undefined;
  let pool: Pool;
  let api: RunningApi | undefined;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;

  beforeAll(async () => {
    db = await createThrowawayDatabase(adminUrl!);
    await migrate({
      databaseUrl: db.url,
      dir: MIGRATIONS_DIR,
      direction: "up",
      count: Infinity,
      migrationsTable: "pgmigrations",
      log: () => {}
    });
    pool = new Pool({ connectionString: db.url });
    api = await startApi(PORT, { DATABASE_URL: db.url, AUTH_JWT_SECRET: JWT_SECRET });

    tenantA = await seedTenant(pool, api.baseUrl, "acme-modules", {});
    tenantB = await seedTenant(pool, api.baseUrl, "globex-modules", {});

    // Deliberately disjoint. Overlapping sets would let a query that ignored
    // the tenant boundary still look right for the shared entries.
    await grant(tenantA.tenantId, ["van-sales", "analytics"]);
    await grant(tenantB.tenantId, ["warehouse"]);
  });

  afterAll(async () => {
    api?.stop();
    await pool?.end();
    await db?.drop();
    db = undefined;
  });

  /** Granted directly, since the writing route is a platform one. */
  async function grant(tenantId: string, keys: string[]): Promise<void> {
    await pool.query(
      `INSERT INTO tenant_module (tenant_id, module_id)
       SELECT $1, m.id FROM module m WHERE m.key = ANY($2::text[])
       ON CONFLICT (tenant_id, module_id) DO NOTHING`,
      [tenantId, keys]
    );
  }

  const get = (path: string, token?: string): Promise<Response> =>
    fetch(`${api!.baseUrl}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {}
    });

  const heldBy = async (token: string): Promise<string[]> => {
    const res = await get("/modules", token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ModuleRow[];
    return body
      .filter((module) => module.enabled)
      .map((module) => module.key)
      .sort();
  };

  describe(coversRoute("GET /modules"), () => {
    it("marks only the caller's own entitlements as held", async () => {
      expect(await heldBy(tenantA.accessToken)).toEqual(["analytics", "van-sales"]);

      // And tenant B sees its own — so this is isolation rather than an
      // endpoint that reports nothing as held to everybody.
      expect(await heldBy(tenantB.accessToken)).toEqual(["warehouse"]);
    });

    it("returns the whole catalogue to both, since the catalogue is global", async () => {
      const asA = (await (await get("/modules", tenantA.accessToken)).json()) as ModuleRow[];
      const asB = (await (await get("/modules", tenantB.accessToken)).json()) as ModuleRow[];

      // Same modules, different flags. A tenant learning that a module exists is
      // not a leak — the product's feature list is not a secret — but learning
      // which of them another customer bought would be.
      expect(asA.map((m) => m.key).sort()).toEqual(asB.map((m) => m.key).sort());
      expect(asA.length).toBeGreaterThan(0);

      // The grant date does not cross either. It is the one field that would
      // survive a "held" flag being recomputed correctly but joined wrongly.
      const warehouseForA = asA.find((m) => m.key === "warehouse");
      expect(warehouseForA?.enabled).toBe(false);
      expect(warehouseForA?.enabledAt).toBeNull();
    });

    it("refuses an unauthenticated request rather than defaulting to a tenant", async () => {
      expect((await get("/modules")).status).toBe(401);
      expect((await get("/modules", "not.a.real.token")).status).toBe(401);
    });
  });
});
