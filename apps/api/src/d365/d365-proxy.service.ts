import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import {
  openClientSecret,
  resolveProxyTarget,
  withRequestTenantScope,
  type ConnectionCredentials
} from "@growpath/db";
import { fetchWithCorrelation } from "@growpath/observability";
import { DATABASE_POOL } from "../database/database.module";
import { apiLogger } from "../observability/logger";
import { D365TokenCache } from "./d365-token.cache";

/**
 * The ERP pass-through (US-046).
 *
 * What this replaces: the Ionic app held a `client_credentials` secret and
 * talked to D365 itself. US-040 sealed that secret on the server, which left the
 * API able to *verify* a credential and unable to *use* one. This is the other
 * half — the device talks to here, and here talks to D365.
 *
 * Two credentials meet in this file and neither may reach the other's
 * counterparty. The device's access token authorises the call and is
 * **replaced**, never forwarded: D365 has no idea who our users are, and a
 * device must never receive something it could present to the ERP directly.
 */

/**
 * How long a D365 query may take.
 *
 * Six times the token client's 10s, deliberately. A cold sandbox answering an
 * `$expand` genuinely takes fifteen seconds or more, and a ceiling tight enough
 * to feel safe would present as the app being broken.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Request headers forwarded to D365, and the complete list.
 *
 * An allowlist, and built onto an empty set rather than by deleting from the
 * incoming one. The difference matters: copy-and-delete forwards every header
 * somebody adds later — `authorization`, `cookie`, `x-forwarded-for` — so a leak
 * needs only an omission, where this needs a deliberate edit to this array.
 *
 * `if-match` and `prefer` are here because OData needs them: optimistic
 * concurrency, and `return=representation`.
 */
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "if-match",
  "if-none-match",
  "prefer",
  "odata-version",
  "odata-maxversion"
] as const;

/**
 * Response headers returned to the caller, and the complete list.
 *
 * Three deliberate absences:
 *
 * - `set-cookie` — D365 sets cookies, and on the web build they would land on
 *   our origin.
 * - `www-authenticate` — on a 401 it describes the credential *this API*
 *   presented. Handing a device a challenge for a credential it does not hold
 *   invites it to try to satisfy one, and it discloses the tenant's Entra realm.
 * - `content-length` / `content-encoding` — the body is re-framed on the way
 *   out, so the upstream's numbers would be wrong.
 */
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "etag",
  "odata-version",
  "preference-applied",
  "retry-after"
] as const;

export interface ProxyRequest {
  method: string;
  /**
   * The request URL as it arrived, still percent-encoded.
   *
   * `request.originalUrl`, never `request.params[0]`: Express URL-decodes route
   * parameters, so a key predicate containing `%2F` or `%27` would be corrupted
   * on the way out and D365 would answer about a different record.
   */
  originalUrl: string;
  headers: Record<string, string | string[] | undefined>;
  /** The unparsed body, when there was one. */
  rawBody: Buffer | undefined;
  /** Express's parsed body, used only when `rawBody` is unavailable. */
  parsedBody: unknown;
  companyId: string | null;
}

export type ProxyOutcome =
  | {
      ok: true;
      status: number;
      headers: Record<string, string>;
      body: NodeJS.ReadableStream | null;
    }
  /** No such company, or the named path escaped the allowlist. */
  | { ok: false; reason: "not_found" }
  /** More than one configured environment and no company named. */
  | { ok: false; reason: "ambiguous" }
  /** The environment exists but carries no usable credential. */
  | { ok: false; reason: "not_configured" }
  /** Reached D365 and it would not accept our credential, or we never reached it. */
  | { ok: false; reason: "unauthorized" | "unreachable" | "timeout" };

