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
      /effect\(\s*\(\) => \{[\s\S]{0,160}this\.id\(\);[\s\S]{0,900}this\.load\(\)/
    );
  });

  it("does not let the reload re-trigger its own effect", () => {
    /*
     * `load()` opens with `state.set(asyncLoading(state().data))` — it reads the
     * signal it then writes. Called bare inside the effect, that read becomes a
     * dependency and the write re-triggers the effect that performed it, which
     * is an unbounded loop: it pins a core and takes the tab down. Every detail
     * screen shipped with it, so clicking any tenant or user crashed the browser.
     *
     * `allowSignalWrites` permits the write; it does not break the cycle.
     * `untracked` does, and the assertion is that the call stays inside it.
     */
    for (const file of [
      "features/tenants/tenant-detail.page.ts",
      "features/users/user-detail.page.ts",
      "features/platform/platform-tenant-detail.page.ts",
      "features/platform/components/tenant-modules.component.ts"
    ]) {
      expect(read(file), `${file} would loop forever and crash the tab`).toMatch(
        /untracked\(\(\) => this\.load\(\)\)/
      );
    }
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

describe("US-063 AC2 — lifecycle actions belong to the operator", () => {
  /*
   * The original story put suspend/reactivate/archive/restore on the tenant's
   * own detail screen, backed by a tenant-scoped PATCH /tenants/:id/status that
   * checked no permission. Any signed-in member could switch their whole
   * workspace off. Lifecycle is now an operator decision only, made from
   * All tenants through PATCH /platform/tenants/:id/status.
   */
  it("declares no tenant-scoped lifecycle route", () => {
    const tenantWrites = DECLARED_ROUTES.filter(
      (route) => route.path.startsWith("/tenants/") && route.method !== "GET"
    );
    expect(tenantWrites).toEqual([]);

    const platform = DECLARED_ROUTES.find(
      (route) => route.method === "PATCH" && route.path === "/platform/tenants/:id/status"
    );
    expect(platform?.visibility).toBe("platform");
  });

  it("keeps the lifecycle audit actions claimed by the platform route", () => {
    const held = NON_ROUTE_AUDIT_ACTIONS.map((entry) => entry.action);
    const platform =
      DECLARED_ROUTES.find((route) => route.path === "/platform/tenants/:id/status")?.audits ??
      [];
    for (const action of [
      "tenant.soft_deleted",
      "tenant.restored",
      "tenant.suspended",
      "tenant.reactivated"
    ]) {
      expect(held).not.toContain(action);
      expect(platform).toContain(action);
    }
  });

  it("offers no lifecycle controls on the tenant's own screens", () => {
    const page = read("features/tenants/tenant-detail.page.ts");
    expect(page).not.toContain("lifecycle");

    const service = read("features/tenants/tenants.service.ts");
    expect(service).not.toMatch(/setStatus|patchValidated/);
    // No fixture left to fall back to either.
    expect(service).not.toContain("mockResponse");
  });

  it("keeps typed-slug confirmation available for destructive actions", () => {
    const dialog = read("shared/ui/confirm-dialog.component.ts");
    expect(dialog).toContain("confirmPhrase");
    // Exact match: a slug is lowercase by schema rule, so a loose comparison
    // would accept something the system never stores.
    expect(dialog).toMatch(/this\.typed\(\) === phrase/);
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
      /(tenant-detail\.page|tenant-environments\.component|confirm-dialog\.component)\.ts$/.test(
        path
      )
    );
    // Four, not three: `platform-tenant-detail.page.ts` matches the same pattern
    // and is deliberately left in scope. It is the operator's twin of the tenant
    // detail screen, so holding it to a weaker localisation rule than the screen
    // it mirrors would be exactly the wrong exemption. The count is here to stop
    // the filter silently matching nothing, so it moves when the set really does.
    expect(added.length).toBe(4);

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
