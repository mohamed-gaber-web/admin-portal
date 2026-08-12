import { burnPasswordHashingTime, verifyPassword } from "./invitations";
import type { Queryable } from "./tenancy";

/**
 * Password authentication (US-021).
 *
 * `user.email` is unique per tenant rather than globally, so an address alone
 * does not identify a person — three people at three clients may share one. The
 * caller therefore supplies the tenant slug, and (slug, email) is the identity.
 */

/**
 * The one message every failed sign-in returns.
 *
 * Wrong password, unknown email, unknown slug and a user who cannot sign in yet
 * are indistinguishable to the caller; a per-reason message is precisely how
 * that distinction escapes. The reason is recorded in `auth_event`, where only
 * an operator sees it.
 */
export const INVALID_CREDENTIALS_MESSAGE = "Those sign-in details are not correct.";

/**
 * The result of a sign-in attempt.
 *
 * A result rather than an exception, deliberately. `authenticate` records the
 * attempt before returning, and callers run it inside a transaction — so
 * throwing on failure rolled that transaction back and discarded the very
 * record of the failed attempt. Failed sign-ins are the ones a security review
 * asks about, so the write must not depend on the call succeeding.
 */
export type AuthenticationResult =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false };

/** Why a sign-in failed. Written to auth_event; never returned to the caller. */
type FailureReason =
  | "no such tenant"
  | "no such user"
  | "user not active"
  | "user has no credential"
  | "wrong password";

