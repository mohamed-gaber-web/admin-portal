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
  // `tenant.soft_deleted` and `tenant.restored` used to be held here, written by
  // softDeleteTenant() and restoreTenant() since US-010 with no endpoint that
  // reached them. PATCH /tenants/:id/status now does, and claims them below —
  // the guard is bidirectional, so leaving them here as well would fail on the
  // double claim.
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
    note: "Provisions a tenant with its default roles and admin user (US-014). Creating a tenant cannot be scoped to that tenant, so it goes through the US-012 escape hatch, which logs the bypass with the request's correlation ID. Now requires a platform administrator: it was unauthenticated while there was nobody who could hold a token, which also meant anyone reaching the port could create tenants and any tenant administrator could create more. Bootstrapping is `pnpm platform-admin` instead.",
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
  },
  {
    method: "POST",
    path: "/auth/login",
    visibility: "public",
    note: "Sign-in (US-021). Takes an address and a password; email is unique across the installation, so the tenant is resolved from it rather than supplied, and is returned in the response. Wrong password, unknown email, a non-active user and an archived tenant all return an identical 401, in indistinguishable time.",
    audits: [],
    noAuditReason:
      "Sign-in attempts are recorded in auth_event, not audit_log. A failed attempt against an unknown address has no tenant at all, and audit_log.tenant_id is NOT NULL — which is the reason auth_event exists."
  },
  {
    method: "POST",
    path: "/auth/refresh",
    visibility: "public",
    note: "Exchanges a refresh token for a new pair (US-023). Necessarily unauthenticated — the access token it replaces has expired. Every exchange rotates; presenting a spent token revokes the whole family. Unknown, expired, revoked and replayed all answer with one identical 401.",
    audits: [],
    noAuditReason:
      "Rotation and replay are recorded in auth_event (token.refreshed, token.replayed, token.rejected), not audit_log. A replay of an unknown token has no tenant at all, and audit_log.tenant_id is NOT NULL."
  },
  {
    method: "POST",
    path: "/auth/logout",
    visibility: "public",
    note: "Ends a session server-side (US-046). Necessarily unauthenticated, like refresh: whoever is signing out may hold an access token that expired hours ago, which is exactly when they most want the session gone. Revokes the whole family, not the token presented — a refresh token has rotated many times by then, and revoking one link would leave the session usable. Answers an identical 204 for a live token, an expired one, an already-revoked one and one that was never issued.",
    audits: [],
    noAuditReason:
      "Recorded in auth_event as session.signed_out, not audit_log, for the same reason /auth/refresh is: a logout presenting an unrecognised token has no tenant, and audit_log.tenant_id is NOT NULL."
  },
  {
    method: "POST",
    path: "/auth/forgot-password",
    visibility: "public",
    note: "Asks for a reset link (US-024). Necessarily unauthenticated. Answers an identical 202 whether or not the account exists — this is the endpoint where account enumeration usually leaks, so the status code is fixed as well as the body.",
    audits: [],
    noAuditReason:
      "Recorded in auth_event as password_reset.requested. A request naming an unknown address has no tenant, and audit_log.tenant_id is NOT NULL. Writing an audit_log row only when the account exists would also make the audit log itself the enumeration oracle the response avoids being."
  },
  {
    method: "POST",
    path: "/auth/reset-password",
    visibility: "public",
    note: "Redeems a reset link (US-024). The token is the only credential the caller has. Redeeming revokes every refresh token the user holds, because a reset is what someone does when they believe the account is compromised.",
    // The tenant is known by the time this succeeds, so the credential change
    // belongs in the audit log as well as auth_event.
    audits: ["password.reset"]
  },
  {
    method: "POST",
    path: "/auth/mfa/verify",
    visibility: "public",
    note: "Answers an MFA challenge and completes a sign-in (US-025). Unauthenticated: the caller holds a challenge token, which proves only that a password was correct and can be exchanged for nothing else. A wrong code, a replayed code and a spent recovery code all answer identically.",
    audits: [],
    noAuditReason:
      "Recorded in auth_event as mfa.succeeded / mfa.failed, alongside the sign-in attempt it belongs to. Consistent with login: authentication outcomes live in auth_event, not audit_log."
  },
  {
    method: "POST",
    path: "/auth/mfa/enrol",
    visibility: "tenant-scoped",
    note: "Starts TOTP enrolment for the signed-in user (US-025). The user comes from the token's claims — there is no id parameter, so nobody can start an enrolment for anyone else. Nothing is enabled until it is confirmed.",
    audits: [],
    noAuditReason:
      "Mints a secret but enables nothing; the account is unchanged until confirmation, which is audited as mfa.enabled. Auditing the start would record an intent that may never complete."
  },
  {
    method: "POST",
    path: "/auth/mfa/confirm",
    visibility: "tenant-scoped",
    note: "Confirms enrolment against a code from the authenticator app and issues recovery codes (US-025). The code proves the app holds the same secret the server does.",
    audits: ["mfa.enabled"]
  },
  {
    method: "GET",
    path: "/companies",
    visibility: "tenant-scoped",
    note: "The caller's own companies (US-022). No tenant in the path or the query: the tenant comes from the access token's claims via the request context, and RLS does the filtering."
  },
  {
    method: "GET",
    path: "/companies/:id",
    visibility: "tenant-scoped",
    note: "One company by id. Another tenant's id is invisible inside the scoped session, so it answers 404 — never 403, which would confirm the row exists."
  },
  {
    method: "GET",
    path: "/tenants",
    visibility: "tenant-scoped",
    note: "The caller's own tenant (US-063). Scoped, not platform: this returned every tenant on the installation until it was found to disclose the whole customer list — names, plans and headcounts — to anyone who could sign in anywhere. The tenant table's own RLS policy does the filtering, so the page never holds more than the caller's own row."
  },
  {
    method: "GET",
    path: "/tenants/:id",
    visibility: "tenant-scoped",
    note: "The caller's own tenant with its environments and their legal entities (US-063). Any other id is invisible inside the scoped session, so it answers 404 — never 403, which would confirm the tenant exists. The tenant → environment → company hierarchy is returned nested, never flattened (US-010)."
  },
  {
    method: "GET",
    path: "/tenants/:id/activity",
    visibility: "tenant-scoped",
    note: "The caller's own tenant's recent audit entries, for the detail screen's feed (US-063). `audit_log` carries its own isolation policy, so another tenant's id yields no rows — and the tenant is checked first so it answers 404 rather than an empty feed, which would confirm the id exists."
  },
  {
    method: "PATCH",
    path: "/tenants/:id/status",
    visibility: "tenant-scoped",
    note: "A lifecycle transition on the caller's own tenant — suspend, reactivate, archive, restore (US-063). Takes the state to reach rather than the verb to apply, so a retried request is a no-op instead of a second transition. Another tenant's id matches no row: the RLS policy fences the UPDATE as well as the read.",
    // Four, because four different things can happen, and which one did is the
    // question the log exists to answer. Archiving is the soft delete, so it
    // claims the two actions US-010 had been writing with no route to reach them.
    audits: [
      "tenant.soft_deleted",
      "tenant.restored",
      "tenant.suspended",
      "tenant.reactivated"
    ]
  },
  {
    method: "GET",
    path: "/users",
    visibility: "tenant-scoped",
    note: "The caller's own tenant's users (US-064). No tenant in the path or the query: it comes from the access token's claims, and RLS does the filtering."
  },
  {
    method: "GET",
    path: "/users/:id",
    visibility: "tenant-scoped",
    note: "One user by id. Another tenant's id is invisible inside the scoped session, so it answers 404 rather than 403 — a 403 would turn an id into an oracle for another tenant's membership."
  },
  {
    method: "POST",
    path: "/users/invitations",
    visibility: "tenant-scoped",
    note: "Issues an invitation into the caller's tenant (US-064). Distinct from POST /auth/accept-invitation, which redeems one and is necessarily unauthenticated. The token is returned once and stored only as a digest.",
    // The invitation creates the user row and grants its first role in the same
    // transaction, so both are recorded.
    audits: ["invitation.issued", "role.assigned"]
  },
  {
    method: "PATCH",
    path: "/users/:id/status",
    visibility: "tenant-scoped",
    note: "Suspends or reactivates an account (US-064). Roles are untouched, so restoring access restores what the person had. Reactivating a user who never set a password is a 400, not a constraint violation.",
    audits: ["user.suspended", "user.reactivated"]
  },
  {
    method: "PUT",
    path: "/users/:id/roles",
    visibility: "tenant-scoped",
    note: "Replaces the set of roles a user holds (US-064). The whole set rather than a delta, so two administrators editing the same user cannot interleave into an arrangement neither chose.",
    // A grant and a revocation are different events: a log recording only
    // "roles changed" could not answer "who was given admin".
    audits: ["role.assigned", "role.revoked"]
  },
  {
    method: "GET",
    path: "/roles",
    visibility: "tenant-scoped",
    note: "The caller's tenant's roles with the permissions each holds (US-064). `role` is tenant-scoped; the permission catalogue it references is global and read-only to the application."
  },
  {
    method: "PUT",
    path: "/roles/:id/permissions",
    visibility: "tenant-scoped",
    note: "Replaces one role's permissions (US-064). Granting a `.write` also grants its `.read` — enforced here and not only in the portal's matrix, because a rule living in one client is a rule every other client skips. There is no create or delete: a tenant that can delete its own admin role can lock itself out.",
    audits: ["role.permissions_changed"]
  },
  {
    method: "GET",
    path: "/activity",
    visibility: "tenant-scoped",
    note: "The caller's tenant's audit trail. Read-only, and there is deliberately no route that writes one: entries are written by the operations they describe, in the same transaction, so an endpoint accepting an entry would let a caller write their own history."
  },

  /*
   * D365 connections and mobile configuration (US-040).
   *
   * These two groups look alike and are classified differently on purpose. A
   * connection holds a client secret and is tenant-scoped throughout; the mobile
   * bootstrap holds no credential at all and is necessarily public. The split
   * between them is the story: it is what stops a device-facing endpoint from
   * ever being able to reach the confidential half.
   */
  {
    method: "GET",
    path: "/connections",
    visibility: "tenant-scoped",
    note: "The caller's tenant's D365 connections, one per environment (US-040). No client secret is returned, and not because it is stripped on the way out: `connectionSchema` is strict and has no field it could occupy (US-045)."
  },
  {
    method: "GET",
    path: "/connections/:id",
    visibility: "tenant-scoped",
    note: "One connection, keyed by environment id. Another tenant's id is invisible inside the scoped session, so it answers 404 — a 403 would confirm the environment exists."
  },
  {
    method: "PUT",
    path: "/connections/:id",
    visibility: "tenant-scoped",
    note: "Saves a D365 connection, and only after a live client-credentials exchange succeeds (US-042). A rejected credential is a 422 and writes nothing — the exit criterion is that configuration cannot be saved until a test passes, and the ordering in ConnectionService is the whole of it. An omitted clientSecret keeps the stored one (US-045).",
    // Two, because two distinct things happen and a log recording only the save
    // could not answer "was this credential ever verified". A rejected save
    // writes the second and not the first.
    audits: ["connection.updated", "connection.tested"]
  },
  {
    method: "POST",
    path: "/connections/:id/test",
    visibility: "tenant-scoped",
    note: "Re-checks a stored connection without changing it. Answers 200 with `ok: false` on failure rather than an error status: checking is what was asked for, and a negative result is a legitimate answer to it. The secret is opened, presented to Entra and discarded.",
    audits: ["connection.tested"]
  },
  {
    method: "GET",
    path: "/mobile-config",
    visibility: "tenant-scoped",
    note: "The caller's tenant's mobile configuration, as administered (US-040). Distinct from GET /mobile/config, which is the unauthenticated projection a device downloads."
  },
  {
    method: "PUT",
    path: "/mobile-config",
    visibility: "tenant-scoped",
    note: "Creates or replaces the caller's tenant's mobile configuration. The whole record travels rather than a patch, so two administrators editing the same form cannot interleave into an arrangement neither chose. `apiBaseUrl` must be https — it redirects every device in the field, and a cleartext hop discloses the access tokens sent over it.",
    audits: ["mobile_config.updated"]
  },
  {
    method: "GET",
    path: "/mobile/config",
    visibility: "public",
    note: "What a device fetches at launch, replacing its bundled environment.ts (US-040). Necessarily unauthenticated — this is the endpoint that tells the app where the API is, so requiring a token would require the app to already know what it is asking for. Throttled per source like every other unauthenticated route. It carries no credential of any kind: the D365 client secret is on a table this endpoint's query does not name, and an unknown, archived or suspended slug all answer with one identical 404."
  },

  /*
   * The ERP pass-through (US-046).
   *
   * Ten entries for two paths, because the route guard scans one decorator at
   * a time and the controller declares five methods on each family. Verbose,
   * and deliberately so: an @All() route would be invisible to that guard.
   */
  {
    method: "GET",
    path: "/d365/data/*",
    visibility: "tenant-scoped",
    note: "The ERP pass-through (US-046). Tenant-scoped through the token like every other route here; which of the tenant's environments it reaches comes from the company named in x-d365-company, resolved under RLS, so another tenant's company id answers 404. Two path families rather than one wildcard so the allowlist — data/ and api/services/ — is enforced by the router before any handler runs. It never answers 401: only AccessTokenGuard may, and an upstream 401 passed through would make the mobile app sign a user out because our ERP service principal expired, not their session."
  },
  {
    method: "POST",
    path: "/d365/data/*",
    visibility: "tenant-scoped",
    note: "The ERP pass-through (US-046). Tenant-scoped through the token like every other route here; which of the tenant's environments it reaches comes from the company named in x-d365-company, resolved under RLS, so another tenant's company id answers 404. Two path families rather than one wildcard so the allowlist — data/ and api/services/ — is enforced by the router before any handler runs. It never answers 401: only AccessTokenGuard may, and an upstream 401 passed through would make the mobile app sign a user out because our ERP service principal expired, not their session.",
    audits: [],
    noAuditReason:
      "A proxied ERP call is not a configuration change. A van sales device makes hundreds an hour, so an entry each would make GET /activity unreadable and turn the append-only audit_log into the busiest write path in the system — the feed exists to answer \"who changed this connection\", which connection.updated already does, and D365 is the system of record for the operations themselves. What is recorded instead is the structured request log line, carrying the correlation id, tenant, user, environment, method, path and status."
  },
  {
    method: "PUT",
    path: "/d365/data/*",
    visibility: "tenant-scoped",
    note: "The ERP pass-through (US-046). Tenant-scoped through the token like every other route here; which of the tenant's environments it reaches comes from the company named in x-d365-company, resolved under RLS, so another tenant's company id answers 404. Two path families rather than one wildcard so the allowlist — data/ and api/services/ — is enforced by the router before any handler runs. It never answers 401: only AccessTokenGuard may, and an upstream 401 passed through would make the mobile app sign a user out because our ERP service principal expired, not their session.",
    audits: [],
    noAuditReason:
      "A proxied ERP call is not a configuration change. A van sales device makes hundreds an hour, so an entry each would make GET /activity unreadable and turn the append-only audit_log into the busiest write path in the system — the feed exists to answer \"who changed this connection\", which connection.updated already does, and D365 is the system of record for the operations themselves. What is recorded instead is the structured request log line, carrying the correlation id, tenant, user, environment, method, path and status."
  },
  {
    method: "PATCH",
    path: "/d365/data/*",
    visibility: "tenant-scoped",
    note: "The ERP pass-through (US-046). Tenant-scoped through the token like every other route here; which of the tenant's environments it reaches comes from the company named in x-d365-company, resolved under RLS, so another tenant's company id answers 404. Two path families rather than one wildcard so the allowlist — data/ and api/services/ — is enforced by the router before any handler runs. It never answers 401: only AccessTokenGuard may, and an upstream 401 passed through would make the mobile app sign a user out because our ERP service principal expired, not their session.",
    audits: [],
    noAuditReason:
      "A proxied ERP call is not a configuration change. A van sales device makes hundreds an hour, so an entry each would make GET /activity unreadable and turn the append-only audit_log into the busiest write path in the system — the feed exists to answer \"who changed this connection\", which connection.updated already does, and D365 is the system of record for the operations themselves. What is recorded instead is the structured request log line, carrying the correlation id, tenant, user, environment, method, path and status."
  },
  {
    method: "DELETE",
    path: "/d365/data/*",
    visibility: "tenant-scoped",
    note: "The ERP pass-through (US-046). Tenant-scoped through the token like every other route here; which of the tenant's environments it reaches comes from the company named in x-d365-company, resolved under RLS, so another tenant's company id answers 404. Two path families rather than one wildcard so the allowlist — data/ and api/services/ — is enforced by the router before any handler runs. It never answers 401: only AccessTokenGuard may, and an upstream 401 passed through would make the mobile app sign a user out because our ERP service principal expired, not their session.",
    audits: [],
    noAuditReason:
      "A proxied ERP call is not a configuration change. A van sales device makes hundreds an hour, so an entry each would make GET /activity unreadable and turn the append-only audit_log into the busiest write path in the system — the feed exists to answer \"who changed this connection\", which connection.updated already does, and D365 is the system of record for the operations themselves. What is recorded instead is the structured request log line, carrying the correlation id, tenant, user, environment, method, path and status."
  },
  {
    method: "GET",
    path: "/d365/api/services/*",
    visibility: "tenant-scoped",
    note: "The ERP pass-through (US-046). Tenant-scoped through the token like every other route here; which of the tenant's environments it reaches comes from the company named in x-d365-company, resolved under RLS, so another tenant's company id answers 404. Two path families rather than one wildcard so the allowlist — data/ and api/services/ — is enforced by the router before any handler runs. It never answers 401: only AccessTokenGuard may, and an upstream 401 passed through would make the mobile app sign a user out because our ERP service principal expired, not their session."
  },
  {
    method: "POST",
    path: "/d365/api/services/*",
    visibility: "tenant-scoped",
    note: "The ERP pass-through (US-046). Tenant-scoped through the token like every other route here; which of the tenant's environments it reaches comes from the company named in x-d365-company, resolved under RLS, so another tenant's company id answers 404. Two path families rather than one wildcard so the allowlist — data/ and api/services/ — is enforced by the router before any handler runs. It never answers 401: only AccessTokenGuard may, and an upstream 401 passed through would make the mobile app sign a user out because our ERP service principal expired, not their session.",
    audits: [],
    noAuditReason:
      "A proxied ERP call is not a configuration change. A van sales device makes hundreds an hour, so an entry each would make GET /activity unreadable and turn the append-only audit_log into the busiest write path in the system — the feed exists to answer \"who changed this connection\", which connection.updated already does, and D365 is the system of record for the operations themselves. What is recorded instead is the structured request log line, carrying the correlation id, tenant, user, environment, method, path and status."
  },
  {
    method: "PUT",
    path: "/d365/api/services/*",
    visibility: "tenant-scoped",
    note: "The ERP pass-through (US-046). Tenant-scoped through the token like every other route here; which of the tenant's environments it reaches comes from the company named in x-d365-company, resolved under RLS, so another tenant's company id answers 404. Two path families rather than one wildcard so the allowlist — data/ and api/services/ — is enforced by the router before any handler runs. It never answers 401: only AccessTokenGuard may, and an upstream 401 passed through would make the mobile app sign a user out because our ERP service principal expired, not their session.",
    audits: [],
    noAuditReason:
      "A proxied ERP call is not a configuration change. A van sales device makes hundreds an hour, so an entry each would make GET /activity unreadable and turn the append-only audit_log into the busiest write path in the system — the feed exists to answer \"who changed this connection\", which connection.updated already does, and D365 is the system of record for the operations themselves. What is recorded instead is the structured request log line, carrying the correlation id, tenant, user, environment, method, path and status."
  },
  {
    method: "PATCH",
    path: "/d365/api/services/*",
    visibility: "tenant-scoped",
    note: "The ERP pass-through (US-046). Tenant-scoped through the token like every other route here; which of the tenant's environments it reaches comes from the company named in x-d365-company, resolved under RLS, so another tenant's company id answers 404. Two path families rather than one wildcard so the allowlist — data/ and api/services/ — is enforced by the router before any handler runs. It never answers 401: only AccessTokenGuard may, and an upstream 401 passed through would make the mobile app sign a user out because our ERP service principal expired, not their session.",
    audits: [],
    noAuditReason:
      "A proxied ERP call is not a configuration change. A van sales device makes hundreds an hour, so an entry each would make GET /activity unreadable and turn the append-only audit_log into the busiest write path in the system — the feed exists to answer \"who changed this connection\", which connection.updated already does, and D365 is the system of record for the operations themselves. What is recorded instead is the structured request log line, carrying the correlation id, tenant, user, environment, method, path and status."
  },
  {
    method: "DELETE",
    path: "/d365/api/services/*",
    visibility: "tenant-scoped",
    note: "The ERP pass-through (US-046). Tenant-scoped through the token like every other route here; which of the tenant's environments it reaches comes from the company named in x-d365-company, resolved under RLS, so another tenant's company id answers 404. Two path families rather than one wildcard so the allowlist — data/ and api/services/ — is enforced by the router before any handler runs. It never answers 401: only AccessTokenGuard may, and an upstream 401 passed through would make the mobile app sign a user out because our ERP service principal expired, not their session.",
    audits: [],
    noAuditReason:
      "A proxied ERP call is not a configuration change. A van sales device makes hundreds an hour, so an entry each would make GET /activity unreadable and turn the append-only audit_log into the busiest write path in the system — the feed exists to answer \"who changed this connection\", which connection.updated already does, and D365 is the system of record for the operations themselves. What is recorded instead is the structured request log line, carrying the correlation id, tenant, user, environment, method, path and status."
  },

  /*
   * The platform tier.
   *
   * `platform`, not `tenant-scoped`, and therefore not covered by an isolation
   * test — asserting that these routes cannot see another tenant's rows would
   * assert the opposite of what they are for. What guards them instead is a
   * permission the token must carry *and* membership of the reserved platform
   * tenant, checked independently, plus a database trigger that makes the
   * permission ungrantable anywhere else. tests/platform-administration.test.ts
   * is where that boundary is exercised.
   *
   * They are separate paths rather than the same routes widened by permission,
   * deliberately: one endpoint whose result set depended on who was asking is
   * one forgotten check away from handing the customer list to every tenant,
   * which is the exact regression US-063 was written to fix.
   */
  {
    method: "GET",
    path: "/platform/tenants",
    visibility: "platform",
    note: "Every tenant on the installation, for the operator console. Excludes the reserved platform tenant, which is the operators' own workspace rather than a customer — and archiving it would soft-delete the only tenant from which a tenant can be created."
  },
  {
    method: "GET",
    path: "/platform/tenants/:id",
    visibility: "platform",
    note: "Any tenant's detail with its environments and legal entities. The platform tenant's own id answers 404, consistently with its absence from the list, so a leaked id still leads nowhere."
  },
  {
    method: "GET",
    path: "/platform/tenants/:id/activity",
    visibility: "platform",
    note: "Any tenant's audit trail. The tenant is checked first so an unknown id is a 404 rather than an empty feed, which would read as a tenant that has never done anything."
  },
  {
    method: "PATCH",
    path: "/platform/tenants/:id/status",
    visibility: "platform",
    note: "Suspend, reactivate, archive or restore any tenant. Takes the state to reach rather than the verb to apply, so a retried request is a no-op — the same contract as the tenant-scoped route, because the same button should not mean different things to an operator and an administrator.",
    // The same four actions the tenant-scoped route claims. Both write them,
    // through the same functions; the guard checks that every claimed action
    // exists in the source, not that only one route may claim it.
    audits: [
      "tenant.soft_deleted",
      "tenant.restored",
      "tenant.suspended",
      "tenant.reactivated"
    ]
  },
  {
    method: "GET",
    path: "/modules",
    visibility: "tenant-scoped",
    note: "The caller's own module entitlements (US-072). Read-only, and that is the point: which modules a tenant holds is a commercial decision made by whoever operates the installation, so a tenant administrator who could write here would have been handed the price list. Takes no tenant — it comes from the token's claims, and the RLS policy on tenant_module does the filtering, so with no context set every module comes back unheld rather than every module held."
  },
  {
    method: "PATCH",
    path: "/platform/tenants/:id/plan",
    visibility: "platform",
    note: "Moves a tenant onto a plan, or cancels their subscription (US-072). A separate permission from the lifecycle route on purpose: suspending a tenant locks their people out, and unsubscribing one need not — a customer whose subscription lapsed should stop getting what they no longer pay for, not lose access to their own data at the moment they most need to export it.",
    // Two actions for one column change. A cancellation and a downgrade to
    // trial leave the same row behind, and only the log can tell them apart
    // afterwards — which is what the real subscription model (US-070/071) will
    // be reconstructed from.
    audits: ["tenant.plan_changed", "tenant.unsubscribed"]
  },
  {
    method: "GET",
    path: "/platform/tenants/:id/modules",
    visibility: "platform",
    note: "The module catalogue with each entry marked held or not for one tenant (US-072). The tenant is checked first so an unknown id is a 404 rather than a catalogue with nothing enabled, which would read as a real customer who has bought nothing."
  },
  {
    method: "PUT",
    path: "/platform/tenants/:id/modules",
    visibility: "platform",
    note: "Replaces the set of modules a tenant is entitled to (US-072). PUT rather than PATCH: the body is the complete set, so a retry cannot half-apply — the same shape as replacing a role's permissions, for the same reason. Unknown keys are ignored rather than rejected, so a portal built against an older catalogue can still change everything else.",
    audits: ["tenant.modules_changed"]
  },
  {
    method: "GET",
    path: "/platform/users",
    visibility: "platform",
    note: "Every user across every tenant, each row carrying the tenant it belongs to. Platform operators are included rather than filtered out: an operator needs to see who else holds the tier."
  },
  {
    method: "GET",
    path: "/platform/users/:id",
    visibility: "platform",
    note: "Any user by id, in any tenant."
  },
  {
    method: "PATCH",
    path: "/platform/users/:id/status",
    visibility: "platform",
    note: "Suspends or reactivates any account, in any tenant. Refuses the caller's own account: an operator who suspends themselves is locked out with no screen that could undo it, and there may be nobody else holding the tier.",
    // Written into the *target* tenant's audit log, naming the operator. From
    // inside that tenant this is a change made by somebody they cannot see, and
    // an anonymous entry would leave the platform tier unaccountable to the
    // people it acts on.
    audits: ["user.suspended", "user.reactivated"]
  },
  {
    method: "GET",
    path: "/platform/admins",
    visibility: "platform",
    note: "Everybody holding the platform role. Keyed on the role rather than on membership of the reserved tenant: a user row there who was never given the role holds no platform.* permission and is not an operator, so listing them would overstate who can reach every tenant."
  },
  {
    method: "POST",
    path: "/platform/admins",
    visibility: "platform",
    note: "Mints another operator and returns a one-time invitation (the same call `pnpm platform-admin` makes from a shell). Carries its own permission rather than riding on platform.user.write, because this hands somebody reach over every tenant. An address that already belongs to an active operator returns invitation: null and is left alone — reissuing would be an account takeover available to anyone who can reach this route.",
    // Written by ensurePlatformAdmin when the grant actually happens, into the
    // platform tenant's own log. A re-run that changes nothing adds no line.
    audits: ["role.assigned", "invitation.issued"]
  },
  {
    method: "POST",
    path: "/platform/tenants/:id/admin-invitation",
    visibility: "platform",
    note: "Issues a fresh invitation for a tenant's administrator — the operator's only remedy for a tenant stuck at pending. That status is derived from \"nobody here has signed in yet\", so no lifecycle transition clears it, and POST /users/invitations needs user.write inside the tenant, which is exactly the permission nobody there can exercise yet. Refuses an administrator who already has a password (409): reissuing there would be a password reset wearing the wrong name, and a way to take over an account by inviting it.",
    audits: ["invitation.issued"]
  },
  {
    method: "PATCH",
    path: "/platform/tenants/:id",
    visibility: "platform",
    note: "Renames a tenant. Name only — the slug is identity: people sign in with it and every invitation link already sent carries it, so changing it would silently invalidate all of them with no way for the tenant to tell its own people. Under platform.tenant.write, the same key as the lifecycle transitions, because renaming is an operational correction rather than a commercial decision.",
    audits: ["tenant.renamed"]
  },
  {
    method: "PATCH",
    path: "/platform/tenants/:id/seats",
    visibility: "platform",
    note: "Sets or clears a tenant's negotiated seat allowance, overriding what its package includes. Under platform.plan.write rather than platform.tenant.write because it is a commercial decision about what a customer may have, the same kind as moving them between packages — not an operational one like suspending them. null clears the override and returns the tenant to its package's number.",
    audits: ["tenant.seats_changed"]
  },
  {
    method: "GET",
    path: "/platform/plans",
    visibility: "platform",
    note: "The package catalogue with the seats each package includes. Read-only: nothing in the portal edits the numbers yet, and the operator screens need them to render a plan picker that says what each package actually buys. Gated on platform.tenant.read rather than a key of its own — it is the same catalogue every plan badge is already drawn from."
  },
  {
    method: "PATCH",
    path: "/platform/plans/:key",
    visibility: "platform",
    note: "Changes how many users a package includes, for every tenant on it that has not negotiated its own figure. Under platform.plan.write, the same key that moves a tenant between packages and sets a tenant's seat override — all three decide what a customer may have. Keyed by plan key rather than id because the key is what tenant rows point at and what an operator reads on screen. Audited against the platform tenant, since the plan table belongs to no tenant.",
    audits: ["plan.seats_changed"]
  },
  {
    method: "GET",
    path: "/platform/permissions",
    visibility: "platform",
    note: "Every permission the installation defines, with how many roles across every tenant hold each. Read-only, and there is no writing counterpart anywhere: `permission` is a global table the application holds SELECT on and nothing else. It exists so an operator can see the platform.* half, which never appears in a tenant's own role matrix."
  }
];
