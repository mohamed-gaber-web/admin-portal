/* eslint-disable */
/**
 * Tenant and user administration (US-063, US-064).
 *
 * The administration screens were built against fixtures and needed four facts
 * the schema did not carry. Each is added here as the narrowest column that
 * tells the truth, rather than as a general-purpose settings blob.
 *
 * On tenant status specifically: there is no `status` column, and deliberately
 * so. Three of the four states the portal shows are already derivable —
 * `archived` from `deleted_at`, `pending` from "no user has accepted their
 * invitation yet" — and a stored status alongside them would be a second source
 * of truth for a fact the rows already answer, free to drift from it. Only
 * suspension is genuinely new information, so only suspension gets a column,
 * and it mirrors the `deleted_at` idiom the tenancy migration established.
 */

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // --- Tenant commercial plan -------------------------------------------
  // Constrained rather than free text: the portal renders a badge per plan and
  // an unrecognised value would fall through to a blank one.
  pgm.addColumn("tenant", {
    plan: { type: "text", notNull: true, default: "trial" }
  });
  pgm.addConstraint("tenant", "tenant_plan_check", {
    check: "plan IN ('trial', 'starter', 'growth', 'enterprise')"
  });

  // --- Tenant suspension -------------------------------------------------
  /**
   * Set while a tenant is suspended; null while it is not.
   *
   * A timestamp rather than a boolean, for the same reason `deleted_at` is one:
   * "when did this happen" is the question asked immediately after "is it
   * suspended", and a boolean cannot answer it.
   *
   * Suspension and soft deletion are independent columns because they are
   * independent facts — a suspended tenant that is then archived should not
   * silently lose the record that it was suspended first.
   */
  pgm.addColumn("tenant", {
    suspended_at: { type: "timestamptz" }
  });
  pgm.createIndex("tenant", "suspended_at", {
    name: "tenant_suspended_index",
    where: "suspended_at IS NOT NULL"
  });

  // --- User display name -------------------------------------------------
  /**
   * Nullable, because it genuinely is unknown for a while.
   *
   * A user row is created by an invitation, which carries an email address and
   * nothing else — the person's name is not known until they accept it. A
   * NOT NULL column would have to be filled with a placeholder derived from the
   * email, which is a guess stored as though it were a fact.
   */
  pgm.addColumn("user", {
    name: { type: "text" }
  });

  // --- Environment kind --------------------------------------------------
  /**
   * Production or sandbox.
   *
   * Defaulted to sandbox rather than production: the default is what an
   * environment created without thinking about it becomes, and the safe
   * mistake is to treat production as a sandbox's stricter neighbour rather
   * than the reverse.
   */
  pgm.addColumn("d365_environment", {
    kind: { type: "text", notNull: true, default: "sandbox" }
  });
  pgm.addConstraint("d365_environment", "d365_environment_kind_check", {
    check: "kind IN ('production', 'sandbox')"
  });

  // --- The permission catalogue -----------------------------------------
  /**
   * Reference data, not demo data.
   *
   * `permission` is a global table that `role_permission` points at, and until
   * now it was populated only by `seedDemoData`. That made the catalogue demo
   * data by accident: a database that had been migrated but not seeded — which
   * is every real deployment, and every throwaway database in the test suite —
   * had an empty catalogue, so every role held nothing and the permission
   * matrix rendered a grid of unchecked boxes that could not be checked.
   *
   * The keys are duplicated here rather than imported from `DEMO_PERMISSIONS`
   * for the same reason the RLS migration duplicates its table list: a
   * migration is a frozen snapshot of history and must not change when the
   * application's idea of the catalogue moves on. A permission added later
   * belongs in a new migration.
   *
   * `ON CONFLICT DO NOTHING` so this is safe on a database that was already
   * seeded, and so it does not overwrite a description someone has edited.
   */
  const PERMISSIONS = [
    ["tenant.read", "View tenant settings"],
    ["tenant.write", "Change tenant settings"],
    ["user.read", "View users"],
    ["user.write", "Invite and modify users"],
    ["connection.read", "View D365 connections"],
    ["connection.write", "Manage D365 connections"],
    ["audit.read", "Read the audit log"]
  ];

  for (const [key, description] of PERMISSIONS) {
    pgm.sql(`
      INSERT INTO permission (key, description)
      VALUES ('${key}', '${description}')
      ON CONFLICT (key) DO NOTHING
    `);
  }
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  /**
   * Removes only the catalogue entries nothing is using.
   *
   * A permission a role has been granted is referenced by `role_permission`,
   * whose foreign key is RESTRICT precisely so that removing a permission
   * cannot silently strip it from every role that holds it. Deleting those
   * rows to force the catalogue entry out would destroy data this migration
   * never created, so an in-use permission is left in place.
   */
  pgm.sql(`
    DELETE FROM permission p
    WHERE p.key IN (
      'tenant.read', 'tenant.write', 'user.read', 'user.write',
      'connection.read', 'connection.write', 'audit.read'
    )
      AND NOT EXISTS (
        SELECT 1 FROM role_permission rp WHERE rp.permission_id = p.id
      )
  `);

  pgm.dropConstraint("d365_environment", "d365_environment_kind_check");
  pgm.dropColumn("d365_environment", "kind");

  pgm.dropColumn("user", "name");

  pgm.dropIndex("tenant", "suspended_at", { name: "tenant_suspended_index" });
  pgm.dropColumn("tenant", "suspended_at");

  pgm.dropConstraint("tenant", "tenant_plan_check");
  pgm.dropColumn("tenant", "plan");
};
