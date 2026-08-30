import { inject } from "@angular/core";
import type { HttpInterceptorFn } from "@angular/common/http";
import { API_ROUTES } from "@growpath/contracts";
import { SessionStore } from "../auth/session.store";

/**
 * Routes that must never carry an Authorization header.
 *
 * Each is unauthenticated by necessity: the caller either has no credential yet
 * (sign-in, invitation, reset) or is holding one that has expired (refresh) or
 * one that is not an access token at all (the MFA challenge). Sending a stale
 * bearer token to `/auth/refresh` is the subtle case — a server that validates
 * it before reading the body would reject the very request meant to replace it.
 */
const UNAUTHENTICATED: readonly string[] = [
  API_ROUTES.login,
  API_ROUTES.refresh,
  API_ROUTES.acceptInvitation,
  API_ROUTES.requestPasswordReset,
  API_ROUTES.completePasswordReset,
  API_ROUTES.verifyMfa
];

/**
 * Attaches the access token to requests that need one.
 *
 * The token lives in memory on `SessionStore` and is read per request rather
 * than captured once, so a refresh that rotates it takes effect on the next
 * call without re-registering anything.
 */
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const session = inject(SessionStore);
  const token = session.accessToken();

  if (!token || UNAUTHENTICATED.some((route) => request.url.endsWith(route))) {
    return next(request);
  }

  return next(
    request.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
  );
};