@Injectable()
export class D365ProxyService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly tokens: D365TokenCache
  ) {}

  async forward(request: ProxyRequest): Promise<ProxyOutcome> {
    const suffix = pathAndQuery(request.originalUrl);
    if (suffix === null) return { ok: false, reason: "not_found" };

    // Scoped, and short. The transaction ends before anything is sent to the
    // ERP — forwarding inside the scope would hold a Postgres connection for the
    // whole round trip, and a slow ERP under van-sales load would drain the pool
    // and take the portal down with it.
    //
    // This lookup runs on every request, including when a token is already
    // cached, and it must stay that way. It is what makes another tenant's
    // company id invisible; skipping it on a cache hit — a tempting-looking
    // optimisation, since the token is right there — would turn the cache into a
    // cross-tenant capability the moment one tenant warmed it.
    const target = await withRequestTenantScope(this.pool, (client) =>
      resolveProxyTarget(client, request.companyId)
    );
    if (!target.ok) return { ok: false, reason: target.reason };

    const url = assemble(target.url, suffix);
    if (url === null) return { ok: false, reason: "not_found" };

    const body = bodyOf(request);

    const first = await this.attempt(url, request, target.environmentId, body, false);
    if (first.kind !== "unauthorized") return first.outcome;

    // A 401 from D365 means the token went stale sooner than its `expires_in`
    // claimed — a secret rotated under us, or clock skew. Evict and try once.
    // Once, not in a loop: if a fresh token is refused too, the credential is
    // wrong, and retrying is how a service principal gets locked out.
    this.tokens.evict(target.environmentId);
    const second = await this.attempt(url, request, target.environmentId, body, true);
    return second.outcome;
  }

  private async attempt(
    url: string,
    request: ProxyRequest,
    environmentId: string,
    body: Buffer | string | undefined,
    isRetry: boolean
  ): Promise<
    { kind: "done"; outcome: ProxyOutcome } | { kind: "unauthorized"; outcome: ProxyOutcome }
  > {
    const token = await this.tokens.tokenFor(environmentId, () =>
      this.credentialsFor(environmentId)
    );

    if (!token.ok) {
      const outcome: ProxyOutcome =
        token.error === "not_configured"
          ? { ok: false, reason: "not_configured" }
          : { ok: false, reason: "unauthorized" };
      return { kind: "done", outcome };
    }

    const headers: Record<string, string> = {};
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    // Assigned last and unconditionally. The caller's own Authorization is not
    // in the allowlist above, and this line is what guarantees that even if
    // somebody added it, it would be overwritten rather than sent to the ERP.
    headers.authorization = `Bearer ${token.accessToken}`;
    if (body !== undefined && !headers["content-type"]) {
      headers["content-type"] = "application/json";
    }

    let response: Response;
    try {
      response = await fetchWithCorrelation(
        url,
        {
          method: request.method,
          headers,
          // Cast because `Buffer` is a `Uint8Array` that this lib's `BodyInit`
          // does not name; `fetch` accepts it, and forwarding the bytes as they
          // arrived is the point.
          body: body as BodyInit | undefined,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        },
        { target: "d365" }
      );
    } catch (err) {
      // The exception is classified by name only. Its message is the runtime's
      // and can name the customer's ERP host, along with DNS and TLS detail.
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      return {
        kind: "done",
        outcome: { ok: false, reason: timedOut ? "timeout" : "unreachable" }
      };
    }

    if (response.status === 401 && !isRetry) {
      // Drain, so the socket is released before the retry.
      await response.arrayBuffer().catch(() => undefined);
      return { kind: "unauthorized", outcome: { ok: false, reason: "unauthorized" } };
    }

    if (response.status === 401) {
      apiLogger.warn("d365.proxy.upstream_unauthorized", { environmentId });
      await response.arrayBuffer().catch(() => undefined);
      return { kind: "done", outcome: { ok: false, reason: "unauthorized" } };
    }

    return {
      kind: "done",
      outcome: {
        ok: true,
        status: response.status,
        headers: pick(response.headers, FORWARDED_RESPONSE_HEADERS),
        body: response.body as NodeJS.ReadableStream | null
      }
    };
  }

  /** Opens the sealed secret. Called only when the cache holds no live token. */
  private credentialsFor(environmentId: string): Promise<ConnectionCredentials | null> {
    return withRequestTenantScope(this.pool, (client) =>
      openClientSecret(client, environmentId)
    );
  }
}

/**
 * The part of the request that belongs to D365, still encoded.
 *
 * Returns null for anything that escapes the prefix. The router has already
 * matched `/d365/data/` or `/d365/api/services/`, so this is the second of two
 * checks rather than the only one — traversal is the case a single check misses,
 * because `/d365/data/../../namespaces` matches the route and is not a data
 * request.
 */
function pathAndQuery(originalUrl: string): string | null {
  const withoutPrefix = originalUrl.replace(/^\/d365/, "");
  if (withoutPrefix === originalUrl) return null;

  const [path] = withoutPrefix.split("?", 1);
  const decoded = safeDecode(path);
  if (decoded === null) return null;
  // Checked on the decoded form, so `%2e%2e%2f` cannot slip past a check that
  // only understands literal dots.
  if (decoded.includes("..") || decoded.includes("\\")) return null;

  return withoutPrefix;
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed escape is not something to guess at.
    return null;
  }
}

/**
 * The upstream URL.
 *
 * Re-parsed after assembly and checked against the environment's own origin and
 * the two allowed prefixes. The traversal guard above works on the string; this
 * works on what a URL parser actually makes of it, which is the discrepancy an
 * encoding trick lives in.
 */
function assemble(base: string, suffix: string): string | null {
  let root: URL;
  try {
    root = new URL(base);
  } catch {
    return null;
  }

  // There is no CHECK constraint on `d365_environment.url`, and this proxy is
  // the one place a value there becomes an outbound request. In production a
  // cleartext hop would disclose the ERP token on every call.
  if (process.env.NODE_ENV === "production" && root.protocol !== "https:") {
    return null;
  }

  const candidate = `${root.origin}${root.pathname.replace(/\/+$/, "")}${suffix}`;
  let assembled: URL;
  try {
    assembled = new URL(candidate);
  } catch {
    return null;
  }

  if (assembled.origin !== root.origin) return null;
  if (!/^\/(data|api\/services)\//.test(assembled.pathname)) return null;

  return assembled.toString();
}

function bodyOf(request: ProxyRequest): Buffer | string | undefined {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  // The unparsed bytes when the platform kept them, which is the only form that
  // survives a body this API does not understand.
  if (request.rawBody !== undefined) return request.rawBody;
  if (request.parsedBody === undefined || request.parsedBody === null) return undefined;
  // Re-serialised. Lossless for the OData JSON the app actually sends, and the
  // same thing the Vercel function it replaces has been doing in production.
  return JSON.stringify(request.parsedBody);
}

function pick(headers: Headers, names: readonly string[]): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null) picked[name] = value;
  }
  return picked;
}
