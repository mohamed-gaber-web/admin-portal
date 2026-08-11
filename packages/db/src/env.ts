import { existsSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "./config";

/** The monorepo root, two levels above this package. */
export const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

/**
 * Loads the repo-root `.env` into process.env unless DATABASE_URL is already
 * set. The CLIs run from the package directory but developers keep a single
 * .env at the root, and an exported DATABASE_URL (as in CI) always wins.
 */
export function loadRepoEnv(): void {
  if (process.env.DATABASE_URL) {
    return;
  }
  const envPath = join(REPO_ROOT, ".env");
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}
