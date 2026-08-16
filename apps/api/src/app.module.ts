import { MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { ActivityController } from "./activity/activity.controller";
import { ActivityService } from "./activity/activity.service";
import { AuthController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { CompanyController } from "./company/company.controller";
import { CompanyService } from "./company/company.service";
import { ConnectionController } from "./connection/connection.controller";
import { ConnectionService } from "./connection/connection.service";
import { D365TokenClient } from "./connection/d365-token.client";
import {
  MobileBootstrapController,
  MobileConfigController
} from "./mobile/mobile.controller";
import { MobileService } from "./mobile/mobile.service";
import { RoleController } from "./role/role.controller";
import { RoleService } from "./role/role.service";
import { UserController } from "./user/user.controller";
import { UserService } from "./user/user.service";
import { RateLimitGuard } from "./common/rate-limit.guard";
import { RateLimitService } from "./common/rate-limit.service";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./health/health.controller";
import { HealthService } from "./health/health.service";
import { CorrelationMiddleware } from "./observability/correlation.middleware";
import { PlatformController } from "./platform/platform.controller";
import { PlatformService } from "./platform/platform.service";
import { PlatformGuard } from "./auth/platform.guard";
import { RedisModule } from "./redis/redis.module";
import { EntitlementController } from "./entitlement/entitlement.controller";
import { EntitlementService } from "./entitlement/entitlement.service";
import { TenantController } from "./tenant/tenant.controller";
import { TenantService } from "./tenant/tenant.service";

@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [
    ActivityController,
    AuthController,
    CompanyController,
    ConnectionController,
    EntitlementController,
    HealthController,
    MobileBootstrapController,
    MobileConfigController,
    PlatformController,
    RoleController,
    TenantController,
    UserController
  ],
  providers: [
    ActivityService,
    AuthService,
    CompanyService,
    ConnectionService,
    D365TokenClient,
    EntitlementService,
    HealthService,
    MobileService,
    PlatformService,
    RoleService,
    TenantService,
    UserService,
    RateLimitService,
    RateLimitGuard,
    // Injects the pool and the Reflector, so it must be a provider rather than
    // only a decorator argument — `@UseGuards(PlatformGuard)` resolves it from
    // the container.
    PlatformGuard
  ]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every route, including /health: a request with no correlation ID is a
    // request nobody can follow, and exemptions are how gaps appear.
    consumer.apply(CorrelationMiddleware).forRoutes("*");
  }
}
