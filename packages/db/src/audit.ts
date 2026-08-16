import { isSecretKey, redactValues, REDACTED, type RedactableValues } from "@growpath/observability";
import {
  likeArgument,
  limitOffset,
  toPage,
  type PageRequest,
  type PagedResult,
  type RowWithTotal
} from "./paging";
import type { Queryable } from "./tenancy";

/**
 * Redaction is shared with the logger (US-007) rather than reimplemented here:
 * the audit log and the log file must agree on what counts as a secret, and two
 * copies of that rule is one copy that gets updated.
 */
export { isSecretKey, redactValues, REDACTED };

export type AuditValues = RedactableValues;

/**
 * Names the fields that differ between two states.
 *
 * Computed from the raw values *before* redaction, which is what lets a secret
 * field record that it changed without recording what it changed to.
 */
export function changedFields(
  before: AuditValues | null | undefined,
  after: AuditValues | null | undefined
): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changed: string[] = [];
  for (const key of keys) {
    const from = JSON.stringify(before?.[key] ?? null);
    const to = JSON.stringify(after?.[key] ?? null);
    if (from !== to) {
      changed.push(key);
    }
  }
  return changed.sort();
}

export interface AuditActor {
  /** Who acted. Required — an entry without an actor answers nothing. */
  label: string;
  /** The acting user, when there is a user row for them. */
  userId?: string | null;
  /** Client IP, when the change arrived over the network. */
  ip?: string | null;
}

export interface RecordAuditEntryInput {
  tenantId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  actor: AuditActor;
  before?: AuditValues | null;
  after?: AuditValues | null;
  /** Extra context; redacted on the same terms as before/after. */
  context?: AuditValues | null;
}

export interface AuditEntry {
  id: string;
  tenantId: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorLabel: string;
  actorUserId: string | null;
  actorIp: string | null;
  beforeValues: AuditValues | null;
  afterValues: AuditValues | null;
  changedFields: string[];
  createdAt: Date;
}

interface AuditRow {
  id: string;
  tenant_id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  actor_label: string;
  user_id: string | null;
  actor_ip: string | null;
  before_values: AuditValues | null;
  after_values: AuditValues | null;
  changed_fields: string[] | null;
  created_at: Date;
}

const toEntry = (row: AuditRow): AuditEntry => ({
  id: row.id,
  tenantId: row.tenant_id,
  action: row.action,
  entityType: row.entity_type,
  entityId: row.entity_id,
  actorLabel: row.actor_label,
  actorUserId: row.user_id,
  actorIp: row.actor_ip,
  beforeValues: row.before_values,
  afterValues: row.after_values,
  changedFields: row.changed_fields ?? [],
  createdAt: row.created_at
});

/**
 * Appends one audit entry.
 *
 * Secret values are stripped before the row is written, so a redaction bug
 * cannot be repaired after the fact — the entry is immutable by then.
 */
export async function recordAuditEntry(
  db: Queryable,
  input: RecordAuditEntryInput
): Promise<AuditEntry> {
  if (!input.actor.label.trim()) {
    throw new Error("audit entries require a non-empty actor label");
  }

  // Diff first, redact second: the order is the whole of AC3.
  const changed = changedFields(input.before, input.after);

  const res = await db.query<AuditRow>(
    `INSERT INTO audit_log (
       tenant_id, user_id, actor_label, actor_ip, action, entity_type, entity_id,
       before_values, after_values, changed_fields, data
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::text[], $11::jsonb)
     RETURNING id, tenant_id, user_id, actor_label, actor_ip, action, entity_type,
               entity_id, before_values, after_values, changed_fields, created_at`,
    [
      input.tenantId,
      input.actor.userId ?? null,
      input.actor.label,
      input.actor.ip ?? null,
      input.action,
      input.entityType,
      input.entityId ?? null,
      JSON.stringify(redactValues(input.before)),
      JSON.stringify(redactValues(input.after)),
      changed,
      JSON.stringify(redactValues(input.context))
    ]
  );

  return toEntry(res.rows[0]);
}

/** Reads a tenant's audit trail, newest last. */
export async function listAuditEntries(db: Queryable, tenantId: string): Promise<AuditEntry[]> {
  const res = await db.query<AuditRow>(
    `SELECT id, tenant_id, user_id, actor_label, actor_ip, action, entity_type,
            entity_id, before_values, after_values, changed_fields, created_at
     FROM audit_log WHERE tenant_id = $1 ORDER BY created_at, id`,
    [tenantId]
  );
  return res.rows.map(toEntry);
}

/**
 * One page of the caller's tenant's audit trail, newest first.
 *
 * Newest first, unlike `listAuditEntries` — that one is read by tests that
 * assert on a sequence of events, where chronological order is what makes the
 * assertion readable. A feed is read from the top.
 */
export async function listAuditPage(
  db: Queryable,
  request: PageRequest
): Promise<PagedResult<AuditEntry>> {
  const like = likeArgument(request.search);
  const { limit, offset } = limitOffset(request);

  const res = await db.query<AuditRow & RowWithTotal>(
    `SELECT id, tenant_id, user_id, actor_label, actor_ip, action, entity_type,
            entity_id, before_values, after_values, changed_fields, created_at,
            count(*) OVER () AS total_count
     FROM audit_log
     WHERE ($1::text IS NULL
            OR action ILIKE $1 ESCAPE '\\'
            OR actor_label ILIKE $1 ESCAPE '\\'
            OR coalesce(entity_id, '') ILIKE $1 ESCAPE '\\')
     ORDER BY created_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    [like, limit, offset]
  );

  return toPage(res.rows, request, toEntry);
}

/** Every audit entry for one tenant, newest first. Used by the tenant detail screen. */
export async function listAuditEntriesForTenant(
  db: Queryable,
  tenantId: string,
  limit = 20
): Promise<AuditEntry[]> {
  const res = await db.query<AuditRow>(
    `SELECT id, tenant_id, user_id, actor_label, actor_ip, action, entity_type,
            entity_id, before_values, after_values, changed_fields, created_at
     FROM audit_log WHERE tenant_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [tenantId, limit]
  );
  return res.rows.map(toEntry);
}
