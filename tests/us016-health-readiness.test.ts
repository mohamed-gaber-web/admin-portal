import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import migrate from "node-pg-migrate";
import { join } from "node:path";
import { repoRoot } from "./helpers";
import { createThrowawayDatabase, type ThrowawayDatabase } from "./pg-helpers";
import { startApi, type RunningApi } from "./api-server";
import { readinessSchema } from "../packages/contracts/src/schemas/health";
import { API_ROUTES } from "../packages/contracts/src/routes";

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  // Don't silently skip coverage.
  console.warn(
    "[US-016] DATABASE_URL not set — the readiness tests are SKIPPED. Set DATABASE_URL to a Postgres admin connection to run them."
  );
}

/** Ports nothing listens on, for the unreachable-dependency cases. */
const CLOSED_REDIS_URL = "redis://127.0.0.1:1";
const CLOSED_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:1/postgres";

interface StubRedis {
  url: string;
  /** Commands the stub actually received, uppercased. */
  received: () => string[];
  stop: () => Promise<void>;
}

/**
 * A socket that speaks just enough RESP to answer PING.
 *
 * The point is that the probe must complete a genuine request/response round
 * trip over TCP. A mocked ioredis would pass even if the probe never opened a
 * connection, which is the failure this test exists to catch.
 */
async function startStubRedis(): Promise<StubRedis> {
  const sockets = new Set<Socket>();
  const received: string[] = [];

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      // ioredis sends inline or array-encoded commands; both contain the verb.
      const text = chunk.toString("utf8").toUpperCase();
      received.push(text);
      if (text.includes("PING")) {
        socket.write("+PONG\r\n");
      } else if (text.includes("QUIT")) {
        socket.write("+OK\r\n");
      } else {
        // INFO, COMMAND, and friends: enough to keep the client happy.
        socket.write("+OK\r\n");
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("stub Redis did not bind to a TCP port");
  }

  return {
    url: `redis://127.0.0.1:${address.port}`,
    received: () => [...received],
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      })
  };
}

