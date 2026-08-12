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
  InvalidInvitationError,
  withoutTenantScope
} from "@growpath/db";
import type {
  AcceptInvitationInput,
  AcceptedInvitation,
  Authenticated,
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
    const result = await withoutTenantScope(
      this.pool,
      {
        reason:
          "Sign-in precedes any tenant context; the supplied slug is an unverified claim until the credential checks out (US-021)."
      },
      (client) => authenticate(client, { ...input, ip, userAgent })
    );

    // Thrown after the transaction commits, never inside it. Rejecting from
    // within would roll back the auth_event that records the failed attempt,
    // and a failed sign-in nobody can see is the opposite of the requirement.
    if (!result.ok) {
      // 401 with one fixed message for every cause, so nothing here can leak
      // which of slug, email, status or password was wrong.
      throw new UnauthorizedException({ message: INVALID_CREDENTIALS_MESSAGE });
    }

    // Issued only after the credential checks out, and carrying the tenant the
    // database confirmed — not the slug the caller claimed (US-022).
    const { token, expiresIn } = await issueAccessToken({
      userId: result.user.userId,
      tenantId: result.user.tenantId,
      tenantSlug: result.user.tenantSlug,
      email: result.user.email,
      permissions: result.user.permissions
    });

    return {
      status: "authenticated",
      user: { id: result.user.userId, email: result.user.email },
      tenant: { id: result.user.tenantId, slug: result.user.tenantSlug },
      accessToken: token,
      tokenType: "Bearer",
      expiresIn
    };
  }
}
