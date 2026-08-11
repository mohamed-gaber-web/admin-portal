import { Body, Controller, HttpCode, Ip, Post } from "@nestjs/common";
import {
  API_ROUTES,
  createTenantSchema,
  type CreateTenantInput,
  type ProvisionedTenant
} from "@growpath/contracts";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { TenantService } from "./tenant.service";

@Controller()
export class TenantController {
  constructor(private readonly tenants: TenantService) {}

  @Post(API_ROUTES.tenants)
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createTenantSchema)) dto: CreateTenantInput,
    @Ip() ip: string
  ): Promise<ProvisionedTenant> {
    // Provisioning creates the tenant, its default roles and its first admin
    // user in one transaction; a duplicate slug surfaces as 409. The client IP
    // is recorded on the audit entries (US-015).
    return this.tenants.create(dto, ip || null);
  }
}
