import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import { recordAuditEntry, type AuditActor } from "./audit";
import type { Queryable } from "./tenancy";

/**
 * Portal user invitations (US-020).
 *
 * Provisioning creates a tenant's first admin with no credential, so until this
 * exists nobody can sign in at all. An invitation is the only route from "a user
 * row exists" to "a person can authenticate".
 */

/** 256 bits of randomness. Long enough that guessing is not a threat model. */
const TOKEN_BYTES = 32;

/** How long an unaccepted invitation stays usable. */
export const DEFAULT_INVITATION_TTL_HOURS = 7 * 24;

/**
 * Argon2id parameters, following the OWASP baseline (19 MiB, 2 iterations, 1
 * lane). Deliberately slow: unlike the invitation token below, a password is
 * human-chosen and therefore guessable, so the cost of each guess is the
 * defence.
 */
export const PASSWORD_HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, PASSWORD_HASH_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // A malformed stored hash must read as "wrong password", never as a crash
    // that distinguishes this account from any other.
    return false;
  }
}

/**
 * Burns the same time a real password hash would, so a rejected attempt cannot
 * be recognised by how quickly it came back.
 *
 * Hashing a fresh random string rather than a fixed one, so the work cannot be
 * optimised away or cached.
 */
export async function burnPasswordHashingTime(): Promise<void> {
  await hashPassword(randomBytes(16).toString("hex"));
}

/** A single-use invitation token. Returned once; never stored, never logged. */
export function generateInvitationToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * The digest stored in place of the token.
 *
 * SHA-256 rather than Argon2id, deliberately. A slow KDF protects a guessable
 * secret; this token is 256 random bits, so there is nothing to guess, and
 * putting a 19 MiB hash on an unauthenticated lookup path would hand anyone a
 * denial-of-service lever.
 */
