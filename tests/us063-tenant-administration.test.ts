import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { DECLARED_ROUTES, NON_ROUTE_AUDIT_ACTIONS } from "./route-manifest";

/**
 * US-063 — Tenant administration screens.
 *
 * No Notion page (the Tasks database stops at US-026), so these are the
 * criteria agreed before implementation: a tenant detail screen, the lifecycle
 * actions the route manifest was holding audit actions for, the
 * tenant → environment → company hierarchy kept intact, tenant-scoped activity,
 * and the localisation definition of done.
 *
 * Source-level assertions, as in the neighbouring suites. They prove the wiring
 * and the invariants; they do not prove the screen renders.
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

describe("US-063 AC1 — a tenant detail screen, reachable from the list", () => {
  it("routes /tenants/:id to the detail page", () => {
    const routes = read("app.routes.ts");
    expect(routes).toMatch(/path: "tenants\/:id"/);
    expect(routes).toContain("tenant-detail.page");
  });

  it("takes the id as a bound input rather than reading ActivatedRoute", () => {
    const page = read("features/tenants/tenant-detail.page.ts");
    expect(page).toMatch(/readonly id = input\.required<string>\(\)/);
    // Checked as an injection, not as a substring: the doc comment on this page
    // names ActivatedRoute to explain what it is doing instead.
    expect(page).not.toMatch(/inject\(ActivatedRoute\)/);
    expect(page).not.toMatch(/^import .*ActivatedRoute/m);

    // The binding only works because the router is configured for it.
    expect(read("app.config.ts")).toContain("withComponentInputBinding");
  });

  it("reloads when the id changes", () => {
    // The router reuses the component across sibling ids rather than
    // recreating it, so loading once in the constructor would show the wrong
    // tenant on the second visit.
    const page = read("features/tenants/tenant-detail.page.ts");
    expect(page).toMatch(
      /effect\(\s*\(\) => \{[\s\S]{0,160}this\.id\(\);[\s\S]{0,60}this\.load\(\)/
    );
  });

  it("declares the signal write the reload performs", () => {
    // `load()` sets the loading state synchronously, and Angular 18 throws
    // NG0600 for a signal write inside an effect unless it is declared. Without
    // this the page did not merely warn — it failed to render at all.
    for (const file of [
      "features/tenants/tenant-detail.page.ts",
      "features/users/user-detail.page.ts"
    ]) {
      expect(read(file), `${file} would throw NG0600 on navigation`).toContain(
        "allowSignalWrites: true"
      );
    }
  });

  it("links to the detail from the tenant list", () => {
    const list = read("features/tenants/tenants.page.ts");
    expect(list).toMatch(/\[routerLink\]="\['\/tenants', tenant\.id\]"/);
  });

  it("treats an unknown id as empty, not as an error", () => {
    // A stale link is a normal thing to follow; a red failure state for it
    // teaches people to distrust a working screen.
    const page = read("features/tenants/tenant-detail.page.ts");
    expect(page).toContain("tenantDetail.notFoundTitle");
    expect(page).toMatch(/ui-empty-state[\s\S]{0,200}tenantDetail\.notFoundTitle/);
  });
});

describe("US-063 AC2 — lifecycle actions", () => {
  it("derives the available actions from status, not from template branches", () => {
    const model = read("core/models/tenant.model.ts");
    expect(model).toContain("TENANT_ACTIONS_BY_STATUS");

    const component = read("features/tenants/components/tenant-lifecycle.component.ts");
    expect(component).toContain("TENANT_ACTIONS_BY_STATUS[this.tenant().status]");
  });

  it("makes the illegal transitions unrepresentable", async () => {
    const {
      TENANT_ACTIONS_BY_STATUS,
      TENANT_ACTION_RESULT
    } = await import("../apps/portal/src/app/core/models/tenant.model");

    // An archived tenant is soft-deleted: restoring is the only way back.
    expect(TENANT_ACTIONS_BY_STATUS.archived).toEqual(["restore"]);
    // Nothing offers a transition to the state it is already in.
    for (const [status, actions] of Object.entries(TENANT_ACTIONS_BY_STATUS)) {
      for (const action of actions) {
        expect(TENANT_ACTION_RESULT[action]).not.toBe(status);
      }
    }
  });

  it("requires typing the slug before archiving, and only before archiving", async () => {
    const { TENANT_ACTIONS_NEEDING_PHRASE } = await import(
      "../apps/portal/src/app/core/models/tenant.model"
    );
    // Friction everywhere is friction nowhere — it stops being read.
    expect(TENANT_ACTIONS_NEEDING_PHRASE).toEqual(["archive"]);

    const dialog = read("shared/ui/confirm-dialog.component.ts");
    expect(dialog).toContain("confirmPhrase");
    // Exact match: a slug is lowercase by schema rule, so a loose comparison
    // would accept something the system never stores.
    expect(dialog).toMatch(/this\.typed\(\) === phrase/);
  });

  it("claims the audit actions the route manifest was holding", () => {
    const component = read("features/tenants/components/tenant-lifecycle.component.ts");
    for (const action of ["tenant.soft_deleted", "tenant.restored"]) {
      expect(component).toContain(action);
    }

    // Now claimed by PATCH /tenants/:id/status, so they must no longer be held
    // as route-less. The US-015 guard is bidirectional and would fail on the
    // double claim, but asserting it here says why the entries were removed.
    const held = NON_ROUTE_AUDIT_ACTIONS.map((entry) => entry.action);
    expect(held).not.toContain("tenant.soft_deleted");
    expect(held).not.toContain("tenant.restored");

    const lifecycle = DECLARED_ROUTES.find(
      (route) => route.path === "/tenants/:id/status"
    );
    expect(lifecycle?.audits).toContain("tenant.soft_deleted");
    expect(lifecycle?.audits).toContain("tenant.restored");
  });

  it("names only audit actions the lifecycle route actually declares", () => {
    // Showing a name nothing records sends an operator searching the log for
    // an entry that will never be there — so every name offered on screen must
    // be one the route claims, and the US-015 guard holds those to the source.
    const component = read("features/tenants/components/tenant-lifecycle.component.ts");
    const declared =
      DECLARED_ROUTES.find((route) => route.path === "/tenants/:id/status")?.audits ?? [];

    const named = [...component.matchAll(/(?:suspend|reactivate|archive|restore):\s*"([^"]+)"/g)]
      .map((match) => match[1])
      .filter((action) => action.startsWith("tenant."));
    expect(named.length).toBe(4);

    for (const action of named) {
      expect(declared, `${action} is shown but not declared`).toContain(action);
    }
  });

  it("sends the transition to the API rather than mutating a fixture", () => {
    const lifecycleRoutes = DECLARED_ROUTES.filter(
      (route) => route.path.startsWith("/tenants/") && route.method !== "GET"
    );
    expect(lifecycleRoutes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "PATCH /tenants/:id/status"
    ]);

    const service = read("features/tenants/tenants.service.ts");
    expect(service).toMatch(/setStatus[\s\S]{0,400}API_ROUTES\.tenantStatus/);
    // No fixture left to fall back to — a half-wired service that silently
    // mutates local state on failure is the outcome worth ruling out.
    expect(service).not.toContain("mockResponse");
  });

  it("sends the target state rather than the verb", () => {
    // Idempotence: a retried archive must not become a second transition.
    const service = read("features/tenants/tenants.service.ts");
    expect(service).toMatch(/\{ status \}/);
  });
});

describe("US-063 AC3 — the tenant/environment/company hierarchy survives", () => {
  it("nests companies inside environments in the model", () => {
    const model = read("core/models/tenant.model.ts");
    expect(model).toMatch(/interface TenantEnvironment[\s\S]{0,400}companies: TenantCompany\[\]/);
    expect(model).toMatch(/interface TenantDetail[\s\S]{0,200}environments: TenantEnvironment\[\]/);
  });

  it("renders them nested rather than as one flat list", () => {
    const component = read("features/tenants/components/tenant-environments.component.ts");
    // A @for over companies inside the @for over environments.
    expect(component).toMatch(
      /@for \(env of environments\(\)[\s\S]*@for \(company of env\.companies/
    );
  });

  it("shows connection state without offering the action", () => {
    // Configuring and testing a connection is US-065. Surfacing the state
    // without the button is where this story stops.
    const component = read("features/tenants/components/tenant-environments.component.ts");
    expect(component).toContain("connection.connected");
    expect(component).not.toMatch(/testConnection|\(click\)/);
  });
});

describe("US-063 AC4 — tenant-scoped activity", () => {
  it("loads activity for the tenant and reuses the shared feed", () => {
    const page = read("features/tenants/tenant-detail.page.ts");
    expect(page).toContain("tenants.activity(this.id())");
    expect(page).toContain("app-activity-list");
  });

  it("does not block the page on it", () => {
    // The audit feed is supplementary; the identity and lifecycle controls are
    // what the page exists for.
    const page = read("features/tenants/tenant-detail.page.ts");
    expect(page).toMatch(/activity\(this\.id\(\)\)\.subscribe/);
    expect(page).toMatch(/error: \(\) => this\.activity\.set\(\[\]\)/);
  });
});

describe("US-063 AC5 — localisation definition of done", () => {
  it("passes the i18n guard", () => {
    const output = execFileSync(
      process.execPath,
      [join(ROOT, "scripts/check-i18n.mjs")],
      { cwd: ROOT, encoding: "utf8", stdio: "pipe" }
    );
    expect(output).toContain("en and ar agree");
  });

  it("uses logical properties in the new screens", () => {
    const physical =
      /class="[^"]*(?<!\w)(?:pl-\d|pr-\d|ml-\d|mr-\d|left-\d|right-\d|text-left|text-right)/;

    const added = sources().filter((path) =>
      /(tenant-detail\.page|tenant-lifecycle\.component|tenant-environments\.component|confirm-dialog\.component)\.ts$/.test(
        path
      )
    );
    // Five, not four: `platform-tenant-detail.page.ts` matches the same pattern
    // and is deliberately left in scope. It is the operator's twin of the tenant
    // detail screen, so holding it to a weaker localisation rule than the screen
    // it mirrors would be exactly the wrong exemption. The count is here to stop
    // the filter silently matching nothing, so it moves when the set really does.
    expect(added.length).toBe(5);

    for (const file of added) {
      const source = readFileSync(file, "utf8");
      for (const template of source.matchAll(/template:\s*`([\s\S]*?)`/g)) {
        expect(template[1].replace(/<!--[\s\S]*?-->/g, "")).not.toMatch(physical);
      }
    }
  });

  it("keeps machine strings left-to-right under RTL", () => {
    // Slugs, URLs and dataAreaIds are identifiers, not prose. Mirroring them
    // translates nothing and makes them harder to read.
    expect(read("features/tenants/components/tenant-environments.component.ts")).toContain(
      'dir="ltr"'
    );
    expect(read("features/tenants/tenant-detail.page.ts")).toContain('dir="ltr"');
    expect(read("shared/ui/confirm-dialog.component.ts")).toContain('dir="ltr"');
  });
});
