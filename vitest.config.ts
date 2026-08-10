import { defineConfig } from "vitest/config";

// Root test runner for the monorepo-contract tests (one per acceptance criterion).
// Tests use only Node built-ins plus config parsing, so no special transforms are needed.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup-env.ts"],
    environment: "node",
    globals: true,
    testTimeout: 120000,
    hookTimeout: 120000
  }
});
