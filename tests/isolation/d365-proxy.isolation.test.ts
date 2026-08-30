import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import migrate from "node-pg-migrate";
import { join } from "node:path";
import { repoRoot } from "../helpers";
import { createThrowawayDatabase, type ThrowawayDatabase } from "../pg-helpers";
import { startApi, type RunningApi } from "../api-server";
import { coversRoute } from "../route-guard";
import { seedTenant, type TenantFixture } from "../tenant-fixtures";
import { startEntraStub, type EntraStub } from "../entra-stub";
import { startD365Stub, type D365Stub } from "../d365-stub";

/**
 * Cross-tenant isolation for the ERP pass-through (US-013, US-046).
 *
 * The boundary this file defends is unusual, and worth stating plainly: the
 * proxy holds a credential with unrestricted access to *every* configured
 * customer's ERP. A leak across this boundary is not one tenant reading
 * another's rows — it is one tenant's device issuing requests against another
 * customer's ERP under a service principal that can do anything.
 *
 * The interesting case is therefore not the plain 404 but the **cached** one.
 * The token cache is keyed on environment, so once tenant B has warmed it a
 * naive implementation could hand tenant A a live token without ever consulting
 * the database. Every test below that asserts on stub request counts exists to
 * prove that did not happen.
 */

const MIGRATIONS_DIR = join(repoRoot, "packages/db/migrations");
// Unique across the suite: test files run in parallel, and a shared port means
// one file's server answering another file's requests.
const PORT = 34857;
const JWT_SECRET = "isolation-d365-proxy-signing-key-32-characters";
const ENCRYPTION_KEY = "isolation-d365-proxy-encryption-key-32-chars";

const ENTRA_TENANT_ID = "26c58d65-b577-4f92-aed2-cec1395d146d";
const CLIENT_ID = "db61ee09-84a1-4912-b319-709480fa243a";
const VICTIM_SECRET = "tenant-b-d365-client-secret";

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  console.warn(
    "[US-013] DATABASE_URL not set — the D365 proxy isolation suite is SKIPPED. Set DATABASE_URL to a Postgres admin connection to run it."
  );
}

