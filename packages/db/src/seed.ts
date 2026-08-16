import type { Pool, PoolClient } from "pg";
import { ensurePlatformAdmin, findPlatformTenant } from "./platform";

/**
 * The demo platform administrator.
 *
 * A third account that belongs to no customer tenant: it exists so the
 * cross-tenant screens have somebody to sign in as during development, and so
 * the platform tests have a fixture that was built the same way a real one is.
 *
 * Like every other demo user it is seeded with no password. `pnpm platform-admin`
 * is what mints a usable credential — a seed that shipped a working operator
 * login would be a published credential for the highest-privilege account in
 * the system.
 */
export const DEMO_PLATFORM_ADMIN = { email: "operator@growpath.test", name: "Platform Operator" };

export interface DemoUser {
  email: string;
  /** Role names, which must appear in the owning tenant's `roles`. */
  roles: string[];
}

/**
 * Permissions granted to each demo role, derived rather than listed.
 *
 * `admin` holds the whole catalogue; `viewer` holds only the read half. Derived
 * so that adding a permission to DEMO_PERMISSIONS cannot leave the demo roles
 * quietly out of date.
 */
export function permissionsForRole(role: string): string[] {
  const all = DEMO_PERMISSIONS.map((p) => p.key);
  return role === "admin" ? all : all.filter((key) => key.endsWith(".read"));
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

/**
 * A demo tenant's mobile runtime configuration (US-040).
 *
 * Seeded because `tenant_mobile_config` is a tenant-scoped table, and the US-011
 * suite refuses to assert isolation on a table holding no rows — an RLS check
 * against an empty table passes vacuously, which is the one way that suite could
 * be wrong without failing.
 *
 * The values are visibly fake. A demo seed carrying a plausible-looking Entra
 * client id is a demo seed somebody copies into a real tenant.
 */
export interface DemoMobileConfig {
  apiBaseUrl: string;
  userAuth: {
    clientId: string;
    authority: string;
    redirectUri: string;
    scopes: string[];
  } | null;
  minimumAppVersion: string | null;
}

export interface DemoTenant {
  slug: string;
  name: string;
  environment: { name: string; url: string };
  mobile: DemoMobileConfig;
  /**
   * Module entitlements (US-072).
   *
   * Seeded for the same reason the mobile config is: `tenant_module` is a
   * tenant-scoped table, and the US-011 suite refuses to assert isolation on a
   * table holding no rows — an RLS check against an empty table passes
   * vacuously, which is the one way that suite could be wrong without failing.
   *
   * The two tenants deliberately hold *different* sets, so a query that ignored
   * the tenant boundary would return a set neither of them has.
   */
  modules: string[];
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
    /** Still on Entra sign-in, so both rollout states appear in the demo data. */
    mobile: {
      apiBaseUrl: "https://acme.api.growpath.invalid",
      userAuth: {
        clientId: "00000000-0000-4000-8000-00000000ac11",
        authority: "https://login.microsoftonline.com/00000000-0000-4000-8000-00000000acd1",
        redirectUri: "/auth/login",
        scopes: ["openid", "profile", "email", "User.Read"]
      },
      minimumAppVersion: "2.0.0"
    },
    /** On an enterprise plan, so everything except field service. */
    modules: ["van-sales", "warehouse", "analytics"],
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
    /** Past cutover: portal-native sign-in only, so `userAuth` is genuinely null. */
    mobile: {
      apiBaseUrl: "https://globex.api.growpath.invalid",
      userAuth: null,
      minimumAppVersion: null
    },
    /** A smaller set, and intentionally not a subset of Acme's. */
    modules: ["warehouse", "field-service"],
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
  /** Mobile runtime configurations (US-040) — one per tenant. */
  mobileConfigs: number;
  /** Module entitlements (US-072) — several per tenant. */
  tenantModules: number;
  companies: number;
  roles: number;
  users: number;
  auditEntries: number;
  rolePermissions: number;
  invitations: number;
  refreshTokens: number;
  authEvents: number;
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

  const catalogue = await client.query<{ id: string; key: string }>(
    "SELECT id, key FROM permission"
  );
  const permissionIds = new Map(catalogue.rows.map((row) => [row.key, row.id]));

  const summary: SeedSummary = {
    tenants: 0,
    permissions: DEMO_PERMISSIONS.length,
    environments: 0,
    mobileConfigs: 0,
    tenantModules: 0,
    companies: 0,
    roles: 0,
    users: 0,
    auditEntries: 0,
    rolePermissions: 0,
    invitations: 0,
    refreshTokens: 0,
    authEvents: 0
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

    // Mobile runtime configuration (US-040). Upserted on the tenant, which is
    // unique, so re-running the seed replaces rather than duplicates.
    await client.query(
      `INSERT INTO tenant_mobile_config (
         tenant_id, api_base_url,
         user_auth_client_id, user_auth_authority, user_auth_redirect_uri, user_auth_scopes,
         minimum_app_version
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id) DO UPDATE SET
         api_base_url = EXCLUDED.api_base_url,
         user_auth_client_id = EXCLUDED.user_auth_client_id,
         user_auth_authority = EXCLUDED.user_auth_authority,
         user_auth_redirect_uri = EXCLUDED.user_auth_redirect_uri,
         user_auth_scopes = EXCLUDED.user_auth_scopes,
         minimum_app_version = EXCLUDED.minimum_app_version,
         updated_at = now()`,
      [
        tenantId,
        tenant.mobile.apiBaseUrl,
        tenant.mobile.userAuth?.clientId ?? null,
        tenant.mobile.userAuth?.authority ?? null,
        tenant.mobile.userAuth?.redirectUri ?? null,
        tenant.mobile.userAuth?.scopes ?? [],
        tenant.mobile.minimumAppVersion
      ]
    );
    summary.mobileConfigs += 1;

    // Module entitlements (US-072). Keyed on the catalogue rather than on ids,
    // so a key the migration has not installed is skipped instead of failing
    // the whole seed — the same tolerance `setTenantModules` shows.
    for (const moduleKey of tenant.modules) {
      const inserted = await client.query(
        `INSERT INTO tenant_module (tenant_id, module_id)
         SELECT $1, m.id FROM module m WHERE m.key = $2
         ON CONFLICT (tenant_id, module_id) DO NOTHING`,
        [tenantId, moduleKey]
      );
      summary.tenantModules += inserted.rowCount ?? 0;
    }

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

      // Roles carried a name and no authority until S3 added role_permission.
      for (const key of permissionsForRole(role)) {
        const permissionId = permissionIds.get(key);
        if (!permissionId) {
          throw new Error(`demo data error: unknown permission "${key}"`);
        }
        await client.query(
          `INSERT INTO role_permission (tenant_id, role_id, permission_id) VALUES ($1, $2, $3)
           ON CONFLICT (role_id, permission_id) DO NOTHING`,
          [tenantId, roleId, permissionId]
        );
        summary.rolePermissions += 1;
      }
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

      // Demo users carry no password: hashing arrives with US-021, and the
      // schema forbids an 'active' user with no credential. So each one holds
      // a pending invitation, which is the real state of a freshly seeded
      // tenant rather than a convenient fiction.
      await client.query(
        `INSERT INTO user_invitation (tenant_id, user_id, token_hash, expires_at)
         SELECT $1, $2, $3, now() + interval '7 days'
         WHERE NOT EXISTS (SELECT 1 FROM user_invitation WHERE user_id = $2)`,
        // A digest of a token that was never issued: the column must never hold
        // anything a caller could present, seeded or not.
        [tenantId, userId, `seed:${tenant.slug}:${user.email}`]
      );
      summary.invitations += 1;

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

    const firstUserId = userIds.get(tenant.users[0].email)!;

    /**
     * One spent refresh token per tenant.
     *
     * Revoked and expired, because a seeded *usable* session token would be a
     * working credential shipped in demo data. It exists so the isolation suite
     * covers refresh_token before US-023 starts creating real ones — an
     * unpopulated table makes those assertions pass vacuously.
     */
    await client.query(
      `INSERT INTO refresh_token
         (tenant_id, user_id, family_id, token_hash, expires_at, revoked_at, revoked_reason)
       SELECT $1, $2, gen_random_uuid(), $3, now() - interval '1 day',
              now() - interval '1 day', 'seed: historical session'
       WHERE NOT EXISTS (SELECT 1 FROM refresh_token WHERE tenant_id = $1)`,
      [tenantId, firstUserId, `seed:${tenant.slug}:refresh`]
    );
    summary.refreshTokens += 1;

    await client.query(
      `INSERT INTO auth_event
         (tenant_id, user_id, claimed_slug, claimed_email, event, outcome, reason)
       SELECT $1, $2, $3, $4, 'login.succeeded', 'succeeded', 'seeded'
       WHERE NOT EXISTS (SELECT 1 FROM auth_event WHERE tenant_id = $1)`,
      [tenantId, firstUserId, tenant.slug, tenant.users[0].email]
    );
    summary.authEvents += 1;
  }

  /**
   * The platform operator.
   *
   * Seeded only when the platform tenant exists, which it does from the
   * platform-administration migration onward. Guarded rather than assumed
   * because the seed is also run against databases mid-migration in
   * development, and a seed that fails on a missing table is a seed nobody can
   * use to diagnose the missing table.
   *
   * The invitation it issues is discarded here on purpose: a token printed by
   * `pnpm seed` would sit in a terminal scrollback and a CI log as a live
   * credential for the account that can see every tenant. Development runs
   * `pnpm platform-admin` to get one that is meant to be used.
   */
  const platformTenant = await findPlatformTenant(client);
  if (platformTenant) {
    // Guarded on the user row rather than left to `ensurePlatformAdmin`, which
    // reissues an invitation to an account that has not accepted one yet. That
    // is right for the CLI — reissuing is what you run it for — and wrong for a
    // seed that is re-run on every `pnpm bootstrap`, where it would leave a pile
    // of live invitations behind it.
    const existing = await client.query(
      `SELECT 1 FROM "user" WHERE tenant_id = $1 AND lower(email) = lower($2)`,
      [platformTenant.id, DEMO_PLATFORM_ADMIN.email]
    );

    if (existing.rowCount === 0) {
      await ensurePlatformAdmin(client, {
        email: DEMO_PLATFORM_ADMIN.email,
        name: DEMO_PLATFORM_ADMIN.name,
        actor: { label: "system:seed" }
      });
    }
    summary.users += 1;
  }

  /**
   * A failed sign-in that belongs to no tenant.
   *
   * This is the row the whole nullable-tenant design exists for: someone tried
   * an address that matches nothing, and that attempt is exactly what a
   * security review asks about. It could not be written to audit_log at all.
   */
  await client.query(
    `INSERT INTO auth_event (claimed_slug, claimed_email, event, outcome, reason)
     SELECT 'unknown-tenant', 'nobody@example.test', 'login.failed', 'failed', 'no such tenant'
     WHERE NOT EXISTS (SELECT 1 FROM auth_event WHERE tenant_id IS NULL)`
  );
  summary.authEvents += 1;

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
