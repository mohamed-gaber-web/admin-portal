/**
 * Development environment.
 *
 * `apiBaseUrl` matches the API's default port, and the API's default
 * `PORTAL_ORIGIN` is this app's dev server — so the two talk to each other with
 * no configuration on a fresh clone. Change both together or CORS will refuse
 * the request before any of your code runs.
 */
export const environment = {
  production: false,
  apiBaseUrl: "http://localhost:3000",
  appName: "Grow Path Admin",

  /**
   * Serve authentication from fixtures instead of calling the API.
   *
   * Off. The portal now talks to the real backend, so running it needs the API
   * up and the migrations applied — `pnpm db:migrate`, then `pnpm dev`.
   *
   * What this still switches is `AuthService`, which keeps each fixture beside
   * its real call: turning it on gives back a sign-in that accepts any password
   * and a demo MFA challenge, which is how the authentication screens were
   * built before there was an API to build them against. It no longer makes the
   * rest of the portal work offline — tenants, users, roles and the activity
   * log have no fixture left to fall back to.
   *
   * The dashboard is the one screen still served entirely from a fixture, and
   * not via this flag: its tiles carry period-over-period deltas and sparkline
   * series, and nothing in the schema records the history those need. See
   * `DashboardService`.
   *
   * Hard-off in production regardless, so a build can never ship demo data.
   */
  useMockApi: false,

  /**
   * Screens and controls that can be switched off without removing them.
   *
   * A flag rather than deleted code, and the distinction matters: what is off
   * here is off because of a *product* decision that may be reversed, not
   * because it was a mistake. Deleting the create-tenant dialog would make
   * turning it back on a rewrite; leaving it behind a flag makes it one line.
   *
   * Nothing here is a security boundary. Every one of these controls calls an
   * endpoint that checks permissions itself — a user who edits the built bundle
   * gets the button back and the same 403 they would have got anyway.
   */
  features: {
    /**
     * Off: tenants are provisioned outside the portal.
     *
     * `POST /tenants` still exists and still works for a platform administrator.
     * What is hidden is the button — new customers are onboarded by whoever
     * operates the installation, and a self-service dialog on the operator
     * console invited a tenant to be created by whoever happened to be looking
     * at the screen.
     */
    tenantCreation: false
  }
} as const;

export type Environment = typeof environment;
