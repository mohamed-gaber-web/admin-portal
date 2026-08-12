import { Body, Controller, HttpCode, Ip, Post } from "@nestjs/common";
import {
  API_ROUTES,
  acceptInvitationSchema,
  type AcceptInvitationInput,
  type AcceptedInvitation
} from "@growpath/contracts";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { AuthService } from "./auth.service";

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * Redeems an invitation and sets the user's first password.
   *
   * 200 rather than 201: nothing is created here. The user row already existed
   * — issuing the invitation made it — and this gives it a credential.
   */
  @Post(API_ROUTES.acceptInvitation)
  @HttpCode(200)
  accept(
    @Body(new ZodValidationPipe(acceptInvitationSchema)) dto: AcceptInvitationInput,
    @Ip() ip: string
  ): Promise<AcceptedInvitation> {
    return this.auth.acceptInvitation(dto, ip || null);
  }
}
