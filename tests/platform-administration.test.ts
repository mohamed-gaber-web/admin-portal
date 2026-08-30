import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import migrate from "node-pg-migrate";
import { join } from "node:path";
import { repoRoot } from "./helpers";
import { createThrowawayDatabase, type ThrowawayDatabase } from "./pg-helpers";
import { startApi, type RunningApi } from "./api-server";
import {
  seedPlatformAdmin,
  seedTenant,
  type PlatformAdminFixture,
  type TenantFixture
} from "./tenant-fixtures";
import { API_ROUTES } from "../packages/contracts/src/routes";
import { PERMISSION_KEYS, PLATFORM_PERMISSION_KEYS } from "../packages/contracts/src/schemas/role";
import {
  PLATFORM_ADMIN_ROLE,
  PLATFORM_TENANT_SLUG
} from "../packages/db/src/platform";

/**
 * The platform administration tier.
 *
 * An account that sees every tenant and every user is the largest privilege in
 * this system, so the suite spends most of its effort on what it *cannot* do
 * and on who cannot become it. The happy path is three assertions; the fence
 * around it is the rest.
 *
 * End-to-end against the real server: the tokens are ones the API issued, the
 * requests go over HTTP, and the escalation attempts run against the real
 * database with its real triggers rather than against a mock of them.
 */

const MIGRATIONS_DIR = join(repoRoot, "packages/db/migrations");
// Unique across the suite — parallel test files sharing a port means two API
// servers on two databases and requests landing on whichever bound first.
const PORT = 34833;
const JWT_SECRET = "platform-suite-signing-key-at-least-32-chars";

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  console.warn(
    "[platform] DATABASE_URL not set — the platform administration suite is SKIPPED. Set DATABASE_URL to a Postgres admin connection to run it."
  );
}

