/**
 * Diagnoses — and optionally repairs — the `app_user` role the tenant-scoped
 * transaction depends on.
 *
 * Every tenant-scoped route runs `withRequestTenantScope`, which does
 * `SET LOCAL ROLE app_user` and then queries under row level security. If the
 * role is missing, unusable, or missing its grants, *all* of those routes
 * answer 500 while unscoped ones (sign-in, `/mobile/config`, `/platform/*`)
 * keep working — which is the exact signature this exists to fix.
 *
 * Why re-running the migrations does not cure it: `pgmigrations` records them as
 * applied, so `migrate:up` is a no-op. The usual cause is a database restored
 * from a dump — the tables and rows come back, but `GRANT` statements naming a
 * role that did not exist at restore time fail and are skipped.
 *
 *   node scripts/repair-app-role.cjs                    # report only
 *   node scripts/repair-app-role.cjs --apply            # fix what is broken
 *   railway run node scripts/repair-app-role.cjs --apply
 *
 * Idempotent: `CREATE ROLE` is guarded, and `GRANT` is already idempotent.
 * Nothing here drops anything or touches a row of data.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');

/** The grants, exactly as the migrations issue them. Table -> privileges. */
const GRANTS = [
  ['tenant', 'SELECT, INSERT, UPDATE, DELETE'],
  ['d365_environment', 'SELECT, INSERT, UPDATE, DELETE'],
  ['company', 'SELECT, INSERT, UPDATE, DELETE'],
  ['user', 'SELECT, INSERT, UPDATE, DELETE'],
  ['role', 'SELECT, INSERT, UPDATE, DELETE'],
  ['user_role', 'SELECT, INSERT, UPDATE, DELETE'],
  // Append-only: 1730000003000 REVOKEs UPDATE and DELETE, and triggers enforce it.
  ['audit_log', 'SELECT, INSERT'],
  ['permission', 'SELECT'],
  ['role_permission', 'SELECT, INSERT, UPDATE, DELETE'],
  ['user_invitation', 'SELECT, INSERT, UPDATE, DELETE'],
  ['refresh_token', 'SELECT, INSERT, UPDATE, DELETE'],
  ['auth_event', 'SELECT, INSERT'],
  ['password_reset', 'SELECT, INSERT, UPDATE, DELETE'],
  ['mfa_recovery_code', 'SELECT, INSERT, UPDATE, DELETE'],
  ['mfa_code_use', 'SELECT, INSERT, UPDATE, DELETE'],
  ['tenant_mobile_config', 'SELECT, INSERT, UPDATE, DELETE'],
  ['module', 'SELECT'],
  ['tenant_module', 'SELECT, INSERT, UPDATE, DELETE'],
  ['plan', 'SELECT'],
];

const CURRENT_TENANT_ID_FN = `
  CREATE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
  $$;
`;

function connectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL.trim();
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return null;
  const match = fs.readFileSync(envPath, 'utf8').match(/^\s*DATABASE_URL\s*=\s*"?([^"\n\r]+)/m);
  return match ? match[1].trim() : null;
}