export interface SignInInput {
  /** Tenant identifier supplied by the caller. */
  slug: string;
  email: string;
  password: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuthenticatedUser {
  userId: string;
  email: string;
  tenantId: string;
  tenantSlug: string;
  /** Permission keys granted through this user's roles. */
  permissions: string[];
}

/**
 * Permission keys a user holds, via their roles.
 *
 * Read at sign-in and stamped into the token, so a request does not pay for
 * this join. The trade-off is that a permission change takes effect when the
 * token next refreshes rather than instantly — which is why the access token
 * expiry is minutes rather than hours.
 */
export async function loadPermissions(
  db: Queryable,
  tenantId: string,
  userId: string
): Promise<string[]> {
  const res = await db.query<{ key: string }>(
    `SELECT DISTINCT p.key
     FROM user_role ur
     JOIN role_permission rp ON rp.role_id = ur.role_id
     JOIN permission p ON p.id = rp.permission_id
     WHERE ur.tenant_id = $1 AND ur.user_id = $2
     ORDER BY p.key`,
    [tenantId, userId]
  );
  return res.rows.map((row) => row.key);
}

interface CandidateRow {
  tenant_id: string;
  user_id: string;
  email: string;
  status: string;
  password_hash: string | null;
}

/**
 * Rebuilds the identity for a user whose credential was already verified.
 *
 * Used by the MFA gate (US-025), where the password check happened in an
 * earlier request and the session is only issued once the second factor lands.
 * Re-reads the tenant and permissions rather than carrying them in the
 * challenge token: a disabled account between the two steps must not still
 * receive a session.
 */
export async function loadAuthenticatedUser(
  db: Queryable,
  userId: string
): Promise<AuthenticatedUser | null> {
  const res = await db.query<{
    user_id: string;
    email: string;
    tenant_id: string;
    slug: string;
    status: string;
  }>(
    `SELECT u.id AS user_id, u.email, t.id AS tenant_id, t.slug, u.status
     FROM "user" u
     JOIN tenant t ON t.id = u.tenant_id
     WHERE u.id = $1 AND t.deleted_at IS NULL`,
    [userId]
  );

  const row = res.rows[0];
  if (!row || row.status !== "active") {
    return null;
  }

  return {
    userId: row.user_id,
    email: row.email,
    tenantId: row.tenant_id,
    tenantSlug: row.slug,
    permissions: await loadPermissions(db, row.tenant_id, row.user_id)
  };
}

export interface RecordAuthEventInput {
  tenantId?: string | null;
  userId?: string | null;
  claimedSlug?: string | null;
  claimedEmail?: string | null;
  event: string;
  outcome: "succeeded" | "failed";
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Appends one authentication event.
 *
 * Takes no tenant for granted: a sign-in against an unknown slug has none, and
 * that is exactly the attempt worth recording. `audit_log` could not hold it —
 * its tenant_id is NOT NULL — which is why `auth_event` exists.
 */
export async function recordAuthEvent(
  db: Queryable,
  input: RecordAuthEventInput
): Promise<void> {
  await db.query(
    `INSERT INTO auth_event
       (tenant_id, user_id, claimed_slug, claimed_email, event, outcome, reason, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.tenantId ?? null,
      input.userId ?? null,
      input.claimedSlug ?? null,
      input.claimedEmail ?? null,
      input.event,
      input.outcome,
      input.reason ?? null,
      input.ip ?? null,
      input.userAgent ?? null
    ]
  );
}

/**
 * Verifies a sign-in and records the attempt.
 *
 * The event is written on every path, success or failure, before the result is
 * returned or thrown — so there is no branch where an attempt goes unrecorded,
 * which is what AC3 actually asks for.
 */
export async function authenticate(
  db: Queryable,
  input: SignInInput
): Promise<AuthenticationResult> {
  const slug = input.slug.trim();
  const email = input.email.trim();

  // One query for both, so an unknown slug and an unknown email cost the same.
  // Soft-deleted tenants are excluded here rather than checked afterwards: a
  // deleted tenant must behave exactly like one that never existed.
  const candidate = await db.query<CandidateRow>(
    `SELECT t.id AS tenant_id, u.id AS user_id, u.email, u.status, u.password_hash
     FROM tenant t
     LEFT JOIN "user" u ON u.tenant_id = t.id AND lower(u.email) = lower($2)
     WHERE t.slug = lower($1) AND t.deleted_at IS NULL`,
    [slug, email]
  );

  const row = candidate.rows[0];

  const fail = async (
    reason: FailureReason,
    tenantId: string | null,
    userId: string | null
  ): Promise<AuthenticationResult> => {
    await recordAuthEvent(db, {
      tenantId,
      userId,
      claimedSlug: slug,
      claimedEmail: email,
      event: "login.failed",
      outcome: "failed",
      reason,
      ip: input.ip,
      userAgent: input.userAgent
    });
    return { ok: false };
  };

  // Every branch that stops before verifying a password burns the same time a
  // verification would, so "no such user" cannot be recognised by returning
  // faster than "wrong password".
  if (!row) {
    await burnPasswordHashingTime();
    return fail("no such tenant", null, null);
  }
  if (!row.user_id) {
    await burnPasswordHashingTime();
    return fail("no such user", row.tenant_id, null);
  }
  if (row.status !== "active") {
    await burnPasswordHashingTime();
    return fail("user not active", row.tenant_id, row.user_id);
  }
  if (!row.password_hash) {
    // The schema forbids this pairing, so reaching it means the constraint was
    // dropped. Fail closed rather than trusting it cannot happen.
    await burnPasswordHashingTime();
    return fail("user has no credential", row.tenant_id, row.user_id);
  }

  if (!(await verifyPassword(row.password_hash, input.password))) {
    return fail("wrong password", row.tenant_id, row.user_id);
  }

  await db.query(
    `UPDATE "user" SET last_login_at = now(), failed_login_count = 0, updated_at = now()
     WHERE id = $1`,
    [row.user_id]
  );

  await recordAuthEvent(db, {
    tenantId: row.tenant_id,
    userId: row.user_id,
    claimedSlug: slug,
    claimedEmail: email,
    event: "login.succeeded",
    outcome: "succeeded",
    ip: input.ip,
    userAgent: input.userAgent
  });

  return {
    ok: true,
    user: {
      userId: row.user_id,
      email: row.email,
      tenantId: row.tenant_id,
      tenantSlug: slug,
      permissions: await loadPermissions(db, row.tenant_id, row.user_id)
    }
  };
}
