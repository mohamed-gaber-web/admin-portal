import {
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { PermissionKey } from "@growpath/contracts";
import type { Request } from "express";
import { apiLogger } from "../observability/logger";

/**
 * The permission check for a tenant-scoped route.
 *
 * Roles have held permissions since the auth-foundation migration and the
 * portal has been able to edit them since US-064, but nothing on a tenant-scoped
 * route ever *read* them — a `viewer` was a viewer only because the screens
 * happened not to offer it a button, and anything that spoke to the API
 * directly held whatever an administrator held. This is what makes the
 * distinction real.
 *
 * Applied to two groups of routes, and the second is what makes the first mean
 * anything:
 *
 *   - **Configuration** — D365 connections and the mobile bootstrap record.
 *     `connection.read` / `connection.write` and `tenant.read` / `tenant.write`.
 *     This is the split a viewer is expected to feel: they see how the tenant is
 *     wired up and cannot rewire it.
 *   - **User and role administration** — the users list, invitations, status,
 *     role assignment and the permission matrix. `user.read` / `user.write`.
 *     Without this the first group is advisory: the matrix is where permissions
 *     are granted, so an account that could save it could grant itself
 *     `connection.write` and sign in again.
 *
 * The remaining tenant-scoped controllers still carry no check — companies, the
 * activity log, the D365 proxy the mobile app reads business data through — and
 * each is its own decision about which key it needs. The proxy in particular is
 * not obviously `connection.read`: it serves the app that ordinary staff use,
 * and guarding it with a portal permission would decide, by accident, who may
 * use the product.
 *
 * Runs after `AccessTokenGuard`, which is what put `request.auth` there, and
 * fails closed if that guard was forgotten: no claims means 401, never a pass.
 *
 * The claim is what is checked, not the database. Permissions are stamped into
 * the access token at sign-in, so a permission revoked mid-session keeps working
 * until the token expires — which is the same window `ACCESS_TOKEN_TTL_SECONDS`
 * already bounds for every other claim on it.
 */

const PERMISSION_KEY = "tenant:permission";

/**
 * Declares which permission a route requires.
 *
 * Mandatory wherever `PermissionGuard` is applied: the guard refuses a route
 * carrying no metadata rather than letting it through. A route added to a
 * guarded controller without a decorator is a route somebody forgot to think
 * about, and the failure should be loud rather than open.
 */
export const RequiresPermission = (permission: PermissionKey) =>
  SetMetadata(PERMISSION_KEY, permission);

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const claims = request.auth;

    if (!claims) {
      // AccessTokenGuard did not run, or ran and rejected. Either way there is
      // no verified identity here, and this guard must never be the thing that
      // decides an unauthenticated request is fine.
      throw new UnauthorizedException({ message: "Authentication required." });
    }

    const required = this.reflector.getAllAndOverride<PermissionKey | undefined>(
      PERMISSION_KEY,
      [context.getHandler(), context.getClass()]
    );

    if (!required) {
      throw new Error(
        "PermissionGuard is applied to a route with no @RequiresPermission. Declare the permission it needs."
      );
    }

    if (!claims.permissions.includes(required)) {
      /**
       * Logged at info, not warn.
       *
       * Unlike `platform.access.denied`, this is an ordinary event: a viewer
       * whose portal is a version behind, or somebody who genuinely tried the
       * wrong button. It is worth being able to find — "why can this person not
       * save" is a support question — without being worth an alert.
       */
      apiLogger.info("tenant.permission.denied", {
        required,
        path: request.path
      });

      // 403 rather than 404: the caller is inside the right tenant and the
      // resource is one they are allowed to *read*. Hiding its existence from
      // somebody already looking at it would only be confusing.
      throw new ForbiddenException({
        message: "You do not have permission to perform this action."
      });
    }

    return true;
  }
}
