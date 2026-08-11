import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { createPool } from "@growpath/db";
import type { Pool } from "pg";

/** Injection token for the shared pg connection pool. */
export const DATABASE_POOL = "DATABASE_POOL";

/**
 * Provides one connection pool for the whole application.
 *
 * Global so feature modules do not each have to import it, and closed on
 * shutdown so tests and dev restarts do not leave connections behind — which
 * would keep a throwaway test database undroppable.
 */
@Global()
@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      useFactory: (): Pool => createPool()
    }
  ],
  exports: [DATABASE_POOL]
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
