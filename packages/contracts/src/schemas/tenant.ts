import { z } from "zod";
import { pageSchema } from "./page";

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

/**
 * The package a tenant is created on when nobody chooses one.
 *
 * A mirror of the `tenant.plan` column default, which is the authority — the
 * database applies it, and provisioning omits the column rather than sending
 * this, so there is exactly one value in play at write time. This copy exists
 * so the create form can pre-select the right option, and a contract test
 * asserts the two agree.
 *
 * `growth` (25 seats) rather than `trial` (3): provisioning creates the first
 * admin, and a new customer that is full after two colleagues is a default that
 * makes the common case the broken one.
 */
export const DEFAULT_TENANT_PLAN: TenantPlan = "growth";

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
  adminEmail: z.string().email().optional(),
  /**
   * The package the tenant starts on.
   *
   * Optional, and omitting it takes the column default — which is what every
   * caller written before this field did, and what the API's own tests still
   * do. Present so an operator provisioning a customer who has already bought
   * something does not have to create them on the default and immediately move
   * them, which is two audit entries describing one decision.
   *
   * A seat override is deliberately not offered here. A negotiated figure is a
   * concession on top of a package, and asking for it on the create form would
   * put the rarest decision in front of every tenant that will never need one.
   */
  plan: tenantPlanSchema.optional()
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
 * One package on offer, and the seats it includes.
 *
 * Fetched rather than held as a constant here, unlike `TENANT_PLANS` above. The
 * two are different kinds of fact: which packages *exist* is a closed set the
 * compiler should check a key against, and how many users each *includes* is an
 * operational number an installation can change with an `UPDATE` — a constant
 * would turn raising the enterprise allowance into a release.
 *
 * A contract test asserts the keys here match the `plan` table.
 */
export const planSchema = z
  .object({
    key: tenantPlanSchema,
    description: z.string(),
    /** Seats included. Always positive — the table constrains it. */
    userLimit: z.number().int().positive(),
    /**
     * Tenants currently on this package.
     *
     * Carried so the screen that edits `userLimit` can say how many customers a
     * change reaches before it is made. Raising a number is harmless; lowering
     * one silently freezes hiring for every tenant on the package that has no
     * negotiated figure of its own, and an operator who cannot see that count is
     * being asked to make the decision blind.
     *
     * Counts every tenant holding the package, including those with an override
     * — they are on it, and moving the package's number is still the thing that
     * would affect them if their override were cleared.
     */
    tenantCount: z.number().int().nonnegative()
  })
  .strict();

export type Plan = z.infer<typeof planSchema>;

export const planListSchema = z.array(planSchema);

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
    /**
     * Seats the tenant's package includes.
     *
     * Carried on the summary rather than fetched per row, because every screen
     * that shows `userCount` wants to show it as a fraction — "24 users" and
     * "24 of 25 users" are different facts, and only the second one tells an
     * operator a customer is about to be unable to hire.
     *
     * Denormalised from the package on purpose: it is the package's number, and
     * a tenant has no allowance of its own. Moving a tenant to another package
     * is what changes it.
     */
    userLimit: z.number().int().positive(),
    /**
     * The tenant's own negotiated allowance, when it has one.
     *
     * Null means it inherits its package, which is the normal state. Present
     * beside `userLimit` rather than instead of it, because the two answer
     * different questions: `userLimit` is what the limit *is* — always the
     * effective number, so every screen and every check can read one field —
     * and this says whether it came from the package or from a negotiation.
     *
     * Only the screen that edits the allowance needs the distinction. It needs
     * it badly, though: an operator has to be able to see that 40 is a figure
     * somebody agreed to, and to put it back to "whatever Growth includes".
     */
    seatLimitOverride: z.number().int().positive().nullable(),
    /**
     * The tenant's admin address.
     *
     * On the summary rather than only the detail, because the list is where an
     * operator goes to find who to contact about a customer — and opening six
     * detail pages to read six addresses is the screen failing at the thing it
     * is for. Empty only when the tenant has no users at all, which is a state
     * provisioning does not produce.
     */
    adminEmail: z.string(),
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

/**
 * Setting or clearing a tenant's negotiated seat allowance.
 *
 * `null` is a meaningful value, not an omission — it is how an operator puts a
 * tenant back onto its package's number. `.nullable()` rather than
 * `.optional()` so the two are distinguishable: a body that omits the field is
 * a malformed request, and a body that sends null is a deliberate reset.
 */
export const updateTenantSeatsSchema = z
  .object({
    seatLimit: z.number().int().positive().nullable()
  })
  .strict();

export type UpdateTenantSeatsInput = z.infer<typeof updateTenantSeatsSchema>;

/**
 * Changing what a package includes.
 *
 * Only `userLimit`. The key is the identity and is what every tenant row points
 * at, so renaming one here would be a migration wearing an edit's clothing; the
 * description is prose the portal renders from its own translation table rather
 * than from this column. The seat count is the one field an operator has a
 * reason to move, and the one the design always said would move by `UPDATE`
 * rather than by release.
 *
 * Positive, matching `plan_user_limit_positive`. A zero-seat package cannot be
 * provisioned at all — provisioning creates the first admin — so it could only
 * ever exist as a typo that bricked every new tenant on it.
 */
export const updatePlanSchema = z
  .object({
    userLimit: z.number().int().positive()
  })
  .strict();

export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;

/**
 * Renaming a tenant.
 *
 * Name only. The slug is deliberately not editable: it is what a user types to
 * sign in, what every invitation link already sent carries, and what the seed
 * and fixtures address a tenant by — changing it silently invalidates all of
 * those, and the tenant would have no way to tell its own people. A customer
 * that genuinely needs a different slug needs a migration, not a text field.
 */
export const updateTenantSchema = z
  .object({
    name: z.string().min(1)
  })
  .strict();

export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;

/**
 * A reissued administrator invitation.
 *
 * The token is returned exactly once and stored only as a digest, so a link
 * that is not copied here is not recoverable — it is reissued instead. Shaped
 * like the `invitation` block of `provisionedTenantSchema` for that reason:
 * both are the same one-time hand-off, and the screens that render them do the
 * same thing with the value.
 */
export const reissuedInvitationSchema = z
  .object({
    /** Who it was issued to — the tenant's admin, resolved server-side. */
    email: z.string().email(),
    invitation: z.object({
      id: z.string().uuid(),
      expiresAt: z.string(),
      token: z.string()
    })
  })
  .strict();

export type ReissuedInvitation = z.infer<typeof reissuedInvitationSchema>;
