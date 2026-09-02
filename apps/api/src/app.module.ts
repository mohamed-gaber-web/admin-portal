import { MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { ActivityController } from "./activity/activity.controller";
import { ActivityService } from "./activity/activity.service";
import { AuthController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { CompanyController } from "./company/company.controller";
import { CompanyService } from "./company/company.service";
import { ConnectionController } from "./connection/connection.controller";
import { ConnectionService } from "./connection/connection.service";
import { D365TokenClient } from "./connection/d365-token.client";
import { D365ProxyController } from "./d365/d365-proxy.controller";
import { D365ProxyService } from "./d365/d365-proxy.service";
import { D365TokenCache } from "./d365/d365-token.cache";
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
import { UnhandledExceptionFilter } from "./common/unhandled-exception.filter";
import { RateLimitService } from "./common/rate-limit.service";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./health/health.controller";
import { HealthService } from "./health/health.service";
import { CorrelationMiddleware } from "./observability/correlation.middleware";
import { PlatformController } from "./platform/platform.controller";
import { PlatformService } from "./platform/platform.service";
import { PermissionGuard } from "./auth/permission.guard";
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
    D365ProxyController,
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
    // First, so an unhandled exception anywhere is logged with its cause and
    // answered with a classification rather than a bare 500.
    { provide: APP_FILTER, useClass: UnhandledExceptionFilter },
    ActivityService,
    AuthService,
    CompanyService,
    ConnectionService,
    D365TokenClient,
    D365ProxyService,
    D365TokenCache,
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
    PlatformGuard,
    // Same reason: it injects the Reflector to read @RequiresPermission.
    PermissionGuard
  ]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every route, including /health: a request with no correlation ID is a
    // request nobody can follow, and exemptions are how gaps appear.
    consumer.apply(CorrelationMiddleware).forRoutes("*");
  }
}
