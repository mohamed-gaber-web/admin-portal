import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Ip,
  NotFoundException,
  Param,
  Put,
  Req,
  UseGuards
} from "@nestjs/common";
import {
  PlatformPermissionNotGrantableError,
  PlatformRoleNotEditableError,
  UnknownPermissionError
} from "@growpath/db";
import type { Request } from "express";
import {
  API_ROUTES,
  updateRolePermissionsSchema,
  type Role,
  type UpdateRolePermissionsInput
} from "@growpath/contracts";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { actorFrom } from "../common/actor";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { RoleService } from "./role.service";

/**
 * Roles and their permissions, scoped to the caller's tenant (US-064).
 *
 * There is no create or delete. Roles come from provisioning, and a tenant that
 * can delete its own admin role is a tenant that can lock itself out — the
 * matrix changes what a role may do, which is the part that needs to be
 * editable.
 */
@Controller()
@UseGuards(AccessTokenGuard)
export class RoleController {
  constructor(private readonly roles: RoleService) {}

  @Get(API_ROUTES.roles)
  list(): Promise<Role[]> {
    return this.roles.list();
  }

  @Put(API_ROUTES.rolePermissions)
  async setPermissions(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateRolePermissionsSchema))
    dto: UpdateRolePermissionsInput,
    @Req() request: Request,
    @Ip() ip: string
  ): Promise<Role> {
    let role: Role | null;
    try {
      role = await this.roles.setPermissions(id, dto.permissions, actorFrom(request, ip));
    } catch (err) {
      if (err instanceof UnknownPermissionError) {
        // 400, not 500: the request named a permission the catalogue does not
        // contain, which the caller can fix. The catalogue is installed by
        // migration, so this means a key the schema has never heard of.
        throw new BadRequestException({
          message: err.message,
          permissions: err.permissions
        });
      }
      if (err instanceof PlatformPermissionNotGrantableError) {
        /**
         * 403, not 400 — and unreachable through a well-formed request.
         *
         * `updateRolePermissionsSchema` validates against the tenant half of
         * the catalogue, so a `platform.*` key is rejected by the pipe before
         * this handler runs. This exists for the day somebody widens that enum
         * without thinking it through: the answer is then a refusal that says
         * what happened rather than a 500 from the database trigger that
         * refuses the same grant one layer further down.
         */
        throw new ForbiddenException({
          message: err.message,
          permissions: err.permissions
        });
      }
      if (err instanceof PlatformRoleNotEditableError) {
        // The platform tier's own roles are not editable here. Saving this
        // screen against one would silently revoke the cross-tenant grants it
        // never displayed — see the note in `setRolePermissions`.
        throw new ForbiddenException({ message: err.message, role: err.role });
      }
      throw err;
    }

    if (!role) {
      // Another tenant's role id is simply not visible inside the scoped
      // session, so it answers 404 rather than 403.
      throw new NotFoundException({ message: "Role not found." });
    }
    return role;
  }
}
