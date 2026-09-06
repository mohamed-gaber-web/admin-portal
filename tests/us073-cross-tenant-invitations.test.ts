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
import { DEFAULT_TENANT_ROLES } from "../packages/contracts/src/schemas/role";
import { DEFAULT_ROLES } from "../packages/db/src/provisioning";

/**
 * Adding a user to a named tenant, from the platform tier (US-073).
 *
 * The tenant-scoped `POST /users/invitations` takes its tenant from the token
 * and cannot be pointed anywhere else, which is what makes it safe to hand to a
 * tenant administrator. An operator adding somebody to a customer's workspace
 * is outside that workspace by definition, so the tenant has to travel in the
 * body — and the whole question this suite asks is whether that field is only
 * ever honoured for somebody `PlatformGuard` has already vetted.
 *
 * The rest of the sequence is deliberately identical to the tenant-scoped
 * route's: one invitation, one role, both audited into the *target* tenant's
 * log. A user added this way should be indistinguishable from one the tenant
 * added itself.
 */

const MIGRATIONS_DIR = join(repoRoot, "packages/db/migrations");
// Unique across the suite: test files run in parallel, and a shared port means
// one file's server answering another file's requests.
const PORT = 34860;
const JWT_SECRET = "us073-suite-signing-key-at-least-32-characters";

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  console.warn(
    "[US-073] DATABASE_URL not set — the cross-tenant invitation suite is SKIPPED. Set DATABASE_URL to a Postgres admin connection to run it."
  );
}

describe("US-073 - the role list the picker offers", () => {
  it("matches the roles provisioning actually creates", () => {
    // `@growpath/db` cannot import `@growpath/contracts`, so the two lists are
    // kept in step by hand — which is exactly the arrangement that drifts
    // silently. A role added to provisioning and not to the contract would give
    // the operator's picker a stale set; this fails first.
    expect([...DEFAULT_TENANT_ROLES]).toEqual([...DEFAULT_ROLES]);
  });
});

