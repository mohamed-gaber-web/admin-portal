import { Injectable, inject } from "@angular/core";
import { Router } from "@angular/router";
import { Observable, of, tap, throwError } from "rxjs";
import {
  API_ROUTES,
  PERMISSION_KEYS,
  PLATFORM_PERMISSION_KEYS,
  PLATFORM_TENANT_SLUG,
  acceptedInvitationSchema,
  authenticatedSchema,
  confirmMfaSchema,
  mfaEnabledSchema,
  mfaEnrolmentSchema,
  passwordResetCompletedSchema,
  passwordResetRequestedSchema,
  signInResponseSchema,
  type AcceptInvitationInput,
  type AcceptedInvitation,
  type Authenticated,
  type CompletePasswordResetInput,
  type ConfirmMfaInput,
  type MfaEnabled,
  type MfaEnrolmentStarted,
  type PasswordResetCompleted,
  type PasswordResetRequested,
  type RequestPasswordResetInput,
  type SignInInput,
  type SignInResponse,
  type VerifyMfaInput
} from "@growpath/contracts";
import { environment } from "@env";
import { ApiError } from "../http/api-error";
import { ApiService } from "../http/api.service";
import { mockResponse } from "../http/mock";
import { SessionStore } from "./session.store";

/**
 * Every authentication operation the portal performs.
 *
 * Sign-in returns a **discriminated union**: a correct password either
 * completes the sign-in or produces an MFA challenge, and the two branches
 * carry different fields. Parsing the response with `signInResponseSchema`
 * rather than `authenticatedSchema` is what makes the compiler stop a caller
 * from reading `accessToken` off a challenge that has none.
 *
 * Only the `authenticated` branch touches `SessionStore`. A challenge token
 * proves a password was correct and nothing more — treating it as a session,
 * even briefly, would defeat the second factor entirely.
 *
 * While `environment.useMockApi` is on none of these touch the network. Each
 * real call sits directly beside its fixture so the two cannot drift apart
 * unnoticed.
 */
