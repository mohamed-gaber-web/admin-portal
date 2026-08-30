import { burnPasswordHashingTime, verifyPassword } from "./invitations";
import { clearFailedAttempts, registerFailedAttempt } from "./lockout";
import type { Queryable } from "./tenancy";

/**
 * Password authentication (US-021).
 *
 * `user.email` is unique across the whole installation — see the
 * global-email-identity migration — so an address identifies exactly one person
 * and the tenant is something this module *resolves*, never something the caller
 * supplies. That is the whole reason sign-in no longer takes a slug: a value the
 * caller sends is a value the caller can iterate, and the workspace is now
 * derived from a verified credential instead.
 *
 * The tenant still travels back out, in `AuthenticatedUser`, because the portal
 * has to show somebody which workspace they landed in.
 */

/**
 * The one message every failed sign-in returns.
 *
 * Wrong password, unknown email and a user who cannot sign in yet are
 * indistinguishable to the caller; a per-reason message is precisely how that
 * distinction escapes. The reason is recorded in `auth_event`, where only an
 * operator sees it.
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
  | "no such user"
  // The address resolves, but its tenant is soft-deleted. Distinct from "no
  // such user" in the log because it is an operator's doing rather than a
  // stranger guessing addresses.
  | "tenant archived"
  | "user not active"
  | "user has no credential"
  | "wrong password"
  // US-026. Recorded so an operator can tell a locked account apart from a
  // wrong password; the caller cannot, which is the point.
  | "account locked";

export interface SignInInput {
  /**
   * The whole of the supplied identity.
   *
   * No slug: the tenant is resolved from this address, which is unique across
   * the installation.
   */
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
  /**
   * The workspace's display name.
   *
   * Carried alongside the slug because the slug is an identifier and this is
   * what a person recognises. Sign-in no longer asks which workspace you meant,
   * so the answer has to be visible afterwards — otherwise somebody with
   * accounts on two installations cannot tell which one they reached.
   */
  tenantName: string;
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
  tenant_slug: string;
  tenant_name: string;
  /** Non-null for a soft-deleted tenant, which must behave like no tenant at all. */
  tenant_deleted_at: Date | null;
  user_id: string;
  email: string;
  status: string;
  password_hash: string | null;
  /** Evaluated in the database, so a drifted server clock cannot unlock early. */
  locked: boolean | null;
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
    name: string;
    status: string;
  }>(
    `SELECT u.id AS user_id, u.email, t.id AS tenant_id, t.slug, t.name, u.status
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
    tenantName: row.name,
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
  const email = input.email.trim();

  // The address is the lookup key, and `user_email_global_unique` is what makes
  // that a single row. The tenant is joined rather than filtered on: a
  // soft-deleted tenant has to be *found* so the refusal can be recorded against
  // it, and then refused below — filtering it out in the WHERE clause would make
  // an archived customer's sign-in indistinguishable in the log from a stranger
  // guessing addresses, which is exactly the pair an operator needs to tell
  // apart.
  const candidate = await db.query<CandidateRow>(
    `SELECT t.id AS tenant_id, t.slug AS tenant_slug, t.name AS tenant_name,
            t.deleted_at AS tenant_deleted_at,
            u.id AS user_id, u.email, u.status, u.password_hash,
            (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked
     FROM "user" u
     JOIN tenant t ON t.id = u.tenant_id
     WHERE lower(u.email) = lower($1)`,
    [email]
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
      // Null now rather than the caller's slug: there is no slug in the request
      // any more, and the resolved tenant is already recorded in `tenantId`.
      claimedSlug: null,
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
    return fail("no such user", null, null);
  }
  if (row.tenant_deleted_at) {
    await burnPasswordHashingTime();
    return fail("tenant archived", row.tenant_id, row.user_id);
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

  // Checked before the password is verified, and burning the same time as a
  // verification would. Returning early *without* burning would make a locked
  // account measurably faster than a wrong password — handing back, as a timing
  // signal, exactly the distinction the identical message withholds.
  if (row.locked) {
    await burnPasswordHashingTime();
    return fail("account locked", row.tenant_id, row.user_id);
  }

  if (!(await verifyPassword(row.password_hash, input.password))) {
    const outcome = await registerFailedAttempt(db, row.user_id);

    if (outcome.justLocked) {
      // A second event, not a replacement: the attempt itself is still a failed
      // sign-in, and the lockout is a distinct thing an operator searches for.
      await recordAuthEvent(db, {
        tenantId: row.tenant_id,
        userId: row.user_id,
        claimedSlug: null,
        claimedEmail: email,
        event: "login.locked",
        outcome: "failed",
        reason: `locked after ${outcome.failedCount} consecutive failures`,
        ip: input.ip,
        userAgent: input.userAgent
      });
    }

    return fail("wrong password", row.tenant_id, row.user_id);
  }

  await clearFailedAttempts(db, row.user_id);
  await db.query(
    `UPDATE "user" SET last_login_at = now(), updated_at = now() WHERE id = $1`,
    [row.user_id]
  );

  await recordAuthEvent(db, {
    tenantId: row.tenant_id,
    userId: row.user_id,
    claimedSlug: null,
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
      // The tenant the database resolved, not one anybody claimed — there is no
      // longer a claim to confuse it with.
      tenantSlug: row.tenant_slug,
      tenantName: row.tenant_name,
      permissions: await loadPermissions(db, row.tenant_id, row.user_id)
    }
  };
}
