import { Injectable, inject } from "@angular/core";
import { catchError, forkJoin, map, of, type Observable } from "rxjs";
import type { Connection, MobileConfig, TenantModule } from "@growpath/contracts";
import { ConfigurationService } from "@features/configuration/configuration.service";
import { UsersService } from "@features/users/users.service";

/**
 * What a tenant's own landing screen is built from.
 *
 * Every field is nullable, and null means "could not be read", not "empty".
 * A member without `connection.read` gets a 403 on connections; that should
 * hide the one setup step it feeds, not turn the whole welcome screen into an
 * error page for someone who simply was not granted that screen.
 */
export interface TenantDashboardData {
  connections: Connection[] | null;
  /** `undefined` when unreadable; `null` is the API's "not set up yet". */
  mobileConfig: MobileConfig | null | undefined;
  teamSize: number | null;
  pendingInvitations: number | null;
  modules: TenantModule[] | null;
}

/**
 * Real data only — unlike the operator dashboard, there is no fixture here.
 * A newly provisioned tenant must see its own empty state, and a fixture would
 * show it somebody else's numbers.
 */
@Injectable({ providedIn: "root" })
export class TenantDashboardService {
  private readonly configuration = inject(ConfigurationService);
  private readonly users = inject(UsersService);

  load(): Observable<TenantDashboardData> {
    return forkJoin({
      connections: this.configuration.listConnections().pipe(orNull()),
      mobileConfig: this.configuration
        .getMobileConfig()
        .pipe(catchError(() => of(undefined))),
      teamSize: this.users
        .list({ page: 1, pageSize: 1, status: "all" })
        .pipe(map((page) => page.total), orNull()),
      pendingInvitations: this.users
        .list({ page: 1, pageSize: 1, status: "invited" })
        .pipe(map((page) => page.total), orNull()),
      modules: this.configuration.listOwnModules().pipe(orNull())
    });
  }
}

function orNull<T>() {
  return catchError<T, Observable<null>>(() => of(null));
}