@Injectable({ providedIn: "root" })
export class AuthService {
  private readonly api = inject(ApiService);
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);

  signIn(input: SignInInput): Observable<SignInResponse> {
    const request = environment.useMockApi
      ? fakeSignIn(input)
      : this.api.postValidated(API_ROUTES.login, input, signInResponseSchema);

    return request.pipe(tap((response) => this.adopt(response)));
  }

  /** Answers an MFA challenge. On success this is the moment a session begins. */
  verifyMfa(input: VerifyMfaInput): Observable<Authenticated> {
    const request = environment.useMockApi
      ? fakeVerifyMfa(input)
      : this.api.postValidated(API_ROUTES.verifyMfa, input, authenticatedSchema);

    return request.pipe(tap((authenticated) => this.session.set(authenticated)));
  }

  /**
   * Starts TOTP enrolment. Authenticated — the user comes from the token's
   * claims, so nobody can start an enrolment for anyone else.
   */
  startMfaEnrolment(): Observable<MfaEnrolmentStarted> {
    if (environment.useMockApi) {
      return mockResponse<MfaEnrolmentStarted>({
        status: "enrolment_started",
        secret: DEMO_TOTP_SECRET,
        uri: `otpauth://totp/Grow%20Path:demo@acme.com?secret=${DEMO_TOTP_SECRET}&issuer=Grow%20Path&algorithm=SHA1&digits=6&period=30`
      });
    }
    return this.api.postValidated(API_ROUTES.enrolMfa, {}, mfaEnrolmentSchema);
  }

  /**
   * Confirms enrolment with a code from the authenticator.
   *
   * The recovery codes in the response exist nowhere else — only their digests
   * are stored, so there is no endpoint that could ever show them again.
   */
  confirmMfaEnrolment(input: ConfirmMfaInput): Observable<MfaEnabled> {
    if (environment.useMockApi) return fakeConfirmMfa(input);
    return this.api.postValidated(
      API_ROUTES.confirmMfa,
      confirmMfaSchema.parse(input),
      mfaEnabledSchema
    );
  }

  /**
   * Asks for a reset link.
   *
   * Always resolves the same way. The API answers identically whether or not
   * the account exists, and the screen must not undo that by branching.
   */
  requestPasswordReset(
    input: RequestPasswordResetInput
  ): Observable<PasswordResetRequested> {
    if (environment.useMockApi) {
      return mockResponse<PasswordResetRequested>({ status: "accepted" });
    }
    return this.api.postValidated(
      API_ROUTES.requestPasswordReset,
      input,
      passwordResetRequestedSchema
    );
  }

  /** Redeems a reset link. Returns no session: every refresh token was revoked. */
  completePasswordReset(
    input: CompletePasswordResetInput
  ): Observable<PasswordResetCompleted> {
    if (environment.useMockApi) {
      return mockResponse<PasswordResetCompleted>({
        status: "reset",
        email: "demo@acme.com"
      });
    }
    return this.api.postValidated(
      API_ROUTES.completePasswordReset,
      input,
      passwordResetCompletedSchema
    );
  }

  /**
   * Exchanges the stored refresh token for a fresh pair.
   *
   * Single use: the token is spent by this call, so the rotated one it returns
   * has to be stored or the session is lost. Presenting a spent token signs the
   * whole session out, which is the reuse-detection half of US-023 — so a
   * failure here means clear everything, not retry.
   */
  refresh(): Observable<Authenticated | null> {
    const refreshToken = this.session.refreshToken();
    if (!refreshToken) return of(null);

    const request = environment.useMockApi
      ? fakeRefresh()
      : this.api.postValidated(
          API_ROUTES.refresh,
          { refreshToken },
          authenticatedSchema
        );

    return request.pipe(tap((authenticated) => this.session.set(authenticated)));
  }

  /** Redeems an invitation and sets a first password. Does not sign the user in. */
  acceptInvitation(input: AcceptInvitationInput): Observable<AcceptedInvitation> {
    if (environment.useMockApi) {
      return mockResponse<AcceptedInvitation>({
        status: "accepted",
        email: "invited.user@acme.com"
      });
    }

    return this.api.postValidated(
      API_ROUTES.acceptInvitation,
      input,
      acceptedInvitationSchema
    );
  }

  /**
   * Signs out locally.
   *
   * Local only, and that is a real gap rather than a note for later. Clearing
   * the tokens from this tab does not revoke either — the refresh token stays
   * exchangeable for its full lifetime. This needs a `POST /auth/logout` that
   * invalidates it server-side, or a user who signs out on a shared machine has
   * not actually signed out.
   */
  signOut(): void {
    this.session.clear();
    void this.router.navigate(["/login"]);
  }

  private adopt(response: SignInResponse): void {
    // Narrowed on `status`: the challenge branch has no token to adopt, and the
    // discriminated union is what stops this from being a runtime check.
    if (response.status === "authenticated") this.session.set(response);
  }
}

// ── Demo doubles ────────────────────────────────────────────────────────────

/** Base32, so an authenticator app accepts it if someone actually scans the QR. */
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

/** The code the demo MFA challenge rejects, so the failure path is reviewable. */
export const DEMO_MFA_REJECTED_CODE = "000000";

/** The password that produces an MFA challenge instead of a session. */
export const DEMO_MFA_PASSWORD = "mfa";

/** The password the demo sign-in rejects outright. */
export const DEMO_FAILURE_PASSWORD = "fail";

/**
 * Demo sign-in. Any address and password are accepted.
 *
 * Two exceptions, both there because they are the only way to reach those
 * branches without a server: `fail` returns the same 401 the API would, and
 * `mfa` returns a challenge.
 */
function fakeSignIn(input: SignInInput): Observable<SignInResponse> {
  if (input.password === DEMO_FAILURE_PASSWORD) {
    return throwError(
      () => new ApiError(401, "Rejected by the demo sign-in.", "error.unauthorized")
    );
  }

  if (input.password === DEMO_MFA_PASSWORD) {
    return mockResponse<SignInResponse>({
      status: "mfa_required",
      challengeToken: "demo.challenge.token",
      expiresIn: 300
    });
  }

  return mockResponse<SignInResponse>(demoSession(input.email));
}

