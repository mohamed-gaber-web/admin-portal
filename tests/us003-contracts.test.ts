import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { repoRoot } from "./helpers";
import { startApi, type RunningApi } from "./api-server";

const FIXTURES = join(repoRoot, "tests/fixtures/us003");

interface TscResult {
  ok: boolean;
  output: string;
}

function tscCheck(file: string): TscResult {
  const cmd = `pnpm exec tsc --noEmit --strict --skipLibCheck --module commonjs --moduleResolution node --esModuleInterop "${file}"`;
  try {
    const out = execSync(cmd, { cwd: repoRoot, encoding: "utf8", stdio: "pipe" });
    return { ok: true, output: out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("US-003 - shared contracts package", () => {
  const PORT = 34611;
  let api: RunningApi | undefined;

  beforeAll(async () => {
    // Builds @growpath/contracts (so the AC1 fixtures resolve its types) and
    // starts the real API for the AC2 validation checks.
    api = await startApi(PORT);
  });

  afterAll(() => {
    api?.stop();
  });

  // AC1: Given a schema change, when I build, then consumers fail at compile time.
  it("AC1: consumers of the shared types fail at compile time on schema drift", () => {
    const valid = tscCheck(join(FIXTURES, "valid.ts"));
    expect(valid.ok, `expected valid fixture to compile:\n${valid.output}`).toBe(true);

    const invalid = tscCheck(join(FIXTURES, "invalid.ts"));
    expect(invalid.ok, "expected invalid fixture to FAIL compilation").toBe(false);
    expect(invalid.output).toMatch(/slug/); // the missing required field is named in the error
  });

  // AC2: Given any API request, when it is handled, then it is validated against the shared schema.
  it("AC2: the API validates requests against the shared schema", async () => {
    const base = api!.baseUrl;

    const good = await fetch(`${base}/tenants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Acme", slug: "acme" })
    });
    expect(good.status).toBe(201);
    await expect(good.json()).resolves.toEqual({ tenant: { name: "Acme", slug: "acme" } });

    // Missing required `slug` -> rejected by the shared schema.
    const bad = await fetch(`${base}/tenants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Acme" })
    });
    expect(bad.status).toBe(400);

    // Wrong shape for `slug` -> also rejected.
    const badSlug = await fetch(`${base}/tenants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Acme", slug: "Not A Slug!" })
    });
    expect(badSlug.status).toBe(400);
  });
});
