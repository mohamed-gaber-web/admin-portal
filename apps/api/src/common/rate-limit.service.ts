import { Injectable } from "@nestjs/common";
import { RedisConnection } from "../redis/redis.module";

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the window resets. Sent as `Retry-After`. */
  retryAfterSeconds: number;
  /** Requests already counted in the current window, including this one. */
  count: number;
}

/**
 * Fixed-window request counting, per key (US-026).
 *
 * A fixed window rather than a sliding one, deliberately. It is two commands
 * and no bookkeeping, and its known weakness — up to twice the limit across a
 * window boundary — is not worth a sorted set here: doubling ten attempts a
 * minute for one second still leaves credential stuffing impractical, which is
 * the whole objective.
 *
 * Redis when it is configured, an in-process map when it is not. The fallback
 * is real but weaker, and the difference matters: it counts per instance, so
 * behind N replicas the effective limit is N times the configured one. That is
 * acceptable for local development, where there is one instance, and is why
 * readiness reports Redis separately rather than treating it as optional
 * decoration in production.
 */
@Injectable()
export class RateLimitService {
  /** Fallback counters. Keyed the same way as Redis, expiring on read. */
  private readonly local = new Map<string, { count: number; expiresAt: number }>();

  constructor(private readonly redis: RedisConnection) {}

  async consume(
    key: string,
    limit: number,
    windowMs: number
  ): Promise<RateLimitDecision> {
    const client = this.redis.client;
    if (!client) return this.consumeLocally(key, limit, windowMs);

    try {
      // INCR then set the expiry only on the first hit, so the window runs from
      // the first request rather than sliding forward on every one — otherwise
      // a steady stream of requests keeps resetting the clock and the limit
      // never resets.
      const count = await client.incr(key);
      if (count === 1) await client.pexpire(key, windowMs);

      const ttl = await client.pttl(key);
      return {
        allowed: count <= limit,
        // A missing TTL (-1) means the expiry was lost; fall back to the full
        // window rather than reporting a nonsensical negative retry.
        retryAfterSeconds: Math.max(1, Math.ceil((ttl > 0 ? ttl : windowMs) / 1000)),
        count
      };
    } catch {
      // Redis is unreachable. Throttling locally is a weaker guarantee than
      // throttling globally, and both are better than not throttling — a
      // rate limiter that fails open under load fails exactly when it is needed.
      return this.consumeLocally(key, limit, windowMs);
    }
  }

  private consumeLocally(
    key: string,
    limit: number,
    windowMs: number
  ): RateLimitDecision {
    const now = Date.now();
    const existing = this.local.get(key);

    if (!existing || existing.expiresAt <= now) {
      this.local.set(key, { count: 1, expiresAt: now + windowMs });
      this.sweep(now);
      return { allowed: true, retryAfterSeconds: Math.ceil(windowMs / 1000), count: 1 };
    }

    existing.count += 1;
    return {
      allowed: existing.count <= limit,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.expiresAt - now) / 1000)),
      count: existing.count
    };
  }

  /**
   * Drops expired counters.
   *
   * Without this the map is an unbounded cache keyed by client IP, which is a
   * memory leak an attacker controls the size of. Swept on write rather than on
   * a timer so it costs nothing when the API is idle.
   */
  private sweep(now: number): void {
    if (this.local.size < 1000) return;
    for (const [key, entry] of this.local) {
      if (entry.expiresAt <= now) this.local.delete(key);
    }
  }
}
