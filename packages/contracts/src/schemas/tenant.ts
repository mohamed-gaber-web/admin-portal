import { z } from "zod";
import { pageSchema } from "./page";

/** Payload accepted when creating a tenant. */
export const createTenantSchema = z.object({
  name: z.string().min(1),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric with dashes"),
  /**
   * Email of the tenant's first admin user. Optional — provisioning derives
   * `admin@<slug>.local` when it is omitted, so existing consumers that send
   * only name and slug keep working.
   */
  adminEmail: z.string().email().optional()
});

export type CreateTenantInput = z.infer<typeof createTenantSchema>;

/** What provisioning returns: the tenant plus everything created alongside it. */
export const provisionedTenantSchema = z.object({
  tenant: z.object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string()
  }),
  adminUser: z.object({
    id: z.string().uuid(),
    email: z.string().email()
  }),
  roles: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string()
    })
  ),
  /**
   * The first admin's invitation (US-020).
   *
   * Provisioning creates an admin user with no credential, so without this a
   * new tenant contains nobody who can ever sign in. The token is returned
   * here once and never again.
   */
  invitation: z.object({
    id: z.string().uuid(),
    expiresAt: z.string(),
    token: z.string()
  })
});

export type ProvisionedTenant = z.infer<typeof provisionedTenantSchema>;

/**
 * A tenant's lifecycle state, as every administration screen reads it.
 *
 * Three of the four are derived rather than stored (see the tenant
 * administration migration): `archived` from `deleted_at`, `pending` from a
 * tenant whose first admin has not accepted their invitation yet, and `active`
 * as what remains. Only `suspended` has a column of its own.
 */
export const TENANT_STATUSES = ["active", "pending", "suspended", "archived"] as const;
export const tenantStatusSchema = z.enum(TENANT_STATUSES);
export type TenantStatus = z.infer<typeof tenantStatusSchema>;

export const TENANT_PLANS = ["trial", "starter", "growth", "enterprise"] as const;
export const tenantPlanSchema = z.enum(TENANT_PLANS);
export type TenantPlan = z.infer<typeof tenantPlanSchema>;

/** A tenant as the list screen renders it. */
export const tenantSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    status: tenantStatusSchema,
    plan: tenantPlanSchema,
    /** Users belonging to the tenant, counted server-side. */
    userCount: z.number().int().nonnegative(),
    /** ISO-8601. A string because that is what JSON carries. */
    createdAt: z.string()
  })
  .strict();

export type TenantSummary = z.infer<typeof tenantSummarySchema>;

export const tenantPageSchema = pageSchema(tenantSummarySchema);

/** A legal entity, as it appears nested inside its environment. */
export const tenantCompanySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    dataAreaId: z.string(),
    environmentId: z.string().uuid()
  })
  .strict();

export const ENVIRONMENT_KINDS = ["production", "sandbox"] as const;
export const environmentKindSchema = z.enum(ENVIRONMENT_KINDS);

/**
 * Whether the portal can currently reach the environment.
 *
 * The API answers `not_configured` for every environment today, and that is the
 * truthful answer rather than a placeholder: storing and testing connection
 * credentials is US-065, so there is nothing yet that could report `connected`
 * without inventing it.
 */
export const CONNECTION_STATES = ["connected", "failing", "not_configured"] as const;
export const connectionStateSchema = z.enum(CONNECTION_STATES);

/**
 * A D365 environment with its legal entities nested inside it.
 *
 * Nested, not flattened. US-010 calls collapsing the tenant → environment →
 * company hierarchy the most expensive modelling mistake available here, and a
 * response shape that flattens it makes the mistake unavoidable for consumers.
 */
export const tenantEnvironmentSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    kind: environmentKindSchema,
    url: z.string(),
    connection: connectionStateSchema,
    companies: z.array(tenantCompanySchema)
  })
  .strict();

/** Everything the tenant detail screen shows, in one response. */
export const tenantDetailSchema = tenantSummarySchema
  .extend({
    /** The tenant's first admin. Empty when provisioning predates this field. */
    adminEmail: z.string(),
    environments: z.array(tenantEnvironmentSchema)
  })
  .strict();

export type TenantDetail = z.infer<typeof tenantDetailSchema>;

/**
 * A lifecycle transition, expressed as the state the caller wants to reach.
 *
 * The target state rather than a verb, so the request is idempotent: asking for
 * `suspended` twice is a no-op, whereas a `suspend` command replayed against an
 * already-suspended tenant has no obviously correct answer.
 *
 * `pending` is absent on purpose — it is derived from whether anyone has
 * accepted an invitation, so it is not something an operator can transition to.
 */
export const TENANT_STATUS_TARGETS = ["active", "suspended", "archived"] as const;

export const updateTenantStatusSchema = z
  .object({
    status: z.enum(TENANT_STATUS_TARGETS)
  })
  .strict();

export type UpdateTenantStatusInput = z.infer<typeof updateTenantStatusSchema>;
