/* eslint-disable */
/**
 * Replaces the placeholder module catalogue with the mobile app's real one.
 *
 * The four keys installed by the modules-and-plan-administration migration —
 * `van-sales`, `warehouse`, `field-service`, `analytics` — were invented before
 * there was an app to match them against. They named plausible product areas
 * rather than anything a user could see, so an operator enabling "analytics"
 * had no way to know what would change on a device, and two of the four
 * corresponded to nothing that had ever been built.
 *
 * These thirteen are the Ionic app's navigation groups, one for one. Enabling a
 * module now means exactly one thing: that group appears in the sidebar.
 *
 * ### Why an edit rather than a drop and rebuild
 *
 * `tenant_module` cascades on `module`, so dropping the table would silently
 * revoke every entitlement any tenant holds. Two of the old keys survive
 * verbatim (`van-sales`, `warehouse`) and one is renamed in place
 * (`analytics` → `performance`, which is the group carrying dashboards and
 * smart reports), so tenants holding those keep them across this migration
 * without an operator re-granting anything. Only `field-service` is deleted,
 * because the app has no counterpart to move it to — inventing one to preserve
 * a row would be worse than the revocation it avoids.
 *
 * ### Literals, again
 *
 * Keys and descriptions are spelled out here rather than imported from the
 * contracts package, matching every earlier migration: a migration is a frozen
 * snapshot of history and must not change meaning when the application's idea
 * of the catalogue moves on. A contract test asserts the two agree today.
 *
 * No apostrophe appears in any description below. These strings are
 * interpolated into SQL literals, and the earlier migration's doubled-quote
 * workaround is a hazard worth simply not needing.
 */

/**
 * The catalogue, in sidebar order.
 *
 * `sort_order` is the index in tens, matching the convention the first
 * catalogue set: gaps, so a module can be slotted between two others without
 * renumbering the table.
 */
const MODULES = [
  ["inventory", "Inventory — transfer orders, cycle counting and transfer journals"],
  ["purchase-order", "Purchase Order — product receipts, registration, vendor returns and paper-PO scanning"],
  ["sales-order", "Sales Order — packing slips and inventory reservation"],
  ["return-order", "Return Order — picking slips for customer returns"],
  ["project", "Project — item requirements and project item journals"],
  ["production", "Production — picking lists and report as finished"],
  ["warehouse", "Warehouse — license plates, pick and put, and packing"],
  ["inquiry", "Inquiry — on-hand lists and inventory inquiry"],
  ["van-sales", "Van Sales — mobile order capture and delivery on a route"],
  ["route-tracking", "Route Tracking — journey plans, route management, GPS and dispatch"],
  ["trade-payments", "Trade and Payments — promotions, merchandising, customer credit and e-payment"],
  ["performance", "Performance — KPIs, commission, dashboards and smart reports"],
  ["distribution", "Distribution — distributor management, supervisor app and ERP integration"]
];

/** What `analytics` becomes, so the tenants holding it keep an entitlement. */
const RENAMED_FROM = "analytics";
const RENAMED_TO = "performance";

/** No counterpart in the app. Its `tenant_module` rows cascade away with it. */
const REMOVED = "field-service";

/** The catalogue this migration replaced, for `down`. */
const PREVIOUS = [
  ["van-sales", "Van sales — mobile order capture and delivery on a route", 10],
  ["warehouse", "Warehouse — stock counts, transfers and picking", 20],
  ["field-service", "Field service — work orders and site visits", 30],
  ["analytics", "Analytics — dashboards over the tenant''s D365 data", 40]
];

