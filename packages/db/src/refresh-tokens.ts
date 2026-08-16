import { createHash, randomBytes } from "node:crypto";
import { loadPermissions, recordAuthEvent, type AuthenticatedUser } from "./authentication";
import type { Queryable } from "./tenancy";

/**
 * Refresh token rotation with reuse detection (US-023).
 *
 * An access token lasts fifteen minutes; a refresh token is what keeps a
 * session alive past that, which makes it the more valuable thing to steal. It
 * is long-lived, and it is presented by a caller who is by definition not
 * currently authenticated.
 *
 * The defence is rotation: every exchange mints a new token and burns the one
 * presented. A burnt token being presented again means it leaked — either the
 * thief is using a copy, or the legitimate user is replaying one the thief
 * already spent. Which of the two it is cannot be known from here, so the whole
 * family goes and the event is recorded for a human to look at.
 */

/** 256 bits. Guessing is not a threat model. */
const TOKEN_BYTES = 32;

/**
 * How long a refresh token stays usable.
 *
 * A fortnight bounds a token that leaks and is never rotated — the rotation
 * machinery below only catches a thief who *uses* the token, and a stolen token
 * that simply sits there is caught by nothing but expiry.
 */
export const REFRESH_TOKEN_TTL_DAYS = 14;

/**
 * The one message every failed exchange returns.
 *
 * Unknown, expired, revoked and replayed are indistinguishable to the caller.
 * Telling a thief that their token was *recognised but already used* confirms
 * they hold something real.
 */
export const INVALID_SESSION_MESSAGE = "That session is no longer valid. Please sign in again.";

/** A refresh token. Returned once, never stored, never logged. */
export function generateRefreshToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * The digest stored in place of the token (AC3).
 *
 * SHA-256 rather than Argon2id, for the same reason as invitation tokens: this
 * is 256 random bits, so there is nothing to guess, and a 19 MiB hash on an
 * unauthenticated lookup path would be a denial-of-service lever.
 */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface IssuedRefreshToken {
  id: string;
  familyId: string;
  /** The only time the raw token exists outside the caller's hands. */
  token: string;
  expiresAt: Date;
}

export interface IssueRefreshTokenInput {
  tenantId: string;
  userId: string;
  /** Continues an existing family. Omitted at sign-in, which starts one. */
  familyId?: string | null;
  /** The token this one replaces, so a family reads as a chain. */
  parentId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  ttlDays?: number;
}

interface IssuedRow {
  id: string;
  family_id: string;
  expires_at: Date;
}

export async function issueRefreshToken(
  db: Queryable,
  input: IssueRefreshTokenInput
): Promise<IssuedRefreshToken> {
  const token = generateRefreshToken();
  const ttlDays = input.ttlDays ?? REFRESH_TOKEN_TTL_DAYS;

  const res = await db.query<IssuedRow>(
    `INSERT INTO refresh_token
       (tenant_id, user_id, family_id, token_hash, parent_id, expires_at, ip, user_agent)
     VALUES ($1, $2, COALESCE($3::uuid, gen_random_uuid()), $4, $5,
             now() + ($6 || ' days')::interval, $7, $8)
     RETURNING id, family_id, expires_at`,
    [
      input.tenantId,
      input.userId,
      input.familyId ?? null,
      hashRefreshToken(token),
      input.parentId ?? null,
      String(ttlDays),
      input.ip ?? null,
      input.userAgent ?? null
    ]
  );

  const row = res.rows[0];
  return { id: row.id, familyId: row.family_id, token, expiresAt: row.expires_at };
}

/** Why an exchange failed. Recorded in auth_event; never returned to the caller. */
export type RefreshFailure = "unknown" | "expired" | "revoked" | "replayed";

export type RefreshResult =
  | { ok: true; user: AuthenticatedUser; refresh: IssuedRefreshToken }
  | { ok: false; reason: RefreshFailure };

export interface RotateRefreshTokenInput {
  token: string;
  ip?: string | null;
  userAgent?: string | null;
}

interface CandidateRow {
  id: string;
  tenant_id: string;
  user_id: string;
  family_id: string;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
  email: string;
  status: string;
  tenant_slug: string;
  tenant_name: string;
  tenant_deleted_at: Date | null;
}

/**
 * Revokes every unrevoked token in a family.
 *
 * Revoking only the token that was replayed would leave the thief's newer one
 * working, which is the failure this whole mechanism exists to prevent.
 */
