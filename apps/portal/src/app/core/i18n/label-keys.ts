import type { ModuleKey } from "@growpath/contracts";
import type {
  ActivitySeverity,
  TenantPlan,
  TenantStatus,
  UserStatus
} from "@core/models";
import type { MessageKey } from "./messages/en";

/**
 * Domain vocabulary, mapped to message keys.
 *
 * Every map is written out in full rather than built by interpolation
 * (`` `tenantStatus.${status}` ``). Two reasons, and the second is the one that
 * matters: a `Record<Status, MessageKey>` fails to compile when a new status is
 * added and nobody translates it, and `scripts/check-i18n.mjs` can only detect
 * an unused key if every key appears literally somewhere in the source. A
 * single interpolated key would blind that check for a whole family.
 */

export const TENANT_STATUS_LABEL_KEYS: Record<TenantStatus, MessageKey> = {
  active: "tenantStatus.active",
  pending: "tenantStatus.pending",
  suspended: "tenantStatus.suspended",
  archived: "tenantStatus.archived"
};

export const TENANT_PLAN_LABEL_KEYS: Record<TenantPlan, MessageKey> = {
  trial: "plan.trial",
  starter: "plan.starter",
  growth: "plan.growth",
  enterprise: "plan.enterprise"
};

/**
 * Module names, translated rather than taken from the API.
 *
 * The `module` table carries an English `description`, exactly as `permission`
 * does, and for the same reason it must not be rendered directly: a global table
 * with one language in it is how a localised product ends up with a permanently
 * English screen. The API's description is shown only as a fallback for a key
 * this build has never heard of.
 */
export const MODULE_LABEL_KEYS: Record<ModuleKey, MessageKey> = {
  inventory: "module.inventory",
  "purchase-order": "module.purchase-order",
  "sales-order": "module.sales-order",
  "return-order": "module.return-order",
  project: "module.project",
  production: "module.production",
  warehouse: "module.warehouse",
  inquiry: "module.inquiry",
  "van-sales": "module.van-sales",
  "route-tracking": "module.route-tracking",
  "trade-payments": "module.trade-payments",
  performance: "module.performance",
  distribution: "module.distribution"
};

export const MODULE_DESCRIPTION_KEYS: Record<ModuleKey, MessageKey> = {
  inventory: "module.inventory.description",
  "purchase-order": "module.purchase-order.description",
  "sales-order": "module.sales-order.description",
  "return-order": "module.return-order.description",
  project: "module.project.description",
  production: "module.production.description",
  warehouse: "module.warehouse.description",
  inquiry: "module.inquiry.description",
  "van-sales": "module.van-sales.description",
  "route-tracking": "module.route-tracking.description",
  "trade-payments": "module.trade-payments.description",
  performance: "module.performance.description",
  distribution: "module.distribution.description"
};

export const USER_STATUS_LABEL_KEYS: Record<UserStatus, MessageKey> = {
  active: "userStatus.active",
  invited: "userStatus.invited",
  suspended: "userStatus.suspended"
};

export const SEVERITY_LABEL_KEYS: Record<ActivitySeverity, MessageKey> = {
  info: "severity.info",
  success: "severity.success",
  warning: "severity.warning",
  danger: "severity.danger"
};
