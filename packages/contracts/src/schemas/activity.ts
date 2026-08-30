import { z } from "zod";
import { pageSchema, pageQuerySchema } from "./page";

/**
 * How prominently an audit entry is shown.
 *
 * Derived by the API from the action name rather than stored, because it is a
 * presentation decision about a fixed vocabulary — `audit_log` records what
 * happened, and how alarming that is belongs to whoever is reading. Deriving it
 * server-side keeps the answer identical across the portal, the mobile app and
 * anything else that grows a feed.
 */
export const ACTIVITY_SEVERITIES = ["info", "success", "warning", "danger"] as const;
export const activitySeveritySchema = z.enum(ACTIVITY_SEVERITIES);
export type ActivitySeverity = z.infer<typeof activitySeveritySchema>;

/**
 * One audit entry, shaped for a feed.
 *
 * `action` is the raw audit action name (`tenant.provisioned`,
 * `invitation.issued`, …) and not display text, for the same reason role names
 * travel as names: the feed is rendered in two languages.
 */
export const activityEntrySchema = z
  .object({
    id: z.string().uuid(),
    action: z.string(),
    /** Who acted, as the audit log recorded them. */
    actor: z.string(),
    /** What was acted upon — an entity id, a slug or an email. */
    target: z.string(),
    /** ISO-8601. */
    at: z.string(),
    severity: activitySeveritySchema
  })
  .strict();

export type ActivityEntry = z.infer<typeof activityEntrySchema>;

export const activityPageSchema = pageSchema(activityEntrySchema);

export const activityQuerySchema = pageQuerySchema.extend({
  severity: z.union([activitySeveritySchema, z.literal("all")]).catch("all")
});

export type ActivityQuery = z.infer<typeof activityQuerySchema>;

/**
 * Severity per audit action.
 *
 * Exhaustive over the actions the system writes today, with `info` as the
 * fallback so an action added later appears in the feed looking unremarkable
 * rather than not appearing at all.
 */
const SEVERITY_BY_ACTION: Record<string, ActivitySeverity> = {
  "tenant.provisioned": "success",
  "tenant.restored": "success",
  "tenant.reactivated": "success",
  "tenant.suspended": "warning",
  "tenant.soft_deleted": "danger",
  "invitation.issued": "info",
  "invitation.accepted": "success",
  "role.assigned": "info",
  "role.revoked": "warning",
  "role.permissions_changed": "warning",
  "user.suspended": "warning",
  "user.reactivated": "success",
  "password.reset": "warning",
  "mfa.enabled": "success",
  // Commercial changes an operator makes to a customer (US-072). Losing a
  // module and losing a subscription are both things the tenant will notice
  // without being told, so they read as warnings rather than as notes.
  "tenant.plan_changed": "info",
  "tenant.unsubscribed": "danger",
  "tenant.modules_changed": "warning",
  // A seat allowance moving. `info` rather than `warning`: the common case is an
  // operator granting a customer *more* room, and the cut is already visible as
  // the tenant being unable to invite.
  // A tenant renamed. `info`: it changes what the tenant is called and nothing
  // about what it may do.
  "tenant.renamed": "info",
  "tenant.seats_changed": "info",
  // A *package's* allowance moving, which reaches every tenant on it that has
  // no negotiated figure. `warning` rather than the `info` its per-tenant
  // counterpart gets, and the difference is the blast radius: one is a
  // concession to one customer, this is a change to what the product sells.
  "plan.seats_changed": "warning"
};

export function severityForAction(action: string): ActivitySeverity {
  return SEVERITY_BY_ACTION[action] ?? "info";
}
