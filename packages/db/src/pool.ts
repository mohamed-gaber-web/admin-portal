import { createLogger } from "@growpath/observability";
import { Pool, type PoolConfig } from "pg";

const poolLogger = createLogger({ name: "db.pool" });

/**
 * Creates a pg connection pool. Reads DATABASE_URL by default so the API and
 * migration tooling share one connection convention.
 *
 * The `error` listener is not optional. `pg` emits `error` on the *pool* when a
 * client sitting idle in it fails — a Postgres restart, an idle timeout, a
 * firewall dropping a long-lived socket — and an EventEmitter that emits
 * `error` with no listener terminates the process. This is not theoretical: the
 * API died on exactly that, an `ECONNRESET` on a connection with a use count in
 * the thousands, taking down every request in flight because one idle socket
 * went away.
 *
 * Swallowing it is correct here. The pool discards the broken client and opens
 * a fresh one on the next checkout, so the recovery is automatic and the only
 * thing the process has to do is not die. It is logged rather than ignored,
 * because a burst of these is a real signal about the network or the database
 * even though any single one is routine.
 */
export function createPool(
  connectionString: string | undefined = process.env.DATABASE_URL,
  config: PoolConfig = {}
): Pool {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  const pool = new Pool({ connectionString, ...config });

  pool.on("error", (err: Error) => {
    // No correlation ID on purpose: an idle client belongs to no request. The
    // request that later needs a connection gets a healthy one.
    poolLogger.error("db.pool.idle_client_error", {
      detail: err.message,
      name: err.name
    });
  });

  return pool;
}
