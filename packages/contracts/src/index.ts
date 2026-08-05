/**
 * Shared contracts consumed by both apps/api and apps/portal.
 * Changing anything here should trigger dependents to rebuild (AC2).
 */

/** Response shape returned by the API's health endpoint. */
export interface HealthStatus {
  status: "ok";
  service: string;
}

/** Well-known route paths shared between the API and the portal. */
export const API_ROUTES = {
  health: "/health"
} as const;
