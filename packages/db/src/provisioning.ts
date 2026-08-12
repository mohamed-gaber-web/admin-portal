import type { Pool, PoolClient } from "pg";
import { recordAuditEntry, type AuditActor } from "./audit";

/** Roles every new tenant starts with. Matches the demo seed's conventions. */
export const DEFAULT_ROLES = ["admin", "viewer"] as const;

/** The role the first admin user is assigned. */
export const DEFAULT_ADMIN_ROLE = "admin";

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";

/**
 * Raised when the tenant identifier is already taken. Carried as a typed error
 * so the API can answer 409 with something the caller can act on, rather than
 * leaking a driver message.
 */
export class TenantAlreadyExistsError extends Error {
  readonly slug: string;

  constructor(slug: string) {
    super(`A tenant with the identifier "${slug}" already exists. Choose a different slug.`);
    this.name = "TenantAlreadyExistsError";
    this.slug = slug;
  }
}

export interface ProvisionTenantInput {
  name: string;
  slug: string;
  /** Defaults to `admin@<slug>.local`. */
  adminEmail?: string;
}

export interface ProvisionTenantResult {
  tenant: { id: string; name: string; slug: string };
  adminUser: { id: string; email: string };
  roles: { id: string; name: string }[];
}

/** The admin address used when the caller does not supply one. */
export function defaultAdminEmail(slug: string): string {
  return `admin@${slug}.local`;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === UNIQUE_VIOLATION
  );
}

/**
 * Provisioning on a caller-supplied client, which must already be in a
 * transaction.
 *
 * Exported so the API can run it inside the US-012 escape hatch: provisioning
 * genuinely cannot be tenant-scoped — the tenant does not exist yet — and going
 * through `withoutTenantScope` is what puts that bypass in the log instead of
 * leaving it as an unremarked use of the admin pool.
 */
export async function provisionTenantOnClient(
  client: PoolClient,
  input: ProvisionTenantInput,
  actor: AuditActor
): Promise<ProvisionTenantResult> {
  const email = input.adminEmail ?? defaultAdminEmail(input.slug);

  let tenant: { id: string; name: string; slug: string };
  try {
    const res = await client.query<{ id: string; name: string; slug: string }>(
      "INSERT INTO tenant (name, slug) VALUES ($1, $2) RETURNING id, name, slug",
      [input.name, input.slug]
    );
    tenant = res.rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new TenantAlreadyExistsError(input.slug);
    }
    throw err;
  }

  const roles: { id: string; name: string }[] = [];
  for (const name of DEFAULT_ROLES) {
    const res = await client.query<{ id: string; name: string }>(
      "INSERT INTO role (tenant_id, name) VALUES ($1, $2) RETURNING id, name",
      [tenant.id, name]
    );
    roles.push(res.rows[0]);
  }

  // "user" is a reserved word, so it stays quoted.
  const userRes = await client.query<{ id: string; email: string }>(
    'INSERT INTO "user" (tenant_id, email) VALUES ($1, $2) RETURNING id, email',
    [tenant.id, email]
  );
  const adminUser = userRes.rows[0];

  const adminRole = roles.find((role) => role.name === DEFAULT_ADMIN_ROLE);
  if (!adminRole) {
    throw new Error(`DEFAULT_ROLES must contain "${DEFAULT_ADMIN_ROLE}"`);
  }
  await client.query(
    "INSERT INTO user_role (tenant_id, user_id, role_id) VALUES ($1, $2, $3)",
    [tenant.id, adminUser.id, adminRole.id]
  );

  // Two entries, because two different things happened: a tenant came into
  // existence, and someone was granted a permission.
  await recordAuditEntry(client, {
    tenantId: tenant.id,
    action: "tenant.provisioned",
    entityType: "tenant",
    entityId: tenant.id,
    actor: { ...actor, userId: actor.userId ?? adminUser.id },
    before: null,
    after: { name: tenant.name, slug: tenant.slug },
    context: { defaultRoles: [...DEFAULT_ROLES] }
  });

  await recordAuditEntry(client, {
    tenantId: tenant.id,
    action: "role.assigned",
    entityType: "user_role",
    entityId: adminUser.id,
    actor: { ...actor, userId: actor.userId ?? adminUser.id },
    before: null,
    after: { userEmail: adminUser.email, role: adminRole.name },
    context: { roleId: adminRole.id }
  });

  return { tenant, adminUser, roles };
}

/**
 * Creates a tenant together with its default roles and first admin user.
 *
 * One transaction, deliberately: a tenant that exists with no admin user is
 * worse than a failed request, because nobody can sign in to repair it.
 *
 * Runs on the admin connection and so bypasses row level security — creating a
 * tenant cannot be scoped to that tenant. Once the API connects as `app_user`
 * this needs a separately privileged path.
 */
export async function provisionTenant(
  pool: Pool,
  input: ProvisionTenantInput,
  actor: AuditActor = { label: "system:provisioning" }
): Promise<ProvisionTenantResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await provisionTenantOnClient(client, input, actor);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
