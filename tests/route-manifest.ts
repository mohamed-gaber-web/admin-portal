/**
 * Every route the API exposes, classified.
 *
 * This file is the thing you must edit when you add a route. The US-013 guard
 * compares it against the routes actually declared in the controllers and fails
 * CI on any mismatch, so a new route cannot reach main unclassified.
 *
 *   public        - no authentication, no tenant data (health checks)
 *   platform      - platform-admin operations, not scoped to one tenant
 *   tenant-scoped - returns or mutates one tenant's data
 *
 * A `tenant-scoped` route additionally requires an isolation test under
 * tests/isolation/ declaring `coversRoute("<METHOD> <path>")`.
 *
 * A **mutating** route (POST, PUT, PATCH, DELETE) additionally requires an
 * `audits` list naming the audit actions it writes (US-015). Every name must
 * match a real `recordAuditEntry({ action: "..." })` call in the source.
 */

export type RouteVisibility = "public" | "platform" | "tenant-scoped";

export interface DeclaredRoute {
  method: string;
  path: string;
  visibility: RouteVisibility;
  /** Why it is classified this way — read by the next person to touch it. */
  note: string;
  /**
   * Audit actions this route writes (US-015). Required on mutating methods.
   *
   * Empty is a legitimate answer for a mutation that changes nothing sensitive,
   * but it has to be an argued one — `noAuditReason` is then mandatory.
   */
  audits?: string[];
  /** Why a mutating route writes no audit entry. Required when `audits` is empty. */
  noAuditReason?: string;
}

/**
 * Audit actions written by code that no HTTP route reaches yet — CLI tools,
 * background jobs, and library functions waiting for their endpoint.
 *
 * Listing them here is what keeps the guard bidirectional. Without it, "this
 * action is written but nothing claims it" would be indistinguishable from "a
 * route quietly stopped auditing", and the guard would have to ignore both.
 */
export const NON_ROUTE_AUDIT_ACTIONS: { action: string; note: string }[] = [
  {
    action: "tenant.soft_deleted",
    note: "softDeleteTenant() (US-010). No delete endpoint yet; the admin portal's tenant lifecycle screen will claim this."
  },
  {
    action: "tenant.restored",
    note: "restoreTenant() (US-010). Pairs with tenant.soft_deleted and arrives with the same endpoint."
  }
];

export const DECLARED_ROUTES: DeclaredRoute[] = [
  {
    method: "GET",
    path: "/health",
    visibility: "public",
    note: "Liveness probe. Returns no tenant data."
  },
  {
    method: "GET",
    path: "/health/ready",
    visibility: "public",
    note: "Readiness probe (US-016). Unauthenticated, because orchestrators cannot present credentials — so it reports each dependency as up/down/not_configured and nothing else. Causes go to the log."
  },
  {
    method: "POST",
    path: "/tenants",
    visibility: "platform",
    note: "Provisions a tenant with its default roles and admin user (US-014). Creating a tenant cannot be scoped to that tenant, so it stays platform — it goes through the US-012 escape hatch, which logs the bypass with the request's correlation ID.",
    // Three entries, because three different things happened: a tenant came
    // into existence, someone was granted a permission, and the first admin
    // was invited (US-020 — without which nobody could ever sign in).
    audits: ["tenant.provisioned", "role.assigned", "invitation.issued"]
  },
  {
    method: "POST",
    path: "/auth/accept-invitation",
    visibility: "public",
    note: "Redeems an invitation and sets a first password (US-020). Necessarily unauthenticated — the caller has no credential yet — so the token is both the credential and the tenant selector. Unknown, expired and already-accepted tokens are refused identically.",
    audits: ["invitation.accepted"]
  }
];
