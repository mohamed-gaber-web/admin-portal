import { MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { AuthController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./health/health.controller";
import { HealthService } from "./health/health.service";
import { CorrelationMiddleware } from "./observability/correlation.middleware";
import { RedisModule } from "./redis/redis.module";
import { TenantController } from "./tenant/tenant.controller";
import { TenantService } from "./tenant/tenant.service";

@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [AuthController, HealthController, TenantController],
  providers: [AuthService, HealthService, TenantService]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every route, including /health: a request with no correlation ID is a
    // request nobody can follow, and exemptions are how gaps appear.
    consumer.apply(CorrelationMiddleware).forRoutes("*");
  }
}
