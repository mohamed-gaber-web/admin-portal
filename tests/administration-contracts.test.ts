import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import migrate from "node-pg-migrate";
import { join } from "node:path";
import { repoRoot } from "./helpers";
import { createThrowawayDatabase, type ThrowawayDatabase } from "./pg-helpers";
import { startApi, type RunningApi } from "./api-server";
import { FIXTURE_PASSWORD } from "./tenant-fixtures";
import { provisionTenant } from "../packages/db/src/provisioning";
import { acceptInvitation } from "../packages/db/src/invitations";
import { createCompany, createEnvironment } from "../packages/db/src/tenancy";
import { API_ROUTES } from "../packages/contracts/src/routes";
import {
  activityEntrySchema,
  activityPageSchema,
  issuedUserInvitationSchema,
  roleListSchema,
  roleSchema,
  tenantDetailSchema,
  tenantPageSchema,
  userDetailSchema,
  userPageSchema,
  z
} from "../packages/contracts/src";

/**
 * Every administration response, parsed with the schema the portal parses it
 * with.
 *
 * The isolation suite proves these endpoints enforce tenancy; this proves they
 * return what the client expects. The distinction matters because the portal's
 * `ApiService.getValidated` parses through these same schemas and *throws* on a
 * mismatch — so a renamed field or a stray column does not degrade a screen, it
 * blanks it.
 *
 * The schemas are `.strict()`, which is the point: an extra property is a
 * failure here rather than a silent widening of what a tenant-scoped endpoint
 * hands out. A test that accepted unknown keys would pass while the portal
 * broke.
 */

const MIGRATIONS_DIR = join(repoRoot, "packages/db/migrations");
const PORT = 34830;
const JWT_SECRET = "contract-suite-signing-key-at-least-32-chars";

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  console.warn(
    "[contracts] DATABASE_URL not set — the administration contract suite is SKIPPED."
  );
}

