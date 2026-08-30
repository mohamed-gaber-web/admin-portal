import { recordAuditEntry, type AuditActor } from "./audit";
import type { Queryable } from "./tenancy";

/**
 * Mobile runtime configuration (US-040).
 *
 * The half of `environment.ts` a device is allowed to hold: where the API is,
 * which public Entra client to sign in with, and the oldest build this tenant
 * will serve. Everything confidential lives in `connections.ts` and is read by
 * the API alone.
 *
 * Two reads, and the difference between them is the security story:
 *
 *   `findMobileBootstrap`  unauthenticated, by slug, for a device that has no
 *                          session yet. Runs unscoped, so it selects an explicit
 *                          column list — a `SELECT *` here would publish the next
 *                          column somebody adds.
 *   `findMobileConfig`     the caller's own, inside a tenant-scoped session, for
 *                          the administration screen.
 */

/** The public Entra client a device signs users in with. Absent after cutover. */
export interface MobileUserAuth {
  clientId: string;
  authority: string;
  redirectUri: string;
  scopes: string[];
}

export interface MobileConfigRecord {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  apiBaseUrl: string;
  userAuth: MobileUserAuth | null;
  minimumAppVersion: string | null;
  updatedAt: Date;
}

interface MobileConfigRow {
  tenant_id: string;
  slug: string;
  name: string;
  api_base_url: string;
  user_auth_client_id: string | null;
  user_auth_authority: string | null;
  user_auth_redirect_uri: string | null;
  user_auth_scopes: string[] | null;
  minimum_app_version: string | null;
  updated_at: Date;
}

/**
 * Named columns, never `*`.
 *
 * This projection is what an unauthenticated caller receives. A wildcard would
 * mean the next column added to the table is published the moment the migration
 * runs, with no code change to review — the failure being guarded against is a
 * silent one.
 */
const MOBILE_CONFIG_COLUMNS = `
  c.tenant_id, t.slug, t.name,
  c.api_base_url,
  c.user_auth_client_id, c.user_auth_authority, c.user_auth_redirect_uri, c.user_auth_scopes,
  c.minimum_app_version, c.updated_at
`;

const toRecord = (row: MobileConfigRow): MobileConfigRecord => ({
  tenantId: row.tenant_id,
  tenantSlug: row.slug,
  tenantName: row.name,
  apiBaseUrl: row.api_base_url,
  userAuth: row.user_auth_client_id
    ? {
        clientId: row.user_auth_client_id,
        // Non-null together with the client id, enforced by the check
        // constraint the migration adds — a half-configured block would produce
        // a sign-in attempt against nothing.
        authority: row.user_auth_authority ?? "",
        redirectUri: row.user_auth_redirect_uri ?? "",
        scopes: row.user_auth_scopes ?? []
      }
    : null,
  minimumAppVersion: row.minimum_app_version,
  updatedAt: row.updated_at
});

/**
 * The bootstrap read: one tenant's device configuration, by slug.
 *
 * The slug is the same thing sign-in already takes, and for the same reason —
 * it is the only identifier a freshly installed app has been given. It is a
 * *claim*, resolved here, never a tenant context: nothing this function returns
 * is scoped to a session, so it cannot be used to reach anything else.
 *
 * **Archived and suspended tenants answer null.** A suspended tenant is one
 * whose access has been withdrawn, and handing its devices a working
 * configuration would make suspension a portal-only fiction while the field kept
 * running. The caller turns null into the same 404 an unknown slug gets.
 */
export async function findMobileBootstrap(
  db: Queryable,
  slug: string
): Promise<MobileConfigRecord | null> {
  const candidate = slug.trim().toLowerCase();
  // Bounded before it reaches the query: the parameter arrives on a query string
  // from an unauthenticated caller, and an unbounded one is free index work per
  // request.
  if (!candidate || candidate.length > 64) return null;

  const res = await db.query<MobileConfigRow>(
    `SELECT ${MOBILE_CONFIG_COLUMNS}
       FROM tenant_mobile_config c
       JOIN tenant t ON t.id = c.tenant_id
      WHERE t.slug = $1
        AND t.deleted_at IS NULL
        AND t.suspended_at IS NULL
        AND NOT t.is_platform`,
    [candidate]
  );

  const row = res.rows[0];
  return row ? toRecord(row) : null;
}

