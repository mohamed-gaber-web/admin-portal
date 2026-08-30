import { createHash, randomBytes } from "node:crypto";
import { recordAuditEntry } from "./audit";
import { recordAuthEvent } from "./authentication";
import { hashPassword, MIN_PASSWORD_LENGTH } from "./invitations";
import type { Queryable } from "./tenancy";

/**
 * Password reset (US-024).
 *
 * Two endpoints with opposite disclosure rules. Requesting a reset must reveal
 * nothing — it is the one place a careless implementation hands out the user
 * list, by answering differently for an address that exists. Completing one may
 * be strict, because by then the caller has proved they hold a token.
 */

/** 256 bits, like every other token here. Guessing is not a threat model. */
const TOKEN_BYTES = 32;

/**
 * How long a reset link stays usable.
 *
 * Shorter than an invitation's week: a reset is requested by someone sitting at
 * their inbox right now, and the link is a full account takeover for as long as
 * it lives.
 */
export const DEFAULT_RESET_TTL_HOURS = 1;

/**
 * The one message a completed-reset failure returns.
 *
 * Unknown, expired and already-used are indistinguishable, for the same reason
 * they are on invitations: a per-reason message tells the holder of a guessed
 * token whether it was ever real.
 */
export class InvalidPasswordResetError extends Error {
  constructor() {
    super("That reset link is not valid. Request a new one.");
    this.name = "InvalidPasswordResetError";
  }
}

export function generateResetToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** SHA-256, not Argon2id — 256 random bits have nothing to guess. */
export function hashResetToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface RequestPasswordResetInput {
  /** The whole of the supplied identity, as at sign-in. No slug. */
  email: string;
  ip?: string | null;
  userAgent?: string | null;
  ttlHours?: number;
}

export interface IssuedPasswordReset {
  id: string;
  tenantId: string;
  userId: string;
  email: string;
  token: string;
  expiresAt: Date;
}

interface CandidateRow {
  tenant_id: string;
  user_id: string;
  email: string;
  status: string;
  tenant_deleted_at: Date | null;
}

/**
 * Issues a reset token, or quietly does nothing.
 *
 * Returns null when there is no account to reset — an unknown address, an
 * archived tenant, or a user who has never accepted an invitation and so has no
 * password to replace. **The caller must answer identically either way** (AC1);
 * this returning null is not an error and must not become one.
 *
 * The attempt is recorded in `auth_event` regardless, so a sweep through a
 * tenant's likely addresses is visible to an operator even though it is
 * invisible to the person doing it.
 */
export async function requestPasswordReset(
  db: Queryable,
  input: RequestPasswordResetInput
): Promise<IssuedPasswordReset | null> {
  const email = input.email.trim();

  // Keyed on the address alone, matching sign-in: it is unique across the
  // installation, so it resolves the tenant rather than needing one supplied.
  const candidate = await db.query<CandidateRow>(
    `SELECT t.id AS tenant_id, u.id AS user_id, u.email, u.status,
            t.deleted_at AS tenant_deleted_at
     FROM "user" u
     JOIN tenant t ON t.id = u.tenant_id
     WHERE lower(u.email) = lower($1)`,
    [email]
  );

  const row = candidate.rows[0];
  const eligible = Boolean(row) && row.status === "active" && !row.tenant_deleted_at;

  if (!eligible) {
    await recordAuthEvent(db, {
      tenantId: row?.tenant_id ?? null,
      userId: row?.user_id ?? null,
      claimedSlug: null,
      claimedEmail: email,
      event: "password_reset.requested",
      outcome: "failed",
      reason: !row
        ? "no such user"
        : row.tenant_deleted_at
          ? "tenant archived"
          : "user not active",
      ip: input.ip,
      userAgent: input.userAgent
    });
    return null;
  }

  const token = generateResetToken();
  const ttlHours = input.ttlHours ?? DEFAULT_RESET_TTL_HOURS;

  const res = await db.query<{ id: string; expires_at: Date }>(
    `INSERT INTO password_reset (tenant_id, user_id, token_hash, expires_at, requested_ip)
     VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval, $5)
     RETURNING id, expires_at`,
    [row.tenant_id, row.user_id, hashResetToken(token), String(ttlHours), input.ip ?? null]
  );

  await recordAuthEvent(db, {
    tenantId: row.tenant_id,
    userId: row.user_id,
    claimedSlug: null,
    claimedEmail: email,
    event: "password_reset.requested",
    outcome: "succeeded",
    ip: input.ip,
    userAgent: input.userAgent
  });

  return {
    id: res.rows[0].id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    email: row.email,
    token,
    expiresAt: res.rows[0].expires_at
  };
}

