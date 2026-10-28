/* eslint-disable */
/**
 * The D365 warehouse a user works in.
 *
 * Set by the tenant's administrator when inviting or editing a user, and read
 * by the mobile app after sign-in so every warehouse dropdown starts on it. A
 * default, not a restriction: the app still lets the user pick another, and
 * nothing here decides what they may reach in the ERP.
 *
 * A warehouse is a D365 record, so it is stored as a reference to one rather
 * than copied: which company (D365 legal entity) and which warehouse id in it.
 * The name is kept alongside purely so a screen can show "11 - Main warehouse"
 * without a round trip to Dynamics; the id is what the app acts on.
 *
 * On the user row rather than a table of its own: one warehouse per user, and
 * the row is already fenced by `user`'s tenant isolation policy.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumns("user", {
    /**
     * The company the warehouse belongs to. No foreign key on purpose: a
     * company removed later would otherwise either delete the user (CASCADE) or
     * break the check below (SET NULL). Reads join the company and treat a
     * vanished one as "no warehouse".
     */
    default_warehouse_company_id: { type: "uuid" },
    /** D365 `WarehouseId` (InventLocationId), e.g. `11`. */
    default_warehouse_id: { type: "text" },
    /** D365 `WarehouseName`, for display only. */
    default_warehouse_name: { type: "text" }
  });

  pgm.addConstraint("user", "user_default_warehouse_complete_check", {
    check: `(
      (default_warehouse_company_id IS NULL AND default_warehouse_id IS NULL AND default_warehouse_name IS NULL)
      OR
      (default_warehouse_company_id IS NOT NULL AND default_warehouse_id IS NOT NULL AND default_warehouse_name IS NOT NULL)
    )`
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropConstraint("user", "user_default_warehouse_complete_check");
  pgm.dropColumns("user", [
    "default_warehouse_company_id",
    "default_warehouse_id",
    "default_warehouse_name"
  ]);
};
