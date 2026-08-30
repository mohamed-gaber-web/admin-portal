import { Inject, Injectable } from "@nestjs/common";
import {
  listRoles,
  setRolePermissions,
  withRequestTenantScope,
  type AuditActor,
  type RoleRecord
} from "@growpath/db";
import {
  normalisePermissions,
  permissionKeySchema,
  type PermissionKey,
  type Role
} from "@growpath/contracts";
import type { Pool } from "pg";
import { DATABASE_POOL } from "../database/database.module";

/**
 * Permission keys held in the database, narrowed to the contract's enum.
 *
 * A key the catalogue contains but the contract does not is dropped rather than
 * returned: the response schema is `strict`, so passing it through would fail
 * validation at the client and blank the whole screen over one unknown row.
 */
const toContractPermissions = (keys: string[]): PermissionKey[] =>
  keys.filter((key): key is PermissionKey => permissionKeySchema.safeParse(key).success);

const toRole = (record: RoleRecord): Role => ({
  id: record.id,
  name: record.name,
  permissions: toContractPermissions(record.permissions),
  userCount: record.userCount,
  builtIn: record.builtIn
});

@Injectable()
export class RoleService {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async list(): Promise<Role[]> {
    const roles = await withRequestTenantScope(this.pool, (client) => listRoles(client));
    return roles.map(toRole);
  }

  /**
   * Replaces one role's permissions.
   *
   * `normalisePermissions` is applied here, on the authority side, and not only
   * in the portal's matrix: granting `.write` without `.read` is not a state
   * the system models, and a rule enforced only in one client is a rule every
   * other client skips.
   */
  async setPermissions(
    id: string,
    permissions: readonly PermissionKey[],
    actor: AuditActor
  ): Promise<Role | null> {
    const normalised = normalisePermissions(permissions);
    const record = await withRequestTenantScope(this.pool, (client) =>
      setRolePermissions(client, id, normalised, actor)
    );
    return record ? toRole(record) : null;
  }
}
