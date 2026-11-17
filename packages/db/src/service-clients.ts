import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { recordAuditEntry } from "./audit";
import { recordAuthEvent } from "./authentication";
import type { Queryable } from "./tenancy";

/**
 * Service clients: machine credentials for a scheduled job reading ERP data.
 *
 * The person-shaped credentials (password, MFA, single-use refresh tokens) are
 * wrong for a background sync: it cannot answer a second factor, and a refresh
 * token presented twice by two restarts of the same job revokes the session.
 * A service client is a client id plus a long random secret, exchanged at
 * `POST /auth/service-token` for a short-lived token whose audience no ordinary
 * route accepts. See the migration for why it is as narrow as it is.
 */

/** The only scope a service client can hold today (CHECK-enforced in the database). */
export const D365_DATA_READ_SCOPE = "d365.data.read";
export const SERVICE_CLIENT_SCOPES = [D365_DATA_READ_SCOPE] as const;
export type ServiceClientScope = (typeof SERVICE_CLIENT_SCOPES)[number];

/** The one message every failed exchange returns. Unknown, wrong and revoked look alike. */
export const INVALID_CLIENT_MESSAGE = "Invalid client credentials.";

const CLIENT_ID_PREFIX = "svc_";
const SECRET_BYTES = 32;

export function generateServiceClientId(): string {
  return CLIENT_ID_PREFIX + randomBytes(12).toString("base64url");
}

/** 256 bits. Returned once, stored only as a digest, never logged. */
export function generateServiceClientSecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

export function hashServiceClientSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export interface ServiceClientRecord {
  id: string;
  tenantId: string;
  name: string;
  clientId: string;
  scopes: string[];
  createdBy: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface CreatedServiceClient {
  client: ServiceClientRecord;
  /** The only time the secret exists outside the caller's hands. */
  clientSecret: string;
}

interface ClientRow {
  id: string;
  tenant_id: string;
  name: string;
  client_id: string;
  scopes: string[];
  created_by: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const CLIENT_COLUMNS =
  "id, tenant_id, name, client_id, scopes, created_by, created_at, last_used_at, revoked_at";

function toRecord(row: ClientRow): ServiceClientRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    clientId: row.client_id,
    scopes: row.scopes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at
  };
}

export interface CreateServiceClientInput {
  tenantId: string;
  name: string;
  scopes?: ServiceClientScope[];
  /** Who created it, for the audit entry (e.g. "cli:ops@host"). */
  actorLabel: string;
}

/** Creates a client and records `service_client.created`. Run inside a transaction. */
export async function createServiceClient(
  db: Queryable,
  input: CreateServiceClientInput
): Promise<CreatedServiceClient> {
  const name = input.name.trim();
  const scopes = input.scopes?.length ? input.scopes : [D365_DATA_READ_SCOPE];
  const clientSecret = generateServiceClientSecret();

  const res = await db.query<ClientRow>(
    `INSERT INTO service_client (tenant_id, name, client_id, secret_hash, scopes, created_by)
     VALUES ($1, $2, $3, $4, $5::text[], $6)
     RETURNING ${CLIENT_COLUMNS}`,
    [
      input.tenantId,
      name,
      generateServiceClientId(),
      hashServiceClientSecret(clientSecret),
      scopes,
      input.actorLabel
    ]
  );
  const client = toRecord(res.rows[0]);

  await recordAuditEntry(db, {
    tenantId: client.tenantId,
    action: "service_client.created",
    entityType: "service_client",
    entityId: client.id,
    actor: { label: input.actorLabel },
    after: { name: client.name, clientId: client.clientId, scopes: client.scopes }
  });

  return { client, clientSecret };
}

export interface RevokeServiceClientInput {
  clientId: string;
  reason: string;
  actorLabel: string;
}

/**
 * Revokes a client. Returns the record, or null if no live client has that id.
 * Tokens already issued stay valid until they expire (at most 15 minutes).
 */
