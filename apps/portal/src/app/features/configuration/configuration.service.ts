import { Injectable, inject } from "@angular/core";
import type { Observable } from "rxjs";
import {
  API_ROUTES,
  tenantModuleListSchema,
  type TenantModule,
  connectionListSchema,
  connectionSchema,
  connectionTestResultSchema,
  mobileConfigSchema,
  type Connection,
  type ConnectionTestResult,
  type MobileConfig,
  type SaveConnectionInput,
  type SaveMobileConfigInput
} from "@growpath/contracts";
import { ApiService, pathFor } from "@core/http/api.service";
import { nullOnNotFound } from "@core/http/not-found";

/**
 * The tenant's own configuration: D365 connections and the mobile bootstrap.
 *
 * One service for two endpoints because they are one screen — an administrator
 * setting a tenant up does both in the same sitting, and splitting them would
 * mean two services whose only distinction is which half of the same task they
 * serve.
 *
 * Both are tenant-scoped and take no tenant in the path: it comes from the
 * access token's claims, and row level security does the filtering. There is
 * nothing here to iterate.
 */
@Injectable({ providedIn: "root" })
export class ConfigurationService {
  private readonly api = inject(ApiService);

  /**
   * Every environment's connection, for the caller's tenant.
   *
   * A connection has no identity apart from its environment, so there is no
   * create and no delete here and there cannot be: creating one would mean
   * creating an environment, and deleting one would leave an environment
   * pointing at nothing.
   */
  listConnections(): Observable<Connection[]> {
    return this.api.getValidated(API_ROUTES.connections, connectionListSchema);
  }

  /**
   * Saves a connection. The API runs a live credential check first and persists
   * only if it passes, so a 422 here means nothing was written.
   *
   * `clientSecret` is optional and omitting it keeps the stored one — nothing
   * can display the current secret, so requiring it would force whoever is
   * correcting an expiry date to re-type a credential they may not have.
   */
  saveConnection(id: string, input: SaveConnectionInput): Observable<Connection> {
    return this.api.putValidated(
      pathFor(API_ROUTES.connection, { id }),
      input,
      connectionSchema
    );
  }

  /**
   * Re-checks a stored configuration without changing it.
   *
   * Answers 200 with `ok: false` on failure rather than an error status, unlike
   * a save: checking is what was asked for, and the result of a check is a
   * legitimate answer whichever way it comes out.
   */
  testConnection(id: string): Observable<ConnectionTestResult> {
    return this.api.postValidated(
      pathFor(API_ROUTES.connectionTest, { id }),
      {},
      connectionTestResultSchema
    );
  }

  /**
   * The tenant's own module entitlements.
   *
   * Read-only, and there is no writing counterpart on this service by design:
   * which modules a tenant holds is decided by whoever operates the
   * installation. The operator's toggles live on `PlatformService`.
   */
  listOwnModules(): Observable<TenantModule[]> {
    return this.api.getValidated(API_ROUTES.modules, tenantModuleListSchema);
  }

  /**
   * The tenant's mobile bootstrap record, or null when there is not one yet.
   *
   * The API answers **404** for a tenant that has never configured one, and that
   * is the right answer for it to give: "not set up yet" and "set up with
   * blanks" are different states, and an empty object would erase the
   * difference. It is not an error, though — a tenant being set up for the first
   * time is the normal way to arrive here, so it becomes null and the screen
   * renders an empty form rather than a red failure with a retry button that
   * would never succeed.
   */
  getMobileConfig(): Observable<MobileConfig | null> {
    return this.api
      .getValidated(API_ROUTES.tenantMobileConfig, mobileConfigSchema)
      .pipe(nullOnNotFound());
  }

  /**
   * Saves the mobile configuration.
   *
   * `apiBaseUrl` redirects every device in the field to whatever it names, which
   * makes it the most damaging edit available on this screen — the contract
   * refuses anything that is not an absolute `https://` URL, and the form says
   * so before the request rather than after.
   */
  saveMobileConfig(input: SaveMobileConfigInput): Observable<MobileConfig> {
    return this.api.putValidated(
      API_ROUTES.tenantMobileConfig,
      input,
      mobileConfigSchema
    );
  }
}
