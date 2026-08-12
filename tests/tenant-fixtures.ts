import type { Pool } from "pg";
import { createCompany, createEnvironment, createTenant } from "../packages/db/src/tenancy";
import { acceptInvitation, issueInvitation } from "../packages/db/src/invitations";
import { API_ROUTES } from "../packages/contracts/src/routes";

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
  companies: CompanyFixture[];
}

export interface SeedTenantOptions {
  companies?: string[];
  /** Permission keys the admin should hold, granted through a role. */
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
  if (options.permissions?.length) {
    await grantPermissions(pool, tenant.id, invitation.userId, options.permissions);
  }

  await acceptInvitation(pool, { token: invitation.token, password: FIXTURE_PASSWORD });

  const res = await fetch(`${baseUrl}${API_ROUTES.login}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug, email, password: FIXTURE_PASSWORD })
  });
  if (res.status !== 200) {
    throw new Error(`fixture sign-in failed for ${slug}: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { accessToken: string };

  return {
    tenantId: tenant.id,
    userId: invitation.userId,
    slug,
    email,
    accessToken: body.accessToken,
    companies
  };
}

/**
 * Gives a user the named permissions through an `admin` role.
 *
 * The full chain — permission catalogue, role, role_permission, user_role — is
 * what `loadPermissions` reads, so building it here is what makes a permission
 * claim in a token mean something.
 */
export async function grantPermissions(
  pool: Pool,
  tenantId: string,
  userId: string,
  keys: string[]
): Promise<void> {
  const role = await pool.query<{ id: string }>(
    `INSERT INTO role (tenant_id, name) VALUES ($1, 'admin')
     ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [tenantId]
  );
  const roleId = role.rows[0].id;

  await pool.query(
    `INSERT INTO user_role (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`,
    [tenantId, userId, roleId]
  );

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
}
