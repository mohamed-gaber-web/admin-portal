import { catchError, of, type Observable, type OperatorFunction } from "rxjs";
import { ApiError } from "./api-error";

/**
 * Turns a 404 into `null`, and lets every other failure through.
 *
 * Detail screens are reached by URL, so a stale bookmark or a deleted row is a
 * normal thing to encounter — those screens render an empty state for it rather
 * than a red error, and this is what lets them tell the two apart.
 *
 * Deliberately narrow. Only 404 is swallowed: a 500 or a dropped connection
 * also produces no record, and reporting those as "not found" would tell
 * someone their data is gone when the server is merely down.
 */
export function nullOnNotFound<T>(): OperatorFunction<T, T | null> {
  return catchError((error: unknown): Observable<T | null> => {
    if (error instanceof ApiError && error.status === 404) {
      return of(null);
    }
    throw error;
  });
}
