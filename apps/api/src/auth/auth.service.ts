import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { acceptInvitation, InvalidInvitationError, withoutTenantScope } from "@growpath/db";
import type { AcceptInvitationInput, AcceptedInvitation } from "@growpath/contracts";
import type { Pool } from "pg";
import { DATABASE_POOL } from "../database/database.module";

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
}
