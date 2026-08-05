import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import swc from "unplugin-swc";

// Root test runner for the monorepo-contract tests (one per acceptance criterion).
// SWC emits decorator metadata so the NestJS app can be booted in-process (AC1).
// The @growpath/contracts alias resolves the shared package from source, so tests
// don't require a prior build step.
export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: "es2022"
      },
      module: { type: "es6" }
    })
  ],
  resolve: {
    alias: {
      "@growpath/contracts": fileURLToPath(
        new URL("./packages/contracts/src/index.ts", import.meta.url)
      )
    }
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000
  }
});