(async () => {
  const url = connectionString();
  if (!url) {
    console.log('No DATABASE_URL in the environment or .env.');
    process.exit(1);
  }

  try {
    const parsed = new URL(url);
    console.log(`target: ${parsed.hostname}:${parsed.port || 5432}/${parsed.pathname.slice(1)} as ${parsed.username}`);
  } catch {
    console.log('target: (unparseable DATABASE_URL)');
  }
  console.log(APPLY ? 'mode:   APPLY — repairs will be made\n' : 'mode:   report only (pass --apply to fix)\n');

  const client = new Client({
    connectionString: url,
    ssl: /railway|rlwy/.test(url) ? { rejectUnauthorized: false } : undefined,
  });

  try {
    await client.connect();
  } catch (err) {
    console.log('CONNECT FAILED:', err.message);
    process.exit(1);
  }

  const repairs = [];
  const blockers = [];

  const state = (await client.query(`
    SELECT current_user,
           (SELECT count(*)::int FROM pg_roles WHERE rolname='app_user')            AS role_exists,
           pg_has_role(current_user,'app_user','MEMBER')                            AS can_set_role,
           (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)               AS is_superuser,
           (SELECT count(*)::int FROM pg_proc WHERE proname='current_tenant_id')    AS fn_exists,
           (SELECT count(*)::int FROM pgmigrations)                                 AS migrations
  `)).rows[0];

  console.log('current state');
  console.log(`  connecting user     ${state.current_user}${state.is_superuser ? ' (superuser)' : ''}`);
  console.log(`  app_user exists     ${state.role_exists ? 'yes' : 'NO'}`);
  console.log(`  can SET ROLE to it  ${state.can_set_role ? 'yes' : 'NO'}`);
  console.log(`  current_tenant_id() ${state.fn_exists ? 'present' : 'MISSING'}`);
  console.log(`  migrations applied  ${state.migrations}`);

  // ── 1. The role itself ────────────────────────────────────────────────────
  if (!state.role_exists) {
    repairs.push([
      'create role app_user',
      `DO $$ BEGIN CREATE ROLE app_user NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    ]);
  }

  // ── 2. Membership, so SET ROLE is permitted ───────────────────────────────
  // A superuser may always SET ROLE. A CREATEROLE user on PostgreSQL 15 and
  // earlier does not get membership in a role it creates, which is exactly how
  // a database ends up with the role present and unusable.
  if (!state.can_set_role && !state.is_superuser) {
    repairs.push([
      `grant app_user to ${state.current_user}`,
      `GRANT app_user TO "${state.current_user}"`,
    ]);
  }

  // ── 3. The tenant GUC reader every RLS policy calls ───────────────────────
  if (!state.fn_exists) {
    repairs.push(['create current_tenant_id()', CURRENT_TENANT_ID_FN]);
  }

  // ── 4. Schema usage and per-table grants ──────────────────────────────────
  const hasUsage = state.role_exists && (await client.query(
    `SELECT has_schema_privilege('app_user','public','USAGE') AS ok`
  )).rows[0].ok;
  if (!hasUsage) {
    repairs.push(['grant usage on schema public', 'GRANT USAGE ON SCHEMA public TO app_user']);
  }

  const present = new Set(
    (await client.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'`)).rows.map(r => r.tablename)
  );
  const held = new Map();
  for (const row of (await client.query(`
    SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
    FROM information_schema.role_table_grants
    WHERE grantee='app_user' AND table_schema='public'
    GROUP BY table_name
  `)).rows) {
    held.set(row.table_name, row.privs);
  }

  console.log('\ngrants');
  let missingGrants = 0;
  for (const [table, privileges] of GRANTS) {
    if (!present.has(table)) {
      blockers.push(`table "${table}" does not exist — the schema itself is incomplete`);
      console.log(`  ${table.padEnd(22)} TABLE MISSING`);
      continue;
    }
    const wanted = privileges.split(',').map(p => p.trim()).sort();
    const actual = (held.get(table) ?? '').split(',').filter(Boolean);
    const absent = wanted.filter(p => !actual.includes(p));
    if (absent.length) {
      missingGrants++;
      console.log(`  ${table.padEnd(22)} missing ${absent.join(', ')}`);
      repairs.push([`grant on ${table}`, `GRANT ${privileges} ON "${table}" TO app_user`]);
    }
  }
  if (!missingGrants) console.log('  all present');

  // ── 5. Row level security, reported but never silently changed ────────────
  const unprotected = (await client.query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname='public' AND NOT rowsecurity
      AND tablename = ANY($1) AND tablename <> 'pgmigrations'
  `, [GRANTS.map(([t]) => t).filter(t => !['permission', 'module', 'plan'].includes(t))])).rows;

  if (unprotected.length) {
    console.log(`\nrow level security DISABLED on: ${unprotected.map(r => r.tablename).join(', ')}`);
    console.log('  Not repaired here on purpose — this is tenant isolation, and replaying');
    console.log('  policies blind could differ from what the migrations define. If this list');
    console.log('  is non-empty the database needs rebuilding from migrations, not patching.');
  }

  // ── 6. Apply, or explain ──────────────────────────────────────────────────
  if (blockers.length) {
    console.log('\nBLOCKED:');
    for (const b of blockers) console.log(`  - ${b}`);
    console.log('  Repairing grants cannot help while tables are missing. Run the migrations');
    console.log('  against this database first: railway run pnpm db:migrate');
    await client.end();
    process.exit(1);
  }

  const real = repairs;

  if (!repairs.length) {
    console.log('\nNothing to repair — this database can run tenant-scoped transactions.');
    await verify(client);
    await client.end();
    return;
  }

  console.log(`\n${APPLY ? 'applying' : 'would apply'} ${real.length} change(s):`);
  for (const [label, sql] of real) {
    if (!APPLY) {
      console.log(`  - ${label}`);
      continue;
    }
    try {
      await client.query(sql);
      console.log(`  ok   ${label}`);
    } catch (err) {
      console.log(`  FAIL ${label}: ${err.code} ${err.message}`);
    }
  }

  if (APPLY) await verify(client);
  else console.log('\nRe-run with --apply to make these changes.');

  await client.end();
})();

/** Runs the exact sequence `withRequestTenantScope` runs, then rolls back. */
async function verify(client) {
  console.log('\nverifying withRequestTenantScope');
  const tenant = await client.query('SELECT id, slug FROM tenant LIMIT 1').catch(() => ({ rows: [] }));
  const tenantId = tenant.rows[0]?.id ?? '00000000-0000-0000-0000-000000000000';

  const steps = [
    ['BEGIN', 'BEGIN'],
    ['SET LOCAL ROLE app_user', 'SET LOCAL ROLE app_user'],
    ["set_config('app.tenant_id')", `SELECT set_config('app.tenant_id', '${tenantId}', true)`],
    ['SELECT FROM company', 'SELECT count(*)::int AS n FROM company'],
    ['SELECT FROM role', 'SELECT count(*)::int AS n FROM role'],
    ['SELECT FROM d365_environment', 'SELECT count(*)::int AS n FROM d365_environment'],
  ];

  let ok = true;
  for (const [label, sql] of steps) {
    try {
      await client.query(sql);
      console.log(`  ok   ${label}`);
    } catch (err) {
      console.log(`  FAIL ${label}: ${err.code} ${err.message}`);
      ok = false;
      break;
    }
  }
  await client.query('ROLLBACK').catch(() => undefined);
  console.log(ok ? '\nPASS — the API should stop returning 500 on tenant-scoped routes.'
                 : '\nSTILL FAILING — paste the FAIL line above.');
}
