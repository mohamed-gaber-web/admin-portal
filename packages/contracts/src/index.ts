/**
 * Single source of truth for DTOs shared across the API, portal, and mobile app.
 * Schemas are Zod; the TypeScript types are inferred from them, so a schema
 * change surfaces in consumers at compile time (not runtime).
 */
export { z } from "zod";

export * from "./routes";
export * from "./schemas/page";
export * from "./schemas/health";
export * from "./schemas/tenant";
export * from "./schemas/invitation";
export * from "./schemas/auth";
export * from "./schemas/company";
export * from "./schemas/user";
export * from "./schemas/role";
export * from "./schemas/activity";
export * from "./schemas/connection";
export * from "./schemas/mobile-config";
export * from "./schemas/module";
export * from "./schemas/platform";
