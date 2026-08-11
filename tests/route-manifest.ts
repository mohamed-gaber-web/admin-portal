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
 */

export type RouteVisibility = "public" | "platform" | "tenant-scoped";

export interface DeclaredRoute {
  method: string;
  path: string;
  visibility: RouteVisibility;
  /** Why it is classified this way — read by the next person to touch it. */
  note: string;
}

export const DECLARED_ROUTES: DeclaredRoute[] = [
  {
    method: "GET",
    path: "/health",
    visibility: "public",
    note: "Liveness probe. Returns no tenant data."
  },
  {
    method: "POST",
    path: "/tenants",
    visibility: "platform",
    note: "Provisions a tenant with its default roles and admin user (US-014). Creating a tenant cannot be scoped to that tenant, so it stays platform — it runs on the admin connection and bypasses RLS by design."
  }
];
