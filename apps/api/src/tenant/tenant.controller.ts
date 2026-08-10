import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { API_ROUTES, createTenantSchema, type CreateTenantInput } from "@growpath/contracts";
import { ZodValidationPipe } from "../common/zod-validation.pipe";

@Controller()
export class TenantController {
  @Post(API_ROUTES.tenants)
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createTenantSchema)) dto: CreateTenantInput
  ): { tenant: CreateTenantInput } {
    // No persistence yet (that's US-002); US-003 proves shared-schema validation.
    return { tenant: dto };
  }
}