describe.skipIf(!hasDb)("US-016 - health and readiness endpoints", () => {
  let db: ThrowawayDatabase | undefined;

  beforeAll(async () => {
    db = await createThrowawayDatabase(adminUrl!);
    await migrate({
      databaseUrl: db.url,
      dir: join(repoRoot, "packages/db/migrations"),
      direction: "up",
      count: Infinity,
      migrationsTable: "pgmigrations",
      log: () => {}
    });
  });

  afterAll(async () => {
    await db?.drop();
    db = undefined;
  });

  // AC1: Given the service is running, when the readiness endpoint is called,
  // then database and Redis connectivity are verified.
  it("AC1: readiness verifies database and Redis connectivity", async () => {
    const redis = await startStubRedis();
    let api: RunningApi | undefined;

    try {
      api = await startApi(34816, { DATABASE_URL: db!.url, REDIS_URL: redis.url });

      const res = await fetch(`${api.baseUrl}${API_ROUTES.ready}`);
      expect(res.status).toBe(200);

      const body = readinessSchema.parse(await res.json());
      expect(body.status).toBe("ready");
      expect(body.checks.database).toBe("up");
      expect(body.checks.redis).toBe("up");

      // Redis was genuinely reached, not assumed: the stub saw the PING. Without
      // this, a probe hard-coded to return "up" would satisfy every assertion
      // above, and "connectivity is verified" would be untested.
      expect(
        redis.received().some((command) => command.includes("PING")),
        "the readiness probe never sent PING — connectivity was assumed, not verified"
      ).toBe(true);

      // The database has no equivalent witness here, but it does not need one:
      // AC2 starts the same endpoint against an unreachable database and gets
      // "down", so the check cannot be a constant either.

      // Liveness is a different endpoint and answers a different question: it
      // must not be checking dependencies at all.
      const live = await fetch(`${api.baseUrl}${API_ROUTES.health}`);
      expect(live.status).toBe(200);
      expect(await live.json()).toEqual({ status: "ok", service: "api" });
    } finally {
      api?.stop();
      await redis.stop();
    }
  });

  // AC2: Given a failing dependency, when probed, then the endpoint reports
  // unhealthy without leaking internals.
  it("AC2: a failing dependency reports unhealthy without leaking internals", async () => {
    // "A failing dependency" is a category, so each way one can fail is
    // exercised: unreachable Redis, unreachable database, and — the one a
    // deployment is most likely to hit — Redis simply never configured in
    // production. Each names the dependency that must be down and the one that
    // must still be reported accurately beside it, which is what proves the
    // checks are independent rather than a single shared try/catch.
    const scenarios = [
      {
        name: "Redis unreachable",
        port: 34817,
        env: { DATABASE_URL: db!.url, REDIS_URL: CLOSED_REDIS_URL },
        down: "redis" as const,
        healthy: "database" as const,
        logMessage: "health.redis.unreachable",
        // ioredis's own rejection says only "Reached the max retries per
        // request limit", which cannot tell a refused connection apart from a
        // bad password or a TLS mismatch — so the root cause is captured too.
        logCause: /ECONNREFUSED/i
      },
      {
        name: "database unreachable",
        port: 34818,
        env: { DATABASE_URL: CLOSED_DATABASE_URL, REDIS_URL: "" },
        down: "database" as const,
        healthy: null,
        logMessage: "health.database.unreachable",
        logCause: /ECONNREFUSED/i
      },
      {
        name: "REDIS_URL unset in production",
        port: 34819,
        env: { DATABASE_URL: db!.url, REDIS_URL: "", NODE_ENV: "production" },
        down: "redis" as const,
        healthy: "database" as const,
        logMessage: "health.redis.unconfigured",
        // A dependency nobody configured is a dependency nobody is checking.
        logCause: /REDIS_URL/
      }
    ];

    for (const scenario of scenarios) {
      let api: RunningApi | undefined;
      try {
        api = await startApi(scenario.port, scenario.env, { captureLogs: true });

        const res = await fetch(`${api.baseUrl}${API_ROUTES.ready}`);

        // 503, because orchestrators route on the status code.
        expect(res.status, `${scenario.name}: expected 503`).toBe(503);

        const raw = await res.text();
        // strict() — an added field fails here rather than shipping unnoticed.
        const body = readinessSchema.parse(JSON.parse(raw));
        expect(body.status).toBe("not_ready");
        expect(body.checks[scenario.down], `${scenario.name}: ${scenario.down}`).toBe("down");
        if (scenario.healthy) {
          expect(body.checks[scenario.healthy], `${scenario.name}: healthy dep`).toBe("up");
        }

        // --- No internals in the response ------------------------------------
        for (const leak of [
          "127.0.0.1", // host
          "ECONNREFUSED", // driver error code
          "connect", // driver error text
          "ioredis", // library name
          "at ", // stack frame
          "Error", // exception class
          "postgres", // credentials/DSN fragments
          "password",
          "REDIS_URL", // configuration variable names
          db!.url
        ]) {
          expect(
            raw.toLowerCase(),
            `${scenario.name}: the readiness body leaked "${leak}"`
          ).not.toContain(leak.toLowerCase());
        }

        // Liveness must still pass: the process is alive, only a dependency is
        // not. Failing liveness here is what restarts a whole fleet over an
        // outage a restart cannot fix.
        const live = await fetch(`${api.baseUrl}${API_ROUTES.health}`);
        expect(live.status, `${scenario.name}: liveness must not follow readiness`).toBe(200);

        // --- ...but the cause is not lost, either ----------------------------
        // Redacting the error out of existence would leave an operator holding
        // a 503 and nothing to act on. It belongs in the log.
        const logs = api.logs();
        expect(logs, `${scenario.name}: the failure must be logged server-side`).toContain(
          scenario.logMessage
        );
        expect(logs, `${scenario.name}: the log must carry the cause`).toMatch(scenario.logCause);
      } finally {
        api?.stop();
      }
    }
  });
});
