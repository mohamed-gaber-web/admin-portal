import { existsSync } from "node:fs";
import { join } from "node:path";

// Load the local .env (if present and DATABASE_URL isn't already set) so the
// migration tests can find a Postgres connection without exporting it each run.
const envPath = join(process.cwd(), ".env");
if (!process.env.DATABASE_URL && existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
