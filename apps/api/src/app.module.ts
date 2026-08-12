import { MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./health/health.controller";
import { HealthService } from "./health/health.service";
import { CorrelationMiddleware } from "./observability/correlation.middleware";
import { TenantController } from "./tenant/tenant.controller";
import { TenantService } from "./tenant/tenant.service";

@Module({
  imports: [DatabaseModule],
  controllers: [HealthController, TenantController],
  providers: [HealthService, TenantService]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every route, including /health: a request with no correlation ID is a
    // request nobody can follow, and exemptions are how gaps appear.
    consumer.apply(CorrelationMiddleware).forRoutes("*");
  }
}
