import { Client } from "pg";

/** How long to wait for a connection before declaring Postgres unreachable. */
const CONNECT_TIMEOUT_MS = 5000;

const NO_URL_MESSAGE = [
  "DATABASE_URL is not set.",
  "",
  "Copy .env.example to .env at the repo root and point DATABASE_URL at your",
  "local Postgres, for example:",
  "",
  "  DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres",
  "",
  "The account needs CREATEDB rights — the tests create and drop throwaway databases."
].join("\n");

export interface DatabaseInfo {
  /** Full `version()` string reported by the server. */
  version: string;
  /** Database the connection landed in. */
  database: string;
  /** Whether this account can CREATE DATABASE (required by the tests). */
  canCreateDatabase: boolean;
}

/** Returns the connection string with any password replaced, safe to print. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return "<unparseable DATABASE_URL>";
  }
}

function unreachableMessage(url: string, cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return [
    `Cannot reach Postgres at ${redactUrl(url)}`,
    `  ${detail}`,
    "",
    "Check that:",
    "  - the PostgreSQL service is running (Windows: Get-Service postgresql*)",
    "  - the host and port in DATABASE_URL match the server",
    "  - the user and password are correct"
  ].join("\n");
}

/**
 * Verifies Postgres is running and reachable, and reports what it found.
 * Throws with actionable guidance rather than a bare driver error — this is the
 * first thing a developer hits on a new machine.
 */
export async function checkDatabase(
  connectionString: string | undefined = process.env.DATABASE_URL
): Promise<DatabaseInfo> {
  if (!connectionString) {
    throw new Error(NO_URL_MESSAGE);
  }

  const client = new Client({ connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  try {
    await client.connect();
  } catch (err) {
    // The driver's own message ("ECONNREFUSED 127.0.0.1:5432") says nothing
    // about what to do next, so wrap it.
    await client.end().catch(() => undefined);
    throw new Error(unreachableMessage(connectionString, err));
  }

  try {
    const res = await client.query<{ version: string; database: string; can_create: boolean }>(
      `SELECT version() AS version,
              current_database() AS database,
              (SELECT rolsuper OR rolcreatedb FROM pg_roles WHERE rolname = current_user) AS can_create`
    );
    const row = res.rows[0];
    if (!row) {
      throw new Error("Postgres returned no rows for the preflight query");
    }
    return {
      version: row.version,
      database: row.database,
      canCreateDatabase: Boolean(row.can_create)
    };
  } finally {
    await client.end();
  }
}
