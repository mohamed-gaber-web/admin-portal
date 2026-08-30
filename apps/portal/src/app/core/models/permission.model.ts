import type { MessageKey } from "@core/i18n/messages/en";

/**
 * A permission from the global catalogue.
 *
 * `permission` is not tenant-scoped and the application holds `SELECT` on it
 * and nothing else — the row-level-security migration grants exactly that. So
 * the catalogue is something the portal reads and displays; it is never
 * something the portal creates, renames or deletes. A screen offering to edit a
 * permission would be offering an operation the database refuses.
 *
 * What *is* editable is which permissions a role holds — `role_permission`,
 * the join the auth-foundation migration added to stop roles being decorative.
 */
export interface Permission {
  key: PermissionKey;
  /** Translated at render. The API returns an English description; this does not. */
  descriptionKey: MessageKey;
  group: PermissionGroup;
}

/**
 * The catalogue, verbatim from `DEMO_PERMISSIONS` in `@growpath/db`.
 *
 * Kept in step with the seed by hand today. When an endpoint serves the
 * catalogue this becomes the response shape, and the descriptions should travel
 * as keys rather than as English — a global table with a `description` column
 * in one language is how a localised product ends up with a permanently English
 * permissions screen.
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

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

/**
 * Groups, so the matrix reads as four subjects rather than seven flat rows.
 *
 * Derived from the key's prefix, which is the same convention the audit actions
 * use. Nothing depends on the grouping beyond layout.
 */
export type PermissionGroup = "tenant" | "user" | "connection" | "audit";

export const PERMISSION_CATALOGUE: readonly Permission[] = [
  { key: "tenant.read", descriptionKey: "permission.tenant.read", group: "tenant" },
  { key: "tenant.write", descriptionKey: "permission.tenant.write", group: "tenant" },
  { key: "user.read", descriptionKey: "permission.user.read", group: "user" },
  { key: "user.write", descriptionKey: "permission.user.write", group: "user" },
  {
    key: "connection.read",
    descriptionKey: "permission.connection.read",
    group: "connection"
  },
  {
    key: "connection.write",
    descriptionKey: "permission.connection.write",
    group: "connection"
  },
  { key: "audit.read", descriptionKey: "permission.audit.read", group: "audit" }
];

export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  "tenant",
  "user",
  "connection",
  "audit"
];

/**
 * A role. Tenant-scoped, unlike the permissions it holds.
 *
 * `builtIn` marks the two the seed creates. They can hold different permissions
 * — that is the point of the matrix — but nothing offers to delete them, since
 * a tenant with no admin role is a tenant nobody can administer.
 */
export interface Role {
  id: string;
  name: string;
  descriptionKey: MessageKey;
  permissions: PermissionKey[];
  userCount: number;
  builtIn: boolean;
}

/** True when granting this permission implies read access it does not name. */
export function impliedBy(permission: PermissionKey): PermissionKey | null {
  // `.write` without `.read` is not a state the API models — writing something
  // you cannot see is meaningless — so the matrix keeps them together.
  return permission.endsWith(".write")
    ? (permission.replace(/\.write$/, ".read") as PermissionKey)
    : null;
}
