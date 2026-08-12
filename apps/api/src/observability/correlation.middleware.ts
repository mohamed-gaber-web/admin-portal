import { Injectable, type NestMiddleware } from "@nestjs/common";
import {
  CORRELATION_ID_HEADER,
  newCorrelationId,
  runWithRequestContext,
  sanitizeCorrelationId
} from "@growpath/observability";
import type { NextFunction, Request, Response } from "express";
import { apiLogger } from "./logger";

/**
 * Opens a request context for every request and logs the outcome (US-007).
 *
 * An inbound `x-correlation-id` is honoured so a trace started by the portal or
 * the mobile app continues here, but only after `sanitizeCorrelationId` has
 * checked its shape — it is caller-controlled text that ends up in every log
 * line for the request. The ID is echoed back so the caller can quote it in a
 * support ticket.
 *
 * What is logged is a fixed set of named fields. There is deliberately no
 * "log the request object" path: headers carry `authorization`, and bodies
 * carry passwords and client secrets.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = sanitizeCorrelationId(req.headers[CORRELATION_ID_HEADER]);
    const correlationId = inbound ?? newCorrelationId();
    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    runWithRequestContext(
      { correlationId, method: req.method, path: req.path },
      () => {
        const startedAt = process.hrtime.bigint();

        // Registered inside the context, so the callback still sees it — and by
        // then authentication has filled in the tenant and user IDs.
        res.on("finish", () => {
          const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
          const log = res.statusCode >= 500 ? apiLogger.error : apiLogger.info;
          log("http.request.completed", {
            method: req.method,
            // `path`, never `originalUrl`: the query string is where tokens and
            // reset codes travel.
            path: req.path,
            status: res.statusCode,
            durationMs,
            correlationIdSource: inbound ? "inbound" : "generated",
            ip: req.ip ?? null,
            userAgent: req.headers["user-agent"] ?? null
          });
        });

        next();
      }
    );
  }
}
