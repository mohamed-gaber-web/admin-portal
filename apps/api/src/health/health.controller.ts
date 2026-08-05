import { Controller, Get } from "@nestjs/common";
import { API_ROUTES, type HealthStatus } from "@growpath/contracts";

@Controller()
export class HealthController {
  @Get(API_ROUTES.health)
  check(): HealthStatus {
    return { status: "ok", service: "api" };
  }
}
