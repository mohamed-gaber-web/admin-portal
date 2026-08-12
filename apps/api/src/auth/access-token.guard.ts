import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext
} from "@nestjs/common";
import { setRequestTenant, setRequestUser } from "@growpath/observability";
import type { Request } from "express";
import { verifyAccessToken } from "./tokens";

/**
 * Establishes the request's tenant from a bearer token, and from nothing else.
 *
 * This is US-012's rule enforced at the edge. `setRequestTenant` is called here
 * and only here: the tenant a request operates on comes from a signed claim,
 * never from a header, a query parameter or a route parameter. Anything a
 * caller can type is something a caller can iterate.
 *
 * Fails closed. If the token is absent, expired, forged or malformed, the guard
 * rejects and no tenant is ever set — so a route reached without a valid token
 * has no context to run under, rather than a default one.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    const token = bearerToken(request.headers.authorization);
    if (!token) {
      throw new UnauthorizedException({ message: "Authentication required." });
    }

    const claims = await verifyAccessToken(token);
    if (!claims) {
      // One message for expired, forged and malformed alike. Which one it was
      // tells an attacker whether they hold a real token.
      throw new UnauthorizedException({ message: "Authentication required." });
    }

    setRequestTenant(claims.tenantId);
    setRequestUser(claims.userId);

    // Carried for handlers that need the caller's identity or permissions
    // without re-verifying. The tenant is deliberately not read from here by
    // data access — that comes from the request context, via
    // withRequestTenantScope.
    request.auth = claims;

    return true;
  }
}

function bearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const [scheme, value] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && value ? value.trim() : null;
}
