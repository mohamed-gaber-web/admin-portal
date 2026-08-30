import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * US-061 — Authentication screens.
 *
 * The story has no Notion page (the Tasks database stops at US-026), so these
 * criteria are the ones agreed before implementation: an MFA challenge, MFA
 * enrolment, the two password-reset screens, sign-in handling the response
 * union, and the bearer token that the tenant-scoped MFA routes require.
 *
 * The sprint's localisation definition-of-done applies to all of them, so it is
 * checked here too rather than assumed from US-062.
 *
 * Source-level assertions, matching the convention of the other suites here.
 * Worth stating plainly: this proves the wiring, not the rendering. A screen
 * can satisfy every assertion below and still look wrong.
 */

const ROOT = resolve(__dirname, "..");
const PORTAL = join(ROOT, "apps/portal");
const APP = join(PORTAL, "src/app");

const read = (path: string) => readFileSync(join(APP, path), "utf8");

function sources(dir = APP): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("US-061 AC1 — sign-in handles both outcomes of a correct password", () => {
  it("parses the response as a discriminated union, not as a session", () => {
    const service = read("core/auth/auth.service.ts");
    // `authenticatedSchema` alone would throw on an `mfa_required` response —
    // an MFA-enabled account would see a contract error, not a prompt.
    expect(service).toContain("signInResponseSchema");
    expect(service).toMatch(/signIn\([\s\S]*?signInResponseSchema/);
  });

  it("only adopts a session on the authenticated branch", () => {
    const service = read("core/auth/auth.service.ts");
    expect(service).toMatch(/status === "authenticated"[\s\S]{0,80}session\.set/);
  });

  it("routes an MFA challenge to /mfa without signing anyone in", () => {
    const login = read("features/auth/login.page.ts");
    expect(login).toMatch(/status === "mfa_required"/);
    expect(login).toMatch(/challenge\.start\(response\)/);
    expect(login).toContain('navigateByUrl("/mfa")');
    // The login page must not touch the session store itself.
    expect(login).not.toMatch(/session\.set/);
  });
});

describe("US-061 AC2 — the MFA challenge screen", () => {
  it("exists and is guarded so it cannot be opened directly", () => {
    const routes = read("app.routes.ts");
    expect(routes).toMatch(/path: "mfa"/);
    expect(routes).toContain("mfaChallengeGuard");

    const guard = read("core/auth/auth.guard.ts");
    expect(guard).toMatch(/hasChallenge\(\)[\s\S]{0,60}createUrlTree\(\["\/login"\]\)/);
  });

  it("keeps the challenge token in memory and never persists it", () => {
    const store = read("core/auth/mfa-challenge.store.ts");
    expect(store).not.toContain("localStorage");
    expect(store).not.toContain("sessionStorage");
  });

  it("offers a recovery code as well as an authenticator code", () => {
    const page = read("features/auth/mfa-challenge.page.ts");
    expect(page).toContain("mfa.useRecovery");
    expect(page).toContain("mfa.recoveryLabel");
    expect(page).toContain("verifyMfa");
  });

  it("does not distinguish a wrong code from a replayed or spent one", () => {
    const page = read("features/auth/mfa-challenge.page.ts");
    // One failure key for every rejection, matching an API that answers
    // identically to all three.
    const failureKeys = [...page.matchAll(/"(mfa\.[a-zA-Z]+)"/g)].map((m) => m[1]);
    expect(failureKeys).toContain("mfa.failed");
    expect(failureKeys).not.toContain("mfa.wrongCode");
    expect(failureKeys).not.toContain("mfa.replayed");
  });
});

describe("US-061 AC3 — MFA enrolment", () => {
  it("shows the secret as a QR and as text", () => {
    const component = read("features/settings/components/mfa-enrolment.component.ts");
    expect(component).toContain("ui-qr-code");
    // The manual key is a peer, not a fallback: you cannot scan the screen you
    // are reading it from.
    expect(component).toContain("mfaSetup.manualLabel");
    expect(component).toContain("startMfaEnrolment");
    expect(component).toContain("confirmMfaEnrolment");
  });

  it("surfaces the recovery codes and says they are shown once", () => {
    const component = read("features/settings/components/mfa-enrolment.component.ts");
    expect(component).toContain("recoveryCodes");
    expect(component).toContain("mfaSetup.recoveryWarning");

    const en = read("core/i18n/messages/en.ts");
    expect(en).toMatch(/"mfaSetup\.recoveryWarning":\s*"[^"]*once/i);
  });

  it("drops the secret from memory once enrolment is confirmed", () => {
    const component = read("features/settings/components/mfa-enrolment.component.ts");
    expect(component).toMatch(/recoveryCodes\.set[\s\S]{0,200}enrolment\.set\(null\)/);
  });

  it("keeps the QR encoder out of the initial bundle", () => {
    // The barrel is imported by the eager shell, so re-exporting a component
    // with a heavy dependency drags it in for every visitor.
    const barrel = read("shared/ui/index.ts");
    expect(barrel).not.toMatch(/^export \* from "\.\/qr-code\.component";$/m);

    const component = read("features/settings/components/mfa-enrolment.component.ts");
    expect(component).toContain('from "@shared/ui/qr-code.component"');
  });
});

