/* eslint-disable */
/**
 * The platform administration tier.
 *
 * Everything before this migration is tenant-shaped: a user belongs to exactly
 * one tenant, `user.email` is unique within it, the access token carries one
 * `tenantId`, and every policy keys on `current_tenant_id()`. US-063 narrowed
 * `GET /tenants` to the caller's own tenant precisely because a portal-wide list
 * disclosed the customer roster to anyone who could sign in anywhere.
 *
 * There is still a role that legitimately spans tenants — whoever operates the
 * installation. This migration gives that role somewhere to exist without
 * unpicking any of the above.
 *
 * The design, and why:
 *
 *   1. A **reserved tenant** holds the operators. `user.tenant_id` stays NOT
 *      NULL, sign-in still supplies a slug, the token still carries one tenant,
 *      and `withRequestTenantScope` is untouched. Nothing about the tenant model
 *      bends to accommodate this.
 *   2. Cross-tenant reach comes from **permissions**, not from a null tenant.
 *      The new `platform.*` keys join the existing catalogue.
 *   3. Holding a `platform.*` key inside an ordinary tenant must be **impossible**,
 *      not merely useless. `provisionTenantOnClient` grants an incoming tenant's
 *      admin role the entire catalogue, and `PUT /roles/:id/permissions` lets a
 *      tenant admin grant their own role anything in it — so adding these keys
 *      naively would hand every tenant admin the platform tier on their next
 *      provision. The trigger below is what makes that a database error rather
 *      than a code review someone has to remember.
 *
 * The API adds a second, independent check (the caller's tenant must be this
 * one) on top of the permission. Two gates, because the cost of this particular
 * check being wrong is every tenant's data.
 */

/** Reserved. `tenant.slug` is unique, so no customer can ever take it. */
const PLATFORM_SLUG = "platform";
const PLATFORM_NAME = "Grow Path Platform";
const PLATFORM_ROLE = "platform-admin";

/**
 * Cross-tenant permissions.
 *
 * Namespaced under `platform.` rather than named `tenant.read.all` because the
 * prefix is what the trigger, the API guard and the portal's matrix all filter
 * on — a rule keyed on a naming convention needs the convention to be
 * mechanical, not a judgement call about which keys "look" platform-level.
 */
