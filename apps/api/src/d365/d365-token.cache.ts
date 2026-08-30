import { Injectable } from "@nestjs/common";
import type { ConnectionCredentials, ConnectionErrorCode } from "@growpath/db";
import { apiLogger } from "../observability/logger";
import { D365TokenClient } from "../connection/d365-token.client";

/**
 * The ERP access token, held so a device never needs one (US-046).
 *
 * US-040 moved the D365 client secret off every installed build and onto the
 * server. That left the API able to *verify* a credential and unable to *use*
 * one — `D365TokenClient.check()` deliberately discarded its token, with a note
 * saying where the credential would have to live. This is that place.
 *
 * ### Why in process, and not Redis
 *
 * A cached token is a bearer credential. In this map it is reachable by code
 * running in this process; in Redis it is reachable by anything holding the
 * Redis URL, and `REDIS_URL` is optional locally, so the failure mode of getting
 * that wrong is a credential in an unauthenticated cache nobody remembered was
 * there. The cost is one extra token request per instance per hour, which is
 * nothing next to what a shared cache would have to be worth to justify.
 *
 * The consequence to know about: with N instances there are N tokens, all valid.
 * Entra issues them happily. Revocation is by rotating the client secret, which
 * evicts every instance the same way it always did — by making the next
 * exchange fail.
 */

/**
 * Subtracted from Entra's `expires_in` before the entry is considered live.
 *
 * A token that expires while a request is in flight to D365 comes back 401, and
 * the retry that follows costs a round trip to a customer's ERP. A minute of
 * unused life is cheaper than that, and D365 tokens last an hour.
 */
const EXPIRY_MARGIN_MS = 60_000;

export type CachedToken =
  | { ok: true; accessToken: string }
  | { ok: false; error: ConnectionErrorCode | "not_configured" };

interface Entry {
  accessToken: string;
  /** Already has the margin subtracted, so readers do arithmetic once. */
  expiresAt: number;
}

@Injectable()
export class D365TokenCache {
  private readonly tokens = new Map<string, Entry>();

  /**
   * In-flight exchanges, keyed the same way.
   *
   * The promise is stored, not the result, and that is what makes this single
   * flight: fifty devices hitting a cold cache at shift start find a promise
   * rather than a miss, and Entra sees one request instead of fifty. Storing
   * only results would make the stampede exactly as bad as no cache at all,
   * during the one moment it matters.
   */
  private readonly inFlight = new Map<string, Promise<CachedToken>>();

  constructor(private readonly client: D365TokenClient) {}

  /**
   * A usable token for one environment.
   *
   * `load` opens the sealed client secret, and is called only on a miss — it
   * runs a tenant-scoped query and an AES decrypt, and doing that per request
   * when a live token is already held would be work for nothing. It returns
   * null when the environment has no usable credential: unconfigured, or sealed
   * under a key this process no longer holds. Both mean the same thing, and
   * failing closed is the only safe reading of an unreadable credential.
   */
  async tokenFor(
    environmentId: string,
    load: () => Promise<ConnectionCredentials | null>
  ): Promise<CachedToken> {
    const live = this.tokens.get(environmentId);
    if (live && live.expiresAt > Date.now()) {
      return { ok: true, accessToken: live.accessToken };
    }

    const pending = this.inFlight.get(environmentId);
    if (pending) return pending;

    const attempt = this.acquire(environmentId, load).finally(() => {
      this.inFlight.delete(environmentId);
    });
    this.inFlight.set(environmentId, attempt);
    return attempt;
  }

  /**
   * Drops a cached token.
   *
   * Called when a connection is saved, and it has to be: a rotated secret whose
   * old token stays cached leaves the previous credential working for up to an
   * hour after an administrator believed they had replaced it.
   */
  evict(environmentId: string): void {
    this.tokens.delete(environmentId);
  }

  private async acquire(
    environmentId: string,
    load: () => Promise<ConnectionCredentials | null>
  ): Promise<CachedToken> {
    const credentials = await load();
    if (!credentials) return { ok: false, error: "not_configured" };

    const result = await this.client.exchange(credentials);
    if (!result.ok) {
      // The reason code, never the directory's `error_description` — that is
      // prose carrying correlation ids and the client id, and it changes
      // without notice. No token, no secret, no response body reaches this line.
      apiLogger.warn("d365.token.exchange_failed", {
        environmentId,
        reason: result.error
      });
      return { ok: false, error: result.error };
    }

    this.tokens.set(environmentId, {
      accessToken: result.accessToken,
      expiresAt: Date.now() + Math.max(0, result.expiresIn * 1000 - EXPIRY_MARGIN_MS)
    });

    return { ok: true, accessToken: result.accessToken };
  }
}
