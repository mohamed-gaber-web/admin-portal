import type { Pool } from "pg";
import { createCompany, createEnvironment, createTenant } from "../packages/db/src/tenancy";
import { acceptInvitation, issueInvitation } from "../packages/db/src/invitations";
import { ensurePlatformAdmin, PLATFORM_TENANT_SLUG } from "../packages/db/src/platform";
import type { Queryable } from "../packages/db/src/tenancy";
import { API_ROUTES } from "../packages/contracts/src/routes";
import { PERMISSION_KEYS } from "../packages/contracts/src/schemas/role";

/** Long enough to clear the 12-character minimum in `acceptInvitation`. */
export const FIXTURE_PASSWORD = "correct-horse-battery-staple";

export interface CompanyFixture {
  id: string;
  name: string;
  dataAreaId: string;
}

export interface TenantFixture {
  tenantId: string;
  userId: string;
  slug: string;
  email: string;
  /** A real token, obtained by signing in over HTTP the way a client would. */
  accessToken: string;
  /** The refresh token from that same sign-in, unspent. */
  refreshToken: string;
  companies: CompanyFixture[];
}

export interface SeedTenantOptions {
  companies?: string[];
  /**
   * Permission keys the admin should hold, granted through a role.
   *
   * Omit it and the admin holds the whole tenant-scoped catalogue, which is what
   * `provisionTenant` gives a real tenant's first administrator. That default
   * matters now that routes check the claim: a fixture admin holding nothing
   * would be refused by `PermissionGuard` on the very endpoints these suites
   * exist to exercise, and the failure would look like a broken endpoint rather
   * than a fixture with no authority.
   *
   * Pass an explicit list to test a narrower account — `[]` for one with no
   * permissions at all.
   */
  permissions?: string[];
}

/**
 * A tenant with a signed-in admin and some companies.
 *
 * Built through the real invitation → accept → sign-in path rather than by
 * inserting rows, so the token these tests carry is one the API actually
 * issued. Two of these are what an isolation test needs: proving tenant A
 * cannot see tenant B requires a tenant B that genuinely has something to see.
 */
