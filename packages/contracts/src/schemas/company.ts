import { z } from "zod";

/**
 * A legal entity within a D365 environment.
 *
 * `strict()` so a column added later cannot widen what a tenant-scoped endpoint
 * returns without the contract test noticing.
 */
export const companySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    /** The D365 `dataAreaId` this company maps to. */
    dataAreaId: z.string(),
    environmentId: z.string().uuid()
  })
  .strict();

export type Company = z.infer<typeof companySchema>;

export const companyListSchema = z.array(companySchema);
