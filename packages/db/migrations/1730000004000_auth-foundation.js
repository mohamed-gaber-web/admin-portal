/* eslint-disable */
/**
 * Authentication foundation (sprint S3).
 *
 * One migration for the whole sprint rather than seven, because US-020 to
 * US-026 share a schema and shipping it in pieces would mean each story
 * migrating a table the next one reshapes.
 *
 * Identity model, settled before this was written:
 *   - Local passwords with Argon2id. Not Entra ID.
 *   - `user.email` is unique per tenant, not globally, so a login supplies the
 *     tenant slug alongside the email. Email alone does not identify a person.
 *
 * Nothing here stores a credential in the clear: passwords are hashed by
 * Argon2id, and invitation and refresh tokens are stored as digests. A token
 * column holding a usable token is a second copy of the credential.
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

  // --- Credentials on user ---------------------------------------------
  pgm.addColumn("user", {
    // Null until an invitation is accepted. A user therefore exists before it
    // can sign in, which is what makes the invitation flow (US-020) possible
    // without inventing a placeholder password nobody knows.
    password_hash: { type: "text" },
    password_changed_at: { type: "timestamptz" },
    // invited -> active on first accepted invitation; disabled is an admin act.
    status: { type: "text", notNull: true, default: "invited" },
    last_login_at: { type: "timestamptz" },
    // Lockout state (US-026). Counted on the user, not derived from auth_event,
    // so the check is one indexed read rather than an aggregate over a log that
    // grows without bound.
    failed_login_count: { type: "integer", notNull: true, default: 0 },
    locked_until: { type: "timestamptz" },
    // TOTP shared secret (US-025). The column name contains "secret" so the
    // shared redaction rule keeps it out of logs and audit entries.
    mfa_secret: { type: "text" },
    mfa_enabled_at: { type: "timestamptz" }
  });

  pgm.addConstraint("user", "user_status_check", {
    check: "status IN ('invited', 'active', 'disabled')"
  });

  // An active account with no credential is a contradiction the database can
  // reject outright, rather than one that surfaces as a confusing login bug.
  pgm.addConstraint("user", "user_active_requires_credential_check", {
    check: "status <> 'active' OR password_hash IS NOT NULL"
  });

  // Existing rows predate credentials and have no password, so "invited" is
  // the truthful state rather than a convenient one.
  pgm.sql(`UPDATE "user" SET status = 'invited' WHERE password_hash IS NULL`);

  // Sign-in looks a user up by (tenant, email) — the composite the login DTO
  // supplies. The existing unique constraint already covers it; this index is
  // for the case-insensitive lookup, because addresses are not case sensitive
  // in practice and "Ali@x.com" must not become a second account.
  pgm.sql(`CREATE UNIQUE INDEX user_tenant_email_lower_index ON "user" (tenant_id, lower(email))`);

  // --- Role permissions (closes the gap that made roles decorative) -----
  // `permission` was seeded from the start but nothing joined it to `role`, so
  // a role carried a name and no authority at all.
  pgm.addConstraint("role", "role_id_tenant_unique", { unique: ["id", "tenant_id"] });

  pgm.createTable("role_permission", {
    id: idCol(),
    tenant_id: tenantRef(),
    role_id: { type: "uuid", notNull: true },
    // RESTRICT, not CASCADE: removing a permission from the catalogue must not
    // silently strip it from every role that was granted it.
    permission_id: {
      type: "uuid",
      notNull: true,
      references: "permission",
      onDelete: "RESTRICT"
    },
    created_at: createdAt()
  });

  // Composite key, matching the company/environment pattern: a role belonging
  // to another tenant is rejected by the database rather than by application
  // discipline.
  pgm.addConstraint("role_permission", "role_permission_role_fk", {
    foreignKeys: {
      columns: ["role_id", "tenant_id"],
      references: "role (id, tenant_id)",
      onDelete: "CASCADE"
    }
  });
  pgm.addConstraint("role_permission", "role_permission_unique", {
    unique: ["role_id", "permission_id"]
  });

  // --- Invitations (US-020) --------------------------------------------
  pgm.createTable("user_invitation", {
    id: idCol(),
    tenant_id: tenantRef(),
    user_id: { type: "uuid", notNull: true, references: "user", onDelete: "CASCADE" },
    // The digest, never the token. A leaked database must not yield a working
    // invitation link.
    token_hash: { type: "text", notNull: true, unique: true },
    expires_at: { type: "timestamptz", notNull: true },
    accepted_at: { type: "timestamptz" },
    invited_by: { type: "uuid", references: "user", onDelete: "SET NULL" },
    created_at: createdAt()
  });
  pgm.createIndex("user_invitation", "user_id");

  // --- Refresh tokens with rotation families (US-023) -------------------
  pgm.createTable("refresh_token", {
    id: idCol(),
    tenant_id: tenantRef(),
    user_id: { type: "uuid", notNull: true, references: "user", onDelete: "CASCADE" },
    /**
     * Every token minted by one sign-in shares a family. Rotation issues a new
     * token in the same family; presenting an already-used one means the token
     * leaked, and the whole family is revoked rather than that single token —
     * revoking only the replayed token would leave the thief's newer token
     * working.
     */
    family_id: { type: "uuid", notNull: true },
    token_hash: { type: "text", notNull: true, unique: true },
    parent_id: { type: "uuid", references: "refresh_token", onDelete: "SET NULL" },
    expires_at: { type: "timestamptz", notNull: true },
    /** Set when rotated. A second presentation of a used token is the replay. */
    used_at: { type: "timestamptz" },
    revoked_at: { type: "timestamptz" },
    revoked_reason: { type: "text" },
    ip: { type: "inet" },
    user_agent: { type: "text" },
    created_at: createdAt()
  });
  pgm.createIndex("refresh_token", "family_id");
  pgm.createIndex("refresh_token", "user_id");

  // --- Authentication events -------------------------------------------
  /**
   * Why this is not `audit_log`: `audit_log.tenant_id` is NOT NULL, and the
   * events that matter most here have no tenant. A failed sign-in for an
   * address that exists in no tenant, or for an unknown slug, is exactly the
   * event a security review asks about, and it cannot be written to a table
   * that demands a tenant.
   *
   * `tenant_id` is therefore nullable, and the claimed slug and email are kept
   * as free text — what the caller *asserted*, which is the interesting part
   * when the assertion was wrong.
   */
  pgm.createTable("auth_event", {
    id: idCol(),
    // Nullable, deliberately. See above.
    tenant_id: { type: "uuid", references: "tenant", onDelete: "RESTRICT" },
    user_id: { type: "uuid", references: "user", onDelete: "RESTRICT" },
    /** What the caller claimed, which may match nothing. */
    claimed_slug: { type: "text" },
    claimed_email: { type: "text" },
    /** e.g. login.succeeded, login.failed, token.replayed, account.locked. */
    event: { type: "text", notNull: true },
    outcome: { type: "text", notNull: true },
    /** Never the credential — only why it failed, in general terms. */
    reason: { type: "text" },
    ip: { type: "inet" },
    user_agent: { type: "text" },
    created_at: createdAt()
  });
  pgm.addConstraint("auth_event", "auth_event_outcome_check", {
    check: "outcome IN ('succeeded', 'failed')"
  });
  pgm.createIndex("auth_event", ["claimed_email", "created_at"], {
    name: "auth_event_email_created_index"
  });
  pgm.createIndex("auth_event", ["tenant_id", "created_at"], {
    name: "auth_event_tenant_created_index"
  });

  // --- Append-only, for both security logs ------------------------------
  // A generic guard rather than reusing audit_log's: a migration is a frozen
  // snapshot, so renaming the existing function is not available.
  pgm.sql(`
    CREATE FUNCTION raise_append_only() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
        USING ERRCODE = '42501';
    END $$;
  `);
  pgm.sql(`
    CREATE TRIGGER auth_event_no_update BEFORE UPDATE ON auth_event
      FOR EACH ROW EXECUTE FUNCTION raise_append_only()
  `);
  pgm.sql(`
    CREATE TRIGGER auth_event_no_delete BEFORE DELETE ON auth_event
      FOR EACH ROW EXECUTE FUNCTION raise_append_only()
  `);
  pgm.sql(`
    CREATE TRIGGER auth_event_no_truncate BEFORE TRUNCATE ON auth_event
      FOR EACH STATEMENT EXECUTE FUNCTION raise_append_only()
  `);

  // --- Grants and row level security ------------------------------------
  pgm.sql(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      role_permission, user_invitation, refresh_token
    TO app_user
  `);
  // Append-only for the application: it may record events and read its own
  // tenant's, never rewrite them.
  pgm.sql(`GRANT SELECT, INSERT ON auth_event TO app_user`);

  for (const table of ["role_permission", "user_invitation", "refresh_token"]) {
    pgm.sql(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
    pgm.sql(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    pgm.sql(`
      CREATE POLICY tenant_isolation ON "${table}"
        USING (tenant_id = current_tenant_id())
        WITH CHECK (tenant_id = current_tenant_id())
    `);
  }

  /**
   * auth_event needs a split policy, because reads and writes happen at
   * different points in the request.
   *
   * Writes come from authentication itself, which by definition runs before a
   * tenant is in the session — a write policy conditioned on
   * current_tenant_id() would make the failed-login case unrecordable, which is
   * the case that matters. Reads stay strictly scoped.
   *
   * The trade-off accepted here: a session scoped to tenant A can append an
   * event naming tenant B. That is worth it against the alternative of not
   * recording failed sign-ins at all, and the rows are immutable once written.
   * Platform-level rows (tenant_id NULL) are visible only through
   * withoutTenantScope().
   */
  pgm.sql(`ALTER TABLE auth_event ENABLE ROW LEVEL SECURITY`);
  pgm.sql(`ALTER TABLE auth_event FORCE ROW LEVEL SECURITY`);
  pgm.sql(`CREATE POLICY auth_event_append ON auth_event FOR INSERT WITH CHECK (true)`);
  pgm.sql(`
    CREATE POLICY auth_event_read ON auth_event FOR SELECT
      USING (tenant_id = current_tenant_id())
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.sql(`DROP POLICY IF EXISTS auth_event_read ON auth_event`);
  pgm.sql(`DROP POLICY IF EXISTS auth_event_append ON auth_event`);

  for (const table of ["role_permission", "user_invitation", "refresh_token"]) {
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON "${table}"`);
  }

  pgm.sql(`REVOKE ALL ON auth_event FROM app_user`);
  pgm.sql(`REVOKE ALL ON role_permission, user_invitation, refresh_token FROM app_user`);

  pgm.sql(`DROP TRIGGER IF EXISTS auth_event_no_truncate ON auth_event`);
  pgm.sql(`DROP TRIGGER IF EXISTS auth_event_no_delete ON auth_event`);
  pgm.sql(`DROP TRIGGER IF EXISTS auth_event_no_update ON auth_event`);

  pgm.dropTable("auth_event");
  pgm.dropTable("refresh_token");
  pgm.dropTable("user_invitation");
  pgm.dropTable("role_permission");

  pgm.sql(`DROP FUNCTION IF EXISTS raise_append_only()`);

  pgm.dropConstraint("role", "role_id_tenant_unique");

  pgm.sql(`DROP INDEX IF EXISTS user_tenant_email_lower_index`);
  pgm.dropConstraint("user", "user_active_requires_credential_check");
  pgm.dropConstraint("user", "user_status_check");
  pgm.dropColumn("user", [
    "password_hash",
    "password_changed_at",
    "status",
    "last_login_at",
    "failed_login_count",
    "locked_until",
    "mfa_secret",
    "mfa_enabled_at"
  ]);
};