export async function seedTenant(
  pool: Pool,
  baseUrl: string,
  slug: string,
  options: SeedTenantOptions = {}
): Promise<TenantFixture> {
  const tenant = await createTenant(pool, { name: slug, slug });
  const email = `admin@${slug}.local`;

  const environment = await createEnvironment(pool, {
    tenantId: tenant.id,
    name: "PROD",
    url: `https://${slug}.crm4.dynamics.com`
  });

  const companies: CompanyFixture[] = [];
  const names = options.companies ?? [];
  for (const [index, name] of names.entries()) {
    const company = await createCompany(pool, {
      tenantId: tenant.id,
      environmentId: environment.id,
      name,
      // Indexed: `dataAreaId` is unique per environment, and two companies whose
      // names share a prefix ("Acme Retail", "Acme Manufacturing") otherwise
      // collide.
      dataAreaId: `${name.replace(/[^A-Za-z0-9]/g, "").slice(0, 4).toLowerCase()}${index}`
    });
    companies.push({ id: company.id, name: company.name, dataAreaId: company.dataAreaId });
  }

  const invitation = await issueInvitation(pool, {
    tenantId: tenant.id,
    email,
    actor: { label: "platform-admin" }
  });

  // Granted before sign-in, because permissions are stamped into the token at
  // sign-in rather than joined per request.
  const granted = options.permissions ?? [...PERMISSION_KEYS];
  if (granted.length) {
    await grantPermissions(pool, tenant.id, invitation.userId, granted);
  }

  /**
   * The other default role, held by nobody yet.
   *
   * `createTenant` builds the tenant without the roles `provisionTenant` would
   * have created, so a fixture tenant used to have whichever single role
   * `grantPermissions` invented. That is a tenant no customer has: tests that
   * name `viewer` — assigning it, inviting into it — failed against the fixture
   * for a reason that says nothing about the code under test.
   */
  await ensureRole(
    pool,
    tenant.id,
    "viewer",
    PERMISSION_KEYS.filter((key) => key.endsWith(".read"))
  );

  await acceptInvitation(pool, { token: invitation.token, password: FIXTURE_PASSWORD });

  const res = await fetch(`${baseUrl}${API_ROUTES.login}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: FIXTURE_PASSWORD })
  });
  if (res.status !== 200) {
    throw new Error(`fixture sign-in failed for ${slug}: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { accessToken: string; refreshToken: string };

  return {
    tenantId: tenant.id,
    userId: invitation.userId,
    slug,
    email,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    companies
  };
}

export interface PlatformAdminFixture {
  tenantId: string;
  userId: string;
  email: string;
  slug: string;
  accessToken: string;
  /** `Authorization` header, since almost every use is passing exactly this. */
  headers: Record<string, string>;
}

/**
 * A signed-in platform administrator.
 *
 * Needed by every suite that provisions a tenant over HTTP: `POST /tenants` is
 * no longer unauthenticated, because an open endpoint that mints tenants is one
 * anybody who can reach the port may use, and a signed-in tenant administrator
 * could use it too.
 *
 * Built through the real `pnpm platform-admin` path — `ensurePlatformAdmin`,
 * accept, sign in — rather than by inserting rows and forging a token. A
 * fixture that took a shortcut here would pass while the bootstrap it stands in
 * for was broken, which is the one thing this account cannot afford.
 *
 * The reserved tenant itself comes from the platform-administration migration,
 * so a throwaway test database has it as soon as it is migrated.
 */
export async function seedPlatformAdmin(
  db: Queryable,
  baseUrl: string,
  email = "operator@platform.test"
): Promise<PlatformAdminFixture> {
  const result = await ensurePlatformAdmin(db, { email, name: "Test Operator" });
  if (!result.invitation) {
    throw new Error(`platform admin ${email} already has a credential; use a fresh address`);
  }

  await acceptInvitation(db, {
    token: result.invitation.token,
    password: FIXTURE_PASSWORD
  });

  const res = await fetch(`${baseUrl}${API_ROUTES.login}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: FIXTURE_PASSWORD })
  });
  if (res.status !== 200) {
    throw new Error(`platform admin sign-in failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { accessToken: string };

  return {
    tenantId: result.tenant.id,
    userId: result.userId,
    email,
    slug: PLATFORM_TENANT_SLUG,
    accessToken: body.accessToken,
    headers: { authorization: `Bearer ${body.accessToken}` }
  };
}

export interface SeedMemberOptions {
  /** Defaults to `viewer`, the read-only role provisioning creates. */
  role?: string;
  /** Defaults to the read half of the catalogue, which is what a viewer holds. */
  permissions?: string[];
}

export interface MemberFixture {
  userId: string;
  email: string;
  accessToken: string;
}

/**
 * A second user inside an existing tenant, holding a narrower role.
 *
 * The point of it is the thing one tenant with one all-powerful admin cannot
 * express: whether a route distinguishes between two members of the *same*
 * tenant. Cross-tenant isolation is a different question with a different
 * answer (404, not 403), and a second tenant cannot stand in for this one.
 *
 * Built through invitation → accept → sign in, like `seedTenant`, so the token
 * carries the permissions the real sign-in path stamped onto it rather than a
 * set this file decided.
 */
export async function seedMember(
  pool: Pool,
  baseUrl: string,
  tenant: Pick<TenantFixture, "tenantId" | "slug">,
  options: SeedMemberOptions = {}
): Promise<MemberFixture> {
  const role = options.role ?? "viewer";
  const permissions =
    options.permissions ?? PERMISSION_KEYS.filter((key) => key.endsWith(".read"));
  const email = `${role}@${tenant.slug}.local`;

  const invitation = await issueInvitation(pool, {
    tenantId: tenant.tenantId,
    email,
    actor: { label: "platform-admin" }
  });

  await grantPermissions(pool, tenant.tenantId, invitation.userId, permissions, role);
  await acceptInvitation(pool, { token: invitation.token, password: FIXTURE_PASSWORD });

  const res = await fetch(`${baseUrl}${API_ROUTES.login}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: FIXTURE_PASSWORD })
  });
  if (res.status !== 200) {
    throw new Error(`fixture sign-in failed for ${email}: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { accessToken: string };

  return { userId: invitation.userId, email, accessToken: body.accessToken };
}

/**
 * Gives a user the named permissions through a role.
 *
 * The full chain — permission catalogue, role, role_permission, user_role — is
 * what `loadPermissions` reads, so building it here is what makes a permission
 * claim in a token mean something.
 *
 * The role name is a parameter rather than always `admin`, because a fixture
 * that granted a read-only set through a role called `admin` would be testing
 * the permission check while lying about who holds it — and the next person
 * reading the row would reasonably disbelieve the test.
 */
export async function grantPermissions(
  pool: Pool,
  tenantId: string,
  userId: string,
  keys: readonly string[],
  roleName = "admin"
): Promise<void> {
  const roleId = await ensureRole(pool, tenantId, roleName, keys);

  await pool.query(
    `INSERT INTO user_role (tenant_id, user_id, role_id) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [tenantId, userId, roleId]
  );
}

/**
 * Creates (or tops up) one role and the permissions it holds, and returns its id.
 *
 * Split out of `grantPermissions` so a role can exist without anybody holding
 * it — which is what a freshly provisioned tenant's `viewer` looks like, and
 * what a test naming that role needs to be there.
 */
export async function ensureRole(
  pool: Pool,
  tenantId: string,
  roleName: string,
  keys: readonly string[]
): Promise<string> {
  const role = await pool.query<{ id: string }>(
    `INSERT INTO role (tenant_id, name) VALUES ($1, $2)
     ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [tenantId, roleName]
  );
  const roleId = role.rows[0].id;

  for (const key of keys) {
    const permission = await pool.query<{ id: string }>(
      `INSERT INTO permission (key, description) VALUES ($1, $1)
       ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key
       RETURNING id`,
      [key]
    );
    await pool.query(
      `INSERT INTO role_permission (tenant_id, role_id, permission_id) VALUES ($1, $2, $3)
       ON CONFLICT (role_id, permission_id) DO NOTHING`,
      [tenantId, roleId, permission.rows[0].id]
    );
  }

  return roleId;
}
