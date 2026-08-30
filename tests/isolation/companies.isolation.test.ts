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
 * Cross-tenant isolation for the company routes (US-013).
 *
 * This is the suite the US-013 guard requires of every tenant-scoped route. It
 * is deliberately end-to-end: the tokens are ones the API issued, the requests
 * go over HTTP, and the filtering is whatever the real stack does — not a unit
 * test of the layer we happen to trust today.
 */

const MIGRATIONS_DIR = join(repoRoot, "packages/db/migrations");
const PORT = 34823;
const JWT_SECRET = "isolation-suite-signing-key-at-least-32-chars";

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  // Don't silently skip coverage — this is the Alpha gate.
  console.warn(
    "[US-013] DATABASE_URL not set — the cross-tenant isolation suite is SKIPPED. Set DATABASE_URL to a Postgres admin connection to run it."
  );
}

describe.skipIf(!hasDb)("US-013 - cross-tenant isolation", () => {
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

    // Two tenants, each with something worth stealing.
    tenantA = await seedTenant(pool, api.baseUrl, "acme-iso", {
      companies: ["Acme Manufacturing", "Acme Retail"]
    });
    tenantB = await seedTenant(pool, api.baseUrl, "globex-iso", {
      companies: ["Globex Holdings"]
    });
  });

  afterAll(async () => {
    api?.stop();
    await pool?.end();
    await db?.drop();
    db = undefined;
  });

  const get = (path: string, token?: string): Promise<Response> =>
    fetch(`${api!.baseUrl}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {}
    });

  describe(coversRoute("GET /companies"), () => {
    it("returns only the caller's own companies", async () => {
      const res = await get("/companies", tenantA.accessToken);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { id: string; name: string }[];
      expect(body.map((c) => c.name).sort()).toEqual(["Acme Manufacturing", "Acme Retail"]);

      // Tenant B's company is genuinely absent, not merely last in the list.
      const ids = new Set(body.map((c) => c.id));
      for (const company of tenantB.companies) {
        expect(ids.has(company.id), "tenant A must not see a tenant B company").toBe(false);
      }

      // And the same request as tenant B returns tenant B's, so this is
      // isolation rather than an endpoint that returns nothing useful.
      const asB = await get("/companies", tenantB.accessToken);
      expect(((await asB.json()) as { name: string }[]).map((c) => c.name)).toEqual([
        "Globex Holdings"
      ]);
    });

    it("refuses an unauthenticated request rather than defaulting to a tenant", async () => {
      expect((await get("/companies")).status).toBe(401);
      expect((await get("/companies", "not.a.real.token")).status).toBe(401);
    });
  });

  describe(coversRoute("GET /companies/:id"), () => {
    // US-013 AC1: tenant A requesting any tenant B resource gets a 404, not a 403.
    it("answers 404, never 403, for another tenant's company", async () => {
      const victim = tenantB.companies[0].id;

      const res = await get(`/companies/${victim}`, tenantA.accessToken);
      expect(res.status).toBe(404);
      expect(
        res.status,
        "403 would confirm the company exists, which is the leak this prevents"
      ).not.toBe(403);

      // The response body must not leak it either.
      const text = await res.text();
      expect(text).not.toContain(tenantB.companies[0].name);
      expect(text).not.toContain(tenantB.tenantId);

      // Indistinguishable from an id that exists nowhere at all.
      const absent = await get(
        "/companies/00000000-0000-4000-8000-000000000000",
        tenantA.accessToken
      );
      expect(absent.status).toBe(404);
      expect(await absent.text()).toBe(text);

      // Guard against a vacuous pass: the id is real, and its owner can fetch it.
      const owner = await get(`/companies/${victim}`, tenantB.accessToken);
      expect(owner.status, "the fixture id must be genuinely fetchable").toBe(200);
      expect(((await owner.json()) as { id: string }).id).toBe(victim);
    });

    it("does not turn a malformed id into a server error", async () => {
      // A 500 on a non-uuid would tell a caller their guess was at least
      // well-formed, which is a slower version of the same oracle.
      const res = await get("/companies/not-a-uuid", tenantA.accessToken);
      expect(res.status).toBe(404);
    });
  });
});
