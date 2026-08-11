import type { Queryable } from "./tenancy";

/** Placeholder written in place of any secret value. */
export const REDACTED = "[redacted]";

/**
 * Field names whose values must never reach the audit log. Matched on the key,
 * not the value: guessing at whether a string "looks like" a token is how
 * secrets get missed.
 */
const SECRET_KEY =
  /(secret|password|passwd|token|credential|api[-_]?key|authorization|cookie|private[-_]?key|connection[-_]?string)/i;

export type AuditValues = Record<string, unknown>;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

function isPlainObject(value: unknown): value is AuditValues {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactObject(values: AuditValues): AuditValues {
  const out: AuditValues = {};
  for (const [key, value] of Object.entries(values)) {
    if (isSecretKey(key)) {
      out[key] = REDACTED;
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) => (isPlainObject(item) ? redactObject(item) : item));
    } else if (isPlainObject(value)) {
      out[key] = redactObject(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Replaces every secret value with {@link REDACTED}, recursively. */
export function redactValues(values: AuditValues | null | undefined): AuditValues | null {
  if (!values) {
    return null;
  }
  return redactObject(values);
}

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
