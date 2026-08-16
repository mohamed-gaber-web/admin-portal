import { inject } from "@angular/core";
import { Router, type CanActivateFn } from "@angular/router";
import { MfaChallengeStore } from "./mfa-challenge.store";
import { SessionStore } from "./session.store";

/**
 * Keeps signed-out visitors out of the shell.
 *
 * This is a usability control, not a security one. Everything behind it is
 * rendered from data the API hands over, and the API decides for itself whether
 * to hand it over — the guard only spares people the sight of a dashboard that
 * would fail to load. Treating a client-side guard as the access control is how
 * an admin portal ends up shipping data to unauthorised callers.
 */
export const authGuard: CanActivateFn = (_route, state) => {
  const session = inject(SessionStore);
  const router = inject(Router);

  // Identity alone is not a session.
  //
  // Identity persists in localStorage while the refresh token lives in
  // sessionStorage, which is per-tab — so opening the portal in a *new* tab
  // restores a name and no credential. Admitting that state rendered the shell
  // for someone who is not signed in: the dashboard filled in from fixtures and
  // looked fine, then every real request 401'd, which surfaced as screens whose
  // data was mysteriously empty rather than as "you are signed out".
  //
  // `needsCredential` is exactly this state, and session restore has already
  // run by the time a guard evaluates — it is an app initializer — so a refresh
  // token that could have been exchanged already has been.
  if (session.isAuthenticated() && !session.needsCredential()) return true;

  // Nothing usable to carry forward, and leaving the stale identity on screen
  // would keep the account menu showing someone who cannot make a request.
  if (session.needsCredential()) session.clear();

  // `returnUrl` so a deep link survives the detour through sign-in.
  return router.createUrlTree(["/login"], {
    queryParams: { returnUrl: state.url }
  });
};

/**
 * Bounces an already–signed-in user away from the sign-in page.
 *
 * Holds to the same definition of "signed in" as `authGuard`: bouncing someone
 * who has an identity but no credential would trap them, sending them to a
 * dashboard that cannot load and back again.
 */
export const guestGuard: CanActivateFn = () => {
  const session = inject(SessionStore);
  const router = inject(Router);

  return session.isAuthenticated() && !session.needsCredential()
    ? router.createUrlTree(["/dashboard"])
    : true;
};

/**
 * Keeps the cross-tenant screens out of an ordinary tenant's hands.
 *
 * Like every guard in this file, a usability control rather than the boundary.
 * The `/platform/*` endpoints refuse anyone who is not a platform administrator
 * — checked against the signed token claim *and* against the caller's tenant,
 * neither of which the browser can influence — so a user who edits their stored
 * permissions reaches a page whose every request comes back 403. This spares
 * them that, and it spares an ordinary administrator a menu entry that could
 * only ever fail.
 *
 * Redirects to the dashboard rather than to sign-in: the person is signed in
 * perfectly well, they simply have no business here.
 */
export const platformGuard: CanActivateFn = () => {
  const session = inject(SessionStore);
  const router = inject(Router);

  return session.isPlatformAdmin() ? true : router.createUrlTree(["/dashboard"]);
};

/**
 * Keeps `/mfa` reachable only mid-sign-in.
 *
 * The challenge lives in memory, so a direct visit or a reload has nothing to
 * verify and lands here with no token — showing a code field that cannot
 * succeed. Sending them back to sign in is the only recovery.
 *
 * Like `authGuard`, this is a usability control. `/auth/mfa/verify` refuses a
 * request without a valid challenge token no matter what the browser displays.
 */
export const mfaChallengeGuard: CanActivateFn = () => {
  const challenge = inject(MfaChallengeStore);
  const router = inject(Router);

  return challenge.hasChallenge() ? true : router.createUrlTree(["/login"]);
};
