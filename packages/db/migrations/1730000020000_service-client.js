/* eslint-disable */
/**
 * Service clients: machine credentials for reading a tenant's ERP data.
 *
 * Every credential before this one belongs to a person: a password, a second
 * factor, a refresh token that dies if it is presented twice. That is right for
 * people and wrong for a scheduled job, which cannot answer an MFA prompt and
 * cannot safely share a single-use refresh token across restarts.
 *
 * A service client is narrower than any user, on purpose:
 *
 *   - it belongs to one tenant, fenced by the same isolation policy as
 *     everything else;
 *   - it holds scopes, not roles, and the CHECK below admits exactly one scope
 *     today: reading ERP data. It can never be granted a tenant permission;
 *   - its secret is stored as a SHA-256 digest only. It is 256 random bits, so
 *     there is nothing to guess and no reason to pay for Argon2id on a path an
 *     unauthenticated caller can reach (same reasoning as refresh tokens);
 *   - it is revoked, never deleted, so the auth_event rows that name it keep
 *     meaning something.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable("service_client", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    tenant_id: { type: "uuid", notNull: true, references: "tenant", onDelete: "CASCADE" },
    /** What it is for, e.g. "ONE365 reports sync". Shown in listings and logs. */
    name: { type: "text", notNull: true },
    /** Public identifier, `svc_…`. Not a secret; unique across the installation. */
    client_id: { type: "text", notNull: true, unique: true },
    /** SHA-256 hex digest of the secret. The secret itself is shown once. */
    secret_hash: { type: "text", notNull: true },
    scopes: { type: "text[]", notNull: true },
    created_by: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    last_used_at: { type: "timestamptz" },
    revoked_at: { type: "timestamptz" },
    revoked_reason: { type: "text" }
  });
  pgm.createIndex("service_client", "tenant_id");

  pgm.addConstraint("service_client", "service_client_scopes_check", {
    // The allowlist lives in the database, so a bug in the application cannot
    // mint a client with a scope nobody reviewed.
    check: "cardinality(scopes) > 0 AND scopes <@ ARRAY['d365.data.read']::text[]"
  });
  pgm.addConstraint("service_client", "service_client_name_check", {
    check: "length(btrim(name)) BETWEEN 1 AND 120"
  });

  // No DELETE: revocation is an UPDATE, and history stays.
  pgm.sql(`GRANT SELECT, INSERT, UPDATE ON service_client TO app_user`);
  pgm.sql(`ALTER TABLE service_client ENABLE ROW LEVEL SECURITY`);
  pgm.sql(`ALTER TABLE service_client FORCE ROW LEVEL SECURITY`);
  pgm.sql(`
    CREATE POLICY tenant_isolation ON service_client
      USING (tenant_id = current_tenant_id())
      WITH CHECK (tenant_id = current_tenant_id())
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON service_client`);
  pgm.sql(`REVOKE ALL ON service_client FROM app_user`);
  pgm.dropTable("service_client");
};
