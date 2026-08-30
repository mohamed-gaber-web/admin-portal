import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  UnprocessableEntityException,
  UseGuards
} from "@nestjs/common";
import type { Request } from "express";
import {
  API_ROUTES,
  saveConnectionSchema,
  type Connection,
  type ConnectionTestResult,
  type SaveConnectionInput
} from "@growpath/contracts";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { actorFrom } from "../common/actor";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ConnectionService } from "./connection.service";

/**
 * D365 connection configuration for the caller's own tenant (US-040).
 *
 * There is no create and no delete. A connection is one-to-one with an
 * environment and has no life of its own: creating one would mean creating an
 * environment, and deleting one would mean an environment that exists but points
 * at nothing. What is editable is the credential.
 *
 * Reads never carry the client secret, and that is a property of the response
 * type rather than of this controller — `connectionSchema` has no field it could
 * occupy (US-045).
 *
 * > Permission enforcement is not applied here yet. `connection.read` and
 * > `connection.write` exist in the catalogue and are stamped into the token's
 * > claims, but the guard that checks them is US-031 and no tenant-scoped route
 * > in this API enforces permissions today. Adding a check on this controller
 * > alone would read as though the others were covered.
 */
@Controller()
@UseGuards(AccessTokenGuard)
export class ConnectionController {
  constructor(private readonly connections: ConnectionService) {}

  @Get(API_ROUTES.connections)
  list(): Promise<Connection[]> {
    return this.connections.list();
  }

  @Get(API_ROUTES.connection)
  async find(@Param("id") id: string): Promise<Connection> {
    const connection = await this.connections.find(id);
    if (!connection) {
      // Another tenant's environment id is not visible inside the scoped
      // session, so it answers 404 — a 403 would confirm the environment exists.
      throw new NotFoundException({ message: "Connection not found." });
    }
    return connection;
  }

  /**
   * Saves a connection, and only if a live token request succeeds first.
   *
   * A rejected credential is a **422**, not a 400: the request was well-formed
   * and the server understood it — what failed is the exchange with Entra, which
   * is a fact about the world rather than about the syntax of the request. A
   * 400 would tell the portal to highlight a malformed field, and there is not
   * one.
   */
  @Put(API_ROUTES.connection)
  async save(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(saveConnectionSchema)) dto: SaveConnectionInput,
    @Req() request: Request,
    @Ip() ip: string
  ): Promise<Connection> {
    const outcome = await this.connections.save(id, dto, actorFrom(request, ip));

    switch (outcome.status) {
      case "saved":
        return outcome.connection;

      case "not_found":
        throw new NotFoundException({ message: "Connection not found." });

      case "secret_required":
        // A genuine 400: the caller can fix it by sending the field. Omitting
        // the secret is only meaningful when there is a stored one to keep.
        throw new BadRequestException({
          message: "A client secret is required the first time this connection is configured."
        });

      case "rejected":
        throw new UnprocessableEntityException({
          message: "The connection test failed, so nothing was saved.",
          // The reason code, never the identity provider's own message — see
          // `CONNECTION_ERRORS`.
          error: outcome.result.error,
          checkedAt: outcome.result.checkedAt
        });
    }
  }

  /**
   * Re-checks a stored configuration without changing it.
   *
   * 200 with `ok: false` rather than an error status, unlike the save above. The
   * request succeeded — checking is exactly what was asked for, and the result
   * of a check is a legitimate answer whichever way it comes out. This is the
   * endpoint behind the *Test connection* button, which needs to render a
   * failure rather than treat it as a broken request.
   */
  @Post(API_ROUTES.connectionTest)
  @HttpCode(HttpStatus.OK)
  async test(
    @Param("id") id: string,
    @Req() request: Request,
    @Ip() ip: string
  ): Promise<ConnectionTestResult> {
    const result = await this.connections.test(id, actorFrom(request, ip));
    if (!result) {
      throw new NotFoundException({ message: "Connection not found." });
    }
    return result;
  }
}
