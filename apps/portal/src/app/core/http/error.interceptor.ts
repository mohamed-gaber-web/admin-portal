import {
  HttpErrorResponse,
  type HttpInterceptorFn
} from "@angular/common/http";
import { inject } from "@angular/core";
import { Router } from "@angular/router";
import { catchError, throwError } from "rxjs";
import { API_ROUTES } from "@growpath/contracts";
import { SessionStore } from "../auth/session.store";
import { ApiError } from "./api-error";

/**
 * Turns transport failures into `ApiError`, and signs the user out on a 401.
 *
 * The sign-in request is exempt from the redirect: a rejected password is a 401
 * that the login form itself must show, and bouncing to /login from /login
 * would swallow the message and look like nothing happened.
 */
export const errorInterceptor: HttpInterceptorFn = (request, next) => {
  const router = inject(Router);
  const session = inject(SessionStore);

  return next(request).pipe(
    catchError((cause: unknown) => {
      if (!(cause instanceof HttpErrorResponse)) {
        return throwError(() => cause);
      }

      const error = ApiError.from(cause);
      const isSignIn = request.url.endsWith(API_ROUTES.login);

      if (error.isUnauthorized && !isSignIn) {
        // The credential is no longer good, so the in-memory session is a lie.
        // Clear it first, then send them to sign in again, remembering where
        // they were so they land back there rather than on the dashboard.
        session.clear();
        void router.navigate(["/login"], {
          queryParams: { returnUrl: router.url }
        });
      }

      return throwError(() => error);
    })
  );
};
