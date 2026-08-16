import { z } from "zod";
import { connectionStateSchema, environmentKindSchema } from "./tenant";

/**
 * D365 connection configuration (US-040, US-045).
 *
 * This is the confidential half of the mobile app's old `environment.ts`. It is
 * read and written by the admin portal, and **never** served to a device: the
 * credential it configures is a `client_credentials` service principal scoped to
 * `<instance>/.default`, which is unrestricted application access to the ERP.
 * The device half is `mobile-config.ts`, and the separation is the point of the
 * story — see the note there.
 *
 * ### Where `environment.ts` went
 *
 * | Old field           | Now                                                    |
 * | ------------------- | ------------------------------------------------------ |
 * | `auth.tokenUrl`     | derived from `entraTenantId` + `authorityHost`          |
 * | `auth.clientId`     | `clientId`                                             |
 * | `auth.clientSecret` | sealed server-side; write-only, never returned          |
 * | `auth.scope`        | derived from the environment URL — always `…/.default`  |
 * | `auth.grantType`    | gone; `client_credentials` is the only grant this uses  |
 * | `d365BaseUrl`       | `url`, which `d365_environment` already carried         |
 */

/** Entra authority hosts. Sovereign clouds serve the same protocol elsewhere. */
export const AUTHORITY_HOSTS = [
  "login.microsoftonline.com",
  "login.microsoftonline.us",
  "login.partner.microsoftonline.cn"
] as const;

export const authorityHostSchema = z.enum(AUTHORITY_HOSTS);
export type AuthorityHost = z.infer<typeof authorityHostSchema>;

/**
 * Why a connection test failed.
 *
 * A closed set, and deliberately not Entra's `error_description`. That text is
 * free-form, carries correlation ids and the client id, and changes without
 * notice — passing it through would make an error contract out of a third
 * party's prose, and eventually put something in it that should not be there.
 * These four are the distinctions an administrator can act on.
 */
export const CONNECTION_ERRORS = [
  /** The client id or secret was rejected. Usually an expired secret. */
  "invalid_client",
  /** The directory does not know that application. Usually the wrong tenant id. */
  "invalid_tenant",
  /** Authenticated, but not entitled to the environment. A missing app role. */
  "invalid_scope",
  /** Entra or the environment did not answer. Network, DNS, or an outage. */
  "unreachable",
  /** Anything else, reported as itself rather than guessed at. */
  "unexpected"
] as const;

export const connectionErrorSchema = z.enum(CONNECTION_ERRORS);
export type ConnectionError = z.infer<typeof connectionErrorSchema>;

/**
 * How long before expiry the portal warns (US-044). Shared so the API and the
 * portal agree on when a secret becomes urgent, rather than each choosing.
 */
export const SECRET_EXPIRY_WARNING_DAYS = 30;

/**
 * A connection, as every reader sees it.
 *
 * There is no `clientSecret` field, and that absence is the contract. US-045
 * asks for write-only secret handling; expressing it as a schema that has
 * nowhere to put one is stronger than a serialiser that remembers to remove it,
 * because `strict()` then makes an accidental addition a test failure.
 *
 * `hasClientSecret` is what a screen actually needs: whether one is configured
 * is a different question from what it is.
 */
export const connectionSchema = z
  .object({
    /** The environment id. A connection has no identity apart from its environment. */
    environmentId: z.string().uuid(),
    environmentName: z.string(),
    environmentKind: environmentKindSchema,
    /** The D365 instance URL. */
    url: z.string(),

    entraTenantId: z.string().nullable(),
    authorityHost: authorityHostSchema,
    clientId: z.string().nullable(),

    hasClientSecret: z.boolean(),
    /** ISO-8601, or null when no secret has ever been stored. */
    clientSecretUpdatedAt: z.string().nullable(),
    clientSecretExpiresAt: z.string().nullable(),
    /**
     * Days until the secret expires; null when no expiry was recorded.
     *
     * Computed server-side rather than left to the client. A device or browser
     * with a wrong clock would otherwise decide for itself whether a credential
     * is expiring, and the whole point of US-044 is that this warning is
     * reliable.
     */
    daysUntilSecretExpiry: z.number().int().nullable(),

    state: connectionStateSchema,
    /** ISO-8601 timestamp of the last check. A state with no age is not evidence. */
    checkedAt: z.string().nullable(),
    error: connectionErrorSchema.nullable(),

    /**
     * What the API will actually call, spelled out.
     *
     * Derived, never stored, and returned so an administrator can confirm the
     * request the server is about to make instead of inferring it from three
     * fields. Null while the connection is unconfigured.
     */
    tokenUrl: z.string().nullable(),
    scope: z.string()
  })
  .strict();

export type Connection = z.infer<typeof connectionSchema>;

export const connectionListSchema = z.array(connectionSchema);

/**
 * Saving a connection.
 *
 * `clientSecret` is optional, and omitting it keeps the stored one. The screen
 * cannot display the current secret — nothing can — so making it required would
 * force whoever is correcting the expiry date to re-type a credential they may
 * not have. The predictable result of that is a placeholder typed in to get past
 * the field, which is a working connection broken by its own form validation.
 */
export const saveConnectionSchema = z
  .object({
    /** The Entra directory GUID — the middle segment of the old `tokenUrl`. */
    entraTenantId: z.string().uuid("entraTenantId must be the directory GUID"),
    /** Defaults to the commercial cloud, which is right for every tenant but a sovereign one. */
    authorityHost: authorityHostSchema.optional(),
    clientId: z.string().uuid("clientId must be the application GUID"),
    /** Omit to keep the stored secret. Never returned by any read. */
    clientSecret: z.string().min(1).optional(),
    /**
     * When Entra stops accepting the secret (US-044).
     *
     * Typed in because the token endpoint does not report it, and nullable
     * because an administrator who does not know it should be able to say so
     * rather than invent a date that later reads as fact.
     */
    clientSecretExpiresAt: z.string().datetime().nullable().optional()
  })
  .strict();

export type SaveConnectionInput = z.infer<typeof saveConnectionSchema>;

/**
 * What a live check found.
 *
 * Returned by the explicit test endpoint. A *save* does not return this: a save
 * that failed its check is a 422 carrying the reason, because a 200 whose body
 * says `ok: false` is a success status on a request that changed nothing, and
 * clients treat those differently.
 */
export const connectionTestResultSchema = z
  .object({
    ok: z.boolean(),
    state: connectionStateSchema,
    error: connectionErrorSchema.nullable(),
    checkedAt: z.string()
  })
  .strict();

export type ConnectionTestResult = z.infer<typeof connectionTestResultSchema>;

/**
 * True when a secret is close enough to expiry to warrant a warning, or is
 * already past it. Shared so the badge and the alerting agree.
 */
export function secretNeedsAttention(daysUntilSecretExpiry: number | null): boolean {
  return daysUntilSecretExpiry !== null && daysUntilSecretExpiry <= SECRET_EXPIRY_WARNING_DAYS;
}
