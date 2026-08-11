import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import migrate from "node-pg-migrate";
import { join } from "node:path";
import { repoRoot } from "./helpers";
import { createThrowawayDatabase, type ThrowawayDatabase } from "./pg-helpers";
import {
  createTenant,
  createEnvironment,
  createCompany,
  listCompaniesForEnvironment,
  listActiveTenants,
  findTenant,
  softDeleteTenant,
  restoreTenant
} from "../packages/db/src/tenancy";

const MIGRATIONS_DIR = join(repoRoot, "packages/db/migrations");
const MIGRATIONS_TABLE = "pgmigrations";

const adminUrl = process.env.DATABASE_URL;
const hasDb = Boolean(adminUrl);

if (!hasDb) {
  // Don't silently skip coverage.
  console.warn(
    "[US-010] DATABASE_URL not set — the tenancy model tests are SKIPPED. Set DATABASE_URL to a Postgres admin connection to run them."
  );
}

/** Unique per test so the three cases cannot interfere with each other. */
let counter = 0;
const uniqueSlug = (prefix: string): string => `${prefix}-${(counter += 1)}`;

describe.skipIf(!hasDb)("US-010 - tenant, environment and company data model", () => {
  let db: ThrowawayDatabase | undefined;
  let pool: Pool;

  beforeAll(async () => {
    db = await createThrowawayDatabase(adminUrl!);
    await migrate({
      databaseUrl: db.url,
      dir: MIGRATIONS_DIR,
      direction: "up",
      count: Infinity,
      migrationsTable: MIGRATIONS_TABLE,
      log: () => {}
    });
    pool = new Pool({ connectionString: db.url });
  });

  afterAll(async () => {
    await pool?.end();
    await db?.drop();
    db = undefined;
  });

  // AC1: Given a tenant, when I add an environment, then it may hold many companies.
  it("AC1: an environment holds many companies", async () => {
    const tenant = await createTenant(pool, { name: "Initech", slug: uniqueSlug("initech") });
    const prod = await createEnvironment(pool, {
      tenantId: tenant.id,
      name: "PROD",
      url: "https://initech-prod.crm4.dynamics.com"
    });

    const names = ["Initech France", "Initech Germany", "Initech Spain"];
    for (const [index, name] of names.entries()) {
      await createCompany(pool, {
        tenantId: tenant.id,
        environmentId: prod.id,
        name,
        dataAreaId: `it0${index + 1}`
      });
    }

    const companies = await listCompaniesForEnvironment(pool, prod.id);
    expect(companies).toHaveLength(3);
    expect(companies.map((c) => c.name)).toEqual(names.slice().sort());
    // All three hang off the same environment — the level US-002 was missing.
    expect(new Set(companies.map((c) => c.environmentId))).toEqual(new Set([prod.id]));
  });

  // AC2: Given a company, when created, then it stores its dataAreaId and links
  // to exactly one environment.
  it("AC2: a company stores its dataAreaId and links to exactly one environment", async () => {
    const tenant = await createTenant(pool, { name: "Umbrella", slug: uniqueSlug("umbrella") });
    const prod = await createEnvironment(pool, {
      tenantId: tenant.id,
      name: "PROD",
      url: "https://umbrella-prod.crm4.dynamics.com"
    });
    const uat = await createEnvironment(pool, {
      tenantId: tenant.id,
      name: "UAT",
      url: "https://umbrella-uat.crm4.dynamics.com"
    });

    const company = await createCompany(pool, {
      tenantId: tenant.id,
      environmentId: prod.id,
      name: "Umbrella Retail",
      dataAreaId: "umbr"
    });

    // It stores the dataAreaId...
    expect(company.dataAreaId).toBe("umbr");
    // ...and links to exactly one environment, not to both and not to the tenant.
    expect(company.environmentId).toBe(prod.id);
    expect(await listCompaniesForEnvironment(pool, uat.id)).toHaveLength(0);

    // A company without an environment is rejected outright.
    await expect(
      pool.query("INSERT INTO company (tenant_id, name, data_area_id) VALUES ($1, $2, $3)", [
        tenant.id,
        "Orphan Ltd",
        "orph"
      ])
    ).rejects.toThrow(/environment_id/);

    // The same dataAreaId cannot identify two entities in one environment.
    await expect(
      createCompany(pool, {
        tenantId: tenant.id,
        environmentId: prod.id,
        name: "Umbrella Retail Duplicate",
        dataAreaId: "umbr"
      })
    ).rejects.toThrow(/company_environment_data_area_unique/);

    // And an environment belonging to another tenant is rejected by the
    // composite foreign key, so the hierarchy cannot be crossed.
    const other = await createTenant(pool, { name: "Hooli", slug: uniqueSlug("hooli") });
    await expect(
      createCompany(pool, {
        tenantId: other.id,
        environmentId: prod.id,
        name: "Hooli Retail",
        dataAreaId: "hool"
      })
    ).rejects.toThrow(/company_environment_fk/);
  });

  // AC3: Given a tenant deletion, when requested, then it is soft-deleted and recoverable.
  it("AC3: deleting a tenant soft-deletes it and it is recoverable", async () => {
    const slug = uniqueSlug("cyberdyne");
    const tenant = await createTenant(pool, { name: "Cyberdyne", slug });
    const prod = await createEnvironment(pool, {
      tenantId: tenant.id,
      name: "PROD",
      url: "https://cyberdyne-prod.crm4.dynamics.com"
    });
    await createCompany(pool, {
      tenantId: tenant.id,
      environmentId: prod.id,
      name: "Cyberdyne Systems",
      dataAreaId: "cybr"
    });

    const deleted = await softDeleteTenant(pool, tenant.id);
    expect(deleted?.deletedAt).toBeInstanceOf(Date);

    // Gone from the active view...
    expect((await listActiveTenants(pool)).map((t) => t.slug)).not.toContain(slug);
    expect(await findTenant(pool, tenant.id)).toBeNull();

    // ...but the row is still there, and so are its children — that is what
    // makes this recoverable rather than a re-creation.
    const stillThere = await findTenant(pool, tenant.id, { includeDeleted: true });
    expect(stillThere?.slug).toBe(slug);
    expect(stillThere?.deletedAt).toBeInstanceOf(Date);
    expect(await listCompaniesForEnvironment(pool, prod.id)).toHaveLength(1);

    const restored = await restoreTenant(pool, tenant.id);
    expect(restored?.deletedAt).toBeNull();
    expect((await listActiveTenants(pool)).map((t) => t.slug)).toContain(slug);
    expect(await listCompaniesForEnvironment(pool, prod.id)).toHaveLength(1);
  });
});
