import { HttpErrorResponse } from "@angular/common/http";
import type { MessageKey } from "@core/i18n/messages/en";
import type { TranslateFn } from "@core/i18n/i18n.service";

/**
 * A failed request, normalised into something a template can render.
 *
 * Components never see `HttpErrorResponse`. It carries a `message` like
 * "Http failure response for http://localhost:3000/auth/login: 401 Unauthorized",
 * which is a fine log line and a terrible thing to show a person, and it makes
 * every component that wants the server's actual message dig through
 * `error.error.message` and guess at its shape.
 *
 * Two ways to describe a failure, and the distinction matters once the portal
 * speaks two languages:
 *
 * - `messageKey` — our own wording, translated at render time. Used whenever
 *   the server gave a status and nothing else.
 * - `message` — the server's own text, in whatever language it chose. Shown
 *   verbatim, because we cannot translate a string we have never seen.
 *
 * `describeError` picks between them. Nothing should read `.message` directly.
 */
export class ApiError extends Error {
  constructor(
    /** HTTP status, or 0 when the request never reached the server. */
    readonly status: number,
    message: string,
    /** Set when the wording is ours and therefore translatable. */
    readonly messageKey?: MessageKey,
    /** Field-level failures from the API's Zod validation pipe, if any. */
    readonly fieldErrors: Readonly<Record<string, string>> = {},
    /**
     * The response body, for the few failures that carry a machine-readable
     * reason beyond the message.
     *
     * `PUT /connections/:id` is the case this exists for: it answers 422 with a
     * `error` naming one of five connection failure codes, and that code is the
     * actionable half — "the connection test failed" tells an administrator
     * nothing they can fix, and "the directory does not know that application"
     * tells them to check the tenant id.
     *
     * Deliberately `unknown`, not a typed shape. This class describes *every*
     * failure the API can produce, and giving it a field typed for one endpoint
     * would invite every other endpoint to add another. Callers narrow it
     * themselves, defensively.
     */
    readonly body: unknown = null
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** True when retrying might work: a timeout, a dropped connection, a 5xx. */
  get isRetryable(): boolean {
    return this.status === 0 || this.status >= 500;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  static from(response: HttpErrorResponse): ApiError {
    // Status 0 means the browser blocked it or the network dropped it — the
    // server sent nothing, so there is no body to read and no status to report.
    if (response.status === 0) {
      return new ApiError(0, "Could not reach the server.", "error.offline");
    }

    const body: unknown = response.error;
    const serverMessage = messageFrom(body);
    const fields = fieldErrorsFrom(body);

    return serverMessage
      ? new ApiError(response.status, serverMessage, undefined, fields, body)
      : new ApiError(
          response.status,
          `Request failed with status ${response.status}.`,
          defaultKeyFor(response.status),
          fields,
          body
        );
  }
}

/**
 * The API and the portal disagree about a response's shape.
 *
 * Not an `ApiError`: nothing failed over HTTP. The server answered 200 with a
 * body the shared schema refuses, which in practice means one side is running
 * code the other has not caught up with — most often a dev server holding a
 * pre-bundled copy of `@growpath/contracts` from before the last rebuild.
 *
 * It carries its own class so `describeError` can show the detail rather than a
 * translated generic. That is a deliberate exception to the rule that users see
 * our wording: this message names the field and the endpoint, and it is the
 * difference between "could not be loaded" — which sends somebody hunting
 * through the network tab — and "seatLimitOverride: Unrecognized key", which
 * names the fix. Its audience is whoever is running the portal, and in every
 * environment where it can occur that is a developer.
 */
export class ContractViolationError extends Error {
  constructor(
    readonly path: string,
    readonly detail: string
  ) {
    super(`Response from ${path} did not match its contract — ${detail}`);
    this.name = "ContractViolationError";
  }
}

/**
 * The sentence to show a user for any thrown value.
 *
 * Handles the three cases every subscribe callback otherwise re-implements: an
 * `ApiError` with our wording, an `ApiError` carrying the server's, and
 * something that is not an `ApiError` at all.
 */
export function describeError(
  error: unknown,
  t: TranslateFn,
  fallbackKey: MessageKey = "error.generic"
): string {
  if (error instanceof ApiError) {
    return error.messageKey ? t(error.messageKey) : error.message;
  }
  // Shown verbatim rather than folded into the fallback. A contract mismatch
  // hidden behind "could not be loaded" is a screen that looks broken for a
  // reason nothing on it will ever state; see the note on the class.
  if (error instanceof ContractViolationError) {
    return error.message;
  }
  return t(fallbackKey);
}

/** Nest sends `{ statusCode, message, error }`, with `message` sometimes an array. */
function messageFrom(body: unknown): string | null {
  if (typeof body === "string" && body.trim()) return body;
  if (!body || typeof body !== "object") return null;

  const message = (body as { message?: unknown }).message;
  if (typeof message === "string" && message.trim()) return message;
  if (Array.isArray(message) && message.length) return String(message[0]);
  return null;
}

/** The validation pipe reports issues as `{ issues: [{ path, message }] }`. */
function fieldErrorsFrom(body: unknown): Record<string, string> {
  if (!body || typeof body !== "object") return {};
  const issues = (body as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return {};

  const errors: Record<string, string> = {};
  for (const issue of issues) {
    if (!issue || typeof issue !== "object") continue;
    const { path, message } = issue as { path?: unknown; message?: unknown };
    const field = Array.isArray(path) ? path.join(".") : String(path ?? "");
    if (field && typeof message === "string" && !errors[field]) {
      errors[field] = message;
    }
  }
  return errors;
}

/**
 * Wording of last resort, when the server gave a status and nothing else.
 *
 * 401 says "sign-in details" without saying which was wrong — matching the API,
 * which answers identically for a wrong password, an unknown email and an
 * unknown slug precisely so the response cannot be used to enumerate accounts.
 * A friendlier message here would leak what the API works to hide.
 */
function defaultKeyFor(status: number): MessageKey {
  switch (status) {
    case 400:
      return "error.badRequest";
    case 401:
      return "error.unauthorized";
    case 403:
      return "error.forbidden";
    case 404:
      return "error.notFound";
    case 409:
      return "error.conflict";
    case 429:
      return "error.tooManyRequests";
    default:
      return status >= 500 ? "error.server" : "error.generic";
  }
}
