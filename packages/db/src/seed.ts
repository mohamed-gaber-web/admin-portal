import type { Pool, PoolClient } from "pg";

export interface DemoUser {
  email: string;
  /** Role names, which must appear in the owning tenant's `roles`. */
  roles: string[];
}

export interface DemoAuditEntry {
  action: string;
  entityType: string;
  /** Email of the acting user; must appear in the tenant's `users`. */
  actorEmail: string;
}

export interface DemoCompany {
  name: string;
  /** D365 legal-entity identifier, unique within its environment. */
  dataAreaId: string;
}

export interface DemoTenant {
  slug: string;
  name: string;
  environment: { name: string; url: string };
  companies: DemoCompany[];
  roles: string[];
  users: DemoUser[];
  auditLog: DemoAuditEntry[];
}

/** Global permission catalogue — not tenant-scoped. */
export const DEMO_PERMISSIONS: { key: string; description: string }[] = [
  { key: "tenant.read", description: "View tenant settings" },
  { key: "tenant.write", description: "Change tenant settings" },
  { key: "user.read", description: "View users" },
  { key: "user.write", description: "Invite and modify users" },
  { key: "connection.read", description: "View D365 connections" },
  { key: "connection.write", description: "Manage D365 connections" },
  { key: "audit.read", description: "Read the audit log" }
];

/**
 * Two tenants, deliberately — not one. Every tenant-isolation test from
 * Sprint 2 onward needs a second tenant to prove a query cannot reach across
 * the boundary; a single-tenant seed makes those tests vacuously pass.
 */
export const DEMO_TENANTS: DemoTenant[] = [
  {
    slug: "acme",
    name: "Acme Corp",
    environment: { name: "Acme Production", url: "https://acme.crm4.dynamics.com" },
    companies: [
      { name: "Acme Manufacturing", dataAreaId: "acmf" },
      { name: "Acme Logistics", dataAreaId: "acml" }
    ],
    roles: ["admin", "viewer"],
    users: [
      { email: "owner@acme.test", roles: ["admin"] },
      { email: "analyst@acme.test", roles: ["viewer"] },
      { email: "ops@acme.test", roles: ["viewer"] }
    ],
    auditLog: [
      { action: "tenant.created", entityType: "tenant", actorEmail: "owner@acme.test" },
      { action: "user.invited", entityType: "user", actorEmail: "owner@acme.test" }
    ]
  },
  {
    slug: "globex",
    name: "Globex Corporation",
    environment: { name: "Globex Production", url: "https://globex.crm11.dynamics.com" },
    companies: [
      { name: "Globex Retail", dataAreaId: "glbr" },
      { name: "Globex Wholesale", dataAreaId: "glbw" }
    ],
    roles: ["admin", "viewer"],
    users: [
      { email: "owner@globex.test", roles: ["admin"] },
      { email: "analyst@globex.test", roles: ["viewer"] },
      { email: "ops@globex.test", roles: ["viewer"] }
    ],
    auditLog: [
      { action: "tenant.created", entityType: "tenant", actorEmail: "owner@globex.test" },
      { action: "connection.created", entityType: "d365_environment", actorEmail: "owner@globex.test" }
    ]
  }
];

export interface SeedSummary {
  tenants: number;
  permissions: number;
  environments: number;
  companies: number;
  roles: number;
  users: number;
  auditEntries: number;
}

/** Runs a statement expected to RETURN one id, and returns that id. */
async function insertReturningId(
  client: PoolClient,
  sql: string,
  params: unknown[]
): Promise<string> {
  const res = await client.query<{ id: string }>(sql, params);
  const row = res.rows[0];
  if (!row) {
    throw new Error(`expected a returned row from: ${sql.trim().split("\n")[0]}`);
  }
  return row.id;
}

/** Runs a SELECT expected to match exactly one row, and returns its id. */
async function selectId(client: PoolClient, sql: string, params: unknown[]): Promise<string> {
  const res = await client.query<{ id: string }>(sql, params);
  const row = res.rows[0];
  if (!row) {
    throw new Error(`expected a row from: ${sql.trim().split("\n")[0]}`);
  }
  return row.id;
}

