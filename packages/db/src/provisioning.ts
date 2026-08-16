import type { Pool, PoolClient } from "pg";
import { recordAuditEntry, type AuditActor } from "./audit";
import { issueInvitation } from "./invitations";
import { isPlatformPermissionKey } from "./platform";

/** Roles every new tenant starts with. Matches the demo seed's conventions. */
export const DEFAULT_ROLES = ["admin", "viewer"] as const;

/**
 * What each default role may do, the moment the tenant exists.
 *
 * Provisioning used to create the two roles and grant them nothing, which made
 * them names attached to no authority — a freshly provisioned tenant opened its
 * permission matrix on a grid of unchecked boxes, and its admin held less than
 * the viewer role implies. The roles were decorative in exactly the way the
 * `role_permission` table was added to prevent.
 *
 * The rule is the one the demo seed already used: admin holds the whole
 * catalogue, viewer holds the read half. It is expressed against whatever the
 * `permission` table actually contains rather than a hard-coded key list, so a
 * permission added by a later migration is granted to admin automatically and
 * cannot be silently missed here.
 */
function permissionsForDefaultRole(role: string, catalogue: string[]): string[] {
  // `platform.*` is filtered out first, and this is not optional tidying. The
  // rule below hands `admin` the whole catalogue on purpose, so that a
  // permission added by a later migration is granted rather than silently
  // missed — which, once the platform tier existed, meant every incoming
  // tenant's administrator would be provisioned with cross-tenant reach. The
  // database refuses the grant outright (see the platform-administration
  // migration's trigger), so leaving this unfiltered would not leak anything;
  // it would make `POST /tenants` fail on every call.
  const tenantScoped = catalogue.filter((key) => !isPlatformPermissionKey(key));

  return role === "admin" ? tenantScoped : tenantScoped.filter((key) => key.endsWith(".read"));
}

/** The role the first admin user is assigned. */
export const DEFAULT_ADMIN_ROLE = "admin";

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";

/**
 * Raised when the tenant identifier is already taken. Carried as a typed error
 * so the API can answer 409 with something the caller can act on, rather than
 * leaking a driver message.
 */
export class TenantAlreadyExistsError extends Error {
  readonly slug: string;

  constructor(slug: string) {
    super(`A tenant with the identifier "${slug}" already exists. Choose a different slug.`);
    this.name = "TenantAlreadyExistsError";
    this.slug = slug;
  }
}

export interface ProvisionTenantInput {
  name: string;
  slug: string;
  /** Defaults to `admin@<slug>.local`. */
  adminEmail?: string;
}

export interface ProvisionTenantResult {
  tenant: { id: string; name: string; slug: string };
  adminUser: { id: string; email: string };
  roles: { id: string; name: string }[];
  /**
   * The first admin's invitation (US-020).
   *
   * Provisioning used to create an admin user with no credential, which meant a
   * freshly provisioned tenant had nobody who could ever sign in. The token is
   * returned exactly once here and stored only as a digest.
   */
  invitation: { id: string; expiresAt: Date; token: string };
}

/** The admin address used when the caller does not supply one. */
export function defaultAdminEmail(slug: string): string {
  return `admin@${slug}.local`;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === UNIQUE_VIOLATION
  );
}

/**
 * Provisioning on a caller-supplied client, which must already be in a
 * transaction.
 *
 * Exported so the API can run it inside the US-012 escape hatch: provisioning
 * genuinely cannot be tenant-scoped — the tenant does not exist yet — and going
 * through `withoutTenantScope` is what puts that bypass in the log instead of
 * leaving it as an unremarked use of the admin pool.
 */
