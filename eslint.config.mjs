// Shared flat ESLint config for every workspace.
// Each workspace's `lint` script runs `eslint src` and picks this up.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/.angular/**", "**/node_modules/**", "**/coverage/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn"
    }
  }
);
