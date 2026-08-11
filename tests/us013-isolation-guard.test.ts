import { describe, it, expect } from "vitest";
import {
  discoverRoutes,
  findRouteGuardProblems,
  listIsolationCoveredRoutes,
  routeKey,
  type DiscoveredRoute
} from "./route-guard";
import { DECLARED_ROUTES, type DeclaredRoute } from "./route-manifest";

const route = (
  method: string,
  path: string | null,
  source = "apps/api/src/x/x.controller.ts"
): DiscoveredRoute => ({
  method,
  path,
  rawArgument: path === null ? "somePathVariable" : `"${path}"`,
  source
});

describe("US-013 - cross-tenant isolation guard", () => {
  // AC2: Given a new API route, when merged without an isolation test, then CI fails.
  //
  // AC1 (404 not 403 on another tenant's resource) and AC3 (the suite covers
  // every tenant-scoped endpoint) are NOT covered: the API exposes no
  // tenant-scoped endpoint yet, so both would pass vacuously. See the US-013
  // report. This guard is what forces the first such endpoint to arrive with
  // its isolation test.
  it("AC2: a route added without classification or an isolation test fails the guard", () => {
    // The API as it stands is fully classified.
    const problems = findRouteGuardProblems(
      discoverRoutes(),
      DECLARED_ROUTES,
      listIsolationCoveredRoutes()
    );
    expect(
      problems,
      `route guard problems:\n${problems.map((p) => `  [${p.kind}] ${p.route} — ${p.detail}`).join("\n")}`
    ).toEqual([]);

    // Every route the controllers declare could actually be read. An
    // unresolvable one would mean the guard is silently protecting less than it
    // appears to.
    expect(discoverRoutes().filter((r) => r.path === null)).toEqual([]);

    // --- Negative controls -------------------------------------------------
    // Without these, this test would pass just as happily against a guard that
    // always returns an empty array.

    const declared: DeclaredRoute[] = [
      { method: "GET", path: "/health", visibility: "public", note: "" },
      { method: "GET", path: "/companies", visibility: "tenant-scoped", note: "" }
    ];

    // 1. A brand-new route nobody classified.
    const undeclared = findRouteGuardProblems(
      [route("GET", "/health"), route("GET", "/companies"), route("GET", "/invoices")],
      declared,
      [routeKey("GET", "/companies")]
    );
    expect(undeclared.map((p) => p.kind)).toContain("undeclared");
    expect(undeclared.find((p) => p.kind === "undeclared")?.route).toBe("GET /invoices");

    // 2. A tenant-scoped route classified but with no isolation test.
    const uncovered = findRouteGuardProblems(
      [route("GET", "/health"), route("GET", "/companies")],
      declared,
      [] // no isolation test claims it
    );
    expect(uncovered.map((p) => p.kind)).toContain("uncovered");
    expect(uncovered.find((p) => p.kind === "uncovered")?.route).toBe("GET /companies");

    // 3. A route the guard cannot read statically must fail loudly, not be skipped.
    const unresolvable = findRouteGuardProblems([route("GET", null)], [], []);
    expect(unresolvable.map((p) => p.kind)).toEqual(["unresolvable"]);

    // 4. A manifest entry for a route that no longer exists.
    const stale = findRouteGuardProblems([route("GET", "/health")], declared, []);
    expect(stale.map((p) => p.kind)).toContain("stale");
    expect(stale.find((p) => p.kind === "stale")?.route).toBe("GET /companies");

    // 5. And the clean case really is clean — the guard is not simply always angry.
    expect(
      findRouteGuardProblems(
        [route("GET", "/health"), route("GET", "/companies")],
        declared,
        [routeKey("GET", "/companies")]
      )
    ).toEqual([]);
  });
});
