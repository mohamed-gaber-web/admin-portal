import { z } from "zod";

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
