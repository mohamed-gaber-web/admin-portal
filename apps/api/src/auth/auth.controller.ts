import { Body, Controller, Headers, HttpCode, Ip, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AccessTokenGuard } from "./access-token.guard";
import {
  API_ROUTES,
  acceptInvitationSchema,
  completePasswordResetSchema,
  confirmMfaSchema,
  logoutSchema,
  refreshSchema,
  requestPasswordResetSchema,
  signInSchema,
  verifyMfaSchema,
  type AcceptInvitationInput,
  type AcceptedInvitation,
  type Authenticated,
  type CompletePasswordResetInput,
  type ConfirmMfaInput,
  type LogoutInput,
  type MfaEnabled,
  type MfaEnrolmentStarted,
  type PasswordResetCompleted,
  type PasswordResetRequested,
  type RefreshInput,
  type RequestPasswordResetInput,
  type SignInInput,
  type SignInResponse,
  type VerifyMfaInput
} from "@growpath/contracts";
import { RateLimitGuard } from "../common/rate-limit.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { AuthService } from "./auth.service";

/**
 * Every route here is throttled per source (US-026).
 *
 * Applied at the controller rather than per route, so a route added later is
 * covered by default. These are the endpoints an attacker can reach without a
 * credential — the ones worth guessing at — and exempting one is the kind of
 * omission nobody notices until it is being used.
 */
@Controller()
@UseGuards(RateLimitGuard)
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
  ): Promise<SignInResponse> {
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
   * Ends a session.
   *
   * 204 and no body, always — for a live token, an expired one, one that was
   * revoked an hour ago and one that was never issued. A status or a body that
   * varied would turn this into an oracle for which refresh tokens exist, and it
   * is reachable without a session, so it would be a free one.
   */
  @Post(API_ROUTES.logout)
  @HttpCode(204)
  async logout(
    @Body(new ZodValidationPipe(logoutSchema)) dto: LogoutInput,
    @Ip() ip: string,
    @Headers("user-agent") userAgent: string
  ): Promise<void> {
    await this.auth.logout(dto, ip || null, userAgent || null);
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

  /**
   * Answers an MFA challenge and completes a sign-in (US-025).
   *
   * Unauthenticated: the caller holds a challenge token, not an access token —
   * having only a correct password is precisely the state this resolves.
   */
  @Post(API_ROUTES.verifyMfa)
  @HttpCode(200)
  verifyMfa(
    @Body(new ZodValidationPipe(verifyMfaSchema)) dto: VerifyMfaInput,
    @Ip() ip: string,
    @Headers("user-agent") userAgent: string
  ): Promise<Authenticated> {
    return this.auth.verifyMfa(dto, ip || null, userAgent || null);
  }

  /**
   * Starts TOTP enrolment for the signed-in user.
   *
   * The user comes from the verified token, never from the body: an enrolment
   * endpoint that took a user id would let anyone re-enrol anyone.
   */
  @Post(API_ROUTES.enrolMfa)
  @HttpCode(200)
  @UseGuards(AccessTokenGuard)
  enrolMfa(@Req() request: Request): Promise<MfaEnrolmentStarted> {
    return this.auth.enrolMfa(request.auth!.userId);
  }

  /** Confirms enrolment with a code from the authenticator app. */
  @Post(API_ROUTES.confirmMfa)
  @HttpCode(200)
  @UseGuards(AccessTokenGuard)
  confirmMfa(
    @Req() request: Request,
    @Body(new ZodValidationPipe(confirmMfaSchema)) dto: ConfirmMfaInput,
    @Ip() ip: string
  ): Promise<MfaEnabled> {
    return this.auth.confirmMfa(request.auth!.userId, dto, ip || null);
  }
}
