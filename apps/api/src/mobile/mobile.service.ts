import { Inject, Injectable } from "@nestjs/common";
import {
  findMobileBootstrap,
  findMobileConfig,
  saveMobileConfig,
  withoutTenantScope,
  withRequestTenantScope,
  type AuditActor,
  type MobileConfigRecord
} from "@growpath/db";
import type { MobileConfig, SaveMobileConfigInput } from "@growpath/contracts";
import type { Pool } from "pg";
import { DATABASE_POOL } from "../database/database.module";

/**
 * Mobile runtime configuration (US-040).
 *
 * The response this builds is what replaces the Ionic app's `environment.ts`.
 * It carries no credential: the D365 client secret lives on `d365_environment`,
 * is sealed, and is read only by the token client — none of the queries reached
 * from here so much as name that table.
 */

const toConfig = (record: MobileConfigRecord): MobileConfig => ({
  tenantSlug: record.tenantSlug,
  tenantName: record.tenantName,
  apiBaseUrl: record.apiBaseUrl,
  userAuth: record.userAuth,
  minimumAppVersion: record.minimumAppVersion,
  updatedAt: record.updatedAt.toISOString()
});

@Injectable()
export class MobileService {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  /**
   * The bootstrap read, for a device that has no session yet.
   *
   * Unscoped, and deliberately loud about it. A freshly installed app holds a
   * slug and nothing else, so there is no token for a tenant to come from —
   * exactly the position `POST /tenants` is in, and it uses the same escape
   * hatch, which logs the bypass with the request's correlation ID (US-012).
   *
   * The bypass is safe here for a reason worth stating: `findMobileBootstrap`
   * selects a fixed column list from one table whose every column is
   * device-public by design. An unscoped query is dangerous when it can reach
   * data the scoping was protecting, and this one cannot.
   */
  async bootstrap(slug: string): Promise<MobileConfig | null> {
    const record = await withoutTenantScope(
      this.pool,
      {
        reason:
          "Mobile bootstrap resolves a tenant from the slug a device was installed with; there is no session yet for a tenant to come from (US-040)."
      },
      (client) => findMobileBootstrap(client, slug)
    );
    return record ? toConfig(record) : null;
  }

  /** The caller's own tenant's configuration, for the administration screen. */
  async find(): Promise<MobileConfig | null> {
    const record = await withRequestTenantScope(this.pool, (client) => findMobileConfig(client));
    return record ? toConfig(record) : null;
  }

  /** Creates or replaces the caller's own tenant's configuration. */
  async save(input: SaveMobileConfigInput, actor: AuditActor): Promise<MobileConfig | null> {
    const record = await withRequestTenantScope(this.pool, (client) =>
      saveMobileConfig(
        client,
        {
          apiBaseUrl: input.apiBaseUrl,
          userAuth: input.userAuth,
          minimumAppVersion: input.minimumAppVersion ?? null
        },
        actor
      )
    );
    return record ? toConfig(record) : null;
  }
}
