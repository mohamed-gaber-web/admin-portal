import { z } from "zod";

/** Response shape returned by the API's health endpoint. */
export const healthStatusSchema = z.object({
  status: z.literal("ok"),
  service: z.string()
});

export type HealthStatus = z.infer<typeof healthStatusSchema>;
