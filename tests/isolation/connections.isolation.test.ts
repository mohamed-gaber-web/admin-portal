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

/**
 * Cross-tenant isolation for the connection and mobile configuration routes
 * (US-013, US-040).
 *
 * These routes carry the highest-value secret in the system — a D365 service
 * principal with unrestricted access to a customer's ERP — so the usual
 * question is sharper here than elsewhere: a leak across this boundary is not a
 * disclosure of one tenant's records but of the credential that reads all of
 * them.
 *
 * `GET /mobile/config` is deliberately absent. It is classified `public` and
 * takes a slug by design, so it has no tenant boundary to prove; its
 * enumeration behaviour is covered by AC6 of the US-040 suite instead.
 */

const MIGRATIONS_DIR = join(repoRoot, "packages/db/migrations");
// Unique across the suite: test files run in parallel, and a shared port means
// one file's server answering another file's requests.
const PORT = 34834;
const JWT_SECRET = "isolation-connections-signing-key-32-chars";
const ENCRYPTION_KEY = "isolation-connections-encryption-key-32-chars";

const ENTRA_TENANT_ID = "26c58d65-b577-4f92-aed2-cec1395d146d";
const CLIENT_ID = "db61ee09-84a1-4912-b319-709480fa243a";
const VICTIM_SECRET = "tenant-b-d365-client-secret";

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  console.warn(
    "[US-013] DATABASE_URL not set — the connection isolation suite is SKIPPED. Set DATABASE_URL to a Postgres admin connection to run it."
  );
}

