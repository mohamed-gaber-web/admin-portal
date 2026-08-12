import { createLogger } from "@growpath/observability";

/** The API's logger. Every line carries the request context automatically. */
export const apiLogger = createLogger({ name: "api" });
