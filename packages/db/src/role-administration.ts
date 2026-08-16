import { recordAuditEntry, type AuditActor } from "./audit";
import { isPlatformPermissionKey } from "./platform";
import { DEFAULT_ROLES } from "./provisioning";
import { isUuid } from "./tenant-administration";
import type { Queryable } from "./tenancy";

/**
 * Roles and the permissions they hold (US-064).
 *
 * Tenant-scoped, so nothing here takes a tenant identifier — the caller runs it
 * inside `withRequestTenantScope`. The permission catalogue it references is
 * global and read-only to the application: the row-level-security migration
 * grants `SELECT` on `permission` and nothing else, so a role's permissions can
 * change but the catalogue itself cannot.
 */

export interface RoleRecord {
  id: string;
  name: string;
  permissions: string[];
  userCount: number;
  builtIn: boolean;
}

/** The roles provisioning creates. Nothing offers to delete these. */
const BUILT_IN: readonly string[] = DEFAULT_ROLES;

interface RoleRow {
  id: string;
  name: string;
  permissions: string[];
  user_count: string;
}

const toRole = (row: RoleRow): RoleRecord => ({
  id: row.id,
  name: row.name,
  permissions: row.permissions,
  userCount: Number(row.user_count),
  builtIn: BUILT_IN.includes(row.name)
});

/**
 * Every role in the caller's tenant.
 *
 * `count(DISTINCT ur.user_id)` rather than `count(ur.user_id)`: the join to
 * `role_permission` multiplies each role's rows by its permission count, so a
 * plain count would report an admin role with seven permissions as having seven
 * times as many users as it does.
 */
export async function listRoles(db: Queryable): Promise<RoleRecord[]> {
  const res = await db.query<RoleRow>(
    `SELECT r.id, r.name,
            coalesce(
              array_agg(DISTINCT p.key) FILTER (WHERE p.key IS NOT NULL),
              '{}'
            ) AS permissions,
            count(DISTINCT ur.user_id) AS user_count
     FROM role r
     LEFT JOIN role_permission rp ON rp.role_id = r.id
     LEFT JOIN permission p ON p.id = rp.permission_id
     LEFT JOIN user_role ur ON ur.role_id = r.id
     GROUP BY r.id
     ORDER BY r.name`
  );
  return res.rows.map(toRole);
}

export async function findRole(db: Queryable, roleId: string): Promise<RoleRecord | null> {
  if (!isUuid(roleId)) return null;
  const roles = await listRoles(db);
  return roles.find((role) => role.id === roleId) ?? null;
}

/**
 * Raised when a tenant role is offered a cross-tenant permission.
 *
 * Separate from `UnknownPermissionError` because the two are different answers:
 * the key exists, it is simply not something this endpoint can hand out. Saying
 * "no such permission" instead would be a small lie that sends the caller
 * looking for a typo.
 */
export class PlatformPermissionNotGrantableError extends Error {
  readonly permissions: string[];

  constructor(permissions: string[]) {
    super(
      `Platform permissions cannot be granted to a tenant role: ${permissions.join(", ")}.`
    );
    this.name = "PlatformPermissionNotGrantableError";
    this.permissions = permissions;
  }
}

/** Raised when the permission matrix is pointed at a platform tenant role. */
export class PlatformRoleNotEditableError extends Error {
  readonly role: string;

  constructor(role: string) {
    super(
      `The "${role}" role is managed by the platform tier and cannot be edited from the tenant permission matrix.`
    );
    this.name = "PlatformRoleNotEditableError";
    this.role = role;
  }
}

/** Raised when a request names a permission the catalogue does not contain. */
export class UnknownPermissionError extends Error {
  readonly permissions: string[];

  constructor(permissions: string[]) {
    super(`No such permission: ${permissions.join(", ")}.`);
    this.name = "UnknownPermissionError";
    this.permissions = permissions;
  }
}

