/* eslint-disable */
/**
 * Backfills the default role grants provisioning used to omit.
 *
 * `provisionTenantOnClient` created the `admin` and `viewer` roles and granted
 * them nothing, so every tenant provisioned before this migration holds two
 * roles with no permissions at all — names attached to no authority, which is
 * exactly what `role_permission` was added to prevent. The provisioning code is
 * fixed alongside this; this repairs the tenants that already exist.
 *
 * Deliberately conservative: it grants only to roles that currently hold
 * **zero** permissions. A role somebody has already configured — including one
 * they configured by revoking everything they did not want — is left exactly as
 * it is. The alternative, asserting the defaults over every default-named role,
 * would silently undo real administrative decisions.
 *
 * The rule matches the seed and the fixed provisioning path: admin holds the
 * whole catalogue, viewer holds the read half.
 */

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO role_permission (tenant_id, role_id, permission_id)
    SELECT r.tenant_id, r.id, p.id
    FROM role r
    CROSS JOIN permission p
    WHERE r.name IN ('admin', 'viewer')
      -- Untouched roles only. A role with a single grant is one somebody has
      -- already had an opinion about.
      AND NOT EXISTS (
        SELECT 1 FROM role_permission existing WHERE existing.role_id = r.id
      )
      AND (r.name = 'admin' OR p.key LIKE '%.read')
    ON CONFLICT (role_id, permission_id) DO NOTHING
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = () => {
  /**
   * Deliberately empty.
   *
   * The grants are indistinguishable from ones an administrator made through
   * the permission matrix — same table, same columns, no marker saying which
   * were backfilled. Removing "the default set" on the way down would strip
   * permissions somebody chose, so this migration is not reversible in the
   * only direction that would matter.
   */
};
