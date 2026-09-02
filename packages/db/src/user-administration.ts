import { recordAuditEntry, type AuditActor } from "./audit";
import {
  likeArgument,
  limitOffset,
  orderByClause,
  toPage,
  type PageRequest,
  type PagedResult
} from "./paging";
import { isUuid } from "./tenant-administration";
import type { Queryable } from "./tenancy";

/**
 * User administration within one tenant (US-064).
 *
 * Every function here is tenant-scoped and takes no tenant identifier. The
 * caller runs them inside `withRequestTenantScope`, so row level security does
 * the filtering — a `tenantId` parameter would be a parameter someone could
 * eventually feed from a header, and a header that selects a tenant is a header
 * somebody iterates.
 */

/** As the portal names them. The column's third value is `disabled`. */
export type UserStatus = "active" | "invited" | "suspended";

export interface UserSummary {
  id: string;
  email: string;
  name: string;
  role: string;
  status: UserStatus;
  tenantSlug: string;
  lastSeenAt: Date | null;
}

export interface UserDetail extends UserSummary {
  roles: string[];
  createdAt: Date;
  invitedBy: string | null;
}

/**
 * The column stores `disabled`; every screen says `suspended`.
 *
 * Translated at this boundary rather than by renaming the column, because
 * `user_status_check` is written into a migration that has already run
 * everywhere — and "the database and the UI disagree about one word" is a much
 * cheaper problem than a migration that rewrites a constraint under live rows.
 */
const toUserStatus = (status: string): UserStatus =>
  status === "disabled" ? "suspended" : (status as UserStatus);

const toColumnStatus = (status: "active" | "suspended"): string =>
  status === "suspended" ? "disabled" : "active";

/**
 * The role shown in the list's single "role" column.
 *
 * `admin` wins when held, because that is the fact someone scanning the list is
 * looking for; otherwise the first alphabetically, which `array_agg` has
 * already ordered. Empty for a user holding none — an invited user who has not
 * been granted anything yet is a real state, and inventing a default role for
 * the column would misreport it.
 */
const primaryRole = (roles: string[]): string =>
  roles.includes("admin") ? "admin" : (roles[0] ?? "");

const USER_SORT_COLUMNS: Record<string, string> = {
  name: "coalesce(nullif(u.name, ''), split_part(u.email, '@', 1))",
  email: "u.email",
  status: "u.status",
  tenantSlug: "t.slug",
  lastSeenAt: "u.last_login_at",
  createdAt: "u.created_at"
};

interface UserRow {
  id: string;
  email: string;
  name: string;
  status: string;
  tenant_slug: string;
  last_login_at: Date | null;
  created_at: Date;
  roles: string[];
  total_count: string;
}

/**
 * `name` falls back to the email's local part in SQL rather than in the mapper.
 *
 * It has to: the same expression is what `ORDER BY name` sorts on, and a
 * fallback applied after the rows come back would sort by the null column and
 * then display something else — a list that looks unsorted.
 */
const NAME_EXPRESSION = `coalesce(nullif(u.name, ''), split_part(u.email, '@', 1))`;

const ROLES_EXPRESSION = `
  coalesce(
    array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL),
    '{}'
  )`;

const toSummary = (row: UserRow): UserSummary => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: primaryRole(row.roles),
  status: toUserStatus(row.status),
  tenantSlug: row.tenant_slug,
  lastSeenAt: row.last_login_at
});

export interface UserPageRequest extends PageRequest {
  /** `all`, or one status to filter to. */
  status?: UserStatus | "all";
}