describe.skipIf(!hasDb)("US-013 - cross-tenant isolation for the D365 proxy", () => {
  let db: ThrowawayDatabase | undefined;
  let pool: Pool;
  let api: RunningApi | undefined;
  let entra: EntraStub | undefined;
  let erp: D365Stub | undefined;
  let attacker: TenantFixture;
  let victim: TenantFixture;

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

    entra = await startEntraStub();
    entra.accept(CLIENT_ID, VICTIM_SECRET);
    erp = await startD365Stub();

    api = await startApi(PORT, {
      DATABASE_URL: db.url,
      AUTH_JWT_SECRET: JWT_SECRET,
      SECRET_ENCRYPTION_KEY: ENCRYPTION_KEY,
      D365_AUTHORITY_ORIGIN_OVERRIDE: entra.origin
    });

    attacker = await seedTenant(pool, api.baseUrl, "acme-proxy-iso", { companies: ["Acme"] });
    victim = await seedTenant(pool, api.baseUrl, "globex-proxy-iso", { companies: ["Globex"] });

    // The victim's environment points at the stub, so its ERP is genuinely
    // reachable. An isolation test against an unreachable one would pass for the
    // wrong reason.
    await pool.query("UPDATE d365_environment SET url = $1 WHERE tenant_id = $2", [
      erp.origin,
      victim.tenantId
    ]);

    // And it is genuinely configured. Proving nothing leaks from an environment
    // that holds no credential proves nothing at all.
    const configured = await send(
      "PUT",
      `/connections/${await environmentOf(victim.tenantId)}`,
      { entraTenantId: ENTRA_TENANT_ID, clientId: CLIENT_ID, clientSecret: VICTIM_SECRET },
      victim.accessToken
    );
    if (configured.status !== 200) {
      throw new Error(`fixture connection setup failed: ${await configured.text()}`);
    }
  });

  afterAll(async () => {
    api?.stop();
    await entra?.stop();
    await erp?.stop();
    await pool?.end();
    await db?.drop();
    db = undefined;
  });

  async function environmentOf(tenantId: string): Promise<string> {
    const res = await pool.query<{ id: string }>(
      "SELECT id FROM d365_environment WHERE tenant_id = $1 LIMIT 1",
      [tenantId]
    );
    return res.rows[0].id;
  }

  function send(
    method: string,
    path: string,
    body?: unknown,
    token?: string,
    companyId?: string
  ): Promise<Response> {
    return fetch(`${api!.baseUrl}${path}`, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(companyId ? { "x-d365-company": companyId } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  }

  /** Warms the token cache as the victim, so the attacker meets a hot cache. */
  async function warmVictimCache(): Promise<void> {
    const res = await send(
      "GET",
      "/d365/data/Companies",
      undefined,
      victim.accessToken,
      victim.companies[0].id
    );
    expect(res.status, await res.clone().text()).toBe(200);
  }

  describe(coversRoute("GET /d365/data/*"), () => {
    it("does not serve another tenant's company, even with the cache warm", async () => {
      await warmVictimCache();
      const erpCallsBefore = erp!.requests.length;
      const entraCallsBefore = entra!.requests.length;

      const res = await send(
        "GET",
        "/d365/data/Companies",
        undefined,
        attacker.accessToken,
        victim.companies[0].id
      );

      expect(res.status).toBe(404);
      // The whole point. A cached token plus a skipped database lookup would
      // have answered 200 here with the victim's data.
      expect(erp!.requests.length).toBe(erpCallsBefore);
      expect(entra!.requests.length).toBe(entraCallsBefore);
    });

    it("answers a foreign company id exactly as it answers a nonexistent one", async () => {
      const foreign = await send(
        "GET",
        "/d365/data/Companies",
        undefined,
        attacker.accessToken,
        victim.companies[0].id
      );
      const nowhere = await send(
        "GET",
        "/d365/data/Companies",
        undefined,
        attacker.accessToken,
        "00000000-0000-4000-8000-000000000000"
      );

      expect(foreign.status).toBe(nowhere.status);
      expect(await foreign.text()).toBe(await nowhere.text());
    });

    it("is genuinely fetchable by its owner", async () => {
      // The anti-vacuity check. Without it every assertion above would still
      // pass if the route were simply broken for everyone.
      const res = await send(
        "GET",
        "/d365/data/Companies",
        undefined,
        victim.accessToken,
        victim.companies[0].id
      );
      expect(res.status).toBe(200);
    });

    it("never forwards the caller's own access token to the ERP", async () => {
      await warmVictimCache();
      const seen = erp!.requests.at(-1);

      expect(seen?.headers.authorization).toBeDefined();
      expect(seen?.headers.authorization).not.toContain(victim.accessToken);
      // What it carries instead is the token the directory minted for us.
      expect(seen?.headers.authorization).toBe("Bearer stub.token.value");
    });
  });

  describe(coversRoute("POST /d365/data/*"), () => {
    it("refuses to create anything in another tenant's ERP", async () => {
      await warmVictimCache();
      const before = erp!.requests.length;

      const res = await send(
        "POST",
        "/d365/data/SalesOrderHeadersV3",
        { SalesOrderNumber: "SO-999" },
        attacker.accessToken,
        victim.companies[0].id
      );

      expect(res.status).toBe(404);
      expect(erp!.requests.length).toBe(before);
    });
  });

  describe(coversRoute("PUT /d365/data/*"), () => {
    it("refuses to replace anything in another tenant's ERP", async () => {
      const before = erp!.requests.length;
      const res = await send(
        "PUT",
        "/d365/data/SalesOrderHeadersV3('SO-1')",
        { SalesOrderName: "replaced" },
        attacker.accessToken,
        victim.companies[0].id
      );
      expect(res.status).toBe(404);
      expect(erp!.requests.length).toBe(before);
    });
  });

  describe(coversRoute("PATCH /d365/data/*"), () => {
    it("refuses to modify anything in another tenant's ERP", async () => {
      const before = erp!.requests.length;
      const res = await send(
        "PATCH",
        "/d365/data/SalesOrderHeadersV3('SO-1')",
        { SalesOrderName: "changed" },
        attacker.accessToken,
        victim.companies[0].id
      );
      expect(res.status).toBe(404);
      expect(erp!.requests.length).toBe(before);
    });
  });

  describe(coversRoute("DELETE /d365/data/*"), () => {
    it("refuses to delete anything in another tenant's ERP", async () => {
      const before = erp!.requests.length;
      const res = await send(
        "DELETE",
        "/d365/data/SalesOrderHeadersV3('SO-1')",
        undefined,
        attacker.accessToken,
        victim.companies[0].id
      );
      expect(res.status).toBe(404);
      expect(erp!.requests.length).toBe(before);
    });
  });

  describe(coversRoute("GET /d365/api/services/*"), () => {
    it("does not reach another tenant's custom services", async () => {
      const before = erp!.requests.length;
      const res = await send(
        "GET",
        "/d365/api/services/GPServiceGroup/GPService/status",
        undefined,
        attacker.accessToken,
        victim.companies[0].id
      );
      expect(res.status).toBe(404);
      expect(erp!.requests.length).toBe(before);
    });
  });

  describe(coversRoute("POST /d365/api/services/*"), () => {
    it("does not invoke another tenant's custom services", async () => {
      const before = erp!.requests.length;
      const res = await send(
        "POST",
        "/d365/api/services/GPServiceGroup/GPService/confirmReceipt",
        { id: "PO-1" },
        attacker.accessToken,
        victim.companies[0].id
      );
      expect(res.status).toBe(404);
      expect(erp!.requests.length).toBe(before);
    });
  });

  describe(coversRoute("PUT /d365/api/services/*"), () => {
    it("does not reach another tenant's custom services", async () => {
      const before = erp!.requests.length;
      const res = await send(
        "PUT",
        "/d365/api/services/GPServiceGroup/GPService/thing",
        { id: "PO-1" },
        attacker.accessToken,
        victim.companies[0].id
      );
      expect(res.status).toBe(404);
      expect(erp!.requests.length).toBe(before);
    });
  });

  describe(coversRoute("PATCH /d365/api/services/*"), () => {
    it("does not reach another tenant's custom services", async () => {
      const before = erp!.requests.length;
      const res = await send(
        "PATCH",
        "/d365/api/services/GPServiceGroup/GPService/thing",
        { id: "PO-1" },
        attacker.accessToken,
        victim.companies[0].id
      );
      expect(res.status).toBe(404);
      expect(erp!.requests.length).toBe(before);
    });
  });

  describe(coversRoute("DELETE /d365/api/services/*"), () => {
    it("does not reach another tenant's custom services", async () => {
      const before = erp!.requests.length;
      const res = await send(
        "DELETE",
        "/d365/api/services/GPServiceGroup/GPService/thing",
        undefined,
        attacker.accessToken,
        victim.companies[0].id
      );
      expect(res.status).toBe(404);
      expect(erp!.requests.length).toBe(before);
    });
  });

  describe("the proxy is not a way around authentication", () => {
    it("refuses a request with no token at all", async () => {
      const res = await send("GET", "/d365/data/Companies");
      expect(res.status).toBe(401);
      // 401 here is AccessTokenGuard, and it is the *only* 401 this route may
      // produce. An upstream rejection leaves as 502 — see the controller.
    });
  });
});
