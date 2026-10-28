import { z } from "zod";
import { pageSchema, pageQuerySchema } from "./page";

/**
 * A user's account state.
 *
 * `invited` is a state in its own right, not a flavour of `pending`: the user
 * row exists with no credential from the moment an invitation is issued until
 * it is redeemed, and during that window the account genuinely cannot sign in.
 *
 * The database calls the third state `disabled` and the portal calls it
 * `suspended`. The API translates at its own boundary rather than renaming the
 * column, because `user_status_check` is referenced by a migration that has
 * already run everywhere.
 */
export const USER_STATUSES = ["active", "invited", "suspended"] as const;
export const userStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof userStatusSchema>;

/**
 * The address a removed user is left holding: `removed+<id>@invalid`.
 *
 * Removing an account releases its real address for reuse, and RFC 2606
 * reserves `.invalid` so the placeholder can never collide with one or receive
 * mail. It is not a well-formed address by `z.string().email()`'s rules — a bare
 * `.invalid` has no dot in the domain — so a response schema that insisted on
 * one rejected every removed account, and the portal reported a removal that
 * had succeeded as a failure.
 */
export const RELEASED_ADDRESS_PATTERN = /^removed\+[0-9a-f-]{36}@invalid$/i;

/** A user's address as a response carries it: a real one, or the placeholder. */
const userAddressSchema = z.union([
  z.string().email(),
  z.string().regex(RELEASED_ADDRESS_PATTERN)
]);

/** A user as the list screen renders it. */
export const userSummarySchema = z
  .object({
    id: z.string().uuid(),
    email: userAddressSchema,
    /**
     * Display name, or the email's local part when nobody has supplied one.
     *
     * Never null in the response even though the column is nullable: every
     * consumer would otherwise need the same fallback, and one of them would
     * render "null" in a table cell.
     */
    name: z.string(),
    /**
     * The user's primary role, as a role *name* rather than display text.
     *
     * A name, because the portal translates it at render — a response carrying
     * "Administrator" would print English on an Arabic screen, and a bare data
     * field is invisible to the untranslated-string check.
     */
    role: z.string(),
    status: userStatusSchema,
    tenantSlug: z.string(),
    /** ISO-8601, or null for someone invited who has never signed in. */
    lastSeenAt: z.string().nullable()
  })
  .strict();

export type UserSummary = z.infer<typeof userSummarySchema>;

export const userPageSchema = pageSchema(userSummarySchema);

/** Everything the user detail screen shows. */
/**
 * A D365 warehouse a user works in: the company it belongs to and its id there.
 *
 * `dataAreaId` and `companyName` are derived by the server from the company,
 * never accepted from a caller — see `userWarehouseInputSchema`.
 */
export const userWarehouseSchema = z
  .object({
    companyId: z.string().uuid(),
    companyName: z.string(),
    dataAreaId: z.string(),
    /** D365 `WarehouseId`, e.g. `11`. */
    warehouseId: z.string(),
    /** D365 `WarehouseName`, for display. */
    name: z.string()
  })
  .strict();

export type UserWarehouse = z.infer<typeof userWarehouseSchema>;

/** What a caller sends to assign one. The rest is resolved from the company. */
export const userWarehouseInputSchema = z
  .object({
    companyId: z.string().uuid(),
    warehouseId: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(200)
  })
  .strict();

export type UserWarehouseInput = z.infer<typeof userWarehouseInputSchema>;

/** `PUT /users/:id/warehouse`. Null clears it. */
export const setUserWarehouseSchema = z
  .object({ defaultWarehouse: userWarehouseInputSchema.nullable() })
  .strict();

export type SetUserWarehouseInput = z.infer<typeof setUserWarehouseSchema>;

/**
 * `GET /me`: what the signed-in user needs to know about themselves.
 *
 * Its own route, readable by any signed-in user, because a warehouse operator
 * holds no `user.read` and still needs their own warehouse.
 */
export const meSchema = z
  .object({
    userId: z.string().uuid(),
    defaultWarehouse: userWarehouseSchema.nullable()
  })
  .strict();

export type Me = z.infer<typeof meSchema>;

export const userDetailSchema = userSummarySchema
  .extend({
    /** Every role the user holds, by name. A user may hold several. */
    roles: z.array(z.string()),
    createdAt: z.string(),
    /** Who issued the invitation, or null for a tenant's first admin. */
    invitedBy: z.string().nullable(),
    /** The warehouse the mobile app starts this user on. */
    defaultWarehouse: userWarehouseSchema.nullable()
  })
  .strict();

export type UserDetail = z.infer<typeof userDetailSchema>;

/**
 * Listing users.
 *
 * There is no tenant parameter, and there must never be one: the tenant comes
 * from the access token's claims and row level security does the filtering. A
 * tenant a caller can name is a tenant a caller can iterate.
 */
export const userQuerySchema = pageQuerySchema.extend({
  /*
   * Omitted excludes suspended users rather than meaning "everything".
   *
   * Suspending is how an operator removes somebody — the account keeps its
   * history and can be reactivated, but it is meant to be gone from the working
   * list, and a remove that leaves the row in the table reads as one that did
   * not happen. `"all"` asks for them back, which is what keeps Reactivate
   * reachable.
   */
  status: z
    .union([userStatusSchema, z.literal("all")])
    .optional()
    .catch(undefined)
});

export type UserQuery = z.infer<typeof userQuerySchema>;

/**
 * Inviting a user.
 *
 * The role is a name rather than an id because the caller is choosing from the
 * tenant's role list, and names are what that list is keyed by on screen. The
 * API resolves it against the tenant's own roles, so an id belonging to another
 * tenant is not a thing this endpoint can be handed.
 */
export const inviteUserSchema = z
  .object({
    email: z.string().email(),
    role: z.string().min(1),
    /** Optional: the invitation is addressed to an email, not to a name. */
    name: z.string().min(1).max(200).optional(),
    /** Optional: the warehouse the mobile app starts them on. */
    defaultWarehouse: userWarehouseInputSchema.optional()
  })
  .strict();

export type InviteUserInput = z.infer<typeof inviteUserSchema>;

/**
 * What issuing an invitation returns.
 *
 * `token` appears exactly once, here. Only a digest is stored, so an invitation
 * that is lost is reissued rather than recovered — which means the screen has
 * to surface it at this moment or not at all.
 */
export const issuedUserInvitationSchema = z
  .object({
    user: userSummarySchema,
    token: z.string(),
    expiresAt: z.string()
  })
  .strict();

export type IssuedUserInvitation = z.infer<typeof issuedUserInvitationSchema>;

/**
 * Changing a user's account state.
 *
 * `invited` is not a target: it describes a user who has been sent an
 * invitation and not yet redeemed it, which is a consequence of the invitation
 * flow rather than something an administrator can assign.
 */
export const USER_STATUS_TARGETS = ["active", "suspended"] as const;

export const updateUserStatusSchema = z
  .object({
    status: z.enum(USER_STATUS_TARGETS)
  })
  .strict();

export type UpdateUserStatusInput = z.infer<typeof updateUserStatusSchema>;

/**
 * Replacing a user's roles.
 *
 * The whole set, not a delta. Two administrators editing the same user with
 * add/remove operations produce an order-dependent result; sending the intended
 * final set makes the last write win, which is at least a state someone chose.
 */
export const updateUserRolesSchema = z
  .object({
    roles: z.array(z.string().min(1))
  })
  .strict();

export type UpdateUserRolesInput = z.infer<typeof updateUserRolesSchema>;
