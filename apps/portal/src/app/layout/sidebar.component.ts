import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output
} from "@angular/core";
import { RouterLink, RouterLinkActive } from "@angular/router";
import { NAVIGATION } from "@core/layout/navigation";
import { SessionStore } from "@core/auth/session.store";
import { injectT } from "@core/i18n/i18n.service";
import { BadgeComponent, IconComponent } from "@shared/ui";

/**
 * The primary navigation.
 *
 * Rendered from `NAVIGATION`, so a new screen is a line of data rather than a
 * block of markup, and a future permission filter has one list to filter.
 *
 * The active row is marked three ways — tint, weight, and a rail against the
 * left edge — because a single faint background tint is easy to lose against a
 * list of eight items, and the rail is the part that survives being glanced at.
 *
 * Collapsed, it keeps the icons and drops the labels. The label is not deleted
 * from the accessibility tree though — it moves to `title` and `aria-label`, so
 * an icon rail stays navigable by screen reader and hover.
 */
@Component({
  selector: "app-sidebar",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, IconComponent, BadgeComponent],
  host: { class: "flex h-full flex-col bg-surface" },
  template: `
    <!--
      Brand.

      Two marks, not one, because the rail is 9 units wide and the logo is a
      3.2:1 lockup: scaled to fit that width it would be four pixels tall. So
      the wordmark is shown when there is room for it, and the collapsed rail
      falls back to the square glyph — which is the same trade every product
      with a horizontal logo and an icon rail makes.
    -->
    <div class="flex h-16 shrink-0 items-center gap-3 border-b border-border px-4">
      @if (collapsed()) {
        <span
          class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary bg-gradient-to-b from-white/20 to-transparent text-primary-foreground shadow-primary"
        >
          <ui-icon name="logo" [size]="18" [strokeWidth]="2.25" />
        </span>
      } @else {
        <div class="min-w-0">
          <!--
            No text beside it: the file already contains the words "Grow Path",
            and repeating them would read as a stutter. The intrinsic width and
            height are set so the row does not reflow while the image loads.
          -->
          <!--
            dark:brightness-0 dark:invert — see the note in the auth layout. A
            stopgap for a dark-navy wordmark on a dark surface, until there is
            an asset drawn for it.
          -->
          <img
            src="assets/images/grow-path-logo.svg"
            [alt]="t('app.name')"
            width="206"
            height="64"
            class="h-8 w-auto dark:brightness-0 dark:invert"
          />
          <p class="mt-0.5 truncate text-xs text-foreground-subtle">
            {{ session.tenant()?.slug ?? t("app.subtitle") }}
          </p>
        </div>
      }
    </div>

    <nav
      class="flex-1 space-y-6 overflow-y-auto px-3 py-5"
      [attr.aria-label]="t('nav.main')"
    >
      @for (section of navigation(); track section.titleKey) {
        <div class="space-y-0.5">
          @if (!collapsed()) {
            <p
              class="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground-subtle"
            >
              {{ t(section.titleKey) }}
            </p>
          }

          @for (item of section.items; track item.route) {
            <a
              [routerLink]="item.route"
              routerLinkActive
              #active="routerLinkActive"
              [attr.aria-current]="active.isActive ? 'page' : null"
              [attr.title]="collapsed() ? t(item.labelKey) : null"
              [attr.aria-label]="collapsed() ? t(item.labelKey) : null"
              (click)="navigated.emit()"
              [class]="linkClass(active.isActive)"
            >
              @if (active.isActive) {
                <!-- start-0 and rounded-e-full: the rail hugs the leading
                     edge, which is the right-hand one in Arabic. -->
                <span
                  class="absolute start-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-e-full bg-primary"
                  aria-hidden="true"
                ></span>
              }

              <ui-icon [name]="item.icon" [size]="18" />

              @if (!collapsed()) {
                <span class="flex-1 truncate">{{ t(item.labelKey) }}</span>
                @if (item.badge) {
                  <ui-badge tone="primary">{{ item.badge }}</ui-badge>
                }
              }
            </a>
          }
        </div>
      }
    </nav>
  `
})
export class SidebarComponent {
  readonly collapsed = input(false);
  /** Lets the shell close the mobile drawer once a link is followed. */
  readonly navigated = output<void>();

  protected readonly session = inject(SessionStore);
  protected readonly t = injectT();

  /**
   * The sections this session can see.
   *
   * The filter the `NAVIGATION` comment anticipated. It is a rendering
   * decision — the routes are guarded on their own, and the API refuses the
   * requests regardless — so hiding a section here removes a dead end rather
   * than enforcing anything.
   */
  protected readonly navigation = computed(() =>
    NAVIGATION.filter(
      (section) =>
        !section.requiresPermission || this.session.hasPermission(section.requiresPermission)
    )
  );

  protected linkClass(isActive: boolean): string {
    return [
      "group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm",
      "transition-all duration-200",
      this.collapsed() ? "justify-center" : "",
      isActive
        ? "bg-primary-subtle font-semibold text-primary"
        : "font-medium text-foreground-muted hover:bg-surface-muted hover:text-foreground"
    ]
      .filter(Boolean)
      .join(" ");
  }
}
