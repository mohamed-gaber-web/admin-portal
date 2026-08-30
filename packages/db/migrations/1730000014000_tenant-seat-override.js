/* eslint-disable */
/**
 * A per-tenant seat allowance, overriding the package's.
 *
 * The plan-seat-limits migration made a tenant's allowance exactly its
 * package's, and said so: "no per-tenant negotiated seat count — an operator who
 * needs to give one customer more moves them to a bigger package." That held
 * until the first customer negotiated 40 seats on a package that includes 25,
 * which is the ordinary shape of enterprise sales rather than an edge case.
 *
 * ### Why a nullable column rather than a number on every tenant
 *
 * NULL means "whatever the package includes", and it is the default, so a tenant
 * nobody has negotiated with carries no number of its own. That matters when the
 * package's allowance changes: raising Growth from 25 to 30 lifts every Growth
 * tenant that has not been given a specific figure, and leaves alone the ones
 * that have. A column defaulted to the package's value at creation time would
 * silently freeze every tenant at whatever the number was on the day they signed
 * up, and nothing afterwards could tell an inherited 25 from a negotiated one.
 *
 * So the effective allowance is `COALESCE(tenant.seat_limit, plan.user_limit)`,
 * computed at every read rather than stored. There is exactly one place a seat
 * count is decided, which is the point.
 */

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumn("tenant", {
    /**
     * Seats this tenant may hold, when it differs from its package.
     *
     * Nullable, and null is the normal state: it means "inherit the package".
     * See the note above for why that is not the same as copying the number in.
     */
    seat_limit: { type: "integer", notNull: false }
  });

  /**
   * Positive when present, mirroring `plan_user_limit_positive`.
   *
   * A zero-seat override would lock a tenant out of its own workspace with no
   * screen that could undo it — the tenant's administrators are users, and
   * users are what the limit counts.
   */
  pgm.addConstraint("tenant", "tenant_seat_limit_positive", {
    check: "seat_limit IS NULL OR seat_limit > 0"
  });
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropConstraint("tenant", "tenant_seat_limit_positive");
  pgm.dropColumn("tenant", "seat_limit");
};
