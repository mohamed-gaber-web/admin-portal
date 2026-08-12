import { Body, Controller, Headers, HttpCode, Ip, Post } from "@nestjs/common";
import {
  API_ROUTES,
  acceptInvitationSchema,
  completePasswordResetSchema,
  refreshSchema,
  requestPasswordResetSchema,
  signInSchema,
  type AcceptInvitationInput,
  type AcceptedInvitation,
  type Authenticated,
  type CompletePasswordResetInput,
  type PasswordResetCompleted,
  type PasswordResetRequested,
  type RefreshInput,
  type RequestPasswordResetInput,
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

  /**
   * Exchanges a refresh token for a new pair.
   *
   * 200, not 201: from the caller's side this continues a session rather than
   * creating one. The IP and user agent are recorded on the new token, so a
   * family that suddenly rotates from another continent is visible afterwards.
   */
  @Post(API_ROUTES.refresh)
  @HttpCode(200)
  refresh(
    @Body(new ZodValidationPipe(refreshSchema)) dto: RefreshInput,
    @Ip() ip: string,
    @Headers("user-agent") userAgent: string
  ): Promise<Authenticated> {
    return this.auth.refresh(dto, ip || null, userAgent || null);
  }

  /**
   * Asks for a reset link.
   *
   * 202, and the same 202 whether or not the address exists — the status code
   * is part of the response, so varying it would leak exactly what the fixed
   * body is there to hide.
   */
  @Post(API_ROUTES.requestPasswordReset)
  @HttpCode(202)
  requestPasswordReset(
    @Body(new ZodValidationPipe(requestPasswordResetSchema)) dto: RequestPasswordResetInput,
    @Ip() ip: string,
    @Headers("user-agent") userAgent: string
  ): Promise<PasswordResetRequested> {
    return this.auth.requestPasswordReset(dto, ip || null, userAgent || null);
  }

  /** Redeems a reset link and sets a new password. */
  @Post(API_ROUTES.completePasswordReset)
  @HttpCode(200)
  completePasswordReset(
    @Body(new ZodValidationPipe(completePasswordResetSchema)) dto: CompletePasswordResetInput,
    @Ip() ip: string,
    @Headers("user-agent") userAgent: string
  ): Promise<PasswordResetCompleted> {
    return this.auth.completePasswordReset(dto, ip || null, userAgent || null);
  }
}
