/* eslint-disable */
/**
 * D365 connection configuration and mobile runtime configuration (US-040).
 *
 * The Ionic app ships a hardcoded `environment.ts` holding one tenant's D365
 * credentials. This migration is the schema half of removing it, and the shape
 * here is driven entirely by one observation about that file: it mixes two
 * things with **different audiences**, and storing them in one place would carry
 * the mistake into the database.
 *
 *   environment.auth.*        client_credentials, a client *secret*, and the
 *                             `.default` scope — application-level access to the
 *                             whole ERP, with no user context. Shipping it to a
 *                             device puts a full-access ERP credential inside
 *                             every installed APK. It belongs to the API alone,
 *                             so it lands on `d365_environment` and is sealed.
 *
 *   environment.userAuth.*    a *public* client. It holds no secret by design —
 *                             that is what "public client" means — and the
 *                             device genuinely needs it before it has any
 *                             session. It lands in `tenant_mobile_config`, which
 *                             an unauthenticated bootstrap endpoint may read.
 *
 * Two tables, because the boundary between them is the entire point of the
 * story. A single `config` blob would make "is this field safe to serve to a
 * device" a question about a JSON key rather than about which table it is in.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // --- The confidential half: D365 service credentials -------------------
  /**
   * Added to `d365_environment` rather than to a `d365_connection` table of its
   * own.
   *
   * A connection is one-to-one with an environment and cannot outlive it: an
   * environment is *defined* by the D365 instance it points at. A separate table
   * would model an optional relationship that does not exist, and would need its
   * own RLS policy for a row that is already fenced by this table's.
   */
  pgm.addColumns("d365_environment", {
    /**
     * The Entra ID directory the service principal lives in — the GUID in the
     * middle of the token URL.
     *
     * The *tenant id*, not the assembled `tokenUrl`. A URL stored whole is a URL
     * somebody eventually edits into a host of their choosing, and the token
     * endpoint is where the client secret is presented — so the one field an
     * attacker with write access would want to change is the one this schema
     * declines to store.
     */
    entra_tenant_id: { type: "text" },

    /**
     * The Entra authority host. Defaulted, because there is one right answer for
     * every commercial-cloud customer and this must not become a question asked
     * on the configuration form.
     *
     * It exists at all because sovereign clouds are real and already named:
     * `login.microsoftonline.us` (US Gov) and `login.partner.microsoftonline.cn`
     * (China) serve the same protocol from a different host. Constrained rather
     * than free text — an arbitrary host here would redirect every token
     * request, secret included, to whatever was typed.
     */
    entra_authority_host: {
      type: "text",
      notNull: true,
      default: "login.microsoftonline.com"
    },

    /** The confidential client's application id. Not a secret; identifies it. */
    client_id: { type: "text" },

    /**
     * The client secret, sealed by `sealSecret()` — never plaintext.
     *
     * Encrypted rather than hashed, for the reason `user.mfa_secret` is: the API
     * has to reproduce it to request a token, so a one-way digest is not
     * available. That makes `SECRET_ENCRYPTION_KEY` the real boundary, and the
     * sprint's exit criterion — "no client secret is recoverable from the
     * database alone" — is a statement about that key living somewhere this
     * database does not.
     *
     * The `_sealed` suffix is deliberate: a column named `client_secret` invites
     * the next person to write a plaintext value into it.
     */
    client_secret_sealed: { type: "text" },

    /** When the secret was last replaced. Shown as "rotated 40 days ago". */
    client_secret_updated_at: { type: "timestamptz" },

    /**
     * When Entra will stop accepting it (US-044).
     *
     * Entra secrets expire — 6, 12 or 24 months — and the failure mode is the
     * whole integration stopping at once, on a date nobody recorded. Typed in by
     * the administrator because the token endpoint does not report it.
     */
    client_secret_expires_at: { type: "timestamptz" },

    /**
     * Whether the last check reached D365. Denormalised deliberately: the
     * tenant detail screen renders a badge per environment, and it must not have
     * to make a live token request to draw a list.
     */
    connection_state: { type: "text", notNull: true, default: "not_configured" },

    /** When that state was established. A state with no age is not evidence. */
    connection_checked_at: { type: "timestamptz" },

    /**
     * Why the last check failed, as one of a fixed set of reason codes.
     *
     * A code, never the identity provider's own message. Entra's
     * `error_description` is free text containing correlation ids, timestamps
     * and the client id, it changes without notice, and pasting a
     * third party's error text into a column is how a credential eventually
     * lands in one. The set below is what an administrator can actually act on.
     */
    connection_error: { type: "text" }
  });

  pgm.addConstraint("d365_environment", "d365_environment_connection_state_check", {
    check: "connection_state IN ('connected', 'failing', 'not_configured')"
  });

  pgm.addConstraint("d365_environment", "d365_environment_connection_error_check", {
    check: `connection_error IS NULL OR connection_error IN (
      'invalid_client', 'invalid_tenant', 'invalid_scope', 'unreachable', 'unexpected'
    )`
  });

  pgm.addConstraint("d365_environment", "d365_environment_authority_host_check", {
    check: `entra_authority_host IN (
      'login.microsoftonline.com',
      'login.microsoftonline.us',
      'login.partner.microsoftonline.cn'
    )`
  });

  /**
   * A connection is configured completely or not at all.
   *
   * Half a connection is the state that produces the worst bug available here:
   * a token request assembled from a tenant id and a client id with no secret
   * fails at Entra, which reports it as a bad *client* — so the administrator
   * reads "invalid client" and starts changing the field that was already
   * correct. The database refuses the state instead.
   */
  pgm.addConstraint("d365_environment", "d365_environment_connection_complete_check", {
    check: `(
      (entra_tenant_id IS NULL AND client_id IS NULL AND client_secret_sealed IS NULL)
      OR
      (entra_tenant_id IS NOT NULL AND client_id IS NOT NULL AND client_secret_sealed IS NOT NULL)
    )`
  });

  /**
   * An unconfigured environment cannot claim a connection state.
   *
   * Without this, clearing a connection while leaving `connection_state` at
   * `connected` leaves a badge saying the integration works on an environment
   * holding no credentials at all.
   */
  pgm.addConstraint("d365_environment", "d365_environment_state_requires_config_check", {
    check: "client_id IS NOT NULL OR connection_state = 'not_configured'"
  });

  // --- The public half: what a device may be told ------------------------
  /**
   * One row per tenant, holding exactly the fields the mobile app needs before
   * it has authenticated — and nothing else.
   *
   * The safety property is structural rather than a rule someone follows: the
   * bootstrap endpoint reads this table and only this table, so a field cannot
   * become device-readable by accident. Making a new field public is a
   * migration, which is a review.
   */
  pgm.createTable("tenant_mobile_config", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    tenant_id: { type: "uuid", notNull: true, references: "tenant", onDelete: "CASCADE" },

    /**
     * Where the app sends its API calls. Per tenant, not per build: this is the
     * field that lets one binary serve every customer, which is the whole
     * reason `environment.ts` is being dismantled.
     */
    api_base_url: { type: "text", notNull: true },

    /**
     * The Entra *public* client the app signs users in with — the `userAuth`
     * half of `environment.ts`.
     *
     * Nullable as a set, because it is transitional. The portal's own
     * authentication (US-021 onward) is local, and US-102 runs both side by side
     * during rollout; a tenant past cutover has no Entra sign-in at all, and
     * null says that plainly rather than leaving a dead client id configured.
     *
     * No secret column here, and there must never be one. A client that can keep
     * a secret is not a public client, and a secret that reaches a device is not
     * a secret.
     */
    user_auth_client_id: { type: "text" },
    user_auth_authority: { type: "text" },
    user_auth_redirect_uri: { type: "text" },
    user_auth_scopes: { type: "text[]", notNull: true, default: "{}" },

    /**
     * The oldest app build this tenant will serve (US-103).
     *
     * Here rather than in a global config because van sales devices update
     * slowly and unevenly, and the sprint plan says the cutover is per tenant.
     */
    minimum_app_version: { type: "text" },

    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  });

  // One configuration per tenant. A second row would make "which one does the
  // device get" a question answered by ORDER BY.
  pgm.addConstraint("tenant_mobile_config", "tenant_mobile_config_tenant_unique", {
    unique: ["tenant_id"]
  });
  pgm.createIndex("tenant_mobile_config", "tenant_id");

  /**
   * The userAuth block is present as a whole or absent as a whole, for the same
   * reason the D365 connection is: a client id with no authority produces a
   * sign-in attempt against nothing, and the app cannot report that usefully.
   */
  pgm.addConstraint("tenant_mobile_config", "tenant_mobile_config_user_auth_complete_check", {
    check: `(
      (user_auth_client_id IS NULL AND user_auth_authority IS NULL AND user_auth_redirect_uri IS NULL)
      OR
      (user_auth_client_id IS NOT NULL AND user_auth_authority IS NOT NULL AND user_auth_redirect_uri IS NOT NULL)
    )`
  });

  // --- Isolation ---------------------------------------------------------
  // A new tenant-scoped table with no policy is reported by
  // findTablesMissingRlsPolicies() and fails CI (US-011). The grant is explicit
  // per table, matching the RLS migration's convention.
  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_mobile_config TO app_user`);
  pgm.sql(`ALTER TABLE tenant_mobile_config ENABLE ROW LEVEL SECURITY`);
  pgm.sql(`ALTER TABLE tenant_mobile_config FORCE ROW LEVEL SECURITY`);
  pgm.sql(`
    CREATE POLICY tenant_isolation ON tenant_mobile_config
      USING (tenant_id = current_tenant_id())
      WITH CHECK (tenant_id = current_tenant_id())
  `);

  // --- Permissions -------------------------------------------------------
  /**
   * `connection.read` and `connection.write` already exist — the tenant
   * administration migration installed them for screens that had nothing to
   * read yet. Nothing to add: this migration is what finally gives them
   * something to authorise.
   */
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 *
 * Structurally reversible, and deliberately not data-reversible: rolling back
 * drops every sealed secret. That is the correct outcome — a sealed value this
 * schema no longer describes is unreadable anyway, and keeping it would leave
 * ciphertext nobody can account for.
 */
exports.down = (pgm) => {
  pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON tenant_mobile_config`);
  pgm.sql(`ALTER TABLE tenant_mobile_config NO FORCE ROW LEVEL SECURITY`);
  pgm.sql(`ALTER TABLE tenant_mobile_config DISABLE ROW LEVEL SECURITY`);
  pgm.sql(`REVOKE ALL ON tenant_mobile_config FROM app_user`);
  pgm.dropTable("tenant_mobile_config");

  pgm.dropConstraint("d365_environment", "d365_environment_state_requires_config_check");
  pgm.dropConstraint("d365_environment", "d365_environment_connection_complete_check");
  pgm.dropConstraint("d365_environment", "d365_environment_authority_host_check");
  pgm.dropConstraint("d365_environment", "d365_environment_connection_error_check");
  pgm.dropConstraint("d365_environment", "d365_environment_connection_state_check");

  pgm.dropColumns("d365_environment", [
    "entra_tenant_id",
    "entra_authority_host",
    "client_id",
    "client_secret_sealed",
    "client_secret_updated_at",
    "client_secret_expires_at",
    "connection_state",
    "connection_checked_at",
    "connection_error"
  ]);
};
