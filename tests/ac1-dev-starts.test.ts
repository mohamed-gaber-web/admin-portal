import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { readJson, repoRoot, type PackageJson } from "./helpers";

// AC1: Given a clean clone, when I run the install and dev commands,
// then API and portal both start.
//
// We prove the API genuinely starts by building it (turbo builds the shared
// package first) and running the real compiled server, then hitting /health.
describe("AC1 - install + dev starts API and portal", () => {
  const PORT = 34517;
  let server: ChildProcess | undefined;

  beforeAll(async () => {
    // Build the API (turbo's ^build compiles @growpath/contracts first).
    // execSync runs through the shell, which is required to invoke pnpm.cmd on Windows.
    execSync("pnpm exec turbo run build --filter=@growpath/api", {
      cwd: repoRoot,
      stdio: "inherit"
    });

    server = spawn(process.execPath, [join(repoRoot, "apps/api/dist/main.js")], {
      cwd: repoRoot,
      env: { ...process.env, PORT: String(PORT) },
      stdio: "ignore"
    });

    await waitForHealth(`http://127.0.0.1:${PORT}/health`, 30000);
  });

  afterAll(() => {
    server?.kill();
  });

  it("boots the compiled API and serves the /health endpoint", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok", service: "api" });
  });

  it("wires `dev` to start both the API and the portal", () => {
    const root = readJson<PackageJson>("package.json");
    const api = readJson<PackageJson>("apps/api/package.json");
    const portal = readJson<PackageJson>("apps/portal/package.json");

    // Root `dev` fans out across workspaces via turbo.
    expect(root.scripts?.dev).toContain("turbo run dev");
    // Each app exposes its own `dev` so turbo can start both.
    expect(api.scripts?.dev).toBeTruthy();
    expect(portal.scripts?.dev).toBeTruthy();
  });
});

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`API did not become healthy at ${url} within ${timeoutMs}ms: ${String(lastErr)}`);
}