export interface CompletePasswordResetInput {
  token: string;
  password: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface CompletedPasswordReset {
  tenantId: string;
  userId: string;
  email: string;
  /** Refresh tokens killed by the reset. Zero is normal for an idle account. */
  revokedSessions: number;
}

interface ResetRow {
  id: string;
  tenant_id: string;
  user_id: string;
  expires_at: Date;
  used_at: Date | null;
  email: string;
  status: string;
  password_hash: string | null;
  tenant_deleted_at: Date | null;
}

export type PasswordResetResult =
  | { ok: true; reset: CompletedPasswordReset }
  | { ok: false };

/**
 * Redeems a reset token and replaces the password.
 *
 * Must run inside a transaction: the row is locked FOR UPDATE so two
 * simultaneous redemptions of one token cannot both set a password, and the
 * password write, the token burn and the session revocation either all land or
 * none do. A password changed without its sessions revoked is the failure this
 * story is guarding against.
 *
 * Returns a result rather than throwing, for the same reason `authenticate` and
 * `rotateRefreshToken` do: the caller runs this in a transaction, and throwing
 * from inside would roll back the `auth_event` recording the refusal — which is
 * the whole of AC3.
 */
export async function completePasswordReset(
  db: Queryable,
  input: CompletePasswordResetInput
): Promise<PasswordResetResult> {
  if (input.password.length < MIN_PASSWORD_LENGTH) {
    // Checked before the token is looked at, so a weak password fails the same
    // way whether or not the token was real.
    return { ok: false };
  }

  const candidate = await db.query<ResetRow>(
    `SELECT pr.id, pr.tenant_id, pr.user_id, pr.expires_at, pr.used_at,
            u.email, u.status, u.password_hash, t.deleted_at AS tenant_deleted_at
     FROM password_reset pr
     JOIN "user" u ON u.id = pr.user_id
     JOIN tenant t ON t.id = pr.tenant_id
     WHERE pr.token_hash = $1
     FOR UPDATE OF pr`,
    [hashResetToken(input.token)]
  );

  const row = candidate.rows[0];

  // AC3: every refusal is recorded, and every refusal reads the same outward.
  const refuse = async (reason: string): Promise<{ ok: false }> => {
    await recordAuthEvent(db, {
      tenantId: row?.tenant_id ?? null,
      userId: row?.user_id ?? null,
      event: "password_reset.failed",
      outcome: "failed",
      reason,
      ip: input.ip,
      userAgent: input.userAgent
    });
    return { ok: false };
  };

  if (!row) {
    return refuse("unknown reset token");
  }
  if (row.used_at) {
    return refuse("reset token already used");
  }
  if (row.expires_at.getTime() <= Date.now()) {
    return refuse("reset token expired");
  }
  if (row.status === "disabled" || row.tenant_deleted_at) {
    return refuse("user or tenant no longer active");
  }

  const passwordHash = await hashPassword(input.password);

  await db.query(
    `UPDATE "user"
     SET password_hash = $2, password_changed_at = now(), status = 'active',
         failed_login_count = 0, updated_at = now()
     WHERE id = $1`,
    [row.user_id, passwordHash]
  );

  await db.query("UPDATE password_reset SET used_at = now() WHERE id = $1", [row.id]);

  // Every family, not just one: a reset is what someone does when they believe
  // the account is compromised, and leaving the attacker's session alive would
  // make the reset theatre.
  const revoked = await db.query(
    `UPDATE refresh_token SET revoked_at = now(), revoked_reason = 'password reset'
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [row.user_id]
  );

  // Also burn any other outstanding reset links, so a second email cannot be
  // redeemed after this one.
  await db.query(
    "UPDATE password_reset SET used_at = now() WHERE user_id = $1 AND used_at IS NULL",
    [row.user_id]
  );

  // The tenant is known by now, so this belongs in the audit log as well as
  // auth_event. Both values are redacted on the way in — the entry records
  // *that* the credential changed, never either side of it.
  await recordAuditEntry(db, {
    tenantId: row.tenant_id,
    action: "password.reset",
    entityType: "user",
    entityId: row.user_id,
    actor: { label: `user:${row.email}`, userId: row.user_id, ip: input.ip ?? null },
    before: { passwordHash: row.password_hash },
    after: { passwordHash },
    context: { revokedSessions: revoked.rowCount ?? 0 }
  });

  await recordAuthEvent(db, {
    tenantId: row.tenant_id,
    userId: row.user_id,
    claimedEmail: row.email,
    event: "password_reset.completed",
    outcome: "succeeded",
    ip: input.ip,
    userAgent: input.userAgent
  });

  return {
    ok: true,
    reset: {
      tenantId: row.tenant_id,
      userId: row.user_id,
      email: row.email,
      revokedSessions: revoked.rowCount ?? 0
    }
  };
}
