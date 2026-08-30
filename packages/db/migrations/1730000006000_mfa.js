/* eslint-disable */
/**
 * Multi-factor authentication (US-025).
 *
 * `user.mfa_secret` and `user.mfa_enabled_at` already exist from the S3
 * foundation. Two things it did not anticipate are added here:
 *
 *   - recovery codes, so losing a phone is not losing the account;
 *   - a record of which time steps have been spent, which is what stops a TOTP
 *     code being replayed inside the window where it is still valid.
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

  pgm.createTable("mfa_recovery_code", {
    id: idCol(),
    tenant_id: tenantRef(),
    user_id: { type: "uuid", notNull: true, references: "user", onDelete: "CASCADE" },
    // The digest, never the code. Recovery codes bypass the second factor
    // entirely, so a leaked table would be a leaked bypass for every admin.
    code_hash: { type: "text", notNull: true, unique: true },
    used_at: { type: "timestamptz" },
    created_at: createdAt()
  });
  pgm.createIndex("mfa_recovery_code", "user_id");

  /**
   * One row per TOTP time step a user has spent.
   *
   * The step, not the code: a code is derived from the step, so recording the
   * step is enough to refuse a second presentation, and it means the table
   * never holds anything that could be replayed if it leaked.
   *
   * The unique constraint is the enforcement, not the application's check —
   * two simultaneous presentations of one code both pass a SELECT, and only
   * one can win an INSERT.
   */
  pgm.createTable("mfa_code_use", {
    id: idCol(),
    tenant_id: tenantRef(),
    user_id: { type: "uuid", notNull: true, references: "user", onDelete: "CASCADE" },
    step: { type: "bigint", notNull: true },
    created_at: createdAt()
  });
  pgm.addConstraint("mfa_code_use", "mfa_code_use_user_step_unique", {
    unique: ["user_id", "step"]
  });

  pgm.sql(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_recovery_code, mfa_code_use TO app_user
  `);

  for (const table of ["mfa_recovery_code", "mfa_code_use"]) {
    pgm.sql(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
    pgm.sql(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    pgm.sql(`
      CREATE POLICY tenant_isolation ON "${table}"
        USING (tenant_id = current_tenant_id())
        WITH CHECK (tenant_id = current_tenant_id())
    `);
  }
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  for (const table of ["mfa_recovery_code", "mfa_code_use"]) {
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON "${table}"`);
  }
  pgm.sql(`REVOKE ALL ON mfa_recovery_code, mfa_code_use FROM app_user`);
  pgm.dropTable("mfa_code_use");
  pgm.dropTable("mfa_recovery_code");
};
