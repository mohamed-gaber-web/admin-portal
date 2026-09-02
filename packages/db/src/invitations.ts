import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { argon2id, argon2Verify } from "hash-wasm";
import { recordAuditEntry, type AuditActor } from "./audit";
import { assertSeatAvailable } from "./modules";
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
 * Shortest password this layer accepts, enforced server-side.
 *
 * Duplicated from `MIN_PASSWORD_LENGTH` in `@growpath/contracts` rather than
 * imported: this package does not depend on the contracts package, and adding
 * that dependency to share one integer would invert the layering — contracts
 * describes the HTTP surface, and this is the last line of defence behind it.
 *
 * The two must agree, so a contract test asserts it. That is deliberately a
 * test rather than a type: the schema rejecting a short password at the edge
 * and the database accepting it would be a silent hole, and the failure worth
 * having is a red build rather than a runtime surprise.
 */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Argon2id parameters, following the OWASP baseline (19 MiB, 2 iterations, 1
 * lane). Deliberately slow: unlike the invitation token below, a password is
 * human-chosen and therefore guessable, so the cost of each guess is the
 * defence.
 *
 * Unchanged from when this used the native `argon2` package, and that matters
 * more than it looks — see the note on the implementation below. Changing any
 * value here does not invalidate stored hashes (each one records the parameters
 * it was made with) but it does mean old and new hashes cost different amounts
 * to verify.
 */
export const PASSWORD_HASH_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  /** 128 bits, the argon2 default. Recorded inside the hash string. */
  saltBytes: 16,
  /** 256 bits, the argon2 default. */
  hashLength: 32
} as const;

/**
 * Argon2id, in WebAssembly rather than a native binding.
 *
 * The algorithm, the parameters and the stored format are identical to what the
 * native `argon2` package produced — a PHC string, `$argon2id$v=19$m=19456,t=2,p=1$…`,
 * which is a documented interchange format and not one library's private
 * encoding. **Hashes written before this change verify unchanged**, because the
 * hash carries its own parameters and both implementations read the same string.
 *
 * The reason for the swap is deployment, not cryptography: `argon2` ships a
 * prebuilt, unsigned `.node` binary, and Windows Smart App Control refuses to
 * load unsigned native code. On a machine where that policy is enforced — as it
 * is on managed devices, by an administrator rather than by the developer — the
 * entire API failed to boot at `require`, because this module is imported on
 * every path that touches a user. A password hash is not worth a dependency
 * that can be switched off by a group policy.
 *
 * WebAssembly is slower than the native binding, roughly two to three times, and
 * for this function that is a feature rather than a cost: the whole point of
 * these parameters is to make each guess expensive.
 */
export async function hashPassword(password: string): Promise<string> {
  return argon2id({
    password,
    salt: randomBytes(PASSWORD_HASH_OPTIONS.saltBytes),
    parallelism: PASSWORD_HASH_OPTIONS.parallelism,
    iterations: PASSWORD_HASH_OPTIONS.timeCost,
    memorySize: PASSWORD_HASH_OPTIONS.memoryCost,
    hashLength: PASSWORD_HASH_OPTIONS.hashLength,
    // The PHC string, so the parameters travel with the hash and a later change
    // to the constants above cannot make old hashes unverifiable.
    outputType: "encoded"
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash });
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

/**
 * Raised when the address already belongs to somebody in another tenant.
 *
 * `user.email` became a global identity in the global-email-identity migration:
 * one address is one person, so a consultant working for two customers needs two
 * addresses. Without this the unique index surfaces as a driver error and a 500
 * — which tells the caller nothing, when the actual answer is short and
 * actionable.
 *
 * Distinct from `UserAlreadyActiveError`, which is about *this* tenant and has a
 * different remedy: there, the person already has an account here and wants a
 * password reset; here, the address is spoken for somewhere they cannot see.
 */
export class EmailAlreadyInUseError extends Error {
  readonly email: string;

  constructor(email: string) {
    super(
      `${email} is already in use. An email address identifies one person across the whole installation, so it cannot be invited into a second workspace.`
    );
    this.name = "EmailAlreadyInUseError";
    this.email = email;
  }
}

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";

/** True for the global email index, and not for any other unique violation. */
function isDuplicateEmail(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const candidate = err as { code?: unknown; constraint?: unknown };
  return (
    candidate.code === UNIQUE_VIOLATION &&
    typeof candidate.constraint === "string" &&
    candidate.constraint.includes("email")
  );
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
    /**
     * The seat check, and only on this branch.
     *
     * Re-inviting somebody who is already `invited` reaches here with a
     * `userId` and skips it, which is deliberate: that person already occupies
     * a seat, so reissuing their link consumes nothing. Refusing it would strand
     * the one user a full tenant most needs to fix — the administrator whose
     * invitation expired before they accepted it.
     *
     * Inside the caller's transaction, immediately before the insert, so the
     * window between reading the count and taking the seat is as small as a
     * statement. See `assertSeatAvailable` for what that does and does not
     * guarantee.
     */
    await assertSeatAvailable(db, input.tenantId);

    let created;
    try {
      created = await db.query<{ id: string }>(
        `INSERT INTO "user" (tenant_id, email, status) VALUES ($1, $2, 'invited') RETURNING id`,
        [input.tenantId, email]
      );
    } catch (err) {
      // The address belongs to somebody in another tenant. The lookup above
      // only saw this tenant's rows — by design, since that is the question it
      // is asking — so this is where the global index speaks.
      if (isDuplicateEmail(err)) throw new EmailAlreadyInUseError(email);
      throw err;
    }
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
  if (input.password.length < MIN_PASSWORD_LENGTH) {
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
