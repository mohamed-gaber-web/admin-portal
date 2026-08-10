import { join } from "node:path";

/** Package root (dist/.. at runtime, src/.. during type-check). */
export const PACKAGE_ROOT = join(__dirname, "..");

/** Directory holding the versioned migration files. */
export const MIGRATIONS_DIR = join(PACKAGE_ROOT, "migrations");

/** Table node-pg-migrate uses to track applied migrations. */
export const MIGRATIONS_TABLE = "pgmigrations";
