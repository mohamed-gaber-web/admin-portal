/** A user row as the users screen renders it. */
export interface UserSummary {
  id: string;
  email: string;
  name: string;
  /**
   * The user's primary role, as a role *name* (`admin`, `viewer`) rather than
   * display text.
   *
   * Names, because the list has to render it translated and a fixture holding
   * "Owner" would print English on an Arabic screen — a bare data field is
   * invisible to the untranslated-string check, so it would have shipped
   * unnoticed. Resolved through the tenant's roles at render.
   */
  role: string;
  status: UserStatus;
  tenantSlug: string;
  /** ISO-8601, or null for someone who has been invited but never signed in. */
  lastSeenAt: string | null;
}

/**
 * `invited` is a real state, not a flavour of `pending`: provisioning creates a
 * user row with no credential, so between the invitation and its redemption the
 * account exists and cannot sign in. The list has to be able to say so.
 */
export type UserStatus = "active" | "invited" | "suspended";

export const USER_STATUSES: readonly UserStatus[] = [
  "active",
  "invited",
  "suspended"
];

/** Everything the user detail screen shows. */
export interface UserDetail extends UserSummary {
  /** Role names, as held in the owning tenant. A user may hold several. */
  roles: string[];
  createdAt: string;
  /** Who issued the invitation, or null for the tenant's first admin. */
  invitedBy: string | null;
}

/**
 * What can be done to a user in each state.
 *
 * Same shape as the tenant lifecycle table, and for the same reason: a status
 * with no legal transition to itself, expressed as data so the illegal
 * combinations cannot be rendered.
 *
 * An `invited` user has no credential yet, so there is nothing to suspend —
 * reissuing the invitation is the only thing that helps them.
 */
export type UserAction = "suspend" | "reactivate" | "resendInvitation";

export const USER_ACTIONS_BY_STATUS: Record<UserStatus, UserAction[]> = {
  active: ["suspend"],
  invited: ["resendInvitation"],
  suspended: ["reactivate"]
};
