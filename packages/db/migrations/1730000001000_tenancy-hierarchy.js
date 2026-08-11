/* eslint-disable */
/**
 * Tenancy hierarchy: tenant -> d365_environment -> company.
 *
 * US-002 hung `company` directly off `tenant`, which collapses two levels that
 * are not the same thing: one tenant holds several D365 environments (PROD,
 * UAT), each holding several legal entities. This migration inserts the missing
 * level and adds soft deletion to `tenant`.
 */

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // --- Soft delete on tenant -------------------------------------------
  // Children are deliberately left untouched: restoring a tenant has to be a
  // genuine recovery, not a re-creation.
  pgm.addColumn("tenant", {
    deleted_at: { type: "timestamptz" }
  });
  pgm.createIndex("tenant", "deleted_at", {
    name: "tenant_active_index",
    where: "deleted_at IS NULL"
  });

  // --- company belongs to exactly one environment ----------------------
  // company carries tenant_id (US-002 requires it on every scoped table) *and*
  // environment_id. A composite foreign key makes it impossible for those two
  // to disagree, rather than trusting application code to keep them in step.
  pgm.addConstraint("d365_environment", "d365_environment_id_tenant_unique", {
    unique: ["id", "tenant_id"]
  });

  pgm.addColumn("company", {
    environment_id: { type: "uuid" },
    data_area_id: { type: "text" }
  });

  // Backfill: attach each existing company to its tenant's earliest environment.
  pgm.sql(`
    UPDATE company c
    SET environment_id = e.id
    FROM (
      SELECT DISTINCT ON (tenant_id) tenant_id, id
      FROM d365_environment
      ORDER BY tenant_id, created_at, id
    ) e
    WHERE c.environment_id IS NULL AND e.tenant_id = c.tenant_id
  `);

  // Backfill data_area_id from the company name, de-duplicated within an
  // environment so the unique constraint below can be applied.
  pgm.sql(`
    UPDATE company c
    SET data_area_id = sub.value
    FROM (
      SELECT id,
             CASE WHEN cnt = 1 THEN base ELSE left(base, 3) || rn::text END AS value
      FROM (
        SELECT id,
               base,
               row_number() OVER (PARTITION BY environment_id, base ORDER BY created_at, id) AS rn,
               count(*) OVER (PARTITION BY environment_id, base) AS cnt
        FROM (
          SELECT id,
                 environment_id,
                 created_at,
                 coalesce(
                   nullif(left(regexp_replace(lower(name), '[^a-z0-9]', '', 'g'), 4), ''),
                   'ent'
                 ) AS base
          FROM company
          WHERE data_area_id IS NULL
        ) b
      ) r
    ) sub
    WHERE c.id = sub.id
  `);

  // Fail loudly rather than inventing an environment for orphaned companies.
  pgm.sql(`
    DO $$
    DECLARE orphans int;
    BEGIN
      SELECT count(*) INTO orphans FROM company WHERE environment_id IS NULL;
      IF orphans > 0 THEN
        RAISE EXCEPTION
          'Cannot add company.environment_id: % company row(s) belong to a tenant with no d365_environment. Create an environment for those tenants, then re-run this migration.',
          orphans;
      END IF;
    END $$;
  `);

  pgm.alterColumn("company", "environment_id", { notNull: true });
  pgm.alterColumn("company", "data_area_id", { notNull: true });

  pgm.addConstraint("company", "company_environment_fk", {
    foreignKeys: {
      columns: ["environment_id", "tenant_id"],
      references: "d365_environment (id, tenant_id)",
      onDelete: "CASCADE"
    }
  });

  // A dataAreaId identifies one legal entity within one environment.
  pgm.addConstraint("company", "company_environment_data_area_unique", {
    unique: ["environment_id", "data_area_id"]
  });

  pgm.createIndex("company", "environment_id");
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 *
 * Structurally reversible, but not data-reversible: rolling back drops
 * environment_id and data_area_id, and those values are gone.
 */
exports.down = (pgm) => {
  pgm.dropIndex("company", "environment_id");
  pgm.dropConstraint("company", "company_environment_data_area_unique");
  pgm.dropConstraint("company", "company_environment_fk");
  pgm.dropColumn("company", "data_area_id");
  pgm.dropColumn("company", "environment_id");

  pgm.dropConstraint("d365_environment", "d365_environment_id_tenant_unique");

  pgm.dropIndex("tenant", "deleted_at", { name: "tenant_active_index" });
  pgm.dropColumn("tenant", "deleted_at");
};
