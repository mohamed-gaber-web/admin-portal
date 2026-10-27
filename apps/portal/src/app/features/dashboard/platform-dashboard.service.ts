import { Injectable, inject } from "@angular/core";
import { catchError, forkJoin, map, of, switchMap, type Observable } from "rxjs";
import { MAX_PAGE_SIZE } from "@growpath/contracts";
import type { TenantSummary } from "@core/models";
import { PlatformService } from "@features/platform/platform.service";

/**
 * What the operator dashboard is built from — the installation, read live.
 *
 * Every field is nullable, and null means "could not be read". An operator
 * holding only the user keys gets a 403 on tenants; that should blank the
 * tenant panels, not replace the whole landing screen with an error.
 */
export interface PlatformDashboardData {
  /** Every tenant, archived included — the screen decides what counts as live. */
  tenants: TenantSummary[] | null;
  userTotal: number | null;
  invitedUsers: number | null;
  suspendedUsers: number | null;
  adminCount: number | null;
  /** When this snapshot was taken, for the "updated" caption. */
  loadedAt: Date;
}

/**
 * Raw facts only; every figure on the screen is derived from these in the
 * component, so there is one source of truth and nothing to keep in step.
 *
 * Tenants are paged through in full. An installation measures its customers in
 * tens or hundreds, so a few requests of 100 are cheap — and a dashboard
 * that silently counted only the first page would under-report exactly when
 * the business had grown.
 */
@Injectable({ providedIn: "root" })
export class PlatformDashboardService {
  private readonly platform = inject(PlatformService);

  load(): Observable<PlatformDashboardData> {
    return forkJoin({
      tenants: this.allTenants().pipe(orNull()),
      userTotal: this.userCount("all"),
      invitedUsers: this.userCount("invited"),
      suspendedUsers: this.userCount("suspended"),
      adminCount: this.platform.listAdmins().pipe(
        map((admins) => admins.length),
        orNull()
      )
    }).pipe(map((data) => ({ ...data, loadedAt: new Date() })));
  }

  private allTenants(): Observable<TenantSummary[]> {
    const page = (n: number) =>
      this.platform.listTenants({ page: n, pageSize: MAX_PAGE_SIZE, status: "all" });

    return page(1).pipe(
      switchMap((first) => {
        const pages = Math.ceil(first.total / MAX_PAGE_SIZE);
        if (pages <= 1) return of(first.items);
        const rest = Array.from({ length: pages - 1 }, (_, index) => page(index + 2));
        return forkJoin(rest).pipe(
          map((more) => [first, ...more].flatMap((result) => result.items))
        );
      })
    );
  }

  private userCount(status: "all" | "invited" | "suspended"): Observable<number | null> {
    return this.platform
      .listUsers({ page: 1, pageSize: 1, status })
      .pipe(map((result) => result.total), orNull());
  }
}

function orNull<T>() {
  return catchError<T, Observable<null>>(() => of(null));
}
