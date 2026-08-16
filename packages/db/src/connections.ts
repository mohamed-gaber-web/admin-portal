import { recordAuditEntry, type AuditActor } from "./audit";
import { openSecret, sealSecret } from "./secret-box";
import { isUuid } from "./tenant-administration";
import type { Queryable } from "./tenancy";

/**
 * D365 connection configuration (US-040, US-045).
 *
 * Everything here runs inside a tenant-scoped session, so there is no
 * `WHERE tenant_id` in any query below and none is wanted: row level security on
 * `d365_environment` does the filtering, which is what makes another tenant's
 * environment id a 404 rather than something this file has to remember to check.
 *
 * The rule the whole module is built around: **the client secret leaves this
 * file in exactly one direction**. `openClientSecret` hands it to the token
 * request and nothing else; every other function returns `ConnectionRecord`,
 * which has no field it could travel in. US-045's "write-only secret handling"
 * is therefore a property of the return type rather than a rule about which
 * fields a serialiser remembers to strip.
 */

/** How the connection last behaved. Mirrors the contract's `CONNECTION_STATES`. */
export type ConnectionState = "connected" | "failing" | "not_configured";

/**
 * Why a check failed, as a fixed set.
 *
 * Deliberately not the identity provider's own message — see the migration.
 * These are the distinctions an administrator can act on: the wrong secret, the
 * wrong directory, a service principal with no access to the ERP, and a network
 * that did not answer.
 */
export type ConnectionErrorCode =
  | "invalid_client"
  | "invalid_tenant"
  | "invalid_scope"
  | "unreachable"
  | "unexpected";

/** Entra hosts the schema will accept. Sovereign clouds serve the same protocol. */
export const AUTHORITY_HOSTS = [
  "login.microsoftonline.com",
  "login.microsoftonline.us",
  "login.partner.microsoftonline.cn"
] as const;

export type AuthorityHost = (typeof AUTHORITY_HOSTS)[number];

/**
 * How long before expiry an administrator should be warned (US-044).
 *
 * Thirty days because that is the sprint's exit criterion, and because it is
 * long enough to raise a change request against a directory the tenant's own IT
 * department controls — the rotation usually is not ours to perform.
 */
export const SECRET_EXPIRY_WARNING_DAYS = 30;

/**
 * A connection as every reader sees it.
 *
 * Note what is absent. There is no `clientSecret`, and `hasClientSecret` is the
 * substitute: a screen needs to know whether one is configured, which is a
 * different question from what it is.
 */
export interface ConnectionRecord {
  /** The environment id. A connection has no identity apart from its environment. */
  environmentId: string;
  environmentName: string;
  environmentKind: "production" | "sandbox";
  /** The D365 instance URL, e.g. `https://x.operations.eu.dynamics.com`. */
  url: string;
  entraTenantId: string | null;
  authorityHost: AuthorityHost;
  clientId: string | null;
  hasClientSecret: boolean;
  clientSecretUpdatedAt: Date | null;
  clientSecretExpiresAt: Date | null;
  state: ConnectionState;
  checkedAt: Date | null;
  error: ConnectionErrorCode | null;
}

interface ConnectionRow {
  id: string;
  tenant_id: string;
  name: string;
  kind: "production" | "sandbox";
  url: string;
  entra_tenant_id: string | null;
  entra_authority_host: AuthorityHost;
  client_id: string | null;
  client_secret_sealed: string | null;
  client_secret_updated_at: Date | null;
  client_secret_expires_at: Date | null;
  connection_state: ConnectionState;
  connection_checked_at: Date | null;
  connection_error: ConnectionErrorCode | null;
}

/**
 * Columns every read selects.
 *
 * `client_secret_sealed` is among them, and only so that `hasClientSecret` can
 * be answered — `toRecord` reduces it to a boolean and the sealed value never
 * leaves this module. Selecting `client_secret_sealed IS NOT NULL` instead would
 * be marginally tidier and would mean the sealed column had a second, separate
 * read path to keep honest.
 */
const CONNECTION_COLUMNS = `
  id, tenant_id, name, kind, url,
  entra_tenant_id, entra_authority_host, client_id,
  client_secret_sealed, client_secret_updated_at, client_secret_expires_at,
  connection_state, connection_checked_at, connection_error
`;

const toRecord = (row: ConnectionRow): ConnectionRecord => ({
  environmentId: row.id,
  environmentName: row.name,
  environmentKind: row.kind,
  url: row.url,
  entraTenantId: row.entra_tenant_id,
  authorityHost: row.entra_authority_host,
  clientId: row.client_id,
  hasClientSecret: row.client_secret_sealed !== null,
  clientSecretUpdatedAt: row.client_secret_updated_at,
  clientSecretExpiresAt: row.client_secret_expires_at,
  state: row.connection_state,
  checkedAt: row.connection_checked_at,
  error: row.connection_error
});

/**
 * The OAuth token endpoint for a connection.
 *
 * Assembled rather than stored. The stored form would be one text column holding
 * the URL the client secret gets presented to, which is precisely the field an
 * attacker with write access would edit — see the migration.
 */
