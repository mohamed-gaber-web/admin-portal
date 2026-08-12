/** Well-known route paths shared between the API and its consumers. */
export const API_ROUTES = {
  /** Liveness. Answers "is this process wedged", and checks nothing downstream. */
  health: "/health",
  /** Readiness. Answers "should traffic come here", and verifies dependencies. */
  ready: "/health/ready",
  tenants: "/tenants"
} as const;
