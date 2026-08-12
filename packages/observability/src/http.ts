import { CORRELATION_ID_HEADER, currentCorrelationId, newCorrelationId } from "./context";
import { logger as defaultLogger, type Logger } from "./logger";

/**
 * Outbound HTTP carrying the originating correlation ID (US-007 AC2).
 *
 * The D365 client arrives in Sprint 5; when it does it calls through here, and
 * its calls land in the log under the same correlation ID as the request that
 * triggered them.
 */

/** Headers to attach to a downstream call so it joins the same trace. */
export function correlationHeaders(
  extra: Record<string, string> = {}
): Record<string, string> {
  return { ...extra, [CORRELATION_ID_HEADER]: currentCorrelationId() ?? newCorrelationId() };
}

/**
 * A URL reduced to what is safe to log.
 *
 * The query string is dropped, not redacted: OAuth codes, SAS tokens and
 * session IDs all travel there, and no key-based rule can catch them once
 * they are flattened into a string.
 */
export function loggableTarget(input: string | URL): string {
  try {
    const url = input instanceof URL ? input : new URL(input);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "[unparseable-url]";
  }
}

export interface DownstreamCallOptions {
  /** Names the system being called, e.g. "d365". Appears on the log line. */
  target?: string;
  logger?: Logger;
}

/**
 * `fetch` with the correlation ID attached and the call logged at both ends.
 *
 * Request and response bodies are never logged — a D365 token response body is
 * a credential, and one convenience log line would write it to disk.
 */
export async function fetchWithCorrelation(
  input: string | URL,
  init: RequestInit = {},
  options: DownstreamCallOptions = {}
): Promise<Response> {
  const log = options.logger ?? defaultLogger;
  const target = options.target ?? "downstream";
  const url = loggableTarget(input);
  const method = (init.method ?? "GET").toUpperCase();

  const headers = new Headers(init.headers);
  headers.set(CORRELATION_ID_HEADER, currentCorrelationId() ?? newCorrelationId());

  const startedAt = process.hrtime.bigint();
  log.debug("downstream.request.started", { target, method, url });

  try {
    const response = await fetch(input, { ...init, headers });
    log.info("downstream.request.completed", {
      target,
      method,
      url,
      status: response.status,
      durationMs: elapsedMs(startedAt)
    });
    return response;
  } catch (err) {
    log.error("downstream.request.failed", {
      target,
      method,
      url,
      durationMs: elapsedMs(startedAt),
      err
    });
    throw err;
  }
}

function elapsedMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}
