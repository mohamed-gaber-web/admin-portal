import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import { LayoutStore } from "@core/layout/layout.store";
import { SidebarComponent } from "./sidebar.component";
import { TopbarComponent } from "./topbar.component";

/**
 * The authenticated frame: sidebar, topbar, and the routed page.
 *
 * The sidebar appears twice on purpose — a static column from `lg` up, and an
 * overlay drawer below it. One element animated between the two roles ends up
 * carrying both sets of positioning at once, and the desktop rail inherits
 * transition and transform rules that only ever made sense for the drawer.
 * Two instances of a stateless component cost nothing and each stays simple.
 */
@Component({
  selector: "app-shell",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, SidebarComponent, TopbarComponent],
  host: { class: "flex min-h-screen bg-background" },
  template: `
    <!-- Desktop rail -->
    <!-- border-e, not border-r: the divider sits on the sidebar's trailing
         edge, which is its left side in Arabic. -->
    <aside
      [class]="
        'hidden shrink-0 border-e border-border transition-[width] duration-200 lg:block ' +
        (layout.collapsed() ? 'w-[4.5rem]' : 'w-64')
      "
    >
      <div class="sticky top-0 h-screen">
        <app-sidebar [collapsed]="layout.collapsed()" />
      </div>
    </aside>

    <!-- Mobile drawer -->
    @if (layout.drawerOpen()) {
      <div class="fixed inset-0 z-40 lg:hidden">
        <div
          class="absolute inset-0 bg-slate-950/40 animate-fade-in dark:bg-slate-950/70"
          (click)="layout.closeDrawer()"
          aria-hidden="true"
        ></div>
        <!-- The drawer enters from the leading edge, so its slide-in animation
             has to reverse too — a drawer that opens on the right while sliding
             in from the left is the classic half-mirrored RTL bug. -->
        <div
          class="absolute inset-y-0 start-0 w-64 border-e border-border shadow-modal animate-slide-in-start"
        >
          <app-sidebar (navigated)="layout.closeDrawer()" />
        </div>
      </div>
    }

    <div class="flex min-w-0 flex-1 flex-col">
      <app-topbar />
      <!-- min-w-0 all the way down, or a wide table stretches the whole column. -->
      <main class="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
        <router-outlet />
      </main>
    </div>
  `
})
export class ShellComponent {
  protected readonly layout = inject(LayoutStore);
}
