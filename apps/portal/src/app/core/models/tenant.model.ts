/**
 * A tenant as the portal's list and detail screens need it.
 *
 * Wider than `ProvisionedTenant` from the contracts package, which describes
 * only what provisioning returns. When the API grows a `GET /tenants`, this
 * shape is what its response schema should be held to.
 */
export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  plan: TenantPlan;
  userCount: number;
  /**
   * Seats the tenant's package includes.
   *
   * Beside `userCount` so every screen that shows one can show the other. The
   * pair is the useful fact — "24 users" says nothing an operator can act on,
   * and "24 of 25" says a customer is one hire away from being stuck.
   */
  userLimit: number;
  /**
   * The tenant's own negotiated allowance, or null when it inherits its package.
   *
   * `userLimit` above is always the effective number, so every screen that only
   * renders a limit reads that one. This exists for the screen that *edits* the
   * allowance, which has to distinguish "40, because somebody agreed to 40" from
   * "25, because that is what Growth includes".
   */
  seatLimitOverride: number | null;
  /** The tenant's admin address, for an operator who needs to contact them. */
  adminEmail: string;
  /** ISO-8601. Kept as a string because that is what JSON carries. */
  createdAt: string;
}

export type TenantStatus = "active" | "suspended" | "pending" | "archived";

export type TenantPlan = "trial" | "starter" | "growth" | "enterprise";

export const TENANT_STATUSES: readonly TenantStatus[] = [
  "active",
  "pending",
  "suspended",
  "archived"
];

export const TENANT_PLANS: readonly TenantPlan[] = [
  "trial",
  "starter",
  "growth",
  "enterprise"
];

/**
 * One package on offer, as `GET /platform/plans` returns it.
 *
 * The seat count is fetched rather than declared beside `TENANT_PLANS` above,
 * and the split is the same one the contracts package draws: which packages
 * exist is a closed set the compiler checks against, and how many users each
 * includes is a number an installation can change without a release. Hard-coding
 * it here would be a second copy free to disagree with the database.
 */
export interface Plan {
  key: TenantPlan;
  description: string;
  userLimit: number;
  /**
   * Tenants currently on this package.
   *
   * Shown beside the seat count on the packages screen, so an operator can see
   * how many customers a change reaches before making it. Raising a number is
   * harmless; lowering one stops hiring for every tenant on the package that has
   * no negotiated figure of its own.
   */
  tenantCount: number;
}

/**
 * A D365 environment belonging to a tenant.
 *
 * The middle layer of the US-010 hierarchy: one tenant holds several
 * environments, each holding several legal entities. That story calls
 * collapsing these the single most expensive modelling mistake available here,
 * so the portal nests them rather than flattening to a tenant→company list.
 */
export interface TenantEnvironment {
  id: string;
  name: string;
  kind: EnvironmentKind;
  /** The D365 instance URL. Shown, never edited here — that is US-065. */
  url: string;
  connection: ConnectionState;
  companies: TenantCompany[];
}

export type EnvironmentKind = "production" | "sandbox";

/**
 * Whether the portal can currently reach the environment.
 *
 * Read-only on this screen. Configuring a connection and testing it belongs to
 * the D365 configuration screen (US-065); showing the state without offering
 * the action is the boundary between the two stories.
 */
export type ConnectionState = "connected" | "failing" | "not_configured";

/** A legal entity. Mirrors `Company` in the contracts package. */
export interface TenantCompany {
  id: string;
  name: string;
  dataAreaId: string;
  environmentId: string;
}

/** Everything the tenant detail screen shows, in one shape. */
export interface TenantDetail extends TenantSummary {
  environments: TenantEnvironment[];
}

export const ENVIRONMENT_KINDS: readonly EnvironmentKind[] = [
  "production",
  "sandbox"
];

/**
 * What can be done to a tenant in each state.
 *
 * Declared as data rather than as branches in a template, so an unreachable
 * combination — reactivating an archived tenant without restoring it first — is
 * impossible to render rather than merely unlikely.
 */
export type TenantAction = "suspend" | "reactivate" | "archive" | "restore";

export const TENANT_ACTIONS_BY_STATUS: Record<TenantStatus, TenantAction[]> = {
  active: ["suspend", "archive"],
  pending: ["archive"],
  suspended: ["reactivate", "archive"],
  // An archived tenant is soft-deleted. Restoring is the only way back, and
  // suspending something already gone is not a state worth having.
  archived: ["restore"]
};

/** The status each action lands the tenant in. */
export const TENANT_ACTION_RESULT: Record<TenantAction, TenantStatus> = {
  suspend: "suspended",
  reactivate: "active",
  archive: "archived",
  restore: "active"
};

/**
 * Actions that require typing the slug to confirm.
 *
 * Only the soft delete. Suspension is disruptive but reversible in a click;
 * archiving is the one that hides a tenant from every other screen, and it is
 * the one people do to the wrong row.
 */
export const TENANT_ACTIONS_NEEDING_PHRASE: readonly TenantAction[] = ["archive"];
