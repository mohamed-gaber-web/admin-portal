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
