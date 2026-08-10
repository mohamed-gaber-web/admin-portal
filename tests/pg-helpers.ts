import { Client } from "pg";

export interface ThrowawayDatabase {
  url: string;
  drop: () => Promise<void>;
}

/**
 * Creates a fresh, uniquely-named database on the server pointed at by the admin
 * connection string, and returns its URL plus a cleanup function that drops it.
 */
export async function createThrowawayDatabase(adminUrl: string): Promise<ThrowawayDatabase> {
  const dbName = `us002_test_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  const url = withDatabase(adminUrl, dbName);

  const drop = async (): Promise<void> => {
    const a = new Client({ connectionString: adminUrl });
    await a.connect();
    try {
      await a.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [dbName]
      );
      await a.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    } finally {
      await a.end();
    }
  };

  return { url, drop };
}

function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}
