import type { AccessTokenClaims, ServiceTokenClaims } from "./tokens";

/**
 * The verified claims, attached by AccessTokenGuard.
 *
 * Declared optional because most routes are unauthenticated — a handler that
 * reads it must be behind the guard, and the type says so.
 *
 * At most one of the two is set: `auth` for a person, `service` for a service
 * client on a route that opted in with `@AllowServiceToken`.
 */
declare global {
  namespace Express {
    interface Request {
      auth?: AccessTokenClaims;
      service?: ServiceTokenClaims;
    }
  }
}

export {};
