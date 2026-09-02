import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import migrate from "node-pg-migrate";
import { join } from "node:path";
import { repoRoot } from "./helpers";
import { createThrowawayDatabase, type ThrowawayDatabase } from "./pg-helpers";
import { startApi, type RunningApi } from "./api-server";
import {
  seedMember,
  seedTenant,
  type MemberFixture,
  type TenantFixture
} from "./tenant-fixtures";

/**
 * A viewer may read the configuration screens and change nothing.
 *
 * The gap this closes: roles have held permissions since the auth-foundation
 * migration, provisioning grants `viewer` the read half of the catalogue, and
 * the portal has been able to edit the matrix since US-064 — but no
 * tenant-scoped route ever *read* the claim. So a `viewer` was read-only
 * because the screens happened not to draw the buttons, and anyone who spoke to
 * the API directly held whatever an administrator held. That is not a
 * permission; it is a rendering convention.
 *
 * The distinction is tested between two members of one tenant, deliberately.
 * Cross-tenant isolation is a different question with a different answer — 404,
 * because the row is invisible inside the scoped session — and the suites under
 * tests/isolation cover it. Here both users can see the same rows, and the only
 * thing separating them is what their role holds.
 *
 * Scope: the configuration routes (D365 connections, mobile bootstrap record),
 * which are the ones behind the Configuration screen. The other tenant-scoped
 * controllers still carry no permission check, and each is its own decision
 * about which key it needs.
 */

const MIGRATIONS_DIR = join(repoRoot, "packages/db/migrations");
// Unique across the suite: test files run in parallel, and a shared port means
// one file's server answering another file's requests.
const PORT = 34859;
const JWT_SECRET = "us031-suite-signing-key-at-least-32-characters";
const ENCRYPTION_KEY = "us031-suite-secret-encryption-key-at-least-32-chars";

const MOBILE_CONFIG = {
  apiBaseUrl: "https://acme.api.example",
  userAuth: null,
  minimumAppVersion: "2.0.0"
};

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  console.warn(
    "[US-031] DATABASE_URL not set — the configuration permission suite is SKIPPED. Set DATABASE_URL to a Postgres admin connection to run it."
  );
}

