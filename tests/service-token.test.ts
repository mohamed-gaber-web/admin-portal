import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import migrate from "node-pg-migrate";
import { join } from "node:path";
import { repoRoot } from "./helpers";
import { createThrowawayDatabase, type ThrowawayDatabase } from "./pg-helpers";
import { startApi, type RunningApi } from "./api-server";
import { seedTenant, type TenantFixture } from "./tenant-fixtures";
import { startEntraStub, type EntraStub } from "./entra-stub";
import { startD365Stub, type D365Stub } from "./d365-stub";
import { createServiceClient, revokeServiceClient } from "../packages/db/src/service-clients";
import { serviceTokenSchema } from "../packages/contracts/src/schemas/auth";
import { API_ROUTES } from "../packages/contracts/src/routes";

/**
 * Service clients: machine credentials for a scheduled job reading ERP data.
 *
 * What this file defends: a service token reaches exactly two things — reading
 * OData entities and listing the tenant's companies — and nothing else. Not a
 * write, not a custom service (which can post documents), not a single route a
 * person's token reaches. And it stays inside its tenant like everything else.
 */

const MIGRATIONS_DIR = join(repoRoot, "packages/db/migrations");
const PORT = 34895;
const JWT_SECRET = "service-token-suite-signing-key-32-characters";
const ENCRYPTION_KEY = "service-token-suite-encryption-key-32-chars";
const ENTRA_TENANT_ID = "26c58d65-b577-4f92-aed2-cec1395d146d";
const D365_CLIENT_ID = "db61ee09-84a1-4912-b319-709480fa243a";
const D365_SECRET = "service-suite-d365-client-secret";

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  console.warn(
    "[service-token] DATABASE_URL not set — the service client tests are SKIPPED. Set DATABASE_URL to a Postgres admin connection to run them."
  );
}

