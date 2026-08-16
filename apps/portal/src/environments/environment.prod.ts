/**
 * Production environment, swapped in by the `fileReplacements` entry in
 * angular.json.
 *
 * The base URL is empty on purpose: in production the portal is served from the
 * same origin as the API behind a reverse proxy, so requests go to `/auth/login`
 * rather than to a hard-coded host. That also means no CORS preflight and no
 * build-time knowledge of the deployment domain.
 */
export const environment = {
  production: true,
  apiBaseUrl: "",
  appName: "Grow Path Admin",

  /**
   * Never on in production. Fixtures exist so the UI can be built without a
   * backend; a production build serving fabricated tenants and a sign-in that
   * accepts any password would be considerably worse than a broken screen.
   */
  useMockApi: false,

  /** See the development environment for what each flag does and why. */
  features: {
    tenantCreation: false
  }
} as const;

export type Environment = typeof environment;
