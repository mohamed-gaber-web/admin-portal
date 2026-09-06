import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus
} from "@nestjs/common";
import type { Request, Response } from "express";
import { currentCorrelationId } from "@growpath/observability";
import { apiLogger } from "../observability/logger";

/**
 * Turns an unhandled exception into something an operator can act on.
 *
 * Without this, Nest answers a crash with a bare
 * `{"statusCode":500,"message":"Internal server error"}` and the cause is
 * discarded. That is indistinguishable between a Postgres permission error, a
 * missing tenant context and a genuine bug — so a total outage takes a database
 * session and a log search to identify, and every failing route looks the same.
 *
 * Two things change. The cause is **logged** against the request's correlation
 * ID, and a **classification** is returned in the response.
 *
 * ### Why a code may safely be returned
 *
 * `code` is a fixed, closed vocabulary, and `dbCode` is a SQLSTATE — a public
 * five-character enum naming a *class* of failure (`42501` is
 * "insufficient_privilege", `42P01` is "undefined_table"). Neither carries a row,
 * a column value, a customer name or a host. The exception's `message` is what
 * would leak — it can quote SQL, name a schema object, or contain a connection
 * string — and it is deliberately kept to the log.
 *
 * This mirrors what the D365 proxy already does: a closed set of codes out, the
 * underlying exception in.
 *
 * `HttpException`s pass through untouched. A 401, 403 or 404 is a decision the
 * application made on purpose, and re-describing it here would flatten every
 * deliberate status into a crash report.
 */
@Catch()
export class UnhandledExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    // A handler that took `@Res()` — the D365 proxy — may already have written.
    // Writing again throws inside the filter and masks the original failure.
    if (response.headersSent) {
      apiLogger.error("api.unhandled_exception.after_response", {
        method: request.method,
        path: request.path,
        ...describe(exception)
      });
      return;
    }

    const detail = describe(exception);

    apiLogger.error("api.unhandled_exception", {
      method: request.method,
      path: request.path,
      ...detail,
      stack: exception instanceof Error ? exception.stack : undefined
    });

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: "Internal server error",
      code: detail.code,
      // Present only for a database failure, and only ever the SQLSTATE.
      ...(detail.dbCode ? { dbCode: detail.dbCode } : {}),
      // Already exposed as a response header; repeated here so a support ticket
      // that pastes the body is traceable to the log line.
      correlationId: currentCorrelationId()
    });
  }
}

interface ExceptionDetail {
  code: string;
  dbCode?: string;
  name?: string;
  message?: string;
}

/**
 * Classifies an exception into a safe code, keeping the unsafe parts for the log.
 *
 * The `code` is what a client sees; `name` and `message` are logged only.
 */
function describe(exception: unknown): ExceptionDetail {
  if (!(exception instanceof Error)) {
    return { code: "unknown", message: String(exception) };
  }

  if (exception.name === "MissingTenantContextError") {
    // The request reached a scoped query without an authenticated tenant. Always
    // a bug or a misrouted call, never something a caller can cause.
    return { code: "missing_tenant_context", name: exception.name, message: exception.message };
  }

  // `pg` puts the SQLSTATE on `code`, always five characters.
  const candidate = (exception as { code?: unknown }).code;
  if (typeof candidate === "string" && /^[0-9A-Z]{5}$/.test(candidate)) {
    return {
      code: "database_error",
      dbCode: candidate,
      name: exception.name,
      message: exception.message
    };
  }

  return { code: "unhandled", name: exception.name, message: exception.message };
}
