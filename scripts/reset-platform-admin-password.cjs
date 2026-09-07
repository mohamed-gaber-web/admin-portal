/**
 * Resets the password for an account the invitation and reset flows cannot reach.
 *
 * `pnpm platform-admin` refuses an account that is already active — deliberately,
 * because reissuing an invitation for a live account is an account takeover
 * wearing a bootstrap command's name. And `POST /auth/password-reset` only
 * issues a link when `status = 'active'` (password-reset.ts:106), so an account
 * still sitting at `invited` gets the same 202 and no email, forever.
 *
 * Between those two lies the case this exists for: the installation's only
 * platform administrator, unable to sign in and unable to self-recover, with no
 * second platform admin to invite them back. Recovery there needs the database
 * credentials, which is the level of access this account is worth.
 *
 *   node scripts/reset-platform-admin-password.cjs --email ops@example.com
 *   node scripts/reset-platform-admin-password.cjs --email ops@example.com --apply
 *   railway run node scripts/reset-platform-admin-password.cjs --email ops@example.com --apply
 *
 * Reports and changes nothing without `--apply`. With it, and with no password
 * supplied, one is generated and printed once — this is the only place it is
 * ever shown, since only the Argon2id digest is stored.
 *
 * Writes the same fields `completePasswordReset` writes, for the same reasons:
 * the account goes active, every refresh token is revoked (a reset that left the
 * old sessions alive would be theatre), and every outstanding reset link and
 * invitation is burnt so none can be redeemed afterwards. It additionally
 * clears `locked_until`, which the reset path does not — a lockout that
 * outlived the credential it was protecting would leave the operator locked out
 * of the password they were just handed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const repoRoot = path.join(__dirname, '..');

/**
 * `hash-wasm` is a dependency of @growpath/db, and pnpm does not hoist it to the
 * root. Resolved from that package rather than vendored so the Argon2id
 * parameters below are not the only copy — the round-trip check before the
 * write re-verifies the digest through the same library the API uses.
 */
function loadHashWasm() {
  const candidates = [
    path.join(repoRoot, 'packages/db/node_modules'),
    path.join(repoRoot, 'node_modules'),
    repoRoot
  ];
  for (const dir of candidates) {
    try {
      return require(require.resolve('hash-wasm', { paths: [dir] }));
    } catch {
      /* try the next one */
    }
  }
  throw new Error(
    'Cannot resolve hash-wasm. Run `pnpm install` first, or run this from the repo root.'
  );
}

/**
 * Argon2id parameters, copied from PASSWORD_HASH_OPTIONS in
 * packages/db/src/invitations.ts. They are recorded inside the PHC string, so a
 * digest written with the wrong ones still verifies — the copy is a consistency
 * matter, not a correctness one, and the round-trip check below is what
 * actually proves the credential works.
 */
const PASSWORD_HASH_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  saltLength: 16,
  hashLength: 32
};

async function hashPassword(hashWasm, password) {
  return hashWasm.argon2id({
    password,
    salt: crypto.randomBytes(PASSWORD_HASH_OPTIONS.saltLength),
    parallelism: PASSWORD_HASH_OPTIONS.parallelism,
    iterations: PASSWORD_HASH_OPTIONS.timeCost,
    memorySize: PASSWORD_HASH_OPTIONS.memoryCost,
    hashLength: PASSWORD_HASH_OPTIONS.hashLength,
    outputType: 'encoded'
  });
}

