-- Recreates the `app_user` role and every grant the migrations issue.
--
-- Run this when `SET LOCAL ROLE app_user` fails with `role "app_user" does not
-- exist`, which makes every tenant-scoped route answer 500 while sign-in and
-- the unauthenticated routes keep working.
--
-- Why migrations do not fix it: roles are cluster-wide and `pg_dump` does not
-- export them, so a database restored from a dump arrives with its tables, its
-- data and a full `pgmigrations` table — but no role, and every
-- `GRANT ... TO app_user` in the dump failed on the way in. `migrate:up` then
-- does nothing, because every migration is already recorded as applied.
--
-- Idempotent and safe to re-run. Creates no table, drops nothing, touches no row.
-- Mirrors 1730000002000_row-level-security.js and the grants added after it.

BEGIN;

-- 1. The role. Guarded, because roles are cluster-wide and may already exist.
DO $$ BEGIN
  CREATE ROLE app_user NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. The tenant GUC every row level security policy reads. `OR REPLACE` so a
--    database that already has it is left alone.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
  $$;

-- 3. Schema access.
GRANT USAGE ON SCHEMA public TO app_user;

-- 4. Per-table grants, explicitly and never `ALL TABLES` — that would hand the
--    application role write access to the migration bookkeeping table.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenant, d365_environment, company, "user", role, user_role, audit_log
TO app_user;

GRANT SELECT ON permission TO app_user;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  role_permission, user_invitation, refresh_token
TO app_user;

GRANT SELECT, INSERT ON auth_event TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON password_reset TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_recovery_code, mfa_code_use TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_mobile_config TO app_user;
GRANT SELECT ON module TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_module TO app_user;
GRANT SELECT ON plan TO app_user;

-- 5. The audit log is append-only. Granted above with the rest of the core
--    tables, then narrowed here exactly as 1730000003000 does — triggers enforce
--    it too, but the grant is the first line of it.
REVOKE UPDATE, DELETE ON audit_log FROM app_user;

COMMIT;

-- 6. Proof. Runs precisely what `withRequestTenantScope` runs, then rolls back.
--    If this returns a row instead of an error, the API will stop answering 500
--    on tenant-scoped routes.
BEGIN;
  -- The tenant is read BEFORE the role switch, on purpose: afterwards this
  -- session is `app_user` under forced row level security with no tenant set
  -- yet, so the subquery would be refused by the very isolation being tested.
  SELECT set_config('app.tenant_id', (SELECT id::text FROM tenant LIMIT 1), true);
  SET LOCAL ROLE app_user;
  SELECT count(*) AS companies_visible FROM company;
ROLLBACK;
