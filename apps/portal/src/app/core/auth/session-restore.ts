import { APP_INITIALIZER, inject, type Provider } from "@angular/core";
import { catchError, of, tap } from "rxjs";
import { AuthService } from "./auth.service";
import { SessionStore } from "./session.store";

/**
 * Trades the stored refresh token for a live session before the app renders.
 *
 * Without this the portal has an odd half-state after every page reload: the
 * identity is in localStorage so the user's name and workspace appear, but the
 * access token was memory-only and is gone — so the shell renders and every
 * authenticated request 401s. Most visibly, MFA enrolment becomes permanently
 * unreachable, because `/auth/mfa/enrol` is tenant-scoped.
 *
 * Runs as an app initializer so it completes before the first route resolves,
 * which means `authGuard` sees a settled session rather than racing it.
 *
 * A failure clears everything rather than retrying. The refresh token is single
 * use: if the exchange failed, the token is either spent, expired, or was
 * replayed — and replay signs the whole session out by design (US-023). Retrying
 * would at best repeat a spent exchange and at worst look like an attack.
 *
 * (`APP_INITIALIZER` rather than `provideAppInitializer`, which arrived in
 * Angular 19. Swap it when the app upgrades.)
 */
export function provideSessionRestore(): Provider {
  return {
    provide: APP_INITIALIZER,
    multi: true,
    useFactory: () => {
      const session = inject(SessionStore);
      const auth = inject(AuthService);

      return () => {
        // Nothing to restore: a first visit, or a tab that never signed in.
        if (!session.refreshToken()) return of(null);

        return auth.refresh().pipe(
          catchError(() => {
            session.clear();
            return of(null);
          }),
          // Belt and braces: an exchange that resolves without a session is not
          // a session, and leaving the stale identity on screen would be a lie.
          tap((restored) => {
            if (!restored) session.clear();
          })
        );
      };
    }
  };
}
