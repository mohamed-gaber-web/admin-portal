import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { readText } from "./helpers";

interface CiJob {
  services?: Record<string, { image?: string }>;
  steps?: Array<{ run?: string }>;
}

interface CiWorkflow {
  jobs: Record<string, CiJob>;
}

// AC3: Given CI, when a PR adds a migration, then it runs against a throwaway database.
describe("US-002 AC3 - CI runs migrations against a throwaway database", () => {
  const ci = parse(readText(".github/workflows/ci.yml")) as CiWorkflow;
  const jobs = Object.values(ci.jobs);

  it("has a CI job with a postgres service container that runs migrations up and down", () => {
    const dbJobs = jobs.filter(
      (job) =>
        job.services !== undefined &&
        Object.values(job.services).some((svc) => (svc.image ?? "").includes("postgres"))
    );

    expect(dbJobs.length, "no CI job defines a postgres service container").toBeGreaterThan(0);

    const runCommands = dbJobs.flatMap((job) => job.steps ?? []).map((step) => step.run ?? "");
    const joined = runCommands.join("\n");

    expect(joined, "CI must run migrations up against the throwaway DB").toMatch(/migrate:up/);
    expect(joined, "CI must exercise rollback against the throwaway DB").toMatch(/migrate:down/);
  });
});
