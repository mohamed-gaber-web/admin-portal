#!/usr/bin/env node
/**
 * One-command local setup: check Postgres, run migrations, seed demo data.
 *
 * Assumes a PostgreSQL server is already running locally (see README). The
 * steps run in this order deliberately: an unreachable database should fail
 * with a clear message before anything tries to migrate.
 *
 * Exposed as `pnpm bootstrap`, not `pnpm setup` — `setup` is a built-in pnpm
 * command and would shadow the script.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Load the root .env here so every child process inherits DATABASE_URL —
// node-pg-migrate only reads it from the environment. An already-exported
// DATABASE_URL (as in CI) wins.
const envPath = join(repoRoot, ".env");
if (!process.env.DATABASE_URL && existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const steps = [
  {
    label: "Build @growpath/db",
    cmd: "pnpm",
    args: ["--filter", "@growpath/db", "build"],
    shell: true
  },
  {
    label: "Check Postgres is running",
    cmd: process.execPath,
    args: [join(repoRoot, "packages/db/dist/preflight-cli.js")],
    shell: false
  },
  {
    label: "Run migrations",
    cmd: "pnpm",
    args: ["--filter", "@growpath/db", "migrate:up"],
    shell: true
  },
  {
    label: "Seed demo data",
    cmd: process.execPath,
    args: [join(repoRoot, "packages/db/dist/seed-cli.js")],
    shell: false
  }
];

for (const [index, step] of steps.entries()) {
  console.log(`\n[${index + 1}/${steps.length}] ${step.label}`);
  // shell: true is required to invoke pnpm.cmd on Windows.
  const result = spawnSync(step.cmd, step.args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: step.shell
  });
  if (result.status !== 0) {
    console.error(`\nSetup failed at step ${index + 1}: ${step.label}`);
    process.exit(result.status ?? 1);
  }
}

console.log("\nLocal environment ready. Start the app with `pnpm dev`.");
