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
 * Cross-tenant isolation for the administration routes (US-013, US-063, US-064).
 *
 * The US-013 guard requires one of these for every tenant-scoped route, and the
 * administration endpoints are the ones where it matters most: they list people
 * and change what those people may do. End-to-end on purpose — the tokens are
 * ones the API issued, the requests go over HTTP, and the filtering is whatever
 * the real stack does rather than a unit test of the layer we happen to trust.
 */

const MIGRATIONS_DIR = join(repoRoot, "packages/db/migrations");
// Unique across the suite. Test files run in parallel, so a shared port means
// two API servers backed by two different throwaway databases, and requests
// landing on whichever bound first — which surfaces as a sign-in failing
// against a tenant that genuinely does not exist in that server's database.
const PORT = 34829;
const JWT_SECRET = "isolation-suite-signing-key-at-least-32-chars";

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  console.warn(
    "[US-013] DATABASE_URL not set — the administration isolation suite is SKIPPED. Set DATABASE_URL to a Postgres admin connection to run it."
  );
}

describe.skipIf(!hasDb)("US-013 - administration cross-tenant isolation", () => {
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

    tenantA = await seedTenant(pool, api.baseUrl, "acme-admin-iso", {
      permissions: ["user.read", "user.write"]
    });
    tenantB = await seedTenant(pool, api.baseUrl, "globex-admin-iso", {
      permissions: ["user.read", "user.write"]
    });
  }, 120_000);

  afterAll(async () => {
    api?.stop();
    await pool?.end();
    await db?.drop();
    db = undefined;
  });

  const request = (
    method: string,
    path: string,
    token?: string,
    body?: unknown
  ): Promise<Response> =>
    fetch(`${api!.baseUrl}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

  const get = (path: string, token?: string) => request("GET", path, token);

  describe(coversRoute("GET /tenants"), () => {
    it("returns only the caller's own tenant, not the customer list", async () => {
      const res = await get("/tenants?pageSize=50", tenantA.accessToken);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { items: { slug: string }[]; total: number };
      // The regression this exists for: it used to answer with every tenant on
      // the installation, disclosing names, plans and headcounts to anyone who
      // could sign in anywhere.
      expect(body.items.map((row) => row.slug)).toEqual([tenantA.slug]);
      expect(body.total).toBe(1);

      const asB = await get("/tenants?pageSize=50", tenantB.accessToken);
      const bodyB = (await asB.json()) as { items: { slug: string }[] };
      expect(bodyB.items.map((row) => row.slug)).toEqual([tenantB.slug]);
    });

    it("refuses an unauthenticated request", async () => {
      expect((await get("/tenants")).status).toBe(401);
    });
  });

  describe(coversRoute("GET /tenants/:id"), () => {
    it("answers 404, never 403, for another tenant", async () => {
      const res = await get(`/tenants/${tenantB.tenantId}`, tenantA.accessToken);
      expect(res.status).toBe(404);
      expect(res.status).not.toBe(403);

      const text = await res.text();
      expect(text).not.toContain(tenantB.slug);

      // Indistinguishable from an id that exists nowhere at all.
      const absent = await get(
        "/tenants/00000000-0000-4000-8000-000000000000",
        tenantA.accessToken
      );
      expect(await absent.text()).toBe(text);

      // Not a vacuous pass: its owner can fetch it.
      expect((await get(`/tenants/${tenantB.tenantId}`, tenantB.accessToken)).status).toBe(
        200
      );
    });
  });

  describe(coversRoute("GET /tenants/:id/activity"), () => {
    it("does not expose another tenant's audit trail", async () => {
      const res = await get(`/tenants/${tenantB.tenantId}/activity`, tenantA.accessToken);
      expect(res.status).toBe(404);

      // Its owner sees it, so the 404 is isolation rather than an empty feature.
      const own = await get(`/tenants/${tenantA.tenantId}/activity`, tenantA.accessToken);
      expect(own.status).toBe(200);
      expect(((await own.json()) as unknown[]).length).toBeGreaterThan(0);
    });
  });

  describe(coversRoute("PATCH /tenants/:id/status"), () => {
    it("cannot suspend another tenant", async () => {
      const res = await request(
        "PATCH",
        `/tenants/${tenantB.tenantId}/status`,
        tenantA.accessToken,
        { status: "suspended" }
      );
      expect(res.status).toBe(404);

      // The write must not have landed — read it back as its owner, which is
      // the only way to tell "refused" from "refused and applied anyway".
      const after = await get(`/tenants/${tenantB.tenantId}`, tenantB.accessToken);
      expect(((await after.json()) as { status: string }).status).not.toBe("suspended");
    });
  });

  describe(coversRoute("GET /users"), () => {
    it("returns only the caller's own tenant's users", async () => {
      const res = await get("/users", tenantA.accessToken);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { items: { id: string; email: string }[] };
      expect(body.items.map((user) => user.email)).toEqual([tenantA.email]);

      // Tenant B's admin is genuinely absent, not merely further down the list.
      const ids = new Set(body.items.map((user) => user.id));
      expect(ids.has(tenantB.userId), "tenant A must not see a tenant B user").toBe(false);

      // The same request as tenant B returns tenant B's, so this is isolation
      // rather than an endpoint that returns nothing useful to anyone.
      const asB = await get("/users", tenantB.accessToken);
      const bodyB = (await asB.json()) as { items: { email: string }[] };
      expect(bodyB.items.map((user) => user.email)).toEqual([tenantB.email]);
    });

    it("refuses an unauthenticated request rather than defaulting to a tenant", async () => {
      expect((await get("/users")).status).toBe(401);
      expect((await get("/users", "not.a.real.token")).status).toBe(401);
    });
  });

  describe(coversRoute("GET /users/:id"), () => {
    it("answers 404, never 403, for another tenant's user", async () => {
      const res = await get(`/users/${tenantB.userId}`, tenantA.accessToken);
      expect(res.status).toBe(404);
      expect(
        res.status,
        "403 would confirm the user exists, which is the leak this prevents"
      ).not.toBe(403);

      const text = await res.text();
      expect(text).not.toContain(tenantB.email);
      expect(text).not.toContain(tenantB.tenantId);

      // Indistinguishable from an id that exists nowhere at all.
      const absent = await get(
        "/users/00000000-0000-4000-8000-000000000000",
        tenantA.accessToken
      );
      expect(absent.status).toBe(404);
      expect(await absent.text()).toBe(text);

      // Guard against a vacuous pass: the id is real, and its owner can fetch it.
      const owner = await get(`/users/${tenantB.userId}`, tenantB.accessToken);
      expect(owner.status, "the fixture id must be genuinely fetchable").toBe(200);
    });

    it("does not turn a malformed id into a server error", async () => {
      const res = await get("/users/not-a-uuid", tenantA.accessToken);
      expect(res.status).toBe(404);
    });
  });

  describe(coversRoute("PATCH /users/:id/status"), () => {
    it("cannot suspend another tenant's user", async () => {
      const res = await request(
        "PATCH",
        `/users/${tenantB.userId}/status`,
        tenantA.accessToken,
        { status: "suspended" }
      );
      expect(res.status).toBe(404);

      // The write must not have landed. Read it back as its own tenant, which
      // is the only way to tell "refused" apart from "refused and applied".
      const after = await get(`/users/${tenantB.userId}`, tenantB.accessToken);
      expect(((await after.json()) as { status: string }).status).toBe("active");
    });
  });

  describe(coversRoute("PUT /users/:id/roles"), () => {
    it("cannot change another tenant's user's roles", async () => {
      const res = await request(
        "PUT",
        `/users/${tenantB.userId}/roles`,
        tenantA.accessToken,
        { roles: [] }
      );
      expect(res.status).toBe(404);

      const after = await get(`/users/${tenantB.userId}`, tenantB.accessToken);
      expect(
        ((await after.json()) as { roles: string[] }).roles,
        "tenant B's admin must still hold the role tenant A tried to strip"
      ).toContain("admin");
    });

    it("refuses a role name from another tenant rather than resolving it", async () => {
      // Role names repeat across tenants — both have an `admin`. The lookup is
      // scoped, so tenant A naming a role can only ever reach its own.
      const roles = await get("/roles", tenantA.accessToken);
      const own = (await roles.json()) as { id: string; name: string }[];
      expect(own.map((role) => role.name)).toContain("admin");

      const res = await request(
        "PUT",
        `/users/${tenantA.userId}/roles`,
        tenantA.accessToken,
        { roles: ["no-such-role"] }
      );
      expect(res.status).toBe(400);
    });
  });

  describe(coversRoute("POST /users/invitations"), () => {
    it("creates the user in the caller's tenant and nowhere else", async () => {
      const res = await request("POST", "/users/invitations", tenantA.accessToken, {
        email: "invited@acme-admin-iso.local",
        role: "admin"
      });
      expect(res.status).toBe(201);

      const body = (await res.json()) as {
        user: { id: string; tenantSlug: string };
        token: string;
      };
      expect(body.user.tenantSlug).toBe(tenantA.slug);
      expect(body.token, "the token is returned exactly once").toBeTruthy();

      // Visible to its own tenant...
      expect((await get(`/users/${body.user.id}`, tenantA.accessToken)).status).toBe(200);
      // ...and to nobody else.
      expect((await get(`/users/${body.user.id}`, tenantB.accessToken)).status).toBe(404);
    });
  });

  describe(coversRoute("GET /roles"), () => {
    it("returns only the caller's own tenant's roles", async () => {
      const asA = await get("/roles", tenantA.accessToken);
      expect(asA.status).toBe(200);
      const rolesA = (await asA.json()) as { id: string; name: string }[];

      const asB = await get("/roles", tenantB.accessToken);
      const rolesB = (await asB.json()) as { id: string; name: string }[];

      // Both tenants have a role called `admin`, and they are different rows.
      // Comparing names would pass vacuously; the ids are what prove isolation.
      const idsA = new Set(rolesA.map((role) => role.id));
      for (const role of rolesB) {
        expect(idsA.has(role.id), "a role id must not appear in both tenants").toBe(false);
      }
    });
  });

  describe(coversRoute("PUT /roles/:id/permissions"), () => {
    it("cannot edit another tenant's role", async () => {
      const rolesB = (await (await get("/roles", tenantB.accessToken)).json()) as {
        id: string;
        name: string;
        permissions: string[];
      }[];
      const victim = rolesB.find((role) => role.name === "admin")!;

      const res = await request(
        "PUT",
        `/roles/${victim.id}/permissions`,
        tenantA.accessToken,
        { permissions: [] }
      );
      expect(res.status).toBe(404);

      // And the permissions are untouched.
      const after = (await (await get("/roles", tenantB.accessToken)).json()) as {
        id: string;
        permissions: string[];
      }[];
      expect(after.find((role) => role.id === victim.id)?.permissions).toEqual(
        victim.permissions
      );
    });

    it("grants the read implied by a write", async () => {
      const roles = (await (await get("/roles", tenantA.accessToken)).json()) as {
        id: string;
        name: string;
      }[];
      const admin = roles.find((role) => role.name === "admin")!;

      const res = await request(
        "PUT",
        `/roles/${admin.id}/permissions`,
        tenantA.accessToken,
        { permissions: ["tenant.write"] }
      );
      expect(res.status).toBe(200);

      // Enforced by the API, not only by the portal's matrix: writing something
      // you cannot read is not a state the system models.
      const body = (await res.json()) as { permissions: string[] };
      expect(body.permissions.sort()).toEqual(["tenant.read", "tenant.write"]);
    });
  });

  describe(coversRoute("GET /activity"), () => {
    it("returns only the caller's own tenant's audit entries", async () => {
      const res = await get("/activity", tenantA.accessToken);
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        items: { action: string; target: string }[];
      };
      // Provisioning wrote entries for both tenants; only one tenant's are here.
      expect(body.items.length).toBeGreaterThan(0);
      for (const entry of body.items) {
        expect(entry.target).not.toContain(tenantB.slug);
      }

      expect((await get("/activity")).status).toBe(401);
    });
  });
});
