import { z } from "zod";

/** Response shape returned by the API's liveness endpoint. */
export const healthStatusSchema = z.object({
  status: z.literal("ok"),
  service: z.string()
});

export type HealthStatus = z.infer<typeof healthStatusSchema>;

/**
 * What a readiness probe is allowed to say about one dependency.
 *
 * A closed set of opaque words, deliberately. `/health/ready` is unauthenticated
 * — orchestrators cannot present credentials — so anything it returns is public.
 * "down" tells the orchestrator everything it needs to route traffic elsewhere;
 * *why* it is down belongs in the logs, behind the access controls that protect
 * them.
 */
export const dependencyStateSchema = z.enum(["up", "down", "not_configured"]);

export type DependencyState = z.infer<typeof dependencyStateSchema>;

/**
 * Response shape returned by the API's readiness endpoint.
 *
 * `strict()` so an added field fails the contract test rather than quietly
 * shipping: this schema is the whitelist of what may leave the process, and the
 * usual "unknown keys are stripped" default would make a leak invisible here.
 */
export const readinessSchema = z
  .object({
    status: z.enum(["ready", "not_ready"]),
    checks: z
      .object({
        database: dependencyStateSchema,
        redis: dependencyStateSchema
      })
      .strict()
  })
  .strict();

export type Readiness = z.infer<typeof readinessSchema>;
