import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";
import {
  acceptInvitation,
  authenticate,
  beginMfaEnrolment,
  completePasswordReset,
  confirmMfaEnrolment,
  INVALID_CREDENTIALS_MESSAGE,
  INVALID_SESSION_MESSAGE,
  InvalidInvitationError,
  InvalidMfaCodeError,
  InvalidPasswordResetError,
  issueRefreshToken,
  loadAuthenticatedUser,
  MfaAlreadyEnabledError,
  mfaIsEnabled,
  recordAuthEvent,
  requestPasswordReset,
  revokeSessionByRefreshToken,
  rotateRefreshToken,
  verifyMfa,
  withoutTenantScope,
  withRequestTenantScope,
  type AuthenticatedUser,
  type IssuedRefreshToken
} from "@growpath/db";
import type {
  AcceptInvitationInput,
  AcceptedInvitation,
  Authenticated,
  CompletePasswordResetInput,
  ConfirmMfaInput,
  LogoutInput,
  MfaEnabled,
  MfaEnrolmentStarted,
  PasswordResetCompleted,
  PasswordResetRequested,
  RefreshInput,
  RequestPasswordResetInput,
  SignInInput,
  SignInResponse,
  VerifyMfaInput
} from "@growpath/contracts";
import { apiLogger } from "../observability/logger";
import type { Pool } from "pg";
import { DATABASE_POOL } from "../database/database.module";
import { issueAccessToken, issueMfaChallenge, verifyMfaChallenge } from "./tokens";

@Injectable()
export class AuthService {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async acceptInvitation(
    input: AcceptInvitationInput,
    ip: string | null
  ): Promise<AcceptedInvitation> {
    try {
      // Deliberately unscoped: the person redeeming has no credential and no
      // session, so there is no authenticated tenant to scope to. The token is
      // what resolves the tenant, and it is the only thing that can.
      const accepted = await withoutTenantScope(
        this.pool,
        {
          reason:
            "Redeeming an invitation happens before the user has any credential, so no tenant context exists yet; the token resolves the tenant (US-020)."
        },
        (client) => acceptInvitation(client, { ...input, ip })
      );

      return { status: "accepted", email: accepted.email };
    } catch (err) {
      if (err instanceof InvalidInvitationError) {
        // 400 with one fixed message. Unknown, expired and already-accepted
        // tokens must be indistinguishable, so the reason never reaches here —
        // the service layer already collapsed them into one error.
        throw new BadRequestException({ message: err.message });
      }
      throw err;
    }
  }

  async signIn(
    input: SignInInput,
    ip: string | null,
    userAgent: string | null
  ): Promise<SignInResponse> {
    // Unscoped by necessity: the caller has no session yet, and which tenant
    // they belong to is the question this request answers. Nothing in the
    // request names a tenant at all now — the address resolves one, and only
    // once the password checks out does that resolution become a context.
    const outcome = await withoutTenantScope(
      this.pool,
      {
        reason:
          "Sign-in precedes any tenant context; the tenant is resolved from the address and is not a context until the credential checks out (US-021)."
      },
      async (client) => {
        const result = await authenticate(client, { ...input, ip, userAgent });
        if (!result.ok) {
          return { result, mfaRequired: false };
        }

        // US-025 AC2. No refresh token is issued on this branch at all — not
        // issued-and-withheld, not issued-and-revoked. A correct password alone
        // must leave nothing behind that could reach tenant data.
        if (await mfaIsEnabled(client, result.user.userId)) {
          return { result, mfaRequired: true };
        }

        // A sign-in starts a new family — no familyId, so the insert mints one.
        const refresh = await issueRefreshToken(client, {
          tenantId: result.user.tenantId,
          userId: result.user.userId,
          ip,
          userAgent
        });
        return { result, mfaRequired: false, refresh };
      }
    );

    // Thrown after the transaction commits, never inside it. Rejecting from
    // within would roll back the auth_event that records the failed attempt,
    // and a failed sign-in nobody can see is the opposite of the requirement.
    if (!outcome.result.ok) {
      // 401 with one fixed message for every cause, so nothing here can leak
      // which of slug, email, status or password was wrong.
      throw new UnauthorizedException({ message: INVALID_CREDENTIALS_MESSAGE });
    }

    if (outcome.mfaRequired) {
      const challenge = await issueMfaChallenge({
        userId: outcome.result.user.userId,
        tenantId: outcome.result.user.tenantId
      });
      return {
        status: "mfa_required",
        challengeToken: challenge.token,
        expiresIn: challenge.expiresIn
      };
    }

    return this.authenticated(outcome.result.user, outcome.refresh!);
  }

