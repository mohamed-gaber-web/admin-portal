import { Body, Controller, Headers, HttpCode, Ip, Post } from "@nestjs/common";
import {
  API_ROUTES,
  acceptInvitationSchema,
  signInSchema,
  type AcceptInvitationInput,
  type AcceptedInvitation,
  type Authenticated,
  type SignInInput
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

  /**
   * Signs in with a tenant slug, email and password.
   *
   * 200, not 201: nothing is created. The user agent is captured for the
   * authentication log — it is the one field that helps an operator tell a
   * script apart from a person during a credential-stuffing run.
   */
  @Post(API_ROUTES.login)
  @HttpCode(200)
  login(
    @Body(new ZodValidationPipe(signInSchema)) dto: SignInInput,
    @Ip() ip: string,
    @Headers("user-agent") userAgent: string
  ): Promise<Authenticated> {
    return this.auth.signIn(dto, ip || null, userAgent || null);
  }
}
