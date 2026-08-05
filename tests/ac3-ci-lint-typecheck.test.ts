import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { readJson, readText, WORKSPACES, type PackageJson } from "./helpers";

interface TurboConfig {
  tasks: Record<string, unknown>;
}

interface CiWorkflow {
  jobs: Record<string, { steps: Array<{ run?: string }> }>;
}

// AC3: Given a PR, when CI runs, then lint and typecheck cover every workspace.
describe("AC3 - CI runs lint and typecheck across every workspace", () => {
  const ci = parse(readText(".github/workflows/ci.yml")) as CiWorkflow;
  const runCommands = Object.values(ci.jobs)
    .flatMap((job) => job.steps)
    .map((step) => step.run ?? "");

  it("triggers on pull requests", () => {
    const raw = readText(".github/workflows/ci.yml");
    expect(raw).toMatch(/pull_request/);
  });

  it("runs both lint and typecheck in CI", () => {
    expect(runCommands.some((c) => c.includes("pnpm lint"))).toBe(true);
    expect(runCommands.some((c) => c.includes("pnpm typecheck"))).toBe(true);
  });

  it("routes lint and typecheck through turbo (so every workspace is covered)", () => {
    const root = readJson<PackageJson>("package.json");
    const turbo = readJson<TurboConfig>("turbo.json");

    expect(root.scripts?.lint).toContain("turbo run lint");
    expect(root.scripts?.typecheck).toContain("turbo run typecheck");
    expect(turbo.tasks).toHaveProperty("lint");
    expect(turbo.tasks).toHaveProperty("typecheck");
  });

  it("defines lint and typecheck scripts in every workspace", () => {
    for (const ws of WORKSPACES) {
      const pkg = readJson<PackageJson>(`${ws.dir}/package.json`);
      expect(pkg.scripts?.lint, `${ws.name} is missing a lint script`).toBeTruthy();
      expect(
        pkg.scripts?.typecheck,
        `${ws.name} is missing a typecheck script`
      ).toBeTruthy();
    }
  });
});
