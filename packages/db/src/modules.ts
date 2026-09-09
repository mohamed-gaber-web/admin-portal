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

/**
 * Mirrors the contract's `MODULE_KEYS`, and the migration's catalogue.
 *
 * The mobile app's navigation groups, one for one — see
 * `1730000016000_mobile-module-catalogue.js` for why the four invented
 * placeholders that used to be here were replaced.
 */
export type ModuleKey =
  | "inventory"
  | "purchase-order"
  | "sales-order"
  | "return-order"
  | "project"
  | "production"
  | "warehouse"
  | "inquiry"
  | "van-sales"
  | "route-tracking"
  | "trade-payments"
  | "performance"
  | "distribution";

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

/**
 * The reserved tenant that installation-wide audit entries are filed against.
 *
 * A local copy of `PLATFORM_TENANT_SLUG` from `platform.ts` rather than an
 * import, to avoid closing the cycle `modules → platform → invitations →
 * modules`. Two string literals is the smaller cost, and the contract test that
 * already pins the slug covers both.
 */
const PLATFORM_TENANT_SLUG_FOR_AUDIT = "platform";

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

/**
 * Grants a set of modules to a tenant that is being created, in the caller's
 * transaction.
 *
 * Separate from `setTenantModules`, and the difference is the audit entry.
 * `setTenantModules` writes `tenant.modules_changed` with a before and an
 * after, which is right for an edit and wrong here: nothing changed, and a log
 * line claiming a tenant's entitlements were altered seconds after it came into
 * existence reads as an edit somebody made. Provisioning records the grant as
 * context on `tenant.provisioned` instead — the same treatment the default
 * roles and permissions already get.
 *
 * Takes no `before` read and does no revoking, because a tenant one statement
 * old holds nothing there could be a before of.
 *
 * Returns the keys actually granted, which is the intersection of what was
 * asked for and what the catalogue contains. Unknown keys are dropped rather
 * than refused, matching `setTenantModules`: they can only come from a client
 * built against a newer catalogue, and failing provisioning over one would mean
 * a tenant cannot be created at all until every deployed portal agrees with the
 * database.
 */