export async function revokeServiceClient(
  db: Queryable,
  input: RevokeServiceClientInput
): Promise<ServiceClientRecord | null> {
  const res = await db.query<ClientRow>(
    `UPDATE service_client SET revoked_at = now(), revoked_reason = $2
     WHERE client_id = $1 AND revoked_at IS NULL
     RETURNING ${CLIENT_COLUMNS}`,
    [input.clientId, input.reason]
  );
  const row = res.rows[0];
  if (!row) return null;

  const client = toRecord(row);
  await recordAuditEntry(db, {
    tenantId: client.tenantId,
    action: "service_client.revoked",
    entityType: "service_client",
    entityId: client.id,
    actor: { label: input.actorLabel },
    context: { reason: input.reason }
  });
  return client;
}

export async function listServiceClients(
  db: Queryable,
  tenantId: string
): Promise<ServiceClientRecord[]> {
  const res = await db.query<ClientRow>(
    `SELECT ${CLIENT_COLUMNS} FROM service_client WHERE tenant_id = $1 ORDER BY created_at`,
    [tenantId]
  );
  return res.rows.map(toRecord);
}

export interface AuthenticatedServiceClient {
  /** The service_client row id; becomes the token subject. */
  id: string;
  clientId: string;
  name: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  scopes: string[];
}

export type ServiceClientAuthentication =
  | { ok: true; client: AuthenticatedServiceClient }
  | { ok: false };

export interface AuthenticateServiceClientInput {
  clientId: string;
  clientSecret: string;
  ip?: string | null;
  userAgent?: string | null;
}

interface CandidateRow {
  id: string;
  client_id: string;
  name: string;
  secret_hash: string;
  scopes: string[];
  revoked_at: Date | null;
  tenant_id: string;
  tenant_slug: string;
  tenant_name: string;
  tenant_deleted_at: Date | null;
}

/**
 * Checks a client id and secret, records the attempt in auth_event, and
 * returns the client on success. Returns rather than throws, so the caller's
 * transaction commits the failure record.
 */
export async function authenticateServiceClient(
  db: Queryable,
  input: AuthenticateServiceClientInput
): Promise<ServiceClientAuthentication> {
  const res = await db.query<CandidateRow>(
    `SELECT sc.id, sc.client_id, sc.name, sc.secret_hash, sc.scopes, sc.revoked_at,
            t.id AS tenant_id, t.slug AS tenant_slug, t.name AS tenant_name,
            t.deleted_at AS tenant_deleted_at
     FROM service_client sc
     JOIN tenant t ON t.id = sc.tenant_id
     WHERE sc.client_id = $1`,
    [input.clientId]
  );
  const row = res.rows[0];

  // Hash and compare even when the id is unknown, so timing does not reveal
  // which client ids exist.
  const presented = Buffer.from(hashServiceClientSecret(input.clientSecret), "hex");
  const expected = Buffer.from(row?.secret_hash ?? "0".repeat(64), "hex");
  const secretMatches =
    presented.length === expected.length && timingSafeEqual(presented, expected);

  const fail = async (reason: string): Promise<ServiceClientAuthentication> => {
    await recordAuthEvent(db, {
      tenantId: row?.tenant_id ?? null,
      event: "service_token.rejected",
      outcome: "failed",
      reason: `${reason} (client ${input.clientId.slice(0, 64)})`,
      ip: input.ip,
      userAgent: input.userAgent
    });
    return { ok: false };
  };

  if (!row) return fail("unknown client");
  if (!secretMatches) return fail("wrong secret");
  if (row.revoked_at) return fail("revoked client");
  if (row.tenant_deleted_at) return fail("tenant archived");

  await db.query("UPDATE service_client SET last_used_at = now() WHERE id = $1", [row.id]);
  await recordAuthEvent(db, {
    tenantId: row.tenant_id,
    event: "service_token.issued",
    outcome: "succeeded",
    reason: `client ${row.client_id}`,
    ip: input.ip,
    userAgent: input.userAgent
  });

  return {
    ok: true,
    client: {
      id: row.id,
      clientId: row.client_id,
      name: row.name,
      tenantId: row.tenant_id,
      tenantSlug: row.tenant_slug,
      tenantName: row.tenant_name,
      scopes: row.scopes
    }
  };
}
