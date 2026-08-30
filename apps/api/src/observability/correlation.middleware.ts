import { Injectable, type NestMiddleware } from "@nestjs/common";
import {
  CORRELATION_ID_HEADER,
  newCorrelationId,
  runWithRequestContext,
  sanitizeCorrelationId
} from "@growpath/observability";
import { API_ROUTES } from "@growpath/contracts";
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
/**
 * Orchestrator probe routes, which run every few seconds for the life of the
 * process — roughly 17k lines a day per instance at a 5s interval.
 *
 * Quieting them is opt-in through LOG_PROBE_REQUESTS=false rather than the
 * default, because US-007 requires *every* request to be logged with its
 * correlation ID and probes are requests. An operator drowning in probe lines
 * can turn them down; nobody loses the guarantee by accident.
 *
 * The louder half of the problem is fixed regardless: a readiness 503 no longer
 * writes an error line per probe, because HealthService logs a dependency
 * failure once per state change rather than once per check.
 */
const PROBE_PATHS = new Set<string>([API_ROUTES.health, API_ROUTES.ready]);

function probesAreQuiet(): boolean {
  return process.env.LOG_PROBE_REQUESTS?.trim().toLowerCase() === "false";
}

function levelFor(path: string, status: number): "debug" | "info" | "error" {
  if (PROBE_PATHS.has(path) && probesAreQuiet()) {
    return "debug";
  }
  return status >= 500 ? "error" : "info";
}

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
          const log = apiLogger[levelFor(req.path, res.statusCode)];
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
