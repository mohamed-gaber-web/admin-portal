import type { Pool, PoolClient } from "pg";
import { recordAuditEntry, type AuditActor } from "./audit";
import { issueInvitation } from "./invitations";
import { grantTenantModules } from "./modules";
import { isPlatformPermissionKey } from "./platform";

/** Roles every new tenant starts with. Matches the demo seed's conventions. */
export const DEFAULT_ROLES = ["admin", "viewer"] as const;

/**
 * What each default role may do, the moment the tenant exists.
 *
 * Provisioning used to create the two roles and grant them nothing, which made
 * them names attached to no authority — a freshly provisioned tenant opened its
 * permission matrix on a grid of unchecked boxes, and its admin held less than
 * the viewer role implies. The roles were decorative in exactly the way the
 * `role_permission` table was added to prevent.
 *
 * The rule is the one the demo seed already used: admin holds the whole
 * catalogue, viewer holds the read half. It is expressed against whatever the
 * `permission` table actually contains rather than a hard-coded key list, so a
 * permission added by a later migration is granted to admin automatically and
 * cannot be silently missed here.
 */
function permissionsForDefaultRole(role: string, catalogue: string[]): string[] {
  // `platform.*` is filtered out first, and this is not optional tidying. The
  // rule below hands `admin` the whole catalogue on purpose, so that a
  // permission added by a later migration is granted rather than silently
  // missed — which, once the platform tier existed, meant every incoming
  // tenant's administrator would be provisioned with cross-tenant reach. The
  // database refuses the grant outright (see the platform-administration
  // migration's trigger), so leaving this unfiltered would not leak anything;
  // it would make `POST /tenants` fail on every call.
  const tenantScoped = catalogue.filter((key) => !isPlatformPermissionKey(key));

  return role === "admin" ? tenantScoped : tenantScoped.filter((key) => key.endsWith(".read"));
}

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

/**
 * Raised when the first administrator's address already belongs to somebody.
 *
 * `user_email_global_unique` makes an address identify exactly one person
 * across the installation — that is what lets sign-in resolve the workspace
 * from the address alone, and it means the address of an existing user in
 * *any* tenant cannot become a new tenant's administrator.
 *
 * Typed for the same reason as the slug above: without it the unique violation
 * reached the API as a raw driver error and became a 500, which tells an
 * operator that the server is broken when what actually happened is that they
 * typed an address somebody already has. Provisioning runs in one transaction,
 * so the half-built tenant was always rolled back — the outcome was right and
 * only the report was wrong, which is precisely the failure nobody
 * investigates.
 *
 * The address is named because the caller just supplied it. The tenant holding
 * it is not: `platform.tenant.write` does not imply `platform.user.read`, and
 * answering "that belongs to tenant acme" would hand a caller a fact this
 * endpoint has no business teaching them. Knowing the address is taken is
 * enough to act on.
 */
export class AdminEmailAlreadyExistsError extends Error {
  readonly email: string;

  constructor(email: string) {
    super(`The address "${email}" already belongs to a user. Choose a different administrator address.`);
    this.name = "AdminEmailAlreadyExistsError";
    this.email = email;
  }
}

export interface ProvisionTenantInput {
  name: string;
  slug: string;
  /** Defaults to `admin@<slug>.local`. */
  adminEmail?: string;
  /**
   * The package to start the tenant on.
   *
   * Omitted means "whatever the column defaults to", which is deliberately not
   * spelled out here: the database applies the default, so there is one value
   * in play rather than a copy in application code that can drift from it.
   */
  plan?: string;
  /**
   * Modules to grant the tenant as it is created.
   *
   * Omitted or empty grants nothing. Granted inside the provisioning
   * transaction rather than by a follow-up call, because provisioning's last
   * act is issuing the first admin's invitation: a tenant created with no
   * modules is one whose administrator can accept that invitation and sign in
   * to an empty sidebar before an operator reaches the second screen.
   *
   * Unknown keys are dropped rather than refused — see `grantTenantModules`.
   */
  modules?: readonly string[];
}

export interface ProvisionTenantResult {
  tenant: { id: string; name: string; slug: string };
  adminUser: { id: string; email: string };
  roles: { id: string; name: string }[];
  /**
   * The modules actually granted — what was asked for, intersected with the
   * catalogue. Returned so a caller can tell that a key it sent was dropped as
   * unknown, which is otherwise silent.
   */
  modules: string[];
  /**
   * The first admin's invitation (US-020).
   *
   * Provisioning used to create an admin user with no credential, which meant a
   * freshly provisioned tenant had nobody who could ever sign in. The token is
   * returned exactly once here and stored only as a digest.
   */
  invitation: { id: string; expiresAt: Date; token: string };
}

