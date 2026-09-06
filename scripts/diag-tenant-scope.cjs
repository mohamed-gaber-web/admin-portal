/**
 * Reproduces `withRequestTenantScope` against whatever DATABASE_URL is in scope.
 *
 * Every tenant-scoped route opens the same short transaction — `SET LOCAL ROLE
 * app_user`, then the tenant GUC, then the query — so when all of them answer
 * 500 while unscoped routes answer normally, the failure is one of those three
 * statements. This runs them in order and reports which one breaks.
 *
 *   railway run node scripts/diag-tenant-scope.cjs   # against the deployed DB
 *   node scripts/diag-tenant-scope.cjs               # against .env
 *
 * Read-only: the transaction is always rolled back, and nothing is printed that
 * could identify a credential.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

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

  // Host only — never the credential.
  try {
    const parsed = new URL(url);
    console.log(`target: ${parsed.hostname}:${parsed.port || 5432}/${parsed.pathname.slice(1)} as ${parsed.username}\n`);
  } catch {
    console.log('target: (unparseable DATABASE_URL)\n');
  }

  const client = new Client({
    connectionString: url,
    // Railway terminates TLS with a certificate this client has no root for.
    ssl: /railway|rlwy|proxy\.rlwy/.test(url) ? { rejectUnauthorized: false } : undefined,
  });

  try {
    await client.connect();
  } catch (err) {
    console.log('CONNECT FAILED:', err.message);
    process.exit(1);
  }

  const show = async (label, sql) => {
    try {
      const result = await client.query(sql);
      console.log(label, JSON.stringify(result.rows[0] ?? result.rows));
    } catch (err) {
      console.log(label, 'ERROR:', err.code, err.message);
    }
  };

  await show('identity  ', `SELECT current_user,
      (SELECT count(*)::int FROM pg_roles WHERE rolname='app_user')  AS role_exists,
      pg_has_role(current_user,'app_user','MEMBER')                  AS can_set_role,
      (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)     AS is_superuser`);
  await show('server    ', `SELECT current_database() AS db, split_part(version(),' ',2) AS pg`);
  await show('migrations', `SELECT count(*)::int AS applied, max(name) AS latest FROM pgmigrations`);
  await show('rls setup ', `SELECT
      (SELECT count(*)::int FROM pg_proc WHERE proname='current_tenant_id')                        AS fn,
      (SELECT count(DISTINCT table_name)::int FROM information_schema.role_table_grants
         WHERE grantee='app_user')                                                                 AS granted_tables,
      (SELECT count(*)::int FROM pg_tables WHERE schemaname='public' AND rowsecurity)              AS rls_tables`);

  console.log('\n--- reproducing withRequestTenantScope ---');
  const tenant = await client.query('SELECT id, slug FROM tenant LIMIT 1').catch(() => ({ rows: [] }));
  const tenantId = tenant.rows[0]?.id;
  console.log('  tenant:', tenant.rows[0]?.slug ?? '(none found)');

  const steps = [
    ['BEGIN                   ', 'BEGIN'],
    ['SET LOCAL ROLE app_user ', 'SET LOCAL ROLE app_user'],
    ['set_config app.tenant_id', `SELECT set_config('app.tenant_id', '${tenantId ?? '00000000-0000-0000-0000-000000000000'}', true)`],
    ['SELECT FROM company     ', 'SELECT count(*)::int AS n FROM company'],
    ['SELECT FROM role        ', 'SELECT count(*)::int AS n FROM role'],
    ['SELECT FROM d365_env    ', 'SELECT count(*)::int AS n FROM d365_environment'],
  ];

  for (const [label, sql] of steps) {
    try {
      const result = await client.query(sql);
      console.log(`  ${label} -> OK`, result.rows[0] ? JSON.stringify(result.rows[0]) : '');
    } catch (err) {
      console.log(`  ${label} -> FAILED: ${err.code} ${err.message}`);
      break;
    }
  }

  await client.query('ROLLBACK').catch(() => undefined);
  await client.end();
})();
