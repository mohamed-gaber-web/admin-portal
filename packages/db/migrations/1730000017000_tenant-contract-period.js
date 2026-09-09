/* eslint-disable */
/**
 * The period a tenant's contract runs for.
 *
 * Two dates on `tenant`, so an operator can record what a customer actually
 * signed and the profile can say how much of it is left. Until now the only
 * commercial facts stored were the package and the seat allowance — both of
 * them "what they get", with nothing anywhere saying "until when".
 *
 * ### `date`, not `timestamptz`
 *
 * Every other time column in this schema is `timestamptz`, and this one
 * deliberately is not. Those record *when something happened* — an instant, and
 * an instant is the same moment everywhere. A contract period is a statement
 * about calendar days: a contract that ends on 31 December ends on 31 December
 * for the customer, for the operator reading the screen in another country, and
 * for the server, whatever any of their clocks say. Stored as `timestamptz` it
 * would be an instant rendered differently per timezone, and "expires today"
 * would be true a day early or a day late depending on who was looking.
 *
 * ### Nullable, and both independently
 *
 * Every tenant that exists today has no contract recorded, and inventing one
 * from `created_at` would be fabricating a commercial fact nobody agreed to.
 * Null means "not recorded", which is honest and is what the profile shows.
 *
 * The two are separately nullable rather than a filled-in-together pair,
 * because a real one arrives that way: a start date is known at signing and an
 * end date is sometimes open until a term is agreed. The check constraint below
 * enforces only the thing that is always wrong — an end before its start.
 *
 * ### What this deliberately is not
 *
 * Not the subscription model from US-070/071. There is no renewal, no billing
 * period, no grace window, no history of previous terms — an edit overwrites,
 * and the audit log is where the previous term survives. Nothing enforces
 * expiry either: a lapsed contract is shown, loudly, and what to do about it
 * stays an operator's decision on the lifecycle card. Locking a customer out of
 * their own data on a date is a harsher act than not renewing them, and it is
 * not one this migration quietly grants.
 */

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumn("tenant", {
    contract_start_date: { type: "date" },
    contract_end_date: { type: "date" }
  });

  /**
   * The one combination that is always a mistake.
   *
   * `NOT VALID` is deliberately *not* used: there is no existing data to
   * grandfather — both columns were created null by the statement above — so
   * the constraint can be validated immediately and be true of every row from
   * the moment it exists.
   *
   * Equal dates pass. A single-day contract is a real thing (a pilot, a trial
   * extension), and refusing it would be the constraint inventing policy.
   */
  pgm.addConstraint("tenant", "tenant_contract_period_ordered", {
    check: `contract_start_date IS NULL
            OR contract_end_date IS NULL
            OR contract_end_date >= contract_start_date`
  });

  /**
   * Answers "whose contract expires soon" without reading every tenant.
   *
   * Partial, on the end date alone: the rows worth finding are the ones that
   * have an end date, and on an installation where most tenants have no
   * contract recorded a full index would be mostly nulls.
   */
  pgm.createIndex("tenant", "contract_end_date", {
    where: "contract_end_date IS NOT NULL"
  });
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropIndex("tenant", "contract_end_date", {
    where: "contract_end_date IS NOT NULL",
    ifExists: true
  });
  pgm.dropConstraint("tenant", "tenant_contract_period_ordered", { ifExists: true });
  pgm.dropColumn("tenant", ["contract_start_date", "contract_end_date"]);
};