/** One page of the caller's tenant's users. */
export async function listUsers(
  db: Queryable,
  request: UserPageRequest
): Promise<PagedResult<UserSummary>> {
  const like = likeArgument(request.search);
  const { limit, offset } = limitOffset(request);
  const status =
    !request.status || request.status === "all"
      ? null
      : request.status === "suspended"
        ? "disabled"
        : request.status;

  const res = await db.query<UserRow>(
    `SELECT u.id, u.email, u.status, u.last_login_at, u.created_at,
            ${NAME_EXPRESSION} AS name,
            t.slug AS tenant_slug,
            ${ROLES_EXPRESSION} AS roles,
            count(*) OVER () AS total_count
     FROM "user" u
     JOIN tenant t ON t.id = u.tenant_id
     LEFT JOIN user_role ur ON ur.user_id = u.id
     LEFT JOIN role r ON r.id = ur.role_id
     WHERE ($1::text IS NULL OR u.status = $1)
       AND ($2::text IS NULL
            OR u.email ILIKE $2 ESCAPE '\\'
            OR u.name ILIKE $2 ESCAPE '\\'
            OR t.slug ILIKE $2 ESCAPE '\\')
     GROUP BY u.id, t.slug
     ${orderByClause(request, USER_SORT_COLUMNS, "name")}
     LIMIT $3 OFFSET $4`,
    [status, like, limit, offset]
  );

  return toPage(res.rows, request, toSummary);
}

interface UserDetailRow extends Omit<UserRow, "total_count"> {
  invited_by: string | null;
}

/** One user, or null when this tenant cannot see them. */
export async function findUserDetail(
  db: Queryable,
  userId: string
): Promise<UserDetail | null> {
  if (!isUuid(userId)) return null;

  const res = await db.query<UserDetailRow>(
    `SELECT u.id, u.email, u.status, u.last_login_at, u.created_at,
            ${NAME_EXPRESSION} AS name,
            t.slug AS tenant_slug,
            ${ROLES_EXPRESSION} AS roles,
            -- Who invited them, resolved to an address. A user invited by
            -- provisioning has no inviter, which is null rather than a label.
            (SELECT inviter.email
               FROM user_invitation inv
               JOIN "user" inviter ON inviter.id = inv.invited_by
              WHERE inv.user_id = u.id
              ORDER BY inv.created_at DESC
              LIMIT 1) AS invited_by
     FROM "user" u
     JOIN tenant t ON t.id = u.tenant_id
     LEFT JOIN user_role ur ON ur.user_id = u.id
     LEFT JOIN role r ON r.id = ur.role_id
     WHERE u.id = $1
     GROUP BY u.id, t.slug`,
    [userId]
  );

  const row = res.rows[0];
  if (!row) return null;

  return {
    ...toSummary({ ...row, total_count: "1" }),
    roles: row.roles,
    createdAt: row.created_at,
    invitedBy: row.invited_by
  };
}

/** Raised when reactivating an account that has never had a credential. */
export class UserHasNoCredentialError extends Error {
  constructor() {
    super(
      "This account has no password yet, so it cannot be activated. Reissue the invitation instead."
    );
    this.name = "UserHasNoCredentialError";
  }
}

/**
 * Suspends or reactivates an account.
 *
 * Reactivation is refused for a user with no password rather than attempted and
 * left to fail: `user_active_requires_credential_check` would reject it in the
 * database, and a constraint violation surfacing as a 500 tells the operator
 * nothing about what to do instead.
 */
export async function setUserStatus(
  db: Queryable,
  userId: string,
  status: "active" | "suspended",
  actor: AuditActor
): Promise<UserDetail | null> {
  if (!isUuid(userId)) return null;

  const current = await db.query<{ id: string; tenant_id: string; status: string; has_password: boolean }>(
    `SELECT id, tenant_id, status, password_hash IS NOT NULL AS has_password
     FROM "user" WHERE id = $1`,
    [userId]
  );
  const row = current.rows[0];
  if (!row) return null;

  if (status === "active" && !row.has_password) {
    throw new UserHasNoCredentialError();
  }

  const next = toColumnStatus(status);
  if (row.status !== next) {
    await db.query(`UPDATE "user" SET status = $2, updated_at = now() WHERE id = $1`, [
      userId,
      next
    ]);

    // The two actions are written as literals on their own line rather than
    // chosen by a ternary inside the call. The US-015 guard reads these
    // statically to check that every action a route claims is one the source
    // actually writes, and an expression it cannot evaluate is an action it
    // cannot track.
    const entry = {
      tenantId: row.tenant_id,
      entityType: "user",
      entityId: userId,
      actor,
      before: { status: row.status },
      after: { status: next }
    };

    if (status === "suspended") {
      await recordAuditEntry(db, {
        action: "user.suspended",
        ...entry
      });
    } else {
      await recordAuditEntry(db, {
        action: "user.reactivated",
        ...entry
      });
    }
  }

  return findUserDetail(db, userId);
}

