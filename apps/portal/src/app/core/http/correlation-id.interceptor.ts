import type { HttpInterceptorFn } from "@angular/common/http";

/**
 * The header the API reads and echoes back (`@growpath/observability`).
 *
 * Written as a literal rather than imported: the portal does not depend on the
 * observability package, and pulling in a Node-oriented package for one string
 * would drag AsyncLocalStorage into a browser bundle.
 */
export const CORRELATION_ID_HEADER = "x-correlation-id";

/**
 * Tags every outbound request with a correlation ID.
 *
 * The API logs it on every line it writes while handling the request, so a
 * support ticket that quotes the ID from the browser resolves to the exact
 * server-side story. Without it, "it failed around 2pm" is the only join key
 * between the two halves of the system.
 */
export const correlationIdInterceptor: HttpInterceptorFn = (request, next) => {
  return next(
    request.clone({
      setHeaders: { [CORRELATION_ID_HEADER]: newCorrelationId() }
    })
  );
};

function newCorrelationId(): string {
  // Available in every browser the portal supports over HTTPS or localhost, but
  // absent on an insecure origin — hence the fallback rather than a bare call.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `c-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
