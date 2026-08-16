import { Observable, delay, of, throwError } from "rxjs";

/**
 * Stand-in for endpoints the API does not expose yet.
 *
 * As of today the API serves `POST /tenants`, `POST /auth/login`,
 * `POST /auth/accept-invitation` and the two health probes — there is no list
 * endpoint for tenants, users or the audit log. Rather than ship blank screens
 * until there is, the list features read through a service whose only mock-aware
 * line is the one that calls this.
 *
 * The delay is deliberate and not zero: an instant resolve means nobody ever
 * sees the skeleton states, and a loading state that is never exercised in
 * development is a loading state that is broken in production.
 *
 * Every call site is a single-line swap to `this.api.get(...)`. Search for this
 * function to find them all.
 */
export function mockResponse<T>(value: T, latencyMs = 550): Observable<T> {
  return of(value).pipe(delay(latencyMs));
}

/** The failing counterpart, for exercising error states by hand. */
export function mockFailure<T>(message: string, latencyMs = 550): Observable<T> {
  return throwError(() => new Error(message)).pipe(delay(latencyMs));
}
