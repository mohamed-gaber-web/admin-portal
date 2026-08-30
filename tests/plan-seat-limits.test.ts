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
import {
  DEFAULT_TENANT_PLAN,
  TENANT_PLANS
} from "../packages/contracts/src/schemas/tenant";

/**
 * Packages, and the seats each one includes.
 *
 * The rule this suite exists to hold is one sentence: a tenant may hold as many
 * users as its package includes, and the way to change that number is to change
 * the package. Everything below is either that rule or an edge of it.
 *
 * End-to-end against the real server and a real database, because the check is
 * a SQL one inside a transaction — a mock of the count would be a mock of the
 * only thing worth testing here.
 */

const MIGRATIONS_DIR = join(repoRoot, "packages/db/migrations");
// Unique across the suite — parallel files sharing a port means two API servers
// on two databases and requests landing on whichever bound first.
const PORT = 34841;
const JWT_SECRET = "seat-limit-suite-signing-key-at-least-32-chars";

/** What the migration seeds. Asserted below rather than assumed. */
const EXPECTED_LIMITS: Record<string, number> = {
  trial: 3,
  starter: 10,
  growth: 25,
  enterprise: 100
};

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  console.warn(
    "[seats] DATABASE_URL not set — the plan seat limit suite is SKIPPED. Set DATABASE_URL to a Postgres admin connection to run it."
  );
}

