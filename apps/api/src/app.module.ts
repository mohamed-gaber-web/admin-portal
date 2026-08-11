import { Module } from "@nestjs/common";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./health/health.controller";
import { TenantController } from "./tenant/tenant.controller";
import { TenantService } from "./tenant/tenant.service";

@Module({
  imports: [DatabaseModule],
  controllers: [HealthController, TenantController],
  providers: [TenantService]
})
export class AppModule {}
