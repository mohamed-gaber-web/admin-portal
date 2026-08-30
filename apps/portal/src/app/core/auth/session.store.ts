import { Injectable, computed, signal } from "@angular/core";
import type { Authenticated } from "@growpath/contracts";

const STORAGE_KEY = "growpath.session";

/**
 * Where the refresh token is kept between page loads.
 *
 * `sessionStorage`, not `localStorage`, and the difference is the whole point.
 * Both are readable by any script that reaches the page, but sessionStorage is
 * scoped to one tab and cleared when that tab closes — so an XSS payload gets a
 * session, not a permanent credential, and a shared machine does not hand the
 * next person a live token.
 *
 * This is a compromise, chosen so MFA enrolment is reachable at all: `/auth/mfa/enrol`
 * is tenant-scoped, and with tokens purely in memory a page refresh made it
 * permanently unreachable. The contract's own note says a browser client should
 * keep the refresh token out of localStorage and move it to an httpOnly cookie
 * — that remains the correct end state, and it needs an API change. Until then
 * this is the smallest exposure that leaves the feature usable.
 */
const REFRESH_KEY = "growpath.refresh";

/** Who is signed in. Identity only — never the credential. */
export interface Identity {
  user: Authenticated["user"];
  tenant: Authenticated["tenant"];
  /**
   * What this session may do, as the API reported it at sign-in.
   *
   * Kept for rendering decisions only — which navigation entries exist, which
   * buttons are drawn. It is not an authorisation boundary and must never be
   * treated as one: it lives in `localStorage`, so the user can edit it, and
   * editing it changes what this browser draws and nothing about what the API
   * will do. Every request is re-checked against the signed token claim.
   */
  permissions: string[];
}

/**
 * Who is signed in, as one signal the whole app reads.
 *
 * Kept separate from `AuthService` so the error interceptor can clear a dead
 * session without importing the service that issues requests — which would put
 * a cycle between the interceptor and the thing it intercepts.
 *
 * Three things are stored in three different places, on purpose:
 *
 * - **Identity** (who you are) → `localStorage`. Not a credential; keeping it
 *   means a returning user sees their own name rather than a blank shell.
 * - **Access token** → memory only. Short-lived and reissuable, so persisting
 *   it would add exposure and buy nothing.
 * - **Refresh token** → `sessionStorage`. See the note on `REFRESH_KEY`; this
 *   is a deliberate compromise, not the end state.
 *
 * Nothing ever puts a token in `localStorage`.
 */
@Injectable({ providedIn: "root" })
export class SessionStore {
  private readonly identityState = signal<Identity | null>(restore());

  /**
   * The access token never leaves memory. It is short-lived and replaceable by
   * the refresh token, so persisting it would add exposure and buy nothing.
   */
  private readonly accessTokenState = signal<string | null>(null);
  private readonly refreshTokenState = signal<string | null>(restoreRefreshToken());

  readonly identity = this.identityState.asReadonly();
  readonly accessToken = this.accessTokenState.asReadonly();
  readonly refreshToken = this.refreshTokenState.asReadonly();

  readonly user = computed(() => this.identityState()?.user ?? null);
  readonly tenant = computed(() => this.identityState()?.tenant ?? null);
  readonly isAuthenticated = computed(() => this.identityState() !== null);

  /** What this session may do. Empty for a signed-out browser. */
  readonly permissions = computed(() => this.identityState()?.permissions ?? []);

  /**
   * The workspace this session is in, as a person would say it.
   *
   * Sign-in no longer asks which workspace you meant, so this is where the
   * answer surfaces. Falls back to the slug rather than to an empty string: a
   * blank where the organisation's name belongs reads as a broken shell.
   */
  readonly workspaceName = computed(() => {
    const tenant = this.tenant();
    return tenant?.name || tenant?.slug || "";
  });

  /**
   * Whether to draw the cross-tenant screens.
   *
   * A rendering decision and nothing more. Every `/platform/*` request is
   * checked by the API against the signed token claim *and* against the
   * caller's tenant, so a user who edits this out of `localStorage` gets a
   * navigation entry leading to a page full of 403s — which is the correct
   * outcome, and the reason this can safely be a client-side signal.
   */
  readonly isPlatformAdmin = computed(() =>
    this.permissions().some((permission) => permission.startsWith("platform."))
  );

  /** True when the session holds a specific permission. */
  hasPermission(permission: string): boolean {
    return this.permissions().includes(permission);
  }

  /**
   * True when we know who the user is but hold no credential — the state a page
   * refresh leaves behind. The screens do not branch on it yet; the code that
   * restores a session will.
   */
  readonly needsCredential = computed(
    () => this.isAuthenticated() && this.accessTokenState() === null
  );

  /** Display name derived from the email, since the API has no name field yet. */
  readonly displayName = computed(() => {
    const email = this.user()?.email;
    if (!email) return "";
    const [local] = email.split("@");
    return local
      .split(/[._-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  });

  readonly initials = computed(() => {
    const name = this.displayName();
    if (!name) return "?";
    const parts = name.split(" ").filter(Boolean);
    const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts;
    return letters
      .map((part) => part.charAt(0).toUpperCase())
      .join("")
      .slice(0, 2);
  });

  /** Splits a sign-in response: identity and refresh token persist, access token does not. */
  set(session: Authenticated): void {
    const identity: Identity = {
      user: session.user,
      tenant: session.tenant,
      permissions: session.permissions
    };
    this.identityState.set(identity);
    this.accessTokenState.set(session.accessToken);
    this.refreshTokenState.set(session.refreshToken);
    persist(identity);
    persistRefreshToken(session.refreshToken);
  }

  clear(): void {
    this.identityState.set(null);
    this.accessTokenState.set(null);
    this.refreshTokenState.set(null);
    persist(null);
    persistRefreshToken(null);
  }
}

function restore(): Identity | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    // Shape-checked rather than trusted: this string is user-writable, and a
    // half-written or hand-edited value would otherwise crash on first render.
    return isIdentity(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function persist(identity: Identity | null): void {
  try {
    if (identity) localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private browsing and full quotas both throw here. Losing persistence
    // costs the user a re-login on refresh; throwing would cost them the app.
  }
}

function restoreRefreshToken(): string | null {
  try {
    return sessionStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

function persistRefreshToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(REFRESH_KEY, token);
    else sessionStorage.removeItem(REFRESH_KEY);
  } catch {
    // Private browsing. The session still works until the page is reloaded.
  }
}

function isIdentity(value: unknown): value is Identity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Identity>;
  return (
    typeof candidate.user?.id === "string" &&
    typeof candidate.user?.email === "string" &&
    typeof candidate.tenant?.id === "string" &&
    typeof candidate.tenant?.slug === "string" &&
    // Checked, not defaulted, for the same reason `permissions` is: an identity
    // stored before sign-in returned a workspace name has an *unknown* one, and
    // rendering "undefined" in the sidebar is worse than the one re-login that
    // failing this check costs.
    typeof candidate.tenant?.name === "string" &&
    // Checked rather than defaulted. A stored identity written before this
    // field existed is not "a session with no permissions" — it is a session
    // whose permissions are unknown, and treating unknown as empty would show a
    // returning operator a portal with half its navigation missing until they
    // signed in again. Failing the check drops them to sign-in, which resolves
    // it in one step.
    Array.isArray(candidate.permissions) &&
    candidate.permissions.every((permission) => typeof permission === "string")
  );
}
