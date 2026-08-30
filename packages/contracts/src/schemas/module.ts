import { z } from "zod";
import { tenantPlanSchema } from "./tenant";

/**
 * Module entitlements (US-072).
 *
 * Which functional areas of the product a tenant may use. Distinct from
 * permissions, and the distinction is worth being clear about because the two
 * are easily confused:
 *
 * - A **permission** answers "may *this user* do this?", and is granted by a
 *   tenant's own administrator through a role.
 * - A **module** answers "has *this tenant* paid for this area at all?", and is
 *   granted by whoever operates the installation.
 *
 * A user with every permission in a tenant that holds no warehouse module still
 * cannot use the warehouse, and that is the correct outcome — the customer did
 * not buy it. Modelling entitlements as permissions would have let a tenant
 * administrator grant their own tenant a module nobody sold them.
 */

/**
 * The catalogue, mirrored from the modules-and-plan-administration migration.
 *
 * A contract test asserts these match the `module` table. Kept as a literal here
 * rather than fetched, so the portal can render a stable list and the compiler
 * can check a key against it.
 */
export const MODULE_KEYS = [
  "van-sales",
  "warehouse",
  "field-service",
  "analytics"
] as const;

export const moduleKeySchema = z.enum(MODULE_KEYS);
export type ModuleKey = z.infer<typeof moduleKeySchema>;

/**
 * One module, as the entitlement screen renders it.
 *
 * `enabledAt` is nullable rather than a boolean, because the grant date is the
 * useful half: "held since 4 March" answers a question a support call actually
 * asks, and `true` does not. Null means the tenant does not hold it.
 */
export const tenantModuleSchema = z
  .object({
    key: z.string(),
    description: z.string(),
    enabled: z.boolean(),
    /** ISO-8601, or null when the tenant does not hold this module. */
    enabledAt: z.string().nullable()
  })
  .strict();

export type TenantModule = z.infer<typeof tenantModuleSchema>;

export const tenantModuleListSchema = z.array(tenantModuleSchema);

/**
 * Replacing the set of modules a tenant holds.
 *
 * The whole set rather than one grant at a time, matching
 * `updateRolePermissionsSchema`: a screen of toggles submits a state, and
 * turning that into a sequence of grants and revokes makes a half-applied set
 * the normal result of a dropped connection.
 */
export const setTenantModulesSchema = z
  .object({
    modules: z.array(moduleKeySchema)
  })
  .strict();

export type SetTenantModulesInput = z.infer<typeof setTenantModulesSchema>;

/**
 * Changing a tenant's plan, or cancelling it.
 *
 * `unsubscribe` is a separate flag rather than a fifth plan value because the
 * column has four values and widening it would mean rewriting a check
 * constraint that has held since the tenant-administration migration. What the
 * flag buys is the audit entry: a cancellation and a downgrade to trial leave
 * the same row behind, and only the log can tell them apart afterwards.
 *
 * When the real subscription model lands (US-070/071) this is the endpoint it
 * replaces, and that log is what it will be reconstructed from.
 */
export const setTenantPlanSchema = z
  .object({
    plan: tenantPlanSchema,
    unsubscribe: z.boolean().optional()
  })
  .strict();

export type SetTenantPlanInput = z.infer<typeof setTenantPlanSchema>;
