import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";
import { TenantController } from "./tenant/tenant.controller";

@Module({
  controllers: [HealthController, TenantController]
})
export class AppModule {}