/** The caller's own configuration, inside a tenant-scoped session. */
export async function findMobileConfig(db: Queryable): Promise<MobileConfigRecord | null> {
  const res = await db.query<MobileConfigRow>(
    `SELECT ${MOBILE_CONFIG_COLUMNS}
       FROM tenant_mobile_config c
       JOIN tenant t ON t.id = c.tenant_id`
  );
  const row = res.rows[0];
  return row ? toRecord(row) : null;
}

export interface SaveMobileConfigInput {
  apiBaseUrl: string;
  /** Null clears the Entra sign-in block — what a tenant past cutover looks like. */
  userAuth: MobileUserAuth | null;
  minimumAppVersion?: string | null;
}

/**
 * Creates or replaces the caller's tenant's configuration.
 *
 * An upsert rather than separate create and update endpoints: there is at most
 * one row per tenant, so "does it exist yet" is a question the screen would have
 * to ask only to decide which verb to use.
 *
 * The whole record travels, not a patch. Two administrators editing the same
 * form cannot then interleave into an arrangement neither of them chose — the
 * same reasoning as `PUT /users/:id/roles`.
 */
export async function saveMobileConfig(
  db: Queryable,
  input: SaveMobileConfigInput,
  actor: AuditActor
): Promise<MobileConfigRecord | null> {
  const before = await findMobileConfig(db);

  /**
   * The tenant comes from the session, not from a parameter.
   *
   * `current_tenant_id()` is the same function the RLS policies read, so the row
   * is written for exactly the tenant the policy would then let this session see
   * — there is no id here that could be off by one, and the policy's WITH CHECK
   * refuses the write outright if it ever were.
   */
  const res = await db.query<{ tenant_id: string }>(
    `INSERT INTO tenant_mobile_config (
       tenant_id, api_base_url,
       user_auth_client_id, user_auth_authority, user_auth_redirect_uri, user_auth_scopes,
       minimum_app_version
     )
     VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id) DO UPDATE SET
       api_base_url = EXCLUDED.api_base_url,
       user_auth_client_id = EXCLUDED.user_auth_client_id,
       user_auth_authority = EXCLUDED.user_auth_authority,
       user_auth_redirect_uri = EXCLUDED.user_auth_redirect_uri,
       user_auth_scopes = EXCLUDED.user_auth_scopes,
       minimum_app_version = EXCLUDED.minimum_app_version,
       updated_at = now()
     RETURNING tenant_id`,
    [
      input.apiBaseUrl,
      input.userAuth?.clientId ?? null,
      input.userAuth?.authority ?? null,
      input.userAuth?.redirectUri ?? null,
      input.userAuth?.scopes ?? [],
      input.minimumAppVersion ?? null
    ]
  );

  const tenantId = res.rows[0]?.tenant_id;
  if (!tenantId) return null;

  const after = await findMobileConfig(db);
  if (!after) return null;

  await recordAuditEntry(db, {
    tenantId,
    action: "mobile_config.updated",
    entityType: "tenant_mobile_config",
    entityId: tenantId,
    actor,
    // Nothing here is a credential — a public client id is public by
    // definition — so the values are recorded in full. `apiBaseUrl` changing is
    // the entry worth having: it redirects every device in the field.
    before: before
      ? {
          apiBaseUrl: before.apiBaseUrl,
          userAuthClientId: before.userAuth?.clientId ?? null,
          userAuthAuthority: before.userAuth?.authority ?? null,
          minimumAppVersion: before.minimumAppVersion
        }
      : null,
    after: {
      apiBaseUrl: after.apiBaseUrl,
      userAuthClientId: after.userAuth?.clientId ?? null,
      userAuthAuthority: after.userAuth?.authority ?? null,
      minimumAppVersion: after.minimumAppVersion
    }
  });

  return after;
}
