/* eslint-disable */
/**
 * Email becomes a global identity.
 *
 * Until now `user.email` was unique *within* a tenant, so an address alone did
 * not identify anybody — three people at three clients could share one, and
 * sign-in therefore took `(slug, email, password)`. The slug was not decoration:
 * it was half of the primary identity.
 *
 * The product decision is that a person signs in with an address and a password,
 * and the portal tells them which workspace they landed in. That only has one
 * answer if an address belongs to exactly one person, which is what this
 * migration enforces.
 *
 * ### What this gives up
 *
 * The same human can no longer hold accounts in two tenants under one address.
 * That is a real constraint, not an oversight — it is the price of the address
 * being an identity. A consultant working for two clients needs two addresses,
 * the same way they would with any single-sign-on directory.
 *
 * ### Why it refuses rather than repairs
 *
 * A duplicate found here is two *different people* who happen to share an
 * address string, and there is no rule this migration could apply that picks the
 * right one. Renaming one silently would lock a real user out with no record of
 * why; deleting one destroys their history. So it stops and names the rows, and
 * whoever operates the installation decides. On a fresh installation, and on the
 * demo seed, there is nothing to decide — every address is already distinct.
 */

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  /**
   * Refuse before changing anything.
   *
   * `CREATE UNIQUE INDEX` would fail on its own, but with `duplicate key value
   * violates unique constraint` and one example row — which is the least useful
   * possible description of "you have to merge these accounts". This raises the
   * whole list, and says what to do about it.
   */
  pgm.sql(`
    DO $$
    DECLARE
      duplicates text;
    BEGIN
      SELECT string_agg(detail, E'\\n  ') INTO duplicates
        FROM (
          SELECT lower(u.email) || ' in ' || string_agg(t.slug, ', ' ORDER BY t.slug) AS detail
            FROM "user" u
            JOIN tenant t ON t.id = u.tenant_id
           GROUP BY lower(u.email)
          HAVING count(*) > 1
        ) AS clashes;

      IF duplicates IS NOT NULL THEN
        -- % is the placeholder in RAISE, and the newlines are folded into the
        -- argument rather than the format string so the message stays readable
        -- here and in a terminal.
        RAISE EXCEPTION
          'Cannot make email a global identity. These addresses exist in more than one tenant:%',
          E'\\n  ' || duplicates ||
          E'\\n\\nChange one side of each pair to a distinct address, then re-run the migration.'
          USING ERRCODE = '23505';
      END IF;
    END $$;
  `);

  /**
   * On `lower(email)`, matching how every lookup already reads it.
   *
   * `authenticate()` and `requestPasswordReset()` both compare
   * `lower(u.email) = lower($1)`, so an index on the raw column would leave
   * `Ada@acme.test` and `ada@acme.test` as two rows that both answer one
   * sign-in — a uniqueness rule the application would then have to enforce
   * itself, which is the arrangement this replaces. It also makes those lookups
   * index scans rather than sequential ones, which now matter: sign-in searches
   * the whole table instead of one tenant's slice of it.
   */
  pgm.sql(`CREATE UNIQUE INDEX user_email_global_unique ON "user" (lower(email))`);

  /**
   * `user_tenant_email_unique` is deliberately left in place.
   *
   * It is implied by the index above and so enforces nothing new. Dropping it
   * would be tidier and is not worth it: it is the constraint every earlier
   * migration and every foreign key comment refers to, and keeping it means this
   * migration is reversible without recreating a constraint that other objects
   * may depend on.
   */
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS user_email_global_unique`);
};
