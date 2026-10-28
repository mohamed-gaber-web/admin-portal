import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import migrate from "node-pg-migrate";
import { join } from "node:path";
import { repoRoot } from "./helpers";
import { createThrowawayDatabase, type ThrowawayDatabase } from "./pg-helpers";
import { startApi, type RunningApi } from "./api-server";
import { seedTenant, type TenantFixture } from "./tenant-fixtures";

/**
 * A user's default D365 warehouse: assigned by the tenant admin when inviting
 * or editing, read back by the mobile app through `GET /me`.
 */

const MIGRATIONS_DIR = join(repoRoot, "packages/db/migrations");
const PORT = 34878;

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

describe.skipIf(!hasDb)("user default warehouse", () => {
  let db: ThrowawayDatabase | undefined;
  let pool: Pool;
  let api: RunningApi | undefined;
  let tenant: TenantFixture;

  beforeAll(async () => {
    db = await createThrowawayDatabase(adminUrl!);
    await migrate({
      databaseUrl: db.url,
      dir: MIGRATIONS_DIR,
      direction: "up",
      count: Infinity,
      migrationsTable: "pgmigrations",
      log: () => {}
    });
    pool = new Pool({ connectionString: db.url });
    api = await startApi(PORT, {
      DATABASE_URL: db.url,
      AUTH_JWT_SECRET: "user-warehouse-suite-signing-key-32-chars"
    });
    tenant = await seedTenant(pool, api.baseUrl, "acme-wh", { companies: ["Acme Retail"] });
  }, 120_000);

  afterAll(async () => {
    api?.stop();
    await pool?.end();
    await db?.drop();
  });

  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${api!.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tenant.accessToken}`,
        ...(body ? { "content-type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

  it("assigns a warehouse at invitation, with the legal entity taken from the company", async () => {
    const company = tenant.companies[0];
    const res = await send("POST", "/users/invitations", {
      email: "picker@acme-wh.local",
      role: "viewer",
      // A dataAreaId sent by the caller would be refused by the strict schema;
      // the server derives it.
      defaultWarehouse: { companyId: company.id, warehouseId: "11", name: "Main warehouse" }
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const { user } = (await res.json()) as { user: { id: string } };

    const detail = (await (await send("GET", `/users/${user.id}`)).json()) as {
      defaultWarehouse: unknown;
    };
    expect(detail.defaultWarehouse).toEqual({
      companyId: company.id,
      companyName: company.name,
      dataAreaId: company.dataAreaId,
      warehouseId: "11",
      name: "Main warehouse"
    });
  });

  it("refuses an invitation naming an unknown company, and creates nobody", async () => {
    const res = await send("POST", "/users/invitations", {
      email: "ghost@acme-wh.local",
      role: "viewer",
      defaultWarehouse: {
        companyId: "00000000-0000-4000-8000-000000000000",
        warehouseId: "11",
        name: "Main"
      }
    });
    expect(res.status).toBe(404);
    const rows = await pool.query(`SELECT 1 FROM "user" WHERE email = $1`, ["ghost@acme-wh.local"]);
    expect(rows.rowCount).toBe(0);
  });

  it("refuses a caller-supplied dataAreaId rather than trusting it", async () => {
    const res = await send("PUT", `/users/${tenant.userId}/warehouse`, {
      defaultWarehouse: {
        companyId: tenant.companies[0].id,
        warehouseId: "11",
        name: "Main",
        dataAreaId: "evil"
      }
    });
    expect(res.status).toBe(400);
  });

  it("shows the signed-in user their own warehouse, and clears it", async () => {
    const set = await send("PUT", `/users/${tenant.userId}/warehouse`, {
      defaultWarehouse: { companyId: tenant.companies[0].id, warehouseId: "22", name: "North" }
    });
    expect(set.status).toBe(200);

    const me = (await (await send("GET", "/me")).json()) as {
      defaultWarehouse: { warehouseId: string } | null;
    };
    expect(me.defaultWarehouse?.warehouseId).toBe("22");

    const cleared = await send("PUT", `/users/${tenant.userId}/warehouse`, { defaultWarehouse: null });
    expect(cleared.status).toBe(200);
    const after = (await (await send("GET", "/me")).json()) as { defaultWarehouse: unknown };
    expect(after.defaultWarehouse).toBeNull();
  });

  it("records each change in the audit log", async () => {
    const res = await pool.query<{ after_values: { warehouseId: string | null } }>(
      `SELECT after_values FROM audit_log
        WHERE entity_id = $1 AND action = 'user.warehouse_changed'
        ORDER BY created_at`,
      [tenant.userId]
    );
    expect(res.rows.map((row) => row.after_values.warehouseId)).toEqual(["22", null]);
  });
});
