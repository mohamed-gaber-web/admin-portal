import { describe, it, expect } from "vitest";
import { readJson, type PackageJson } from "./helpers";

interface TurboConfig {
  tasks: Record<string, { dependsOn?: string[]; outputs?: string[] }>;
}

// AC2: Given a change to a shared package, when I build,
// then dependent apps rebuild automatically.
describe("AC2 - shared package change rebuilds dependents", () => {
  it("has both apps depend on the shared @growpath/contracts workspace package", () => {
    const api = readJson<PackageJson>("apps/api/package.json");
    const portal = readJson<PackageJson>("apps/portal/package.json");

    expect(api.dependencies?.["@growpath/contracts"]).toBe("workspace:*");
    expect(portal.dependencies?.["@growpath/contracts"]).toBe("workspace:*");
  });

  it("configures turbo so dependents rebuild when a dependency changes", () => {
    const turbo = readJson<TurboConfig>("turbo.json");
    const build = turbo.tasks.build;

    // ^build means: build this package's dependencies first — so a change to
    // @growpath/contracts forces api and portal to rebuild.
    expect(build?.dependsOn).toContain("^build");
    expect(build?.outputs).toContain("dist/**");
  });

  it("has the shared package produce a build output", () => {
    const contracts = readJson<PackageJson>("packages/contracts/package.json");
    expect(contracts.scripts?.build).toBeTruthy();
  });
});