describe.skipIf(!hasDb)("US-073 - inviting a user into a named tenant", () => {
  let db: ThrowawayDatabase | undefined;
  let pool: Pool;
  let api: RunningApi | undefined;
  let operator: PlatformAdminFixture;
  let tenant: TenantFixture;
  let other: TenantFixture;

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

    operator = await seedPlatformAdmin(pool, api.baseUrl, "operator@us073.test");

    // Two, because "into the tenant you named" cannot be demonstrated against
    // one: a bug that ignored the field and used some other tenant would pass.
    tenant = await seedTenant(pool, api.baseUrl, "acme-invite", {});
    other = await seedTenant(pool, api.baseUrl, "globex-invite", {});
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

  describe("an operator", () => {
    it("adds a user to the tenant named in the body", async () => {
      const res = await request("POST", API_ROUTES.platformUserInvitations, operator.accessToken, {
        tenantId: tenant.tenantId,
        email: "new.person@acme-invite.local",
        role: "viewer"
      });
      expect(res.status).toBe(201);

      const body = (await res.json()) as {
        user: { id: string; email: string; tenantSlug: string; status: string };
        token: string;
        expiresAt: string;
      };

      expect(body.user.tenantSlug).toBe(tenant.slug);
      // `invited`, not `active`: the account exists and cannot sign in until the
      // link is redeemed, which is the same state the tenant-scoped route
      // leaves behind.
      expect(body.user.status).toBe("invited");
      expect(body.token).toBeTruthy();

      const row = await pool.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM "user" WHERE id = $1`,
        [body.user.id]
      );
      expect(row.rows[0].tenant_id).toBe(tenant.tenantId);
    });

    it("gives them the role, resolved inside that tenant", async () => {
      const res = await request("POST", API_ROUTES.platformUserInvitations, operator.accessToken, {
        tenantId: tenant.tenantId,
        email: "an.admin@acme-invite.local",
        role: "admin",
        name: "An Admin"
      });
      expect(res.status).toBe(201);

      const body = (await res.json()) as { user: { id: string; name: string } };
      expect(body.user.name).toBe("An Admin");

      const roles = await pool.query<{ name: string; tenant_id: string }>(
        `SELECT r.name, r.tenant_id FROM user_role ur JOIN role r ON r.id = ur.role_id
         WHERE ur.user_id = $1`,
        [body.user.id]
      );
      expect(roles.rows.map((row) => row.name)).toEqual(["admin"]);
      // The role came from the target tenant, not from another tenant that
      // happens to have one by the same name. Every tenant has an `admin`, so
      // an unscoped lookup would pass the name check and fail this.
      expect(roles.rows[0].tenant_id).toBe(tenant.tenantId);
    });

    it("writes the audit entries into the target tenant's log, naming the operator", async () => {
      // Filtered by actor rather than read whole: the fixture's own setup
      // issued an invitation for the tenant's first administrator, so the log
      // legitimately holds entries this route did not write.
      const entries = await pool.query<{ action: string }>(
        `SELECT action FROM audit_log
         WHERE tenant_id = $1 AND actor_label = $2
         ORDER BY action`,
        [tenant.tenantId, operator.email]
      );

      const actions = entries.rows.map((row) => row.action);
      expect(actions).toContain("invitation.issued");
      // From inside the tenant this is a change made by somebody they cannot
      // see. An unattributed entry would leave the platform tier unaccountable
      // to the people it acts on.
      expect(actions).toContain("role.assigned");
    });

    it("answers 404 for a tenant that does not exist", async () => {
      const res = await request("POST", API_ROUTES.platformUserInvitations, operator.accessToken, {
        tenantId: "00000000-0000-4000-8000-000000000000",
        email: "nobody@nowhere.local",
        role: "viewer"
      });
      expect(res.status).toBe(404);
    });

    it("answers 400 for a role the target tenant does not have", async () => {
      const res = await request("POST", API_ROUTES.platformUserInvitations, operator.accessToken, {
        tenantId: tenant.tenantId,
        email: "wrong.role@acme-invite.local",
        role: "supervisor"
      });
      expect(res.status).toBe(400);

      const body = (await res.json()) as { roles?: string[] };
      expect(body.roles).toEqual(["supervisor"]);
    });

    it("answers 409 for somebody who already has a password there", async () => {
      const res = await request("POST", API_ROUTES.platformUserInvitations, operator.accessToken, {
        tenantId: tenant.tenantId,
        email: tenant.email,
        role: "viewer"
      });
      // Re-inviting an active account would be a password reset wearing the
      // wrong name, and a way to take over an account by inviting it.
      expect(res.status).toBe(409);
    });

    it("refuses an address that already belongs to somebody in another tenant", async () => {
      /**
       * The global-email-identity migration made an address one person across
       * the whole installation, so a consultant at two customers needs two
       * addresses. That is a real product constraint, and this route is the one
       * place an operator can run into it without being able to see the tenant
       * that holds the address — which is exactly why it has to answer in
       * words rather than with the 500 the unique index used to produce.
       */
      // A neutral address, so the assertion below is about what the message
      // says rather than about the domain the fixture happened to use.
      const shared = "shared.person@example.local";
      const first = await request(
        "POST",
        API_ROUTES.platformUserInvitations,
        operator.accessToken,
        { tenantId: tenant.tenantId, email: shared, role: "viewer" }
      );
      expect(first.status).toBe(201);

      const res = await request("POST", API_ROUTES.platformUserInvitations, operator.accessToken, {
        tenantId: other.tenantId,
        email: shared,
        role: "viewer"
      });
      expect(res.status).toBe(409);

      const body = (await res.json()) as { message: string };
      expect(body.message).toContain("already in use");
      // And it does not name the tenant that holds it. An operator can look it
      // up on the users screen; the message is also what a *tenant* administrator
      // sees on their own invite form, where it would be somebody else's
      // customer list.
      expect(body.message).not.toContain(tenant.slug);
    });
  });

  describe("nobody else", () => {
    it("refuses a tenant administrator, however complete their own permissions", async () => {
      const res = await request("POST", API_ROUTES.platformUserInvitations, tenant.accessToken, {
        tenantId: tenant.tenantId,
        email: "self.service@acme-invite.local",
        role: "viewer"
      });
      // 403 even for their *own* tenant. The route is the platform tier's, and
      // a tenant administrator who wants this has `POST /users/invitations`.
      expect(res.status).toBe(403);
    });

    it("refuses a tenant administrator pointing at somebody else's tenant", async () => {
      const res = await request("POST", API_ROUTES.platformUserInvitations, tenant.accessToken, {
        tenantId: other.tenantId,
        email: "intruder@globex-invite.local",
        role: "admin"
      });
      expect(res.status).toBe(403);

      const created = await pool.query<{ id: string }>(
        `SELECT id FROM "user" WHERE tenant_id = $1 AND email = $2`,
        [other.tenantId, "intruder@globex-invite.local"]
      );
      expect(created.rows).toEqual([]);
    });

    it("refuses an unauthenticated request", async () => {
      const res = await request("POST", API_ROUTES.platformUserInvitations, undefined, {
        tenantId: tenant.tenantId,
        email: "anonymous@acme-invite.local",
        role: "viewer"
      });
      expect(res.status).toBe(401);
    });
  });
});
