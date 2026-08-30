/**
 * Production environment, swapped in by the `fileReplacements` entry in
 * angular.json.
 *
 * Same-origin, via a `/api` prefix the host rewrites to the API. Requests go to
 * `/api/auth/login`, so there is no CORS preflight and no build-time knowledge
 * of the API's domain — the rewrite carries that, and it can move without a
 * rebuild.
 *
 * ### Why a prefix rather than an empty string
 *
 * This was `""`, on the reasoning that a reverse proxy would put the portal and
 * the API on one origin and `/auth/login` would just work. It cannot: the
 * portal's *own* routes collide with the API's paths. `/tenants`, `/users`,
 * `/roles`, `/activity` and `/platform/tenants/:id` are all real screens and
 * all real endpoints, so a proxy matching them at the root would send the
 * browser's navigation to the API and return JSON where a page belongs.
 *
 * A prefix nothing in the router claims removes the ambiguity. See `vercel.json`
 * for the rewrite that strips it.
 */
export const environment = {
  production: true,
  apiBaseUrl: "/api",
  appName: "Grow Path Admin",

  /**
   * Never on in production. Fixtures exist so the UI can be built without a
   * backend; a production build serving fabricated tenants and a sign-in that
   * accepts any password would be considerably worse than a broken screen.
   */
  useMockApi: false,

  /** See the development environment for what each flag does and why. */
  features: {}
} as const;

export type Environment = typeof environment;
