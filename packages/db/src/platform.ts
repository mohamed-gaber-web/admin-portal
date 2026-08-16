import { issueInvitation, type IssuedInvitation } from "./invitations";
import { recordAuditEntry, type AuditActor } from "./audit";
import type { Queryable } from "./tenancy";

/**
 * The platform administration tier.
 *
 * A platform administrator is an ordinary user row in a reserved tenant, marked
 * by `tenant.is_platform`. Nothing about the tenant model bends for it: the user
 * still belongs to exactly one tenant, sign-in still supplies a slug, and the
 * access token still carries one `tenantId`. What differs is the permissions
 * that user's role holds, and the fact that the API runs `platform.*` routes
 * through `withoutTenantScope` instead of `withRequestTenantScope`.
 *
 * Everything here reads or writes across tenants and therefore must run
 * unscoped. None of it is reachable from a tenant-scoped session — inside one,
 * the platform tenant's rows are invisible to row level security like any
 * other tenant's.
 */

/**
 * Mirrors of the same constants in `@growpath/contracts`.
 *
 * Duplicated rather than imported, as `MIN_PASSWORD_LENGTH` already is: this
 * package does not depend on the contracts package, and adding that dependency
 * to share two strings would invert the layering — contracts describes the HTTP
 * surface, and this sits behind it. A contract test asserts the two agree.
 */
export const PLATFORM_TENANT_SLUG = "platform";
export const PLATFORM_ADMIN_ROLE = "platform-admin";

/** Prefix that marks a permission as reaching across tenants. */
export const PLATFORM_PERMISSION_PREFIX = "platform.";

export function isPlatformPermissionKey(key: string): boolean {
  return key.startsWith(PLATFORM_PERMISSION_PREFIX);
}

export interface PlatformTenant {
  id: string;
  name: string;
  slug: string;
}

/**
 * Raised when the reserved tenant is absent.
 *
 * It is created by migration, so this means the database is behind the code
 * rather than that the caller did something wrong — and it is worth saying so
 * plainly, because the symptom otherwise is "nobody can create a tenant" with
 * no obvious cause.
 */
export class PlatformTenantMissingError extends Error {
  constructor() {
    super(
      "No platform tenant exists. Run the migrations — it is created by the platform-administration migration, not by the seed."
    );
    this.name = "PlatformTenantMissingError";
  }
}

/**
 * The reserved tenant, found by its flag rather than its slug.
 *
 * A slug is a name someone could rename; the flag is the fact. The slug is only
 * how a person types it into the sign-in form.
 */
export async function findPlatformTenant(db: Queryable): Promise<PlatformTenant | null> {
  const res = await db.query<PlatformTenant>(
    `SELECT id, name, slug FROM tenant WHERE is_platform LIMIT 1`
  );
  return res.rows[0] ?? null;
}

/**
 * Whether a tenant id is the platform tenant.
 *
 * The API asks this about the *caller's own* tenant, taken from a signed token
 * claim, on every platform request. It is the second of the two gates guarding
 * this tier: holding `platform.tenant.read` is not enough, you must also be
 * inside the tenant that is allowed to hold it.
 */
export async function isPlatformTenant(db: Queryable, tenantId: string): Promise<boolean> {
  const res = await db.query<{ is_platform: boolean }>(
    `SELECT is_platform FROM tenant WHERE id = $1`,
    [tenantId]
  );
  return res.rows[0]?.is_platform === true;
}

export interface EnsurePlatformAdminResult {
  tenant: PlatformTenant;
  userId: string;
  /** Null when the account already has a password and was left alone. */
  invitation: IssuedInvitation | null;
  /** True when this call created the user row rather than finding it. */
  created: boolean;
}

/**
 * Makes sure an address exists as a platform administrator, and issues it an
 * invitation so somebody can actually sign in as it.
 *
 * This is the bootstrap path. `POST /tenants` requires a platform administrator,
 * so an installation with no such account is an installation where no tenant can
 * ever be created — and the migration deliberately does not create one, because
 * a user with a credential baked into a migration is a password published in the
 * repository, identical everywhere and impossible to rotate out of history.
 *
 * Idempotent in the way that matters: re-running it for an account that already
 * has a password does not reissue anything and does not disturb the account. It
 * returns `invitation: null` instead, so the caller can say "this already
 * exists, use password reset" rather than silently doing nothing.
 */
