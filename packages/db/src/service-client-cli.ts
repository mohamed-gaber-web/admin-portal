import { hostname, userInfo } from "node:os";
import { loadRepoEnv } from "./env";
import { createPool } from "./pool";
import { createServiceClient, listServiceClients, revokeServiceClient } from "./service-clients";

/**
 * Manages service clients: machine credentials that read one tenant's ERP data.
 *
 *   pnpm service-client -- create --tenant <slug> --name "ONE365 reports sync"
 *   pnpm service-client -- list   --tenant <slug>
 *   pnpm service-client -- revoke --client-id svc_… [--reason "rotated"]
 *
 * A CLI rather than an endpoint for the same reason as `platform-admin`: it
 * needs a shell on a machine holding the database credentials, which is the
 * level of access a credential into a customer's ERP is worth. The secret is
 * printed once and stored only as a digest; a lost secret means revoke and
 * create a new client.
 */

type Command = "create" | "list" | "revoke";

function parseArguments(argv: string[]): { command: Command; values: Map<string, string> } {
  const [command, ...rest] = argv.filter((a) => a !== "--");
  if (command !== "create" && command !== "list" && command !== "revoke") {
    throw new Error(
      "Usage: pnpm service-client -- <create|list|revoke> [--tenant <slug>] [--name <text>] [--client-id <id>] [--reason <text>]"
    );
  }
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) continue;
    const [flag, inline] = arg.slice(2).split("=", 2);
    const next = rest[i + 1];
    const value = inline ?? (next && !next.startsWith("--") ? next : undefined);
    if (value !== undefined) values.set(flag, value.trim());
  }
  return { command, values };
}

function required(values: Map<string, string>, flag: string): string {
  const value = values.get(flag);
  if (!value) throw new Error(`--${flag} is required.`);
  return value;
}

async function main(): Promise<void> {
  loadRepoEnv();
  const { command, values } = parseArguments(process.argv.slice(2));
  const actorLabel = `cli:${userInfo().username}@${hostname()}`;
  const pool = createPool();

  try {
    // Admin pool, no tenant scoping: a command-line tool has no request context,
    // and the tenant is named explicitly and checked below.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      if (command === "revoke") {
        const revoked = await revokeServiceClient(client, {
          clientId: required(values, "client-id"),
          reason: values.get("reason") || "revoked from the command line",
          actorLabel
        });
        await client.query("COMMIT");
        console.log(
          revoked
            ? `Revoked ${revoked.clientId} (${revoked.name}). Tokens already issued expire within 15 minutes.`
            : "No live service client has that id. Nothing was changed."
        );
        return;
      }

      const slug = required(values, "tenant");
      const tenant = await client.query<{ id: string; name: string }>(
        "SELECT id, name FROM tenant WHERE slug = $1 AND deleted_at IS NULL",
        [slug]
      );
      const tenantRow = tenant.rows[0];
      if (!tenantRow) throw new Error(`No active tenant with slug "${slug}".`);

      if (command === "list") {
        const clients = await listServiceClients(client, tenantRow.id);
        await client.query("COMMIT");
        if (clients.length === 0) console.log(`No service clients for ${slug}.`);
        for (const c of clients) {
          const state = c.revokedAt ? `revoked ${c.revokedAt.toISOString()}` : "active";
          const used = c.lastUsedAt ? c.lastUsedAt.toISOString() : "never";
          console.log(`${c.clientId}  ${state}  last used ${used}  ${c.name}  [${c.scopes.join(", ")}]`);
        }
        return;
      }

      const created = await createServiceClient(client, {
        tenantId: tenantRow.id,
        name: required(values, "name"),
        actorLabel
      });
      await client.query("COMMIT");

      console.log(`Created service client for ${tenantRow.name} (${slug}).`);
      console.log("");
      console.log(`  Client id:      ${created.client.clientId}`);
      console.log(`  Client secret:  ${created.clientSecret}`);
      console.log(`  Scopes:         ${created.client.scopes.join(", ")}`);
      console.log("");
      console.log("The secret is shown once and cannot be recovered. Store it in the consumer's");
      console.log("secret store now; if it is lost, revoke this client and create a new one.");
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
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