/**
 * Replaces the permissions held by one role.
 *
 * The whole set rather than one grant at a time, because the caller has already
 * resolved the read-implied-by-write rule and sending a single toggle would
 * make the endpoint reapply it — two places deciding the same thing.
 *
 * Delete-then-insert inside the caller's transaction: the intermediate state
 * where the role holds nothing is never visible to another session, and
 * reconciling the difference row by row would be more code for the same result.
 */
export async function setRolePermissions(
  db: Queryable,
  roleId: string,
  permissionKeys: readonly string[],
  actor: AuditActor
): Promise<RoleRecord | null> {
  if (!isUuid(roleId)) return null;

  const role = await db.query<{
    id: string;
    tenant_id: string;
    name: string;
    is_platform: boolean;
  }>(
    `SELECT r.id, r.tenant_id, r.name, t.is_platform
       FROM role r JOIN tenant t ON t.id = r.tenant_id
      WHERE r.id = $1`,
    [roleId]
  );
  const row = role.rows[0];
  if (!row) return null;

  /**
   * The platform tenant's roles are not editable from this endpoint, and this
   * is a self-lockout guard rather than a policy.
   *
   * The response schema drops permission keys the tenant contract does not
   * know, so a platform administrator opening their own permission matrix sees
   * the `platform.*` grants as absent. Saving that screen would send back the
   * set without them — and this function replaces the whole set, so the one
   * account that can administer the installation would revoke its own reach by
   * pressing Save on a screen that never showed it the checkbox.
   */
  if (row.is_platform) {
    throw new PlatformRoleNotEditableError(row.name);
  }

  const wanted = [...new Set(permissionKeys)];
  const permissions = await db.query<{ id: string; key: string }>(
    `SELECT id, key FROM permission WHERE key = ANY($1::text[])`,
    [wanted]
  );

  const missing = wanted.filter(
    (key) => !permissions.rows.some((permission) => permission.key === key)
  );
  if (missing.length > 0) {
    throw new UnknownPermissionError(missing);
  }

  /**
   * Cross-tenant permissions are not on offer here, at all.
   *
   * The API's schema already rejects them — `updateRolePermissionsSchema`
   * validates against the tenant half of the catalogue — and the database
   * refuses the INSERT for any role outside the platform tenant. This check sits
   * between the two so the refusal is a typed error the caller can be told
   * about, rather than a trigger exception surfacing as a 500 on the one path
   * where the answer "you may not grant that" is the whole point.
   */
  const platformKeys = wanted.filter(isPlatformPermissionKey);
  if (platformKeys.length > 0) {
    throw new PlatformPermissionNotGrantableError(platformKeys);
  }

  const before = await db.query<{ key: string }>(
    `SELECT p.key FROM role_permission rp
     JOIN permission p ON p.id = rp.permission_id
     WHERE rp.role_id = $1 ORDER BY p.key`,
    [roleId]
  );
  const held = before.rows.map((entry) => entry.key);
  const next = permissions.rows.map((permission) => permission.key).sort();

  // Nothing changed: return without writing an audit entry for a request that
  // altered nothing, which would otherwise fill the log with re-saves.
  if (held.length === next.length && held.every((key, index) => key === next[index])) {
    return findRole(db, roleId);
  }

  await db.query(`DELETE FROM role_permission WHERE role_id = $1`, [roleId]);
  for (const permission of permissions.rows) {
    await db.query(
      `INSERT INTO role_permission (tenant_id, role_id, permission_id) VALUES ($1, $2, $3)`,
      [row.tenant_id, roleId, permission.id]
    );
  }

  await recordAuditEntry(db, {
    tenantId: row.tenant_id,
    action: "role.permissions_changed",
    entityType: "role",
    entityId: roleId,
    actor,
    before: { role: row.name, permissions: held },
    after: { role: row.name, permissions: next }
  });

  return findRole(db, roleId);
}
