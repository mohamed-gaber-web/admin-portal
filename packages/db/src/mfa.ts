import { createHash, randomBytes } from "node:crypto";
import { recordAuditEntry } from "./audit";
import { recordAuthEvent } from "./authentication";
import {
  base32Encode,
  decryptSecret,
  encryptSecret,
  generateTotpSecret,
  totpUri,
  verifyTotpCode
} from "./totp";
import type { Queryable } from "./tenancy";

/**
 * Multi-factor authentication (US-025).
 *
 * Three things have to be true at once for this to be worth having: the shared
 * secret must survive a database leak (so it is encrypted, not plain), a
 * recovery code must not become a permanent bypass (so they are hashed and
 * single use), and a code must not be replayable while it is still inside its
 * validity window (so spent time steps are recorded).
 */

/** How many recovery codes an enrolment issues. */
export const RECOVERY_CODE_COUNT = 10;

/** 100 bits per code — high enough entropy that a fast digest is appropriate. */
const RECOVERY_CODE_BYTES = 13;

/**
 * A recovery code, in the grouped form the user sees.
 *
 * Grouped for transcription, normalised away before hashing — someone reading
 * one off paper should not fail because they typed the dashes differently.
 */
export function generateRecoveryCode(): string {
  const raw = base32Encode(randomBytes(RECOVERY_CODE_BYTES)).slice(0, 20);
  return (raw.match(/.{1,5}/g) ?? []).join("-").toLowerCase();
}

export function normaliseRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

/** SHA-256 over the normalised code. 100 random bits have nothing to guess. */
export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normaliseRecoveryCode(code), "utf8").digest("hex");
}

export interface MfaEnrolment {
  /** Shown once, so the user can type it into an app that cannot scan. */
  secret: string;
  /** The `otpauth://` URI behind the QR code. */
  uri: string;
}

interface UserRow {
  id: string;
  tenant_id: string;
  email: string;
  mfa_secret: string | null;
  mfa_enabled_at: Date | null;
}

async function loadUser(db: Queryable, userId: string): Promise<UserRow | undefined> {
  const res = await db.query<UserRow>(
    'SELECT id, tenant_id, email, mfa_secret, mfa_enabled_at FROM "user" WHERE id = $1',
    [userId]
  );
  return res.rows[0];
}

/** Whether a user must present a second factor. */
export async function mfaIsEnabled(db: Queryable, userId: string): Promise<boolean> {
  const user = await loadUser(db, userId);
  return Boolean(user?.mfa_enabled_at);
}

/**
 * Starts enrolment: mints a secret and stores it encrypted, **without**
 * enabling anything.
 *
 * Enabling here would lock a user out of their own account the moment they
 * asked to enrol, before they had ever proved the app was configured. That is
 * what the confirmation step is for.
 */
export async function beginMfaEnrolment(
  db: Queryable,
  input: { userId: string }
): Promise<MfaEnrolment> {
  const user = await loadUser(db, input.userId);
  if (!user) {
    throw new Error("cannot enrol an unknown user in MFA");
  }
  if (user.mfa_enabled_at) {
    throw new MfaAlreadyEnabledError();
  }

  const secret = generateTotpSecret();
  await db.query('UPDATE "user" SET mfa_secret = $2, updated_at = now() WHERE id = $1', [
    user.id,
    encryptSecret(secret)
  ]);

  return { secret, uri: totpUri(secret, user.email) };
}

/** Raised when enrolment is attempted on an account that already has MFA. */
export class MfaAlreadyEnabledError extends Error {
  constructor() {
    super("Multi-factor authentication is already enabled for this account.");
    this.name = "MfaAlreadyEnabledError";
  }
}

/** Raised when a code cannot be accepted. One type, so causes stay indistinct. */
export class InvalidMfaCodeError extends Error {
  constructor() {
    super("That code is not valid.");
    this.name = "InvalidMfaCodeError";
  }
}

export interface ConfirmedMfaEnrolment {
  /** Returned exactly once. Only digests are kept. */
  recoveryCodes: string[];
}

/**
 * Completes enrolment against a code from the user's app, and issues recovery
 * codes.
 *
 * The code proves the app holds the same secret the server does — without it,
 * "enrolled" would mean "we generated a secret and hoped", and the first sign-in
 * would be the first time anyone found out it was wrong.
 */