  /**
   * Answers an MFA challenge and completes the sign-in (US-025).
   *
   * The challenge token proves a password was checked in an earlier request;
   * the code proves the second factor. Only both together produce a session.
   */
  async verifyMfa(
    input: VerifyMfaInput,
    ip: string | null,
    userAgent: string | null
  ): Promise<Authenticated> {
    const claims = await verifyMfaChallenge(input.challengeToken);
    if (!claims) {
      // Expired, forged, or an access token presented in its place.
      throw new UnauthorizedException({ message: INVALID_CREDENTIALS_MESSAGE });
    }

    const outcome = await withoutTenantScope(
      this.pool,
      {
        reason:
          "Answering an MFA challenge happens before a session exists; the challenge token resolves the user (US-025)."
      },
      async (client) => {
        const verification = await verifyMfa(client, {
          userId: claims.userId,
          code: input.code,
          ip,
          userAgent
        });
        if (!verification.ok) {
          return { verification };
        }

        // Re-read rather than trusting the challenge: an account disabled
        // between the password step and this one must not get a session.
        const user = await loadAuthenticatedUser(client, claims.userId);
        if (!user) {
          return { verification: { ok: false as const, reason: "invalid" as const } };
        }

        const refresh = await issueRefreshToken(client, {
          tenantId: user.tenantId,
          userId: user.userId,
          ip,
          userAgent
        });
        return { verification, user, refresh };
      }
    );

    // After the commit, so the auth_event recording the failure survives.
    if (!outcome.verification.ok) {
      // One message for a wrong code, a replayed code and a spent recovery
      // code alike.
      throw new UnauthorizedException({ message: new InvalidMfaCodeError().message });
    }

    return this.authenticated(outcome.user!, outcome.refresh!);
  }

  /**
   * Starts TOTP enrolment for the signed-in user.
   *
   * Tenant-scoped through the request context (US-012): the user row this
   * touches is resolved from the access token's claims, and there is no
   * parameter naming whose enrolment it is.
   */
  async enrolMfa(userId: string): Promise<MfaEnrolmentStarted> {
    try {
      const enrolment = await withRequestTenantScope(this.pool, (client) =>
        beginMfaEnrolment(client, { userId })
      );
      return { status: "enrolment_started", secret: enrolment.secret, uri: enrolment.uri };
    } catch (err) {
      if (err instanceof MfaAlreadyEnabledError) {
        throw new ConflictException({ message: err.message });
      }
      throw err;
    }
  }

  /** Confirms enrolment with a code from the app, and issues recovery codes. */
  async confirmMfa(
    userId: string,
    input: ConfirmMfaInput,
    ip: string | null
  ): Promise<MfaEnabled> {
    try {
      const confirmed = await withRequestTenantScope(this.pool, (client) =>
        confirmMfaEnrolment(client, { userId, code: input.code, ip })
      );
      return { status: "mfa_enabled", recoveryCodes: confirmed.recoveryCodes };
    } catch (err) {
      if (err instanceof MfaAlreadyEnabledError) {
        throw new ConflictException({ message: err.message });
      }
      if (err instanceof InvalidMfaCodeError) {
        throw new BadRequestException({ message: err.message });
      }
      throw err;
    }
  }

  /**
   * Exchanges a refresh token for a new pair (US-023).
   *
   * Unauthenticated, necessarily: the access token this replaces has expired,
   * which is the reason the caller is here. The refresh token is therefore the
   * only credential, and rotating it on every use is what makes a stolen one
   * detectable rather than silently reusable.
   */
  async refresh(
    input: RefreshInput,
    ip: string | null,
    userAgent: string | null
  ): Promise<Authenticated> {
    const result = await withoutTenantScope(
      this.pool,
      {
        reason:
          "Exchanging a refresh token happens with no access token and so no tenant context; the token itself resolves the tenant (US-023)."
      },
      (client) => rotateRefreshToken(client, { token: input.refreshToken, ip, userAgent })
    );

    // Again after the commit: a replay revokes the family and writes the
    // auth_event, and throwing from inside the transaction would discard both —
    // losing precisely the record that a leaked token was detected.
    if (!result.ok) {
      // One message for unknown, expired, revoked and replayed alike. Telling a
      // thief their token was recognised-but-spent confirms they hold a real one.
      throw new UnauthorizedException({ message: INVALID_SESSION_MESSAGE });
    }

    return this.authenticated(result.user, result.refresh);
  }