export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time digest comparison, for callers matching a candidate in memory. */
export function invitationTokenMatches(token: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashInvitationToken(token), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

/** Raised when a user already has a credential and cannot be re-invited. */
export class UserAlreadyActiveError extends Error {
  constructor(email: string) {
    super(`${email} already has an active account. Use password reset instead.`);
    this.name = "UserAlreadyActiveError";
  }
}

/**
 * Raised for every unusable token, whatever the reason.
 *
 * One error type on purpose: unknown, expired and already-accepted must be
 * indistinguishable to the caller (AC3). A per-reason error class is how that
 * distinction leaks out through a message or a status code.
 */
export class InvalidInvitationError extends Error {
  constructor() {
    super("That invitation link is not valid. Ask an administrator for a new one.");
    this.name = "InvalidInvitationError";
  }
}

export interface IssueInvitationInput {
  tenantId: string;
  email: string;
  actor: AuditActor;
  /** The inviting user, when there is one. Null for platform provisioning. */
  invitedBy?: string | null;
  ttlHours?: number;
}

export interface IssuedInvitation {
  id: string;
  userId: string;
  email: string;
  expiresAt: Date;
  /**
   * The only time this value exists outside the caller's hands. It is not
   * stored, not logged, and not recoverable — a lost invitation is reissued,
   * never looked up.
   */
  token: string;
}

/**
 * Invites an address into a tenant, creating the user if it does not exist.
 *
 * Runs on whatever client the caller supplies so it can join a surrounding
 * transaction — provisioning issues the first admin's invitation inside the
 * same transaction that creates the tenant.
 */
export async function issueInvitation(
  db: Queryable,
  input: IssueInvitationInput
): Promise<IssuedInvitation> {
  const email = input.email.trim();
  if (!email) {
    throw new Error("an invitation needs an email address");
  }

  // "user" is a reserved word, so it stays quoted.
  const existing = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM "user" WHERE tenant_id = $1 AND lower(email) = lower($2)`,
    [input.tenantId, email]
  );

  let userId = existing.rows[0]?.id;
  if (existing.rows[0]?.status === "active") {
    // Re-inviting someone who already has a password would be a password reset
    // wearing the wrong name, and a way to take over an account by inviting it.
    throw new UserAlreadyActiveError(email);
  }

  if (!userId) {
    const created = await db.query<{ id: string }>(
      `INSERT INTO "user" (tenant_id, email, status) VALUES ($1, $2, 'invited') RETURNING id`,
      [input.tenantId, email]
    );
    userId = created.rows[0].id;
  }

  const token = generateInvitationToken();
  const ttlHours = input.ttlHours ?? DEFAULT_INVITATION_TTL_HOURS;

  const invitation = await db.query<{ id: string; expires_at: Date }>(
    `INSERT INTO user_invitation (tenant_id, user_id, token_hash, expires_at, invited_by)
     VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval, $5)
     RETURNING id, expires_at`,
    [input.tenantId, userId, hashInvitationToken(token), String(ttlHours), input.invitedBy ?? null]
  );

  await recordAuditEntry(db, {
    tenantId: input.tenantId,
    action: "invitation.issued",
    entityType: "user_invitation",
    entityId: invitation.rows[0].id,
    actor: input.actor,
    before: null,
    // Deliberately no token, and no field whose name would carry one. The
    // shared redaction rule would catch `token`, but not storing it at all is
    // the guarantee that does not depend on a regex.
    after: { email, expiresAt: invitation.rows[0].expires_at }
  });

  return {
    id: invitation.rows[0].id,
    userId,
    email,
    expiresAt: invitation.rows[0].expires_at,
    token
  };
}

export interface AcceptInvitationInput {
  token: string;
  password: string;
  ip?: string | null;
}

export interface AcceptedInvitation {
  tenantId: string;
  userId: string;
  email: string;
}

/**
 * Accepts an invitation and sets the user's first password.
 *
 * Unauthenticated by necessity: the person accepting has no credential yet, and
 * the token is the only thing that says which tenant they are joining. It is
 * therefore the token, not a header or a slug, that resolves the tenant.
 */
export async function acceptInvitation(
  db: Queryable,
  input: AcceptInvitationInput
): Promise<AcceptedInvitation> {
  if (input.password.length < 12) {
    // Checked before the token is looked at, so a weak password fails the same
    // way whether or not the token was real.
    await burnPasswordHashingTime();
    throw new InvalidInvitationError();
  }

  const found = await db.query<{
    id: string;
    tenant_id: string;
    user_id: string;
    email: string;
    accepted_at: Date | null;
    expired: boolean;
    user_status: string;
  }>(
    `SELECT i.id, i.tenant_id, i.user_id, u.email, i.accepted_at,
            (i.expires_at <= now()) AS expired, u.status AS user_status
     FROM user_invitation i
     JOIN "user" u ON u.id = i.user_id
     WHERE i.token_hash = $1`,
    [hashInvitationToken(input.token)]
  );

  const invitation = found.rows[0];
  const usable =
    invitation !== undefined &&
    invitation.accepted_at === null &&
    !invitation.expired &&
    invitation.user_status !== "disabled";

  if (!usable) {
    // Unknown, expired, already accepted, disabled — one path, one error, and
    // the same amount of work, so none of them is distinguishable from outside.
    await burnPasswordHashingTime();
    throw new InvalidInvitationError();
  }

  const passwordHash = await hashPassword(input.password);

  await db.query(
    `UPDATE "user"
     SET password_hash = $1, password_changed_at = now(), status = 'active', updated_at = now()
     WHERE id = $2`,
    [passwordHash, invitation.user_id]
  );

  // Marked accepted after the password lands, so a failure between the two
  // leaves a usable invitation rather than a user who can never sign in.
  await db.query(`UPDATE user_invitation SET accepted_at = now() WHERE id = $1`, [invitation.id]);

  await recordAuditEntry(db, {
    tenantId: invitation.tenant_id,
    action: "invitation.accepted",
    entityType: "user",
    entityId: invitation.user_id,
    actor: { label: `user:${invitation.email}`, userId: invitation.user_id, ip: input.ip ?? null },
    before: { status: "invited", hasPassword: false },
    after: { status: "active", hasPassword: true }
  });

  return {
    tenantId: invitation.tenant_id,
    userId: invitation.user_id,
    email: invitation.email
  };
}
