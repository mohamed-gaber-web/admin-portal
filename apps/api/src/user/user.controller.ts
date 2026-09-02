import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards
} from "@nestjs/common";
import type { Request } from "express";
import {
  API_ROUTES,
  inviteUserSchema,
  updateUserRolesSchema,
  updateUserStatusSchema,
  userQuerySchema,
  type InviteUserInput,
  type IssuedUserInvitation,
  type Page,
  type UpdateUserRolesInput,
  type UpdateUserStatusInput,
  type UserDetail,
  type UserQuery,
  type UserSummary
} from "@growpath/contracts";
import { UnknownRoleError, UserHasNoCredentialError } from "@growpath/db";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { PermissionGuard, RequiresPermission } from "../auth/permission.guard";
import { actorFrom } from "../common/actor";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { UserService } from "./user.service";

/**
 * User administration, scoped to the caller's tenant (US-064).
 *
 * The guard is on the controller rather than per route: every route here reads
 * or writes tenant data, and a route added later that forgot it would be
 * unscoped by default — which `withRequestTenantScope` would turn into a 500
 * rather than a leak, but a 500 is still a route nobody can use.
 *
 * `PermissionGuard` sits beside it for a reason that starts elsewhere: the
 * configuration routes now refuse a `viewer`, and a viewer who could invite
 * themselves a second account or hand their own role `connection.write` would
 * have unlocked that in two requests. A read-only account has to be read-only
 * about *who may act*, or it is not read-only about anything.
 *
 * `user.read` to look, `user.write` to change — including role assignment,
 * which is the most consequential write here and the one the catalogue means by
 * "invite and modify users".
 */
@Controller()
@UseGuards(AccessTokenGuard, PermissionGuard)
export class UserController {
  constructor(private readonly users: UserService) {}

  @Get(API_ROUTES.users)
  @RequiresPermission("user.read")
  list(
    @Query(new ZodValidationPipe(userQuerySchema)) query: UserQuery
  ): Promise<Page<UserSummary>> {
    return this.users.list(query);
  }

  /**
   * Invites someone into the caller's tenant.
   *
   * Declared before `GET /users/:id` in the file, though it does not need to
   * be: the methods differ, so `/users/invitations` cannot be captured by the
   * `:id` route. Kept adjacent to the list for readability.
   */
  @Post(API_ROUTES.userInvitations)
  @RequiresPermission("user.write")
  @HttpCode(201)
  async invite(
    @Body(new ZodValidationPipe(inviteUserSchema)) dto: InviteUserInput,
    @Req() request: Request,
    @Ip() ip: string
  ): Promise<IssuedUserInvitation> {
    try {
      return await this.users.invite(
        dto,
        actorFrom(request, ip),
        // Who is doing the inviting, from the token rather than the body.
        request.auth!.userId
      );
    } catch (err) {
      throw translateRoleError(err);
    }
  }

  @Get(API_ROUTES.user)
  @RequiresPermission("user.read")
  async get(@Param("id") id: string): Promise<UserDetail> {
    const user = await this.users.find(id);
    if (!user) {
      // 404, never 403. A 403 would confirm the user exists in another tenant,
      // which turns an id into an oracle.
      throw new NotFoundException({ message: "User not found." });
    }
    return user;
  }

  @Patch(API_ROUTES.userStatus)
  @RequiresPermission("user.write")
  async setStatus(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateUserStatusSchema)) dto: UpdateUserStatusInput,
    @Req() request: Request,
    @Ip() ip: string
  ): Promise<UserDetail> {
    let user: UserDetail | null;
    try {
      user = await this.users.setStatus(id, dto.status, actorFrom(request, ip));
    } catch (err) {
      if (err instanceof UserHasNoCredentialError) {
        // 400 with the reason: the operator can act on this by reissuing the
        // invitation, and a bare 500 from the check constraint would not say so.
        throw new BadRequestException({ message: err.message });
      }
      throw err;
    }

    if (!user) {
      throw new NotFoundException({ message: "User not found." });
    }
    return user;
  }

  /** Replaces the whole set of roles a user holds. */
  @Put(API_ROUTES.userRoles)
  @RequiresPermission("user.write")
  async setRoles(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateUserRolesSchema)) dto: UpdateUserRolesInput,
    @Req() request: Request,
    @Ip() ip: string
  ): Promise<UserDetail> {
    let user: UserDetail | null;
    try {
      user = await this.users.setRoles(id, dto.roles, actorFrom(request, ip));
    } catch (err) {
      throw translateRoleError(err);
    }

    if (!user) {
      throw new NotFoundException({ message: "User not found." });
    }
    return user;
  }
}

/**
 * An unknown role name is the caller's mistake, not a server fault.
 *
 * 400 rather than 404: the request named a role, and the thing that does not
 * exist is something the caller sent rather than the resource they addressed.
 */
function translateRoleError(err: unknown): unknown {
  if (err instanceof UnknownRoleError) {
    return new BadRequestException({ message: err.message, roles: err.roles });
  }
  return err;
}
