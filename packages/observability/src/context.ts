import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Per-request context (US-007).
 *
 * Held in AsyncLocalStorage so that every log line and every tenant-scoped
 * query can read it without it being threaded through each function signature.
 * A correlation ID that has to be passed by hand is one that gets dropped at
 * the first call site somebody forgets.
 */
export interface RequestContext {
  /** Follows one request end to end, including downstream calls. */
  readonly correlationId: string;
  /**
   * The authenticated tenant. Mutable because authentication resolves it after
   * the context is created — but only ever from the authenticated identity,
   * never from a header or a route parameter (see US-012).
   */
  tenantId: string | null;
  /** The authenticated user, once known. */
  userId: string | null;
  readonly method: string | null;
  readonly path: string | null;
}

export interface RequestContextSeed {
  correlationId?: string;
  tenantId?: string | null;
  userId?: string | null;
  method?: string | null;
  path?: string | null;
}

/** The header carrying the correlation ID, inbound and outbound. */
export const CORRELATION_ID_HEADER = "x-correlation-id";

/**
 * What an inbound correlation ID is allowed to look like.
 *
 * An inbound header is caller-controlled text that ends up in every log line
 * for that request, so it is accepted only in this shape — otherwise a caller
 * could inject newlines and forge log entries.
 */
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

const storage = new AsyncLocalStorage<RequestContext>();

export function newCorrelationId(): string {
  return randomUUID();
}

/**
 * Returns the inbound correlation ID if it is safe to log verbatim, else null
 * so the caller can mint a fresh one.
 */
export function sanitizeCorrelationId(raw: string | string[] | undefined | null): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return CORRELATION_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/** Runs `fn` with a fresh request context in scope. */
export function runWithRequestContext<T>(seed: RequestContextSeed, fn: () => T): T {
  const context: RequestContext = {
    correlationId: seed.correlationId ?? newCorrelationId(),
    tenantId: seed.tenantId ?? null,
    userId: seed.userId ?? null,
    method: seed.method ?? null,
    path: seed.path ?? null
  };
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * The current correlation ID, or null outside a request (a CLI, a migration,
 * a background job that nobody has wrapped yet).
 */
export function currentCorrelationId(): string | null {
  return storage.getStore()?.correlationId ?? null;
}

/**
 * Records the authenticated tenant on the current context.
 *
 * Call this from authentication only. The tenant ID must come from the verified
 * identity — if a header can set it, someone will iterate it.
 */
export function setRequestTenant(tenantId: string | null): void {
  const context = storage.getStore();
  if (!context) {
    throw new Error("setRequestTenant called outside a request context");
  }
  context.tenantId = tenantId;
}

/** Records the authenticated user on the current context. */
export function setRequestUser(userId: string | null): void {
  const context = storage.getStore();
  if (!context) {
    throw new Error("setRequestUser called outside a request context");
  }
  context.userId = userId;
}
