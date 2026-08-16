import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import {
  activityQuerySchema,
  API_ROUTES,
  type ActivityEntry,
  type ActivityQuery,
  type Page
} from "@growpath/contracts";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ActivityService } from "./activity.service";

/**
 * The audit trail, scoped to the caller's tenant.
 *
 * Read-only, and there is no route that writes one: audit entries are written
 * by the operations they describe, in the same transaction. An endpoint that
 * accepted an entry would let a caller write their own history.
 */
@Controller()
@UseGuards(AccessTokenGuard)
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get(API_ROUTES.activity)
  list(
    @Query(new ZodValidationPipe(activityQuerySchema)) query: ActivityQuery
  ): Promise<Page<ActivityEntry>> {
    return this.activity.list(query);
  }
}