describe.skipIf(!hasDb)("plan seat limits", () => {
  let db: ThrowawayDatabase | undefined;
  let pool: Pool;
  let api: RunningApi | undefined;
  let operator: PlatformAdminFixture;
  let tenant: TenantFixture;

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
    tenant = await seedTenant(pool, api.baseUrl, "seats-acme", {
      permissions: ["tenant.read", "user.read", "user.write"]
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

  /** Moves the tenant onto a package, as an operator would. */
  const setPlan = (plan: string): Promise<Response> =>
    request(
      "PATCH",
      API_ROUTES.platformTenantPlan.replace(":id", tenant.tenantId),
      operator.accessToken,
      { plan }
    );

  const inviteUser = (email: string): Promise<Response> =>
    request("POST", API_ROUTES.userInvitations, tenant.accessToken, {
      email,
      role: "admin"
    });

  const countUsers = async (): Promise<number> => {
    const res = await pool.query<{ count: string }>(
      `SELECT count(*) FROM "user" WHERE tenant_id = $1`,
      [tenant.tenantId]
    );
    return Number(res.rows[0].count);
  };

  describe("the catalogue", () => {
    it("defines a positive seat count for every plan the enum allows", async () => {
      const res = await pool.query<{ key: string; user_limit: number }>(
        "SELECT key, user_limit FROM plan ORDER BY sort_order"
      );

      // Every key the contract offers must exist here. A plan an operator can
      // select but that has no row is a tenant with no allowance at all — the
      // join in `findSeatUsage` would return nothing, and the tenant would
      // vanish from the list rather than fail loudly.
      expect(res.rows.map((row) => row.key)).toEqual([...TENANT_PLANS]);

      for (const row of res.rows) {
        expect(row.user_limit).toBe(EXPECTED_LIMITS[row.key]);
        expect(row.user_limit).toBeGreaterThan(0);
      }
    });

    it("is served to an operator, and refused to a tenant administrator", async () => {
      const asOperator = await request("GET", API_ROUTES.platformPlans, operator.accessToken);
      expect(asOperator.status).toBe(200);

      const plans = (await asOperator.json()) as { key: string; userLimit: number }[];
      expect(plans.map((plan) => plan.key)).toEqual([...TENANT_PLANS]);
      expect(plans.find((plan) => plan.key === "growth")?.userLimit).toBe(25);

      // The catalogue is harmless, but it lives behind the platform guard like
      // every other /platform route. A route that read as public because its
      // body is dull is how the next one gets added without a check.
      const asTenant = await request("GET", API_ROUTES.platformPlans, tenant.accessToken);
      expect(asTenant.status).toBe(403);
    });

    it("refuses a package that includes no users", async () => {
      // The constraint is what stops a typo from bricking new tenants: a
      // zero-seat package cannot even be provisioned, since provisioning
      // creates the first admin.
      await expect(
        pool.query(
          "INSERT INTO plan (key, description, user_limit) VALUES ('broken', 'Zero seats', 0)"
        )
      ).rejects.toThrow(/plan_user_limit_positive/);
    });

    it("is the authority on which plans exist", async () => {
      // The foreign key replaced the old check constraint, so an unknown plan
      // is refused by the catalogue rather than by a duplicate list of keys.
      await expect(
        pool.query("UPDATE tenant SET plan = 'platinum' WHERE id = $1", [tenant.tenantId])
      ).rejects.toThrow(/tenant_plan_fkey/);
    });

    it("will not drop a package while a tenant is on it", async () => {
      // ON DELETE RESTRICT. Those tenants would otherwise be left pointing at
      // nothing, which is not "no limit" — it is a tenant that no longer joins.
      //
      // The tenant is put on the package first rather than assumed to be there.
      // It used to be, back when `trial` was the column default; the default is
      // now `growth`, and an assumption like that failing does not fail this
      // test — it makes the DELETE succeed and takes the package out of the
      // catalogue for every assertion after it.
      expect((await setPlan("trial")).status).toBe(200);

      await expect(pool.query("DELETE FROM plan WHERE key = 'trial'")).rejects.toThrow(
        /tenant_plan_fkey/
      );
    });
  });

  describe("what a tenant's package buys", () => {
    it("reports seats used against seats included", async () => {
      await setPlan("trial");

      const res = await request(
        "GET",
        API_ROUTES.platformTenant.replace(":id", tenant.tenantId),
        operator.accessToken
      );
      expect(res.status).toBe(200);

      const detail = (await res.json()) as { userCount: number; userLimit: number };
      expect(detail.userLimit).toBe(EXPECTED_LIMITS.trial);
      expect(detail.userCount).toBe(await countUsers());
    });

    it("moves the allowance when the operator moves the package", async () => {
      await setPlan("enterprise");

      const res = await request(
        "GET",
        API_ROUTES.platformTenant.replace(":id", tenant.tenantId),
        operator.accessToken
      );
      const detail = (await res.json()) as { plan: string; userLimit: number };

      // The allowance is the package's, not a copy on the tenant. Changing one
      // is the only way to change the other.
      expect(detail.plan).toBe("enterprise");
      expect(detail.userLimit).toBe(EXPECTED_LIMITS.enterprise);
    });
  });

  describe("enforcement", () => {
    it("refuses an invitation once the package's seats are used", async () => {
      // Trial includes three. The fixture's admin is the first, so two more
      // fill it exactly.
      await setPlan("trial");

      expect(await countUsers()).toBe(1);

      expect((await inviteUser("second@seats-acme.local")).status).toBe(201);
      expect((await inviteUser("third@seats-acme.local")).status).toBe(201);
      expect(await countUsers()).toBe(EXPECTED_LIMITS.trial);

      const refused = await inviteUser("fourth@seats-acme.local");
      expect(refused.status).toBe(409);

      const body = (await refused.json()) as {
        message: string;
        seats?: { used: number; limit: number; plan: string };
      };
      // The numbers ride along beside the prose, so a client can render them
      // rather than parse them back out of a sentence.
      expect(body.seats).toEqual({ plan: "trial", used: 3, limit: 3 });
      expect(body.message).toContain("3");

      // Refused, not merely reported: the row must not exist.
      expect(await countUsers()).toBe(EXPECTED_LIMITS.trial);
      const orphan = await pool.query(
        `SELECT 1 FROM "user" WHERE tenant_id = $1 AND email = $2`,
        [tenant.tenantId, "fourth@seats-acme.local"]
      );
      expect(orphan.rowCount).toBe(0);
    });

    it("lets the same invitation be reissued when the tenant is full", async () => {
      // The user already occupies a seat, so reissuing their link consumes
      // nothing. Refusing it would strand the one person a full tenant most
      // needs to reach — an administrator whose invitation expired unaccepted.
      expect(await countUsers()).toBe(EXPECTED_LIMITS.trial);

      const reissued = await inviteUser("third@seats-acme.local");
      expect(reissued.status).toBe(201);
      expect(await countUsers()).toBe(EXPECTED_LIMITS.trial);
    });

    it("admits the next user as soon as the package grows", async () => {
      // The operator's remedy, and the whole point of the design: seats are a
      // property of the package, so a bigger package is how you get more.
      expect((await setPlan("starter")).status).toBe(200);

      const admitted = await inviteUser("fourth@seats-acme.local");
      expect(admitted.status).toBe(201);
      expect(await countUsers()).toBe(4);
    });

    it("leaves an over-allowance tenant intact, and merely unable to grow", async () => {
      // A downgrade below the current headcount is allowed — an operator
      // sometimes means to do it before removing people. What it must not do is
      // delete anybody or lock the tenant out.
      expect((await setPlan("trial")).status).toBe(200);
      expect(await countUsers()).toBe(4);

      const refused = await inviteUser("fifth@seats-acme.local");
      expect(refused.status).toBe(409);

      const body = (await refused.json()) as { seats?: { used: number; limit: number } };
      // Over, not merely at — the message has to be able to say so.
      expect(body.seats).toEqual({ plan: "trial", used: 4, limit: 3 });

      // The existing people still have their accounts.
      expect(await countUsers()).toBe(4);
    });
  });

  describe("a tenant's negotiated allowance", () => {
    const setSeats = (seatLimit: number | null): Promise<Response> =>
      request(
        "PATCH",
        API_ROUTES.platformTenantSeats.replace(":id", tenant.tenantId),
        operator.accessToken,
        { seatLimit }
      );

    it("overrides the package, and reports itself as negotiated", async () => {
      await setPlan("trial"); // includes 3
      expect((await setSeats(9)).status).toBe(200);

      const res = await request(
        "GET",
        API_ROUTES.platformTenant.replace(":id", tenant.tenantId),
        operator.accessToken
      );
      const detail = (await res.json()) as {
        userLimit: number;
        seatLimitOverride: number | null;
        plan: string;
      };

      // `userLimit` is always the effective number, so every screen and every
      // check reads one field; the override says where it came from.
      expect(detail.plan).toBe("trial");
      expect(detail.userLimit).toBe(9);
      expect(detail.seatLimitOverride).toBe(9);
    });

    it("admits users up to the negotiated figure, not the package's", async () => {
      // Four users exist from the enforcement suite above, which is already past
      // trial's 3. The override is what makes room.
      expect(await countUsers()).toBe(4);

      expect((await inviteUser("fifth@seats-acme.local")).status).toBe(201);
      expect(await countUsers()).toBe(5);
    });

    it("survives a plan change — the negotiation is not the package", async () => {
      expect((await setPlan("enterprise")).status).toBe(200);

      const res = await request(
        "GET",
        API_ROUTES.platformTenant.replace(":id", tenant.tenantId),
        operator.accessToken
      );
      const detail = (await res.json()) as { userLimit: number; seatLimitOverride: number | null };

      // Enterprise includes 100, but this tenant was given 9. A plan change must
      // not silently discard a figure somebody agreed to.
      expect(detail.seatLimitOverride).toBe(9);
      expect(detail.userLimit).toBe(9);
    });

    it("clears back to the package's number when set to null", async () => {
      expect((await setSeats(null)).status).toBe(200);

      const res = await request(
        "GET",
        API_ROUTES.platformTenant.replace(":id", tenant.tenantId),
        operator.accessToken
      );
      const detail = (await res.json()) as { userLimit: number; seatLimitOverride: number | null };

      expect(detail.seatLimitOverride).toBeNull();
      expect(detail.userLimit).toBe(EXPECTED_LIMITS.enterprise);
    });

    it("tracks the package afterwards rather than freezing at the old number", async () => {
      // The whole reason the column is nullable. A tenant that inherits must
      // move when the package moves; one that was given a figure must not.
      await pool.query("UPDATE plan SET user_limit = 120 WHERE key = 'enterprise'");
      try {
        const res = await request(
          "GET",
          API_ROUTES.platformTenant.replace(":id", tenant.tenantId),
          operator.accessToken
        );
        const detail = (await res.json()) as { userLimit: number };
        expect(detail.userLimit).toBe(120);
      } finally {
        await pool.query("UPDATE plan SET user_limit = $1 WHERE key = 'enterprise'", [
          EXPECTED_LIMITS.enterprise
        ]);
      }
    });

    it("refuses a zero or negative allowance", async () => {
      // A zero-seat tenant would be locked out of its own workspace, and its
      // administrators are users — there is no screen that could undo it.
      expect((await setSeats(0)).status).toBe(400);
      expect((await setSeats(-5)).status).toBe(400);
    });

    it("allows a cut below current usage, without removing anybody", async () => {
      const before = await countUsers();
      expect((await setSeats(1)).status).toBe(200);
      expect(await countUsers()).toBe(before);

      // Bounded and reversible: nobody deleted, nobody signed out, just no room
      // for another.
      const refused = await inviteUser("sixth@seats-acme.local");
      expect(refused.status).toBe(409);
      const body = (await refused.json()) as { seats?: { used: number; limit: number } };
      expect(body.seats?.limit).toBe(1);

      await setSeats(null);
    });

    it("writes one audit entry, and none for an unchanged retry", async () => {
      await setSeats(42);
      const first = await pool.query(
        "SELECT count(*) FROM audit_log WHERE tenant_id = $1 AND action = 'tenant.seats_changed'",
        [tenant.tenantId]
      );

      // Idempotent: the same figure again is not a second negotiation.
      expect((await setSeats(42)).status).toBe(200);
      const second = await pool.query(
        "SELECT count(*) FROM audit_log WHERE tenant_id = $1 AND action = 'tenant.seats_changed'",
        [tenant.tenantId]
      );
      expect(second.rows[0].count).toBe(first.rows[0].count);

      await setSeats(null);
    });
  });

  describe("editing what a package includes", () => {
    const setPlanSeats = (key: string, userLimit: unknown): Promise<Response> =>
      request(
        "PATCH",
        API_ROUTES.platformPlan.replace(":key", key),
        operator.accessToken,
        { userLimit }
      );

    /** Puts a package back, so later assertions read the seeded catalogue. */
    const restore = (key: string) =>
      pool.query("UPDATE plan SET user_limit = $2 WHERE key = $1", [key, EXPECTED_LIMITS[key]]);

    it("moves the allowance of every tenant on the package", async () => {
      // The tenant is on enterprise and inherits, having cleared its override
      // in the suite above.
      await setPlan("enterprise");

      const res = await setPlanSeats("enterprise", 150);
      expect(res.status).toBe(200);

      // The whole catalogue comes back, so the screen can re-render the counts
      // beside every row rather than patching the one it changed.
      const plans = (await res.json()) as { key: string; userLimit: number; tenantCount: number }[];
      expect(plans.map((plan) => plan.key)).toEqual([...TENANT_PLANS]);
      expect(plans.find((plan) => plan.key === "enterprise")?.userLimit).toBe(150);

      const detail = await request(
        "GET",
        API_ROUTES.platformTenant.replace(":id", tenant.tenantId),
        operator.accessToken
      );
      // No cache to invalidate: the effective limit is computed per read.
      expect(((await detail.json()) as { userLimit: number }).userLimit).toBe(150);

      await restore("enterprise");
    });

    it("leaves a tenant with a negotiated figure alone", async () => {
      // The whole reason the override column is nullable. A package moving must
      // not overwrite a number somebody agreed to.
      await request(
        "PATCH",
        API_ROUTES.platformTenantSeats.replace(":id", tenant.tenantId),
        operator.accessToken,
        { seatLimit: 12 }
      );

      expect((await setPlanSeats("enterprise", 150)).status).toBe(200);

      const detail = await request(
        "GET",
        API_ROUTES.platformTenant.replace(":id", tenant.tenantId),
        operator.accessToken
      );
      const body = (await detail.json()) as { userLimit: number; seatLimitOverride: number | null };
      expect(body.seatLimitOverride).toBe(12);
      expect(body.userLimit).toBe(12);

      await restore("enterprise");
      await request(
        "PATCH",
        API_ROUTES.platformTenantSeats.replace(":id", tenant.tenantId),
        operator.accessToken,
        { seatLimit: null }
      );
    });

    it("counts the tenants each package holds", async () => {
      await setPlan("growth");

      const plans = (await (
        await request("GET", API_ROUTES.platformPlans, operator.accessToken)
      ).json()) as { key: string; tenantCount: number }[];

      const growth = plans.find((plan) => plan.key === "growth");
      // At least this tenant. Other suites in the same database may hold more,
      // so the assertion is a floor rather than an exact figure.
      expect(growth?.tenantCount).toBeGreaterThanOrEqual(1);
      expect(plans.every((plan) => plan.tenantCount >= 0)).toBe(true);

      await setPlan("enterprise");
    });

    it("refuses a zero, negative, or fractional seat count", async () => {
      // Mirrors plan_user_limit_positive. A zero-seat package cannot be
      // provisioned at all, since provisioning creates the first admin.
      expect((await setPlanSeats("growth", 0)).status).toBe(400);
      expect((await setPlanSeats("growth", -5)).status).toBe(400);
      expect((await setPlanSeats("growth", 2.5)).status).toBe(400);

      const plans = (await (
        await request("GET", API_ROUTES.platformPlans, operator.accessToken)
      ).json()) as { key: string; userLimit: number }[];
      expect(plans.find((plan) => plan.key === "growth")?.userLimit).toBe(EXPECTED_LIMITS.growth);
    });

    it("404s for a package that is not in the catalogue", async () => {
      expect((await setPlanSeats("platinum", 50)).status).toBe(404);
    });

    it("is refused to a tenant administrator", async () => {
      const res = await request(
        "PATCH",
        API_ROUTES.platformPlan.replace(":key", "growth"),
        tenant.accessToken,
        { userLimit: 999 }
      );
      expect(res.status).toBe(403);
    });

    it("writes one audit entry, and none for an unchanged retry", async () => {
      const countEntries = async (): Promise<number> => {
        const res = await pool.query<{ count: string }>(
          "SELECT count(*) FROM audit_log WHERE action = 'plan.seats_changed'"
        );
        return Number(res.rows[0].count);
      };

      const before = await countEntries();
      expect((await setPlanSeats("starter", 11)).status).toBe(200);
      expect(await countEntries()).toBe(before + 1);

      // Idempotent: the same figure again is not a second decision.
      expect((await setPlanSeats("starter", 11)).status).toBe(200);
      expect(await countEntries()).toBe(before + 1);

      // Filed against the platform tenant, since `plan` belongs to no tenant
      // and `audit_log.tenant_id` is NOT NULL.
      const entry = await pool.query<{ slug: string; after_values: { userLimit: number } }>(
        `SELECT t.slug, a.after_values
           FROM audit_log a JOIN tenant t ON t.id = a.tenant_id
          WHERE a.action = 'plan.seats_changed'
          ORDER BY a.created_at DESC LIMIT 1`
      );
      expect(entry.rows[0].slug).toBe("platform");
      expect(entry.rows[0].after_values.userLimit).toBe(11);

      await restore("starter");
    });

    it("admits a user that the old allowance refused", async () => {
      // The operator's other remedy, and the reason this screen exists: raising
      // the package is how everybody on it gets more room at once.
      await setPlan("trial"); // includes 3
      await setPlanSeats("trial", 3);

      const used = await countUsers();
      expect(used).toBeGreaterThanOrEqual(3);

      expect((await inviteUser("packaged@seats-acme.local")).status).toBe(409);

      expect((await setPlanSeats("trial", used + 1)).status).toBe(200);
      expect((await inviteUser("packaged@seats-acme.local")).status).toBe(201);

      await restore("trial");
      await setPlan("enterprise");
    });
  });

  describe("renaming a tenant", () => {
    const rename = (name: unknown): Promise<Response> =>
      request(
        "PATCH",
        API_ROUTES.platformTenantUpdate.replace(":id", tenant.tenantId),
        operator.accessToken,
        { name }
      );

    it("changes the name and leaves the slug alone", async () => {
      const res = await rename("Renamed Acme");
      expect(res.status).toBe(200);

      const body = (await res.json()) as { name: string; slug: string };
      expect(body.name).toBe("Renamed Acme");
      // The slug is identity — invitations already sent carry it.
      expect(body.slug).toBe("seats-acme");
    });

    it("trims, and refuses a name that is empty once trimmed", async () => {
      expect((await rename("   Padded Name   ")).status).toBe(200);

      const detail = await request(
        "GET",
        API_ROUTES.platformTenant.replace(":id", tenant.tenantId),
        operator.accessToken
      );
      expect(((await detail.json()) as { name: string }).name).toBe("Padded Name");

      // `min(1)` passes a string of spaces, so the refusal has to happen after
      // trimming or a tenant can be renamed to a blank row.
      expect((await rename("   ")).status).toBe(404);
      expect((await rename("")).status).toBe(400);
    });

    it("writes one audit entry, and none for an unchanged retry", async () => {
      const count = async (): Promise<number> => {
        const res = await pool.query<{ count: string }>(
          "SELECT count(*) FROM audit_log WHERE tenant_id = $1 AND action = 'tenant.renamed'",
          [tenant.tenantId]
        );
        return Number(res.rows[0].count);
      };

      await rename("Audited Name");
      const first = await count();
      expect((await rename("Audited Name")).status).toBe(200);
      expect(await count()).toBe(first);
    });

    it("404s for a tenant that does not exist", async () => {
      const res = await request(
        "PATCH",
        API_ROUTES.platformTenantUpdate.replace(
          ":id",
          "00000000-0000-0000-0000-000000000000"
        ),
        operator.accessToken,
        { name: "Ghost" }
      );
      expect(res.status).toBe(404);
    });

    it("is refused to a tenant administrator", async () => {
      const res = await request(
        "PATCH",
        API_ROUTES.platformTenantUpdate.replace(":id", tenant.tenantId),
        tenant.accessToken,
        { name: "Self Serve" }
      );
      expect(res.status).toBe(403);
    });
  });

  describe("unblocking a pending tenant", () => {
    /*
     * `pending` is derived from "nobody in this tenant has signed in yet", so no
     * lifecycle transition clears it. The only thing that does is somebody
     * accepting an invitation — and until this endpoint existed there was no way
     * for an operator to produce one, because issuing invitations needs a
     * permission only a signed-in member of that tenant can hold.
     */
    let pendingTenantId: string;

    it("creates a tenant that reads as pending until somebody signs in", async () => {
      const res = await request("POST", API_ROUTES.tenants, operator.accessToken, {
        name: "Pending Co",
        slug: "seats-pending"
      });
      expect(res.status).toBe(201);
      pendingTenantId = ((await res.json()) as { tenant: { id: string } }).tenant.id;

      const detail = await request(
        "GET",
        API_ROUTES.platformTenant.replace(":id", pendingTenantId),
        operator.accessToken
      );
      // One user exists — the admin — but they have not accepted, so no user is
      // active and the tenant is pending.
      expect(((await detail.json()) as { status: string }).status).toBe("pending");
    });

    it("issues a fresh invitation for that tenant's admin", async () => {
      const res = await request(
        "POST",
        API_ROUTES.platformTenantAdminInvitation.replace(":id", pendingTenantId),
        operator.accessToken
      );
      expect(res.status).toBe(201);

      const body = (await res.json()) as {
        email: string;
        invitation: { token: string; expiresAt: string };
      };
      // Addressed to the admin the detail screen names, resolved server-side.
      expect(body.email).toBe("admin@seats-pending.local");
      expect(body.invitation.token).toBeTruthy();
      expect(new Date(body.invitation.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it("turns the tenant active once the invitation is accepted", async () => {
      const issued = await request(
        "POST",
        API_ROUTES.platformTenantAdminInvitation.replace(":id", pendingTenantId),
        operator.accessToken
      );
      const { invitation } = (await issued.json()) as { invitation: { token: string } };

      const accepted = await request("POST", API_ROUTES.acceptInvitation, undefined, {
        token: invitation.token,
        password: "a-perfectly-ordinary-passphrase"
      });
      expect(accepted.status).toBe(200);

      const detail = await request(
        "GET",
        API_ROUTES.platformTenant.replace(":id", pendingTenantId),
        operator.accessToken
      );
      // Derived, so it moves on its own the moment a user becomes active —
      // there is no status write anywhere in this test.
      expect(((await detail.json()) as { status: string }).status).toBe("active");
    });

    it("refuses to reissue for an administrator who already has a password", async () => {
      // Re-inviting somebody with a credential is a password reset wearing the
      // wrong name, and a way to take over an account by inviting it.
      const res = await request(
        "POST",
        API_ROUTES.platformTenantAdminInvitation.replace(":id", pendingTenantId),
        operator.accessToken
      );
      expect(res.status).toBe(409);
    });

    it("404s for a tenant that does not exist", async () => {
      const res = await request(
        "POST",
        API_ROUTES.platformTenantAdminInvitation.replace(
          ":id",
          "00000000-0000-0000-0000-000000000000"
        ),
        operator.accessToken
      );
      expect(res.status).toBe(404);
    });

    it("is refused to a tenant administrator", async () => {
      const res = await request(
        "POST",
        API_ROUTES.platformTenantAdminInvitation.replace(":id", pendingTenantId),
        tenant.accessToken
      );
      expect(res.status).toBe(403);
    });
  });

  describe("provisioning", () => {
    it("agrees with the contract about which package is the default", async () => {
      // Two places name the default: the column, which actually applies it, and
      // `DEFAULT_TENANT_PLAN`, which the create form pre-selects. If they drift,
      // the form shows one package and provisioning quietly uses another.
      const res = await pool.query<{ column_default: string }>(
        `SELECT column_default FROM information_schema.columns
          WHERE table_name = 'tenant' AND column_name = 'plan'`
      );
      // Stored as `'growth'::text`.
      expect(res.rows[0].column_default).toContain(`'${DEFAULT_TENANT_PLAN}'`);
      expect(EXPECTED_LIMITS[DEFAULT_TENANT_PLAN]).toBe(25);
    });

    it("starts a tenant on the package the operator chose", async () => {
      // The whole point of the field: a customer who has already bought
      // something should not be created on the default and immediately moved,
      // which is two audit entries describing one decision.
      const res = await request("POST", API_ROUTES.tenants, operator.accessToken, {
        name: "Chosen Package",
        slug: "seats-chosen",
        plan: "starter"
      });
      expect(res.status).toBe(201);

      const created = (await res.json()) as { tenant: { id: string } };
      const detail = await request(
        "GET",
        API_ROUTES.platformTenant.replace(":id", created.tenant.id),
        operator.accessToken
      );
      const body = (await detail.json()) as { plan: string; userLimit: number };
      expect(body.plan).toBe("starter");
      expect(body.userLimit).toBe(EXPECTED_LIMITS.starter);
    });

    it("refuses a package that is not in the catalogue", async () => {
      const res = await request("POST", API_ROUTES.tenants, operator.accessToken, {
        name: "Bad Package",
        slug: "seats-badplan",
        plan: "platinum"
      });
      expect(res.status).toBe(400);
    });

    it("creates a tenant on the default package, with 25 seats", async () => {
      // The narrowest edge in the design: provisioning creates a user, so a
      // default package with no seats would make every new tenant fail at
      // creation. The check constraint forbids zero, and `growth` is the
      // default — 25 seats, so a new customer is not full after two colleagues.
      const res = await request("POST", API_ROUTES.tenants, operator.accessToken, {
        name: "Fresh Tenant",
        slug: "seats-fresh"
      });
      expect(res.status).toBe(201);

      const created = (await res.json()) as { tenant: { id: string } };
      const usage = await pool.query<{ plan: string; user_limit: number; used: string }>(
        `SELECT t.plan, p.user_limit,
                (SELECT count(*) FROM "user" u WHERE u.tenant_id = t.id) AS used
           FROM tenant t JOIN plan p ON p.key = t.plan
          WHERE t.id = $1`,
        [created.tenant.id]
      );

      expect(usage.rows[0].plan).toBe("growth");
      expect(usage.rows[0].user_limit).toBe(EXPECTED_LIMITS.growth);
      expect(Number(usage.rows[0].used)).toBe(1);
      expect(usage.rows[0].user_limit).toBeGreaterThan(Number(usage.rows[0].used));
    });
  });
});