describe.skipIf(!hasDb)("platform administration", () => {
  let db: ThrowawayDatabase | undefined;
  let pool: Pool;
  let api: RunningApi | undefined;
  let operator: PlatformAdminFixture;
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

    operator = await seedPlatformAdmin(pool, api.baseUrl);

    // Two customers, because "sees every tenant" cannot be demonstrated against
    // one — a broken query that returned only the caller's own rows would pass.
    tenantA = await seedTenant(pool, api.baseUrl, "acme-platform", {
      companies: ["Acme Manufacturing"],
      permissions: ["tenant.read", "tenant.write", "user.read", "user.write"]
    });
    tenantB = await seedTenant(pool, api.baseUrl, "globex-platform", {
      companies: ["Globex Holdings"],
      permissions: ["tenant.read", "user.read"]
    });
  }, 180_000);

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
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

  describe("the reserved tenant", () => {
    it("is created by migration, flagged, and unique", async () => {
      const res = await pool.query<{ id: string; slug: string }>(
        "SELECT id, slug FROM tenant WHERE is_platform"
      );
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0].slug).toBe(PLATFORM_TENANT_SLUG);

      // The partial unique index is what makes "at most one" a fact rather than
      // a convention. A second platform tenant would be a second unbounded-reach
      // tenant that no screen lists.
      await expect(
        pool.query(
          "INSERT INTO tenant (name, slug, is_platform) VALUES ('Second', 'platform-two', true)"
        )
      ).rejects.toThrow(/unique|duplicate/i);
    });

    it("gives the platform role the cross-tenant permissions", async () => {
      const res = await pool.query<{ key: string }>(
        `SELECT p.key FROM role r
           JOIN tenant t ON t.id = r.tenant_id
           JOIN role_permission rp ON rp.role_id = r.id
           JOIN permission p ON p.id = rp.permission_id
          WHERE t.is_platform AND r.name = $1 AND p.key LIKE 'platform.%'
          ORDER BY p.key`,
        [PLATFORM_ADMIN_ROLE]
      );
      expect(res.rows.map((row) => row.key)).toEqual([...PLATFORM_PERMISSION_KEYS].sort());
    });
  });

  describe("what the operator can see", () => {
    it("lists every tenant, not just its own", async () => {
      const res = await request("GET", `${API_ROUTES.platformTenants}?pageSize=100`, operator.accessToken);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { items: { slug: string }[]; total: number };
      const slugs = body.items.map((item) => item.slug);
      expect(slugs).toContain(tenantA.slug);
      expect(slugs).toContain(tenantB.slug);
    });

    it("leaves the reserved tenant out of the list and answers 404 for its id", async () => {
      const list = await request("GET", `${API_ROUTES.platformTenants}?pageSize=100`, operator.accessToken);
      const body = (await list.json()) as { items: { slug: string }[] };
      expect(body.items.map((item) => item.slug)).not.toContain(PLATFORM_TENANT_SLUG);

      // Hidden consistently: a leaked id must lead nowhere, or the exclusion is
      // decoration rather than a boundary.
      const detail = await request(
        "GET",
        `/platform/tenants/${operator.tenantId}`,
        operator.accessToken
      );
      expect(detail.status).toBe(404);

      // And it cannot be archived, which would soft-delete the only tenant from
      // which a tenant can be created.
      const archive = await request(
        "PATCH",
        `/platform/tenants/${operator.tenantId}/status`,
        operator.accessToken,
        { status: "archived" }
      );
      expect(archive.status).toBe(404);
    });

    it("lists users from every tenant, each carrying its tenant", async () => {
      const res = await request("GET", `${API_ROUTES.platformUsers}?pageSize=100`, operator.accessToken);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { items: { email: string; tenantSlug: string }[] };
      const byEmail = new Map(body.items.map((item) => [item.email, item.tenantSlug]));

      expect(byEmail.get(tenantA.email)).toBe(tenantA.slug);
      expect(byEmail.get(tenantB.email)).toBe(tenantB.slug);
    });

    it("reads any tenant's detail and audit trail", async () => {
      const detail = await request(
        "GET",
        `/platform/tenants/${tenantB.tenantId}`,
        operator.accessToken
      );
      expect(detail.status).toBe(200);
      expect(((await detail.json()) as { slug: string }).slug).toBe(tenantB.slug);

      const activity = await request(
        "GET",
        `/platform/tenants/${tenantB.tenantId}/activity`,
        operator.accessToken
      );
      expect(activity.status).toBe(200);
      expect(Array.isArray(await activity.json())).toBe(true);
    });
  });

  describe("what the operator can change", () => {
    it("suspends a tenant it does not belong to, and records who did it", async () => {
      const res = await request(
        "PATCH",
        `/platform/tenants/${tenantB.tenantId}/status`,
        operator.accessToken,
        { status: "suspended" }
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe("suspended");

      /**
       * The entry lands in the *target* tenant's log, naming the operator.
       *
       * This is the accountability requirement, not a nicety: from inside that
       * tenant this is a change made by somebody they cannot see, and an
       * anonymous entry would leave the platform tier unanswerable to the people
       * it acts on.
       */
      const audit = await pool.query<{ actor_label: string }>(
        `SELECT actor_label FROM audit_log
          WHERE tenant_id = $1 AND action = 'tenant.suspended'`,
        [tenantB.tenantId]
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].actor_label).toBe(operator.email);

      // Restored, so the ordering of these tests cannot leave a suspended
      // tenant behind for the next one.
      const restore = await request(
        "PATCH",
        `/platform/tenants/${tenantB.tenantId}/status`,
        operator.accessToken,
        { status: "active" }
      );
      expect(restore.status).toBe(200);
    });

    it("suspends a user in another tenant, but never its own account", async () => {
      const suspend = await request(
        "PATCH",
        `/platform/users/${tenantA.userId}/status`,
        operator.accessToken,
        { status: "suspended" }
      );
      expect(suspend.status).toBe(200);
      expect(((await suspend.json()) as { status: string }).status).toBe("suspended");

      // An operator who suspends themselves is locked out with no screen that
      // could undo it, and there may be nobody else holding the tier.
      const self = await request(
        "PATCH",
        `/platform/users/${operator.userId}/status`,
        operator.accessToken,
        { status: "suspended" }
      );
      expect(self.status).toBe(400);

      const restore = await request(
        "PATCH",
        `/platform/users/${tenantA.userId}/status`,
        operator.accessToken,
        { status: "active" }
      );
      expect(restore.status).toBe(200);
    });
  });

  describe("who is refused", () => {
    it("refuses an unauthenticated caller with 401", async () => {
      for (const path of [API_ROUTES.platformTenants, API_ROUTES.platformUsers]) {
        const res = await request("GET", path);
        expect(res.status, path).toBe(401);
      }
    });

    it("refuses a tenant administrator holding every tenant permission", async () => {
      // tenantA holds tenant.write and user.write — the whole tenant half of
      // the catalogue. None of it reaches across the boundary.
      for (const path of [API_ROUTES.platformTenants, API_ROUTES.platformUsers]) {
        const res = await request("GET", path, tenantA.accessToken);
        expect(res.status, path).toBe(403);
      }
    });

    it("refuses a tenant administrator who has been granted a platform permission directly", async () => {
      /**
       * The escalation test, and the reason the guard checks two things.
       *
       * The grant below is forced in as the database owner, bypassing every
       * application path — which is more than an attacker inside the API could
       * do. Even then the request fails, because the token's tenant is not the
       * platform tenant.
       */
      const roleId = await pool.query<{ id: string }>(
        `SELECT r.id FROM role r
          JOIN user_role ur ON ur.role_id = r.id
         WHERE ur.user_id = $1 LIMIT 1`,
        [tenantA.userId]
      );

      const permissionId = await pool.query<{ id: string }>(
        "SELECT id FROM permission WHERE key = 'platform.tenant.read'"
      );

      // The trigger refuses it outright — a `platform.*` grant is only legal on
      // a role in the platform tenant, and that is enforced in the database so
      // it holds for whatever reaches the table, not only for code we wrote.
      await expect(
        pool.query(
          `INSERT INTO role_permission (tenant_id, role_id, permission_id)
           SELECT r.tenant_id, r.id, $2 FROM role r WHERE r.id = $1`,
          [roleId.rows[0].id, permissionId.rows[0].id]
        )
      ).rejects.toThrow(/platform tenant/i);
    });

    it("refuses a forged token claiming a platform permission", async () => {
      // Signed with the server's own key, so the signature is genuine — what it
      // lacks is a tenant that is allowed to hold the claim. This is the second
      // gate doing its job on its own.
      const forged = await signToken(
        {
          sub: tenantA.userId,
          tenantId: tenantA.tenantId,
          tenantSlug: tenantA.slug,
          email: tenantA.email,
          permissions: [...PLATFORM_PERMISSION_KEYS]
        },
        JWT_SECRET
      );

      const res = await request("GET", API_ROUTES.platformTenants, forged);
      expect(res.status).toBe(403);
    });
  });

  describe("tenants cannot create tenants", () => {
    it("refuses POST /tenants unauthenticated", async () => {
      const res = await request("POST", API_ROUTES.tenants, undefined, {
        name: "Sneaky Ltd",
        slug: "sneaky-anon"
      });
      expect(res.status).toBe(401);
    });

    it("refuses POST /tenants from a tenant administrator", async () => {
      const res = await request("POST", API_ROUTES.tenants, tenantA.accessToken, {
        name: "Sneaky Ltd",
        slug: "sneaky-tenant"
      });
      expect(res.status).toBe(403);

      const created = await pool.query("SELECT 1 FROM tenant WHERE slug = 'sneaky-tenant'");
      expect(created.rowCount).toBe(0);
    });

    it("allows the platform administrator, and the new tenant's admin gets no platform reach", async () => {
      const res = await request("POST", API_ROUTES.tenants, operator.accessToken, {
        name: "Initech",
        slug: "initech-platform"
      });
      expect(res.status).toBe(201);

      /**
       * Provisioning grants a new tenant's `admin` role the whole catalogue on
       * purpose, so that a permission added by a later migration is not silently
       * missed. Once `platform.*` keys were in that catalogue, this assertion is
       * what stands between that rule and handing every incoming tenant
       * cross-tenant reach.
       */
      const granted = await pool.query<{ key: string }>(
        `SELECT p.key FROM role r
           JOIN tenant t ON t.id = r.tenant_id
           JOIN role_permission rp ON rp.role_id = r.id
           JOIN permission p ON p.id = rp.permission_id
          WHERE t.slug = 'initech-platform' AND r.name = 'admin'
          ORDER BY p.key`
      );
      const keys = granted.rows.map((row) => row.key);
      expect(keys).toEqual([...PERMISSION_KEYS].sort());
      expect(keys.filter((key) => key.startsWith("platform."))).toEqual([]);
    });
  });

  describe("the tenant permission matrix cannot reach the platform keys", () => {
    it("rejects a platform key in PUT /roles/:id/permissions", async () => {
      const roles = await request("GET", API_ROUTES.roles, tenantA.accessToken);
      const list = (await roles.json()) as { id: string; name: string }[];
      const admin = list.find((role) => role.name === "admin")!;

      const res = await request(
        "PUT",
        `/roles/${admin.id}/permissions`,
        tenantA.accessToken,
        { permissions: ["user.read", "platform.tenant.read"] }
      );
      // Rejected by the contract schema before it reaches the database, because
      // `platform.*` is deliberately not in the tenant half of the catalogue.
      expect(res.status).toBe(400);
    });

    it("keeps the platform keys out of the tenant catalogue the portal renders", () => {
      // A key in PERMISSION_KEYS is a checkbox in the tenant permission matrix.
      for (const key of PERMISSION_KEYS) {
        expect(key.startsWith("platform."), `${key} must not be offered to tenants`).toBe(false);
      }
    });
  });
});

/**
 * Signs a token the way the API does, for the forged-claim test.
 *
 * Assembled from `node:crypto` rather than with `jose`, which is a dependency of
 * `apps/api` and not of the test root — and reaching for it here would make this
 * suite depend on another workspace's dependency graph. HS256 is a base64url
 * header, a base64url payload and an HMAC over the two, which is little enough
 * to write out.
 *
 * The signature is genuine: it is made with the key the server is running with.
 * That is the point of the test — what the token lacks is not a valid signature
 * but a tenant entitled to hold the claim inside it.
 */
async function signToken(
  claims: Record<string, unknown>,
  secret: string
): Promise<string> {
  const { createHmac } = await import("node:crypto");

  const { sub, ...rest } = claims;
  const now = Math.floor(Date.now() / 1000);

  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");

  const signingInput = [
    encode({ alg: "HS256", typ: "JWT" }),
    encode({
      ...rest,
      sub,
      iss: "growpath-admin-api",
      aud: "growpath-admin-portal",
      iat: now,
      exp: now + 900
    })
  ].join(".");

  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}
