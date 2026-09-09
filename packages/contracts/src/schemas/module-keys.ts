import { z } from "zod";

/**
 * The module catalogue: the functional areas a tenant can be entitled to.
 *
 * ### Why this is its own file
 *
 * `tenant.ts` needs these keys and the schema over them — provisioning accepts
 * a starting set — and
 * `module.ts` needs `tenantPlanSchema` from `tenant.ts`. Importing across both
 * directions closes a cycle, and a cycle between two files that build Zod
 * schemas at module scope is not the benign kind: whichever loads second sees
 * the other half-initialised, and `z.enum(undefined)` throws at import time
 * rather than failing a test. Keys live here, this file imports nothing, and
 * both sides import it.
 *
 * ### Why these keys
 *
 * They are the mobile app's navigation groups, one for one. The catalogue used
 * to be four invented placeholders — `van-sales`, `warehouse`, `field-service`,
 * `analytics` — chosen before there was an app to match, and an operator
 * enabling "analytics" had no way to know what a driver would see change. A key
 * here now corresponds to exactly one group in the sidebar, so "Production is
 * off" and "the Production group is absent from the menu" are the same fact.
 *
 * Group-level rather than screen-level. The sidebar already groups its
 * forty-odd screens into these thirteen, so this is the granularity the product
 * is already organised at; splitting entitlements finer would put a decision in
 * front of an operator that the app itself does not present to a user.
 *
 * The `module` table is the authority, and a contract test asserts the two
 * agree. This copy exists so the compiler can check a key and the portal can
 * render a stable, ordered list without waiting on a fetch.
 */

/**
 * In sidebar order, which is display order.
 *
 * `sort_order` in the migration mirrors this sequence in tens. Reordering here
 * without reordering there leaves the portal and the app disagreeing about what
 * comes after what, which is confusing rather than broken — but still worth not
 * doing.
 */
export const MODULE_KEYS = [
  "inventory",
  "purchase-order",
  "sales-order",
  "return-order",
  "project",
  "production",
  "warehouse",
  "inquiry",
  "van-sales",
  "route-tracking",
  "trade-payments",
  "performance",
  "distribution"
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

/** Type guard for a string that arrived from outside this build. */
export const isModuleKey = (value: string): value is ModuleKey =>
  (MODULE_KEYS as readonly string[]).includes(value);

/**
 * The keys as a Zod enum.
 *
 * Here rather than in `module.ts` because `tenant.ts` validates a starting set
 * on the create payload and cannot import from there — see the cycle note
 * above. `module.ts` re-exports it, so nothing outside this package needs to
 * know which of the two files it came from.
 */
export const moduleKeySchema = z.enum(MODULE_KEYS);
