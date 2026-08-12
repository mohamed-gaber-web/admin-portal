import { z } from "zod";

/**
 * Payload accepted when signing in.
 *
 * `slug` is required because `user.email` is unique per tenant, not globally —
 * one address may exist in several tenants, so email alone does not identify a
 * person.
 */
export const signInSchema = z.object({
  slug: z.string().min(1),
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
    tenant: z.object({ id: z.string().uuid(), slug: z.string() }).strict(),
    accessToken: z.string().min(1),
    tokenType: z.literal("Bearer"),
    expiresIn: z.number().int().positive(),
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
 * Payload accepted when asking for a reset link.
 *
 * The slug is required for the same reason sign-in needs it: an address is not
 * an identity here, it is an identity *within a tenant*.
 */
export const requestPasswordResetSchema = z.object({
  slug: z.string().min(1),
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
