/* eslint-disable */
/**
 * A tenant's own logo, shown in the mobile app beside the Grow Path mark.
 *
 * On `tenant_mobile_config` rather than a table of its own, because of what that
 * table already is: the one place whose every column a device may be told
 * before it has a session. A logo is exactly that kind of value, and keeping it
 * there means the bootstrap read stays a read of one table — the structural
 * property the US-040 migration was built around.
 *
 * Stored in the database rather than in object storage because there is none in
 * this deployment, and a small capped image does not justify adding one. The
 * cap is what makes that defensible, so it is a check constraint rather than a
 * rule in the API: an image stored here travels inside every bootstrap
 * response a device downloads.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumns("tenant_mobile_config", {
    /**
     * Raster formats only. SVG is refused on purpose: it is a document that can
     * carry script, and this value is rendered on every device in the tenant.
     */
    logo_content_type: { type: "text" },
    logo_data: { type: "bytea" },
    /** When the logo last changed. Distinct from `updated_at`, which any edit bumps. */
    logo_updated_at: { type: "timestamptz" }
  });

  pgm.addConstraint("tenant_mobile_config", "tenant_mobile_config_logo_complete_check", {
    check: `(
      (logo_content_type IS NULL AND logo_data IS NULL AND logo_updated_at IS NULL)
      OR
      (logo_content_type IS NOT NULL AND logo_data IS NOT NULL AND logo_updated_at IS NOT NULL)
    )`
  });

  pgm.addConstraint("tenant_mobile_config", "tenant_mobile_config_logo_type_check", {
    check: "logo_content_type IS NULL OR logo_content_type IN ('image/png', 'image/jpeg', 'image/webp')"
  });

  // 64 KiB. Must match TENANT_LOGO_MAX_BYTES in @growpath/contracts.
  pgm.addConstraint("tenant_mobile_config", "tenant_mobile_config_logo_size_check", {
    check: "logo_data IS NULL OR octet_length(logo_data) <= 65536"
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropConstraint("tenant_mobile_config", "tenant_mobile_config_logo_size_check");
  pgm.dropConstraint("tenant_mobile_config", "tenant_mobile_config_logo_type_check");
  pgm.dropConstraint("tenant_mobile_config", "tenant_mobile_config_logo_complete_check");
  pgm.dropColumns("tenant_mobile_config", ["logo_content_type", "logo_data", "logo_updated_at"]);
};
