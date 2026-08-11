/* eslint-disable */
/**
 * Row level security on tenant tables.
 *
 * Application-level filtering is not enough: analytics queries written later
 * will bypass the ORM, and one missing WHERE clause leaks another tenant's
 * data. These policies put the boundary in the database itself.
 *
 * IMPORTANT: superusers always bypass RLS, and table owners bypass it unless
 * FORCE ROW LEVEL SECURITY is set. None of this protects anything if the
 * application connects as a superuser — it must connect as `app_user`.
 *
 * The table list is duplicated here rather than imported from src/rls.ts: a
 * migration is a frozen snapshot of history and must not change when the
 * application's idea of the schema moves on.
 */

const TENANT_SCOPED_TABLES = [
  "d365_environment",
  "company",
  "user",
  "role",
  "user_role",
  "audit_log"
];

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // Roles are cluster-wide and the test suite migrates several throwaway
  // databases concurrently, so creating this must tolerate losing the race.
  pgm.sql(`
    DO $$ BEGIN
      CREATE ROLE app_user NOLOGIN;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  pgm.sql(`GRANT USAGE ON SCHEMA public TO app_user`);

  // Explicit per-table grants, not ALL TABLES: that would hand the application
  // role write access to the migration bookkeeping table.
  pgm.sql(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      tenant, d365_environment, company, "user", role, user_role, audit_log
    TO app_user
  `);
  // The permission catalogue is global and read-only to the application.
  pgm.sql(`GRANT SELECT ON permission TO app_user`);

  // Tenant context lives in a session GUC. With nothing set this returns NULL,
  // every policy below evaluates false, and zero rows come back — the safe
  // state is the default state, with no special case to forget.
  pgm.sql(`
    CREATE FUNCTION current_tenant_id() RETURNS uuid
    LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
    $$;
  `);

  // The root table keys on its own id; everything else on tenant_id.
  pgm.sql(`ALTER TABLE tenant ENABLE ROW LEVEL SECURITY`);
  pgm.sql(`ALTER TABLE tenant FORCE ROW LEVEL SECURITY`);
  pgm.sql(`
    CREATE POLICY tenant_isolation ON tenant
      USING (id = current_tenant_id())
      WITH CHECK (id = current_tenant_id())
  `);

  for (const table of TENANT_SCOPED_TABLES) {
    pgm.sql(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
    pgm.sql(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    // WITH CHECK fences writes as well as reads: a session scoped to tenant A
    // cannot insert or update a row belonging to tenant B.
    pgm.sql(`
      CREATE POLICY tenant_isolation ON "${table}"
        USING (tenant_id = current_tenant_id())
        WITH CHECK (tenant_id = current_tenant_id())
    `);
  }
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  for (const table of ["tenant", ...TENANT_SCOPED_TABLES]) {
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON "${table}"`);
    pgm.sql(`ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY`);
    pgm.sql(`ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`);
  }

  pgm.sql(`DROP FUNCTION IF EXISTS current_tenant_id()`);

  pgm.sql(`REVOKE ALL ON permission FROM app_user`);
  pgm.sql(`
    REVOKE ALL ON
      tenant, d365_environment, company, "user", role, user_role, audit_log
    FROM app_user
  `);
  pgm.sql(`REVOKE USAGE ON SCHEMA public FROM app_user`);

  // app_user is deliberately NOT dropped. Roles are cluster-wide, and other
  // databases (parallel test runs, other environments on the same server) may
  // still depend on it. Grants above are per-database and safe to revoke.
};
