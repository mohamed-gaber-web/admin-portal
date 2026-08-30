import { provideHttpClient, withInterceptors } from "@angular/common/http";
import {
  ApplicationConfig,
  provideZoneChangeDetection
} from "@angular/core";
import {
  provideRouter,
  withComponentInputBinding,
  withInMemoryScrolling,
  withRouterConfig
} from "@angular/router";
import { provideSessionRestore } from "@core/auth/session-restore";
import { authInterceptor } from "@core/http/auth.interceptor";
import { correlationIdInterceptor } from "@core/http/correlation-id.interceptor";
import { errorInterceptor } from "@core/http/error.interceptor";
import { routes } from "./app.routes";

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),

    provideRouter(
      routes,
      // Route params and query params arrive as component inputs, so a page can
      // declare `input('id')` instead of subscribing to ActivatedRoute.
      withComponentInputBinding(),
      // Navigating to a new page starts at the top; coming back restores where
      // you were. Without this, following a link from halfway down a long list
      // lands you halfway down the next page.
      withInMemoryScrolling({
        scrollPositionRestoration: "enabled",
        anchorScrolling: "enabled"
      }),
      // A guard that redirects re-runs the guards on the new URL. Without this
      // the redirect from an expired session to /login skips `guestGuard`.
      withRouterConfig({ paramsInheritanceStrategy: "always" })
    ),

    // Order matters. The correlation ID goes on first so any failure can
    // reference it; the auth interceptor adds the bearer token; the error
    // interceptor sits outermost so it sees the response to a fully-formed
    // request and can clear the session on a 401.
    provideHttpClient(
      withInterceptors([
        correlationIdInterceptor,
        authInterceptor,
        errorInterceptor
      ])
    ),

    // Runs before the first route resolves, so `authGuard` sees a settled
    // session rather than racing the refresh exchange.
    provideSessionRestore()
  ]
};
