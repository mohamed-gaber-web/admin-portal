import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import migrate from "node-pg-migrate";
import { join } from "node:path";
import { repoRoot } from "./helpers";
import { createThrowawayDatabase, type ThrowawayDatabase } from "./pg-helpers";
import { startApi, type RunningApi } from "./api-server";
import { seedTenant, type TenantFixture } from "./tenant-fixtures";
import { startEntraStub, type EntraStub } from "./entra-stub";
import { openSecret, resetSecretEncryptionKey } from "../packages/db/src/secret-box";
import { createEnvironment } from "../packages/db/src/tenancy";

/**
 * Multi-tenant mobile configuration (US-040, US-041, US-042, US-044, US-045).
 *
 * The story this suite is really testing: the Ionic app used to ship an
 * `environment.ts` holding one tenant's D365 credentials, including a
 * `client_credentials` client secret scoped to `<instance>/.default` — which is
 * unrestricted application access to the ERP, inside every installed build.
 *
 * The migration splits that file in two, and the tests are organised around the
 * split rather than around the endpoints:
 *
 *   - the confidential half never leaves the server (AC1, AC3, AC5)
 *   - it is never stored unverified (AC2)
 *   - it is never re-typed to be kept (AC4)
 *   - the device half is what a device downloads, and is only that (AC5, AC6)
 */

const MIGRATIONS_DIR = join(repoRoot, "packages/db/migrations");
const PORT = 34851;
const JWT_SECRET = "us040-suite-signing-key-at-least-32-characters";
const ENCRYPTION_KEY = "us040-suite-secret-encryption-key-at-least-32-chars";

/**
 * The values from the real `environment.ts` this story replaces.
 *
 * Used verbatim so the assembled token URL below can be compared against the
 * one that file hardcoded — the migration is only correct if the server ends up
 * calling exactly what the app used to call.
 */
const ENTRA_TENANT_ID = "26c58d65-b577-4f92-aed2-cec1395d146d";
const CLIENT_ID = "db61ee09-84a1-4912-b319-709480fa243a";
const CLIENT_SECRET = "the-original-d365-client-secret";
const ROTATED_SECRET = "a-freshly-rotated-d365-client-secret";

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  console.warn(
    "[US-040] DATABASE_URL not set — the mobile configuration suite is SKIPPED. Set DATABASE_URL to a Postgres admin connection to run it."
  );
}

