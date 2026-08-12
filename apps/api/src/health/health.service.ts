import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import Redis from "ioredis";
import type { Pool } from "pg";
import type { DependencyState, Readiness } from "@growpath/contracts";
import { DATABASE_POOL } from "../database/database.module";
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
export class HealthService implements OnApplicationShutdown {
  /** Null when REDIS_URL is unset. See `probeRedis` for what that then means. */
  private readonly redis: Redis | null;

  /**
   * The most recent connection-level Redis error.
   *
   * Kept because the two are not the same error. A failed `ping()` rejects with
   * ioredis's own "Reached the max retries per request limit", which is true and
   * useless — it does not say whether the cause was a refused connection, a DNS
   * failure, a bad password or a TLS mismatch. That detail only ever arrives on
   * the client's 'error' event, so it is captured here and logged alongside.
   */
  private lastRedisError: string | null = null;

  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {
    const url = process.env.REDIS_URL?.trim();
    this.redis = url ? this.createRedisClient(url) : null;
  }

  private createRedisClient(url: string): Redis {
    const client = new Redis(url, {
      // Nothing else uses Redis yet, so do not open a socket at boot just to
      // hold it idle; the first probe connects.
      lazyConnect: true,
      connectTimeout: PROBE_TIMEOUT_MS,
      // Fail the command instead of retrying into our own timeout budget.
      maxRetriesPerRequest: 1
    });

    // Two jobs. First, an EventEmitter 'error' with no listener throws, so an
    // unreachable Redis would take down the very process the probe exists to
    // report on. Second, this is the only place the real cause is visible —
    // keep it for the log rather than discarding it.
    client.on("error", (err: Error) => {
      this.lastRedisError = describe(err);
    });

    // The default retry strategy is deliberately kept: it reconnects with
    // backoff, so once Redis comes back the probe recovers on its own instead
    // of reporting down until someone restarts the instance.
    return client;
  }

  /** True only in production, where an unset REDIS_URL is a misconfiguration. */
  private get redisRequired(): boolean {
    return process.env.NODE_ENV === "production";
  }

  private async probeDatabase(): Promise<DependencyState> {
    try {
      await withTimeout(this.pool.query("SELECT 1"), PROBE_TIMEOUT_MS, "database");
      return "up";
    } catch (err) {
      // The detail goes here and only here. AC2 keeps it out of the response;
      // dropping it entirely would leave an operator with a 503 and no cause,
      // so it is logged with the request's correlation ID (US-007).
      apiLogger.error("health.database.unreachable", { error: describe(err) });
      return "down";
    }
  }

  private async probeRedis(): Promise<DependencyState> {
    if (!this.redis) {
      if (this.redisRequired) {
        apiLogger.error("health.redis.unconfigured", {
          error: "REDIS_URL is not set, and it is required in production"
        });
        return "down";
      }
      // Outside production this is the documented local setup: US-006 left
      // Redis out of the local stack, so a developer has none to point at.
      return "not_configured";
    }

    try {
      const reply = await withTimeout(this.redis.ping(), PROBE_TIMEOUT_MS, "redis");
      if (reply !== "PONG") {
        // Something answered on the port without speaking Redis.
        apiLogger.error("health.redis.unexpected_reply", { error: `PING returned ${reply}` });
        return "down";
      }
      // Recovered — a stale cause on the next failure would send an operator
      // after the wrong problem.
      this.lastRedisError = null;
      return "up";
    } catch (err) {
      apiLogger.error("health.redis.unreachable", {
        error: describe(err),
        cause: this.lastRedisError
      });
      return "down";
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

  async onApplicationShutdown(): Promise<void> {
    // quit() rather than disconnect(), so an in-flight probe finishes first.
    await this.redis?.quit().catch(() => undefined);
  }
}

/**
 * Error text for the log. Never for the response — `describe` exists precisely
 * so the leaky value has one obvious destination and grep finds every use.
 */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
