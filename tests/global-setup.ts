import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Builds the API once for the whole run.
 *
 * `startApi` used to build on every call. Vitest runs test files in parallel,
 * so several of them would invoke `turbo run build` at the same moment against
 * the same `dist` — competing for the same output directory while other
 * processes were spawning `node dist/main.js` from it. Under load that showed
 * up as an API that never became healthy, which reads like a bug in the server
 * rather than in the harness.
 *
 * Once, up front, before any test file runs.
 */
export async function setup(): Promise<void> {
  execSync("pnpm exec turbo run build --filter=@growpath/api", {
    cwd: repoRoot,
    stdio: "inherit"
  });
}
