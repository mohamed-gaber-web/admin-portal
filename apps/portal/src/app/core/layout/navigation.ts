import type { NavSection } from "@core/models";

/**
 * The sidebar, as data.
 *
 * Declared here rather than inline in the sidebar template so that adding a
 * screen is one entry in one list, and so a future permissions check has a
 * single place to filter — a nav built from markup has to be edited in the
 * shape of the markup, and grows a hidden copy of the route table.
 */
export const NAVIGATION: readonly NavSection[] = [
  {
    titleKey: "nav.overview",
    items: [{ labelKey: "nav.dashboard", route: "/dashboard", icon: "dashboard" }]
  },
  {
    titleKey: "nav.manage",
    items: [
      { labelKey: "nav.tenants", route: "/tenants", icon: "building" },
      { labelKey: "nav.users", route: "/users", icon: "users" },
      { labelKey: "nav.roles", route: "/roles", icon: "shield" },
      { labelKey: "nav.activity", route: "/activity", icon: "activity" }
    ]
  },
  {
    titleKey: "nav.workspace",
    items: [
      { labelKey: "nav.configuration", route: "/configuration", icon: "database" },
      { labelKey: "nav.settings", route: "/settings", icon: "settings" }
    ]
  },
  /**
   * The cross-tenant screens, shown only to platform operators.
   *
   * A separate section rather than extra entries in "Manage", because the
   * distinction is the whole point: everything above answers "my tenant" and
   * everything here answers "all of them". Folding them together would leave an
   * operator one glance away from acting on the wrong installation-wide list.
   */
  {
    titleKey: "nav.platform",
    requiresPermission: "platform.tenant.read",
    items: [
      { labelKey: "nav.allTenants", route: "/platform/tenants", icon: "building" },
      { labelKey: "nav.allUsers", route: "/platform/users", icon: "users" },
      { labelKey: "nav.packages", route: "/platform/packages", icon: "inbox" },
      { labelKey: "nav.superAdmins", route: "/platform/admins", icon: "shield" },
      { labelKey: "nav.permissions", route: "/platform/permissions", icon: "key" }
    ]
  }
];