export async function revokeRefreshTokenFamily(
  db: Queryable,
  familyId: string,
  reason: string
): Promise<number> {
  const res = await db.query(
    `UPDATE refresh_token SET revoked_at = now(), revoked_reason = $2
     WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId, reason]
  );
  return res.rowCount ?? 0;
}

/**
 * Exchanges a refresh token for a new one in the same family.
 *
 * **Must run inside a transaction.** The candidate row is locked FOR UPDATE, so
 * two exchanges racing with the same token cannot both rotate — without the
 * lock, both would read `used_at IS NULL`, both would rotate, and a legitimate
 * double-submit would look identical to a replay.
 *
 * Returns a result rather than throwing, for the same reason `authenticate`
 * does: the caller runs this in a transaction, and throwing from inside would
 * roll back the family revocation and the auth_event that record the replay —
 * the two things a security review actually wants.
 */
export async function rotateRefreshToken(
  db: Queryable,
  input: RotateRefreshTokenInput
): Promise<RefreshResult> {
  const candidate = await db.query<CandidateRow>(
    `SELECT rt.id, rt.tenant_id, rt.user_id, rt.family_id, rt.expires_at, rt.used_at,
            rt.revoked_at, u.email, u.status, t.slug AS tenant_slug,
            t.name AS tenant_name, t.deleted_at AS tenant_deleted_at
     FROM refresh_token rt
     JOIN "user" u ON u.id = rt.user_id
     JOIN tenant t ON t.id = rt.tenant_id
     WHERE rt.token_hash = $1
     FOR UPDATE OF rt`,
    [hashRefreshToken(input.token)]
  );

  const row = candidate.rows[0];

  const fail = async (
    reason: RefreshFailure,
    detail: string,
    event = "token.rejected"
  ): Promise<RefreshResult> => {
    await recordAuthEvent(db, {
      tenantId: row?.tenant_id ?? null,
      userId: row?.user_id ?? null,
      event,
      outcome: "failed",
      reason: detail,
      ip: input.ip,
      userAgent: input.userAgent
    });
    return { ok: false, reason };
  };

  if (!row) {
    // No tenant and no user to attribute it to, which is itself worth seeing:
    // a burst of these is someone guessing.
    return fail("unknown", "unknown refresh token");
  }

  // Checked before revocation and expiry, because a used token is the signal
  // this story exists for and it outranks every other reason to say no.
  if (row.used_at) {
    const revoked = await revokeRefreshTokenFamily(db, row.family_id, "refresh token replayed");
    await recordAuthEvent(db, {
      tenantId: row.tenant_id,
      userId: row.user_id,
      event: "token.replayed",
      outcome: "failed",
      reason: `replayed refresh token; revoked ${revoked} token(s) in family ${row.family_id}`,
      ip: input.ip,
      userAgent: input.userAgent
    });
    return { ok: false, reason: "replayed" };
  }

  if (row.revoked_at) {
    return fail("revoked", "revoked refresh token");
  }
  if (row.expires_at.getTime() <= Date.now()) {
    return fail("expired", "expired refresh token");
  }
  if (row.status !== "active" || row.tenant_deleted_at) {
    // The session outlived the account. Kill the family rather than leaving a
    // usable token behind a disabled user.
    await revokeRefreshTokenFamily(db, row.family_id, "user or tenant no longer active");
    return fail("revoked", "user or tenant no longer active");
  }

  await db.query("UPDATE refresh_token SET used_at = now() WHERE id = $1", [row.id]);

  const refresh = await issueRefreshToken(db, {
    tenantId: row.tenant_id,
    userId: row.user_id,
    familyId: row.family_id,
    parentId: row.id,
    ip: input.ip,
    userAgent: input.userAgent
  });

  await recordAuthEvent(db, {
    tenantId: row.tenant_id,
    userId: row.user_id,
    claimedEmail: row.email,
    event: "token.refreshed",
    outcome: "succeeded",
    ip: input.ip,
    userAgent: input.userAgent
  });

  return {
    ok: true,
    refresh,
    user: {
      userId: row.user_id,
      email: row.email,
      tenantId: row.tenant_id,
      tenantSlug: row.tenant_slug,
      tenantName: row.tenant_name,
      permissions: await loadPermissions(db, row.tenant_id, row.user_id)
    }
  };
}
