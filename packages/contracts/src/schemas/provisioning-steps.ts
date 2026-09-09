import { z } from "zod";
import { environmentKindSchema } from "./tenant";

/**
 * The two records a tenant needs before its app can reach Dynamics.
 *
 * Both were missing until now, and their absence was a dead end rather than an
 * inconvenience: `provisionTenant` creates a tenant with no environment,
 * `findErpBlocker` reports `no_environment`, and every mobile user is sent to
 * the setup screen — with nothing anywhere in the API or the portal able to
 * create the row that would clear it. `createEnvironment` and `createCompany`
 * existed in the database package and nothing called them. A freshly sold
 * customer could only be made to work by running the seed script or editing
 * Postgres by hand.
 *
 * Both are created by an operator on the tenant's profile rather than by the
 * tenant itself. That matches every other commercial decision in the platform
 * tier — plan, seats, modules, contract — and it keeps a customer from pointing
 * the app at an arbitrary Dynamics instance.
 *
 * ### Why two endpoints rather than one setup call
 *
 * They are separate decisions taken at separate times. An environment is
 * recorded when a customer's instance is known; its companies are added as
 * legal entities are agreed, often later and more than once. A single
 * "provision everything" body would force an operator to restate the
 * environment every time they added a company, and a retry that restated a
 * stale one would overwrite a corrected URL.
 */

/**
 * A Dynamics environment belonging to a tenant.
 *
 * Carries no credential. The client id and secret are configured afterwards
 * through `PUT /connections/:id`, which tests them against Entra and persists
 * only if they pass — so an environment always exists before a credential can
 * be attached to it, and a rejected credential never creates a half-made row.
 */
export const createEnvironmentSchema = z
  .object({
    name: z.string().min(1).max(200),
    /**
     * The D365 instance URL.
     *
     * `https://` only, and refused rather than coerced. Every token this
     * environment is later used to obtain is sent to this host; an `http://`
     * target would put an ERP access token on a cleartext hop, which is a
     * disclosure rather than a misconfiguration. Same rule the mobile config's
     * `apiBaseUrl` applies, for the same reason.
     */
    url: z
      .string()
      .url()
      .refine((value) => value.startsWith("https://"), {
        message: "The environment URL must be https — ERP access tokens travel to it"
      }),
    /**
     * Optional, defaulting to the column's own default of `sandbox`.
     *
     * Sandbox rather than production is the safe default for a value nobody
     * chose: an environment mislabelled as a sandbox is a cosmetic error, and
     * one mislabelled as production invites somebody to trust it with real
     * orders.
     */
    kind: environmentKindSchema.optional()
  })
  .strict();

export type CreateEnvironmentInput = z.infer<typeof createEnvironmentSchema>;

/**
 * A legal entity inside one of the tenant's environments.
 *
 * `dataAreaId` is the D365 company code every OData query is scoped to — the
 * value the mobile app used to hard-code as `usmf`. Without at least one of
 * these a tenant is still blocked, at `no_company` rather than
 * `no_environment`, which is why this endpoint had to arrive alongside the one
 * above rather than after it.
 */
export const createCompanySchema = z
  .object({
    /**
     * Which of the tenant's environments this belongs to.
     *
     * The composite foreign key on `(environment_id, tenant_id)` refuses an
     * environment belonging to somebody else, so a mismatched id fails in the
     * database rather than quietly attaching a company across a tenant
     * boundary.
     */
    environmentId: z.string().uuid(),
    name: z.string().min(1).max(200),
    /**
     * Lowercase, matching how D365 reports it and how every query sends it.
     *
     * Constrained rather than free text because it is not a label: it is
     * interpolated into OData requests, and `USMF` and `usmf` selecting
     * different things — or nothing — is a failure that surfaces as an empty
     * screen rather than an error.
     */
    dataAreaId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+$/, "dataAreaId must be lowercase letters and digits")
  })
  .strict();

export type CreateCompanyInput = z.infer<typeof createCompanySchema>;
