/**
 * Adds the missing `d365_environment` and `company` rows for one tenant.
 *
 * Provisioning normally creates these alongside the tenant (`createEnvironment`
 * and `createCompany` in `packages/db/src/tenancy.ts`), but a tenant created by
 * another route arrives without them — and then the ERP proxy answers 404
 * `not_found`, because `resolveProxyTarget` finds no environment to forward to.
 *
 * There is no API endpoint that adds an environment to an existing tenant:
 * `PUT /connections/:id` only configures one that already exists. Hence this.
 *
 * Inserts the same columns, in the same order, as the provisioning functions.
 * Idempotent — it reports and skips when a row is already there — and it never
 * updates or deletes anything.
 *
 *   railway run node scripts/provision-environment.cjs --tenant test
 *   railway run node scripts/provision-environment.cjs --tenant test --apply
 *
 * `--tenant` takes a slug or a uuid.
 */
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');

/** Tenant slug or uuid, from `--tenant`. */
const TENANT = (() => {
  const index = process.argv.indexOf('--tenant');
  return index !== -1 ? process.argv[index + 1] : null;
})();

/** What to create. The URL is the D365 instance this tenant's devices talk to. */
const ENVIRONMENT_NAME = 'GP Customers (Sandbox)';
const ENVIRONMENT_URL = 'https://gp-customers.sandbox.operations.eu.dynamics.com';
const COMPANY_NAME = 'USMF';
/** The D365 `dataAreaId`. Every OData query in the mobile app scopes to this. */
const COMPANY_DATA_AREA_ID = 'usmf';

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('No DATABASE_URL. Run through `railway run`.');
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: /railway|rlwy/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();

  if (!TENANT) {
    console.log('Pass --tenant <slug-or-uuid>.');
    await client.end();
    process.exit(1);
  }

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(TENANT);
  const tenant = await client.query(
    isUuid ? 'SELECT id, slug, name FROM tenant WHERE id = $1'
           : 'SELECT id, slug, name FROM tenant WHERE slug = $1',
    [TENANT]
  );
  if (!tenant.rows[0]) {
    console.log(`Tenant "${TENANT}" not found — nothing done.`);
    await client.end();
    process.exit(1);
  }
  const TENANT_ID = tenant.rows[0].id;
  console.log('tenant:', JSON.stringify(tenant.rows[0]));
  console.log(APPLY ? 'mode:   APPLY\n' : 'mode:   report only (pass --apply to insert)\n');

  const environments = await client.query(
    'SELECT id, name, url, connection_state FROM d365_environment WHERE tenant_id = $1',
    [TENANT_ID]
  );

  if (environments.rows.length) {
    console.log('environment exists, skipping:', JSON.stringify(environments.rows));
  } else if (!APPLY) {
    console.log(`would insert environment: ${ENVIRONMENT_NAME} -> ${ENVIRONMENT_URL}`);
  } else {
    const created = await client.query(
      `INSERT INTO d365_environment (tenant_id, name, url) VALUES ($1, $2, $3)
       RETURNING id, name, url, connection_state`,
      [TENANT_ID, ENVIRONMENT_NAME, ENVIRONMENT_URL]
    );
    console.log('created environment:', JSON.stringify(created.rows[0]));
  }

  const companies = await client.query(
    'SELECT id, name, data_area_id FROM company WHERE tenant_id = $1',
    [TENANT_ID]
  );

  if (companies.rows.length) {
    console.log('company exists, skipping:', JSON.stringify(companies.rows));
  } else if (!APPLY) {
    console.log(`would insert company: ${COMPANY_NAME} (${COMPANY_DATA_AREA_ID})`);
  } else {
    const environmentId = (
      await client.query('SELECT id FROM d365_environment WHERE tenant_id = $1 LIMIT 1', [TENANT_ID])
    ).rows[0].id;

    const created = await client.query(
      `INSERT INTO company (tenant_id, environment_id, name, data_area_id) VALUES ($1, $2, $3, $4)
       RETURNING id, name, data_area_id`,
      [TENANT_ID, environmentId, COMPANY_NAME, COMPANY_DATA_AREA_ID]
    );
    console.log('created company:', JSON.stringify(created.rows[0]));
  }

  console.log('\nfinal state for this tenant');
  console.log('  environments:', JSON.stringify((await client.query(
    'SELECT name, url, connection_state FROM d365_environment WHERE tenant_id = $1', [TENANT_ID])).rows));
  console.log('  companies:   ', JSON.stringify((await client.query(
    'SELECT name, data_area_id FROM company WHERE tenant_id = $1', [TENANT_ID])).rows));

  console.log(
    '\nThe environment stays `not_configured` — and the proxy keeps answering 404 —\n' +
    'until a client id, secret and Entra tenant id are saved against it and the\n' +
    'connection test passes. Do that on the portal\'s Connections screen.'
  );

  await client.end();
})();
