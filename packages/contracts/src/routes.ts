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
  acceptInvitation: "/auth/accept-invitation",
  /** Sign-in. Takes the tenant slug, because email alone is not an identity. */
  login: "/auth/login",
  /**
   * Exchanges a refresh token for a new pair. Unauthenticated by necessity —
   * the access token it replaces has expired, which is the whole reason to call.
   */
  refresh: "/auth/refresh",
  /** Asks for a reset link. Answers identically whether or not the account exists. */
  requestPasswordReset: "/auth/forgot-password",
  /** Redeems a reset link and sets a new password. */
  completePasswordReset: "/auth/reset-password",
  /**
   * The caller's own companies. There is no tenant in the path: the tenant comes
   * from the access token's claims, so there is nothing here to iterate.
   */
  companies: "/companies",
  /** One company by id. Another tenant's id is a 404, never a 403. */
  company: "/companies/:id"
} as const;
