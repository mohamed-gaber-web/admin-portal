import { SetMetadata } from "@nestjs/common";

export const ALLOW_SERVICE_TOKEN = "allowServiceToken";

/**
 * Lets a service-client token reach this handler, if it holds `scope`.
 *
 * Opt-in per handler, never per controller: a controller-level opt-in would
 * quietly extend to every method added to it later. `AccessTokenGuard` further
 * limits service tokens to GET, so a read-only scope can never drive a write
 * even if a mutating handler is mistakenly decorated.
 */
export const AllowServiceToken = (scope: string): MethodDecorator =>
  SetMetadata(ALLOW_SERVICE_TOKEN, scope);
