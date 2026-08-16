import { Controller, Get, UseGuards } from "@nestjs/common";
import { API_ROUTES, type TenantModule } from "@growpath/contracts";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { EntitlementService } from "./entitlement.service";

/**
 * The caller's own module entitlements (US-072).
 *
 * One route, and only a read. Which modules a tenant holds is a commercial
 * decision made by whoever operates the installation, so there is no writing
 * counterpart here and there must not be one — a tenant administrator able to
 * grant their own tenant a module is a tenant administrator who has been handed
 * the price list. The write is `PUT /platform/tenants/:id/modules`, behind
 * `platform.module.write`.
 *
 * No tenant in the path. It comes from the access token's claims and row level
 * security on `tenant_module` does the filtering, so another tenant's
 * entitlements are not something this route could be asked for.
 */
@Controller()
@UseGuards(AccessTokenGuard)
export class EntitlementController {
  constructor(private readonly entitlements: EntitlementService) {}

  @Get(API_ROUTES.modules)
  list(): Promise<TenantModule[]> {
    return this.entitlements.list();
  }
}