export function tokenUrlFor(connection: {
  authorityHost: string;
  entraTenantId: string | null;
}): string | null {
  if (!connection.entraTenantId) return null;
  return `https://${connection.authorityHost}/${connection.entraTenantId}/oauth2/v2.0/token`;
}

/**
 * The scope a client-credentials token is requested with.
 *
 * Derived from the environment URL, because in D365 it is *always*
 * `<instance>/.default` — storing it separately would create two fields that can
 * disagree, and the disagreement fails at Entra as an unhelpful scope error.
 * `environment.ts` carried both, and they had to be kept in step by hand.
 */
export function scopeFor(url: string): string {
  return `${url.replace(/\/+$/, "")}/.default`;
}

/** Days until the secret expires; null when no expiry was recorded. */
export function daysUntilExpiry(
  expiresAt: Date | null,
  now: Date = new Date()
): number | null {
  if (!expiresAt) return null;
  return Math.floor((expiresAt.getTime() - now.getTime()) / 86_400_000);
}

/** True when the secret is expiring soon enough to warn about, or already has. */
export function secretNeedsAttention(
  expiresAt: Date | null,
  now: Date = new Date()
): boolean {
  const days = daysUntilExpiry(expiresAt, now);
  return days !== null && days <= SECRET_EXPIRY_WARNING_DAYS;
}

/** Every environment in the caller's tenant, configured or not. */
export async function listConnections(db: Queryable): Promise<ConnectionRecord[]> {
  const res = await db.query<ConnectionRow>(
    `SELECT ${CONNECTION_COLUMNS} FROM d365_environment ORDER BY name`
  );
  return res.rows.map(toRecord);
}

/**
 * One connection by environment id, or null when this tenant cannot see it.
 *
 * A malformed id is null rather than an error: Postgres rejects the uuid cast
 * with a 500, and a 500 against a 404 tells a caller their guess was at least
 * well-formed.
 */
export async function findConnection(
  db: Queryable,
  environmentId: string
): Promise<ConnectionRecord | null> {
  if (!isUuid(environmentId)) return null;

  const res = await db.query<ConnectionRow>(
    `SELECT ${CONNECTION_COLUMNS} FROM d365_environment WHERE id = $1`,
    [environmentId]
  );
  const row = res.rows[0];
  return row ? toRecord(row) : null;
}

/**
 * Everything needed to request a token, secret included.
 *
 * The one function that opens a sealed secret. It is not exported through the
 * package barrel with the others by accident: callers are the token client and
 * nothing else, and a `ConnectionRecord` is what every other consumer gets.
 *
 * Returns null when the connection is unconfigured *or* when the sealed value
 * does not open — a rotated `SECRET_ENCRYPTION_KEY`, a tampered column. Both
 * mean "there is no usable credential here", and failing closed is the only
 * safe reading of an unreadable credential.
 */
export interface ConnectionCredentials {
  environmentId: string;
  tokenUrl: string;
  scope: string;
  clientId: string;
  clientSecret: string;
}

export async function openClientSecret(
  db: Queryable,
  environmentId: string
): Promise<ConnectionCredentials | null> {
  if (!isUuid(environmentId)) return null;

  const res = await db.query<ConnectionRow>(
    `SELECT ${CONNECTION_COLUMNS} FROM d365_environment WHERE id = $1`,
    [environmentId]
  );
  const row = res.rows[0];
  if (!row?.client_id || !row.client_secret_sealed || !row.entra_tenant_id) {
    return null;
  }

  const clientSecret = openSecret("d365.clientSecret", row.client_secret_sealed);
  if (!clientSecret) return null;

  const tokenUrl = tokenUrlFor({
    authorityHost: row.entra_authority_host,
    entraTenantId: row.entra_tenant_id
  });
  if (!tokenUrl) return null;

  return {
    environmentId: row.id,
    tokenUrl,
    scope: scopeFor(row.url),
    clientId: row.client_id,
    clientSecret
  };
}

export interface SaveConnectionInput {
  entraTenantId: string;
  authorityHost?: AuthorityHost;
  clientId: string;
  /**
   * Omitted means "keep the secret already stored" (US-045).
   *
   * This is what makes the edit form usable at all. The screen cannot show the
   * current secret — nothing can — so a required field would force whoever is
   * changing the *expiry date* to re-type a credential they may not have, and
   * the predictable outcome is a placeholder typed into the field to get past
   * it.
   */
  clientSecret?: string;
  clientSecretExpiresAt?: Date | null;
}

/**
 * The credentials a save would use, without writing them.
 *
 * Test-before-save (US-042) needs to try the *incoming* configuration, which by
 * definition is not in the database yet. Resolving it here rather than in the
 * API keeps "omitted secret means the stored one" as a single rule, instead of
 * one the persistence layer and the test path each implement.
 *
 * Returns null when the input omits a secret and no stored one opens.
 */
