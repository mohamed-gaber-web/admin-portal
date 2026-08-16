import type { Queryable } from "./tenancy";

/**
 * Account lockout (US-026).
 *
 * The backstop, not the main control. Per-source throttling carries the weight;
 * this exists for the case throttling cannot see — the same account attacked
 * from many sources.
 *
 * That ordering is the whole design, because naive per-account lockout is a
 * denial-of-service tool rather than a defence: anyone who can lock any account
 * by guessing at it can lock a victim out on demand. Two things keep that in
 * check here.
 *
 * First, `LOCKOUT_THRESHOLD` is deliberately **higher than the per-source
 * request limit**, so a single source runs into the 429 before it can ever
 * reach the lockout. Reaching it at all requires more than one source, which
 * means the attacker has already paid for infrastructure that per-account
 * lockout was never going to stop.
 *
 * Second, the lock expires on its own. A victim locked out by an attacker is
 * inconvenienced for `LOCKOUT_MINUTES`, not until an administrator intervenes —
 * a lockout that needs a human to clear it turns a nuisance into an outage.
 */

/**
 * Consecutive failures before an account locks.
 *
 * Must stay above the per-source limit in `RateLimitGuard`. If the two ever
 * cross, one source becomes able to lock any account inside a single window,
 * which is exactly the trap AC2 names.
 */
export const LOCKOUT_THRESHOLD = 15;

/** How long a locked account stays locked. */
export const LOCKOUT_MINUTES = 15;

export interface LockoutOutcome {
  /** True when this failure was the one that crossed the threshold. */
  justLocked: boolean;
  lockedUntil: Date | null;
  failedCount: number;
}

interface LockoutRow {
  failed_login_count: number;
  locked_until: Date | null;
}

/**
 * Whether an account is locked right now.
 *
 * Compared in the database rather than against the application clock, so a
 * server whose time has drifted cannot unlock an account early or hold one shut
 * late.
 */
export async function isLocked(db: Queryable, userId: string): Promise<boolean> {
  const result = await db.query<{ locked: boolean }>(
    `SELECT (locked_until IS NOT NULL AND locked_until > now()) AS locked
     FROM "user" WHERE id = $1`,
    [userId]
  );
  return result.rows[0]?.locked ?? false;
}

/**
 * Records one failed attempt, locking the account if that crosses the threshold.
 *
 * The increment and the comparison happen in a single statement. Doing it as a
 * read followed by a write lets concurrent attempts each read the same count
 * and none of them cross the threshold — which is precisely the situation an
 * attacker creates by firing in parallel.
 */
export async function registerFailedAttempt(
  db: Queryable,
  userId: string
): Promise<LockoutOutcome> {
  const result = await db.query<LockoutRow>(
    `UPDATE "user"
     SET failed_login_count = failed_login_count + 1,
         locked_until = CASE
           WHEN failed_login_count + 1 >= $2
             THEN now() + make_interval(mins => $3)
           ELSE locked_until
         END,
         updated_at = now()
     WHERE id = $1
     RETURNING failed_login_count, locked_until`,
    [userId, LOCKOUT_THRESHOLD, LOCKOUT_MINUTES]
  );

  const row = result.rows[0];
  if (!row) return { justLocked: false, lockedUntil: null, failedCount: 0 };

  return {
    // Exactly at the threshold, so a run of further failures against an
    // already-locked account does not write a lockout event on every one.
    justLocked: row.failed_login_count === LOCKOUT_THRESHOLD,
    lockedUntil: row.locked_until,
    failedCount: row.failed_login_count
  };
}

/**
 * Clears the counter after a successful sign-in.
 *
 * Also clears `locked_until`. A lock that survived a correct password would
 * outlive the thing it was protecting against, and the password check is a far
 * stronger signal than the counter it replaces.
 */
export async function clearFailedAttempts(
  db: Queryable,
  userId: string
): Promise<void> {
  await db.query(
    `UPDATE "user"
     SET failed_login_count = 0, locked_until = NULL, updated_at = now()
     WHERE id = $1`,
    [userId]
  );
}