export async function ensurePlatformAdmin(
  db: Queryable,
  input: { email: string; name?: string; actor?: AuditActor }
): Promise<EnsurePlatformAdminResult> {
  const tenant = await findPlatformTenant(db);
  if (!tenant) {
    throw new PlatformTenantMissingError();
  }

  const email = input.email.trim();
  const actor = input.actor ?? { label: "system:platform-admin-cli" };

  const existing = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM "user" WHERE tenant_id = $1 AND lower(email) = lower($2)`,
    [tenant.id, email]
  );

  if (existing.rows[0]?.status === "active") {
    // Already usable. Reissuing an invitation here would be an account takeover
    // dressed as a bootstrap command — anyone who can run the CLI could mint a
    // fresh credential for an operator who already has one.
    return { tenant, userId: existing.rows[0].id, invitation: null, created: false };
  }

  // Created by migration. Re-created here only if somebody removed it, because
  // an invitation into a tenant with no platform role grants nothing and the
  // failure would show up much later as "signed in, but sees nothing".
  const role = await db.query<{ id: string }>(
    `INSERT INTO role (tenant_id, name) VALUES ($1, $2)
     ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [tenant.id, PLATFORM_ADMIN_ROLE]
  );
  const roleId = role.rows[0].id;

  await grantPlatformRolePermissions(db, tenant.id, roleId);

  const invitation = await issueInvitation(db, {
    tenantId: tenant.id,
    email,
    actor,
    invitedBy: null
  });

  if (input.name) {
    await db.query(`UPDATE "user" SET name = $2, updated_at = now() WHERE id = $1`, [
      invitation.userId,
      input.name
    ]);
  }

  const assigned = await db.query<{ id: string }>(
    `INSERT INTO user_role (tenant_id, user_id, role_id) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, role_id) DO NOTHING
     RETURNING id`,
    [tenant.id, invitation.userId, roleId]
  );

  // Only when the grant actually happened. A re-run that changes nothing should
  // not add a line to the log claiming somebody was given the platform role
  // again — the log is read to answer "who was given this, and when".
  if (assigned.rows[0]) {
    await recordAuditEntry(db, {
      tenantId: tenant.id,
      action: "role.assigned",
      entityType: "user_role",
      entityId: invitation.userId,
      actor,
      before: null,
      after: { userEmail: email, role: PLATFORM_ADMIN_ROLE }
    });
  }

  return {
    tenant,
    userId: invitation.userId,
    invitation,
    created: !existing.rows[0]
  };
}

export interface PlatformAdminRecord {
  id: string;
  email: string;
  name: string | null;
  status: string;
  lastLoginAt: Date | null;
  createdAt: Date;
}

/**
 * Everybody holding the platform role.
 *
 * Keyed on the role rather than on the tenant. Those are almost the same set,
 * and the difference is the point: a user row in the platform tenant who was
 * never given the role holds no `platform.*` permission and is not an operator,
 * so listing them here would overstate who can reach every tenant. The question
 * this screen answers is "who can act across the installation", and the role is
 * what actually decides that.
 */
export async function listPlatformAdmins(db: Queryable): Promise<PlatformAdminRecord[]> {
  const res = await db.query<{
    id: string;
    email: string;
    name: string | null;
    status: string;
    last_login_at: Date | null;
    created_at: Date;
  }>(
    `SELECT u.id, u.email, u.name, u.status, u.last_login_at, u.created_at
       FROM "user" u
       JOIN user_role ur ON ur.user_id = u.id
       JOIN role r ON r.id = ur.role_id
       JOIN tenant t ON t.id = r.tenant_id
      WHERE t.is_platform AND r.name = $1
      ORDER BY u.email`,
    [PLATFORM_ADMIN_ROLE]
  );

  return res.rows.map((row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at
  }));
}

export interface CatalogPermissionRecord {
  key: string;
  description: string;
  roleCount: number;
}

/**
 * The whole permission catalogue, with how many roles hold each key.
 *
 * Counted across every tenant, which is why this is a platform read and could
 * not sit on the tenant-scoped roles screen: the useful answer to "is anybody
 * using this permission" spans the installation, and inside a tenant session row
 * level security would reduce it to one customer's roles.
 */
export async function listPermissionCatalogue(
  db: Queryable
): Promise<CatalogPermissionRecord[]> {
  const res = await db.query<{ key: string; description: string; role_count: string }>(
    `SELECT p.key, p.description,
            (SELECT count(*) FROM role_permission rp WHERE rp.permission_id = p.id) AS role_count
       FROM permission p
      ORDER BY p.key`
  );

  return res.rows.map((row) => ({
    key: row.key,
    description: row.description,
    roleCount: Number(row.role_count)
  }));
}

/**
 * Grants the platform role its permissions, matching the migration's rule.
 *
 * Expressed against whatever `permission` actually contains rather than a
 * hard-coded key list, for the same reason provisioning is: a `platform.*` key
 * added by a later migration is granted automatically instead of being silently
 * missed here. The database's own trigger refuses these keys on any role outside
 * this tenant, so the pattern cannot leak reach to anyone else.
 */
async function grantPlatformRolePermissions(
  db: Queryable,
  tenantId: string,
  roleId: string
): Promise<void> {
  await db.query(
    `INSERT INTO role_permission (tenant_id, role_id, permission_id)
     SELECT $1, $2, p.id FROM permission p
      WHERE p.key LIKE $3 || '%' OR p.key LIKE '%.read'
     ON CONFLICT (role_id, permission_id) DO NOTHING`,
    [tenantId, roleId, PLATFORM_PERMISSION_PREFIX]
  );
}