function fakeVerifyMfa(input: VerifyMfaInput): Observable<Authenticated> {
  if (input.code.trim() === DEMO_MFA_REJECTED_CODE) {
    // A wrong code, a replayed code and a spent recovery code all answer
    // identically on the real API; the demo does the same.
    return throwError(
      () => new ApiError(401, "Rejected by the demo challenge.", "error.unauthorized")
    );
  }
  return mockResponse(demoSession("amelia.hart@acme.com"));
}

function fakeConfirmMfa(input: ConfirmMfaInput): Observable<MfaEnabled> {
  if (input.code.trim() === DEMO_MFA_REJECTED_CODE) {
    return throwError(
      () => new ApiError(401, "Rejected by the demo enrolment.", "error.unauthorized")
    );
  }
  return mockResponse<MfaEnabled>({
    status: "mfa_enabled",
    recoveryCodes: [
      "K3PX-9DPE-HPWY",
      "JBSW-Y3DP-EHPK",
      "3PXP-JBSW-Y3DP",
      "EHPK-3PXP-JBSW",
      "Y3DP-EHPK-3PXP",
      "9DPE-HPK3-PXPJ",
      "SWY3-DPEH-PK3P",
      "XPJB-SWY3-DPEH"
    ]
  });
}

function fakeRefresh(): Observable<Authenticated> {
  return mockResponse(demoSession("amelia.hart@acme.com"), 250);
}

/**
 * A demo session for an address.
 *
 * The workspace is derived from the address's domain, mirroring what the API now
 * does: sign-in supplies no slug, so the mock must resolve one too or it would
 * be exercising a flow the server no longer has.
 */
function demoSession(email: string): Authenticated {
  const slug = demoSlugFor(email);
  return {
    status: "authenticated",
    user: { id: stableUuid(email), email },
    tenant: { id: stableUuid(slug), slug, name: demoTenantName(slug) },
    // Obviously fake, and inert: nothing verifies them and no request carries
    // them while the mock flag is on.
    accessToken: "demo.access.token",
    tokenType: "Bearer",
    expiresIn: 900,
    permissions: demoPermissions(slug),
    refreshToken: "demo.refresh.token",
    refreshExpiresIn: 1_209_600
  };
}

/**
 * Which workspace a demo address lands in.
 *
 * The domain's first label, so `ops@platform.test` reaches the operator console
 * and `amelia.hart@acme.com` reaches Acme. Crude on purpose: it exists so both
 * permission sets stay reachable without a backend, not to model anything.
 */
function demoSlugFor(email: string): string {
  const domain = email.split("@")[1] ?? "";
  return domain.split(".")[0]?.toLowerCase() || "acme";
}

/** Title-cased slug, standing in for the name a real tenant row would carry. */
function demoTenantName(slug: string): string {
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

/**
 * What the demo session may do.
 *
 * Signing in to the mock with an address on the reserved `platform` domain
 * yields the operator's permissions, so the cross-tenant screens are reachable
 * without a backend; every other domain gets an ordinary tenant administrator's
 * set. Faithful in both directions, which is the point of a mock — a demo where
 * every account sees every screen would hide exactly the difference these
 * permissions exist to draw.
 */
function demoPermissions(slug: string): string[] {
  return slug === PLATFORM_TENANT_SLUG
    ? [...PLATFORM_PERMISSION_KEYS, "tenant.read", "user.read", "audit.read"]
    : [...PERMISSION_KEYS];
}

/**
 * A UUID-shaped id derived from a string.
 *
 * Shaped, because the schemas declare these as UUIDs and a fixture that would
 * fail its own contract is a fixture that hides a bug. Derived rather than
 * random so signing in twice as the same person yields the same ids, which
 * keeps avatar tints and any id-keyed state stable across reloads.
 */
function stableUuid(seed: string): string {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
  }
  const hex = (offset: number, length: number) =>
    Math.abs(Math.imul(hash, offset + 7))
      .toString(16)
      .padStart(length, "0")
      .slice(0, length);

  return `${hex(1, 8)}-${hex(2, 4)}-4${hex(3, 3)}-8${hex(4, 3)}-${hex(5, 12)}`;
}
