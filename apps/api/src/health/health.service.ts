import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import type { DependencyState, Readiness } from "@growpath/contracts";
import { DATABASE_POOL } from "../database/database.module";
import { RedisConnection } from "../redis/redis.module";
import { apiLogger } from "../observability/logger";

/**
 * Readiness checks (US-016).
 *
 * Liveness and readiness are different questions and this file only answers the
 * second one. See `health.controller.ts` for why they must not be merged.
 */

/**
 * Ceiling on a single dependency check.
 *
 * A probe that can hang is worse than a probe that fails: the orchestrator's own
 * timeout fires instead, so the instance is reported unhealthy several seconds
 * later than it could have been, and every probe in flight holds a connection
 * the whole time. Two seconds is comfortably above a healthy round trip and
 * comfortably below a typical 5s probe timeout.
 */
const PROBE_TIMEOUT_MS = 2000;

/** Rejects if `operation` has not settled within `ms`. */
function withTimeout<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} probe timed out after ${ms}ms`)), ms);
  });
  // clearTimeout regardless of outcome, or a slow-but-successful check leaves
  // the event loop holding a timer for the rest of the timeout.
  return Promise.race([operation, expiry]).finally(() => clearTimeout(timer));
}

@Injectable()
export class HealthService {
  /**
   * Last reported state per dependency, so failures are logged on transition
   * rather than on every probe.
   *
   * A readiness probe runs every few seconds forever. Logging each failure
   * would write thousands of identical error lines a day for one outage, which
   * buries the line that actually matters — the first one. Transitions give an
   * operator "went down at T, came back at T+n" and nothing in between.
   */
  private readonly lastState = new Map<string, DependencyState>();

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly redis: RedisConnection
  ) {}

  /** True only in production, where an unset REDIS_URL is a misconfiguration. */
  private get redisRequired(): boolean {
    return process.env.NODE_ENV === "production";
  }

  /**
   * Records a probe outcome, logging only when it differs from last time.
   *
   * Returns the state so call sites read as `return this.report(...)`.
   */
  private report(
    dependency: string,
    state: DependencyState,
    message: string,
    fields: Record<string, unknown> = {}
  ): DependencyState {
    const previous = this.lastState.get(dependency);
    this.lastState.set(dependency, state);

    if (previous === state) {
      // Steady state. Still emitted, so a debug-level run shows every probe.
      apiLogger.debug(message, { ...fields, dependency, state, unchanged: true });
      return state;
    }

    const level = state === "down" ? "error" : previous === undefined ? "debug" : "info";
    apiLogger[level](message, { ...fields, dependency, state, previousState: previous ?? null });
    return state;
  }

  private async probeDatabase(): Promise<DependencyState> {
    try {
      await withTimeout(this.pool.query("SELECT 1"), PROBE_TIMEOUT_MS, "database");
      return this.report("database", "up", "health.database.reachable");
    } catch (err) {
      // The detail goes here and only here. AC2 keeps it out of the response;
      // dropping it entirely would leave an operator with a 503 and no cause,
      // so it is logged with the request's correlation ID (US-007).
      return this.report("database", "down", "health.database.unreachable", {
        error: describe(err)
      });
    }
  }

  private async probeRedis(): Promise<DependencyState> {
    const client = this.redis.client;

    if (!client) {
      if (this.redisRequired) {
        return this.report("redis", "down", "health.redis.unconfigured", {
          error: "REDIS_URL is not set, and it is required in production"
        });
      }
      // Outside production this is the documented local setup: US-006 left
      // Redis out of the local stack, so a developer has none to point at.
      return this.report("redis", "not_configured", "health.redis.not_configured");
    }

    try {
      const reply = await withTimeout(client.ping(), PROBE_TIMEOUT_MS, "redis");
      if (reply !== "PONG") {
        // Something answered on the port without speaking Redis.
        return this.report("redis", "down", "health.redis.unexpected_reply", {
          error: `PING returned ${reply}`
        });
      }
      this.redis.clearLastError();
      return this.report("redis", "up", "health.redis.reachable");
    } catch (err) {
      return this.report("redis", "down", "health.redis.unreachable", {
        error: describe(err),
        cause: this.redis.lastError
      });
    }
  }

  /**
   * Verifies every dependency and reports whether this instance should receive
   * traffic.
   *
   * Checks run concurrently: they are independent, and running them in series
   * would make the worst case the sum of the timeouts rather than the largest.
   * Neither branch can reject — each probe converts its own failure into a
   * state — so one dead dependency still yields a full answer about the others.
   */
  async readiness(): Promise<Readiness> {
    const [database, redis] = await Promise.all([this.probeDatabase(), this.probeRedis()]);

    const checks = { database, redis };
    const ready = Object.values(checks).every((state) => state !== "down");

    return { status: ready ? "ready" : "not_ready", checks };
  }
}

/**
 * Error text for the log. Never for the response — `describe` exists precisely
 * so the leaky value has one obvious destination and grep finds every use.
 */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
