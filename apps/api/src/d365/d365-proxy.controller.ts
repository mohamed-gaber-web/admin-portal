import { Controller, Delete, Get, Patch, Post, Put, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { Readable } from "node:stream";
import { API_ROUTES, D365_COMPANY_HEADER } from "@growpath/contracts";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { D365ProxyService, type ProxyOutcome } from "./d365-proxy.service";

/**
 * The ERP pass-through, as routes (US-046).
 *
 * ### Why ten decorators instead of one `@All`
 *
 * `tests/route-guard.ts` discovers routes by scanning for
 * `@(Get|Post|Put|Patch|Delete)`. `@All` is invisible to it, so a proxy declared
 * that way would be the one route in the API that CI could not check against the
 * manifest — on the single route where an unnoticed change is worth the most.
 * Ten decorators is the price of staying inside the mechanism rather than
 * quietly outside it.
 *
 * ### The invariant: this controller never answers 401
 *
 * Only `AccessTokenGuard` may, and it means "your session is over". If an
 * upstream 401 were passed through, the mobile app's refresh interceptor would
 * read it as its own session expiring and sign a warehouse operator out —
 * because *our* ERP service principal's secret expired. The two failures look
 * identical to a client and have nothing to do with each other, so a rejected
 * D365 credential leaves here as 502.
 */

/** Express's own type has `rawBody` only when the app was created with it. */
type ProxyableRequest = Request & { rawBody?: Buffer };

@Controller()
@UseGuards(AccessTokenGuard)
export class D365ProxyController {
  constructor(private readonly proxy: D365ProxyService) {}

  // ── The OData surface ────────────────────────────────────────────────────
  @Get(API_ROUTES.d365Data)
  getData(@Req() request: ProxyableRequest, @Res() response: Response): Promise<void> {
    return this.handle(request, response);
  }

  @Post(API_ROUTES.d365Data)
  postData(@Req() request: ProxyableRequest, @Res() response: Response): Promise<void> {
    return this.handle(request, response);
  }

  @Put(API_ROUTES.d365Data)
  putData(@Req() request: ProxyableRequest, @Res() response: Response): Promise<void> {
    return this.handle(request, response);
  }

  @Patch(API_ROUTES.d365Data)
  patchData(@Req() request: ProxyableRequest, @Res() response: Response): Promise<void> {
    return this.handle(request, response);
  }

  @Delete(API_ROUTES.d365Data)
  deleteData(@Req() request: ProxyableRequest, @Res() response: Response): Promise<void> {
    return this.handle(request, response);
  }

  // ── The custom service endpoints ─────────────────────────────────────────
  @Get(API_ROUTES.d365Services)
  getService(@Req() request: ProxyableRequest, @Res() response: Response): Promise<void> {
    return this.handle(request, response);
  }

  @Post(API_ROUTES.d365Services)
  postService(@Req() request: ProxyableRequest, @Res() response: Response): Promise<void> {
    return this.handle(request, response);
  }

  @Put(API_ROUTES.d365Services)
  putService(@Req() request: ProxyableRequest, @Res() response: Response): Promise<void> {
    return this.handle(request, response);
  }

  @Patch(API_ROUTES.d365Services)
  patchService(@Req() request: ProxyableRequest, @Res() response: Response): Promise<void> {
    return this.handle(request, response);
  }

  @Delete(API_ROUTES.d365Services)
  deleteService(@Req() request: ProxyableRequest, @Res() response: Response): Promise<void> {
    return this.handle(request, response);
  }

  /**
   * `@Res()` rather than a returned value, so the body can be streamed.
   *
   * An OData response with `$expand` is routinely megabytes; buffering one
   * multiplies this process's memory by its concurrency for no benefit to
   * anybody. The cost is that Nest's exception layer no longer applies, so every
   * branch below writes its own status.
   */
  private async handle(request: ProxyableRequest, response: Response): Promise<void> {
    const company = request.headers[D365_COMPANY_HEADER];

    const outcome = await this.proxy.forward({
      method: request.method,
      originalUrl: request.originalUrl,
      headers: request.headers,
      rawBody: request.rawBody,
      parsedBody: request.body,
      companyId: typeof company === "string" && company.trim() !== "" ? company.trim() : null
    });

    if (!outcome.ok) {
      const { status, error } = failure(outcome.reason);
      response.status(status).json({ error });
      return;
    }

    response.status(outcome.status);
    for (const [name, value] of Object.entries(outcome.headers)) {
      response.setHeader(name, value);
    }

    if (!outcome.body) {
      response.end();
      return;
    }

    Readable.fromWeb(outcome.body as never).pipe(response);
  }
}

/**
 * The closed set of failures this route reports.
 *
 * A closed set, and never the underlying exception: those messages name the
 * customer's ERP host and carry DNS and TLS detail. Every code here is
 * something a device or an administrator can act on.
 */
function failure(
  reason: Exclude<ProxyOutcome, { ok: true }>["reason"]
): { status: number; error: string } {
  switch (reason) {
    case "not_found":
      // The same 404 a nonexistent company gets. A caller who guessed another
      // tenant's id learns nothing about whether it exists.
      return { status: 404, error: "not_found" };
    case "ambiguous":
      // 400, not 409: the caller can fix this, by naming a company.
      return { status: 400, error: "company_required" };
    case "not_configured":
      // 503, not 4xx. The request was fine; an administrator has not finished
      // connecting this environment, and telling the device its request was
      // wrong would send whoever is holding it looking in the wrong place.
      return { status: 503, error: "connection_not_configured" };
    case "unauthorized":
      return { status: 502, error: "d365_unauthorized" };
    case "timeout":
      return { status: 504, error: "d365_timeout" };
    case "unreachable":
    default:
      return { status: 502, error: "d365_unreachable" };
  }
}
