import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { startApi, type RunningApi } from "./api-server";
import {
  CORRELATION_ID_HEADER,
  createLogger,
  fetchWithCorrelation,
  runWithRequestContext,
  sanitizeCorrelationId,
  setRequestTenant,
  setRequestUser
} from "../packages/observability/src/index";

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  // The API refuses to boot without a connection string, so the over-HTTP half
  // of AC1 and AC3 cannot run. Don't skip silently.
  console.warn(
    "[US-007] DATABASE_URL not set — the over-HTTP logging assertions are SKIPPED. The unit-level ones still run."
  );
}

/** Collects the lines a logger writes, so a test can read them back. */
function recordingLogger(name = "test"): {
  logger: ReturnType<typeof createLogger>;
  lines: Record<string, unknown>[];
  raw: string[];
} {
  const raw: string[] = [];
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    name,
    level: "debug",
    sink: (line) => {
      raw.push(line);
      lines.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  return { logger, lines, raw };
}

/** Every JSON line the server has emitted so far. Nest's own banner is not JSON. */
function jsonLines(api: RunningApi): Record<string, unknown>[] {
  return api
    .logs()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

/** The completion log arrives just after the response, so give it a moment. */
async function waitForLine(
  api: RunningApi,
  match: (line: Record<string, unknown>) => boolean,
  timeoutMs = 5000
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = jsonLines(api).find(match);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no matching log line within ${timeoutMs}ms. Captured:\n${api.logs()}`);
}

describe("US-007 - structured logging with correlation IDs", () => {
  // AC1: Given any request, when it is logged, then it carries a correlation
  // ID, tenant ID and user ID.
  it("AC1: every line carries the correlation, tenant and user IDs from the request context", () => {
    const { logger, lines } = recordingLogger("api");

    // Authentication does not exist yet (Sprint 3), so the identity arrives on
    // the context mid-request. That is exactly the case this must survive: the
    // logger reads the context per line rather than capturing it once.
    runWithRequestContext({ correlationId: "corr-aaaaaaaa-1111" }, () => {
      logger.info("request.received");
      setRequestTenant("tenant-abc");
      setRequestUser("user-xyz");
      logger.info("request.authenticated");
    });

    expect(lines[0]).toMatchObject({
      msg: "request.received",
      correlationId: "corr-aaaaaaaa-1111",
      tenantId: null,
      userId: null
    });
    expect(lines[1]).toMatchObject({
      msg: "request.authenticated",
      correlationId: "corr-aaaaaaaa-1111",
      tenantId: "tenant-abc",
      userId: "user-xyz"
    });

    // Outside a request the three keys are still present, so "unknown" is a
    // visible null rather than a missing key someone has to interpret.
    logger.info("cli.started");
    expect(Object.keys(lines[2])).toEqual(
      expect.arrayContaining(["correlationId", "tenantId", "userId"])
    );
    expect(lines[2]).toMatchObject({ correlationId: null, tenantId: null, userId: null });

    // Negative control: two requests do not share an ID, and the context does
    // not leak from one to the next.
    const ids = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      runWithRequestContext({}, () => {
        logger.info("generated");
        ids.add(lines[lines.length - 1].correlationId as string);
        expect(lines[lines.length - 1].tenantId).toBeNull();
      });
    }
    expect(ids.size).toBe(3);

    // An inbound ID is caller-controlled text that lands in every line for the
    // request, so only this shape is accepted.
    expect(sanitizeCorrelationId("7f9a1c22-3b4d-4e5f-8a90-112233445566")).toBe(
      "7f9a1c22-3b4d-4e5f-8a90-112233445566"
    );
    expect(sanitizeCorrelationId("short")).toBeNull();
    expect(sanitizeCorrelationId('injected" ,"level":"error')).toBeNull();
    expect(sanitizeCorrelationId(undefined)).toBeNull();
  });

  // AC2: Given a downstream call to D365, when logged, then it shares the
  // originating correlation ID.
  it("AC2: a downstream call carries and logs the originating correlation ID", async () => {
    const received: (string | undefined)[] = [];
    const stub: Server = createServer((req: IncomingMessage, res) => {
      received.push(req.headers[CORRELATION_ID_HEADER] as string | undefined);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => stub.listen(34818, "127.0.0.1", resolve));

    try {
      const { logger, lines, raw } = recordingLogger("api");
      const ORIGIN_ID = "corr-downstream-2222";
      // The query string carries an access token, the way a D365 token endpoint
      // callback does.
      const url = `http://127.0.0.1:34818/data/Companies?access_token=tok-must-not-be-logged`;

      const response = await runWithRequestContext({ correlationId: ORIGIN_ID }, async () => {
        setRequestTenant("tenant-abc");
        return fetchWithCorrelation(url, { method: "GET" }, { target: "d365", logger });
      });

      expect(response.status).toBe(200);

      // The downstream service genuinely saw the originating ID.
      expect(received).toEqual([ORIGIN_ID]);

      // And so did the log line for that call.
      const completed = lines.find((l) => l.msg === "downstream.request.completed");
      expect(completed, "the downstream call must be logged").toBeDefined();
      expect(completed).toMatchObject({
        correlationId: ORIGIN_ID,
        tenantId: "tenant-abc",
        target: "d365",
        status: 200
      });

      // The logged URL keeps the path and drops the query string — no key-based
      // rule can redact a token once it is flattened into a URL string.
      expect(completed!.url).toBe("http://127.0.0.1:34818/data/Companies");
      expect(raw.join("\n")).not.toContain("tok-must-not-be-logged");

      // Negative control: outside a request context the call still gets an ID
      // rather than logging a null one, but a different one each time.
      const outside = await fetchWithCorrelation(url, {}, { target: "d365", logger });
      expect(outside.status).toBe(200);
      expect(received[1]).toBeTruthy();
      expect(received[1]).not.toBe(ORIGIN_ID);
    } finally {
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });

  // AC3: Given a log line, when inspected, then it contains no secrets or tokens.
  it("AC3: secret-named fields are redacted, at any depth", () => {
    const { logger, raw } = recordingLogger();

    logger.info("connection.updated", {
      name: "PROD",
      clientSecret: "secret-11111",
      nested: { apiKey: "key-22222", deeper: { password: "pw-33333" } },
      list: [{ token: "tok-44444" }],
      headers: { authorization: "Bearer tok-55555", cookie: "session=tok-66666" }
    });
    logger.error("provisioning.failed", { err: new Error("boom"), connectionString: "pg://u:p@h/db" });

    const output = raw.join("\n");
    for (const secret of [
      "secret-11111",
      "key-22222",
      "pw-33333",
      "tok-44444",
      "tok-55555",
      "tok-66666",
      "pg://u:p@h/db"
    ]) {
      expect(output, `the log leaked "${secret}"`).not.toContain(secret);
    }

    // Redaction, not blanket erasure: the non-secret fields survive, and so
    // does the error, which is the whole reason for the line.
    expect(output).toContain("PROD");
    expect(output).toContain("boom");
    expect(output).toContain("[redacted]");
  });
});