const quoted = (keys) => keys.map((key) => `'${key}'`).join(", ");

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  /*
   * The rename goes first, and must: the upsert below carries a `performance`
   * row, and inserting it before the UPDATE would make the unique index on
   * `key` reject the rename rather than the other way around. Done this way the
   * UPDATE claims the key and the upsert quietly falls through to DO UPDATE.
   */
  pgm.sql(`UPDATE module SET key = '${RENAMED_TO}' WHERE key = '${RENAMED_FROM}'`);

  /*
   * Field service goes, and its `tenant_module` rows cascade with it — there is
   * no group in the app it could be moved to instead.
   *
   * A revocation is an entitlement change, and every other entitlement change
   * in this system writes `tenant.modules_changed` (see `setTenantModules`). A
   * customer losing an area at deploy time with nothing in `audit_log` between
   * their last real edit and today is exactly the gap a support call falls
   * into, so the entries are written here, before the delete that makes them
   * unreconstructable.
   *
   * Raw SQL rather than `recordAuditEntry`: a migration is a frozen snapshot
   * and does not import application code, for the same reason the catalogue
   * above is literals. The action name is the existing one, so the audit guard
   * (US-015) already tracks it and no new name has to be registered.
   *
   * `actor_label` is NOT NULL and there is no person behind this — a deploy did
   * it — so it says so, in the `system:` form the column already carries for
   * unattributed writes.
   */
  pgm.sql(`
    INSERT INTO audit_log (
      tenant_id, action, entity_type, entity_id, actor_label,
      before_values, after_values, changed_fields, data
    )
    SELECT tm.tenant_id,
           'tenant.modules_changed',
           'tenant',
           tm.tenant_id::text,
           'system:migration',
           jsonb_build_object('modules', jsonb_build_array('${REMOVED}')),
           jsonb_build_object('modules', '[]'::jsonb),
           ARRAY['modules']::text[],
           jsonb_build_object(
             'migration', '1730000016000_mobile-module-catalogue',
             'reason', 'Module removed from the catalogue; no counterpart in the mobile app.'
           )
      FROM tenant_module tm
      JOIN module m ON m.id = tm.module_id
     WHERE m.key = '${REMOVED}'
  `);

  pgm.sql(`DELETE FROM module WHERE key = '${REMOVED}'`);

  MODULES.forEach(([key, description], index) => {
    /*
     * Upsert rather than insert. Three of these keys already exist — two
     * unchanged since the first catalogue, one just renamed into place — and
     * all three need their description and position brought into line with the
     * sidebar. `DO UPDATE` covers both cases in one statement, so a re-run
     * against a partially applied database converges rather than failing.
     */
    pgm.sql(`
      INSERT INTO module (key, description, sort_order)
      VALUES ('${key}', '${description}', ${(index + 1) * 10})
      ON CONFLICT (key) DO UPDATE
        SET description = EXCLUDED.description,
            sort_order  = EXCLUDED.sort_order
    `);
  });

  /*
   * Anything the catalogue no longer names.
   *
   * A no-op on a database that has only ever seen these two migrations. It
   * exists for the one that has not: a development database seeded by hand, or
   * a branch that added a key of its own. A stray row would show on the
   * portal's entitlement screen as a bare key with no label and no description,
   * because no build has an i18n entry for it.
   */
  const known = quoted(MODULES.map(([key]) => key));

  // Same reasoning as the field-service entries above: whatever this sweeps up
  // may be held by somebody, and a cascade is a revocation.
  pgm.sql(`
    INSERT INTO audit_log (
      tenant_id, action, entity_type, entity_id, actor_label,
      before_values, after_values, changed_fields, data
    )
    SELECT tm.tenant_id,
           'tenant.modules_changed',
           'tenant',
           tm.tenant_id::text,
           'system:migration',
           jsonb_build_object('modules', jsonb_build_array(m.key)),
           jsonb_build_object('modules', '[]'::jsonb),
           ARRAY['modules']::text[],
           jsonb_build_object(
             'migration', '1730000016000_mobile-module-catalogue',
             'reason', 'Module is not in the catalogue this migration installs.'
           )
      FROM tenant_module tm
      JOIN module m ON m.id = tm.module_id
     WHERE m.key NOT IN (${known})
  `);

  pgm.sql(`DELETE FROM module WHERE key NOT IN (${known})`);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  /*
   * Reverses the shape, and cannot reverse the data — worth being explicit
   * about rather than pretending otherwise.
   *
   * `performance` becomes `analytics` again, so a tenant that held either keeps
   * an entitlement. The modules `up` added are deleted, cascading their
   * `tenant_module` rows: those grants were made against a catalogue that does
   * not exist below this migration, so there is nowhere for them to go.
   * `field-service` returns as a catalogue entry held by nobody, because `up`
   * destroyed the only record of who held it.
   */
  const carriedOver = new Set([...PREVIOUS.map(([key]) => key), RENAMED_TO]);
  const added = MODULES.map(([key]) => key).filter((key) => !carriedOver.has(key));

  pgm.sql(`DELETE FROM module WHERE key IN (${quoted(added)})`);
  pgm.sql(`UPDATE module SET key = '${RENAMED_FROM}' WHERE key = '${RENAMED_TO}'`);

  PREVIOUS.forEach(([key, description, sortOrder]) => {
    pgm.sql(`
      INSERT INTO module (key, description, sort_order)
      VALUES ('${key}', '${description}', ${sortOrder})
      ON CONFLICT (key) DO UPDATE
        SET description = EXCLUDED.description,
            sort_order  = EXCLUDED.sort_order
    `);
  });
};
