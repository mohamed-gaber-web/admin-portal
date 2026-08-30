/* eslint-disable */
/**
 * Packages, and the seats each one includes.
 *
 * The modules-and-plan-administration migration listed what it deliberately was
 * not: "no package definitions, ... no seat counts". This is the first of those
 * two, and only that one. A tenant's package now says how many users it may
 * hold, and inviting past that number is refused.
 *
 * ### Why a table rather than a lookup in code
 *
 * The seat count has to be enforced where users are created, which is SQL, and
 * it has to be rendered where packages are chosen, which is the portal. A
 * constant in the application would be readable by the second and not by the
 * first, so the check would either move into application code — where a
 * concurrent invitation can slip past it — or be duplicated. A table is read by
 * both and is the only copy.
 *
 * It also makes the number an operational fact rather than a deployment: raising
 * the enterprise package from 100 to 150 is an `UPDATE`, not a release.
 *
 * ### What this still is not
 *
 * Not the subscription model from US-070/071. There are no billing periods, no
 * proration, no expiry with a grace window, and no per-tenant negotiated seat
 * count — a tenant's allowance is exactly its package's, and an operator who
 * needs to give one customer more moves them to a bigger package. When the real
 * model lands, `plan.user_limit` is the column a per-tenant override defaults
 * from, and the enforcement below is the check it reuses.
 */

/**
 * The packages, with the seats each includes.
 *
 * Literals rather than an import from the contracts package, matching every
 * earlier migration: a migration is a frozen snapshot, and it must not change
 * meaning when the application's idea of the catalogue moves on. A contract test
 * asserts the two agree.
 *
 * The keys are exactly the four the `tenant_plan_check` constraint has allowed
 * since the tenant-administration migration, so every existing row is already
 * valid against the foreign key that replaces it below.
 */
const PLANS = [
  ["trial", "Trial — evaluating the product", 3],
  ["starter", "Starter — a single team", 10],
  ["growth", "Growth — several teams", 25],
  ["enterprise", "Enterprise — the whole organisation", 100]
];

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  /**
   * Global, not tenant-scoped — like `module` and `permission`, and for the same
   * reason: the set of packages the product *sells* is a property of the
   * product. Which one a tenant *holds* is `tenant.plan`.
   *
   * No `tenant_id`, so `findTablesMissingRlsPolicies()` does not ask this table
   * for a policy, and correctly: there is nothing here to isolate.
   */
  pgm.createTable("plan", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    key: { type: "text", primaryKey: false, notNull: true, unique: true },
    description: { type: "text", notNull: true },
    /**
     * Seats included, counted as rows in `"user"`.
     *
     * `notNull` with no default: a package that forgot to say how many users it
     * includes must fail to insert rather than silently mean zero, which would
     * lock a customer out of their own tenant.
     *
     * Positive rather than non-negative. A zero-seat package cannot be
     * provisioned at all — provisioning creates the first admin — so it could
     * only ever exist as a typo that bricked new tenants.
     */
    user_limit: { type: "integer", notNull: true },
    /** Display order, so the picker is deliberate rather than alphabetical. */
    sort_order: { type: "integer", notNull: true, default: 0 },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  });

  pgm.addConstraint("plan", "plan_user_limit_positive", {
    check: "user_limit > 0"
  });

  pgm.sql(`GRANT SELECT ON plan TO app_user`);

  PLANS.forEach(([key, description, userLimit], index) => {
    pgm.sql(`
      INSERT INTO plan (key, description, user_limit, sort_order)
      VALUES ('${key}', '${description}', ${userLimit}, ${(index + 1) * 10})
      ON CONFLICT (key) DO NOTHING
    `);
  });

  /**
   * The catalogue becomes authoritative, replacing the check constraint.
   *
   * `tenant_plan_check` listed the same four keys as a literal, so with the
   * table in place the two are duplicate definitions of one thing — free to
   * drift, and the drift would show up as a package an operator can select and
   * the database then refuses. A foreign key says it once.
   *
   * `ON UPDATE CASCADE` so renaming a package key carries the tenants with it.
   * `ON DELETE RESTRICT` (the default) so a package cannot be removed while
   * anyone is on it — which is the correct answer: those tenants would be left
   * pointing at nothing, with no seat allowance at all.
   */
  pgm.dropConstraint("tenant", "tenant_plan_check");
  pgm.addConstraint("tenant", "tenant_plan_fkey", {
    foreignKeys: {
      columns: "plan",
      references: "plan(key)",
      onUpdate: "CASCADE",
      onDelete: "RESTRICT"
    }
  });
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  /**
   * The check constraint comes back before the table goes, so the column is
   * never unconstrained — and so the tenant-administration migration's own
   * `down`, which drops `tenant_plan_check`, still finds what it expects if the
   * stack is rolled back further.
   */
  pgm.dropConstraint("tenant", "tenant_plan_fkey");
  pgm.addConstraint("tenant", "tenant_plan_check", {
    check: "plan IN ('trial', 'starter', 'growth', 'enterprise')"
  });

  pgm.sql(`REVOKE ALL ON plan FROM app_user`);
  pgm.dropTable("plan");
};
