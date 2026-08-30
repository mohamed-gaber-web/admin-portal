import { Inject, Injectable } from "@nestjs/common";
import { withRequestTenantScope } from "@growpath/db";
import { companySchema, type Company } from "@growpath/contracts";
import type { Pool } from "pg";
import { DATABASE_POOL } from "../database/database.module";

interface CompanyRow {
  id: string;
  name: string;
  data_area_id: string;
  environment_id: string;
}

const toCompany = (row: CompanyRow): Company => ({
  id: row.id,
  name: row.name,
  dataAreaId: row.data_area_id,
  environmentId: row.environment_id
});

@Injectable()
export class CompanyService {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  /**
   * Every company the caller's tenant owns.
   *
   * Note the absent WHERE clause. `withRequestTenantScope` drops the session to
   * `app_user` and sets the tenant from the request context — which the access
   * token guard populated from a signed claim — so row level security does the
   * filtering. There is no tenant identifier in this method to get wrong, and
   * no parameter a caller could influence.
   */
  async list(): Promise<Company[]> {
    return withRequestTenantScope(this.pool, async (client) => {
      const res = await client.query<CompanyRow>(
        "SELECT id, name, data_area_id, environment_id FROM company ORDER BY name"
      );
      return res.rows.map(toCompany);
    });
  }

  /**
   * One company by id, or null if this tenant cannot see it.
   *
   * "Cannot see it" and "does not exist" are the same answer here, and that is
   * the point: the row simply is not visible inside the tenant-scoped session,
   * so the caller learns nothing about whether it exists elsewhere.
   *
   * A malformed id is null rather than an error — Postgres would reject the uuid
   * cast with a 500, which would tell a caller their guess was at least
   * well-formed.
   */
  async find(id: string): Promise<Company | null> {
    if (!companySchema.shape.id.safeParse(id).success) {
      return null;
    }

    return withRequestTenantScope(this.pool, async (client) => {
      const res = await client.query<CompanyRow>(
        "SELECT id, name, data_area_id, environment_id FROM company WHERE id = $1",
        [id]
      );
      const row = res.rows[0];
      return row ? toCompany(row) : null;
    });
  }
}