describe("US-061 AC4 — password reset", () => {
  it("does not branch on whether the account exists", () => {
    const page = read("features/auth/forgot-password.page.ts");
    // One success state, shown regardless. Any conditional on the response
    // would reintroduce the enumeration oracle the contract removes.
    expect(page).toContain("sent.set(true)");
    expect(page).not.toMatch(/response\.(found|exists|sent)/);
  });

  it("uses copy that reveals nothing either", () => {
    const en = read("core/i18n/messages/en.ts");
    const body = /"forgot\.sentBody":\s*\n?\s*"([^"]*)"/.exec(en)?.[1] ?? "";
    expect(body).toBeTruthy();
    // "If those details match an account" is fine — it is true for everyone.
    // "We could not find you" is not.
    expect(body).not.toMatch(/no such|not found|does not exist|no account/i);
  });

  it("hands back no session on a completed reset", () => {
    const page = read("features/auth/reset-password.page.ts");
    expect(page).toContain("completePasswordReset");
    // Redeeming revokes every refresh token; issuing one here would undo that.
    expect(page).not.toMatch(/session\.set|navigateByUrl\("\/dashboard"\)/);
    expect(page).toContain("reset.doneBody");
  });

  it("is reachable from sign-in", () => {
    const login = read("features/auth/login.page.ts");
    expect(login).toContain('routerLink="/forgot-password"');
  });
});

describe("US-061 AC5 — the bearer token the MFA routes require", () => {
  it("attaches the access token to authenticated requests", () => {
    const interceptor = read("core/http/auth.interceptor.ts");
    expect(interceptor).toMatch(/Authorization: `Bearer \$\{token\}`/);
  });

  it("never sends it to the unauthenticated auth routes", () => {
    const interceptor = read("core/http/auth.interceptor.ts");
    for (const route of [
      "API_ROUTES.login",
      "API_ROUTES.refresh",
      "API_ROUTES.acceptInvitation",
      "API_ROUTES.requestPasswordReset",
      "API_ROUTES.completePasswordReset",
      "API_ROUTES.verifyMfa"
    ]) {
      expect(interceptor).toContain(route);
    }
  });

  it("is registered, in an order that lets errors see a formed request", () => {
    const config = read("app.config.ts");

    // Scoped to the `withInterceptors([...])` array. Searching the whole file
    // would measure the order of the import statements, which is alphabetical
    // and says nothing about the pipeline.
    const registration = /withInterceptors\(\[([\s\S]*?)\]\)/.exec(config)?.[1];
    expect(registration).toBeTruthy();

    const registered = [...(registration ?? "").matchAll(/(\w+Interceptor)/g)].map(
      (match) => match[1]
    );
    expect(registered).toEqual([
      "correlationIdInterceptor",
      "authInterceptor",
      "errorInterceptor"
    ]);
  });

  it("restores a session before the first route resolves", () => {
    const config = read("app.config.ts");
    expect(config).toContain("provideSessionRestore");

    const restore = read("core/auth/session-restore.ts");
    expect(restore).toContain("APP_INITIALIZER");
    // A failed exchange means the token is spent, expired or replayed — clear,
    // never retry.
    expect(restore).toMatch(/catchError[\s\S]{0,120}session\.clear\(\)/);
  });

  it("keeps the refresh token out of localStorage", () => {
    const store = read("core/auth/session.store.ts");
    expect(store).toMatch(/sessionStorage\.setItem\(REFRESH_KEY/);
    // The identity may live in localStorage; a token may not.
    const localStorageWrites = [...store.matchAll(/localStorage\.setItem\((\w+)/g)].map(
      (match) => match[1]
    );
    expect(localStorageWrites).not.toContain("REFRESH_KEY");
  });

  it("never persists the access token at all", () => {
    const store = read("core/auth/session.store.ts");
    expect(store).not.toMatch(/(local|session)Storage\.setItem\([^)]*accessToken/i);
  });
});

describe("US-061 AC6 — localisation definition of done", () => {
  it("passes the i18n guard, so no new screen carries a bare string", () => {
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
      /(mfa-challenge|forgot-password|reset-password|mfa-enrolment|otp-input|qr-code)\.(page|component)\.ts$/.test(
        path
      )
    );
    expect(added.length).toBe(6);

    for (const file of added) {
      const source = readFileSync(file, "utf8");
      for (const template of source.matchAll(/template:\s*`([\s\S]*?)`/g)) {
        expect(template[1].replace(/<!--[\s\S]*?-->/g, "")).not.toMatch(physical);
      }
    }
  });

  it("does not treat a padded code as a complete one", () => {
    // The value is space-padded while being filled, so a single digit typed
    // into the last box is six characters long and not a six-digit code.
    // Gating on `.length` accepted it and submitted "     1".
    const otp = read("shared/ui/otp-input.component.ts");
    expect(otp).toContain("export function isOtpComplete");
    expect(otp).toMatch(/isOtpComplete[\s\S]{0,160}\/\^\\d\+\$\//);

    for (const consumer of [
      "features/auth/mfa-challenge.page.ts",
      "features/settings/components/mfa-enrolment.component.ts"
    ]) {
      const source = read(consumer);
      expect(source).toContain("isOtpComplete");
      expect(source).not.toMatch(/code\(\)\.length\s*[!=]==?\s*6/);
    }
  });

  it("keeps codes and keys left-to-right even under RTL", () => {
    // A one-time code is a number and a base32 secret is a machine string;
    // neither reverses in Arabic, and mirroring the boxes would reverse the
    // value the user typed.
    expect(read("shared/ui/otp-input.component.ts")).toContain('dir="ltr"');
    expect(
      read("features/settings/components/mfa-enrolment.component.ts")
    ).toContain('dir="ltr"');
  });
});
