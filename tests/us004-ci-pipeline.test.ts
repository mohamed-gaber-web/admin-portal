import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { readText, readJson } from "./helpers";

interface CiStep {
  run?: string;
  if?: string;
}
interface CiJob {
  needs?: string[] | string;
  services?: Record<string, { image?: string }>;
  steps?: CiStep[];
}
interface CiWorkflow {
  jobs: Record<string, CiJob>;
}

const raw = readText(".github/workflows/ci.yml");
const ci = parse(raw) as CiWorkflow;
const jobs = ci.jobs;
const allRun = Object.values(jobs)
  .flatMap((job) => job.steps ?? [])
  .map((step) => step.run ?? "")
  .join("\n");

describe("US-004 - CI pipeline on pull request", () => {
  // AC1: Given a PR, when it opens, then lint, typecheck, unit tests and build all run.
  it("AC1: a pull request runs lint, typecheck, unit tests, and build", () => {
    expect(raw).toMatch(/pull_request/);
    expect(allRun, "lint must run").toMatch(/pnpm lint/);
    expect(allRun, "typecheck must run").toMatch(/pnpm typecheck/);
    expect(allRun, "unit tests must run").toMatch(/pnpm test/);
    expect(allRun, "build must run").toMatch(/pnpm build/);
  });

  // AC2: Given a failing check, when a merge is attempted, then it is blocked.
  it("AC2: a required aggregate gate blocks merges when any check fails", () => {
    const gate = jobs["ci-success"];
    expect(gate, "ci-success gate job must exist").toBeDefined();

    const needs = Array.isArray(gate.needs) ? gate.needs : gate.needs ? [gate.needs] : [];
    for (const dep of ["lint", "typecheck", "test", "build"]) {
      expect(needs, `gate must depend on the ${dep} job`).toContain(dep);
    }

    // The gate must actually fail when an upstream job fails.
    const steps = gate.steps ?? [];
    const gateRun = steps.map((s) => s.run ?? "").join("\n");
    expect(gateRun, "gate must fail (exit 1) on failure").toMatch(/exit 1/);
    const hasResultGuard = steps.some((s) => /needs\.\*\.result/.test(s.if ?? ""));
    expect(hasResultGuard, "gate must guard on needs.*.result").toBe(true);

    // Branch protection requires that single gate check, which is what blocks the merge.
    const bp = readJson<{ required_status_checks?: { contexts?: string[] } }>(
      ".github/branch-protection.json"
    );
    expect(bp.required_status_checks?.contexts ?? []).toContain("ci-success");
  });
});