describe.skipIf(!hasDb)("administration responses match their contracts", () => {
  let db: ThrowawayDatabase | undefined;
  let pool: Pool;
  let api: RunningApi | undefined;
  let tenant: { tenantId: string; userId: string; email: string; accessToken: string };

  /**
   * Built through `provisionTenant` rather than the shared `seedTenant` helper.
   *
   * That helper inserts a tenant row directly, which is right for the isolation
   * suite — it wants two tenants cheaply. These assertions are about what the
   * administration screens render, and provisioning is what creates the default
   * roles, the role assignment and the first admin's invitation. A tenant built
   * without it has no roles, so every role-shaped assertion here would pass or
   * fail for reasons that have nothing to do with the endpoints.
   */
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

    const provisioned = await provisionTenant(pool, {
      name: "Contract Co",
      slug: "contract-co"
    });

    const environment = await createEnvironment(pool, {
      tenantId: provisioned.tenant.id,
      name: "PROD",
      url: "https://contract-co.crm4.dynamics.com"
    });
    for (const [index, name] of ["Contract Holdings", "Contract Retail"].entries()) {
      await createCompany(pool, {
        tenantId: provisioned.tenant.id,
        environmentId: environment.id,
        name,
        dataAreaId: `con${index}`
      });
    }

    // The admin has no credential until the invitation is redeemed, which is
    // the whole reason provisioning issues one.
    await acceptInvitation(pool, {
      token: provisioned.invitation.token,
      password: FIXTURE_PASSWORD
    });

    const res = await fetch(`${api.baseUrl}${API_ROUTES.login}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: "contract-co",
        email: provisioned.adminUser.email,
        password: FIXTURE_PASSWORD
      })
    });
    if (res.status !== 200) {
      throw new Error(`fixture sign-in failed: ${res.status} ${await res.text()}`);
    }

    tenant = {
      tenantId: provisioned.tenant.id,
      userId: provisioned.adminUser.id,
      email: provisioned.adminUser.email,
      accessToken: ((await res.json()) as { accessToken: string }).accessToken
    };
  }, 120_000);

  afterAll(async () => {
    api?.stop();
    await pool?.end();
    await db?.drop();
    db = undefined;
  });

  /** Fetches and parses, failing with the schema's own complaint. */
  async function parsed<T>(
    path: string,
    schema: z.ZodType<T>,
    init?: RequestInit
  ): Promise<T> {
    const res = await fetch(`${api!.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${tenant.accessToken}`,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers
      }
    });
    const body: unknown = await res.json();
    expect(res.status, `${path} -> ${JSON.stringify(body)}`).toBeLessThan(300);

    const result = schema.safeParse(body);
    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new Error(`${path} did not match its contract — ${detail}`);
    }
    return result.data;
  }

  it("GET /tenants returns a valid page of tenant summaries", async () => {
    const page = await parsed("/tenants?page=1&pageSize=10", tenantPageSchema);
    expect(page.items.length).toBeGreaterThan(0);

    const seeded = page.items.find((row) => row.slug === "contract-co");
    expect(seeded).toBeDefined();
    // The admin accepted their invitation during seeding, so the tenant has an
    // active user and is therefore active rather than pending.
    expect(seeded!.status).toBe("active");
    // The column default, which the fixture does not override. `growth` since
    // the default-plan-growth migration — a new tenant starts with 25 seats, so
    // that provisioning one does not produce a workspace that is full after two
    // colleagues.
    expect(seeded!.plan).toBe("growth");
    expect(seeded!.userCount).toBe(1);
  });

  it("GET /tenants/:id nests companies inside environments", async () => {
    const detail = await parsed(`/tenants/${tenant.tenantId}`, tenantDetailSchema);
    expect(detail.adminEmail).toBe(tenant.email);

    // The US-010 hierarchy survives the round trip rather than being flattened.
    expect(detail.environments.length).toBe(1);
    expect(detail.environments[0].companies.map((c) => c.name).sort()).toEqual([
      "Contract Holdings",
      "Contract Retail"
    ]);
    // Truthful rather than optimistic: no connection has been configured.
    expect(detail.environments[0].connection).toBe("not_configured");
  });

  it("GET /tenants/:id/activity returns entries the feed can render", async () => {
    const entries = await parsed(
      `/tenants/${tenant.tenantId}/activity`,
      z.array(activityEntrySchema)
    );
    expect(entries.length).toBeGreaterThan(0);

    // Severity is derived from the action, so the feed never has to guess.
    const provisioned = entries.find((entry) => entry.action === "invitation.issued");
    expect(provisioned?.severity).toBe("info");
  });

  it("PATCH /tenants/:id/status round-trips every transition", async () => {
    const patch = (status: string) =>
      parsed(`/tenants/${tenant.tenantId}/status`, tenantDetailSchema, {
        method: "PATCH",
        body: JSON.stringify({ status })
      });

    expect((await patch("suspended")).status).toBe("suspended");
    // Idempotent: asking again is a no-op rather than a second transition.
    expect((await patch("suspended")).status).toBe("suspended");
    expect((await patch("active")).status).toBe("active");
    expect((await patch("archived")).status).toBe("archived");
    // Restoring an archived tenant returns it to active, not to whatever it
    // was before — the screen offers "restore" and means it.
    expect((await patch("active")).status).toBe("active");
  });

  it("GET /users and GET /users/:id match their contracts", async () => {
    const page = await parsed("/users?page=1&pageSize=10", userPageSchema);
    expect(page.items.length).toBe(1);

    const summary = page.items[0];
    expect(summary.email).toBe(tenant.email);
    expect(summary.tenantSlug).toBe("contract-co");
    // `name` is never null in the response even though the column is nullable.
    expect(summary.name).toBe("admin");
    expect(summary.role).toBe("admin");

    const detail = await parsed(`/users/${tenant.userId}`, userDetailSchema);
    expect(detail.roles).toContain("admin");
    // Provisioning invited the first admin, so nobody invited them.
    expect(detail.invitedBy).toBeNull();
  });

  it("POST /users/invitations returns a redeemable invitation", async () => {
    const issued = await parsed("/users/invitations", issuedUserInvitationSchema, {
      method: "POST",
      body: JSON.stringify({ email: "new.person@contract-co.local", role: "viewer" })
    });

    expect(issued.user.status).toBe("invited");
    expect(issued.user.role).toBe("viewer");
    expect(issued.user.lastSeenAt).toBeNull();
    expect(issued.token.length).toBeGreaterThan(20);
    expect(Number.isNaN(Date.parse(issued.expiresAt))).toBe(false);
  });

  it("PATCH /users/:id/status refuses to activate an account with no password", async () => {
    const invited = await parsed("/users/invitations", issuedUserInvitationSchema, {
      method: "POST",
      body: JSON.stringify({ email: "no.password@contract-co.local", role: "viewer" })
    });

    const res = await fetch(
      `${api!.baseUrl}/users/${invited.user.id}/status`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${tenant.accessToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ status: "active" })
      }
    );

    // 400 with a reason, not a 500 from the check constraint: the operator can
    // act on this by reissuing the invitation.
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain("invitation");
  });

  it("PUT /users/:id/roles replaces the whole set", async () => {
    const before = await parsed(`/users/${tenant.userId}`, userDetailSchema);
    expect(before.roles).toEqual(["admin"]);

    const after = await parsed(`/users/${tenant.userId}/roles`, userDetailSchema, {
      method: "PUT",
      body: JSON.stringify({ roles: ["viewer"] })
    });
    expect(after.roles).toEqual(["viewer"]);

    // Put it back, so the ordering of these tests cannot strand the fixture
    // without the role its other assertions rely on.
    const restored = await parsed(`/users/${tenant.userId}/roles`, userDetailSchema, {
      method: "PUT",
      body: JSON.stringify({ roles: ["admin"] })
    });
    expect(restored.roles).toEqual(["admin"]);
  });

  it("GET /roles serves the catalogue the migration installs", async () => {
    const roles = await parsed("/roles", roleListSchema);
    expect(roles.map((role) => role.name).sort()).toEqual(["admin", "viewer"]);

    // Both are built in, so neither offers deletion.
    expect(roles.every((role) => role.builtIn)).toBe(true);
  });

  it("PUT /roles/:id/permissions grants the read implied by a write", async () => {
    const roles = await parsed("/roles", roleListSchema);
    const admin = roles.find((role) => role.name === "admin")!;

    const updated = await parsed(
      `/roles/${admin.id}/permissions`,
      roleSchema,
      {
        method: "PUT",
        body: JSON.stringify({ permissions: ["user.write", "audit.read"] })
      }
    );

    // `user.read` was not asked for. The API adds it because writing something
    // you cannot see is not a state the system models.
    expect(updated.permissions.sort()).toEqual([
      "audit.read",
      "user.read",
      "user.write"
    ]);
  });

  it("GET /activity pages the audit trail", async () => {
    const page = await parsed("/activity?page=1&pageSize=5", activityPageSchema);
    expect(page.pageSize).toBe(5);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.total).toBeGreaterThanOrEqual(page.items.length);

    // Newest first — a feed is read from the top.
    const times = page.items.map((entry) => Date.parse(entry.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("rejects a page size beyond the ceiling rather than materialising the table", async () => {
    // `pageSize` reaches a LIMIT clause. The schema clamps it via `catch`, so
    // an absurd request falls back to the default instead of being honoured.
    const page = await parsed("/users?page=1&pageSize=100000", userPageSchema);
    expect(page.pageSize).toBe(10);
  });
});
