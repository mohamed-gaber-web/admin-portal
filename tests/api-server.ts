import { execSync, spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { repoRoot } from "./helpers";

export interface RunningApi {
  baseUrl: string;
  stop: () => void;
}

/**
 * Builds the API (turbo builds @growpath/contracts first) and starts the real
 * compiled server on the given port, resolving once /health responds.
 */
export async function startApi(
  port: number,
  env: NodeJS.ProcessEnv = {}
): Promise<RunningApi> {
  // execSync runs through the shell, which is required to invoke pnpm.cmd on Windows.
  execSync("pnpm exec turbo run build --filter=@growpath/api", {
    cwd: repoRoot,
    stdio: "inherit"
  });

  const server: ChildProcess = spawn(process.execPath, [join(repoRoot, "apps/api/dist/main.js")], {
    cwd: repoRoot,
    // Caller overrides win, so a test can point the API at a throwaway database.
    env: { ...process.env, PORT: String(port), ...env },
    stdio: "ignore"
  });

  await waitForHealth(`http://127.0.0.1:${port}/health`, 30000);

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => server.kill()
  };
}

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
