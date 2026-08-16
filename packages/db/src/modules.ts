import { recordAuditEntry, type AuditActor } from "./audit";
import { isUuid } from "./tenant-administration";
import type { Queryable } from "./tenancy";

/**
 * Module entitlements and plan administration (US-072).
 *
 * Two related questions an operator answers about a customer: which plan they
 * are on, and which functional modules they may use. Kept in one module because
 * the screens that edit them are one screen, and because both write the same
 * shape of audit entry against the tenant they act on.
 *
 * Everything here is platform-level and spans tenants, so it runs unscoped —
 * the API reaches it through `withoutTenantScope`, which records the bypass with
 * the request's correlation ID. The one exception is `listTenantModules` when a
 * tenant reads its *own* entitlements: that runs scoped, and the row level
 * security policy on `tenant_module` is what makes it safe to call with no
 * `tenant_id` filter of its own.
 */

/** Mirrors the contract's `MODULE_KEYS`, and the migration's catalogue. */
export type ModuleKey = "van-sales" | "warehouse" | "field-service" | "analytics";

export type TenantPlan = "trial" | "starter" | "growth" | "enterprise";

/**
 * The plan an unsubscribed tenant returns to.
 *
 * `trial` rather than a fifth "none" value, which would have meant widening the
 * check constraint that has guarded this column since the tenant-administration
 * migration. The distinction a real subscription model needs — never subscribed
 * versus cancelled — lives in the audit log, which records `tenant.unsubscribed`
 * with the plan that was cancelled. When US-070 lands with a genuine
 * subscription table, that history is what it will be reconstructed from.
 */
export const UNSUBSCRIBED_PLAN: TenantPlan = "trial";

export interface ModuleRecord {
  id: string;
  key: string;
  description: string;
  /** Null when the tenant does not hold it. Otherwise when it was granted. */
  enabledAt: Date | null;
}

interface ModuleRow {
  id: string;
  key: string;
  description: string;
  enabled_at: Date | null;
}

/**
 * The whole catalogue, with each module marked held or not for one tenant.
 *
 * A LEFT JOIN rather than two queries intersected in application code: the
 * screen renders every module with a toggle, so "the catalogue" and "what this
 * tenant holds" are one answer, and assembling it here means the two cannot
 * disagree about which modules exist.
 */
export async function listTenantModules(
  db: Queryable,
  tenantId: string
): Promise<ModuleRecord[]> {
  if (!isUuid(tenantId)) return [];

  const res = await db.query<ModuleRow>(
    `SELECT m.id, m.key, m.description, tm.enabled_at
       FROM module m
       LEFT JOIN tenant_module tm ON tm.module_id = m.id AND tm.tenant_id = $1
      ORDER BY m.sort_order, m.key`,
    [tenantId]
  );

  return res.rows.map((row) => ({
    id: row.id,
    key: row.key,
    description: row.description,
    enabledAt: row.enabled_at
  }));
}

/**
 * The catalogue, marked for **whichever tenant the session is scoped to**.
 *
 * Deliberately takes no `tenantId`. The README's rule is that application code
 * does not choose a tenant — a parameter can be fed from a header, and if a
 * header can set the tenant then someone will iterate it. Run inside
 * `withRequestTenantScope`, the LEFT JOIN below sees only the caller's own
 * `tenant_module` rows because the policy filters them, so the marking is
 * correct without anything here naming a tenant.
 *
 * With no tenant context set, `current_tenant_id()` returns NULL, the join
 * matches nothing, and every module comes back unheld. That is the safe
 * failure: "you are entitled to nothing" rather than "you are entitled to
 * everything".
 */
export async function listOwnModules(db: Queryable): Promise<ModuleRecord[]> {
  const res = await db.query<ModuleRow>(
    `SELECT m.id, m.key, m.description, tm.enabled_at
       FROM module m
       LEFT JOIN tenant_module tm ON tm.module_id = m.id
      ORDER BY m.sort_order, m.key`
  );

  return res.rows.map((row) => ({
    id: row.id,
    key: row.key,
    description: row.description,
    enabledAt: row.enabled_at
  }));
}

export interface SetTenantModulesInput {
  tenantId: string;
  /** The complete set the tenant should hold afterwards. */
  keys: readonly string[];
  actor: AuditActor;
}

/**
 * Replaces the set of modules a tenant holds.
 *
 * The whole set rather than one grant at a time, matching how role permissions
 * are edited: a screen full of toggles submits a state, and turning that into a
 * sequence of grant/revoke calls would make a half-applied set the normal
 * outcome of a dropped connection.
 *
 * Unknown keys are ignored rather than rejected. They can only come from a
 * client built against a newer catalogue, and failing the whole request would
 * mean an operator cannot change *anything* about a tenant until every deployed
 * portal agrees with the database.
 *
 * Returns null when the tenant does not exist, so the caller can 404 rather than
 * silently succeeding at nothing.
 */
