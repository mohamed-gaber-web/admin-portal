import { z } from "zod";

/**
 * Minimum password length.
 *
 * Length over composition rules: forced symbols and digits push people toward
 * "Password1!" while a longer passphrase is both stronger and easier to keep.
 */
export const MIN_PASSWORD_LENGTH = 12;

/** Payload accepted when redeeming an invitation. */
export const acceptInvitationSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(MIN_PASSWORD_LENGTH)
});

export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

/**
 * What redeeming an invitation returns.
 *
 * Deliberately thin. The account now exists and can sign in; anything more —
 * roles, tenant name, a session — belongs to US-021 and US-022, and returning
 * it here would hand data to a caller who has not yet authenticated.
 */
export const acceptedInvitationSchema = z
  .object({
    status: z.literal("accepted"),
    email: z.string().email()
  })
  .strict();

export type AcceptedInvitation = z.infer<typeof acceptedInvitationSchema>;

/**
 * An issued invitation, as returned to whoever created it.
 *
 * `token` appears exactly once, in the response that creates it. It is stored
 * only as a digest, so it cannot be read back afterwards — a lost invitation is
 * reissued, never recovered.
 */
export const issuedInvitationSchema = z.object({
  id: z.string().uuid(),
  expiresAt: z.string(),
  token: z.string()
});

export type IssuedInvitation = z.infer<typeof issuedInvitationSchema>;
