import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import migrate from "node-pg-migrate";
import { join } from "node:path";
import { repoRoot } from "./helpers";
import { createThrowawayDatabase, type ThrowawayDatabase } from "./pg-helpers";
import { startApi, type RunningApi } from "./api-server";
import { provisionedTenantSchema } from "../packages/contracts/src/schemas/tenant";
import { DEFAULT_ROLES, DEFAULT_ADMIN_ROLE } from "../packages/db/src/provisioning";
import { seedPlatformAdmin, type PlatformAdminFixture } from "./tenant-fixtures";

const MIGRATIONS_DIR = join(repoRoot, "packages/db/migrations");

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  // Don't silently skip coverage.
  console.warn(
    "[US-014] DATABASE_URL not set — the tenant provisioning tests are SKIPPED. Set DATABASE_URL to a Postgres admin connection to run them."
  );
}

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

describe.skipIf(!hasDb)("US-014 - tenant provisioning API", () => {
  const PORT = 34712;
  const JWT_SECRET = "us014-suite-signing-key-at-least-32-characters";
  let db: ThrowawayDatabase | undefined;
  let api: RunningApi | undefined;
  let baseUrl: string;
  let operator: PlatformAdminFixture;

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
    api = await startApi(PORT, { DATABASE_URL: db.url, AUTH_JWT_SECRET: JWT_SECRET });
    baseUrl = api.baseUrl;

    // `POST /tenants` requires a platform administrator: an unauthenticated
    // endpoint that mints tenants is one anybody reaching the port may use, and
    // any tenant administrator could use it too. The fixture is built through
    // the real bootstrap path rather than by forging a token.
    operator = await withClient(db.url, (client) => seedPlatformAdmin(client, baseUrl));
  });

  afterAll(async () => {
    api?.stop();
    await db?.drop();
    db = undefined;
  });

  const post = (body: unknown): Promise<Response> =>
    fetch(`${baseUrl}/tenants`, {
      method: "POST",
      headers: { "content-type": "application/json", ...operator.headers },
      body: JSON.stringify(body)
    });

  // AC1: Given valid input, when a tenant is created, then a default admin user
  // and default roles are created with it.
  it("AC1: creating a tenant also creates default roles and an admin user", async () => {
    const res = await post({ name: "Initech", slug: "initech" });
    expect(res.status).toBe(201);

    const body = await res.json();
    const parsed = provisionedTenantSchema.safeParse(body);
    expect(parsed.success, `response did not match the shared schema: ${JSON.stringify(body)}`).toBe(
      true
    );
    if (!parsed.success) return;

    expect(parsed.data.tenant.slug).toBe("initech");
    // No adminEmail supplied, so provisioning derives one.
    expect(parsed.data.adminUser.email).toBe("admin@initech.local");
    expect(parsed.data.roles.map((r) => r.name).sort()).toEqual([...DEFAULT_ROLES].sort());

    // The response could lie; check the database itself.
    await withClient(db!.url, async (client) => {
      const tenant = await client.query<{ id: string }>("SELECT id FROM tenant WHERE slug = $1", [
        "initech"
      ]);
      expect(tenant.rowCount).toBe(1);
      const tenantId = tenant.rows[0].id;

      const roles = await client.query<{ id: string; name: string }>(
        "SELECT id, name FROM role WHERE tenant_id = $1 ORDER BY name",
        [tenantId]
      );
      expect(roles.rows.map((r) => r.name)).toEqual([...DEFAULT_ROLES].sort());

      const users = await client.query<{ id: string; email: string }>(
        'SELECT id, email FROM "user" WHERE tenant_id = $1',
        [tenantId]
      );
      expect(users.rowCount).toBe(1);
      expect(users.rows[0].email).toBe("admin@initech.local");

      // The admin user actually holds the admin role.
      const assignment = await client.query<{ role_name: string }>(
        `SELECT r.name AS role_name
         FROM user_role ur
         JOIN role r ON r.id = ur.role_id
         WHERE ur.tenant_id = $1 AND ur.user_id = $2`,
        [tenantId, users.rows[0].id]
      );
      expect(assignment.rows.map((r) => r.role_name)).toEqual([DEFAULT_ADMIN_ROLE]);
    });
  });

  /**
     * The roles carry authority, not just names.
     *
     * This is the assertion whose absence let provisioning ship creating two
     * roles and granting them nothing. Everything above passed — the roles
     * existed, the admin held one — while a freshly provisioned tenant opened
     * its permission matrix on a grid of unchecked boxes and its admin could be
     * granted less than a viewer implies. "The row exists" and "the row means
     * something" are different claims, and only the first was being made.
     */
    it("AC1: the default roles are granted their permissions", async () => {
    // Provisioned by the test above; this asserts on the same tenant rather
    // than creating a second one, so it is checking what that flow produced.
    await withClient(db!.url, async (client) => {
      {
        const tenantId = (
          await client.query<{ id: string }>("SELECT id FROM tenant WHERE slug = $1", [
            "initech"
          ])
        ).rows[0].id;

        /**
         * Compared against the catalogue as it actually stands rather than a
         * hard-coded list, so a permission added by a later migration has to be
         * granted to admin rather than quietly skipped here.
         *
         * `platform.*` is the one documented exception, and it is excluded in
         * the query rather than in the expectation so that the rule reads the
         * same way here as it does in `permissionsForDefaultRole`: these keys
         * reach across tenants, and an incoming tenant's administrator holding
         * them would be the escalation the whole tier is fenced against. The
         * database refuses the grant outright, so this asserts a behaviour that
         * cannot silently regress — only fail loudly.
         */
        const catalogue = (
          await client.query<{ key: string }>(
            "SELECT key FROM permission WHERE key NOT LIKE 'platform.%' ORDER BY key"
          )
        ).rows.map((row) => row.key);
        expect(catalogue.length).toBeGreaterThan(0);

        const granted = await client.query<{ role: string; key: string }>(
          `SELECT r.name AS role, p.key
             FROM role r
             JOIN role_permission rp ON rp.role_id = r.id
             JOIN permission p ON p.id = rp.permission_id
            WHERE r.tenant_id = $1
            ORDER BY r.name, p.key`,
          [tenantId]
        );

        const byRole = (name: string) =>
          granted.rows.filter((row) => row.role === name).map((row) => row.key);

        // Admin holds everything; viewer holds the read half. The same rule the
        // demo seed uses, now applied to real provisioning.
        expect(byRole("admin")).toEqual(catalogue);
        expect(byRole("viewer")).toEqual(catalogue.filter((key) => key.endsWith(".read")));
        expect(byRole("viewer").length).toBeGreaterThan(0);
      }
    });
  });

  // AC2: Given a duplicate tenant identifier, when submitted, then the request
  // is rejected with a clear error.
  it("AC2: a duplicate tenant identifier is rejected with a clear error", async () => {
    const first = await post({ name: "Umbrella", slug: "umbrella" });
    expect(first.status).toBe(201);

    const duplicate = await post({ name: "Umbrella Again", slug: "umbrella" });
    expect(duplicate.status).toBe(409);

    const body = (await duplicate.json()) as { message?: { message?: string; slug?: string } };
    const message = JSON.stringify(body);
    // Clear means: it names what clashed and what to do, not a driver error.
    expect(message).toContain("umbrella");
    expect(message).toMatch(/already exists/i);
    expect(message).not.toMatch(/duplicate key value|23505|violates unique constraint/i);

    // The failed attempt left nothing behind — the transaction rolled back
    // rather than creating orphaned roles or users.
    await withClient(db!.url, async (client) => {
      const tenants = await client.query<{ id: string; name: string }>(
        "SELECT id, name FROM tenant WHERE slug = $1",
        ["umbrella"]
      );
      expect(tenants.rowCount).toBe(1);
      expect(tenants.rows[0].name).toBe("Umbrella");

      const roles = await client.query("SELECT id FROM role WHERE tenant_id = $1", [
        tenants.rows[0].id
      ]);
      expect(roles.rowCount).toBe(DEFAULT_ROLES.length);

      const users = await client.query('SELECT id FROM "user" WHERE tenant_id = $1', [
        tenants.rows[0].id
      ]);
      expect(users.rowCount).toBe(1);
    });
  });
});
