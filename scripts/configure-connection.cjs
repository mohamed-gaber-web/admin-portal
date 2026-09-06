/**
 * Moves the D365 credential out of the mobile app's `environment.ts` and into
 * the portal, where it belongs.
 *
 * This is the one migration step the ERP-proxy cutover needs. The old app read
 * `clientId` / `clientSecret` from its bundle and called Entra itself; the API
 * now does that, using a secret sealed in the database. Until the row carries
 * one, `resolveProxyTarget` skips the environment and every `/d365/*` call
 * answers 404.
 *
 * Goes through `PUT /connections/:id` rather than writing to the database,
 * deliberately: that handler **tests the credential against Entra before it
 * saves**, so a wrong secret is rejected instead of being stored and discovered
 * later by a warehouse operator.
 *
 * The secret is read from the file and sent over TLS. It is never printed, never
 * logged, and never written anywhere else.
 *
 *   node scripts/configure-connection.cjs --env <environmentId> --token <bearer>
 */
const fs = require('fs');
const path = require('path');

const API = 'https://admin-portal-production-db9b.up.railway.app';

/** Entra directory GUID — the middle segment of the app's old `auth.tokenUrl`. */
const ENTRA_TENANT_ID = '26c58d65-b577-4f92-aed2-cec1395d146d';

/** Where the mobile app's environment file lives. */
const ENVIRONMENT_FILE = 'C:/Projects/Sales Order App/sales-order-app/src/environments/environment.ts';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : null;
}

/** Pulls `auth.clientId` and `auth.clientSecret` out of the environment file. */
function readCredentials() {
  if (!fs.existsSync(ENVIRONMENT_FILE)) return null;
  const source = fs.readFileSync(ENVIRONMENT_FILE, 'utf8');
  const clientId = source.match(/clientId:\s*'([^']+)'/)?.[1];
  const clientSecret = source.match(/clientSecret:\s*'([^']+)'/)?.[1];
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

(async () => {
  const environmentId = arg('env');
  const token = arg('token');
  if (!environmentId || !token) {
    console.log('Usage: --env <environmentId> --token <bearer>');
    process.exit(1);
  }

  const credentials = readCredentials();
  if (!credentials) {
    console.log('Could not find auth.clientId / auth.clientSecret in:');
    console.log('  ' + ENVIRONMENT_FILE);
    process.exit(1);
  }

  // Confirm what was found without disclosing it.
  console.log('read from environment.ts:');
  console.log('  clientId :', credentials.clientId);
  console.log('  secret   : found, ' + credentials.clientSecret.length + ' characters (not shown)');
  console.log('  entraTid :', ENTRA_TENANT_ID);
  console.log('\nPUT /connections/' + environmentId + '  (tests against Entra, then saves)\n');

  const response = await fetch(`${API}/connections/${environmentId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      entraTenantId: ENTRA_TENANT_ID,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    }),
  });

  const body = await response.text();
  console.log('HTTP', response.status);

  try {
    const parsed = JSON.parse(body);
    // A saved connection comes back whole; a rejection carries a reason code.
    if (response.ok) {
      console.log('  state    :', parsed.state);
      console.log('  clientId :', parsed.clientId);
      console.log('  hasSecret:', parsed.hasClientSecret);
      console.log('  tokenUrl :', parsed.tokenUrl);
      console.log('  scope    :', parsed.scope);
      console.log('  checkedAt:', parsed.checkedAt);
    } else {
      console.log(' ', JSON.stringify(parsed));
    }
  } catch {
    console.log(' ', body.slice(0, 300));
  }
})();
