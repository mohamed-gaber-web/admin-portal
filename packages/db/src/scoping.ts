import { createLogger, getRequestContext, type Logger } from "@growpath/observability";
import type { Pool, PoolClient } from "pg";
import { TENANT_CONTEXT_SETTING } from "./rls";

/**
 * Automatic tenant scoping (US-012).
 *
 * `withTenantContext` (US-011) takes a tenant ID as an argument, which means
 * every caller is one typo away from scoping to the wrong tenant and one
 * forgotten call away from scoping to none. This module removes the choice: the
 * tenant comes from the authenticated request context and from nowhere else.
 *
 * There is deliberately no `tenantId` parameter here. A parameter can be fed
 * from a header or a route param, and if a header can set the tenant, someone
 * will iterate it.
 */

const dbLogger = createLogger({ name: "db" });

/**
 * The unprivileged role the RLS policies actually apply to.
 *
 * Superusers bypass row level security unconditionally, so scoping a superuser
 * session would look identical and enforce nothing. Every scoped query drops to
 * this role for the duration of the transaction.
 */
export const APPLICATION_ROLE = "app_user";

/** Raised when scoped access is attempted with no authenticated tenant. */
export class MissingTenantContextError extends Error {
  constructor() {
    super(
      "No tenant in the request context. Scoped queries require an authenticated tenant; " +
        "for a deliberate platform-level operation use withoutTenantScope() with a reason."
    );
    this.name = "MissingTenantContextError";
  }
}

/** Raised when the escape hatch is used without saying why. */
export class UnscopedAccessError extends Error {
  constructor() {
    super("withoutTenantScope() requires a non-empty reason — it is recorded in the log.");
    this.name = "UnscopedAccessError";
  }
}

/**
 * Runs `fn` against a client scoped to the tenant on the current request
 * context. Every query on that client is filtered by the database itself.
 *
 * Fails closed: with no tenant in context this throws rather than running
 * unscoped, so the failure mode of forgetting authentication is an error, not
 * a cross-tenant read.
 */
export async function withRequestTenantScope<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const tenantId = getRequestContext()?.tenantId ?? null;
  if (!tenantId) {
    throw new MissingTenantContextError();
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${APPLICATION_ROLE}`);
    // Transaction-local, so the context cannot leak to the next borrower of a
    // pooled connection.
    await client.query("SELECT set_config($1, $2, true)", [TENANT_CONTEXT_SETTING, tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface UnscopedAccessOptions {
  /** Why tenant scoping does not apply. Required, and recorded in the log. */
  reason: string;
  /** Overridable so a test can capture the warning. */
  logger?: Logger;
}

/**
 * The escape hatch: runs `fn` on the admin connection with no tenant scoping.
 *
 * Two things make this safe to have. It cannot be reached by accident — the
 * name says what it does and the reason is mandatory — and every use writes a
 * warning carrying the reason and the request's correlation ID, so a review can
 * ask why any particular bypass exists.
 */
export async function withoutTenantScope<T>(
  pool: Pool,
  options: UnscopedAccessOptions,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const reason = options.reason?.trim();
  if (!reason) {
    throw new UnscopedAccessError();
  }

  const log = options.logger ?? dbLogger;
  log.warn("tenant.scope.bypassed", { reason, callSite: callSite() });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Best-effort caller location, so the log line points at the bypass itself. */
function callSite(): string | null {
  const frames = new Error().stack?.split("\n") ?? [];
  // [0] "Error", [1] callSite, [2] withoutTenantScope, [3] the caller.
  return frames[3]?.trim() ?? null;
}
