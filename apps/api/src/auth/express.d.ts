import type { AccessTokenClaims } from "./tokens";

/**
 * The verified claims, attached by AccessTokenGuard.
 *
 * Declared optional because most routes are unauthenticated — a handler that
 * reads it must be behind the guard, and the type says so.
 */
declare global {
  namespace Express {
    interface Request {
      auth?: AccessTokenClaims;
    }
  }
}

export {};
