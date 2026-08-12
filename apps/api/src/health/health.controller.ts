import { Controller, Get, Res } from "@nestjs/common";
import type { Response } from "express";
import { API_ROUTES, type HealthStatus, type Readiness } from "@growpath/contracts";
import { HealthService } from "./health.service";

@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Liveness: is this process alive and able to serve at all.
   *
   * Checks nothing downstream, deliberately. If liveness probed Postgres, a
   * database blip would fail the check on every instance at once and the
   * orchestrator would restart the entire fleet — a restart cannot fix a
   * dependency that is down, so the outage would get worse rather than better.
   * Readiness is the endpoint for "the database is unreachable".
   */
  @Get(API_ROUTES.health)
  check(): HealthStatus {
    return { status: "ok", service: "api" };
  }

  /**
   * Readiness: should this instance receive traffic.
   *
   * 503 rather than 200-with-a-status-field, because load balancers and
   * orchestrators route on the status code; a body saying "not_ready" behind a
   * 200 is a body nothing reads.
   */
  @Get(API_ROUTES.ready)
  async ready(@Res({ passthrough: true }) res: Response): Promise<Readiness> {
    const readiness = await this.health.readiness();
    res.status(readiness.status === "ready" ? 200 : 503);
    return readiness;
  }
}
