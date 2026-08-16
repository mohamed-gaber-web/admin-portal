import { z } from "zod";

/**
 * The global permission catalogue.
 *
 * `permission` is not tenant-scoped and the application holds `SELECT` on it
 * and nothing else — the row-level-security migration grants exactly that. So
 * the catalogue is read and displayed, never created or renamed through the
 * API. What *is* editable is which permissions a role holds.
 */
export const PERMISSION_KEYS = [
  "tenant.read",
  "tenant.write",
  "user.read",
  "user.write",
  "connection.read",
  "connection.write",
  "audit.read"
] as const;

export const permissionKeySchema = z.enum(PERMISSION_KEYS);
export type PermissionKey = z.infer<typeof permissionKeySchema>;

/**
 * The cross-tenant half of the catalogue, kept in a separate enum on purpose.
 *
 * These authorise reading and administering *every* tenant, so they must never
 * appear in the tenant permission matrix — and `updateRolePermissionsSchema`
 * validates against `permissionKeySchema`, which is exactly the list above.
 * Keeping them out of `PERMISSION_KEYS` is therefore not cosmetic: it is what
 * makes `PUT /roles/:id/permissions` reject a tenant administrator who tries to
 * grant their own role platform reach. The database refuses the same grant
 * independently (see the platform-administration migration), because a rule
 * enforced only by a schema is a rule that holds only for callers using it.
 */
export const PLATFORM_PERMISSION_KEYS = [
  "platform.tenant.read",
  "platform.tenant.write",
  "platform.user.read",
  "platform.user.write",
  /**
   * The commercial half (US-072).
   *
   * Separate keys rather than folding them into `platform.tenant.write`,
   * because they authorise a different kind of act: suspending a tenant is
   * operational and reversible in a minute, and cancelling their subscription
   * or removing a module they paid for is neither. An installation that wants
   * a support operator who can suspend but not unsubscribe now has one.
   */
  "platform.plan.write",
  "platform.module.write",
  /** Minting another operator — the most consequential grant in the system. */
  "platform.admin.write"
] as const;

export const platformPermissionKeySchema = z.enum(PLATFORM_PERMISSION_KEYS);
export type PlatformPermissionKey = z.infer<typeof platformPermissionKeySchema>;

/** The reserved tenant the platform administrators live in. */
export const PLATFORM_TENANT_SLUG = "platform";

/** The built-in role that carries the platform permissions. */
export const PLATFORM_ADMIN_ROLE = "platform-admin";

/** True for a key that reaches across tenants. Mechanical, by prefix. */
export function isPlatformPermission(key: string): key is PlatformPermissionKey {
  return key.startsWith("platform.");
}

/**
 * True when granting this permission implies a read it does not name.
 *
 * Enforced on the API rather than only in the portal's matrix: `.write` without
 * `.read` is not a state the system models — writing something you cannot see
 * is meaningless — and a rule that lives only in the client is a rule any other
 * client skips.
 */
export function impliedBy(permission: PermissionKey): PermissionKey | null {
  return permission.endsWith(".write")
    ? (permission.replace(/\.write$/, ".read") as PermissionKey)
    : null;
}

/**
 * Closes a permission set under the read-implied-by-write rule, and drops any
 * write whose read was not granted.
 *
 * Shared by the API and the portal so both arrive at the same set. The API
 * applies it as the authority; the portal applies it to keep the matrix from
 * flickering while the request is in flight.
 */
export function normalisePermissions(
  permissions: readonly PermissionKey[]
): PermissionKey[] {
  const held = new Set(permissions);

  for (const permission of permissions) {
    const read = impliedBy(permission);
    if (read) held.add(read);
  }

  return [...held].sort();
}

/**
 * A role. Tenant-scoped, unlike the permissions it holds.
 *
 * `builtIn` marks the roles provisioning creates. They can hold different
 * permissions — that is what the matrix is for — but nothing offers to delete
 * them, because a tenant with no admin role is a tenant nobody can administer.
 *
 * No description field: the catalogue's descriptions are English text in a
 * global table, and shipping them would give the product a permanently English
 * permissions screen. The portal resolves a translation key from the name.
 */
export const roleSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    permissions: z.array(permissionKeySchema),
    userCount: z.number().int().nonnegative(),
    builtIn: z.boolean()
  })
  .strict();

export type Role = z.infer<typeof roleSchema>;

export const roleListSchema = z.array(roleSchema);

/**
 * Replacing a role's permissions.
 *
 * The whole set rather than one grant at a time: the read-implied-by-write rule
 * can change two entries for one click, and an endpoint that took a single
 * permission would have to answer "and what happened to the other one?" in its
 * response anyway.
 */
export const updateRolePermissionsSchema = z
  .object({
    permissions: z.array(permissionKeySchema)
  })
  .strict();

export type UpdateRolePermissionsInput = z.infer<typeof updateRolePermissionsSchema>;