export async function provisionTenantOnClient(
  client: PoolClient,
  input: ProvisionTenantInput,
  actor: AuditActor
): Promise<ProvisionTenantResult> {
  const email = input.adminEmail ?? defaultAdminEmail(input.slug);

  let tenant: { id: string; name: string; slug: string };
  try {
    const res = await client.query<{ id: string; name: string; slug: string }>(
      "INSERT INTO tenant (name, slug) VALUES ($1, $2) RETURNING id, name, slug",
      [input.name, input.slug]
    );
    tenant = res.rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new TenantAlreadyExistsError(input.slug);
    }
    throw err;
  }

  const roles: { id: string; name: string }[] = [];
  for (const name of DEFAULT_ROLES) {
    const res = await client.query<{ id: string; name: string }>(
      "INSERT INTO role (tenant_id, name) VALUES ($1, $2) RETURNING id, name",
      [tenant.id, name]
    );
    roles.push(res.rows[0]);
  }

  // The catalogue is installed by migration, so this is normally populated. An
  // empty result is not treated as an error: the roles still exist and the
  // permission matrix can grant them, which is a better outcome than refusing
  // to provision a tenant because a reference table is unexpectedly bare.
  const catalogue = await client.query<{ id: string; key: string }>(
    "SELECT id, key FROM permission ORDER BY key"
  );
  const keys = catalogue.rows.map((row) => row.key);
  const idByKey = new Map(catalogue.rows.map((row) => [row.key, row.id]));

  const grantedByRole: Record<string, string[]> = {};
  for (const role of roles) {
    const granted = permissionsForDefaultRole(role.name, keys);
    grantedByRole[role.name] = granted;

    for (const key of granted) {
      await client.query(
        `INSERT INTO role_permission (tenant_id, role_id, permission_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (role_id, permission_id) DO NOTHING`,
        [tenant.id, role.id, idByKey.get(key)]
      );
    }
  }

  // "user" is a reserved word, so it stays quoted.
  const userRes = await client.query<{ id: string; email: string }>(
    'INSERT INTO "user" (tenant_id, email) VALUES ($1, $2) RETURNING id, email',
    [tenant.id, email]
  );
  const adminUser = userRes.rows[0];

  const adminRole = roles.find((role) => role.name === DEFAULT_ADMIN_ROLE);
  if (!adminRole) {
    throw new Error(`DEFAULT_ROLES must contain "${DEFAULT_ADMIN_ROLE}"`);
  }
  await client.query(
    "INSERT INTO user_role (tenant_id, user_id, role_id) VALUES ($1, $2, $3)",
    [tenant.id, adminUser.id, adminRole.id]
  );

  // Two entries, because two different things happened: a tenant came into
  // existence, and someone was granted a permission.
  await recordAuditEntry(client, {
    tenantId: tenant.id,
    action: "tenant.provisioned",
    entityType: "tenant",
    entityId: tenant.id,
    actor: { ...actor, userId: actor.userId ?? adminUser.id },
    before: null,
    after: { name: tenant.name, slug: tenant.slug },
    // The grants are recorded as context on provisioning rather than as their
    // own `role.permissions_changed` entry: nobody changed anything, these are
    // the defaults the tenant came into existence with, and a separate entry
    // would read as an edit somebody made afterwards.
    context: { defaultRoles: [...DEFAULT_ROLES], defaultPermissions: grantedByRole }
  });

  await recordAuditEntry(client, {
    tenantId: tenant.id,
    action: "role.assigned",
    entityType: "user_role",
    entityId: adminUser.id,
    actor: { ...actor, userId: actor.userId ?? adminUser.id },
    before: null,
    after: { userEmail: adminUser.email, role: adminRole.name },
    context: { roleId: adminRole.id }
  });

  // The tenant is useless without this: the admin row exists but has no
  // credential, and there is no other way to obtain one.
  const invitation = await issueInvitation(client, {
    tenantId: tenant.id,
    email: adminUser.email,
    actor,
    invitedBy: null
  });

  return {
    tenant,
    adminUser,
    roles,
    invitation: { id: invitation.id, expiresAt: invitation.expiresAt, token: invitation.token }
  };
}

/**
 * Creates a tenant together with its default roles and first admin user.
 *
 * One transaction, deliberately: a tenant that exists with no admin user is
 * worse than a failed request, because nobody can sign in to repair it.
 *
 * Runs on the admin connection and so bypasses row level security — creating a
 * tenant cannot be scoped to that tenant. Once the API connects as `app_user`
 * this needs a separately privileged path.
 */
export async function provisionTenant(
  pool: Pool,
  input: ProvisionTenantInput,
  actor: AuditActor = { label: "system:provisioning" }
): Promise<ProvisionTenantResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await provisionTenantOnClient(client, input, actor);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
