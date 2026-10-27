import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { SessionStore } from "@core/auth/session.store";
import { PlatformDashboardComponent } from "./platform-dashboard.component";
import { TenantDashboardComponent } from "./tenant-dashboard.component";

/**
 * `/dashboard`, which is two different screens depending on who is asking.
 *
 * An operator lands on installation-wide numbers; everyone else lands on their
 * own workspace — setup progress, their modules, and where things live. Before
 * this split a newly provisioned tenant's administrator was greeted with the
 * operator's tenant counts and plan mix, which was both meaningless to them and
 * a view of a world they are not part of.
 *
 * `isPlatformAdmin` is a rendering decision only (see `SessionStore`). A tenant
 * user who edits it in storage sees the operator layout over fixture data, and
 * every request behind it is still checked by the API.
 */
@Component({
  selector: "app-dashboard-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PlatformDashboardComponent, TenantDashboardComponent],
  template: `
    @if (session.isPlatformAdmin()) {
      <app-platform-dashboard />
    } @else {
      <app-tenant-dashboard />
    }
  `
})
export class DashboardPage {
  protected readonly session = inject(SessionStore);
}