describe.skipIf(!hasDb)("US-013 - cross-tenant isolation for connections", () => {
  let db: ThrowawayDatabase | undefined;
  let pool: Pool;
  let api: RunningApi | undefined;
  let entra: EntraStub | undefined;
  let tenantA: TenantFixture;
  let tenantB: TenantFixture;
  /** Tenant B's environment — the one tenant A must never reach. */
  let victimEnvironmentId: string;
  let ownEnvironmentId: string;

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

    api = await startApi(PORT, {
      DATABASE_URL: db.url,
      AUTH_JWT_SECRET: JWT_SECRET,
      SECRET_ENCRYPTION_KEY: ENCRYPTION_KEY,
      D365_AUTHORITY_ORIGIN_OVERRIDE: entra.origin
    });

    tenantA = await seedTenant(pool, api.baseUrl, "acme-conn-iso", { companies: ["Acme"] });
    tenantB = await seedTenant(pool, api.baseUrl, "globex-conn-iso", { companies: ["Globex"] });

    ownEnvironmentId = await environmentOf(tenantA.tenantId);
    victimEnvironmentId = await environmentOf(tenantB.tenantId);

    // Tenant B genuinely has something worth stealing. An isolation test against
    // an unconfigured environment proves only that nothing is there.
    const configured = await send(
      "PUT",
      `/connections/${victimEnvironmentId}`,
      { entraTenantId: ENTRA_TENANT_ID, clientId: CLIENT_ID, clientSecret: VICTIM_SECRET },
      tenantB.accessToken
    );
    if (configured.status !== 200) {
      throw new Error(`fixture connection setup failed: ${await configured.text()}`);
    }

    const savedConfig = await send(
      "PUT",
      "/mobile-config",
      {
        apiBaseUrl: "https://globex.api.example",
        userAuth: null,
        minimumAppVersion: "3.1.0"
      },
      tenantB.accessToken
    );
    if (savedConfig.status !== 200) {
      throw new Error(`fixture mobile config setup failed: ${await savedConfig.text()}`);
    }
  });

  afterAll(async () => {
    api?.stop();
    await entra?.stop();
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
    token?: string
  ): Promise<Response> {
    return fetch(`${api!.baseUrl}${path}`, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  }

  describe(coversRoute("GET /connections"), () => {
    it("returns only the caller's own environments", async () => {
      const res = await send("GET", "/connections", undefined, tenantA.accessToken);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { environmentId: string }[];
      const ids = new Set(body.map((c) => c.environmentId));
      expect(ids.has(ownEnvironmentId)).toBe(true);
      expect(ids.has(victimEnvironmentId), "tenant A must not see tenant B's environment").toBe(
        false
      );
    });

    it("never carries a client secret, for anyone", async () => {
      const res = await send("GET", "/connections", undefined, tenantB.accessToken);
      const text = await res.text();

      // Tenant B owns this credential and still does not get it back. Write-only
      // is a property of the schema, not a filter applied to other people.
      expect(text).toContain(victimEnvironmentId);
      expect(text).not.toContain(VICTIM_SECRET);
      // The JSON key, with its colon: `hasClientSecret` and
      // `clientSecretUpdatedAt` legitimately contain the bare substring, and
      // both are facts *about* the secret rather than the secret.
      expect(text).not.toContain('"clientSecret":');
    });

    it("refuses an unauthenticated request rather than defaulting to a tenant", async () => {
      expect((await send("GET", "/connections")).status).toBe(401);
      expect((await send("GET", "/connections", undefined, "not.a.real.token")).status).toBe(401);
    });
  });

  describe(coversRoute("GET /connections/:id"), () => {
    it("answers 404, never 403, for another tenant's connection", async () => {
      const res = await send("GET", `/connections/${victimEnvironmentId}`, undefined, tenantA.accessToken);

      expect(res.status).toBe(404);
      expect(res.status, "403 would confirm the environment exists").not.toBe(403);

      const text = await res.text();
      expect(text).not.toContain(tenantB.tenantId);
      expect(text).not.toContain(CLIENT_ID);

      // Indistinguishable from an id that exists nowhere at all.
      const absent = await send(
        "GET",
        "/connections/00000000-0000-4000-8000-000000000000",
        undefined,
        tenantA.accessToken
      );
      expect(absent.status).toBe(404);
      expect(await absent.text()).toBe(text);

      // Guard against a vacuous pass: the id is real and its owner can fetch it.
      const owner = await send("GET", `/connections/${victimEnvironmentId}`, undefined, tenantB.accessToken);
      expect(owner.status, "the fixture id must be genuinely fetchable").toBe(200);
      expect((await owner.json()) as { hasClientSecret: boolean }).toMatchObject({
        hasClientSecret: true
      });
    });

    it("does not turn a malformed id into a server error", async () => {
      const res = await send("GET", "/connections/not-a-uuid", undefined, tenantA.accessToken);
      expect(res.status).toBe(404);
    });
  });

  describe(coversRoute("PUT /connections/:id"), () => {
    it("cannot overwrite another tenant's credentials", async () => {
      const attempts = entra!.requests.length;

      const res = await send(
        "PUT",
        `/connections/${victimEnvironmentId}`,
        { entraTenantId: ENTRA_TENANT_ID, clientId: CLIENT_ID, clientSecret: "attacker-supplied" },
        tenantA.accessToken
      );

      expect(res.status).toBe(404);

      // Not merely refused at the end: the token exchange never happened, so the
      // attempt could not even be used to probe whether the environment exists
      // by timing it.
      expect(entra!.requests.length).toBe(attempts);

      // And tenant B's stored credential is untouched.
      const stored = await pool.query<{ client_secret_sealed: string }>(
        "SELECT client_secret_sealed FROM d365_environment WHERE id = $1",
        [victimEnvironmentId]
      );
      const asOwner = await send(
        "GET",
        `/connections/${victimEnvironmentId}`,
        undefined,
        tenantB.accessToken
      );
      expect((await asOwner.json()) as { hasClientSecret: boolean }).toMatchObject({
        hasClientSecret: true
      });
      expect(stored.rows[0].client_secret_sealed).toMatch(/^v1\./);
    });
  });

  describe(coversRoute("POST /connections/:id/test"), () => {
    it("cannot exercise another tenant's credentials", async () => {
      const attempts = entra!.requests.length;

      const res = await send("POST", `/connections/${victimEnvironmentId}/test`, {}, tenantA.accessToken);
      expect(res.status).toBe(404);

      // The interesting failure this prevents: a 200 here would let anyone use
      // the endpoint as an oracle for whether a neighbour's credential still
      // works, without ever seeing it.
      expect(entra!.requests.length).toBe(attempts);

      const owner = await send("POST", `/connections/${victimEnvironmentId}/test`, {}, tenantB.accessToken);
      expect(owner.status, "the fixture connection must be genuinely testable").toBe(200);
      expect((await owner.json()) as { ok: boolean }).toMatchObject({ ok: true });
    });
  });

  describe(coversRoute("GET /mobile-config"), () => {
    it("returns the caller's own configuration and not a neighbour's", async () => {
      // Tenant A has never configured one.
      const mine = await send("GET", "/mobile-config", undefined, tenantA.accessToken);
      expect(mine.status).toBe(404);
      expect(await mine.text()).not.toContain("globex.api.example");

      const theirs = await send("GET", "/mobile-config", undefined, tenantB.accessToken);
      expect(theirs.status).toBe(200);
      expect((await theirs.json()) as { apiBaseUrl: string }).toMatchObject({
        apiBaseUrl: "https://globex.api.example"
      });
    });

    it("refuses an unauthenticated request", async () => {
      expect((await send("GET", "/mobile-config")).status).toBe(401);
    });
  });

  describe(coversRoute("PUT /mobile-config"), () => {
    it("writes into the caller's own tenant, never another's", async () => {
      // There is no id in the path to point elsewhere — the tenant comes from
      // the token — so the test is that a write by A leaves B alone. This is the
      // field that redirects every device in the field, so "wrote into the
      // wrong tenant" is a fleet-wide outage.
      const res = await send(
        "PUT",
        "/mobile-config",
        { apiBaseUrl: "https://acme.api.example", userAuth: null },
        tenantA.accessToken
      );
      expect(res.status).toBe(200);

      const theirs = await send("GET", "/mobile-config", undefined, tenantB.accessToken);
      expect((await theirs.json()) as { apiBaseUrl: string }).toMatchObject({
        apiBaseUrl: "https://globex.api.example"
      });

      const rows = await pool.query<{ count: string }>(
        "SELECT count(*) AS count FROM tenant_mobile_config"
      );
      expect(rows.rows[0].count).toBe("2");
    });

    it("refuses an unauthenticated request", async () => {
      expect(
        (await send("PUT", "/mobile-config", { apiBaseUrl: "https://x.example", userAuth: null }))
          .status
      ).toBe(401);
    });
  });
});
