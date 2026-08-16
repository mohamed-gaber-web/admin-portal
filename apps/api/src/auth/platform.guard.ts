import {
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { withoutTenantScope } from "@growpath/db";
import type { PlatformPermissionKey } from "@growpath/contracts";
import type { Request } from "express";
import type { Pool } from "pg";
import { DATABASE_POOL } from "../database/database.module";
import { apiLogger } from "../observability/logger";

/**
 * The gate on every cross-tenant route.
 *
 * Two independent checks, and the redundancy is the point. This is the one tier
 * whose failure mode is *every* tenant's data, so it does not rest on a single
 * condition being right:
 *
 *   1. The token's `permissions` claim must contain the permission the route
 *      asks for. Signed at sign-in, so it cannot be edited by the holder.
 *   2. The caller's tenant must be the reserved platform tenant, confirmed
 *      against `tenant.is_platform` in the database rather than inferred from
 *      the slug.
 *
 * Either alone would be enough if nothing else ever went wrong. Together they
 * mean a mistake has to happen twice: a `platform.*` key somehow granted inside
 * an ordinary tenant still fails (2), and a platform operator whose role was
 * stripped still fails (1). The database refuses that first scenario outright
 * — see the platform-administration migration's trigger — which makes this the
 * third layer rather than the second.
 *
 * Runs after `AccessTokenGuard`, which is what put `request.auth` there. It
 * fails closed if that guard was forgotten: no claims means 401, never a pass.
 */

const PLATFORM_PERMISSION_KEY = "platform:permission";

/**
 * Declares which permission a platform route requires.
 *
 * Mandatory: `PlatformGuard` refuses a route that does not carry this metadata
 * rather than defaulting to "any platform permission will do". A route added
 * without thinking about which permission it needs should not quietly inherit
 * the widest one.
 */
export const RequiresPlatformPermission = (permission: PlatformPermissionKey) =>
  SetMetadata(PLATFORM_PERMISSION_KEY, permission);

@Injectable()
export class PlatformGuard implements CanActivate {
  /**
   * The platform tenant's id, resolved once per process.
   *
   * Cached because it cannot change: the migration creates exactly one row with
   * `is_platform`, and a unique index makes a second one impossible. The cache
   * holds the *promise*, so concurrent first requests share one lookup rather
   * than racing several.
   *
   * A failed lookup is not cached — leaving it null means a database blip
   * during the first platform request does not poison every later one.
   */
  private platformTenantId: Promise<string | null> | null = null;

  constructor(
    private readonly reflector: Reflector,
    @Inject(DATABASE_POOL) private readonly pool: Pool
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const claims = request.auth;

    if (!claims) {
      // AccessTokenGuard did not run, or ran and rejected. Either way there is
      // no verified identity here, and this guard must never be the thing that
      // decides an unauthenticated request is fine.
      throw new UnauthorizedException({ message: "Authentication required." });
    }

    const required = this.reflector.getAllAndOverride<PlatformPermissionKey | undefined>(
      PLATFORM_PERMISSION_KEY,
      [context.getHandler(), context.getClass()]
    );

    if (!required) {
      throw new Error(
        "PlatformGuard is applied to a route with no @RequiresPlatformPermission. Declare the permission it needs."
      );
    }

    const holdsPermission = claims.permissions.includes(required);
    const insidePlatformTenant = claims.tenantId === (await this.resolvePlatformTenantId());

    if (!holdsPermission || !insidePlatformTenant) {
      /**
       * Logged, always — including the near miss.
       *
       * A signed-in tenant administrator probing `/platform/*` is the single
       * most interesting thing in this log: it is either a misconfigured client
       * or somebody testing the boundary, and both are worth being able to find
       * afterwards. `tenantId` and `userId` are already on every line from the
       * request context.
       */
      apiLogger.warn("platform.access.denied", {
        required,
        holdsPermission,
        insidePlatformTenant,
        path: request.path
      });

      // 403 rather than 404 here, unlike a tenant-scoped resource. There is no
      // id being probed and nothing whose existence a 403 could confirm: these
      // paths are in the shared contract, so "this route exists and you may not
      // use it" reveals nothing that reading the client bundle would not.
      throw new ForbiddenException({
        message: "This operation requires a platform administrator."
      });
    }

    return true;
  }

  private resolvePlatformTenantId(): Promise<string | null> {
    if (this.platformTenantId) {
      return this.platformTenantId;
    }

    const lookup = withoutTenantScope(
      this.pool,
      {
        reason:
          "Resolving the reserved platform tenant, which by definition is not the tenant of any scoped session (platform tier)."
      },
      async (client) => {
        const res = await client.query<{ id: string }>(
          "SELECT id FROM tenant WHERE is_platform LIMIT 1"
        );
        return res.rows[0]?.id ?? null;
      }
    ).catch((err: unknown) => {
      // Forget the failure so the next request retries. Caching a rejected
      // lookup would turn one database blip into a permanently broken tier —
      // and the local variable is what makes this safe: clearing the field does
      // not change the promise this call already returned.
      if (this.platformTenantId === lookup) {
        this.platformTenantId = null;
      }
      throw err;
    });

    this.platformTenantId = lookup;
    return lookup;
  }
}