/**
 * Replaces the set of roles a user holds.
 *
 * Roles are named rather than identified by id: the caller is choosing from
 * their own tenant's role list, and resolving names against that list means an
 * id belonging to another tenant is not something this function can be handed.
 * An unknown name is refused outright rather than silently dropped — a request
 * that half-applies is worse than one that fails.
 */
export async function setUserRoles(
  db: Queryable,
  userId: string,
  roleNames: readonly string[],
  actor: AuditActor
): Promise<UserDetail | null> {
  if (!isUuid(userId)) return null;

  const user = await db.query<{ id: string; tenant_id: string; email: string }>(
    `SELECT id, tenant_id, email FROM "user" WHERE id = $1`,
    [userId]
  );
  const row = user.rows[0];
  if (!row) return null;

  const wanted = [...new Set(roleNames)];
  /**
   * Filtered by the user's own tenant, not left to row level security.
   *
   * Redundant on a scoped session — RLS already fences `role` to the current
   * tenant — and load-bearing on an unscoped one, which is how the platform
   * tier reaches this: `withoutTenantScope` bypasses the policy, so an
   * unfiltered lookup would match a role of the same name in *any* tenant and
   * attach it to a user in this one. Role names are not unique across tenants,
   * so that is a live possibility rather than a theoretical one.
   */
  const roles = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM role WHERE tenant_id = $1 AND name = ANY($2::text[])`,
    [row.tenant_id, wanted]
  );

  const missing = wanted.filter((name) => !roles.rows.some((role) => role.name === name));
  if (missing.length > 0) {
    throw new UnknownRoleError(missing);
  }

  const before = await db.query<{ name: string }>(
    `SELECT r.name FROM user_role ur JOIN role r ON r.id = ur.role_id
     WHERE ur.user_id = $1 ORDER BY r.name`,
    [userId]
  );
  const held = new Set(before.rows.map((entry) => entry.name));
  const granted = roles.rows.filter((role) => !held.has(role.name));
  const revoked = [...held].filter((name) => !wanted.includes(name));

  if (granted.length === 0 && revoked.length === 0) {
    return findUserDetail(db, userId);
  }

  await db.query(
    `DELETE FROM user_role WHERE user_id = $1 AND role_id <> ALL($2::uuid[])`,
    [userId, roles.rows.map((role) => role.id)]
  );

  for (const role of granted) {
    await db.query(
      `INSERT INTO user_role (tenant_id, user_id, role_id) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, role_id) DO NOTHING`,
      [row.tenant_id, userId, role.id]
    );
  }

  // Two actions, because a grant and a revocation are different events — a log
  // that recorded only "roles changed" could not answer "who was given admin".
  if (granted.length > 0) {
    await recordAuditEntry(db, {
      tenantId: row.tenant_id,
      action: "role.assigned",
      entityType: "user_role",
      entityId: userId,
      actor,
      before: null,
      after: { userEmail: row.email, roles: granted.map((role) => role.name) }
    });
  }
  if (revoked.length > 0) {
    await recordAuditEntry(db, {
      tenantId: row.tenant_id,
      action: "role.revoked",
      entityType: "user_role",
      entityId: userId,
      actor,
      before: { userEmail: row.email, roles: revoked },
      after: null
    });
  }

  return findUserDetail(db, userId);
}

/** Raised when a request names a role the tenant does not have. */
export class UnknownRoleError extends Error {
  readonly roles: string[];

  constructor(roles: string[]) {
    super(`No such role in this tenant: ${roles.join(", ")}.`);
    this.name = "UnknownRoleError";
    this.roles = roles;
  }
}

/** Sets the display name on a user row, used when an invitation supplies one. */
export async function setUserName(
  db: Queryable,
  userId: string,
  name: string
): Promise<void> {
  await db.query(`UPDATE "user" SET name = $2, updated_at = now() WHERE id = $1`, [
    userId,
    name
  ]);
}
