import { z } from "zod";

/**
 * Payload accepted when signing in.
 *
 * An address and a password, and nothing else. `user.email` is unique across the
 * installation (see the global-email-identity migration), so the address
 * identifies one person and the API resolves their workspace from it — which is
 * strictly better than taking a slug, because a tenant identifier the caller
 * sends is a tenant identifier the caller can iterate.
 *
 * The workspace comes back in `authenticatedSchema.tenant`.
 */
export const signInSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1)
});

export type SignInInput = z.infer<typeof signInSchema>;

/**
 * What a successful sign-in returns.
 *
 * The access token (US-022) is the only thing that authorises a later request,
 * and the only thing that says which tenant it belongs to. `expiresIn` is
 * seconds, and deliberately small: permissions are stamped into the token at
 * sign-in, so it is the expiry that bounds how long a revoked permission keeps
 * working.
 *
 * The refresh token is US-023; until then a session ends when the access token
 * does.
 *
 * `strict()` so a field added later fails the contract test rather than
 * silently widening what an unauthenticated caller can learn.
 */
export const authenticatedSchema = z
  .object({
    status: z.literal("authenticated"),
    user: z.object({ id: z.string().uuid(), email: z.string() }).strict(),
    /**
     * The workspace this sign-in landed in.
     *
     * `name` alongside the slug, and it is load-bearing rather than cosmetic:
     * the caller no longer tells the API which workspace they meant, so this is
     * the only place they find out. A slug is an identifier — `name` is what
     * somebody recognises as their own organisation.
     */
    tenant: z
      .object({ id: z.string().uuid(), slug: z.string(), name: z.string() })
      .strict(),
    accessToken: z.string().min(1),
    tokenType: z.literal("Bearer"),
    expiresIn: z.number().int().positive(),
    /**
     * What this session may do, mirroring the token's own `permissions` claim.
     *
     * Returned so a client can decide what to *render* — whether to show the
     * platform section of the navigation, for instance. It discloses nothing
     * new: the same list is already in the JWT payload, which is base64, not
     * encrypted, and readable by whoever holds the token.
     *
     * It is not an authorisation decision, and no server-side check reads it
     * back. The API re-checks every request against the signed claim, so a
     * client that edits this array changes which buttons it draws and nothing
     * else.
     */
    permissions: z.array(z.string()),
    /**
     * Exchanged at `/auth/refresh` for a new pair (US-023). Single use: the
     * token returned here stops working the moment it is exchanged, and
     * presenting it twice signs the whole session out.
     */
    refreshToken: z.string().min(1),
    refreshExpiresIn: z.number().int().positive()
  })
  .strict();

export type Authenticated = z.infer<typeof authenticatedSchema>;

/**
 * Payload accepted when exchanging a refresh token.
 *
 * The token travels in the body rather than a cookie, matching how the access
 * token is returned — the Ionic app is a first-class client here and has no
 * cookie jar. A browser client should keep it out of `localStorage`; moving it
 * to an httpOnly cookie is a portal-side decision that does not change this
 * contract.
 */
export const refreshSchema = z.object({
  refreshToken: z.string().min(1)
});

export type RefreshInput = z.infer<typeof refreshSchema>;

/**
 * Payload accepted when signing out.
 *
 * The same field `refresh` takes, and for the same reason: the refresh token is
 * what names a session. The access token cannot serve here — it may already have
 * expired, and it carries no reference to the family it was issued alongside.
 */
export const logoutSchema = z.object({
  refreshToken: z.string().min(1)
});

export type LogoutInput = z.infer<typeof logoutSchema>;

/**
 * Payload accepted when asking for a reset link.
 *
 * The address alone, for the same reason sign-in takes it alone: it is the
 * identity. Asking for a slug here would also be worse than useless — someone
 * who has forgotten their password is exactly the person least likely to
 * remember which slug their workspace uses.
 */
export const requestPasswordResetSchema = z.object({
  email: z.string().min(1)
});

export type RequestPasswordResetInput = z.infer<typeof requestPasswordResetSchema>;

/**
 * What a reset request returns — always this, whatever happened.
 *
 * There is deliberately no field that could differ between "we sent a link" and
 * "there is no such account". A boolean here, however well-intentioned, is an
 * account-enumeration oracle.
 */
export const passwordResetRequestedSchema = z
  .object({
    status: z.literal("accepted")
  })
  .strict();

export type PasswordResetRequested = z.infer<typeof passwordResetRequestedSchema>;

/** Payload accepted when redeeming a reset link. */
export const completePasswordResetSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(12)
});

export type CompletePasswordResetInput = z.infer<typeof completePasswordResetSchema>;

/**
 * What redeeming a reset returns.
 *
 * No session: every refresh token was just revoked, and handing back a fresh
 * one would undo the revocation for whoever redeemed the link. They sign in
 * again with the new password, which is also a check that they know it.
 */
export const passwordResetCompletedSchema = z
  .object({
    status: z.literal("reset"),
    email: z.string()
  })
  .strict();

export type PasswordResetCompleted = z.infer<typeof passwordResetCompletedSchema>;

/**
 * What sign-in returns when the account has MFA enabled (US-025).
 *
 * Deliberately carries no access token and no refresh token — a correct
 * password alone must not reach tenant data, which is the entire point of the
 * second factor. The challenge token can be exchanged for nothing except an
 * MFA verification.
 */
export const mfaRequiredSchema = z
  .object({
    status: z.literal("mfa_required"),
    challengeToken: z.string().min(1),
    expiresIn: z.number().int().positive()
  })
  .strict();

export type MfaRequired = z.infer<typeof mfaRequiredSchema>;

/**
 * Everything sign-in can answer.
 *
 * A discriminated union rather than optional fields: a client cannot read
 * `accessToken` off an `mfa_required` response, because on that branch the type
 * does not have one.
 */
export const signInResponseSchema = z.discriminatedUnion("status", [
  authenticatedSchema,
  mfaRequiredSchema
]);

export type SignInResponse = z.infer<typeof signInResponseSchema>;

/** Payload accepted when answering an MFA challenge. */
export const verifyMfaSchema = z.object({
  challengeToken: z.string().min(1),
  /** A six-digit TOTP code, or a recovery code. */
  code: z.string().min(1)
});

export type VerifyMfaInput = z.infer<typeof verifyMfaSchema>;

/** What starting an enrolment returns. Shown once and never again. */
export const mfaEnrolmentSchema = z
  .object({
    status: z.literal("enrolment_started"),
    secret: z.string().min(1),
    uri: z.string().min(1)
  })
  .strict();

export type MfaEnrolmentStarted = z.infer<typeof mfaEnrolmentSchema>;

/** Payload accepted when confirming an enrolment. */
export const confirmMfaSchema = z.object({
  code: z.string().min(1)
});

export type ConfirmMfaInput = z.infer<typeof confirmMfaSchema>;

/**
 * What confirming an enrolment returns.
 *
 * The recovery codes appear here and nowhere else, ever — only their digests
 * are stored, so there is no endpoint that could show them again.
 */
export const mfaEnabledSchema = z
  .object({
    status: z.literal("mfa_enabled"),
    recoveryCodes: z.array(z.string().min(1)).min(1)
  })
  .strict();

export type MfaEnabled = z.infer<typeof mfaEnabledSchema>;