describe.skipIf(!hasDb)("service clients - read-only machine access to ERP data", () => {
  let db: ThrowawayDatabase | undefined;
  let pool: Pool;
  let api: RunningApi | undefined;
  let entra: EntraStub | undefined;
  let erp: D365Stub | undefined;
  let owner: TenantFixture;
  let other: TenantFixture;
  let clientId: string;
  let clientSecret: string;

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
    entra.accept(D365_CLIENT_ID, D365_SECRET);
    erp = await startD365Stub();

    api = await startApi(PORT, {
      DATABASE_URL: db.url,
      AUTH_JWT_SECRET: JWT_SECRET,
      SECRET_ENCRYPTION_KEY: ENCRYPTION_KEY,
      D365_AUTHORITY_ORIGIN_OVERRIDE: entra.origin
    });

    owner = await seedTenant(pool, api.baseUrl, "acme-service", { companies: ["Acme"] });
    other = await seedTenant(pool, api.baseUrl, "globex-service", { companies: ["Globex"] });

    for (const tenant of [owner, other]) {
      await pool.query("UPDATE d365_environment SET url = $1 WHERE tenant_id = $2", [
        erp.origin,
        tenant.tenantId
      ]);
      const env = await pool.query<{ id: string }>(
        "SELECT id FROM d365_environment WHERE tenant_id = $1 LIMIT 1",
        [tenant.tenantId]
      );
      const configured = await send(
        "PUT",
        `/connections/${env.rows[0].id}`,
        { entraTenantId: ENTRA_TENANT_ID, clientId: D365_CLIENT_ID, clientSecret: D365_SECRET },
        tenant.accessToken
      );
      if (configured.status !== 200) {
        throw new Error(`fixture connection setup failed: ${await configured.text()}`);
      }
    }

    const created = await createServiceClient(pool, {
      tenantId: owner.tenantId,
      name: "Reports sync",
      actorLabel: "test"
    });
    clientId = created.client.clientId;
    clientSecret = created.clientSecret;
  });

  afterAll(async () => {
    api?.stop();
    await entra?.stop();
    await erp?.stop();
    await pool?.end();
    await db?.drop();
    db = undefined;
  });

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

  async function exchange(id = clientId, secret = clientSecret): Promise<Response> {
    return send("POST", API_ROUTES.serviceToken, { clientId: id, clientSecret: secret });
  }

  async function serviceToken(): Promise<string> {
    const res = await exchange();
    expect(res.status).toBe(200);
    return ((await res.json()) as { accessToken: string }).accessToken;
  }

  describe("the exchange", () => {
    it("issues a token matching the contract, for the client's own tenant", async () => {
      const res = await exchange();
      expect(res.status).toBe(200);
      const body = await res.json();
      const parsed = serviceTokenSchema.safeParse(body);
      expect(parsed.success, JSON.stringify(body)).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data.tenant.id).toBe(owner.tenantId);
      expect(parsed.data.scopes).toEqual(["d365.data.read"]);
      expect(parsed.data.expiresIn).toBe(900);
    });

    it("stores only a digest of the secret", async () => {
      const res = await pool.query<{ secret_hash: string }>(
        "SELECT secret_hash FROM service_client WHERE client_id = $1",
        [clientId]
      );
      expect(res.rows[0].secret_hash).not.toContain(clientSecret);
      expect(res.rows[0].secret_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("answers a wrong secret and an unknown client identically, and records both", async () => {
      const wrong = await exchange(clientId, "not-the-secret");
      const unknown = await exchange("svc_doesnotexist", "whatever");
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(await wrong.text()).toBe(await unknown.text());

      const events = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM auth_event WHERE event = 'service_token.rejected'"
      );
      expect(events.rows[0].count).toBeGreaterThanOrEqual(2);
    });

    it("refuses a revoked client", async () => {
      const created = await createServiceClient(pool, {
        tenantId: owner.tenantId,
        name: "To be revoked",
        actorLabel: "test"
      });
      expect((await exchange(created.client.clientId, created.clientSecret)).status).toBe(200);

      await revokeServiceClient(pool, {
        clientId: created.client.clientId,
        reason: "test",
        actorLabel: "test"
      });
      expect((await exchange(created.client.clientId, created.clientSecret)).status).toBe(401);
    });

    it("cannot be created with a scope outside the allowlist", async () => {
      await expect(
        pool.query(
          `INSERT INTO service_client (tenant_id, name, client_id, secret_hash, scopes, created_by)
           VALUES ($1, 'x', 'svc_bad', 'h', ARRAY['user.write'], 'test')`,
          [owner.tenantId]
        )
      ).rejects.toThrow(/service_client_scopes_check/);
    });
  });

  describe("what the token reaches", () => {
    it("reads OData entities through the proxy", async () => {
      const token = await serviceToken();
      const before = erp!.requests.length;
      const res = await send(
        "GET",
        "/d365/data/CustomersV3?$top=1",
        undefined,
        token,
        owner.companies[0].id
      );
      expect(res.status, await res.clone().text()).toBe(200);
      expect(erp!.requests.length).toBe(before + 1);
      // The ERP sees our service principal, never the caller's token.
      expect(erp!.requests.at(-1)?.headers.authorization).not.toContain(token);
    });

    it("lists its own tenant's companies, and only those", async () => {
      const token = await serviceToken();
      const res = await send("GET", API_ROUTES.companies, undefined, token);
      expect(res.status).toBe(200);
      const companies = (await res.json()) as { id: string }[];
      expect(companies.map((c) => c.id)).toEqual(owner.companies.map((c) => c.id));
    });

    it("cannot reach another tenant's company through the proxy", async () => {
      const token = await serviceToken();
      const before = erp!.requests.length;
      const res = await send(
        "GET",
        "/d365/data/CustomersV3",
        undefined,
        token,
        other.companies[0].id
      );
      expect(res.status).toBe(404);
      expect(erp!.requests.length).toBe(before);
    });

    it.each([
      ["POST", "/d365/data/SalesOrderHeadersV3"],
      ["PATCH", "/d365/data/SalesOrderHeadersV3('SO-1')"],
      ["DELETE", "/d365/data/SalesOrderHeadersV3('SO-1')"],
      ["GET", "/d365/api/services/GPServiceGroup/GPService/status"],
      ["POST", "/d365/api/services/GPServiceGroup/GPService/confirmReceipt"]
    ])("is refused on %s %s, before the ERP is contacted", async (method, path) => {
      const token = await serviceToken();
      const before = erp!.requests.length;
      const res = await send(
        method,
        path,
        method === "GET" || method === "DELETE" ? undefined : { x: 1 },
        token,
        owner.companies[0].id
      );
      expect(res.status).toBe(401);
      expect(erp!.requests.length).toBe(before);
    });

    it.each([
      ["GET", "/me"],
      ["GET", "/users"],
      ["GET", "/connections"],
      ["GET", "/activity"],
      ["GET", "/tenants"],
      ["GET", "/modules"],
      ["GET", "/platform/tenants"]
    ])("is refused on %s %s, which only a person's token reaches", async (method, path) => {
      const token = await serviceToken();
      const res = await send(method, path, undefined, token);
      expect(res.status).toBe(401);
    });

    it("leaves a person's token working on the opted-in routes", async () => {
      const res = await send("GET", API_ROUTES.companies, undefined, owner.accessToken);
      expect(res.status).toBe(200);
    });
  });
});
