import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { RouterLink } from "@angular/router";
import { AuthService } from "@core/auth/auth.service";
import { SessionStore } from "@core/auth/session.store";
import { injectT } from "@core/i18n/i18n.service";
import { LayoutStore } from "@core/layout/layout.store";
import {
  AvatarComponent,
  ButtonComponent,
  DropdownComponent,
  IconComponent,
  InputDirective,
  MenuItemComponent
} from "@shared/ui";
import { LocaleToggleComponent } from "./locale-toggle.component";
import { ThemeToggleComponent } from "./theme-toggle.component";

/**
 * The bar across the top of the shell.
 *
 * Holds the things that belong to the session rather than the page: search, the
 * theme control, the account menu, and — below the `lg` breakpoint — the button
 * that opens the sidebar as a drawer.
 *
 * Sticky rather than fixed, so it scrolls within the content column instead of
 * overlaying it and needing a matching top padding somewhere else to compensate.
 */
@Component({
  selector: "app-topbar",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    AvatarComponent,
    ButtonComponent,
    DropdownComponent,
    IconComponent,
    InputDirective,
    MenuItemComponent,
    LocaleToggleComponent,
    ThemeToggleComponent
  ],
  host: {
    class:
      "sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur-md sm:px-6"
  },
  template: `
    <button
      uiButton
      variant="ghost"
      size="icon"
      type="button"
      class="lg:hidden"
      [attr.aria-label]="t('topbar.openNavigation')"
      (click)="layout.openDrawer()"
    >
      <ui-icon name="menu" [size]="20" />
    </button>

    <!-- Desktop-only collapse. On mobile the sidebar is a drawer, not a rail. -->
    <button
      uiButton
      variant="ghost"
      size="icon"
      type="button"
      class="hidden lg:inline-flex"
      [attr.aria-label]="
        layout.collapsed() ? t('topbar.expandSidebar') : t('topbar.collapseSidebar')
      "
      [attr.aria-pressed]="layout.collapsed()"
      (click)="layout.toggleCollapsed()"
    >
      <ui-icon [name]="layout.collapsed() ? 'panel-expand' : 'panel-collapse'" [size]="18" />
    </button>

    <div class="relative hidden min-w-0 flex-1 sm:block sm:max-w-xs">
      <span
        class="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-foreground-subtle"
      >
        <ui-icon name="search" [size]="16" />
      </span>
      <input
        uiInput
        type="search"
        class="!py-2 !ps-9"
        [attr.placeholder]="t('common.searchPlaceholder')"
        [attr.aria-label]="t('common.search')"
      />
    </div>

    <div class="ms-auto flex items-center gap-2">
      <app-locale-toggle class="hidden sm:inline-flex" />
      <app-theme-toggle class="hidden md:inline-flex" />

      <button
        uiButton
        variant="ghost"
        size="icon"
        type="button"
        [attr.aria-label]="t('topbar.notifications')"
      >
        <ui-icon name="bell" [size]="18" />
      </button>

      <ui-dropdown align="end">
        <button
          type="button"
          class="flex items-center gap-2 rounded-xl p-1 transition-colors duration-200 hover:bg-surface-muted"
          [attr.aria-label]="t('topbar.accountMenu', { name: session.displayName() })"
        >
          <ui-avatar [name]="session.displayName()" size="sm" />
          <span class="hidden text-sm font-medium text-foreground md:inline">
            {{ session.displayName() }}
          </span>
          <ui-icon name="chevron-down" [size]="15" class="text-foreground-subtle" />
        </button>

        <div dropdownMenu>
          <div class="border-b border-border px-2.5 pb-2.5 pt-1.5">
            <p class="truncate text-sm font-medium text-foreground">
              {{ session.displayName() }}
            </p>
            <p class="truncate text-xs text-foreground-subtle">
              {{ session.user()?.email }}
            </p>
            <!--
              The workspace, because nothing else on screen says which one this
              is. Sign-in stopped asking for it, so an operator with accounts on
              two installations has no other way to tell them apart before
              acting.
            -->
            <p class="mt-1.5 flex items-center gap-1.5 truncate text-xs text-foreground-muted">
              <ui-icon name="building" [size]="13" class="shrink-0" />
              <span class="truncate">{{ session.workspaceName() }}</span>
            </p>
          </div>

          <div class="pt-1.5">
            <a uiMenuItem routerLink="/settings">
              <ui-icon name="settings" [size]="16" />
              {{ t("nav.settings") }}
            </a>
            <button uiMenuItem type="button" tone="danger" (click)="auth.signOut()">
              <ui-icon name="logout" [size]="16" />
              {{ t("topbar.signOut") }}
            </button>
          </div>
        </div>
      </ui-dropdown>
    </div>
  `
})
export class TopbarComponent {
  protected readonly layout = inject(LayoutStore);
  protected readonly session = inject(SessionStore);
  protected readonly auth = inject(AuthService);
  protected readonly t = injectT();
}
