/* eslint-disable */
/**
 * Password reset tokens (US-024).
 *
 * A separate table from `user_invitation` rather than a reused one. They look
 * alike — a hashed single-use token with an expiry — but they answer different
 * questions ("has this person ever had a credential" versus "is this person
 * replacing one"), they expire on different timescales, and collapsing them
 * would make "invited but never accepted" indistinguishable from "reset and
 * never completed".
 */

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  const idCol = () => ({ type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") });
  const createdAt = () => ({ type: "timestamptz", notNull: true, default: pgm.func("now()") });
  const tenantRef = () => ({
    type: "uuid",
    notNull: true,
    references: "tenant",
    onDelete: "CASCADE"
  });

  pgm.createTable("password_reset", {
    id: idCol(),
    tenant_id: tenantRef(),
    user_id: { type: "uuid", notNull: true, references: "user", onDelete: "CASCADE" },
    // The digest, never the token. A leaked database must not yield a working
    // reset link — which would be a way to take over every account at once.
    token_hash: { type: "text", notNull: true, unique: true },
    expires_at: { type: "timestamptz", notNull: true },
    /** Set when redeemed. A second presentation is refused. */
    used_at: { type: "timestamptz" },
    /** Who asked. Useful when a burst of requests arrives for one tenant. */
    requested_ip: { type: "inet" },
    created_at: createdAt()
  });
  pgm.createIndex("password_reset", "user_id");

  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON password_reset TO app_user`);

  // Carries tenant_id, so it needs a policy — the US-011 audit fails CI on any
  // tenant table without one.
  pgm.sql(`ALTER TABLE password_reset ENABLE ROW LEVEL SECURITY`);
  pgm.sql(`ALTER TABLE password_reset FORCE ROW LEVEL SECURITY`);
  pgm.sql(`
    CREATE POLICY tenant_isolation ON password_reset
      USING (tenant_id = current_tenant_id())
      WITH CHECK (tenant_id = current_tenant_id())
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON password_reset`);
  pgm.sql(`REVOKE ALL ON password_reset FROM app_user`);
  pgm.dropTable("password_reset");
};