describe.skipIf(!hasDb)("US-031 - permissions on the configuration routes", () => {
  let db: ThrowawayDatabase | undefined;
  let pool: Pool;
  let api: RunningApi | undefined;
  let tenant: TenantFixture;
  /** The read half of the catalogue, through a role actually called `viewer`. */
  let viewer: MemberFixture;
  /** No permissions at all — the state a stripped role leaves behind. */
  let stranger: MemberFixture;
  let environmentId: string;

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

    api = await startApi(PORT, {
      DATABASE_URL: db.url,
      AUTH_JWT_SECRET: JWT_SECRET,
      SECRET_ENCRYPTION_KEY: ENCRYPTION_KEY
    });

    tenant = await seedTenant(pool, api.baseUrl, "acme-perms", { companies: ["Acme Retail"] });
    viewer = await seedMember(pool, api.baseUrl, tenant);
    stranger = await seedMember(pool, api.baseUrl, tenant, {
      role: "stranger",
      permissions: []
    });

    const environment = await pool.query<{ id: string }>(
      "SELECT id FROM d365_environment WHERE tenant_id = $1 LIMIT 1",
      [tenant.tenantId]
    );
    environmentId = environment.rows[0].id;

    // There has to be something to read. A viewer refused a page that is empty
    // anyway proves nothing about the permission.
    const created = await send("PUT", "/mobile-config", MOBILE_CONFIG, tenant.accessToken);
    if (created.status !== 200) {
      throw new Error(`fixture mobile config setup failed: ${await created.text()}`);
    }
  });

  afterAll(async () => {
    api?.stop();
    await pool?.end();
    await db?.drop();
    db = undefined;
  });

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

  describe("a viewer can read the configuration", () => {
    it("lists the tenant's connections", async () => {
      const res = await send("GET", "/connections", undefined, viewer.accessToken);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { environmentId: string }[];
      expect(body.map((row) => row.environmentId)).toContain(environmentId);
    });

    it("reads one connection", async () => {
      const res = await send(
        "GET",
        `/connections/${environmentId}`,
        undefined,
        viewer.accessToken
      );
      expect(res.status).toBe(200);
    });

    it("reads the mobile configuration", async () => {
      const res = await send("GET", "/mobile-config", undefined, viewer.accessToken);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { apiBaseUrl: string };
      expect(body.apiBaseUrl).toBe(MOBILE_CONFIG.apiBaseUrl);
    });
  });

  describe("and can change none of it", () => {
    it("refuses to save a connection", async () => {
      const res = await send(
        "PUT",
        `/connections/${environmentId}`,
        {
          entraTenantId: "26c58d65-b577-4f92-aed2-cec1395d146d",
          clientId: "db61ee09-84a1-4912-b319-709480fa243a",
          clientSecret: "a-secret-a-viewer-should-not-be-able-to-store"
        },
        viewer.accessToken
      );

      // 403 rather than 404: the caller is inside the right tenant and may read
      // this very row, so hiding its existence would only confuse.
      expect(res.status).toBe(403);

      // Refused *before* the service ran, which is the half that matters — this
      // suite starts no Entra stub, so a request that reached `save` would fail
      // trying to check the credential rather than being turned away.
      const stored = await pool.query<{ client_id: string | null }>(
        // The credential lives on `d365_environment`; a connection is one-to-one
        // with an environment and has no table of its own.
        "SELECT client_id FROM d365_environment WHERE id = $1",
        [environmentId]
      );
      expect(stored.rows[0]?.client_id ?? null).toBeNull();
    });

    it("refuses to run a connection test", async () => {
      // A check spends a live credential and records its outcome on the
      // connection, so it is a write however it reads in the UI.
      const res = await send(
        "POST",
        `/connections/${environmentId}/test`,
        {},
        viewer.accessToken
      );
      expect(res.status).toBe(403);
    });

    it("refuses to save the mobile configuration, and leaves it as it was", async () => {
      const res = await send(
        "PUT",
        "/mobile-config",
        { ...MOBILE_CONFIG, apiBaseUrl: "https://attacker.example" },
        viewer.accessToken
      );
      expect(res.status).toBe(403);

      const after = await send("GET", "/mobile-config", undefined, tenant.accessToken);
      const body = (await after.json()) as { apiBaseUrl: string };
      expect(body.apiBaseUrl).toBe(MOBILE_CONFIG.apiBaseUrl);
    });

    it("says why, without naming the permission", async () => {
      const res = await send("PUT", "/mobile-config", MOBILE_CONFIG, viewer.accessToken);
      const body = (await res.json()) as { message?: string };

      expect(body.message).toBe("You do not have permission to perform this action.");
      // The key itself stays out of the message. It is the one useful thing to
      // learn from a refusal, and there is nothing a refused caller can do with
      // it that an administrator could not tell them.
      expect(JSON.stringify(body)).not.toContain("tenant.write");
    });
  });

  /**
   * The half that makes the rest of it hold.
   *
   * A read-only account that can edit the permission matrix is read-only for as
   * long as it takes to tick a box and sign in again — permissions are stamped
   * into the token at sign-in, so self-elevation is two requests and a refresh,
   * not an exploit.
   */
  describe("and cannot grant itself the ability to", () => {
    it("edit the permission matrix", async () => {
      const roles = await send("GET", "/roles", undefined, tenant.accessToken);
      const list = (await roles.json()) as { id: string; name: string }[];
      const viewerRole = list.find((role) => role.name === "viewer")!;

      const res = await send(
        "PUT",
        `/roles/${viewerRole.id}/permissions`,
        { permissions: ["connection.read", "connection.write"] },
        viewer.accessToken
      );
      expect(res.status).toBe(403);

      // And the role is untouched, not merely the response refused.
      const after = await send("GET", "/roles", undefined, tenant.accessToken);
      const reread = (await after.json()) as { name: string; permissions: string[] }[];
      const stored = reread.find((role) => role.name === "viewer")!;
      expect(stored.permissions).not.toContain("connection.write");
    });

    it("invite a second account", async () => {
      const res = await send(
        "POST",
        "/users/invitations",
        { email: "a-way-back-in@acme-perms.local" },
        viewer.accessToken
      );
      expect(res.status).toBe(403);
    });

    it("assign itself another role", async () => {
      const res = await send(
        "PUT",
        `/users/${viewer.userId}/roles`,
        { roles: ["admin"] },
        viewer.accessToken
      );
      expect(res.status).toBe(403);
    });

    it("while still being able to read who else is in the tenant", async () => {
      // `user.read` is part of the read half, so the users and roles screens
      // stay legible. Taking those away would make "view-only" mean "blind".
      expect((await send("GET", "/users", undefined, viewer.accessToken)).status).toBe(200);
      expect((await send("GET", "/roles", undefined, viewer.accessToken)).status).toBe(200);
    });
  });

  describe("an administrator is unaffected", () => {
    it("saves the mobile configuration", async () => {
      const res = await send(
        "PUT",
        "/mobile-config",
        { ...MOBILE_CONFIG, minimumAppVersion: "2.1.0" },
        tenant.accessToken
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as { minimumAppVersion: string | null };
      expect(body.minimumAppVersion).toBe("2.1.0");
    });
  });

  describe("a role holding nothing reads nothing", () => {
    it("is refused the connection list", async () => {
      const res = await send("GET", "/connections", undefined, stranger.accessToken);
      expect(res.status).toBe(403);
    });

    it("is refused the mobile configuration", async () => {
      const res = await send("GET", "/mobile-config", undefined, stranger.accessToken);
      expect(res.status).toBe(403);
    });

    it("is still refused with no token at all", async () => {
      // 401, not 403: the guard must never be the thing that decides an
      // unauthenticated request is fine.
      expect((await send("GET", "/connections")).status).toBe(401);
      expect((await send("PUT", "/mobile-config", MOBILE_CONFIG)).status).toBe(401);
    });
  });
});
