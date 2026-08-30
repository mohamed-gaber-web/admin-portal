/**
 * One entry from the audit log, shaped for the dashboard feed.
 *
 * `action` mirrors the API's audit action names (`tenant.provisioned`,
 * `invitation.issued`, …) so the feed can be pointed at the real audit
 * endpoint without a translation layer in between.
 */
export interface ActivityEntry {
  id: string;
  action: string;
  actor: string;
  target: string;
  at: string;
  severity: ActivitySeverity;
}

export type ActivitySeverity = "info" | "success" | "warning" | "danger";