export async function setTenantModules(
  db: Queryable,
  input: SetTenantModulesInput
): Promise<ModuleRecord[] | null> {
  if (!isUuid(input.tenantId)) return null;

  const tenant = await db.query<{ id: string }>("SELECT id FROM tenant WHERE id = $1", [
    input.tenantId
  ]);
  if (!tenant.rows[0]) return null;

  const before = await listTenantModules(db, input.tenantId);
  const wanted = [...new Set(input.keys)];

  // Revoke first, then grant. The order does not matter for correctness — both
  // run in the caller's transaction — but doing it this way means the unique
  // constraint is never the thing that stops a re-grant of something being
  // revoked in the same request.
  await db.query(
    `DELETE FROM tenant_module tm
      USING module m
      WHERE tm.module_id = m.id
        AND tm.tenant_id = $1
        AND NOT (m.key = ANY($2::text[]))`,
    [input.tenantId, wanted]
  );

  await db.query(
    `INSERT INTO tenant_module (tenant_id, module_id)
     SELECT $1, m.id FROM module m WHERE m.key = ANY($2::text[])
     ON CONFLICT (tenant_id, module_id) DO NOTHING`,
    [input.tenantId, wanted]
  );

  const after = await listTenantModules(db, input.tenantId);

  const held = (modules: ModuleRecord[]): string[] =>
    modules
      .filter((module) => module.enabledAt !== null)
      .map((module) => module.key)
      .sort();

  const heldBefore = held(before);
  const heldAfter = held(after);

  // Only when something actually moved. A re-submitted form that changes
  // nothing should not add a line to the log claiming a tenant's entitlements
  // were altered — the log is read to answer "who changed this, and when".
  if (heldBefore.join(",") !== heldAfter.join(",")) {
    await recordAuditEntry(db, {
      tenantId: input.tenantId,
      action: "tenant.modules_changed",
      entityType: "tenant",
      entityId: input.tenantId,
      actor: input.actor,
      before: { modules: heldBefore },
      after: { modules: heldAfter }
    });
  }

  return after;
}

export interface SetTenantPlanInput {
  tenantId: string;
  plan: TenantPlan;
  actor: AuditActor;
  /**
   * True when this is a cancellation rather than a move between plans.
   *
   * Changes only the audit action written — `tenant.unsubscribed` instead of
   * `tenant.plan_changed`. The column ends up the same either way, and that is
   * exactly why the distinction has to be recorded: without it, a cancellation
   * and a downgrade to trial are indistinguishable afterwards, and only one of
   * them means the customer left.
   */
  unsubscribe?: boolean;
}

/**
 * Moves a tenant to a plan, and records which kind of move it was.
 *
 * Idempotent: setting the plan a tenant is already on matches no row and writes
 * no audit entry, so a retried request is not a second change.
 *
 * Returns null when the tenant does not exist. Returns the plan unchanged when
 * it was already that plan, which the caller cannot distinguish from a change —
 * and does not need to, because the state afterwards is what it asked for.
 */
export async function setTenantPlan(
  db: Queryable,
  input: SetTenantPlanInput
): Promise<{ plan: TenantPlan; changed: boolean } | null> {
  if (!isUuid(input.tenantId)) return null;

  const existing = await db.query<{ plan: TenantPlan }>(
    "SELECT plan FROM tenant WHERE id = $1",
    [input.tenantId]
  );
  const current = existing.rows[0];
  if (!current) return null;

  if (current.plan === input.plan) {
    return { plan: current.plan, changed: false };
  }

  await db.query(`UPDATE tenant SET plan = $2, updated_at = now() WHERE id = $1`, [
    input.tenantId,
    input.plan
  ]);

  /**
   * Two calls rather than one with a computed action.
   *
   * The audit guard (US-015) reads action names statically, so a ternary in the
   * `action` field is an action it cannot track — and an action it cannot track
   * is one nothing can prove is still being written. Repeating the entry is the
   * cost of the guard being able to check it, which is a good trade: this is
   * the log that says why a customer stopped having what they paid for.
   */
  const entry = {
    tenantId: input.tenantId,
    entityType: "tenant",
    entityId: input.tenantId,
    actor: input.actor,
    before: { plan: current.plan },
    after: { plan: input.plan }
  };

  if (input.unsubscribe) {
    await recordAuditEntry(db, {
      ...entry,
      action: "tenant.unsubscribed"
    });
  } else {
    await recordAuditEntry(db, {
      ...entry,
      action: "tenant.plan_changed"
    });
  }

  return { plan: input.plan, changed: true };
}
