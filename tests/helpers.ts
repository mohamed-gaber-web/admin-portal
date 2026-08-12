import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, "..");

/** Every workspace that must be covered by shared tooling. */
export const WORKSPACES = [
  { name: "@growpath/api", dir: "apps/api" },
  { name: "@growpath/portal", dir: "apps/portal" },
  { name: "@growpath/contracts", dir: "packages/contracts" },
  { name: "@growpath/db", dir: "packages/db" },
  { name: "@growpath/observability", dir: "packages/observability" }
] as const;

export function readJson<T = Record<string, unknown>>(relativePath: string): T {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8")) as T;
}

export function readText(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

export interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
