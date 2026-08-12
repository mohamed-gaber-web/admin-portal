import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Root test runner for the monorepo-contract tests (one per acceptance criterion).
// Tests use only Node built-ins plus config parsing, so no special transforms are needed.
export default defineConfig({
  resolve: {
    alias: {
      // The tests import package sources directly (e.g. ../packages/db/src/audit),
      // and those sources import @growpath/observability. Point that at its
      // source too, so a test run never depends on dist being built first.
      "@growpath/observability": fileURLToPath(
        new URL("./packages/observability/src/index.ts", import.meta.url)
      )
    }
  },
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup-env.ts"],
    environment: "node",
    globals: true,
    testTimeout: 120000,
    hookTimeout: 120000
  }
});
