import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * US-062 — Arabic and English with right-to-left support.
 *
 * Two acceptance criteria, tested here:
 *
 *   1. Every screen renders correctly in Arabic with mirrored layout, tables
 *      and icons.
 *   2. A new UI string without a translation key fails CI.
 *
 * (The sprint's third exit criterion — configuring D365 — belongs to US-065.)
 *
 * These are source-level assertions rather than rendered-DOM ones, matching the
 * convention of the other tests in this directory. That is a real limitation
 * and worth stating: this suite proves the mechanism is wired everywhere, not
 * that the result looks right. A screenshot diff in Arabic is the check that
 * would catch a visually broken but structurally correct screen, and it is not
 * built yet.
 */

const ROOT = resolve(__dirname, "..");
const PORTAL = join(ROOT, "apps/portal");
const APP = join(PORTAL, "src/app");
const CHECKER = join(ROOT, "scripts/check-i18n.mjs");

/** Every .ts file under src/app. */
function sources(dir = APP): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * Runs the guard, returning its exit code and combined output.
 *
 * `root` selects *which copy of the script* to run, not just a working
 * directory: the checker locates the tree from its own `import.meta.url`, so
 * pointing `cwd` at a sandbox while executing the real script would silently
 * check the real tree and pass.
 */
function runChecker(root = ROOT): { code: number; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      [root === ROOT ? CHECKER : join(root, "scripts/check-i18n.mjs")],
      { cwd: root, encoding: "utf8", stdio: "pipe" }
    );
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      code: failure.status ?? 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`
    };
  }
}

describe("US-062 AC1 — every screen renders correctly in Arabic", () => {
  it("ships an Arabic catalogue covering every English key", () => {
    const en = read(join(APP, "core/i18n/messages/en.ts"));
    const ar = read(join(APP, "core/i18n/messages/ar.ts"));

    const keysOf = (source: string) =>
      new Set([...source.matchAll(/^\s*"([\w.-]+)":/gm)].map((match) => match[1]));

    const enKeys = keysOf(en);
    const arKeys = keysOf(ar);

    expect(enKeys.size).toBeGreaterThan(100);
    expect([...enKeys].filter((key) => !arKeys.has(key))).toEqual([]);
    expect([...arKeys].filter((key) => !enKeys.has(key))).toEqual([]);
  });

  it("types the Arabic catalogue against the English one, so a gap fails the build", () => {
    const ar = read(join(APP, "core/i18n/messages/ar.ts"));
    // `Messages` is Record<MessageKey, string>. Without this annotation a
    // missing key would only be caught by the CI script, not the compiler.
    expect(ar).toMatch(/export const ar:\s*Messages\s*=/);
  });

  it("drives dir and lang from the active locale", () => {
    const service = read(join(APP, "core/i18n/i18n.service.ts"));
    expect(service).toContain('setAttribute("dir"');
    expect(service).toContain('setAttribute("lang"');

    // Arabic must resolve to rtl, or nothing below mirrors.
    const locale = read(join(APP, "core/i18n/locale.ts"));
    expect(locale).toMatch(/ar:\s*\{[^}]*dir:\s*"rtl"/);
  });

  it("sets direction before first paint, not after bootstrap", () => {
    // A dir applied only once Angular boots means an Arabic user watches the
    // whole page re-lay-out on every cold load.
    const html = read(join(PORTAL, "src/index.html"));
    expect(html).toContain("growpath.locale");
    expect(html).toMatch(/setAttribute\("dir"/);
  });

  it("uses logical properties rather than left/right utilities", () => {
    // Physical utilities do not mirror. `pl-4` stays on the left in Arabic
    // while everything around it moves, which is how a layout ends up
    // half-mirrored.
    const offenders: string[] = [];
    const physical =
      /class="[^"]*(?<!\w)(?:pl-\d|pr-\d|ml-\d|mr-\d|left-\d|right-\d|text-left|text-right|border-l\b|border-r\b|rounded-l-|rounded-r-)/;

    for (const file of sources()) {
      const source = read(file);
      // Only inside templates; a physical utility named in a prose comment is
      // usually the comment explaining why the logical one is used instead.
      for (const template of source.matchAll(/template:\s*`([\s\S]*?)`/g)) {
        const withoutComments = template[1].replace(/<!--[\s\S]*?-->/g, "");
        if (physical.test(withoutComments)) {
          offenders.push(file.replace(ROOT, "").replace(/\\/g, "/"));
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("mirrors directional icons and only those", () => {
    const icon = read(join(APP, "shared/ui/icon.component.ts"));

    expect(icon).toContain("rtl:-scale-x-100");
    for (const directional of ["chevron-left", "chevron-right", "panel-collapse"]) {
      expect(icon).toMatch(
        new RegExp(`DIRECTIONAL_ICONS[\\s\\S]*"${directional}"[\\s\\S]*\\]\\)`)
      );
    }

    // Mirroring these would invert their meaning rather than preserve it: a
    // flipped "trending-up" reads as a fall.
    const set = icon.slice(
      icon.indexOf("DIRECTIONAL_ICONS"),
      icon.indexOf("])", icon.indexOf("DIRECTIONAL_ICONS"))
    );
    for (const nonDirectional of ["trending-up", "trending-down", "search", "bell"]) {
      expect(set).not.toContain(`"${nonDirectional}"`);
    }
  });

  it("aligns table headers logically", () => {
    const table = read(join(APP, "shared/ui/table.component.ts"));
    expect(table).toContain("text-start");
  });

  it("loads an Arabic typeface, since Inter has no Arabic glyphs", () => {
    const styles = read(join(PORTAL, "src/styles.css"));
    expect(styles).toContain("noto-sans-arabic");
    // Keyed by language, not direction: Latin text inside an Arabic page
    // should stay in the Latin face.
    expect(styles).toMatch(/\[lang="ar"\]\s*\{/);

    // Never `:lang()` in an actual rule — the CSS minifier does not implement
    // that pseudo-class and silently drops the whole rule, shipping Arabic in a
    // system fallback font. Comments are stripped first, since the note
    // explaining this rule necessarily names the selector it warns against.
    const withoutComments = styles.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(withoutComments).not.toMatch(/:lang\(/);

    const packageJson = JSON.parse(read(join(PORTAL, "package.json"))) as {
      dependencies?: Record<string, string>;
    };
    expect(packageJson.dependencies).toHaveProperty(
      "@fontsource-variable/noto-sans-arabic"
    );
  });

  it("formats numbers and dates through the active locale", () => {
    const service = read(join(APP, "core/i18n/i18n.service.ts"));
    expect(service).toContain("Intl.NumberFormat");
    expect(service).toContain("Intl.DateTimeFormat");
    // Arabic plural selection has six categories; `count === 1 ? a : b` is
    // wrong for 0, 2 and 3–10.
    expect(service).toContain("Intl.PluralRules");
  });
});

describe("US-062 AC2 — a new UI string without a translation key fails CI", () => {
  it("passes on the current tree", () => {
    const { code, output } = runChecker();
    expect(output).toContain("en and ar agree");
    expect(code).toBe(0);
  });

  it("is wired into the lint task CI already runs", () => {
    const packageJson = JSON.parse(read(join(PORTAL, "package.json"))) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts.lint).toContain("check-i18n");

    // `pnpm lint` fans out to every workspace via turbo, and CI runs it.
    const workflow = read(join(ROOT, ".github/workflows/ci.yml"));
    expect(workflow).toContain("pnpm lint");
  });

  it("fails when a key is missing from the Arabic catalogue", () => {
    withPatchedCopy(
      (files) => {
        // Drop the last entry of ar.ts, leaving en.ts untouched.
        files["apps/portal/src/app/core/i18n/messages/ar.ts"] = files[
          "apps/portal/src/app/core/i18n/messages/ar.ts"
        ].replace(/^\s*"error\.generic":[^\n]*\n/m, "");
      },
      ({ code, output }) => {
        expect(code).not.toBe(0);
        expect(output).toContain("missing-translation");
        expect(output).toContain("error.generic");
      }
    );
  });

  it("fails when Arabic defines a key English does not", () => {
    withPatchedCopy(
      (files) => {
        files["apps/portal/src/app/core/i18n/messages/ar.ts"] = files[
          "apps/portal/src/app/core/i18n/messages/ar.ts"
        ].replace('"error.generic":', '"error.ghost": "x",\n  "error.generic":');
      },
      ({ code, output }) => {
        expect(code).not.toBe(0);
        expect(output).toContain("orphaned-translation");
        expect(output).toContain("error.ghost");
      }
    );
  });

  it("fails on a bare literal added to a template", () => {
    withPatchedCopy(
      (files) => {
        const path = "apps/portal/src/app/features/not-found/not-found.page.ts";
        files[path] = files[path].replace(
          "<div class=\"space-y-2\">",
          '<div class="space-y-2"><p>Contact your administrator</p>'
        );
      },
      ({ code, output }) => {
        expect(code).not.toBe(0);
        expect(output).toContain("untranslated-text");
        expect(output).toContain("Contact your administrator");
      }
    );
  });

  it("fails on a bare literal in a user-visible attribute", () => {
    withPatchedCopy(
      (files) => {
        const path = "apps/portal/src/app/features/not-found/not-found.page.ts";
        files[path] = files[path].replace(
          '<div class="space-y-2">',
          '<div class="space-y-2" title="Sorry about that">'
        );
      },
      ({ code, output }) => {
        expect(code).not.toBe(0);
        expect(output).toContain("untranslated-attribute");
        expect(output).toContain("Sorry about that");
      }
    );
  });
});

/**
 * Runs the checker against a throwaway copy of the files it reads.
 *
 * The guard has to be shown *failing*, and the only honest way to do that is to
 * feed it a broken tree. Copying the handful of paths it touches into a temp
 * directory keeps the real working tree untouched, so a failed assertion cannot
 * leave the repository in a state where the next `pnpm lint` mysteriously fails.
 */
function withPatchedCopy(
  patch: (files: Record<string, string>) => void,
  assert: (result: { code: number; output: string }) => void
): void {
  const sandbox = mkdtempSync(join(tmpdir(), "us062-"));
  try {
    const files: Record<string, string> = {};
    const tracked = [
      "scripts/check-i18n.mjs",
      ...sources().map((path) =>
        path.replace(ROOT, "").replace(/\\/g, "/").replace(/^\//, "")
      )
    ];
    for (const relative of tracked) files[relative] = read(join(ROOT, relative));

    patch(files);

    for (const [relative, contents] of Object.entries(files)) {
      const target = join(sandbox, relative);
      mkdirpSync(target.slice(0, target.lastIndexOf(require("node:path").sep)));
      writeFileSync(target, contents, "utf8");
    }

    assert(runChecker(sandbox));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function mkdirpSync(dir: string): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require("node:fs").mkdirSync(dir, { recursive: true });
}
