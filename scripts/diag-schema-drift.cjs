/**
 * Reports migrations the code carries that the database has not applied.
 *
 * Deployed code and deployed schema travel separately: the image is built from
 * a commit, the schema is whatever `migrate:up` last managed to do to a
 * long-lived database. When they disagree the API answers 500 with Postgres
 * `42703` (undefined_column) on exactly the routes whose query touches the
 * missing column, while every other route keeps working — which reads like a
 * broken screen rather than a broken deploy, and is why this script exists.
 *
 *   railway run node scripts/diag-schema-drift.cjs   # against the deployed DB
 *   node scripts/diag-schema-drift.cjs               # against .env
 *
 * Read-only. It runs no DDL and prints nothing that could identify a
 * credential — only the host it reached.
 *
 * Exit code is 1 when the database is behind, so CI or a deploy step can gate
 * on it.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'packages', 'db', 'migrations');

function connectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL.trim();

  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return null;
  const match = fs.readFileSync(envPath, 'utf8').match(/^\s*DATABASE_URL\s*=\s*"?([^"\n\r]+)/m);
  return match ? match[1].trim() : null;
}

/**
 * Migration names as `pgmigrations` records them: the filename without `.js`.
 * Sorted by filename, which is the order node-pg-migrate applies them in.
 */
function migrationsOnDisk() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => name.replace(/\.js$/, ''));
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

  // Railway's public proxy presents a certificate signed by its own CA, which
  // node's default verification rejects. The alternative is not connecting.
  const client = new Client({
    connectionString: url,
    ssl: /railway|rlwy\.net/.test(url) ? { rejectUnauthorized: false } : undefined
  });
  await client.connect();

  try {
    const disk = migrationsOnDisk();
    if (disk.length === 0) {
      console.log(`No migrations found at ${MIGRATIONS_DIR}.`);
      process.exitCode = 1;
      return;
    }

    const ledger = await client.query('SELECT name FROM pgmigrations ORDER BY id');
    const applied = new Set(ledger.rows.map((row) => row.name));

    const pending = disk.filter((name) => !applied.has(name));

    /*
     * Recorded on disk order, not ledger order: a migration the database has
     * applied but this checkout does not carry means the deployed image is
     * older than the schema, which is the opposite drift and equally worth
     * saying out loud — rolling it back is not something this script guesses at.
     */
    const onlyInDatabase = [...applied].filter((name) => !disk.includes(name));

    console.log(`migrations in this checkout : ${disk.length}`);
    console.log(`applied to this database    : ${applied.size}`);
    console.log(`last applied                : ${ledger.rows.at(-1)?.name ?? '(none)'}\n`);

    if (onlyInDatabase.length > 0) {
      console.log('Applied to the database but absent from this checkout:');
      for (const name of onlyInDatabase) console.log(`  ${name}`);
      console.log('  -> this checkout is older than the schema.\n');
    }

    if (pending.length === 0) {
      console.log('Up to date: every migration in this checkout is applied.');
      if (onlyInDatabase.length > 0) process.exitCode = 1;
      return;
    }

    console.log(`BEHIND by ${pending.length} migration(s):`);
    for (const name of pending) console.log(`  ${name}`);

    console.log('\nFix:');
    console.log('  DATABASE_URL="<this url>" pnpm --filter @growpath/db migrate:up');
    console.log('or, with the Railway CLI:');
    console.log('  railway run pnpm --filter @growpath/db migrate:up');

    /*
     * The one case `migrate:up` cannot repair, and the reason this script looks
     * at columns at all rather than trusting the ledger: a migration recorded
     * as applied whose change is not actually present. `migrate:up` skips it as
     * done and the 500 survives the fix. Only a sample is checked — enough to
     * catch the state, not to audit the schema.
     */
    const sample = [
      ['tenant', 'seat_limit'],
      ['tenant', 'contract_start_date'],
      ['tenant', 'contract_end_date'],
      ['plan', 'user_limit']
    ];
    const absent = [];
    for (const [table, column] of sample) {
      const { rowCount } = await client.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = $1 AND column_name = $2`,
        [table, column]
      );
      if (rowCount === 0) absent.push(`${table}.${column}`);
    }
    if (absent.length > 0) {
      console.log(`\nabsent columns: ${absent.join(', ')}`);
      console.log('(expected while the migrations above are pending)');
    }

    process.exitCode = 1;
  } finally {
    await client.end();
  }
})().catch((error) => {
  console.error(`failed: ${error.message}${error.code ? ` (${error.code})` : ''}`);
  process.exit(1);
});