/**
 * Ambiguous glyphs left out, because this gets read off a terminal and typed
 * into a browser. Twenty characters from this alphabet is about 119 bits.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_=+.';
const PASSWORD_LENGTH = 20;

function generatePassword() {
  const classes = [/[A-Z]/, /[a-z]/, /[0-9]/, /[-_=+.]/];
  for (;;) {
    let out = '';
    for (let i = 0; i < PASSWORD_LENGTH; i += 1) {
      out += ALPHABET[crypto.randomInt(ALPHABET.length)];
    }
    // Rejection sampling rather than placing one of each and shuffling: it keeps
    // every character uniformly drawn, and the loop practically never repeats.
    if (classes.every((re) => re.test(out))) return out;
  }
}

function parseArguments(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [flag, inline] = arg.slice(2).split('=', 2);
    const next = argv[i + 1];
    const value = inline ?? (next && !next.startsWith('--') ? next : undefined);
    values.set(flag, value ?? true);
  }

  const rawEmail = values.get('email');
  const email = typeof rawEmail === 'string' ? rawEmail.trim() : '';
  if (!email || !email.includes('@')) {
    throw new Error(
      'An email address is required:\n' +
        '  node scripts/reset-platform-admin-password.cjs --email ops@example.com [--apply]'
    );
  }

  // The environment wins over the flag, so the documented way to pass a chosen
  // password is also the way that keeps it out of shell history and out of the
  // process list every other user on the machine can read.
  const flagPassword = values.get('password');
  const password =
    process.env.NEW_PASSWORD ?? (typeof flagPassword === 'string' ? flagPassword : undefined);
  if (password !== undefined && password.length < 12) {
    // Twelve, matching completePasswordResetSchema in @growpath/contracts, which
    // is the stricter of the two floors in the codebase.
    throw new Error('A supplied password must be at least 12 characters.');
  }

  return {
    email,
    password,
    apply: values.get('apply') === true,
    clearMfa: values.get('clear-mfa') === true
  };
}

/** Never prints the credentials — only where this is about to write. */
function describeTarget(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname + ':' + (parsed.port || '5432') + parsed.pathname;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));

  const envPath = path.join(repoRoot, '.env');
  if (!process.env.DATABASE_URL && fs.existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Use `railway run`, or export it first.');
  }

  const hashWasm = loadHashWasm();
  const local = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    // Managed Postgres almost always terminates TLS with a certificate this
    // process has no root for. The connection is still encrypted.
    ssl: local ? undefined : { rejectUnauthorized: false }
  });

  await client.connect();
  console.log('Database: ' + describeTarget(process.env.DATABASE_URL));
  console.log('');

  try {
    const found = await client.query(
      `SELECT u.id, u.email, u.status, u.password_hash IS NOT NULL AS has_password,
              u.locked_until, u.locked_until > now() AS locked, u.failed_login_count,
              u.mfa_enabled_at IS NOT NULL AS mfa_enabled, u.last_login_at,
              t.id AS tenant_id, t.slug, t.name AS tenant_name,
              t.is_platform, t.deleted_at AS tenant_deleted_at
         FROM "user" u
         JOIN tenant t ON t.id = u.tenant_id
        WHERE lower(u.email) = lower($1)`,
      [options.email]
    );

    if (found.rowCount === 0) {
      console.log('No user exists with the address ' + options.email + '.');
      console.log('Create the platform administrator instead:');
      console.log('  pnpm platform-admin -- --email ' + options.email);
      process.exitCode = 1;
      return;
    }
    if (found.rowCount > 1) {
      // Only reachable if 1730000011000_global-email-identity never ran, which is
      // itself the bug: sign-in takes rows[0] of this same lookup, unordered.
      console.log('WARNING: ' + found.rowCount + ' rows share this address. The global');
      console.log('unique index on lower(email) is missing — run the migrations.');
      process.exitCode = 1;
      return;
    }

    const user = found.rows[0];
    const iso = (value) => (value ? value.toISOString() : null);

    console.log('  Email:            ' + user.email);
    console.log(
      '  Workspace:        ' + user.tenant_name + ' (' + user.slug + ')' +
        (user.is_platform ? '  [platform tenant]' : '')
    );
    console.log('  Status:           ' + user.status);
    console.log('  Has password:     ' + user.has_password);
    console.log('  Locked:           ' + (user.locked ? 'yes, until ' + iso(user.locked_until) : 'no'));
    console.log('  Failed attempts:  ' + user.failed_login_count);
    console.log('  MFA enabled:      ' + user.mfa_enabled);
    console.log('  Last sign-in:     ' + (iso(user.last_login_at) ?? 'never'));
    console.log('  Tenant archived:  ' + (iso(user.tenant_deleted_at) ?? 'no'));
    console.log('');

    const events = await client.query(
      `SELECT created_at, event, outcome, reason
         FROM auth_event
        WHERE lower(claimed_email) = lower($1)
        ORDER BY created_at DESC
        LIMIT 10`,
      [options.email]
    );

    if (events.rowCount > 0) {
      console.log('  Recent attempts (the reason is recorded here, never returned to the caller):');
      for (const row of events.rows) {
        console.log(
          '    ' + iso(row.created_at) + '  ' + String(row.event).padEnd(24) +
            ' ' + String(row.outcome).padEnd(10) + ' ' + (row.reason ?? '')
        );
      }
      console.log('');
    }

    if (user.tenant_deleted_at) {
      console.log("This account's workspace is archived, and sign-in refuses that before it");
      console.log('ever checks a password. Restore the tenant first — a new password would');
      console.log('change nothing.');
      process.exitCode = 1;
      return;
    }

    if (!options.apply) {
      console.log('Report only. Nothing was changed. Re-run with --apply to set a new password.');
      if (user.mfa_enabled) {
        console.log('This account has MFA enrolled: a correct password yields a challenge, not');
        console.log('a session. Add --clear-mfa if the authenticator is unavailable.');
      }
      return;
    }

    const password = options.password ?? generatePassword();
    const passwordHash = await hashPassword(hashWasm, password);

    // Proves the digest about to be stored verifies through the same library the
    // API authenticates with, before anything is committed.
    if (!(await hashWasm.argon2Verify({ password, hash: passwordHash }))) {
      throw new Error('The generated hash failed to verify. Nothing was written.');
    }

    await client.query('BEGIN');

    await client.query(
      `UPDATE "user"
          SET password_hash = $2, password_changed_at = now(), status = 'active',
              failed_login_count = 0, locked_until = NULL, updated_at = now()
        WHERE id = $1`,
      [user.id, passwordHash]
    );

    // Every family, exactly as completePasswordReset does: a reset is what
    // someone does when they believe the account is compromised.
    const revoked = await client.query(
      `UPDATE refresh_token SET revoked_at = now(), revoked_reason = 'password reset'
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [user.id]
    );

    const burntResets = await client.query(
      `UPDATE password_reset SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
      [user.id]
    );

    // An unredeemed invitation is a second live credential for this account.
    const burntInvitations = await client.query(
      `UPDATE user_invitation SET accepted_at = now()
        WHERE user_id = $1 AND accepted_at IS NULL AND expires_at > now()`,
      [user.id]
    );

    let clearedMfa = 0;
    if (options.clearMfa) {
      const cleared = await client.query(
        `UPDATE "user" SET mfa_secret = NULL, mfa_enabled_at = NULL, updated_at = now()
          WHERE id = $1 AND mfa_enabled_at IS NOT NULL`,
        [user.id]
      );
      clearedMfa = cleared.rowCount ?? 0;
      await client.query('DELETE FROM mfa_recovery_code WHERE user_id = $1', [user.id]);
    }

    // Neither side of the credential is recorded — only that it changed, which is
    // what the audit log is for.
    await client.query(
      `INSERT INTO audit_log
         (tenant_id, user_id, actor_label, action, entity_type, entity_id, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        user.tenant_id,
        user.id,
        'system:reset-platform-admin-password',
        'password.reset',
        'user',
        user.id,
        JSON.stringify({
          via: 'reset-platform-admin-password.cjs',
          previousStatus: user.status,
          revokedSessions: revoked.rowCount ?? 0,
          clearedMfa: clearedMfa > 0
        })
      ]
    );

    await client.query(
      `INSERT INTO auth_event
         (tenant_id, user_id, claimed_email, event, outcome, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        user.tenant_id,
        user.id,
        user.email,
        'password_reset.completed',
        'succeeded',
        'operator reset via reset-platform-admin-password.cjs'
      ]
    );

    await client.query('COMMIT');

    console.log('Password reset.');
    console.log('');
    console.log('  Email:     ' + user.email);
    if (!options.password) {
      console.log('  Password:  ' + password);
    }
    console.log('');
    console.log('  Sessions revoked:   ' + (revoked.rowCount ?? 0));
    console.log('  Reset links burnt:  ' + (burntResets.rowCount ?? 0));
    console.log('  Invitations burnt:  ' + (burntInvitations.rowCount ?? 0));
    if (user.status !== 'active') {
      console.log('  Status:             ' + user.status + ' -> active');
    }
    if (options.clearMfa) {
      console.log('  MFA cleared:        ' + (clearedMfa > 0 ? 'yes' : 'was not enrolled'));
    } else if (user.mfa_enabled) {
      console.log('');
      console.log('  NOTE: MFA is still enrolled. The password above is correct but yields a');
      console.log('  challenge rather than a session. Re-run with --clear-mfa if the');
      console.log('  authenticator is unavailable.');
    }
    console.log('');
    console.log('Shown once — only the Argon2id digest is stored, so nothing can print it');
    console.log('again. Sign in and change it.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