describe.skipIf(!hasDb)("US-007 - over HTTP", () => {
  const PORT = 34817;
  let api: RunningApi | undefined;

  beforeAll(async () => {
    api = await startApi(PORT, { DATABASE_URL: adminUrl }, { captureLogs: true });
  });

  afterAll(() => {
    api?.stop();
  });

  // AC1, over the real server rather than the logger in isolation.
  it("AC1: a real request is logged with its correlation ID, and echoes it back", async () => {
    const inbound = "us007-inbound-correlation";
    const res = await fetch(`${api!.baseUrl}/health`, {
      headers: { [CORRELATION_ID_HEADER]: inbound }
    });
    expect(res.status).toBe(200);
    // Echoed back so a caller can quote it in a support ticket.
    expect(res.headers.get(CORRELATION_ID_HEADER)).toBe(inbound);

    const line = await waitForLine(
      api!,
      (l) => l.msg === "http.request.completed" && l.correlationId === inbound
    );
    expect(line).toMatchObject({
      method: "GET",
      path: "/health",
      status: 200,
      correlationIdSource: "inbound",
      tenantId: null,
      userId: null
    });

    // With no inbound header the server mints one, and it differs per request.
    const first = await fetch(`${api!.baseUrl}/health`);
    const second = await fetch(`${api!.baseUrl}/health`);
    const firstId = first.headers.get(CORRELATION_ID_HEADER);
    const secondId = second.headers.get(CORRELATION_ID_HEADER);
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(firstId).not.toBe(secondId);
    await waitForLine(
      api!,
      (l) => l.correlationId === firstId && l.correlationIdSource === "generated"
    );

    // A malformed inbound ID is replaced rather than trusted.
    const forged = await fetch(`${api!.baseUrl}/health`, {
      headers: { [CORRELATION_ID_HEADER]: 'x" ,"level":"error' }
    });
    expect(forged.headers.get(CORRELATION_ID_HEADER)).not.toBe('x" ,"level":"error');
    expect(api!.logs()).not.toContain('"level":"error');
  });

  // AC3, over the real server: the places a secret actually arrives.
  it("AC3: no header, cookie or query-string secret reaches the log", async () => {
    const inbound = "us007-secret-scan-request";
    const AUTH = "authsecret-11111";
    const COOKIE = "cookiesecret-22222";
    const QUERY = "querysecret-33333";
    const API_KEY = "apikeysecret-44444";

    const res = await fetch(`${api!.baseUrl}/health?access_token=${QUERY}`, {
      headers: {
        [CORRELATION_ID_HEADER]: inbound,
        authorization: `Bearer ${AUTH}`,
        cookie: `session=${COOKIE}`,
        "x-api-key": API_KEY
      }
    });
    expect(res.status).toBe(200);

    // Wait for the line first, so this is not passing merely because nothing
    // had been logged yet.
    const line = await waitForLine(
      api!,
      (l) => l.msg === "http.request.completed" && l.correlationId === inbound
    );
    expect(line.path).toBe("/health");

    const output = api!.logs();
    for (const secret of [AUTH, COOKIE, QUERY, API_KEY]) {
      expect(output, `the API log leaked "${secret}"`).not.toContain(secret);
    }
  });
});