async function seedWithClient(client: PoolClient): Promise<SeedSummary> {
  for (const permission of DEMO_PERMISSIONS) {
    await client.query(
      `INSERT INTO permission (key, description) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description`,
      [permission.key, permission.description]
    );
  }

  const summary: SeedSummary = {
    tenants: 0,
    permissions: DEMO_PERMISSIONS.length,
    environments: 0,
    companies: 0,
    roles: 0,
    users: 0,
    auditEntries: 0
  };

  for (const tenant of DEMO_TENANTS) {
    const tenantId = await insertReturningId(
      client,
      `INSERT INTO tenant (name, slug) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [tenant.name, tenant.slug]
    );
    summary.tenants += 1;

    // d365_environment, company and audit_log have no natural unique key, so
    // guard them with NOT EXISTS rather than widening the US-002 schema.
    await client.query(
      `INSERT INTO d365_environment (tenant_id, name, url)
       SELECT $1, $2, $3
       WHERE NOT EXISTS (
         SELECT 1 FROM d365_environment WHERE tenant_id = $1 AND name = $2
       )`,
      [tenantId, tenant.environment.name, tenant.environment.url]
    );
    summary.environments += 1;

    // Companies hang off the environment, not the tenant directly (US-010).
    const environmentId = await selectId(
      client,
      "SELECT id FROM d365_environment WHERE tenant_id = $1 AND name = $2",
      [tenantId, tenant.environment.name]
    );

    for (const company of tenant.companies) {
      await client.query(
        `INSERT INTO company (tenant_id, environment_id, name, data_area_id)
         SELECT $1, $2, $3, $4
         WHERE NOT EXISTS (SELECT 1 FROM company WHERE tenant_id = $1 AND name = $3)`,
        [tenantId, environmentId, company.name, company.dataAreaId]
      );
      summary.companies += 1;
    }

    const roleIds = new Map<string, string>();
    for (const role of tenant.roles) {
      const roleId = await insertReturningId(
        client,
        `INSERT INTO role (tenant_id, name) VALUES ($1, $2)
         ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [tenantId, role]
      );
      roleIds.set(role, roleId);
      summary.roles += 1;
    }

    const userIds = new Map<string, string>();
    for (const user of tenant.users) {
      // "user" is a reserved word, so it stays quoted everywhere.
      const userId = await insertReturningId(
        client,
        `INSERT INTO "user" (tenant_id, email) VALUES ($1, $2)
         ON CONFLICT (tenant_id, email) DO UPDATE SET email = EXCLUDED.email
         RETURNING id`,
        [tenantId, user.email]
      );
      userIds.set(user.email, userId);
      summary.users += 1;

      for (const role of user.roles) {
        const roleId = roleIds.get(role);
        if (!roleId) {
          throw new Error(
            `demo data error: ${tenant.slug} user ${user.email} references unknown role "${role}"`
          );
        }
        await client.query(
          `INSERT INTO user_role (tenant_id, user_id, role_id) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, role_id) DO NOTHING`,
          [tenantId, userId, roleId]
        );
      }
    }

    for (const entry of tenant.auditLog) {
      const actorId = userIds.get(entry.actorEmail);
      if (!actorId) {
        throw new Error(
          `demo data error: ${tenant.slug} audit entry "${entry.action}" references unknown user "${entry.actorEmail}"`
        );
      }
      await client.query(
        `INSERT INTO audit_log (tenant_id, user_id, actor_label, action, entity_type, data)
         SELECT $1, $2, 'system:seed', $3, $4, $5::jsonb
         WHERE NOT EXISTS (
           SELECT 1 FROM audit_log
           WHERE tenant_id = $1 AND action = $3 AND entity_type = $4
         )`,
        [tenantId, actorId, entry.action, entry.entityType, JSON.stringify({ seeded: true })]
      );
      summary.auditEntries += 1;
    }
  }

  return summary;
}

/**
 * Seeds the demo tenants and their sample data.
 *
 * Idempotent: re-running never duplicates a row, so it is safe to call on every
 * `pnpm setup`. Runs in one transaction — a partial seed would be worse than no
 * seed, because the gaps are invisible until a test fails oddly.
 */
export async function seedDemoData(pool: Pool): Promise<SeedSummary> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const summary = await seedWithClient(client);
    await client.query("COMMIT");
    return summary;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
