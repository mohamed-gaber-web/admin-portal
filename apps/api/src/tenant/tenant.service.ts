import { ConflictException, Inject, Injectable } from "@nestjs/common";
import {
  provisionTenantOnClient,
  TenantAlreadyExistsError,
  withoutTenantScope
} from "@growpath/db";
import type { CreateTenantInput, ProvisionedTenant } from "@growpath/contracts";
import type { Pool } from "pg";
import { DATABASE_POOL } from "../database/database.module";

@Injectable()
export class TenantService {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async create(input: CreateTenantInput, actorIp: string | null): Promise<ProvisionedTenant> {
    try {
      // Deliberately unscoped, and deliberately loud about it: the tenant being
      // created is the one there is no context for yet, so this is the one
      // operation that cannot be filtered by tenant. The escape hatch logs the
      // bypass with the request's correlation ID (US-012).
      const result = await withoutTenantScope(
        this.pool,
        {
          reason:
            "Tenant provisioning creates the tenant row itself, so there is no tenant to scope to (US-014)."
        },
        (client) =>
          // No authentication yet, so the actor is a label rather than a
          // verified identity. The IP, at least, is observed rather than
          // self-declared.
          provisionTenantOnClient(client, input, { label: "platform-admin", ip: actorIp })
      );

      return {
        ...result,
        invitation: {
          ...result.invitation,
          // The contract carries a string: a Date would be serialised by
          // JSON.stringify anyway, and saying so in the schema is what lets a
          // consumer rely on it.
          expiresAt: result.invitation.expiresAt.toISOString()
        }
      };
    } catch (err) {
      if (err instanceof TenantAlreadyExistsError) {
        // 409, not a 500: the caller can fix this by choosing another slug.
        throw new ConflictException({ message: err.message, slug: err.slug });
      }
      throw err;
    }
  }
}
