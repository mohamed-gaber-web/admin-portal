import type { Request } from "express";
import type { AuditActor } from "@growpath/db";

/**
 * The audit actor for an authenticated request.
 *
 * The identity comes from the verified token claims and from nothing else — a
 * body field or a header naming the actor would let a caller write someone
 * else's name into an append-only log, which is worse than not recording one.
 *
 * The email is the label because that is what an operator reading the log
 * searches for; the user id travels alongside it so the entry survives a
 * change of address.
 *
 * Callers must be behind `AccessTokenGuard`. `request.auth` is optional in the
 * type because most routes are unauthenticated, so the fallback label exists to
 * keep this total — but an entry reading `unknown` means a route was wired
 * without its guard, and it is meant to be conspicuous in the log.
 */
export function actorFrom(request: Request, ip: string | null): AuditActor {
  return {
    label: request.auth?.email ?? "unknown",
    userId: request.auth?.userId ?? null,
    ip: ip || null
  };
}
