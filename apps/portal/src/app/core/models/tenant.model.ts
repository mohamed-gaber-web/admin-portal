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
  adminEmail: string;
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