/** The admin address used when the caller does not supply one. */
export function defaultAdminEmail(slug: string): string {
  return `admin@${slug}.local`;
}

/**
 * A unique violation, optionally narrowed to one index.
 *
 * `constraint` matters wherever a statement can breach more than one index:
 * translating any violation into one meaning is how a real bug ends up
 * reported as the collision the code happened to expect. Postgres names the
 * index in `constraint`, and an unnamed match is refused rather than assumed,
 * because a driver that stopped populating it would otherwise turn this into
 * "any unique violation" without a test noticing.
 */
function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, constraint: violated } = err as { code?: string; constraint?: string };
  if (code !== UNIQUE_VIOLATION) return false;
  return constraint === undefined || violated === constraint;
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
    /*
     * Two statements rather than one with a coalesce, so that omitting the plan
     * leaves the column out of the INSERT entirely and the *database's* default
     * applies. Passing a fallback from here would make application code the
     * second place the default is written down, and the one that silently wins.
     */
    const res = input.plan
      ? await client.query<{ id: string; name: string; slug: string }>(
          "INSERT INTO tenant (name, slug, plan) VALUES ($1, $2, $3) RETURNING id, name, slug",
          [input.name, input.slug, input.plan]
        )
      : await client.query<{ id: string; name: string; slug: string }>(
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

  // The catalogue is installed by migration, so this is normally populated. An
  // empty result is not treated as an error: the roles still exist and the
  // permission matrix can grant them, which is a better outcome than refusing
  // to provision a tenant because a reference table is unexpectedly bare.
  const catalogue = await client.query<{ id: string; key: string }>(
    "SELECT id, key FROM permission ORDER BY key"
  );
  const keys = catalogue.rows.map((row) => row.key);
  const idByKey = new Map(catalogue.rows.map((row) => [row.key, row.id]));

  const grantedByRole: Record<string, string[]> = {};
  for (const role of roles) {
    const granted = permissionsForDefaultRole(role.name, keys);
    grantedByRole[role.name] = granted;

    for (const key of granted) {
      await client.query(
        `INSERT INTO role_permission (tenant_id, role_id, permission_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (role_id, permission_id) DO NOTHING`,
        [tenant.id, role.id, idByKey.get(key)]
      );
    }
  }

  // "user" is a reserved word, so it stays quoted.
  let adminUser: { id: string; email: string };
  try {
    const userRes = await client.query<{ id: string; email: string }>(
      'INSERT INTO "user" (tenant_id, email) VALUES ($1, $2) RETURNING id, email',
      [tenant.id, email]
    );
    adminUser = userRes.rows[0];
  } catch (err) {
    /*
     * Only the global address index is translated. The tenant is brand new, so
     * no per-tenant constraint on "user" can be the one that fired — and a
     * unique violation this code did not anticipate must keep surfacing as
     * itself rather than being reported as an address collision it is not.
     */
    if (isUniqueViolation(err, "user_email_global_unique")) {
      throw new AdminEmailAlreadyExistsError(email);
    }
    throw err;
  }

  const adminRole = roles.find((role) => role.name === DEFAULT_ADMIN_ROLE);
  if (!adminRole) {
    throw new Error(`DEFAULT_ROLES must contain "${DEFAULT_ADMIN_ROLE}"`);
  }
  await client.query(
    "INSERT INTO user_role (tenant_id, user_id, role_id) VALUES ($1, $2, $3)",
    [tenant.id, adminUser.id, adminRole.id]
  );

  /*
   * The modules the operator chose on the create form.
   *
   * Before the audit entry below, so the entry can state what was granted. No
   * entry of its own: nothing was *changed* here, and `tenant.modules_changed`
   * written a moment after `tenant.provisioned` reads as an edit somebody made
   * rather than as the state a tenant came into existence with. Same treatment
   * as the default roles and permissions above.
   */
  const modules = await grantTenantModules(client, {
    tenantId: tenant.id,
    keys: input.modules ?? []
  });

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
    // The grants are recorded as context on provisioning rather than as their
    // own `role.permissions_changed` entry: nobody changed anything, these are
    // the defaults the tenant came into existence with, and a separate entry
    // would read as an edit somebody made afterwards.
    context: { defaultRoles: [...DEFAULT_ROLES], defaultPermissions: grantedByRole, modules }
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

  // The tenant is useless without this: the admin row exists but has no
  // credential, and there is no other way to obtain one.
  const invitation = await issueInvitation(client, {
    tenantId: tenant.id,
    email: adminUser.email,
    actor,
    invitedBy: null
  });

  return {
    tenant,
    adminUser,
    roles,
    modules,
    invitation: { id: invitation.id, expiresAt: invitation.expiresAt, token: invitation.token }
  };
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
