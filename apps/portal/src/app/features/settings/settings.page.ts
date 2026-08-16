import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal
} from "@angular/core";
import { AuthService } from "@core/auth/auth.service";
import { SessionStore } from "@core/auth/session.store";
import { injectT } from "@core/i18n/i18n.service";
import {
  AlertComponent,
  AvatarComponent,
  ButtonComponent,
  CardComponent,
  CardHeaderComponent,
  IconComponent,
  TabsComponent,
  type Tab
} from "@shared/ui";
import { LocaleToggleComponent } from "../../layout/locale-toggle.component";
import { MfaEnrolmentComponent } from "./components/mfa-enrolment.component";
import { PageHeaderComponent } from "../../layout/page-header.component";
import { ThemeToggleComponent } from "../../layout/theme-toggle.component";

/**
 * Account and workspace settings.
 *
 * Tabs, not child routes: these are three views of one page rather than three
 * destinations, and giving each a URL would put entries in the browser history
 * that the back button then has to make sense of.
 *
 * Read-only for now, and it says so. Nothing here has an endpoint to write to —
 * the API exposes sign-in, invitation redemption and tenant provisioning, and
 * nothing that edits a profile or a workspace. Controls that look editable and
 * silently discard what you type are worse than controls that admit they are
 * not wired up yet.
 */
@Component({
  selector: "app-settings-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AlertComponent,
    AvatarComponent,
    ButtonComponent,
    CardComponent,
    CardHeaderComponent,
    IconComponent,
    LocaleToggleComponent,
    MfaEnrolmentComponent,
    PageHeaderComponent,
    TabsComponent,
    ThemeToggleComponent
  ],
  template: `
    <app-page-header
      [title]="t('settings.title')"
      [description]="t('settings.subtitle')"
    />

    <ui-tabs [tabs]="tabs()" [(active)]="active" class="mb-6" />

    @switch (active()) {
      @case ("appearance") {
        <ui-card class="max-w-2xl animate-fade-in">
          <ui-card-header
            [title]="t('settings.appearance')"
            [description]="t('settings.appearanceSubtitle')"
          />
          <div class="mt-6 flex flex-wrap items-center justify-between gap-4">
            <div class="space-y-0.5">
              <p class="text-sm font-medium text-foreground">{{ t("settings.themeHeading") }}</p>
              <p class="text-sm text-foreground-muted">{{ t("settings.themeBody") }}</p>
            </div>
            <app-theme-toggle />
          </div>

          <div
            class="mt-6 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-6"
          >
            <div class="space-y-0.5">
              <p class="text-sm font-medium text-foreground">
                {{ t("settings.languageHeading") }}
              </p>
              <p class="text-sm text-foreground-muted">{{ t("settings.languageBody") }}</p>
            </div>
            <app-locale-toggle />
          </div>
        </ui-card>
      }

      @case ("security") {
        <div class="max-w-2xl space-y-6 animate-fade-in">
          <ui-card>
            <ui-card-header
              [title]="t('settings.password')"
              [description]="t('settings.passwordSubtitle')"
            />
            <div class="mt-6">
              <ui-alert tone="info" [title]="t('settings.passwordUnavailable')">
                {{ t("settings.passwordUnavailableBody") }}
              </ui-alert>
            </div>
          </ui-card>

          <ui-card>
            <ui-card-header
              [title]="t('mfaSetup.title')"
              [description]="t('mfaSetup.subtitle')"
            />
            <div class="mt-6">
              <app-mfa-enrolment />
            </div>
          </ui-card>

          <ui-card>
            <ui-card-header
              [title]="t('settings.sessions')"
              [description]="t('settings.sessionsSubtitle')"
            />
            <div class="mt-6 space-y-4">
              <ui-alert tone="warning" [title]="t('settings.signOutLocalTitle')">
                {{ t("settings.signOutLocalBody") }}
              </ui-alert>

              <div class="flex items-center justify-between gap-4">
                <div class="flex items-center gap-3">
                  <span
                    class="flex h-9 w-9 items-center justify-center rounded-xl bg-surface-muted text-foreground-muted"
                  >
                    <ui-icon name="monitor" [size]="17" />
                  </span>
                  <div>
                    <p class="text-sm font-medium text-foreground">{{ t("settings.thisBrowser") }}</p>
                    <p class="text-xs text-foreground-subtle">{{ t("settings.activeNow") }}</p>
                  </div>
                </div>
                <button uiButton variant="outline" size="sm" (click)="auth.signOut()">
                  {{ t("topbar.signOut") }}
                </button>
              </div>
            </div>
          </ui-card>
        </div>
      }

      @default {
        <div class="max-w-2xl space-y-6 animate-fade-in">
          <ui-card>
            <ui-card-header
              [title]="t('settings.profile')"
              [description]="t('settings.profileSubtitle')"
            />
            <div class="mt-6 flex items-center gap-4">
              <ui-avatar [name]="session.displayName()" size="lg" />
              <div class="min-w-0">
                <p class="truncate font-medium text-foreground">
                  {{ session.displayName() }}
                </p>
                <p class="truncate text-sm text-foreground-muted">
                  {{ session.user()?.email }}
                </p>
              </div>
            </div>
            <div class="mt-6">
              <ui-alert tone="info">{{ t("settings.profileNote") }}</ui-alert>
            </div>
          </ui-card>

          <ui-card>
            <ui-card-header
              [title]="t('settings.workspace')"
              [description]="t('settings.workspaceSubtitle')"
            />
            <dl class="mt-6 grid gap-4 sm:grid-cols-2">
              <div>
                <dt class="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                  {{ t("settings.slug") }}
                </dt>
                <dd class="mt-1 font-mono text-sm text-foreground">
                  {{ session.tenant()?.slug }}
                </dd>
              </div>
              <div>
                <dt class="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                  {{ t("settings.tenantId") }}
                </dt>
                <dd class="mt-1 break-all font-mono text-xs text-foreground-muted">
                  {{ session.tenant()?.id }}
                </dd>
              </div>
            </dl>
          </ui-card>
        </div>
      }
    }
  `
})
export class SettingsPage {
  protected readonly session = inject(SessionStore);
  protected readonly auth = inject(AuthService);
  protected readonly t = injectT();

  // Computed rather than a constant, so the labels re-resolve on a language
  // change instead of freezing at whatever was active when the page loaded.
  protected readonly tabs = computed<Tab[]>(() => [
    { id: "profile", label: this.t("settings.tabProfile") },
    { id: "appearance", label: this.t("settings.tabAppearance") },
    { id: "security", label: this.t("settings.tabSecurity") }
  ]);

  protected readonly active = signal("profile");
}
