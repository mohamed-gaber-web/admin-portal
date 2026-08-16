import { Injectable, inject } from "@angular/core";
import type { Observable } from "rxjs";
import {
  API_ROUTES,
  issuedUserInvitationSchema,
  userDetailSchema,
  userPageSchema,
  type IssuedUserInvitation
} from "@growpath/contracts";
import { ApiService, pathFor } from "@core/http/api.service";
import { nullOnNotFound } from "@core/http/not-found";
import type {
  Page,
  PageQuery,
  UserDetail,
  UserStatus,
  UserSummary
} from "@core/models";

export interface UserQuery extends PageQuery {
  status?: UserStatus | "all";
}

export type { IssuedUserInvitation };

/**
 * Users, within the caller's own tenant.
 *
 * No method takes a tenant, and none ever should: the API reads it from the
 * access token's claims and row level security does the filtering, so a tenant
 * this service could name is a tenant it could get wrong. That is also why
 * another tenant's user id comes back as a 404 rather than a 403 — the row is
 * not merely forbidden, it is invisible.
 */
@Injectable({ providedIn: "root" })
export class UsersService {
  private readonly api = inject(ApiService);

  list(query: UserQuery): Observable<Page<UserSummary>> {
    return this.api.getValidated(API_ROUTES.users, userPageSchema, {
      page: query.page,
      pageSize: query.pageSize,
      search: query.search,
      sort: query.sort,
      direction: query.direction,
      status: query.status
    });
  }

  get(id: string): Observable<UserDetail | null> {
    return this.api
      .getValidated(pathFor(API_ROUTES.user, { id }), userDetailSchema)
      .pipe(nullOnNotFound());
  }

  /**
   * Suspends or restores an account.
   *
   * Access only. Roles are untouched, deliberately — suspending someone and
   * silently dropping what they held would mean restoring access did not
   * restore what they had, and the person doing the restoring would have no way
   * to know what was lost.
   *
   * Reactivating a user who has never set a password is refused by the API with
   * a 400 rather than attempted: the account has no credential, so the thing
   * that helps them is a reissued invitation.
   */
  setStatus(id: string, status: UserStatus): Observable<UserSummary> {
    return this.api.patchValidated(
      pathFor(API_ROUTES.userStatus, { id }),
      { status },
      userDetailSchema
    );
  }

  /**
   * Replaces the set of roles a user holds.
   *
   * The whole set rather than a delta, so two administrators editing the same
   * user cannot interleave into an arrangement neither of them chose. Writes
   * `role.assigned` and `role.revoked` on the API side.
   */
  setRoles(id: string, roles: string[]): Observable<UserDetail> {
    return this.api.putValidated(
      pathFor(API_ROUTES.userRoles, { id }),
      { roles },
      userDetailSchema
    );
  }

  /**
   * Invites someone into the caller's tenant.
   *
   * The token comes back exactly once. Only a digest is stored, so an
   * invitation that is lost is reissued rather than recovered — which is why
   * the dialog shows it immediately and warns that it will not be shown again.
   */
  invite(email: string, role: string): Observable<IssuedUserInvitation> {
    return this.api.postValidated(
      API_ROUTES.userInvitations,
      { email, role },
      issuedUserInvitationSchema
    );
  }
}
