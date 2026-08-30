import { loadRepoEnv } from "./env";
import { acceptInvitation, MIN_PASSWORD_LENGTH } from "./invitations";
import { createPool } from "./pool";
import {
  ensurePlatformAdmin,
  PlatformTenantMissingError,
  PLATFORM_TENANT_SLUG
} from "./platform";

/**
 * Mints a platform administrator and prints its invitation link once.
 *
 * This is the installation's bootstrap. `POST /tenants` requires a platform
 * administrator, so a deployment with no such account is a deployment where no
 * tenant can ever be created — and nothing else can create the first one,
 * deliberately: an endpoint that could would be an endpoint anyone on the
 * network could use to grant themselves the tier.
 *
 * It is a CLI rather than an endpoint or a migration for the same reason. A
 * migration would have to embed a password, which means a credential published
 * in the repository, identical on every installation and impossible to rotate
 * out of git history. A CLI requires a shell on the machine holding the database
 * credentials, which is the level of access this account is worth.
 *
 *   pnpm platform-admin -- --email ops@example.com [--name "Ops Team"]
 *
 * The token is printed to stdout and stored only as a SHA-256 digest, so a lost
 * link is reissued by re-running this, never recovered. Re-running against an
 * account that already has a password changes nothing and says so — reissuing
 * there would be an account takeover wearing a bootstrap command's name.
 *
 * `PLATFORM_ADMIN_PASSWORD` (or `--password`) redeems the invitation in the same
 * transaction and prints no link, for unattended provisioning and for recovery
 * where nobody can reach the portal. The invitation flow stays the default
 * because it is the better one: the person who will own the account chooses
 * their own password, and nothing anybody else typed is ever the credential.
 */

interface Options {
  email: string;
  name?: string;
  portalUrl: string;
  /**
   * Sets the password immediately instead of printing an invitation link.
   *
   * The invitation flow is the better one and stays the default: the person who
   * will own the account chooses their own password, and nothing anybody else
   * typed is ever the credential. This exists for the cases where that is not
   * available — an unattended provision, or a recovery where nobody can reach
   * the portal to redeem a link.
   *
   * Read from `PLATFORM_ADMIN_PASSWORD` in preference to the flag, because a
   * password on a command line lands in shell history and in the process list
   * of every other user on the machine.
   */
  password?: string;
}

/** Where the invitation is redeemed. Overridable, because deployments differ. */
const DEFAULT_PORTAL_URL = "http://localhost:4200";

function parseArguments(argv: string[]): Options {
  const values = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [flag, inline] = arg.slice(2).split("=", 2);
    // Supports both `--email x` and `--email=x`; a flag with no value is left
    // out rather than set to the next flag.
    const next = argv[i + 1];
    const value = inline ?? (next && !next.startsWith("--") ? next : undefined);
    if (value !== undefined) values.set(flag, value);
  }

  const email = values.get("email")?.trim();
  if (!email || !email.includes("@")) {
    throw new Error(
      'An email address is required: pnpm platform-admin -- --email ops@example.com [--name "Ops Team"]'
    );
  }

  // The environment wins over the flag, so the documented way to pass this is
  // also the way that keeps it out of shell history.
  const password = process.env.PLATFORM_ADMIN_PASSWORD ?? values.get("password");
  if (password !== undefined && password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`A password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  return {
    email,
    name: values.get("name")?.trim() || undefined,
    password,
    portalUrl: (values.get("portal-url") ?? process.env.PORTAL_URL ?? DEFAULT_PORTAL_URL).replace(
      /\/+$/,
      ""
    )
  };
}

async function main(): Promise<void> {
  loadRepoEnv();
  const options = parseArguments(process.argv.slice(2));
  const pool = createPool();

  try {
    /**
     * Runs on the admin pool with no tenant scoping, and that is not the escape
     * hatch being abused: this is a command-line tool, not a request. There is
     * no request context to scope to, and the tenant it writes into is the one
     * tenant that exists outside the customer model.
     */
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await ensurePlatformAdmin(client, {
        email: options.email,
        name: options.name
      });

      /**
       * A password was supplied, so redeem the invitation here and now.
       *
       * Through `acceptInvitation` rather than by writing a hash directly: that
       * is the real redemption path, so the password gets the same Argon2id
       * parameters and the same length floor, the invitation is properly burnt,
       * and the `invitation.accepted` audit entry is written. Reimplementing it
       * would be a second way to create a credential, free to drift from the
       * one every other account goes through.
       *
       * Inside the same transaction, so the account is either usable or absent
       * — never a user row holding an invitation nobody was given.
       */
      if (options.password && result.invitation) {
        await acceptInvitation(client, {
          token: result.invitation.token,
          password: options.password
        });
      }

      await client.query("COMMIT");

      if (!result.invitation) {
        console.log(`${options.email} is already an active platform administrator.`);
        console.log("Nothing was changed. Use the password reset flow if the password is lost.");
        return;
      }

      if (options.password) {
        console.log(
          result.created
            ? `Created platform administrator ${options.email}.`
            : `Set the password for platform administrator ${options.email}.`
        );
        console.log("");
        console.log(`  Sign-in tenant:  ${PLATFORM_TENANT_SLUG}`);
        console.log(`  Email:           ${options.email}`);
        console.log("");
        // Not echoed. It is already in the operator's hands, and printing it
        // would put a live credential in every log that captures stdout.
        console.log("The account is active. Sign in with the password you supplied.");
        return;
      }

      const link = `${options.portalUrl}/accept-invitation?token=${result.invitation.token}`;

      console.log(
        result.created
          ? `Created platform administrator ${options.email}.`
          : `Reissued an invitation for platform administrator ${options.email}.`
      );
      console.log("");
      console.log(`  Sign-in tenant:  ${PLATFORM_TENANT_SLUG}`);
      console.log(`  Expires:         ${result.invitation.expiresAt.toISOString()}`);
      console.log(`  Invitation link: ${link}`);
      console.log("");
      // Said plainly, because only a digest is stored: nothing can print this
      // again, and someone who assumes otherwise loses the account.
      console.log("This link is shown once and cannot be recovered. Re-run to issue a new one.");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  if (err instanceof PlatformTenantMissingError) {
    console.error(err.message);
    process.exit(1);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