export async function credentialsForSave(
  db: Queryable,
  environmentId: string,
  input: SaveConnectionInput
): Promise<ConnectionCredentials | null> {
  const existing = await findConnection(db, environmentId);
  if (!existing) return null;

  const clientSecret =
    input.clientSecret ?? (await openClientSecret(db, environmentId))?.clientSecret;
  if (!clientSecret) return null;

  const tokenUrl = tokenUrlFor({
    authorityHost: input.authorityHost ?? existing.authorityHost,
    entraTenantId: input.entraTenantId
  });
  if (!tokenUrl) return null;

  return {
    environmentId,
    tokenUrl,
    scope: scopeFor(existing.url),
    clientId: input.clientId,
    clientSecret
  };
}

/**
 * Writes a verified configuration.
 *
 * Deliberately does **not** test anything: the caller runs the live check first
 * and calls this only on success, because the check is an outbound HTTP request
 * and this package holds no HTTP client. What that buys is that "saved" and
 * "verified" cannot come apart — there is no path through this function that
 * stores an untested credential, so the sprint's exit criterion holds by
 * construction rather than by every caller remembering it.
 */
export async function saveConnection(
  db: Queryable,
  environmentId: string,
  input: SaveConnectionInput,
  actor: AuditActor
): Promise<ConnectionRecord | null> {
  const before = await findConnection(db, environmentId);
  if (!before) return null;

  const sealed = input.clientSecret ? sealSecret("d365.clientSecret", input.clientSecret) : null;

  const res = await db.query<ConnectionRow>(
    `UPDATE d365_environment
        SET entra_tenant_id = $2,
            entra_authority_host = coalesce($3, entra_authority_host),
            client_id = $4,
            -- COALESCE, not a conditional statement: an omitted secret keeps the
            -- stored one, which is the write-only rule expressed where it cannot
            -- be skipped by a caller assembling their own UPDATE.
            client_secret_sealed = coalesce($5, client_secret_sealed),
            client_secret_updated_at = CASE
              WHEN $5::text IS NULL THEN client_secret_updated_at ELSE now()
            END,
            client_secret_expires_at = $6,
            connection_state = 'connected',
            connection_checked_at = now(),
            connection_error = NULL,
            updated_at = now()
      WHERE id = $1
      RETURNING ${CONNECTION_COLUMNS}`,
    [
      environmentId,
      input.entraTenantId,
      input.authorityHost ?? null,
      input.clientId,
      sealed,
      input.clientSecretExpiresAt ?? null
    ]
  );

  const row = res.rows[0];
  if (!row) return null;
  const after = toRecord(row);

  await recordAuditEntry(db, {
    tenantId: row.tenant_id,
    action: "connection.updated",
    entityType: "d365_environment",
    entityId: environmentId,
    actor,
    /**
     * The secret appears here only as the timestamp of its last rotation.
     *
     * The obvious alternative — passing the value under a `clientSecret` key and
     * letting the audit redactor replace it with `[redacted]` — reads well and
     * records something false. Sealing is randomised, so the stored blob differs
     * on every write even when the credential is unchanged, and `changedFields`
     * would then report a rotation on every edit of the expiry date. The
     * timestamp changes exactly when the secret does, which is the fact the log
     * is being asked for.
     */
    before: {
      entraTenantId: before.entraTenantId,
      authorityHost: before.authorityHost,
      clientId: before.clientId,
      clientSecretUpdatedAt: before.clientSecretUpdatedAt,
      clientSecretExpiresAt: before.clientSecretExpiresAt
    },
    after: {
      entraTenantId: after.entraTenantId,
      authorityHost: after.authorityHost,
      clientId: after.clientId,
      clientSecretUpdatedAt: after.clientSecretUpdatedAt,
      clientSecretExpiresAt: after.clientSecretExpiresAt
    },
    context: { verified: true }
  });

  return after;
}

/** The outcome of a live check, as the persistence layer needs it. */
export type ConnectionCheck =
  | { ok: true }
  | { ok: false; error: ConnectionErrorCode };

/**
 * Records what a live check found.
 *
 * Separate from `saveConnection` because a check happens on its own too — the
 * *Test connection* button, and the scheduled sweep US-046 adds — and because a
 * failing check must never be able to alter a credential.
 */
export async function recordConnectionCheck(
  db: Queryable,
  environmentId: string,
  check: ConnectionCheck,
  actor: AuditActor
): Promise<ConnectionRecord | null> {
  const before = await findConnection(db, environmentId);
  if (!before) return null;

  // An unconfigured environment has nothing to check, and the schema forbids it
  // holding any state but `not_configured` — so this would fail the constraint
  // rather than record a meaningless result.
  if (!before.clientId) return before;

  const res = await db.query<ConnectionRow>(
    `UPDATE d365_environment
        SET connection_state = $2,
            connection_checked_at = now(),
            connection_error = $3,
            updated_at = now()
      WHERE id = $1
      RETURNING ${CONNECTION_COLUMNS}`,
    [environmentId, check.ok ? "connected" : "failing", check.ok ? null : check.error]
  );

  const row = res.rows[0];
  if (!row) return null;
  const after = toRecord(row);

  await recordAuditEntry(db, {
    tenantId: row.tenant_id,
    action: "connection.tested",
    entityType: "d365_environment",
    entityId: environmentId,
    actor,
    before: { state: before.state, error: before.error },
    after: { state: after.state, error: after.error }
  });

  return after;
}
