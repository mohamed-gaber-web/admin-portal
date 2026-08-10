/* eslint-disable */
/**
 * Core multi-tenant schema.
 * Every tenant-scoped table carries `tenant_id` from the start (adding it later
 * would force a painful backfill). `tenant` and `permission` are not tenant-scoped.
 */

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  const idCol = () => ({ type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") });
  const createdAt = () => ({ type: "timestamptz", notNull: true, default: pgm.func("now()") });
  const updatedAt = () => ({ type: "timestamptz", notNull: true, default: pgm.func("now()") });
  const tenantRef = () => ({ type: "uuid", notNull: true, references: "tenant", onDelete: "CASCADE" });

  // Root tenancy table (not tenant-scoped).
  pgm.createTable("tenant", {
    id: idCol(),
    name: { type: "text", notNull: true },
    slug: { type: "text", notNull: true, unique: true },
    created_at: createdAt(),
    updated_at: updatedAt()
  });

  // Global permission catalogue (not tenant-scoped).
  pgm.createTable("permission", {
    id: idCol(),
    key: { type: "text", notNull: true, unique: true },
    description: { type: "text" }
  });

  pgm.createTable("d365_environment", {
    id: idCol(),
    tenant_id: tenantRef(),
    name: { type: "text", notNull: true },
    url: { type: "text", notNull: true },
    created_at: createdAt(),
    updated_at: updatedAt()
  });

  pgm.createTable("company", {
    id: idCol(),
    tenant_id: tenantRef(),
    name: { type: "text", notNull: true },
    created_at: createdAt(),
    updated_at: updatedAt()
  });

  pgm.createTable("user", {
    id: idCol(),
    tenant_id: tenantRef(),
    email: { type: "text", notNull: true },
    created_at: createdAt(),
    updated_at: updatedAt()
  });
  pgm.addConstraint("user", "user_tenant_email_unique", { unique: ["tenant_id", "email"] });

  pgm.createTable("role", {
    id: idCol(),
    tenant_id: tenantRef(),
    name: { type: "text", notNull: true },
    created_at: createdAt(),
    updated_at: updatedAt()
  });
  pgm.addConstraint("role", "role_tenant_name_unique", { unique: ["tenant_id", "name"] });

  pgm.createTable("user_role", {
    id: idCol(),
    tenant_id: tenantRef(),
    user_id: { type: "uuid", notNull: true, references: "user", onDelete: "CASCADE" },
    role_id: { type: "uuid", notNull: true, references: "role", onDelete: "CASCADE" },
    created_at: createdAt()
  });
  pgm.addConstraint("user_role", "user_role_unique", { unique: ["user_id", "role_id"] });

  pgm.createTable("audit_log", {
    id: idCol(),
    tenant_id: tenantRef(),
    user_id: { type: "uuid", references: "user", onDelete: "SET NULL" },
    action: { type: "text", notNull: true },
    entity_type: { type: "text", notNull: true },
    entity_id: { type: "text" },
    data: { type: "jsonb" },
    created_at: createdAt()
  });

  // Indexes on tenant_id for tenant-scoped tables.
  for (const table of ["d365_environment", "company", "user", "role", "user_role", "audit_log"]) {
    pgm.createIndex(table, "tenant_id");
  }
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  // Drop in reverse dependency order.
  pgm.dropTable("audit_log");
  pgm.dropTable("user_role");
  pgm.dropTable("role");
  pgm.dropTable("user");
  pgm.dropTable("company");
  pgm.dropTable("d365_environment");
  pgm.dropTable("permission");
  pgm.dropTable("tenant");
};
