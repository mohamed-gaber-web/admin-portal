import { Global, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import Redis from "ioredis";

/**
 * One Redis connection for the whole application.
 *
 * Extracted before the auth sprint rather than after: refresh-token storage,
 * lockout counters and rate limiting each want a client, and four independently
 * constructed clients would mean four connection pools, four sets of retry
 * behaviour, and a readiness probe testing a socket nothing else uses. Probing
 * the connection the application actually depends on is the only version of
 * that check worth having.
 */

/** How long to wait for a connection before treating Redis as unreachable. */
export const REDIS_CONNECT_TIMEOUT_MS = 2000;

@Injectable()
export class RedisConnection implements OnApplicationShutdown {
  /** Null when REDIS_URL is unset — legitimate outside production. */
  readonly client: Redis | null;

  private lastErrorMessage: string | null = null;

  constructor() {
    const url = process.env.REDIS_URL?.trim();
    this.client = url ? this.connect(url) : null;
  }

  private connect(url: string): Redis {
    const client = new Redis(url, {
      // Do not open a socket at boot merely to hold it idle; the first command
      // connects. Auth will make that first command arrive quickly enough.
      lazyConnect: true,
      connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
      // Fail the command rather than retrying into the caller's timeout budget.
      maxRetriesPerRequest: 1
    });

    // Two jobs. First, an EventEmitter 'error' with no listener throws, so an
    // unreachable Redis would take down the process. Second, this is the only
    // place the real cause is visible: a failed command rejects with ioredis's
    // "Reached the max retries per request limit", which cannot tell a refused
    // connection apart from a bad password or a TLS mismatch.
    client.on("error", (err: Error) => {
      this.lastErrorMessage = err.message;
    });

    // The default retry strategy is deliberately kept, so the application
    // recovers on its own once Redis returns.
    return client;
  }

  /** Most recent connection-level error, for logging beside a failed command. */
  get lastError(): string | null {
    return this.lastErrorMessage;
  }

  /** Called after a success, so a stale cause cannot misdirect a later failure. */
  clearLastError(): void {
    this.lastErrorMessage = null;
  }

  async onApplicationShutdown(): Promise<void> {
    // quit() rather than disconnect(), so an in-flight command finishes first.
    await this.client?.quit().catch(() => undefined);
  }
}

@Global()
@Module({
  providers: [RedisConnection],
  exports: [RedisConnection]
})
export class RedisModule {}