export async function confirmMfaEnrolment(
  db: Queryable,
  input: { userId: string; code: string; ip?: string | null }
): Promise<ConfirmedMfaEnrolment> {
  const user = await loadUser(db, input.userId);
  if (!user) {
    throw new Error("cannot confirm MFA for an unknown user");
  }
  if (user.mfa_enabled_at) {
    throw new MfaAlreadyEnabledError();
  }

  const secret = user.mfa_secret ? decryptSecret(user.mfa_secret) : null;
  if (!secret) {
    // No enrolment in progress, or a secret this key cannot read.
    throw new InvalidMfaCodeError();
  }

  const step = verifyTotpCode(secret, input.code);
  if (step === null) {
    throw new InvalidMfaCodeError();
  }

  // The confirming code is spent like any other, so it cannot immediately be
  // replayed at the sign-in gate.
  await db.query(
    "INSERT INTO mfa_code_use (tenant_id, user_id, step) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [user.tenant_id, user.id, step]
  );

  await db.query('UPDATE "user" SET mfa_enabled_at = now(), updated_at = now() WHERE id = $1', [
    user.id
  ]);

  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i += 1) {
    const code = generateRecoveryCode();
    codes.push(code);
    await db.query(
      "INSERT INTO mfa_recovery_code (tenant_id, user_id, code_hash) VALUES ($1, $2, $3)",
      [user.tenant_id, user.id, hashRecoveryCode(code)]
    );
  }

  await recordAuditEntry(db, {
    tenantId: user.tenant_id,
    action: "mfa.enabled",
    entityType: "user",
    entityId: user.id,
    actor: { label: `user:${user.email}`, userId: user.id, ip: input.ip ?? null },
    before: { mfaEnabled: false },
    after: { mfaEnabled: true },
    // Named, not valued: the count is useful, the codes are credentials.
    context: { recoveryCodesIssued: RECOVERY_CODE_COUNT }
  });

  await recordAuthEvent(db, {
    tenantId: user.tenant_id,
    userId: user.id,
    claimedEmail: user.email,
    event: "mfa.enabled",
    outcome: "succeeded",
    ip: input.ip
  });

  return { recoveryCodes: codes };
}

export type MfaVerification =
  | { ok: true; method: "totp" | "recovery" }
  | { ok: false; reason: MfaFailure };

export type MfaFailure = "not_enrolled" | "invalid" | "replayed";

/**
 * Checks a second factor at the sign-in gate.
 *
 * Returns a result rather than throwing, for the reason every other
 * authentication path here does: the caller runs it in a transaction, and
 * throwing would roll back the `auth_event` recording the failed attempt.
 */
export async function verifyMfa(
  db: Queryable,
  input: { userId: string; code: string; ip?: string | null; userAgent?: string | null }
): Promise<MfaVerification> {
  const user = await loadUser(db, input.userId);

  const fail = async (reason: MfaFailure, detail: string): Promise<MfaVerification> => {
    await recordAuthEvent(db, {
      tenantId: user?.tenant_id ?? null,
      userId: user?.id ?? null,
      claimedEmail: user?.email ?? null,
      event: "mfa.failed",
      outcome: "failed",
      reason: detail,
      ip: input.ip,
      userAgent: input.userAgent
    });
    return { ok: false, reason };
  };

  if (!user || !user.mfa_enabled_at || !user.mfa_secret) {
    return fail("not_enrolled", "user is not enrolled in MFA");
  }

  const secret = decryptSecret(user.mfa_secret);
  if (!secret) {
    // The stored secret does not decrypt — a rotated or wrong AUTH_MFA_KEY.
    // Fail closed: the alternative is letting anyone past the second factor.
    return fail("invalid", "stored MFA secret could not be decrypted");
  }

  const step = verifyTotpCode(secret, input.code);

  if (step !== null) {
    // AC3. The unique constraint is the enforcement: two presentations of one
    // code race the same INSERT, and only one can win it. A SELECT-then-INSERT
    // would let both through.
    //
    // ON CONFLICT rather than catching the violation: a raised unique error
    // aborts the surrounding transaction, and every statement after it — the
    // auth_event recording the replay included — would then fail too, turning a
    // correctly detected replay into a 500.
    const claimed = await db.query(
      `INSERT INTO mfa_code_use (tenant_id, user_id, step) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, step) DO NOTHING
       RETURNING id`,
      [user.tenant_id, user.id, step]
    );

    if (claimed.rowCount === 0) {
      return fail("replayed", `TOTP code for step ${step} was already used`);
    }

    await recordAuthEvent(db, {
      tenantId: user.tenant_id,
      userId: user.id,
      claimedEmail: user.email,
      event: "mfa.succeeded",
      outcome: "succeeded",
      reason: "totp",
      ip: input.ip,
      userAgent: input.userAgent
    });
    return { ok: true, method: "totp" };
  }

  // Not a valid TOTP code — it may still be a recovery code. Consumed with a
  // conditional UPDATE so two simultaneous uses cannot both claim it.
  const consumed = await db.query<{ id: string }>(
    `UPDATE mfa_recovery_code SET used_at = now()
     WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
     RETURNING id`,
    [user.id, hashRecoveryCode(input.code)]
  );

  if (consumed.rowCount === 1) {
    await recordAuthEvent(db, {
      tenantId: user.tenant_id,
      userId: user.id,
      claimedEmail: user.email,
      event: "mfa.succeeded",
      outcome: "succeeded",
      // Worth distinguishing: a recovery code means someone lost their phone,
      // or someone is using one they should not have.
      reason: "recovery code",
      ip: input.ip,
      userAgent: input.userAgent
    });
    return { ok: true, method: "recovery" };
  }

  return fail("invalid", "invalid MFA code");
}

/** Recovery codes a user has left. Zero is worth warning them about. */
export async function countUnusedRecoveryCodes(db: Queryable, userId: string): Promise<number> {
  const res = await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM mfa_recovery_code WHERE user_id = $1 AND used_at IS NULL",
    [userId]
  );
  return res.rows[0]?.count ?? 0;
}