export async function grantTenantModules(
  db: Queryable,
  input: { tenantId: string; keys: readonly string[] }
): Promise<string[]> {
  const wanted = [...new Set(input.keys)];
  if (wanted.length === 0) return [];

  const res = await db.query<{ key: string }>(
    `INSERT INTO tenant_module (tenant_id, module_id)
     SELECT $1, m.id FROM module m WHERE m.key = ANY($2::text[])
     -- A no-op update rather than DO NOTHING, so the RETURNING clause below
     -- reports every requested key the catalogue knows rather than only the
     -- ones this statement inserted. With DO NOTHING, topping up a tenant that
     -- already held one of them would return it missing, and a caller cannot
     -- tell "you already had it" from "that module does not exist" — which is
     -- the one question this return value is here to answer.
     --
     -- enabled_at is deliberately not in the SET: re-granting something a
     -- tenant already holds must not move the date it was first granted, which
     -- is what the column is read for.
     ON CONFLICT (tenant_id, module_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
     RETURNING (SELECT key FROM module WHERE id = module_id)`,
    [input.tenantId, wanted]
  );

  return res.rows.map((row) => row.key).sort();
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

// ── The contract period ────────────────────────────────────────────────────

export interface SetTenantContractInput {
  tenantId: string;
  /** `YYYY-MM-DD`, or null to clear. */
  startDate: string | null;
  endDate: string | null;
  actor: AuditActor;
}

export interface TenantContract {
  startDate: string | null;
  endDate: string | null;
}

/**
 * Records the period a tenant's contract runs for.
 *
 * Both dates are written together and either may be null, which is what makes
 * this a replace rather than a patch: sending one and omitting the other would
 * make "clear the end date" indistinguishable from "leave it alone", and an
 * operator fixing a start date would silently carry over whatever end date
 * their stale form held.
 *
 * Overwrites rather than versioning. There is no history of previous terms here
 * — that belongs to the subscription model this is deliberately not (US-070/071)
 * — so the audit entry is where a superseded term survives, and it carries both
 * dates on both sides so a renewal can be read back in full.
 *
 * Enforces nothing. A tenant whose end date has passed keeps working; expiry is
 * displayed and what to do about it stays a decision on the lifecycle card.
 * Locking a customer out of their own data on a date is a harsher act than
 * declining to renew them, and this function does not quietly perform it.
 *
 * Returns null for an unknown tenant, and `changed: false` when the stored
 * dates already match — so a retried request writes no second audit entry.
 */
export async function setTenantContract(
  db: Queryable,
  input: SetTenantContractInput
): Promise<{ contract: TenantContract; changed: boolean } | null> {
  if (!isUuid(input.tenantId)) return null;

  /*
   * Guarded here as well as by `tenant_contract_period_ordered`. The constraint
   * stays the authority — it holds against anything that reaches the table —
   * and this exists so a caller gets a refusal naming the problem rather than a
   * driver error carrying a constraint name.
   *
   * String comparison is date comparison for ISO-8601, which is why the column
   * is read and written in that form throughout.
   */
  if (
    input.startDate !== null &&
    input.endDate !== null &&
    input.endDate < input.startDate
  ) {
    throw new ContractPeriodInvalidError(input.startDate, input.endDate);
  }

  const existing = await db.query<{ start_date: string | null; end_date: string | null }>(
    `SELECT to_char(contract_start_date, 'YYYY-MM-DD') AS start_date,
            to_char(contract_end_date, 'YYYY-MM-DD') AS end_date
       FROM tenant WHERE id = $1`,
    [input.tenantId]
  );
  const current = existing.rows[0];
  if (!current) return null;

  const before: TenantContract = { startDate: current.start_date, endDate: current.end_date };
  const after: TenantContract = { startDate: input.startDate, endDate: input.endDate };

  if (before.startDate === after.startDate && before.endDate === after.endDate) {
    return { contract: before, changed: false };
  }

  await db.query(
    `UPDATE tenant
        SET contract_start_date = $2::date,
            contract_end_date = $3::date,
            updated_at = now()
      WHERE id = $1`,
    [input.tenantId, input.startDate, input.endDate]
  );

  await recordAuditEntry(db, {
    tenantId: input.tenantId,
    action: "tenant.contract_changed",
    entityType: "tenant",
    entityId: input.tenantId,
    actor: input.actor,
    before: { ...before },
    after: { ...after }
  });

  return { contract: after, changed: true };
}

/** Raised when a contract would end before it starts. */
export class ContractPeriodInvalidError extends Error {
  constructor(
    readonly startDate: string,
    readonly endDate: string
  ) {
    super(`A contract cannot end on ${endDate}, before it starts on ${startDate}.`);
    this.name = "ContractPeriodInvalidError";
  }
}

// ── Packages and their seat allowances ─────────────────────────────────────

/**
 * One package on offer, and how many users it includes.
 *
 * Read from the `plan` table rather than held as a constant, so an installation
 * can raise an allowance with an `UPDATE` instead of a release — and so the
 * enforcement in `assertSeatAvailable` and the number the portal renders are the
 * same number rather than two that can drift.
 */
export interface PlanRecord {
  key: TenantPlan;
  description: string;
  userLimit: number;
  /**
   * Tenants currently holding this package.
   *
   * So the screen that edits `userLimit` can say how many customers a change
   * reaches before it is made. Lowering a package's allowance silently stops
   * hiring for every tenant on it that has no negotiated figure, and that is not
   * a decision to make without the number in front of you.
   */
  tenantCount: number;
}

interface PlanRow {
  key: TenantPlan;
  description: string;
  user_limit: string;
  tenant_count: string;
}

/**
 * The whole catalogue, in display order.
 *
 * Global data — `plan` has no `tenant_id` and no row level security — so this is
 * safe to call from a tenant-scoped session as well as an unscoped one. The
 * tenant-facing screens do not use it yet, but the seat check does, and that
 * runs inside whatever session the invitation is being issued from.
 */
export async function listPlans(db: Queryable): Promise<PlanRecord[]> {
  const res = await db.query<PlanRow>(
    `SELECT p.key, p.description, p.user_limit,
            -- A correlated subquery rather than a join and a GROUP BY: the
            -- catalogue is four rows, and a join here would have to be an outer
            -- one to keep a package nobody holds in the list at all.
            (SELECT count(*) FROM tenant t WHERE t.plan = p.key) AS tenant_count
       FROM plan p
      ORDER BY p.sort_order, p.key`
  );

  // `user_limit` arrives as a string from an integer column via node-postgres'
  // default parsing for some types; Number() is cheap insurance either way.
  return res.rows.map((row) => ({
    key: row.key,
    description: row.description,
    userLimit: Number(row.user_limit),
    tenantCount: Number(row.tenant_count)
  }));
}

/** How many seats a tenant's package includes, and how many are taken. */
export interface SeatUsage {
  plan: TenantPlan;
  used: number;
  limit: number;
}

/**
 * Raised when a tenant's package has no seat left for another user.
 *
 * Carries the numbers rather than only a message, so the API can render "25 of
 * 25 seats are in use" without parsing its own error string — and so the portal
 * can tell an administrator whether they are one seat short or twenty.
 */
export class SeatLimitReachedError extends Error {
  constructor(readonly usage: SeatUsage) {
    super(
      `This tenant's ${usage.plan} package includes ${usage.limit} user${
        usage.limit === 1 ? "" : "s"
      }, and all ${usage.limit} are in use. Move the tenant to a larger package to add more.`
    );
    this.name = "SeatLimitReachedError";
  }
}

/**
 * Seats used and included, for one tenant.
 *
 * One query, joined rather than two reads, so the count and the allowance come
 * from the same snapshot. Every user row counts, whatever their status: an
 * invited user who has not accepted yet is holding the seat their invitation
 * promised, and a suspended one still occupies a place their administrator can
 * restore without asking anybody. Only deleting a user frees a seat, which is
 * the rule that makes the number on screen match the row count beneath it.
 *
 * Returns null for an unknown tenant, including a malformed id.
 */
export async function findSeatUsage(
  db: Queryable,
  tenantId: string
): Promise<SeatUsage | null> {
  if (!isUuid(tenantId)) return null;

  const res = await db.query<{ plan: TenantPlan; used: string; user_limit: string }>(
    `SELECT t.plan,
            -- The tenant's negotiated figure when it has one, else its
            -- package's. The same expression the read screens use, so what an
            -- operator is shown and what the check enforces cannot disagree.
            coalesce(t.seat_limit, p.user_limit) AS user_limit,
            (SELECT count(*) FROM "user" u WHERE u.tenant_id = t.id) AS used
       FROM tenant t
       JOIN plan p ON p.key = t.plan
      WHERE t.id = $1`,
    [tenantId]
  );

  const row = res.rows[0];
  if (!row) return null;

  return {
    plan: row.plan,
    used: Number(row.used),
    limit: Number(row.user_limit)
  };
}

/**
 * Refuses when the tenant has no seat left for one more user.
 *
 * Called immediately before a user row is inserted, inside the same transaction,
 * which is what makes it hold: two administrators inviting the last seat
 * simultaneously both read `used = 24` only if neither has committed, and the
 * second one's insert then happens after the first's commit — where its own
 * count sees 25. Postgres' default READ COMMITTED gives each statement a fresh
 * snapshot, so the loser sees the winner's row.
 *
 * That is a check, not a lock, and the distinction is worth stating: it can be
 * beaten by two transactions that both start and commit inside the same instant.
 * The consequence is one seat of overshoot on a package boundary, which is the
 * right thing to trade a row lock on every invitation for. A hard guarantee
 * belongs with the real subscription model, where a seat is a row that can be
 * held.
 *
 * Does nothing for an unknown tenant — the insert that follows will fail on the
 * foreign key, and reporting "no seats" for a tenant that does not exist would
 * be a worse message than the one that failure produces.
 */
export async function assertSeatAvailable(db: Queryable, tenantId: string): Promise<void> {
  const usage = await findSeatUsage(db, tenantId);
  if (!usage) return;
  if (usage.used >= usage.limit) {
    throw new SeatLimitReachedError(usage);
  }
}


/**
 * Sets or clears a tenant's negotiated seat allowance.
 *
 * `null` clears it, putting the tenant back onto its package's number — which
 * is a real operation an operator performs, not an absent argument, so it is
 * spelled as a value rather than as an omission.
 *
 * Deliberately does *not* refuse a figure below the tenant's current headcount.
 * Cutting an allowance under what a customer already uses is a thing operators
 * mean to do — at renewal, before a contraction — and the consequence is
 * bounded and reversible: nobody is deleted and nobody is signed out, the tenant
 * simply cannot invite anyone until it is back within the allowance. Refusing it
 * would mean an operator had to remove people from a customer's tenant before
 * they could record what the customer had agreed to pay for.
 *
 * Returns null for an unknown tenant, and `changed: false` when the stored value
 * already matches — so a retried request writes no second audit entry.
 */
export async function setTenantSeatLimit(
  db: Queryable,
  input: { tenantId: string; seatLimit: number | null; actor: AuditActor }
): Promise<{ seatLimit: number | null; changed: boolean } | null> {
  if (!isUuid(input.tenantId)) return null;

  const existing = await db.query<{ seat_limit: number | null }>(
    "SELECT seat_limit FROM tenant WHERE id = $1",
    [input.tenantId]
  );
  const current = existing.rows[0];
  if (!current) return null;

  const before = current.seat_limit === null ? null : Number(current.seat_limit);
  if (before === input.seatLimit) {
    return { seatLimit: before, changed: false };
  }

  await db.query("UPDATE tenant SET seat_limit = $2, updated_at = now() WHERE id = $1", [
    input.tenantId,
    input.seatLimit
  ]);

  await recordAuditEntry(db, {
    tenantId: input.tenantId,
    action: "tenant.seats_changed",
    entityType: "tenant",
    entityId: input.tenantId,
    actor: input.actor,
    // Null travels as null rather than as the package's number, so the log
    // records what was decided — "put them back on their plan" — rather than
    // whatever that plan happened to include on the day.
    before: { seatLimit: before },
    after: { seatLimit: input.seatLimit }
  });

  return { seatLimit: input.seatLimit, changed: true };
}

/**
 * Changes how many users a package includes.
 *
 * This is the lever that moves every tenant on the package at once. A tenant
 * that has been given its own figure is deliberately unaffected — that is the
 * whole reason `tenant.seat_limit` is nullable — so the reach of a change here
 * is "every tenant on this package that has not negotiated", which is why
 * `listPlans` carries a count for the screen to show first.
 *
 * Takes effect on the next read and no later: the effective allowance is
 * `coalesce(t.seat_limit, p.user_limit)` computed at every read, so there is no
 * cache to invalidate and no tenant row to rewrite. A package raised from 25 to
 * 30 admits the twenty-sixth user immediately.
 *
 * Refuses nothing except an unknown key and a non-positive figure — the same
 * two things the table refuses. In particular it does *not* refuse a number
 * below what tenants on the package are already using, matching
 * `setTenantSeatLimit`: nobody is removed and nobody is signed out, those
 * tenants simply cannot grow until they are back within it. An operator
 * correcting a package that was set too high needs that to be possible.
 *
 * Returns null for a key that is not in the catalogue, and `changed: false` when
 * the stored number already matches — so a retried request writes no second
 * audit entry.
 */
export async function setPlanUserLimit(
  db: Queryable,
  input: { key: string; userLimit: number; actor: AuditActor }
): Promise<{ key: TenantPlan; userLimit: number; changed: boolean } | null> {
  /*
   * Guarded here as well as by the check constraint, so the caller gets null
   * rather than a constraint violation for a number the API layer should have
   * rejected. The constraint stays the authority; this is the better message.
   */
  if (!Number.isInteger(input.userLimit) || input.userLimit < 1) {
    return null;
  }

  const existing = await db.query<{ key: TenantPlan; user_limit: string }>(
    "SELECT key, user_limit FROM plan WHERE key = $1",
    [input.key]
  );
  const current = existing.rows[0];
  if (!current) return null;

  const before = Number(current.user_limit);
  if (before === input.userLimit) {
    return { key: current.key, userLimit: before, changed: false };
  }

  await db.query("UPDATE plan SET user_limit = $2 WHERE key = $1", [
    input.key,
    input.userLimit
  ]);

  /**
   * Attributed to the platform tenant, because `audit_log.tenant_id` is NOT NULL
   * and the thing that changed belongs to no tenant. That is the same
   * convention `ensurePlatformAdmin` already uses for the other global act in
   * this system, and it is the right one: the platform tenant's own log is where
   * installation-wide decisions are read back from.
   *
   * Looked up by slug inline rather than through `findPlatformTenant`, which
   * lives in `platform.ts` — importing it here would close the cycle
   * `modules → platform → invitations → modules`, since invitations already
   * reaches back into this module for the seat check.
   *
   * If the platform tenant is somehow absent the update still stands and the
   * entry is skipped rather than the whole call failing. An installation with no
   * platform tenant has no operator who could have made this request in the
   * first place, so this is unreachable rather than tolerated.
   */
  const platform = await db.query<{ id: string }>(
    "SELECT id FROM tenant WHERE slug = $1",
    [PLATFORM_TENANT_SLUG_FOR_AUDIT]
  );
  const platformTenantId = platform.rows[0]?.id;

  if (platformTenantId) {
    await recordAuditEntry(db, {
      tenantId: platformTenantId,
      action: "plan.seats_changed",
      entityType: "plan",
      entityId: input.key,
      actor: input.actor,
      before: { key: input.key, userLimit: before },
      after: { key: input.key, userLimit: input.userLimit }
    });
  }

  return { key: current.key, userLimit: input.userLimit, changed: true };
}
