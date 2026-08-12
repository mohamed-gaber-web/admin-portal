/** Well-known route paths shared between the API and its consumers. */
export const API_ROUTES = {
  /** Liveness. Answers "is this process wedged", and checks nothing downstream. */
  health: "/health",
  /** Readiness. Answers "should traffic come here", and verifies dependencies. */
  ready: "/health/ready",
  tenants: "/tenants",
  /**
   * Redeeming an invitation. Necessarily unauthenticated — the person accepting
   * has no credential yet, which is the entire point — so the token is the only
   * thing that identifies them, and it identifies the tenant too.
   */
  acceptInvitation: "/auth/accept-invitation"
} as const;
