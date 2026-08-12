import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { repoRoot } from "./helpers";

export interface RunningApi {
  baseUrl: string;
  stop: () => void;
  /**
   * Everything the server has written to stdout/stderr, when started with
   * `captureLogs`. Empty otherwise.
   */
  logs: () => string;
}

export interface StartApiOptions {
  /** Buffer the server's output so a test can assert on its log lines. */
  captureLogs?: boolean;
}

/**
 * Starts the real compiled server on the given port, resolving once /health
 * responds.
 *
 * The build happens once in tests/global-setup.ts, not here. Building per call
 * meant parallel test files ran concurrent `turbo build` invocations against the
 * same `dist` that other processes were already executing.
 */
export async function startApi(
  port: number,
  env: NodeJS.ProcessEnv = {},
  options: StartApiOptions = {}
): Promise<RunningApi> {
  const server: ChildProcess = spawn(process.execPath, [join(repoRoot, "apps/api/dist/main.js")], {
    cwd: repoRoot,
    // Caller overrides win, so a test can point the API at a throwaway database.
    env: { ...process.env, PORT: String(port), ...env },
    // Piped streams must be drained or the child blocks once its buffer fills.
    stdio: options.captureLogs ? ["ignore", "pipe", "pipe"] : "ignore"
  });

  let captured = "";
  if (options.captureLogs) {
    server.stdout?.on("data", (chunk: Buffer) => {
      captured += chunk.toString("utf8");
    });
    server.stderr?.on("data", (chunk: Buffer) => {
      captured += chunk.toString("utf8");
    });
  }

  await waitForHealth(`http://127.0.0.1:${port}/health`, 30000);

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => server.kill(),
    logs: () => captured
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