describe.skipIf(!hasDb)("US-040 - multi-tenant mobile configuration", () => {
  let db: ThrowawayDatabase | undefined;
  let pool: Pool;
  let api: RunningApi | undefined;
  let entra: EntraStub | undefined;
  let tenant: TenantFixture;
  let other: TenantFixture;
  /** The environment configured by the happy path. */
  let prodEnvironmentId: string;
  /** A second environment, left unconfigured so failures have somewhere to land. */
  let uatEnvironmentId: string;

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
    entra.accept(CLIENT_ID, CLIENT_SECRET);

    api = await startApi(PORT, {
      DATABASE_URL: db.url,
      AUTH_JWT_SECRET: JWT_SECRET,
      SECRET_ENCRYPTION_KEY: ENCRYPTION_KEY,
      D365_AUTHORITY_ORIGIN_OVERRIDE: entra.origin
    });

    tenant = await seedTenant(pool, api.baseUrl, "acme-cfg", { companies: ["Acme Retail"] });
    other = await seedTenant(pool, api.baseUrl, "globex-cfg", { companies: ["Globex Ltd"] });

    const environments = await pool.query<{ id: string }>(
      "SELECT id FROM d365_environment WHERE tenant_id = $1",
      [tenant.tenantId]
    );
    prodEnvironmentId = environments.rows[0].id;

    const uat = await createEnvironment(pool, {
      tenantId: tenant.tenantId,
      name: "UAT",
      url: "https://acme-uat.sandbox.operations.eu.dynamics.com"
    });
    uatEnvironmentId = uat.id;

    // The key the API is using, so this process can open what it sealed.
    process.env.SECRET_ENCRYPTION_KEY = ENCRYPTION_KEY;
    resetSecretEncryptionKey();
  });

  afterAll(async () => {
    api?.stop();
    await entra?.stop();
    await pool?.end();
    await db?.drop();
    db = undefined;
  });

  const request = (
    method: string,
    path: string,
    body?: unknown,
    token?: string
  ): Promise<Response> =>
    fetch(`${api!.baseUrl}${path}`, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

  /** The sealed column, read directly — no application code in the way. */
  const sealedSecret = async (environmentId: string): Promise<string | null> => {
    const res = await pool.query<{ client_secret_sealed: string | null }>(
      "SELECT client_secret_sealed FROM d365_environment WHERE id = $1",
      [environmentId]
    );
    return res.rows[0]?.client_secret_sealed ?? null;
  };

  describe("AC1 - a connection is configured per environment and read back without its secret", () => {
    it("saves the credentials and returns everything except the one thing it must not", async () => {
      const expiresAt = new Date(Date.now() + 45 * 86_400_000).toISOString();

      const res = await request(
        "PUT",
        `/connections/${prodEnvironmentId}`,
        {
          entraTenantId: ENTRA_TENANT_ID,
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          clientSecretExpiresAt: expiresAt
        },
        tenant.accessToken
      );

      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;

      expect(body.clientId).toBe(CLIENT_ID);
      expect(body.entraTenantId).toBe(ENTRA_TENANT_ID);
      expect(body.hasClientSecret).toBe(true);
      expect(body.state).toBe("connected");

      // The whole of US-045, stated twice: not present as a field, and not
      // present anywhere in the serialised response under any other name.
      expect(body).not.toHaveProperty("clientSecret");
      expect(JSON.stringify(body)).not.toContain(CLIENT_SECRET);
    });

    it("assembles the same token URL and scope the hardcoded environment.ts used", async () => {
      const res = await request("GET", `/connections/${prodEnvironmentId}`, undefined, tenant.accessToken);
      const body = (await res.json()) as Record<string, unknown>;

      // What `auth.tokenUrl` was, now derived from the directory id rather than
      // stored whole — the field an attacker with write access would edit.
      expect(body.tokenUrl).toBe(
        `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/oauth2/v2.0/token`
      );
      // What `auth.scope` was, now derived from the environment URL so the two
      // cannot drift apart.
      expect(body.scope).toBe("https://acme-cfg.crm4.dynamics.com/.default");
    });

    it("presents the stored secret to the directory, and only that", async () => {
      const exchange = entra!.requests.at(-1);
      expect(exchange?.grantType).toBe("client_credentials");
      expect(exchange?.clientId).toBe(CLIENT_ID);
      expect(exchange?.clientSecret).toBe(CLIENT_SECRET);
      // The directory id reached the wire via the assembled path, not a stored URL.
      expect(exchange?.path).toContain(ENTRA_TENANT_ID);
    });
  });

  describe("AC2 - nothing is saved unless a live connection test passes", () => {
    it("refuses a credential the directory rejects, and writes none of it", async () => {
      const res = await request(
        "PUT",
        `/connections/${uatEnvironmentId}`,
        {
          entraTenantId: ENTRA_TENANT_ID,
          clientId: CLIENT_ID,
          clientSecret: "not-the-right-secret"
        },
        tenant.accessToken
      );

      // 422, not 400: the request was well-formed and understood. What failed is
      // the exchange with the directory, which is a fact about the world.
      expect(res.status).toBe(422);
      expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_client" });

      // The exit criterion. Not "saved then marked failing" — not saved.
      const after = await request("GET", `/connections/${uatEnvironmentId}`, undefined, tenant.accessToken);
      const body = (await after.json()) as Record<string, unknown>;
      expect(body.clientId).toBeNull();
      expect(body.hasClientSecret).toBe(false);
      expect(body.state).toBe("not_configured");
      expect(await sealedSecret(uatEnvironmentId)).toBeNull();
    });

    it("reports an unknown directory as the wrong tenant, not the wrong secret", async () => {
      // The distinction matters: told "invalid client", an administrator rotates
      // a secret that was never wrong.
      entra!.rejectWith({
        error: "invalid_request",
        error_description: "AADSTS90002: Tenant not found. Check to make sure you have the correct tenant ID."
      });

      const res = await request(
        "PUT",
        `/connections/${uatEnvironmentId}`,
        {
          entraTenantId: "00000000-0000-4000-8000-000000000000",
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET
        },
        tenant.accessToken
      );

      expect(res.status).toBe(422);
      expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_tenant" });
      entra!.reset();
    });

    it("refuses a first-time save that carries no secret, rather than storing half a connection", async () => {
      const res = await request(
        "PUT",
        `/connections/${uatEnvironmentId}`,
        { entraTenantId: ENTRA_TENANT_ID, clientId: CLIENT_ID },
        tenant.accessToken
      );

      // 400 here, unlike the 422 above: this one the caller can fix by sending
      // the field. There was nothing to test with, so nothing was tested.
      expect(res.status).toBe(400);
    });
  });

  describe("AC3 - the client secret is not recoverable from the database alone", () => {
    it("stores a sealed value, not the secret", async () => {
      const stored = await sealedSecret(prodEnvironmentId);

      expect(stored).toBeTruthy();
      expect(stored).not.toBe(CLIENT_SECRET);
      expect(stored).not.toContain(CLIENT_SECRET);
      expect(stored).toMatch(/^v1\./);
    });

    it("opens only with the right key, and only for the purpose it was sealed for", async () => {
      const stored = (await sealedSecret(prodEnvironmentId))!;

      expect(openSecret("d365.clientSecret", stored)).toBe(CLIENT_SECRET);

      // A database dump plus the wrong key yields nothing. This is the whole of
      // "not recoverable from the database alone".
      process.env.SECRET_ENCRYPTION_KEY = "a-different-key-of-at-least-thirty-two-characters";
      resetSecretEncryptionKey();
      expect(openSecret("d365.clientSecret", stored)).toBeNull();

      process.env.SECRET_ENCRYPTION_KEY = ENCRYPTION_KEY;
      resetSecretEncryptionKey();
    });

    it("keeps the secret out of the audit log", async () => {
      const entries = await pool.query<{ action: string; data: unknown }>(
        "SELECT action, data FROM audit_log WHERE tenant_id = $1",
        [tenant.tenantId]
      );

      expect(entries.rows.some((row) => row.action === "connection.updated")).toBe(true);
      for (const row of entries.rows) {
        expect(JSON.stringify(row.data)).not.toContain(CLIENT_SECRET);
      }
    });
  });

  describe("AC4 - an omitted secret keeps the stored one (US-045)", () => {
    it("re-verifies with the stored secret when the caller sends none", async () => {
      const before = await sealedSecret(prodEnvironmentId);
      const requestsBefore = entra!.requests.length;

      const res = await request(
        "PUT",
        `/connections/${prodEnvironmentId}`,
        {
          entraTenantId: ENTRA_TENANT_ID,
          clientId: CLIENT_ID,
          // No clientSecret. Editing the expiry date must not require re-typing
          // a credential the administrator may not have.
          clientSecretExpiresAt: new Date(Date.now() + 10 * 86_400_000).toISOString()
        },
        tenant.accessToken
      );

      expect(res.status, await res.clone().text()).toBe(200);

      // The stored secret is what was presented — so "keep" means kept, not
      // "skipped the check".
      expect(entra!.requests.length).toBe(requestsBefore + 1);
      expect(entra!.requests.at(-1)?.clientSecret).toBe(CLIENT_SECRET);

      // Unchanged ciphertext: it was not resealed, so `clientSecretUpdatedAt`
      // still means what it says.
      expect(await sealedSecret(prodEnvironmentId)).toBe(before);
    });

    it("replaces it when one is supplied, and reseals", async () => {
      entra!.accept(CLIENT_ID, ROTATED_SECRET);
      const before = await sealedSecret(prodEnvironmentId);

      const res = await request(
        "PUT",
        `/connections/${prodEnvironmentId}`,
        {
          entraTenantId: ENTRA_TENANT_ID,
          clientId: CLIENT_ID,
          clientSecret: ROTATED_SECRET
        },
        tenant.accessToken
      );

      expect(res.status).toBe(200);
      const stored = await sealedSecret(prodEnvironmentId);
      expect(stored).not.toBe(before);
      expect(openSecret("d365.clientSecret", stored!)).toBe(ROTATED_SECRET);
    });
  });

  describe("AC5 - a device receives the public configuration and no credential", () => {
    const MOBILE_CONFIG = {
      apiBaseUrl: "https://api.growpath.example",
      userAuth: {
        clientId: CLIENT_ID,
        authority: `https://login.microsoftonline.com/${ENTRA_TENANT_ID}`,
        redirectUri: "/auth/login",
        scopes: ["openid", "profile", "email", "User.Read"]
      },
      minimumAppVersion: "2.4.0"
    };

    it("is administered through the authenticated route", async () => {
      const res = await request("PUT", "/mobile-config", MOBILE_CONFIG, tenant.accessToken);
      expect(res.status, await res.clone().text()).toBe(200);
      expect((await res.json()) as { apiBaseUrl: string }).toMatchObject({
        apiBaseUrl: MOBILE_CONFIG.apiBaseUrl
      });
    });

    it("refuses an http apiBaseUrl, which would disclose every device's token", async () => {
      const res = await request(
        "PUT",
        "/mobile-config",
        { ...MOBILE_CONFIG, apiBaseUrl: "http://api.growpath.example" },
        tenant.accessToken
      );
      expect(res.status).toBe(400);
    });

    it("serves the device half unauthenticated, by slug", async () => {
      // No Authorization header: a freshly installed app has no session, which
      // is the entire reason this endpoint exists.
      const res = await request("GET", `/mobile/config?slug=${tenant.slug}`);
      expect(res.status, await res.clone().text()).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        tenantSlug: tenant.slug,
        apiBaseUrl: MOBILE_CONFIG.apiBaseUrl,
        minimumAppVersion: "2.4.0"
      });
      expect(body.userAuth).toMatchObject({ clientId: CLIENT_ID, redirectUri: "/auth/login" });
    });

    it("carries no trace of the confidential half", async () => {
      const res = await request("GET", `/mobile/config?slug=${tenant.slug}`);
      const text = await res.text();

      // The credential itself, in either generation.
      expect(text).not.toContain(CLIENT_SECRET);
      expect(text).not.toContain(ROTATED_SECRET);
      // And the fields that would let a device go around the API to use it.
      expect(text).not.toContain("clientSecret");
      expect(text).not.toContain("/.default");
      expect(text).not.toContain("dynamics.com");
      expect(text).not.toContain("oauth2/v2.0/token");
    });

    it("does not serve one tenant's configuration under another's slug", async () => {
      const res = await request("GET", `/mobile/config?slug=${other.slug}`);
      // `other` has never configured one, so there is nothing to serve — and
      // certainly not the neighbouring tenant's.
      expect(res.status).toBe(404);
    });
  });

  describe("AC6 - an unknown, archived or suspended tenant answers identically", () => {
    it("gives one 404 for a slug that does not exist", async () => {
      const unknown = await request("GET", "/mobile/config?slug=no-such-tenant");
      expect(unknown.status).toBe(404);
    });

    it("stops serving a suspended tenant, byte for byte like an unknown one", async () => {
      const unknown = await request("GET", "/mobile/config?slug=no-such-tenant");
      const unknownBody = await unknown.text();

      await pool.query("UPDATE tenant SET suspended_at = now() WHERE id = $1", [tenant.tenantId]);

      const suspended = await request("GET", `/mobile/config?slug=${tenant.slug}`);
      // A suspended tenant whose devices kept working would be suspended in the
      // portal only.
      expect(suspended.status).toBe(404);
      expect(await suspended.text()).toBe(unknownBody);

      await pool.query("UPDATE tenant SET suspended_at = NULL WHERE id = $1", [tenant.tenantId]);
    });

    it("rejects a malformed slug without reaching the database", async () => {
      const res = await request("GET", "/mobile/config?slug=Not%20A%20Slug");
      expect(res.status).toBe(400);
    });
  });

  describe("AC7 - a secret's expiry is reported before it bites (US-044)", () => {
    it("counts the days remaining server-side", async () => {
      const expiresAt = new Date(Date.now() + 12 * 86_400_000).toISOString();
      await request(
        "PUT",
        `/connections/${prodEnvironmentId}`,
        { entraTenantId: ENTRA_TENANT_ID, clientId: CLIENT_ID, clientSecretExpiresAt: expiresAt },
        tenant.accessToken
      );

      const res = await request("GET", `/connections/${prodEnvironmentId}`, undefined, tenant.accessToken);
      const body = (await res.json()) as { daysUntilSecretExpiry: number };

      // Computed by the server: a device or browser with a wrong clock must not
      // get to decide whether a credential is expiring.
      expect(body.daysUntilSecretExpiry).toBeGreaterThanOrEqual(11);
      expect(body.daysUntilSecretExpiry).toBeLessThanOrEqual(12);
    });
  });

  describe("AC8 - a re-check records what it found", () => {
    it("reports success and leaves the credential alone", async () => {
      const before = await sealedSecret(prodEnvironmentId);

      const res = await request("POST", `/connections/${prodEnvironmentId}/test`, {}, tenant.accessToken);
      expect(res.status).toBe(200);
      expect((await res.json()) as { ok: boolean; state: string }).toMatchObject({
        ok: true,
        state: "connected"
      });

      expect(await sealedSecret(prodEnvironmentId)).toBe(before);
    });

    it("answers 200 with ok:false when the directory refuses, rather than an error status", async () => {
      entra!.rejectWith({ error: "invalid_client" }, 401);

      const res = await request("POST", `/connections/${prodEnvironmentId}/test`, {}, tenant.accessToken);
      // Checking is what was asked for; a negative result is a legitimate answer
      // to it, and the button has to be able to render one.
      expect(res.status).toBe(200);
      expect((await res.json()) as { ok: boolean; error: string }).toMatchObject({
        ok: false,
        error: "invalid_client"
      });

      entra!.reset();
    });

    it("surfaces the recorded state on the tenant detail screen", async () => {
      // Back to working, so the badge has something to change to.
      const recheck = await request(
        "POST",
        `/connections/${prodEnvironmentId}/test`,
        {},
        tenant.accessToken
      );
      expect((await recheck.json()) as { ok: boolean }).toMatchObject({ ok: true });

      const res = await request("GET", `/tenants/${tenant.tenantId}`, undefined, tenant.accessToken);
      const body = (await res.json()) as {
        environments: { id: string; connection: string }[];
      };

      // Was pinned to `not_configured` for every environment until this story;
      // it now reports what a real token request found.
      const prod = body.environments.find((e) => e.id === prodEnvironmentId);
      expect(prod?.connection).toBe("connected");

      const uat = body.environments.find((e) => e.id === uatEnvironmentId);
      expect(uat?.connection).toBe("not_configured");
    });
  });
});
