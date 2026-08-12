import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { apiLogger } from "../observability/logger";

/**
 * Access tokens carrying tenancy (US-022).
 *
 * The token is the only thing that says which tenant a request belongs to. That
 * is the point: US-012 established that the tenant must never come from a
 * header or a route parameter, because anything a caller can set is something a
 * caller can iterate. A signature is what makes a claim trustworthy.
 */

/**
 * Short, deliberately.
 *
 * Permissions are stamped into the token at sign-in rather than joined on every
 * request, so a revoked permission keeps working until the token expires.

 * Minutes bounds that window; refresh (US-023) is what keeps sessions long
 * without making the access token long-lived.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

const ISSUER = "growpath-admin-api";
const AUDIENCE = "growpath-admin-portal";
const ALGORITHM = "HS256";

/**
 * A visibly fake key used only outside production.
 *
 * Named so that finding it in a running system is unambiguous. Production
 * refuses to start without a real one — see `signingKey`.
 */
const DEVELOPMENT_ONLY_SECRET = "insecure-development-only-signing-key-do-not-use-in-production";

/** Shortest secret accepted. Below this HS256 is weaker than its own digest. */
const MIN_SECRET_LENGTH = 32;

let cachedKey: Uint8Array | undefined;
let warnedAboutDevelopmentSecret = false;

/**
 * The HMAC key, from AUTH_JWT_SECRET.
 *
 * Fails closed in production: a missing secret there would silently fall back
 * to a value published in this file, and every token in the system would be
 * forgeable by anyone who has read the repository.
 */
function signingKey(): Uint8Array {
  if (cachedKey) {
    return cachedKey;
  }

  const configured = process.env.AUTH_JWT_SECRET?.trim();
  const isProduction = process.env.NODE_ENV === "production";

  if (!configured) {
    if (isProduction) {
      throw new Error(
        "AUTH_JWT_SECRET is not set. Refusing to sign access tokens with the development key."
      );
    }
    if (!warnedAboutDevelopmentSecret) {
      apiLogger.warn("auth.token.development_key", {
        detail: "AUTH_JWT_SECRET is not set; using the development-only signing key."
      });
      warnedAboutDevelopmentSecret = true;
    }
    cachedKey = new TextEncoder().encode(DEVELOPMENT_ONLY_SECRET);
    return cachedKey;
  }

  if (configured.length < MIN_SECRET_LENGTH) {
    throw new Error(`AUTH_JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }

  cachedKey = new TextEncoder().encode(configured);
  return cachedKey;
}

/** Test seam: forget the cached key after changing AUTH_JWT_SECRET. */
export function resetSigningKey(): void {
  cachedKey = undefined;
  warnedAboutDevelopmentSecret = false;
}

export interface AccessTokenClaims {
  userId: string;
  tenantId: string;
  tenantSlug: string;
  email: string;
  permissions: string[];
}

export interface IssuedAccessToken {
  token: string;
  expiresIn: number;
}

export async function issueAccessToken(claims: AccessTokenClaims): Promise<IssuedAccessToken> {
  const token = await new SignJWT({
    tenantId: claims.tenantId,
    tenantSlug: claims.tenantSlug,
    email: claims.email,
    permissions: claims.permissions
  })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(signingKey());

  return { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

/**
 * Verifies a token and returns its claims, or null if it cannot be trusted.
 *
 * Null rather than a reason: expired, forged and malformed must all read the
 * same to the caller. Issuer and audience are checked as well as the signature,
 * so a token minted by another service sharing the key is not accepted here.
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, signingKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: [ALGORITHM]
    });
    return toClaims(payload);
  } catch {
    return null;
  }
}

/**
 * Reads claims from a verified payload, rejecting anything malformed.
 *
 * A signature proves the payload was not altered; it does not prove the payload
 * has the shape this code expects. A token signed with the right key but
 * missing its tenant must not produce a request with `tenantId: undefined`.
 */
function toClaims(payload: JWTPayload): AccessTokenClaims | null {
  const { sub, tenantId, tenantSlug, email, permissions } = payload as JWTPayload & {
    tenantId?: unknown;
    tenantSlug?: unknown;
    email?: unknown;
    permissions?: unknown;
  };

  if (
    typeof sub !== "string" ||
    typeof tenantId !== "string" ||
    typeof tenantSlug !== "string" ||
    typeof email !== "string" ||
    !Array.isArray(permissions) ||
    !permissions.every((entry) => typeof entry === "string")
  ) {
    return null;
  }

  return { userId: sub, tenantId, tenantSlug, email, permissions: permissions as string[] };
}
