import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { provisionTenant, TenantAlreadyExistsError } from "@growpath/db";
import type { CreateTenantInput, ProvisionedTenant } from "@growpath/contracts";
import type { Pool } from "pg";
import { DATABASE_POOL } from "../database/database.module";

@Injectable()
export class TenantService {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async create(input: CreateTenantInput, actorIp: string | null): Promise<ProvisionedTenant> {
    try {
      // No authentication yet, so the actor is a label rather than a verified
      // identity. The IP, at least, is observed rather than self-declared.
      return await provisionTenant(this.pool, input, {
        label: "platform-admin",
        ip: actorIp
      });
    } catch (err) {
      if (err instanceof TenantAlreadyExistsError) {
        // 409, not a 500: the caller can fix this by choosing another slug.
        throw new ConflictException({ message: err.message, slug: err.slug });
      }
      throw err;
    }
  }
}
