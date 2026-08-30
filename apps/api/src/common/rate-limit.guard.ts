import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable
} from "@nestjs/common";
import type { Request, Response } from "express";
import { RateLimitService } from "./rate-limit.service";

/**
 * Requests per source, per window, on the authentication endpoints.
 *
 * Ten a minute is far above what a person signing in produces — even a bad
 * typist, with a password manager misfiring, does not reach it — and far below
 * what credential stuffing needs to be worth attempting.
 *
 * This number must stay **below** `LOCKOUT_THRESHOLD` in `@growpath/db`. That
 * relationship is the mitigation for the trap in AC2: if one source could issue
 * enough failures inside a window to lock an account, an attacker would have a
 * way to lock any victim out on demand.
 *
 * It is asserted in `tests/us026-rate-limiting.test.ts` rather than here, and
 * that is deliberate. Importing the constant meant importing the `@growpath/db`
 * barrel into a guard Nest resolves during module initialisation — which drags
 * `pg` and the native `argon2` binding in with it and stalls the event loop
 * long enough for the 2s Redis readiness probe to time out. It reproducibly
 * broke US-016. A constant is not worth booting the data layer twice as early;
 * CI enforces the relationship instead.
 */
export const AUTH_RATE_LIMIT = positiveInt(process.env.AUTH_RATE_LIMIT, 10);

/**
 * The window, in milliseconds.
 *
 * Configurable because the other auth test suites make far more than ten
 * requests a second from one address and would otherwise throttle themselves.
 * They shorten the **window** rather than raising the limit, deliberately: the
 * limit's relationship to `LOCKOUT_THRESHOLD` is a security property, and a
 * knob that let a caller weaken it would be a knob someone eventually turns in
 * production.
 */
export const AUTH_RATE_WINDOW_MS = positiveInt(
  process.env.AUTH_RATE_WINDOW_MS,
  60_000
);

/** Parses an env override, falling back rather than accepting nonsense. */
function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Throttles by client address.
 *
 * The primary control of US-026. Account lockout is the backstop for what this
 * cannot see — one account attacked from many sources — and is deliberately set
 * out of reach of any single one.
 *
 * The 429 body says nothing about accounts. A throttle response that varied by
 * whether the email existed would reintroduce, on the error path, the
 * enumeration oracle sign-in works to remove.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly limiter: RateLimitService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const decision = await this.limiter.consume(
      `ratelimit:auth:${sourceOf(request)}`,
      AUTH_RATE_LIMIT,
      AUTH_RATE_WINDOW_MS
    );

    // Sent on every response, not just refusals, so a well-behaved client can
    // slow down before it is refused rather than after.
    response.setHeader("X-RateLimit-Limit", String(AUTH_RATE_LIMIT));
    response.setHeader(
      "X-RateLimit-Remaining",
      String(Math.max(0, AUTH_RATE_LIMIT - decision.count))
    );

    if (decision.allowed) return true;

    response.setHeader("Retry-After", String(decision.retryAfterSeconds));
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: "Too many attempts. Wait a moment and try again.",
        retryAfter: decision.retryAfterSeconds
      },
      HttpStatus.TOO_MANY_REQUESTS
    );
  }
}

/**
 * The address to throttle on.
 *
 * `request.ip`, which Express derives from `X-Forwarded-For` only when
 * `trust proxy` is set. That matters: trusting the header unconditionally lets
 * any caller pick their own key and opt out of throttling entirely, so the
 * deployment decides whether the header is believable, not this file.
 */
function sourceOf(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? "unknown";
}
