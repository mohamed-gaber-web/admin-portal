/* eslint-disable */
/**
 * New tenants start with 25 seats, not 3.
 *
 * The tenant-administration migration defaulted `tenant.plan` to `trial`, and
 * the plan-seat-limits migration then gave trial three seats — so provisioning
 * a customer produced a workspace that was full after two colleagues. That was
 * the right default while a plan was only a badge on a screen; once the number
 * became enforced it made the common case the broken one.
 *
 * ### Why the column default rather than trial's seat count
 *
 * Raising trial from 3 to 25 would have got the same number onto new tenants
 * and cost the catalogue its meaning: a "Trial" package that includes as much
 * as "Growth" is not a trial, and the four packages would no longer be four
 * distinct things an operator is choosing between. The default names which
 * package a new customer starts on, which is the question actually being
 * answered, and `growth` is the one that includes 25.
 *
 * ### What this does not touch
 *
 * Existing tenants. A column default applies to rows inserted after it, so
 * every tenant already provisioned keeps the package it holds — including the
 * ones on trial, deliberately: silently upgrading a customer's package is a
 * commercial act, and this migration is a change to a default, not a decision
 * about anybody's contract. An operator moves them individually, which is what
 * the tenant screen is for.
 *
 * `UNSUBSCRIBED_PLAN` also stays `trial`. Unsubscribing should reduce a tenant
 * to the smallest package, and that is still the one it names.
 */

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.alterColumn("tenant", "plan", { default: "growth" });
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.alterColumn("tenant", "plan", { default: "trial" });
};
