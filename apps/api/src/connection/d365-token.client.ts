import { Injectable } from "@nestjs/common";
import { fetchWithCorrelation } from "@growpath/observability";
import type { ConnectionCheck, ConnectionCredentials } from "@growpath/db";
import { apiLogger } from "../observability/logger";

/**
 * The client-credentials token request, and the only thing that ever presents a
 * D365 client secret (US-042).
 *
 * This is what the mobile app used to do for itself. `environment.ts` carried
 * the grant type, the client id, the secret and the `.default` scope, so every
 * installed build could mint an application-level token against the customer's
 * ERP. Moving the exchange here is the substance of the migration: the device
 * now calls the API, and the API holds the credential.
 *
 * Nothing here logs a request or response body. A token response *is* a
 * credential, and one convenience log line would write it to disk under a
 * correlation ID that makes it easy to find.
 */

/** Long enough for a slow directory, short enough that a save cannot hang. */
const TOKEN_TIMEOUT_MS = 10_000;

/**
 * Redirects the token request at a local stub, for tests only.
 *
 * The authority host is constrained by a check constraint to three real
 * Microsoft hosts, which is right for production and leaves the acceptance
 * tests with nowhere to point. This override replaces the scheme-and-host of an
 * assembled token URL and nothing else — the directory id and path still come
 * from the stored configuration, so a test exercises the real assembly.
 *
 * **Ignored in production, loudly.** An override here redirects every client
 * secret this process holds to whatever it names, which is the single most
 * valuable environment variable an attacker could set. Honouring it outside
 * tests would make it a supported way to exfiltrate credentials.
 */
function authorityOverride(): string | null {
  const configured = process.env.D365_AUTHORITY_ORIGIN_OVERRIDE?.trim();
  if (!configured) return null;

  if (process.env.NODE_ENV === "production") {
    apiLogger.error("d365.authority.override.refused", {
      reason: "D365_AUTHORITY_ORIGIN_OVERRIDE is set in production and has been ignored."
    });
    return null;
  }
  return configured;
}

function tokenEndpoint(tokenUrl: string): string {
  const override = authorityOverride();
  if (!override) return tokenUrl;

  const target = new URL(tokenUrl);
  const replacement = new URL(override);
  target.protocol = replacement.protocol;
  target.host = replacement.host;
  return target.toString();
}

/**
 * Entra's stable error identifiers.
 *
 * Matched on the `AADSTS` code, never stored or returned. The code is a
 * documented, stable identifier; the `error_description` around it is prose that
 * carries correlation ids and the client id and changes without notice. Reading
 * one and discarding the other is what lets the API report a useful cause
 * without making a contract out of somebody else's error text.
 */
const TENANT_NOT_FOUND = /AADSTS90002/;

interface TokenErrorBody {
  error?: string;
  error_description?: string;
}

@Injectable()
export class D365TokenClient {
  /**
   * Attempts a client-credentials exchange and reports what happened.
   *
   * Returns a result rather than throwing, for the same reason `authenticate`
   * does: the caller records the outcome, and a failure that propagates as an
   * exception is a failure whose record is rolled back with the transaction that
   * was writing it.
   *
   * A successful token is discarded. Nothing here needs it — this is a check,
   * and holding the token would mean deciding where to cache a credential, which
   * is US-046's problem and not this function's.
   */
  async check(credentials: ConnectionCredentials): Promise<ConnectionCheck> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      scope: credentials.scope
    });

    let response: Response;
    try {
      response = await fetchWithCorrelation(
        tokenEndpoint(credentials.tokenUrl),
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          // Without this a wedged directory holds the HTTP request open until
          // the client gives up, and the administrator's save spins with it.
          signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
        },
        { target: "entra" }
      );
    } catch {
      // DNS failure, TLS failure, connection refused and timeout are one answer:
      // nothing was reached, so nothing was learned about the credential. The
      // exception itself is deliberately not inspected — its message is the
      // runtime's, and it can name the host and the request.
      return { ok: false, error: "unreachable" };
    }

    if (response.ok) {
      return { ok: true };
    }

    return { ok: false, error: await classify(response) };
  }
}

/**
 * Maps a rejection onto the closed set of reasons the schema allows.
 *
 * The mapping is by cause an administrator can act on, not by status code:
 * "the secret is wrong" and "the application is not in that directory" are both
 * a 400 from Entra and need entirely different fixes.
 */
async function classify(response: Response): Promise<
  "invalid_client" | "invalid_tenant" | "invalid_scope" | "unexpected"
> {
  let body: TokenErrorBody = {};
  try {
    body = (await response.json()) as TokenErrorBody;
  } catch {
    // A non-JSON body from the token endpoint means something other than Entra
    // answered — a captive portal or a proxy. Not classifiable.
    return "unexpected";
  }

  // Read for the code, then dropped. `error_description` is never stored,
  // returned or logged.
  if (body.error_description && TENANT_NOT_FOUND.test(body.error_description)) {
    return "invalid_tenant";
  }

  switch (body.error) {
    case "invalid_client":
    case "unauthorized_client":
      return "invalid_client";
    case "invalid_scope":
    case "invalid_resource":
      return "invalid_scope";
    default:
      return "unexpected";
  }
}