  /**
   * Ends a session, server-side.
   *
   * Until this existed, signing out cleared the tokens from one client and left
   * the refresh token exchangeable for its full fourteen days. On a shared
   * warehouse device that is not a sign-out; it is a sign-out-looking button.
   *
   * Answers nothing, and answers it identically whether the token was live,
   * expired, already revoked or never real. There is no branch a caller can
   * observe, because any difference would confirm which tokens exist — the same
   * reason `requestPasswordReset` returns one fixed 202.
   *
   * Unscoped: whoever is signing out may hold an access token that expired
   * hours ago, so there is no tenant context, and the refresh token resolves the
   * tenant the same way it does at `/auth/refresh`.
   */
  async logout(
    input: LogoutInput,
    ip: string | null,
    userAgent: string | null
  ): Promise<void> {
    await withoutTenantScope(
      this.pool,
      {
        reason:
          "Signing out happens with no usable access token and so no tenant context; the refresh token resolves the tenant (US-046)."
      },
      async (client) => {
        const revoked = await revokeSessionByRefreshToken(client, input.refreshToken);
        await recordAuthEvent(client, {
          tenantId: revoked?.tenantId ?? null,
          userId: revoked?.userId ?? null,
          event: "session.signed_out",
          // "succeeded" for an unrecognised token too. From the caller's side
          // the request did what it asked — the session is not usable — and the
          // distinction lives in `reason`, which is not returned.
          outcome: "succeeded",
          reason: revoked ? null : "no matching session",
          ip,
          userAgent
        });
      }
    );
  }

  /**
   * Asks for a reset link (US-024).
   *
   * Always answers the same thing. Whether an account exists is decided inside
   * `requestPasswordReset`, and the difference goes no further than the log —
   * a response that varies is an account-enumeration oracle, and this is the
   * endpoint where that usually happens.
   */
  async requestPasswordReset(
    input: RequestPasswordResetInput,
    ip: string | null,
    userAgent: string | null
  ): Promise<PasswordResetRequested> {
    const issued = await withoutTenantScope(
      this.pool,
      {
        reason:
          "A reset request arrives with no session; the address is an unverified claim until it is looked up (US-024)."
      },
      (client) => requestPasswordReset(client, { ...input, ip, userAgent })
    );

    if (issued) {
      // Standing in for the email that US-0xx will send. The token itself is
      // never logged — it is a credential, and the logger would redact the
      // field anyway, but not putting it there is the actual defence.
      apiLogger.info("password_reset.link_issued", {
        tenantId: issued.tenantId,
        userId: issued.userId,
        expiresAt: issued.expiresAt.toISOString()
      });
    }

    return { status: "accepted" };
  }

  /**
   * Redeems a reset link and sets a new password.
   *
   * Returns no session on purpose: the reset just revoked every refresh token
   * the user had, and handing back a fresh one would exempt whoever redeemed
   * the link from the revocation they triggered.
   */
  async completePasswordReset(
    input: CompletePasswordResetInput,
    ip: string | null,
    userAgent: string | null
  ): Promise<PasswordResetCompleted> {
    const result = await withoutTenantScope(
      this.pool,
      {
        reason:
          "Redeeming a reset link happens before any session exists; the token resolves the tenant (US-024)."
      },
      (client) => completePasswordReset(client, { ...input, ip, userAgent })
    );

    // Thrown after the commit, so the auth_event recording the refusal survives
    // it — rejecting from inside the transaction would discard exactly the
    // record AC3 asks for.
    if (!result.ok) {
      // 400 with one fixed message: unknown, expired and already-used must be
      // indistinguishable to whoever is holding a guessed token.
      throw new BadRequestException({ message: new InvalidPasswordResetError().message });
    }

    return { status: "reset", email: result.reset.email };
  }

  /** The response shape shared by sign-in and refresh. */
  private async authenticated(
    user: AuthenticatedUser,
    refresh: IssuedRefreshToken
  ): Promise<Authenticated> {
    // Carrying the tenant the database confirmed — not one the caller claimed
    // and not one read from a header (US-022).
    const { token, expiresIn } = await issueAccessToken({
      userId: user.userId,
      tenantId: user.tenantId,
      tenantSlug: user.tenantSlug,
      email: user.email,
      permissions: user.permissions
    });

    return {
      status: "authenticated",
      user: { id: user.userId, email: user.email },
      // The workspace, carried out because nothing carried one in. The name is
      // what the portal shows; the slug stays for anything that keys on it.
      tenant: { id: user.tenantId, slug: user.tenantSlug, name: user.tenantName },
      accessToken: token,
      tokenType: "Bearer",
      expiresIn,
      // The same list the token carries, surfaced so a client can decide what
      // to render — the platform section of the navigation, for instance. It
      // discloses nothing the holder cannot already read out of the JWT
      // payload, and no server-side check reads it back.
      permissions: user.permissions,
      refreshToken: refresh.token,
      refreshExpiresIn: Math.max(
        0,
        Math.floor((refresh.expiresAt.getTime() - Date.now()) / 1000)
      )
    };
  }
}
