import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./helpers";
import { API_ROUTES } from "../packages/contracts/src/routes";
import type { DeclaredRoute } from "./route-manifest";

const CONTROLLER_DIR = join(repoRoot, "apps/api/src");
const ISOLATION_DIR = join(repoRoot, "tests/isolation");

export interface DiscoveredRoute {
  method: string;
  /** Null when the decorator argument could not be resolved statically. */
  path: string | null;
  /** Raw decorator argument, for the failure message. */
  rawArgument: string;
  source: string;
}

export type ProblemKind = "undeclared" | "stale" | "uncovered" | "unresolvable";

export interface GuardProblem {
  kind: ProblemKind;
  route: string;
  detail: string;
}

/** Canonical key used in the manifest and in `coversRoute` markers. */
export const routeKey = (method: string, path: string): string => `${method} ${path}`;

/**
 * Marks an isolation test as covering a route. Doubles as the describe() label
 * and as the static marker the guard scans for, so the two cannot drift.
 */
export function coversRoute(key: string): string {
  return `isolation: ${key}`;
}

function listFiles(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(suffix))
    .map((entry) => join(dir, entry));
}

function joinPaths(prefix: string, path: string): string {
  const clean = (part: string): string => part.replace(/^\/+|\/+$/g, "");
  const segments = [clean(prefix), clean(path)].filter(Boolean);
  return `/${segments.join("/")}`;
}

/** Resolves a route decorator argument to a literal path, or null if it cannot. */
function resolveArgument(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return "";
  }
  const literal = trimmed.match(/^["'`]([^"'`]*)["'`]$/);
  if (literal) {
    return literal[1];
  }
  const constant = trimmed.match(/^API_ROUTES\.(\w+)$/);
  if (constant) {
    return (API_ROUTES as Record<string, string>)[constant[1]] ?? null;
  }
  return null;
}

/**
 * Finds every HTTP route declared by the Nest controllers.
 *
 * This is a static scan, not a runtime introspection of the Nest router: it
 * must work without booting the app or a database. It understands string
 * literals and `API_ROUTES.*`; anything else is reported as unresolvable rather
 * than silently skipped, because a route the guard cannot read is a route the
 * guard cannot protect.
 */
export function discoverRoutes(): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];

  for (const file of listFiles(CONTROLLER_DIR, ".controller.ts")) {
    const source = readFileSync(file, "utf8");
    const relative = file.slice(repoRoot.length + 1).replace(/\\/g, "/");

    const controller = source.match(/@Controller\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/);
    const prefix = controller?.[1] ?? "";

    const decorator = /@(Get|Post|Put|Patch|Delete)\(([^)]*)\)/g;
    let match: RegExpExecArray | null;
    while ((match = decorator.exec(source)) !== null) {
      const method = match[1].toUpperCase();
      const rawArgument = match[2];
      const resolved = resolveArgument(rawArgument);
      routes.push({
        method,
        path: resolved === null ? null : joinPaths(prefix, resolved),
        rawArgument: rawArgument.trim(),
        source: relative
      });
    }
  }

  return routes;
}

/** Route keys claimed by isolation tests via `coversRoute("...")`. */
export function listIsolationCoveredRoutes(): string[] {
  const covered = new Set<string>();
  for (const file of listFiles(ISOLATION_DIR, ".ts")) {
    const source = readFileSync(file, "utf8");
    const marker = /coversRoute\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = marker.exec(source)) !== null) {
      covered.add(match[1]);
    }
  }
  return [...covered].sort();
}

/**
 * The guard itself, as a pure function so it can be exercised against synthetic
 * input. Returns everything wrong; an empty array means the API is fully
 * classified and every tenant-scoped route has an isolation test.
 */
export function findRouteGuardProblems(
  discovered: DiscoveredRoute[],
  declared: DeclaredRoute[],
  coveredRoutes: string[]
): GuardProblem[] {
  const problems: GuardProblem[] = [];
  const declaredByKey = new Map(declared.map((r) => [routeKey(r.method, r.path), r]));
  const discoveredKeys = new Set<string>();

  for (const route of discovered) {
    if (route.path === null) {
      problems.push({
        kind: "unresolvable",
        route: `${route.method} ${route.rawArgument || "<empty>"}`,
        detail: `${route.source} declares a route the guard cannot read statically. Use a string literal or an API_ROUTES entry.`
      });
      continue;
    }

    const key = routeKey(route.method, route.path);
    discoveredKeys.add(key);

    if (!declaredByKey.has(key)) {
      problems.push({
        kind: "undeclared",
        route: key,
        detail: `${route.source} declares this route but tests/route-manifest.ts does not. Classify it, and add an isolation test if it is tenant-scoped.`
      });
    }
  }

  for (const route of declared) {
    const key = routeKey(route.method, route.path);

    if (!discoveredKeys.has(key)) {
      problems.push({
        kind: "stale",
        route: key,
        detail: "tests/route-manifest.ts lists this route but no controller declares it. Remove the entry."
      });
      continue;
    }

    if (route.visibility === "tenant-scoped" && !coveredRoutes.includes(key)) {
      problems.push({
        kind: "uncovered",
        route: key,
        detail: `Tenant-scoped route with no isolation test. Add one under tests/isolation/ declaring coversRoute("${key}").`
      });
    }
  }

  return problems;
}
