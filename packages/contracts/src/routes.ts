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
  /**
   * Sign-in. Takes an address and a password; the workspace is resolved from
   * the address rather than supplied, and returned in the response.
   */
  login: "/auth/login",
  /**
   * Exchanges a refresh token for a new pair. Unauthenticated by necessity —
   * the access token it replaces has expired, which is the whole reason to call.
   */
  refresh: "/auth/refresh",
  /**
   * Ends a session, server-side.
   *
   * Unauthenticated by necessity, like `refresh`: somebody signing out may well
   * be holding an access token that expired hours ago, and that is exactly when
   * they most want the session gone. The refresh token in the body is what
   * identifies the session, and it is the only thing that could.
   */
  logout: "/auth/logout",
  /** Asks for a reset link. Answers identically whether or not the account exists. */
  requestPasswordReset: "/auth/forgot-password",
  /** Redeems a reset link and sets a new password. */
  completePasswordReset: "/auth/reset-password",
  /** Answers an MFA challenge and completes a sign-in (US-025). */
  verifyMfa: "/auth/mfa/verify",
  /** Starts TOTP enrolment for the signed-in user. */
  enrolMfa: "/auth/mfa/enrol",
  /** Confirms enrolment with a code from the authenticator app. */
  confirmMfa: "/auth/mfa/confirm",
  /**
   * The caller's own companies. There is no tenant in the path: the tenant comes
   * from the access token's claims, so there is nothing here to iterate.
   */
  companies: "/companies",
  /** One company by id. Another tenant's id is a 404, never a 403. */
  company: "/companies/:id",
  /**
   * One tenant, with its environments and their legal entities.
   *
   * Platform, like the list: reading a tenant's identity is what the
   * administration screens are for, and scoping it to the caller's own tenant
   * would make the screen able to show exactly one row.
   */
  tenant: "/tenants/:id",
  /**
   * A tenant lifecycle transition — suspend, reactivate, archive, restore.
   *
   * Claims the `tenant.soft_deleted` and `tenant.restored` audit actions that
   * `softDeleteTenant()` and `restoreTenant()` have been writing without a
   * route since US-010.
   */
  tenantStatus: "/tenants/:id/status",
  /** One tenant's recent audit entries, for the detail screen's feed. */
  tenantActivity: "/tenants/:id/activity",
  /**
   * The caller's own tenant's users. No tenant in the path or the query: it
   * comes from the access token's claims, and RLS does the filtering.
   */
  users: "/users",
  /** One user by id. Another tenant's id is a 404, never a 403. */
  user: "/users/:id",
  /** Suspending or reactivating an account. */
  userStatus: "/users/:id/status",
  /** Replacing the set of roles a user holds. */
  userRoles: "/users/:id/roles",
  /**
   * Issuing an invitation to join the caller's tenant.
   *
   * Distinct from `acceptInvitation`, which redeems one and is necessarily
   * unauthenticated. This one requires a token, because the tenant being
   * invited into comes from the caller's claims.
   */
  userInvitations: "/users/invitations",
  /** The caller's tenant's roles, with the permissions each holds. */
  roles: "/roles",
  /** Replacing the permissions on one role. */
  rolePermissions: "/roles/:id/permissions",
  /** The caller's tenant's audit trail. */
  activity: "/activity",

  /**
   * The caller's own module entitlements (US-072).
   *
   * Read-only, and the read-only-ness is the point: which modules a tenant holds
   * is a commercial fact decided by whoever operates the installation, not
   * something a tenant grants itself. The writing counterpart is
   * `platformTenantModules`, behind a platform permission.
   *
   * No tenant in the path — it comes from the access token's claims, and row
   * level security on `tenant_module` does the filtering.
   */
  modules: "/modules",

  /**
   * D365 connections — one per environment, keyed by the environment's id
   * (US-040).
   *
   * No tenant in the path: it comes from the access token's claims, and RLS on
   * `d365_environment` does the filtering, so another tenant's environment id is
   * a 404 rather than something the service has to check for.
   */
  connections: "/connections",
  /** One connection. Reads never carry the client secret — there is no field for it. */
  connection: "/connections/:id",
  /**
   * A live credential check that saves nothing.
   *
   * Distinct from `PUT /connections/:id`, which runs the same check and persists
   * only if it passes. This one exists for the *Test connection* button and for
   * re-checking a configuration that was working yesterday.
   */
  connectionTest: "/connections/:id/test",

  /**
   * The caller's tenant's mobile configuration, for administering it.
   *
   * Note the near-miss with `mobileConfig` below, which is not an accident:
   * this path is the **record**, reachable only with a token; that one is the
   * **projection** a device downloads. They return different shapes on purpose,
   * and the device-facing one is `strict()` so a field cannot leak from this
   * side to that one without a contract test failing.
   */
  tenantMobileConfig: "/mobile-config",

  /**
   * What a device fetches at launch, replacing its bundled `environment.ts`
   * (US-040).
   *
   * **Unauthenticated by necessity**, and the only route in this file that takes
   * a tenant identifier from the caller: a freshly installed app holds a slug and
   * nothing else, so there is no token for the tenant to come from. That is
   * exactly the position `POST /auth/login` is in, and the slug is treated the
   * same way — a claim, resolved and never trusted as a context.
   *
   * It carries no credential of any kind. The D365 client secret is not merely
   * omitted from the response; it is in a different table that this endpoint's
   * query does not name.
   */
  mobileConfig: "/mobile/config",

  /**
   * Everything a device asks of the ERP, forwarded with a credential it never
   * sees (US-046).
   *
   * The counterpart to `mobileConfig`. That route tells a freshly installed app
   * where the API is; these are what the app then talks to instead of D365.
   * US-040 took the `client_credentials` secret out of every installed build and
   * sealed it on the server, which left the device with no way to reach the ERP
   * at all — this is the way.
   *
   * **Two families rather than one `/d365/*`, and that is the security control.**
   * `data/` is the OData surface and `api/services/` the custom service
   * endpoints; between them they are the whole of what the app calls. Splitting
   * them puts the allowlist in the router, where Express enforces it before any
   * of our code runs — one wildcard route would put it in a string comparison
   * inside a handler, where it is one early `return` away from being an open
   * forwarder into a customer's ERP for anyone holding any tenant's token.
   *
   * The paths below the prefix are D365's own, unchanged, because the app names
   * ninety-five of them across twenty services and a migration that also
   * rewrote every query would be two migrations. It also means "what the device
   * asked for" and "what D365 was asked" are the same string in a log.
   *
   * Tenant-scoped through the token like every other route here. Which of the
   * tenant's environments a request reaches is decided by the company named in
   * `D365_COMPANY_HEADER`, resolved under row level security, so another
   * tenant's company id selects nothing and answers 404.
   */
  d365Data: "/d365/data/*",
  d365Services: "/d365/api/services/*",

  /**
   * The platform tier — every tenant and every user, across the installation.
   *
   * Prefixed rather than folded into the routes above, and the prefix is the
   * point: `GET /tenants` answers "my tenant" and `GET /platform/tenants`
   * answers "all of them". One route whose meaning depended on the caller's
   * permissions would be a route where forgetting the check leaks the customer
   * list to every tenant — the exact regression US-063 was written to fix.
   *
   * Every one of these requires a `platform.*` permission *and* a caller inside
   * the reserved platform tenant.
   */
  platformTenants: "/platform/tenants",
  platformTenant: "/platform/tenants/:id",
  platformTenantStatus: "/platform/tenants/:id/status",
  platformTenantActivity: "/platform/tenants/:id/activity",
  /**
   * A tenant's commercial plan, and cancelling it (US-072).
   *
   * Separate from `platformTenantStatus` because the two are separate
   * decisions: suspending a tenant is an operational act that locks everyone
   * out, and unsubscribing one is a commercial act that need not. Folding both
   * into one route would make "cancel their subscription" and "cut off their
   * access" the same button.
   */
  /**
   * A tenant's editable details — its name.
   *
   * The bare resource path, unlike its siblings which each name a facet
   * (`/plan`, `/seats`, `/status`). Those are separate because each is a
   * separate decision with its own permission; this one is the tenant's own
   * attributes, and there is currently one of them.
   */
  platformTenantUpdate: "/platform/tenants/:id",
  /**
   * A fresh invitation for a tenant's administrator.
   *
   * POST because it creates something — a new token, invalidating any previous
   * one. The operator's only remedy for a tenant stuck at `pending`: that status
   * means nobody there has signed in yet, and `POST /users/invitations` needs
   * `user.write` *inside* the tenant, which is exactly the permission nobody
   * there can exercise yet.
   */
  platformTenantAdminInvitation: "/platform/tenants/:id/admin-invitation",
  platformTenantPlan: "/platform/tenants/:id/plan",
  /**
   * The package catalogue, with the seats each package includes.
   *
   * Read-only, like `platformPermissions`, and for a weaker version of the same
   * reason: the seat numbers are an `UPDATE` away rather than fixed, but nothing
   * in the portal edits them yet. What this exists for is the plan picker — an
   * operator choosing between packages has to be able to see that Growth means
   * 25 users, and hard-coding that in the client would put the number in two
   * places and let them disagree.
   */
  platformPlans: "/platform/plans",
  /**
   * One package's seat count.
   *
   * Keyed by `key` rather than by id, unlike every other resource route here.
   * The key is what a tenant row points at, what the foreign key cascades on,
   * and what an operator reads on screen — the uuid is an implementation detail
   * no caller ever holds. A route keyed by something nobody can name would force
   * a list fetch before every edit.
   */
  platformPlan: "/platform/plans/:key",
  /**
   * A tenant's negotiated seat allowance (`null` to inherit its package).
   *
   * Separate from `platformTenantPlan` because the two are separate decisions
   * that happen at separate times: a plan change is what a customer buys, and a
   * seat override is a concession on top of it. Folding them into one body would
   * mean an operator could not adjust seats without restating the plan, and a
   * retry that restated a stale plan would undo an upgrade.
   */
  platformTenantSeats: "/platform/tenants/:id/seats",
  /** Which modules a tenant is entitled to. The whole set, replaced at once. */
  platformTenantModules: "/platform/tenants/:id/modules",

  platformUsers: "/platform/users",
  platformUser: "/platform/users/:id",
  platformUserStatus: "/platform/users/:id/status",

  /**
   * The operators themselves.
   *
   * `GET` lists them; `POST` mints one and returns a one-time invitation. This
   * is the same bootstrap `pnpm platform-admin` performs from a shell — the
   * difference is only that an operator who is already signed in does not have
   * to find a machine with the database credentials to add a colleague.
   */
  platformAdmins: "/platform/admins",

  /**
   * The permission catalogue, whole.
   *
   * Read-only: `permission` is a global table the application holds `SELECT`
   * on and nothing else, so there is no writing counterpart and there cannot
   * be one. It exists so an operator can see every key the installation
   * defines, including the `platform.*` half that never appears in a tenant's
   * own role matrix.
   */
  platformPermissions: "/platform/permissions"
} as const;

/**
 * Which company — and therefore which environment — a proxied ERP request means.
 *
 * A header rather than a query parameter, because the path and query of a
 * proxied request belong to D365 and are forwarded verbatim; anything this API
 * adds there would travel to the ERP as part of an OData query and change what
 * it means. A header is ours, and is stripped before forwarding.
 *
 * Optional. A tenant with one configured environment needs no disambiguation,
 * and requiring the header would mean every screen in the app had to learn about
 * environments before it could ask for a sales order. With more than one, the
 * request is refused rather than guessed at: posting an order into whichever
 * environment sorted first is not a failure anybody would notice quickly.
 */
export const D365_COMPANY_HEADER = "x-d365-company";
