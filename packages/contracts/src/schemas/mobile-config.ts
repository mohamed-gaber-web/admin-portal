import { z } from "zod";

/**
 * Mobile runtime configuration (US-040).
 *
 * This is what replaces `environment.ts` in the Ionic app: the app ships with a
 * tenant slug and nothing else, fetches this at launch, and holds no customer's
 * details in its bundle. One binary then serves every tenant, which is the point
 * of the migration.
 *
 * ### What is deliberately not here
 *
 * The old file's `auth` block — `clientId`, `clientSecret`, `grantType:
 * 'client_credentials'`, `scope: '<instance>/.default'` — is **absent, and must
 * stay absent**. That is a confidential client with unrestricted application
 * access to the ERP, and it was inside every installed build. Moving it into a
 * response the same devices download would relocate the problem rather than fix
 * it: a secret shipped in a bundle and a secret fetched over TLS by anybody who
 * knows a slug are the same secret, equally extractable.
 *
 * So the D365 credential now lives on the server, the API calls D365 on the
 * device's behalf, and `connection.ts` is the contract for administering it. If
 * a field from that schema is ever needed here, the answer is a new API
 * endpoint, not a new field.
 *
 * `userAuth` **is** here, and belongs here: a public client holds no secret by
 * definition, and the app cannot begin an interactive sign-in without it.
 */

/** The public Entra client the app signs users in with. */
export const mobileUserAuthSchema = z
  .object({
    /** Public client id. Public by definition — a public client keeps no secret. */
    clientId: z.string(),
    authority: z.string(),
    redirectUri: z.string(),
    scopes: z.array(z.string())
  })
  .strict();

export type MobileUserAuth = z.infer<typeof mobileUserAuthSchema>;

/**
 * Everything a device is told, and the complete list of it.
 *
 * `strict()`, so a field cannot be added to the device-facing response without
 * the contract test failing — which is what turns "do not publish secrets here"
 * from a convention into something CI enforces.
 */
export const mobileConfigSchema = z
  .object({
    /** Identifies which tenant answered, so the app can show it before sign-in. */
    tenantSlug: z.string(),
    tenantName: z.string(),

    /** Where the app sends its API calls. The field that makes one build serve all. */
    apiBaseUrl: z.string(),

    /**
     * Null once a tenant has cut over to portal-native sign-in (US-102).
     *
     * Null rather than an empty object: "this tenant does not use Entra sign-in"
     * and "it is configured with blanks" are different states, and only one of
     * them is a misconfiguration worth showing an administrator.
     */
    userAuth: mobileUserAuthSchema.nullable(),

    /** The oldest build this tenant will serve (US-103). Null means no floor. */
    minimumAppVersion: z.string().nullable(),

    /**
     * The tenant's own logo, as a `data:` URL the app binds straight to an
     * `<img>`. Null when none is set, and the app then shows the Grow Path mark
     * alone.
     *
     * Inline rather than a URL to a second public endpoint. The device caches
     * this response, so the logo is there on an offline launch; and the only
     * throttle an unauthenticated route can use is shared with sign-in, so a
     * warehouse of devices fetching an image would spend the budget its users
     * need to log in. The size cap below is what keeps inlining it affordable.
     */
    logoDataUrl: z.string().nullable(),

    /**
     * When this configuration last changed.
     *
     * Lets a client cache it and re-fetch on a schedule rather than at every
     * launch — a device on a van sales route is offline often, and a launch that
     * blocks on this endpoint is a launch that fails in a warehouse basement.
     */
    updatedAt: z.string()
  })
  .strict();

export type MobileConfig = z.infer<typeof mobileConfigSchema>;

/**
 * Saving the configuration, from the portal.
 *
 * `apiBaseUrl` is validated as an absolute `https://` URL, and not only for
 * tidiness: this single field redirects every device in the field to whatever it
 * names, so a typo that produces a reachable host is the most damaging edit
 * available on this screen. `http://` is refused outright — an access token on a
 * cleartext hop is an access token that has been disclosed.
 */
export const saveMobileConfigSchema = z
  .object({
    apiBaseUrl: z
      .string()
      .url()
      .refine((value) => value.startsWith("https://"), {
        message: "apiBaseUrl must be https — devices send access tokens to it"
      }),
    /** Null clears the Entra block: what a tenant past cutover looks like. */
    userAuth: mobileUserAuthSchema.nullable(),
    minimumAppVersion: z.string().min(1).nullable().optional()
  })
  .strict();

export type SaveMobileConfigInput = z.infer<typeof saveMobileConfigSchema>;

/**
 * The largest logo a tenant may store, decoded. Matches the database's
 * `tenant_mobile_config_logo_size_check`.
 *
 * 64 KiB, because the logo travels inside every bootstrap response, and because
 * the API's JSON body limit is 100 KB — base64 adds a third, which leaves this
 * comfortably under it. The portal scales an image down before uploading, so a
 * logo at the size the app draws it is a few kilobytes.
 */
export const TENANT_LOGO_MAX_BYTES = 64 * 1024;

/**
 * Raster formats only. SVG is a document that can carry script, and this image
 * is rendered on every device in the tenant.
 */
export const TENANT_LOGO_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export type TenantLogoContentType = (typeof TENANT_LOGO_CONTENT_TYPES)[number];

/** `data:image/<type>;base64,<payload>` — the one shape accepted and served. */
export const TENANT_LOGO_DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * Uploading a logo, from the portal.
 *
 * The length bound is the base64 size of `TENANT_LOGO_MAX_BYTES` plus the
 * prefix, so an oversized upload is refused before it is decoded. The API then
 * decodes it and checks the bytes really are the type the prefix claims.
 */
export const saveMobileLogoSchema = z
  .object({
    dataUrl: z
      .string()
      .max(Math.ceil(TENANT_LOGO_MAX_BYTES / 3) * 4 + 32)
      .regex(TENANT_LOGO_DATA_URL, "dataUrl must be a base64 PNG, JPEG or WebP data: URL")
  })
  .strict();

export type SaveMobileLogoInput = z.infer<typeof saveMobileLogoSchema>;

/**
 * The slug a device presents to bootstrap itself.
 *
 * The same identifier sign-in already takes, and for the same reason: it is the
 * only thing a freshly installed app has been given. It is a claim resolved by
 * the endpoint, never a tenant context — nothing the response carries can be
 * used to reach anything else.
 */
export const mobileConfigQuerySchema = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric with dashes")
  })
  .strict();

export type MobileConfigQuery = z.infer<typeof mobileConfigQuerySchema>;
