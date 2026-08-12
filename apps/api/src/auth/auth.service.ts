import {
  BadRequestException,
  Inject,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";
import {
  acceptInvitation,
  authenticate,
  INVALID_CREDENTIALS_MESSAGE,
  INVALID_SESSION_MESSAGE,
  InvalidInvitationError,
  issueRefreshToken,
  rotateRefreshToken,
  withoutTenantScope,
  type AuthenticatedUser,
  type IssuedRefreshToken
} from "@growpath/db";
import type {
  AcceptInvitationInput,
  AcceptedInvitation,
  Authenticated,
  RefreshInput,
  SignInInput
} from "@growpath/contracts";
import type { Pool } from "pg";
import { DATABASE_POOL } from "../database/database.module";
import { issueAccessToken } from "./tokens";

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
  ): Promise<Authenticated> {
    // Unscoped by necessity: the caller has no session yet, and which tenant
    // they belong to is the question this request answers. The slug they
    // supplied is a claim, not a context — it is verified here, never trusted.
    const outcome = await withoutTenantScope(
      this.pool,
      {
        reason:
          "Sign-in precedes any tenant context; the supplied slug is an unverified claim until the credential checks out (US-021)."
      },
      async (client) => {
        const result = await authenticate(client, { ...input, ip, userAgent });
        if (!result.ok) {
          return { result };
        }
        // A sign-in starts a new family — no familyId, so the insert mints one.
        const refresh = await issueRefreshToken(client, {
          tenantId: result.user.tenantId,
          userId: result.user.userId,
          ip,
          userAgent
        });
        return { result, refresh };
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

    return this.authenticated(outcome.result.user, outcome.refresh!);
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
      tenant: { id: user.tenantId, slug: user.tenantSlug },
      accessToken: token,
      tokenType: "Bearer",
      expiresIn,
      refreshToken: refresh.token,
      refreshExpiresIn: Math.max(
        0,
        Math.floor((refresh.expiresAt.getTime() - Date.now()) / 1000)
      )
    };
  }
}
