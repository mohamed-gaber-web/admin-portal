import { ConflictException, Inject, Injectable } from "@nestjs/common";
import {
  findUserDetail,
  issueInvitation,
  listUsers,
  setUserName,
  setUserRoles,
  setUserStatus,
  SeatLimitReachedError,
  UserAlreadyActiveError,
  withRequestTenantScope,
  type AuditActor,
  type UserDetail as UserDetailRecord,
  type UserPageRequest,
  type UserSummary as UserSummaryRecord
} from "@growpath/db";
import type {
  InviteUserInput,
  IssuedUserInvitation,
  Page,
  UserDetail,
  UserSummary
} from "@growpath/contracts";
import type { Pool } from "pg";
import { DATABASE_POOL } from "../database/database.module";

const toSummary = (record: UserSummaryRecord): UserSummary => ({
  id: record.id,
  email: record.email,
  name: record.name,
  role: record.role,
  status: record.status,
  tenantSlug: record.tenantSlug,
  lastSeenAt: record.lastSeenAt?.toISOString() ?? null
});

const toDetail = (record: UserDetailRecord): UserDetail => ({
  ...toSummary(record),
  roles: record.roles,
  createdAt: record.createdAt.toISOString(),
  invitedBy: record.invitedBy
});

/**
 * Users within the caller's tenant.
 *
 * Note that no method takes a tenant identifier. `withRequestTenantScope` sets
 * the tenant from the request context — which the access token guard populated
 * from a signed claim — and row level security does the filtering. There is
 * nothing here for a caller to influence, which is what makes "another tenant's
 * user id" indistinguishable from "no such user".
 */
@Injectable()
export class UserService {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async list(request: UserPageRequest): Promise<Page<UserSummary>> {
    const page = await withRequestTenantScope(this.pool, (client) =>
      listUsers(client, request)
    );
    return { ...page, items: page.items.map(toSummary) };
  }

  async find(id: string): Promise<UserDetail | null> {
    const record = await withRequestTenantScope(this.pool, (client) =>
      findUserDetail(client, id)
    );
    return record ? toDetail(record) : null;
  }

  async setStatus(
    id: string,
    status: "active" | "suspended",
    actor: AuditActor
  ): Promise<UserDetail | null> {
    const record = await withRequestTenantScope(this.pool, (client) =>
      setUserStatus(client, id, status, actor)
    );
    return record ? toDetail(record) : null;
  }

  async setRoles(
    id: string,
    roles: readonly string[],
    actor: AuditActor
  ): Promise<UserDetail | null> {
    const record = await withRequestTenantScope(this.pool, (client) =>
      setUserRoles(client, id, roles, actor)
    );
    return record ? toDetail(record) : null;
  }

  /**
   * Invites someone into the caller's tenant.
   *
   * The whole thing runs in one scoped transaction: an invitation that exists
   * while the role it promised does not would be worse than a failed request,
   * because the person accepting it would arrive with no access and no
   * explanation.
   *
   * The token is returned once here and stored only as a digest — a lost
   * invitation is reissued, never recovered.
   */
  async invite(
    input: InviteUserInput,
    actor: AuditActor,
    invitedBy: string | null
  ): Promise<IssuedUserInvitation> {
    try {
      return await withRequestTenantScope(this.pool, async (client) => {
        // The tenant comes from the scoped session; `issueInvitation` predates
        // that mechanism and still takes it as an argument, so it is read back
        // from the context the session was opened with rather than from
        // anything the caller sent.
        const tenant = await client.query<{ id: string }>(
          "SELECT current_tenant_id() AS id"
        );
        const tenantId = tenant.rows[0].id;

        const invitation = await issueInvitation(client, {
          tenantId,
          email: input.email,
          actor,
          invitedBy
        });

        if (input.name) {
          await setUserName(client, invitation.userId, input.name);
        }

        await setUserRoles(client, invitation.userId, [input.role], actor);

        const user = await findUserDetail(client, invitation.userId);
        if (!user) {
          // Unreachable: the row was just created in this transaction. Thrown
          // rather than asserted so a future change that breaks the invariant
          // fails loudly instead of returning a half-built response.
          throw new Error("invited user vanished within its own transaction");
        }

        return {
          user: toSummary(user),
          token: invitation.token,
          expiresAt: invitation.expiresAt.toISOString()
        };
      });
    } catch (err) {
      if (err instanceof UserAlreadyActiveError) {
        // 409: the caller can act on this — the person already has an account,
        // so what they wanted was a password reset or a role change.
        throw new ConflictException({ message: err.message });
      }
      if (err instanceof SeatLimitReachedError) {
        /**
         * 409 as well, and for the same reason: nothing is broken, the request
         * conflicts with a state the caller can change. Not 402 — the tenant is
         * paid up, they have simply used what they bought — and not 403, which
         * would say this administrator may not invite people when in fact they
         * may, just not a twenty-sixth one.
         *
         * The counts ride along beside the message so the portal can render
         * them rather than parse them back out of the prose.
         */
        throw new ConflictException({
          message: err.message,
          seats: err.usage
        });
      }
      throw err;
    }
  }
}