const PLATFORM_PERMISSIONS = [
  ["platform.tenant.read", "View every tenant on the installation"],
  // NB: these are interpolated into SQL literals below, so an apostrophe has to
  // be doubled. "any tenant's lifecycle state" terminated the string and made
  // every migration run fail at this line with `syntax error at or near "s"`.
  ["platform.tenant.write", "Create tenants and change any tenant''s lifecycle state"],
  ["platform.user.read", "View every user across all tenants"],
  ["platform.user.write", "Suspend and reactivate users in any tenant"]
];

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // --- Which tenant is the platform one ---------------------------------
  /**
   * A column rather than "the tenant whose slug is 'platform'".
   *
   * A slug is a name, and code that branches on a name is code that breaks when
   * somebody renames it. The API resolves this tenant by the flag; the slug is
   * only how a person types it into the sign-in form.
   */
  pgm.addColumn("tenant", {
    is_platform: { type: "boolean", notNull: true, default: false }
  });

  /**
   * At most one, enforced by the database.
   *
   * A second platform tenant would be a second unbounded-reach tenant that no
   * screen lists and nobody audits — the kind of row that is created by a
   * mistaken re-run and found much later. The unique expression index on a
   * constant is the standard way to say "at most one row satisfying this".
   */
  pgm.sql(`
    CREATE UNIQUE INDEX tenant_single_platform_index
      ON tenant ((is_platform)) WHERE is_platform
  `);

  // --- The permission catalogue -----------------------------------------
  // Keys are literals here rather than imported, matching the convention the
  // earlier migrations set: a migration is a frozen snapshot of history and must
  // not change when the application's idea of the catalogue moves on.
  for (const [key, description] of PLATFORM_PERMISSIONS) {
    pgm.sql(`
      INSERT INTO permission (key, description)
      VALUES ('${key}', '${description}')
      ON CONFLICT (key) DO NOTHING
    `);
  }

  // --- The escalation fence ----------------------------------------------
  /**
   * A `platform.*` grant is only legal on a role belonging to the platform
   * tenant.
   *
   * This is the load-bearing part of the migration. Two existing code paths
   * would otherwise hand these keys out:
   *
   *   - `provisionTenantOnClient` grants a new tenant's `admin` role every row
   *     in `permission`, deliberately, so that a permission added by a later
   *     migration is not silently missed.
   *   - `PUT /roles/:id/permissions` lets a tenant administrator put any
   *     catalogue key on their own role.
   *
   * Both are fixed in the application as well. The trigger is here because the
   * application fix is a filter someone can drop, and because `role_permission`
   * is writable by `app_user` — so the check has to hold for whatever reaches
   * the table, not only for the paths this repository knows about.
   *
   * SECURITY DEFINER: the check reads `tenant`, which carries an RLS policy
   * keyed on `current_tenant_id()`. Evaluated as the calling (scoped) role, the
   * lookup would return no row inside any tenant session, and `is_platform`
   * would come back NULL for the platform tenant itself — turning a legitimate
   * grant into a failure and, worse, making the outcome depend on session
   * state. It runs as the owner so it sees the row it is asking about.
   */
  pgm.sql(`
    CREATE FUNCTION enforce_platform_permission_scope() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE
      permission_key text;
      role_is_platform boolean;
    BEGIN
      SELECT key INTO permission_key FROM permission WHERE id = NEW.permission_id;

      IF permission_key IS NULL OR permission_key NOT LIKE 'platform.%' THEN
        RETURN NEW;
      END IF;

      SELECT t.is_platform INTO role_is_platform
        FROM role r JOIN tenant t ON t.id = r.tenant_id
       WHERE r.id = NEW.role_id;

      IF role_is_platform IS NOT TRUE THEN
        RAISE EXCEPTION
          'permission "%" may only be granted to a role in the platform tenant', permission_key
          USING ERRCODE = '42501';
      END IF;

      RETURN NEW;
    END $$;
  `);

  pgm.sql(`
    CREATE TRIGGER role_permission_platform_scope
      BEFORE INSERT OR UPDATE ON role_permission
      FOR EACH ROW EXECUTE FUNCTION enforce_platform_permission_scope()
  `);

  // --- The platform tenant, its role, and that role's grants -------------
  /**
   * Created here rather than by the seed, because the seed is demo data and
   * this is not: `POST /tenants` now requires a platform administrator, so a
   * deployment with no platform tenant is a deployment where no tenant can ever
   * be created. Bootstrapping cannot depend on a step marked optional.
   *
   * No user is created. A user row with no credential helps nobody, and one
   * with a credential means a password in a migration — readable by everyone
   * with repository access, identical on every installation, and impossible to
   * rotate out of history. `pnpm platform-admin` mints the account and prints a
   * one-time invitation instead.
   */
  pgm.sql(`
    INSERT INTO tenant (name, slug, plan, is_platform)
    VALUES ('${PLATFORM_NAME}', '${PLATFORM_SLUG}', 'enterprise', true)
    ON CONFLICT (slug) DO UPDATE SET is_platform = true
  `);

  pgm.sql(`
    INSERT INTO role (tenant_id, name)
    SELECT id, '${PLATFORM_ROLE}' FROM tenant WHERE slug = '${PLATFORM_SLUG}'
    ON CONFLICT (tenant_id, name) DO NOTHING
  `);

  /**
   * The platform role holds the four `platform.*` keys and the ordinary read
   * keys — not the whole catalogue.
   *
   * The tenant-scoped `.write` keys are deliberately absent: inside the platform
   * tenant they would only authorise edits to the platform tenant's own users
   * and settings, which is not what this role is for, and granting the full
   * catalogue "to be safe" is how a role stops describing anything.
   */
  pgm.sql(`
    INSERT INTO role_permission (tenant_id, role_id, permission_id)
    SELECT r.tenant_id, r.id, p.id
      FROM role r
      JOIN tenant t ON t.id = r.tenant_id
     CROSS JOIN permission p
     WHERE t.is_platform AND r.name = '${PLATFORM_ROLE}'
       AND (p.key LIKE 'platform.%' OR p.key LIKE '%.read')
    ON CONFLICT (role_id, permission_id) DO NOTHING
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.sql(`DROP TRIGGER IF EXISTS role_permission_platform_scope ON role_permission`);
  pgm.sql(`DROP FUNCTION IF EXISTS enforce_platform_permission_scope()`);

  /**
   * The platform tenant is removed only when nobody has signed in as one of its
   * administrators.
   *
   * `tenant` cascades to `user`, `role` and `user_role`, so an unconditional
   * delete would silently destroy real operator accounts — and `audit_log` has a
   * NOT NULL tenant reference, so it would fail halfway through anyway once the
   * tier had been used. Leaving the row in place is the recoverable outcome.
   */
  pgm.sql(`
    DELETE FROM tenant t
     WHERE t.is_platform
       AND NOT EXISTS (SELECT 1 FROM "user" u WHERE u.tenant_id = t.id)
  `);

  pgm.sql(`
    DELETE FROM permission p
     WHERE p.key LIKE 'platform.%'
       AND NOT EXISTS (
         SELECT 1 FROM role_permission rp WHERE rp.permission_id = p.id
       )
  `);

  pgm.sql(`DROP INDEX IF EXISTS tenant_single_platform_index`);
  pgm.dropColumn("tenant", "is_platform");
};
