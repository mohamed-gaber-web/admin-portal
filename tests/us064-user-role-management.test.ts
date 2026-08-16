import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { DEMO_PERMISSIONS, permissionsForRole } from "../packages/db/src/seed";
import { DECLARED_ROUTES } from "./route-manifest";

/**
 * US-064 — User and role management screens.
 *
 * No Notion page (the Tasks database stops at US-026), so these are the
 * criteria agreed before implementation: a user detail screen with role
 * assignment and access control, a roles screen with the permission matrix, an
 * invitation dialog, and the localisation definition of done.
 *
 * The permission assertions compare against `@growpath/db`'s own seed rather
 * than a copy. That is the point of them: the portal's catalogue is currently
 * kept in step by hand, so a permission added to the database and not to the
 * portal should fail here rather than silently produce a matrix missing a
 * column.
 */

const ROOT = resolve(__dirname, "..");
const APP = join(ROOT, "apps/portal/src/app");

const read = (path: string) => readFileSync(join(APP, path), "utf8");

function sources(dir = APP): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("US-064 AC1 — a user detail screen", () => {
  it("routes /users/:id and binds the id as an input", () => {
    const routes = read("app.routes.ts");
    expect(routes).toMatch(/path: "users\/:id"/);

    const page = read("features/users/user-detail.page.ts");
    expect(page).toMatch(/readonly id = input\.required<string>\(\)/);
    expect(page).not.toMatch(/inject\(ActivatedRoute\)/);
  });

  it("is reachable from the list, by name and by row menu", () => {
    const list = read("features/users/users.page.ts");
    expect(list).toMatch(/\[routerLink\]="\['\/users', user\.id\]"/);
    // The row menu's "View profile" was a dead button before this story.
    expect(list).toMatch(/<a uiMenuItem \[routerLink\]="\['\/users', user\.id\]">/);
  });

  it("treats an unknown id as empty rather than as a failure", () => {
    const page = read("features/users/user-detail.page.ts");
    expect(page).toContain("userDetail.notFoundTitle");
  });

  it("keeps roles and access as separate concerns", () => {
    // Suspending must not silently drop roles, or restoring access would not
    // restore what the person had. Two distinct endpoints is what guarantees
    // it: the status call has no way to express a role change.
    const service = read("features/users/users.service.ts");
    expect(service).toMatch(/setStatus[\s\S]{0,300}API_ROUTES\.userStatus/);
    expect(service).toMatch(/setStatus[\s\S]{0,300}\{ status \}/);
    expect(service).not.toMatch(/setStatus[\s\S]{0,300}roles:/);

    // And the API side agrees: the status route declares only the two status
    // actions, never a role one.
    const route = DECLARED_ROUTES.find((entry) => entry.path === "/users/:id/status");
    expect(route?.audits).toEqual(["user.suspended", "user.reactivated"]);
  });
});

describe("US-064 AC2 — role assignment", () => {
  it("offers only roles the user does not already hold", () => {
    const page = read("features/users/user-detail.page.ts");
    expect(page).toMatch(/assignable\(\)[\s\S]{0,220}!held\.has\(role\.name\)/);
  });

  it("round-trips an assignment through the service", () => {
    const page = read("features/users/user-detail.page.ts");
    expect(page).toMatch(/users\.setRoles\(user\.id, roles\)/);

    const service = read("features/users/users.service.ts");
    expect(service).toContain("setRoles");
  });

  it("names the audit action the API writes", () => {
    const service = read("features/users/users.service.ts");
    expect(service).toContain("role.assigned");
  });
});

