import {
  Body,
  Controller,
  Get,
  Ip,
  NotFoundException,
  Put,
  Query,
  Req,
  UseGuards
} from "@nestjs/common";
import type { Request } from "express";
import {
  API_ROUTES,
  mobileConfigQuerySchema,
  saveMobileConfigSchema,
  type MobileConfig,
  type MobileConfigQuery,
  type SaveMobileConfigInput
} from "@growpath/contracts";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { PermissionGuard, RequiresPermission } from "../auth/permission.guard";
import { actorFrom } from "../common/actor";
import { RateLimitGuard } from "../common/rate-limit.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { MobileService } from "./mobile.service";

/**
 * The device-facing bootstrap endpoint (US-040).
 *
 * **Unauthenticated, and it has to be.** This is what a freshly installed app
 * calls before it can sign anybody in — it is the endpoint that tells the app
 * where the API is — so requiring a token would require the app to already know
 * what it is asking for.
 *
 * Throttled per source, like the other unauthenticated routes. The slug is
 * caller-supplied, so this is enumerable in principle; it is enumerable to
 * exactly the degree `POST /auth/login` already is, which takes the same slug
 * and is the reason the throttle exists. What an enumerated slug yields here is
 * a public client id and an API URL — a customer *name*, which is worth
 * throttling, and no credential, which is why it is not worth more than that.
 *
 * An unknown slug, an archived tenant and a suspended one answer with the same
 * 404. Suspension in particular has to be a real 404: a suspended tenant whose
 * devices kept receiving a working configuration would be suspended in the
 * portal only.
 */
@Controller()
@UseGuards(RateLimitGuard)
export class MobileBootstrapController {
  constructor(private readonly mobile: MobileService) {}

  @Get(API_ROUTES.mobileConfig)
  async bootstrap(
    @Query(new ZodValidationPipe(mobileConfigQuerySchema)) query: MobileConfigQuery
  ): Promise<MobileConfig> {
    const config = await this.mobile.bootstrap(query.slug);
    if (!config) {
      throw new NotFoundException({ message: "No configuration for that tenant." });
    }
    return config;
  }
}

/**
 * The same record, administered.
 *
 * A separate controller rather than a third method on the one above, because the
 * two have different guards and different audiences, and a guard that applies to
 * a controller cannot be half-applied. Mixing them would put an authenticated
 * route and an unauthenticated one under one `@UseGuards`, which is precisely
 * the arrangement where someone later adds a route to the wrong half.
 *
 * `tenant.read` to look and `tenant.write` to change, so a viewer sees the
 * configuration and cannot alter it. `apiBaseUrl` is the reason the split
 * matters here more than the wording suggests: it redirects every device in the
 * field to whatever it names, which makes this the most consequential form in
 * the tenant and the last one a read-only account should be able to submit.
 */
@Controller()
@UseGuards(AccessTokenGuard, PermissionGuard)
export class MobileConfigController {
  constructor(private readonly mobile: MobileService) {}

  @Get(API_ROUTES.tenantMobileConfig)
  @RequiresPermission("tenant.read")
  async find(): Promise<MobileConfig> {
    const config = await this.mobile.find();
    if (!config) {
      // A tenant that has never configured one. 404 rather than an empty
      // object, so "not set up yet" is distinguishable from "set up with
      // blanks" — the screen shows a different thing for each.
      throw new NotFoundException({ message: "No mobile configuration for this tenant." });
    }
    return config;
  }

  /**
   * Creates or replaces it.
   *
   * PUT rather than POST-then-PATCH: there is at most one per tenant, so "does
   * it exist yet" is a question the screen would otherwise have to ask only in
   * order to pick a verb.
   */
  @Put(API_ROUTES.tenantMobileConfig)
  @RequiresPermission("tenant.write")
  async save(
    @Body(new ZodValidationPipe(saveMobileConfigSchema)) dto: SaveMobileConfigInput,
    @Req() request: Request,
    @Ip() ip: string
  ): Promise<MobileConfig> {
    const config = await this.mobile.save(dto, actorFrom(request, ip));
    if (!config) {
      throw new NotFoundException({ message: "No mobile configuration for this tenant." });
    }
    return config;
  }
}
