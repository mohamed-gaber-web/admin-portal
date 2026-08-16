/* eslint-disable */
/**
 * Module entitlements, plan administration, and the permissions that authorise
 * them (US-072, and the operator half of S8).
 *
 * Three things, in one migration because they are one capability: an operator
 * decides what a customer has paid for, and that decision is a plan plus a set
 * of modules. Splitting them would leave a release where the modules exist and
 * nothing may edit them.
 *
 * ### What this deliberately is *not*
 *
 * It is not the full subscription model from US-070/071 — there are no package
 * definitions, no billing periods, no seat counts, no expiry with a grace
 * window. `tenant.plan` remains a four-value enum that has been there since the
 * tenant-administration migration, and "unsubscribe" means returning a customer
 * to `trial`.
 *
 * That is a scoping decision rather than an oversight, and the seam is where it
 * should be: when the real model lands it replaces `tenant.plan` and inherits
 * `tenant_module` unchanged, because which modules a tenant may use is a fact
 * about the tenant either way. What it must not inherit is a half-built
 * subscription table that guessed at the shape.
 */

/**
 * The functional modules a tenant can be entitled to.
 *
 * Keys are literals here rather than imported from the contracts package,
 * matching the convention every earlier migration follows: a migration is a
 * frozen snapshot of history, and it must not change meaning when the
 * application's idea of the catalogue moves on. A contract test asserts the two
 * agree.
 */
const MODULES = [
  ["van-sales", "Van sales — mobile order capture and delivery on a route"],
  ["warehouse", "Warehouse — stock counts, transfers and picking"],
  ["field-service", "Field service — work orders and site visits"],
  ["analytics", "Analytics — dashboards over the tenant''s D365 data"]
];

/**
 * Cross-tenant permissions this migration adds.
 *
 * Under the same `platform.` prefix as the rest, which is not cosmetic: the
 * trigger installed by the platform-administration migration refuses any key
 * with this prefix on a role outside the platform tenant, so a new key is
 * fenced by naming it correctly and by nothing else.
 */
const PLATFORM_PERMISSIONS = [
  ["platform.plan.write", "Change any tenant''s plan, and unsubscribe them"],
  ["platform.module.write", "Enable and disable modules for any tenant"],
  // NB: doubled apostrophes above and below — these strings are interpolated
  // into SQL literals, and a bare one terminates the string. See the note in
  // the platform-administration migration, which learnt this the hard way.
  ["platform.admin.write", "Create platform administrators"]
];

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // --- The module catalogue ----------------------------------------------
  /**
   * Global, not tenant-scoped — exactly like `permission`, and for the same
   * reason: the set of modules the product *has* is a property of the product.
   * Which of them a tenant *may use* is `tenant_module` below.
   *
   * No `tenant_id` column, so `findTablesMissingRlsPolicies()` does not ask this
   * table for a policy, and correctly: there is nothing here to isolate.
   */
  pgm.createTable("module", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    key: { type: "text", notNull: true, unique: true },
    description: { type: "text", notNull: true },
    /**
     * Display order, so the portal's list is stable and deliberate rather than
     * alphabetical by an internal key. An integer with gaps, so inserting a
     * module between two others does not renumber the table.
     */
    sort_order: { type: "integer", notNull: true, default: 0 },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  });

  pgm.sql(`GRANT SELECT ON module TO app_user`);

  MODULES.forEach(([key, description], index) => {
    pgm.sql(`
      INSERT INTO module (key, description, sort_order)
      VALUES ('${key}', '${description}', ${(index + 1) * 10})
      ON CONFLICT (key) DO NOTHING
    `);
  });

  // --- Which modules a tenant holds --------------------------------------
  /**
   * A row means entitled; no row means not.
   *
   * Rather than a boolean `enabled` column, because the two states are not
   * symmetrical: "this tenant was granted van sales on 4 March" is a fact worth
   * keeping, and "this tenant has never had van sales" is the absence of one. A
   * boolean would force every tenant to carry a row per module forever, most of
   * them false, and would make the grant date meaningless for the ones that were
   * never granted.
   */
  pgm.createTable("tenant_module", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    tenant_id: {
      type: "uuid",
      notNull: true,
      references: "tenant",
      onDelete: "CASCADE"
    },
    module_id: {
      type: "uuid",
      notNull: true,
      references: "module",
      onDelete: "CASCADE"
    },
    enabled_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  });

  pgm.addConstraint("tenant_module", "tenant_module_unique", {
    unique: ["tenant_id", "module_id"]
  });
  pgm.createIndex("tenant_module", "tenant_id");

  // --- Isolation ---------------------------------------------------------
  // A tenant-scoped table with no policy is reported by
  // findTablesMissingRlsPolicies() and fails CI (US-011). The operator screens
  // reach this table through withoutTenantScope, which is a visible, logged
  // bypass — not a reason to leave the table open to everyone else.
  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_module TO app_user`);
  pgm.sql(`ALTER TABLE tenant_module ENABLE ROW LEVEL SECURITY`);
  pgm.sql(`ALTER TABLE tenant_module FORCE ROW LEVEL SECURITY`);
  pgm.sql(`
    CREATE POLICY tenant_isolation ON tenant_module
      USING (tenant_id = current_tenant_id())
      WITH CHECK (tenant_id = current_tenant_id())
  `);

  // --- The new platform permissions --------------------------------------
  for (const [key, description] of PLATFORM_PERMISSIONS) {
    pgm.sql(`
      INSERT INTO permission (key, description)
      VALUES ('${key}', '${description}')
      ON CONFLICT (key) DO NOTHING
    `);
  }

  /**
   * Granted to the existing platform role.
   *
   * Expressed as "every `platform.` key" rather than as the three added above,
   * matching `grantPlatformRolePermissions` in `platform.ts`: an operator whose
   * role was provisioned before this migration must come out of it holding the
   * new keys, and listing them here would mean remembering to list the next ones
   * too.
   */
  pgm.sql(`
    INSERT INTO role_permission (tenant_id, role_id, permission_id)
    SELECT r.tenant_id, r.id, p.id
      FROM role r
      JOIN tenant t ON t.id = r.tenant_id
     CROSS JOIN permission p
     WHERE t.is_platform AND p.key LIKE 'platform.%'
    ON CONFLICT (role_id, permission_id) DO NOTHING
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  /**
   * The grants go before the permission rows, and the permission rows only if
   * nothing still references them — the same shape as the platform-administration
   * migration's down. A permission still held by a role is one an operator is
   * relying on, and deleting it would silently strip their reach.
   */
  pgm.sql(`
    DELETE FROM role_permission rp
     USING permission p
     WHERE rp.permission_id = p.id
       AND p.key IN ('platform.plan.write', 'platform.module.write', 'platform.admin.write')
  `);
  pgm.sql(`
    DELETE FROM permission p
     WHERE p.key IN ('platform.plan.write', 'platform.module.write', 'platform.admin.write')
       AND NOT EXISTS (SELECT 1 FROM role_permission rp WHERE rp.permission_id = p.id)
  `);

  pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON tenant_module`);
  pgm.sql(`ALTER TABLE tenant_module NO FORCE ROW LEVEL SECURITY`);
  pgm.sql(`ALTER TABLE tenant_module DISABLE ROW LEVEL SECURITY`);
  pgm.sql(`REVOKE ALL ON tenant_module FROM app_user`);
  pgm.dropTable("tenant_module");

  pgm.sql(`REVOKE ALL ON module FROM app_user`);
  pgm.dropTable("module");
};