describe("US-064 AC3 — the permission matrix", () => {
  it("covers exactly the catalogue the database seeds", async () => {
    const { PERMISSION_KEYS } = await import(
      "../apps/portal/src/app/core/models/permission.model"
    );
    const seeded = DEMO_PERMISSIONS.map((permission) => permission.key).sort();
    expect([...PERMISSION_KEYS].sort()).toEqual(seeded);
  });

  it("shows the permissions each role actually holds, rather than a local guess", () => {
    // The matrix used to open on a fixture that mirrored the seed by hand. It
    // now renders `GET /roles`, which reads `role_permission` — so the screen
    // shows what a tenant genuinely has, including any change made since it was
    // provisioned. The assertion that matters is that no copy of the seed's
    // arrangement survives here to drift from it.
    const source = read("features/roles/roles.service.ts");
    expect(source).toContain("API_ROUTES.roles");
    expect(source).not.toContain("mockResponse");

    for (const key of DEMO_PERMISSIONS.map((permission) => permission.key)) {
      expect(
        source,
        `roles.service.ts hard-codes the permission ${key}`
      ).not.toContain(`"${key}"`);
    }

    // The seed's own rule is untouched: admin holds everything, viewer the
    // read half. This is what the API will serve for a freshly seeded tenant.
    expect(permissionsForRole("admin").sort()).toEqual(
      DEMO_PERMISSIONS.map((permission) => permission.key).sort()
    );
    expect(permissionsForRole("viewer").every((key) => key.endsWith(".read"))).toBe(true);
  });

  it("never presents the catalogue itself as editable", () => {
    // `permission` is global and the application holds SELECT on it and
    // nothing else, so offering create/rename/delete would offer an operation
    // the database refuses.
    const matrix = read("features/roles/components/permission-matrix.component.ts");
    expect(matrix).toContain("roles.catalogueReadOnly");
    expect(matrix).not.toMatch(/addPermission|deletePermission|renamePermission/);

    const service = read("features/roles/roles.service.ts");
    expect(service).not.toMatch(/createPermission|removePermission\b/);
  });

  it("keeps write implying read in both directions", async () => {
    const { impliedBy } = await import(
      "../apps/portal/src/app/core/models/permission.model"
    );
    expect(impliedBy("tenant.write")).toBe("tenant.read");
    expect(impliedBy("tenant.read")).toBeNull();

    const service = read("features/roles/roles.service.ts");
    // Granting a write adds its read; revoking a read drops the write.
    expect(service).toMatch(/held\.add\(read\)/);
    expect(service).toMatch(/impliedBy\(candidate\) === permission[\s\S]{0,60}held\.delete/);
  });

  it("puts the checkbox state back if the save fails", () => {
    const page = read("features/roles/roles.page.ts");
    expect(page).toMatch(/saveFailed[\s\S]{0,160}this\.load\(\)/);
  });
});

describe("US-064 AC4 — inviting a user", () => {
  it("wires the button that used to do nothing", () => {
    const list = read("features/users/users.page.ts");
    expect(list).toMatch(/\(click\)="inviteOpen\.set\(true\)"/);
    expect(list).toContain("app-invite-user-dialog");
  });

  it("shows the token once, with the reissue warning", () => {
    const dialog = read("features/users/components/invite-user-dialog.component.ts");
    expect(dialog).toContain("createTenant.tokenWarningTitle");
    expect(dialog).toContain("invite.copyLink");
    // The link points at the redemption screen that already exists.
    expect(dialog).toContain("/accept-invitation?token=");
  });

  it("issues the invitation through the endpoint that exists for it", () => {
    const service = read("features/users/users.service.ts");
    expect(service).toMatch(/invite\([\s\S]{0,400}API_ROUTES\.userInvitations/);
    expect(service).not.toContain("mockResponse");

    // Distinct from redeeming one, which is necessarily unauthenticated — the
    // person accepting has no credential yet. Issuing requires a token, because
    // the tenant being invited into comes from the caller's claims.
    const issuing = DECLARED_ROUTES.find(
      (route) => route.path === "/users/invitations"
    );
    expect(issuing?.visibility).toBe("tenant-scoped");
    expect(issuing?.audits).toContain("invitation.issued");

    const redeeming = DECLARED_ROUTES.find(
      (route) => route.path === "/auth/accept-invitation"
    );
    expect(redeeming?.visibility).toBe("public");
  });
});

describe("US-064 AC5 — localisation definition of done", () => {
  it("passes the i18n guard", () => {
    const output = execFileSync(
      process.execPath,
      [join(ROOT, "scripts/check-i18n.mjs")],
      { cwd: ROOT, encoding: "utf8", stdio: "pipe" }
    );
    expect(output).toContain("en and ar agree");
  });

  it("holds role names as names, not as display text", () => {
    // A fixture carrying "Owner" would print English on an Arabic screen, and
    // a bare data field is invisible to the untranslated-string check.
    const service = read("features/users/users.service.ts");
    expect(service).not.toMatch(/role: "(Owner|Admin|Member|Viewer)"/);

    const list = read("features/users/users.page.ts");
    expect(list).toMatch(/t\(roleLabel\(user\.role\)\)/);
  });

  it("uses logical properties in the new screens", () => {
    const physical =
      /class="[^"]*(?<!\w)(?:pl-\d|pr-\d|ml-\d|mr-\d|left-\d|right-\d|text-left|text-right)/;

    const added = sources().filter((path) =>
      /(user-detail\.page|invite-user-dialog\.component|roles\.page|permission-matrix\.component)\.ts$/.test(
        path
      )
    );
    expect(added.length).toBe(4);

    for (const file of added) {
      const source = readFileSync(file, "utf8");
      for (const template of source.matchAll(/template:\s*`([\s\S]*?)`/g)) {
        expect(template[1].replace(/<!--[\s\S]*?-->/g, "")).not.toMatch(physical);
      }
    }
  });

  it("keeps identifiers left-to-right under RTL", () => {
    // Permission keys, emails and slugs are machine strings.
    expect(read("features/roles/components/permission-matrix.component.ts")).toContain(
      'dir="ltr"'
    );
    expect(read("features/users/user-detail.page.ts")).toContain('dir="ltr"');
  });
});
