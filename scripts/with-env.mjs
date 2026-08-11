#!/usr/bin/env node
/**
 * Runs a command with the repo-root .env loaded into its environment.
 *
 * node-pg-migrate reads DATABASE_URL from the environment and only loads a .env
 * file when the optional `dotenv` dependency is installed, which it is not.
 * Rather than add a dependency for one variable, wrap the command here.
 *
 * Usage: node scripts/with-env.mjs <command> [args...]
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// An already-exported DATABASE_URL (as in CI) wins over the local .env.
const envPath = join(repoRoot, ".env");
if (!process.env.DATABASE_URL && existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: node scripts/with-env.mjs <command> [args...]");
  process.exit(1);
}

// shell: true is required to invoke pnpm.cmd on Windows.
const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit", shell: true });
process.exit(result.status ?? 1);
