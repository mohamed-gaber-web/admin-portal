/* eslint-disable */
/**
 * Append-only audit log.
 *
 * Adds the attribution the compliance story needs (actor label, IP, before and
 * after values, changed fields) and makes entries immutable.
 *
 * Immutability is enforced by triggers rather than by revoking privileges,
 * because privilege checks do not apply to superusers or table owners while
 * triggers do. This is tamper-RESISTANT, not tamper-proof: a superuser can
 * still DISABLE TRIGGER or drop them. Genuine immutability means shipping
 * entries to append-only storage outside this database.
 */

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumn("audit_log", {
    actor_label: { type: "text" },
    actor_ip: { type: "inet" },
    before_values: { type: "jsonb" },
    after_values: { type: "jsonb" },
    changed_fields: { type: "text[]" }
  });

  // Rows written before this migration have no attribution. Mark them as such
  // rather than inventing an actor for them.
  pgm.sql(`UPDATE audit_log SET actor_label = 'unknown:pre-audit' WHERE actor_label IS NULL`);
  // No default: every writer must name an actor, or unattributed entries creep
  // in silently and the column stops meaning anything.
  pgm.alterColumn("audit_log", "actor_label", { notNull: true });

  // An audit log you can erase by deleting its subject is not an audit log.
  // CASCADE and SET NULL would both have to modify existing entries, which the
  // triggers below forbid — so make the refusal an explicit foreign key error
  // rather than a confusing trigger failure.
  pgm.sql(`ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_tenant_id_fkey`);
  pgm.sql(`
    ALTER TABLE audit_log ADD CONSTRAINT audit_log_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES tenant(id) ON DELETE RESTRICT
  `);
  pgm.sql(`ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_user_id_fkey`);
  pgm.sql(`
    ALTER TABLE audit_log ADD CONSTRAINT audit_log_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE RESTRICT
  `);

  pgm.sql(`
    CREATE FUNCTION audit_log_is_append_only() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP
        USING ERRCODE = '42501';
    END $$;
  `);

  pgm.sql(`
    CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only()
  `);
  pgm.sql(`
    CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only()
  `);
  // TRUNCATE is a delete-all by another name.
  pgm.sql(`
    CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
      FOR EACH STATEMENT EXECUTE FUNCTION audit_log_is_append_only()
  `);

  // Defence in depth: the application role cannot even attempt a change.
  pgm.sql(`REVOKE UPDATE, DELETE ON audit_log FROM app_user`);

  // Compliance reads are "what happened to this tenant, in order".
  pgm.createIndex("audit_log", ["tenant_id", "created_at"], {
    name: "audit_log_tenant_created_index"
  });
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropIndex("audit_log", ["tenant_id", "created_at"], {
    name: "audit_log_tenant_created_index"
  });

  pgm.sql(`GRANT UPDATE, DELETE ON audit_log TO app_user`);

  pgm.sql(`DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log`);
  pgm.sql(`DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log`);
  pgm.sql(`DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log`);
  pgm.sql(`DROP FUNCTION IF EXISTS audit_log_is_append_only()`);

  // Restore US-002's referential behaviour.
  pgm.sql(`ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_user_id_fkey`);
  pgm.sql(`
    ALTER TABLE audit_log ADD CONSTRAINT audit_log_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE SET NULL
  `);
  pgm.sql(`ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_tenant_id_fkey`);
  pgm.sql(`
    ALTER TABLE audit_log ADD CONSTRAINT audit_log_tenant_id_fkey
      FOREIGN KEY (tenant_id) REFERENCES tenant(id) ON DELETE CASCADE
  `);

  pgm.dropColumn("audit_log", "changed_fields");
  pgm.dropColumn("audit_log", "after_values");
  pgm.dropColumn("audit_log", "before_values");
  pgm.dropColumn("audit_log", "actor_ip");
  pgm.dropColumn("audit_log", "actor_label");
};
