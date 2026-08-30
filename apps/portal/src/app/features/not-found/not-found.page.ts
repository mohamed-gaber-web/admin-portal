import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { RouterLink } from "@angular/router";
import { SessionStore } from "@core/auth/session.store";
import { injectT } from "@core/i18n/i18n.service";
import { ButtonComponent, IconComponent } from "@shared/ui";

/**
 * The catch-all route.
 *
 * Lives outside the shell, so it renders for a signed-out visitor too — a
 * mistyped URL should say "not found" rather than bounce through sign-in and
 * leave the person wondering what they were being asked to log in to.
 *
 * The way back depends on who is asking, which is why the session is read here.
 */
@Component({
  selector: "app-not-found-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ButtonComponent, IconComponent],
  host: {
    class: "flex min-h-screen flex-col items-center justify-center gap-5 bg-background px-6 text-center"
  },
  template: `
    <span
      class="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-muted text-foreground-subtle"
    >
      <ui-icon name="search" [size]="26" />
    </span>

    <div class="space-y-2">
      <p class="text-sm font-semibold uppercase tracking-wider text-foreground-subtle">
        {{ t("notFound.code") }}
      </p>
      <h1 class="text-2xl font-semibold tracking-tight text-foreground">
        {{ t("notFound.title") }}
      </h1>
      <p class="max-w-sm text-sm text-foreground-muted">{{ t("notFound.body") }}</p>
    </div>

    @if (session.isAuthenticated()) {
      <a uiButton routerLink="/dashboard" size="lg">
        {{ t("notFound.backToDashboard") }}
      </a>
    } @else {
      <a uiButton routerLink="/login" size="lg">{{ t("notFound.goToSignIn") }}</a>
    }
  `
})
export class NotFoundPage {
  protected readonly session = inject(SessionStore);
  protected readonly t = injectT();
}
