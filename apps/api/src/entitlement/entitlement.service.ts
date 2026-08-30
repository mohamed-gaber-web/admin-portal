import { Inject, Injectable } from "@nestjs/common";
import {
  listOwnModules,
  withRequestTenantScope,
  type ModuleRecord
} from "@growpath/db";
import type { TenantModule } from "@growpath/contracts";
import type { Pool } from "pg";
import { DATABASE_POOL } from "../database/database.module";

/**
 * The caller's own module entitlements (US-072).
 *
 * Tenant-scoped through the request context (US-012), like every other read on
 * this side of the API: the tenant comes from the access token's claims and
 * `tenant_module` carries a row level security policy keyed on it, so the query
 * below needs no `WHERE tenant_id` and could not usefully be given one.
 *
 * Read-only. A tenant granting itself a module it has not paid for is exactly
 * the thing entitlements exist to prevent, so the write lives behind a platform
 * permission on the other controller.
 */
@Injectable()
export class EntitlementService {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async list(): Promise<TenantModule[]> {
    // No tenant parameter anywhere in this call chain, which is the rule rather
    // than an omission: the tenant is set by authentication and read from
    // nowhere else, so there is nothing here a caller could point at somebody
    // else's entitlements.
    const records = await withRequestTenantScope(this.pool, listOwnModules);

    return records.map(toTenantModule);
  }
}

const toTenantModule = (record: ModuleRecord): TenantModule => ({
  key: record.key,
  description: record.description,
  enabled: record.enabledAt !== null,
  enabledAt: record.enabledAt?.toISOString() ?? null
});
