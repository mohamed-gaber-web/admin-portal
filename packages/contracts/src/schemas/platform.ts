import { z } from "zod";

/**
 * The operator tier's own administration.
 *
 * Two things a super administrator needs that no other screen provides:
 * creating another one, and seeing the permission catalogue whole.
 */

/**
 * Creating a platform administrator.
 *
 * Only an address and an optional name. No password field, deliberately: the
 * account is created with no credential and an invitation, exactly as
 * `pnpm platform-admin` does it from a shell. A form that set a colleague's
 * password would mean one operator knowing another's credential, which defeats
 * the point of having named operators at all.
 */
/**
 * Inviting a user into a named tenant, from the platform tier (US-073).
 *
 * `tenantId` in the body is the whole difference from `inviteUserSchema`, and it
 * is why this schema lives here rather than beside it: on a tenant-scoped route
 * a caller-supplied tenant is the US-012 mistake, and putting the two shapes
 * next to each other is how one ends up wired to the other's controller.
 *
 * `role` is a name, not an id — role ids are tenant-scoped and an operator
 * standing outside the tenant holds none of them. The API resolves the name
 * inside the target tenant and refuses one that tenant does not have, so this
 * cannot be used to attach a role belonging to somebody else.
 */
export const invitePlatformUserSchema = z
  .object({
    tenantId: z.string().uuid(),
    email: z.string().email(),
    role: z.string().min(1),
    /** Optional: the invitation is addressed to an email, not to a name. */
    name: z.string().min(1).max(200).optional()
  })
  .strict();

export type InvitePlatformUserInput = z.infer<typeof invitePlatformUserSchema>;

export const createPlatformAdminSchema = z
  .object({
    email: z.string().email(),
    name: z.string().min(1).optional()
  })
  .strict();

export type CreatePlatformAdminInput = z.infer<typeof createPlatformAdminSchema>;

/**
 * What creating one returns.
 *
 * The invitation token appears here once and never again — only its digest is
 * stored, so a lost token is reissued rather than recovered, and the dialog has
 * to surface it at that moment or not at all. Same contract as tenant
 * provisioning, for the same reason.
 *
 * `invitation` is null when the address already belonged to an active operator.
 * That is not an error and must not be reported as one: re-running this for
 * somebody who already has a credential and issuing them a fresh invitation
 * would be an account takeover dressed as a convenience.
 */
export const platformAdminCreatedSchema = z
  .object({
    user: z.object({ id: z.string().uuid(), email: z.string() }).strict(),
    /** True when this call created the account rather than finding it. */
    created: z.boolean(),
    invitation: z
      .object({
        id: z.string().uuid(),
        expiresAt: z.string(),
        token: z.string()
      })
      .strict()
      .nullable()
  })
  .strict();

export type PlatformAdminCreated = z.infer<typeof platformAdminCreatedSchema>;

/** One operator, as the list renders them. */
export const platformAdminSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string(),
    name: z.string().nullable(),
    /** `active` once they have accepted their invitation; `invited` before. */
    status: z.string(),
    lastLoginAt: z.string().nullable(),
    createdAt: z.string()
  })
  .strict();

export type PlatformAdmin = z.infer<typeof platformAdminSchema>;

export const platformAdminListSchema = z.array(platformAdminSchema);

/**
 * One permission in the catalogue, as the reference screen shows it.
 *
 * Read-only everywhere. `permission` is not tenant-scoped and the application
 * holds `SELECT` on it and nothing else — the row-level-security migration
 * grants exactly that — so there is no endpoint that could create or rename one,
 * and this schema deliberately has no counterpart for writing.
 */
export const catalogPermissionSchema = z
  .object({
    key: z.string(),
    /** English text from a global table. The portal prefers its own label key. */
    description: z.string(),
    /** True for a `platform.*` key: one that reaches across every tenant. */
    platform: z.boolean(),
    /**
     * How many roles across the installation hold it.
     *
     * The reason this screen is worth having rather than being a static list in
     * the documentation: it answers "is anybody actually using this", which is
     * the question asked before a permission is retired.
     */
    roleCount: z.number().int().nonnegative()
  })
  .strict();

export type CatalogPermission = z.infer<typeof catalogPermissionSchema>;

export const catalogPermissionListSchema = z.array(catalogPermissionSchema);
