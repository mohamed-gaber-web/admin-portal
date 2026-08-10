import { Pool, type PoolConfig } from "pg";

/**
 * Creates a pg connection pool. Reads DATABASE_URL by default so the API and
 * migration tooling share one connection convention.
 */
export function createPool(
  connectionString: string | undefined = process.env.DATABASE_URL,
  config: PoolConfig = {}
): Pool {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  return new Pool({ connectionString, ...config });
}
