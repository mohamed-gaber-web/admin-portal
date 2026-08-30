import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { FormBuilder, ReactiveFormsModule, Validators } from "@angular/forms";
import { Router, RouterLink } from "@angular/router";
import { MIN_PASSWORD_LENGTH } from "@growpath/contracts";
import { AuthService } from "@core/auth/auth.service";
import { describeError } from "@core/http/api-error";
import { injectT } from "@core/i18n/i18n.service";
import {
  AlertComponent,
  ButtonComponent,
  FieldComponent,
  IconComponent,
  InputDirective
} from "@shared/ui";
import { AuthLayoutComponent } from "./auth-layout.component";

/**
 * Redeeming a reset link.
 *
 * No session is handed back on success, and that is deliberate on the API's
 * side: redeeming revokes every refresh token the user holds, and issuing a
 * fresh one here would undo that revocation for whoever followed the link. They
 * sign in with the new password instead, which also proves they know it.
 *
 * So this page ends at "signed out everywhere, go and sign in" rather than
 * dropping the user on the dashboard.
 */
@Component({
  selector: "app-reset-password-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    AlertComponent,
    AuthLayoutComponent,
    ButtonComponent,
    FieldComponent,
    IconComponent,
    InputDirective
  ],
  template: `
    <app-auth-layout [title]="t('reset.title')" [subtitle]="t('reset.subtitle')">
      @if (done()) {
        <div class="space-y-5 text-center">
          <span
            class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-success-subtle text-success"
          >
            <ui-icon name="check-circle" [size]="24" />
          </span>
          <div class="space-y-1">
            <p class="text-sm font-semibold text-foreground">
              {{ t("reset.doneTitle") }}
            </p>
            <p class="text-sm text-foreground-muted">{{ t("reset.doneBody") }}</p>
          </div>
          <a uiButton routerLink="/login" size="lg" [block]="true">
            {{ t("invite.goToSignIn") }}
          </a>
        </div>
      } @else if (!token) {
        <div class="space-y-5">
          <ui-alert tone="danger" [title]="t('reset.invalidTitle')">
            {{ t("reset.invalidBody") }}
          </ui-alert>
          <a uiButton routerLink="/forgot-password" variant="outline" [block]="true">
            {{ t("forgot.submit") }}
          </a>
        </div>
      } @else {
        <form [formGroup]="form" class="space-y-4" (ngSubmit)="submit()">
          @if (failure()) {
            <ui-alert tone="danger">{{ failure() }}</ui-alert>
          }

          <ui-field
            [label]="t('reset.newPassword')"
            controlId="reset-password"
            [required]="true"
            [hint]="t('invite.passwordHint', { count: MIN_PASSWORD_LENGTH })"
            [error]="passwordError()"
          >
            <input
              uiInput
              id="reset-password"
              type="password"
              formControlName="password"
              autocomplete="new-password"
              [invalid]="!!passwordError()"
            />
          </ui-field>

          <ui-field
            [label]="t('reset.confirmPassword')"
            controlId="reset-confirm"
            [required]="true"
            [error]="confirmError()"
          >
            <input
              uiInput
              id="reset-confirm"
              type="password"
              formControlName="confirm"
              autocomplete="new-password"
              [invalid]="!!confirmError()"
            />
          </ui-field>

          <button
            uiButton
            type="submit"
            size="lg"
            [block]="true"
            class="!mt-6"
            [loading]="submitting()"
          >
            {{ t("reset.submit") }}
          </button>
        </form>
      }
    </app-auth-layout>
  `
})
export class ResetPasswordPage {
  protected readonly MIN_PASSWORD_LENGTH = MIN_PASSWORD_LENGTH;

  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly t = injectT();
  protected readonly token =
    this.router.parseUrl(this.router.url).queryParams["token"] ?? "";

  protected readonly submitting = signal(false);
  protected readonly done = signal(false);
  protected readonly failure = signal<string | null>(null);

  protected readonly form = inject(FormBuilder).nonNullable.group({
    password: ["", [Validators.required, Validators.minLength(MIN_PASSWORD_LENGTH)]],
    confirm: ["", [Validators.required]]
  });

  protected passwordError(): string | null {
    const field = this.form.controls.password;
    if (!field.touched || field.valid) return null;
    return this.t("invite.tooShort", { count: MIN_PASSWORD_LENGTH });
  }

  protected confirmError(): string | null {
    const { password, confirm } = this.form.controls;
    if (!confirm.touched || !confirm.value) return null;
    return password.value === confirm.value ? null : this.t("invite.mismatch");
  }

  protected submit(): void {
    this.failure.set(null);
    this.form.markAllAsTouched();

    if (this.form.invalid || this.confirmError()) return;

    this.submitting.set(true);
    this.auth
      .completePasswordReset({
        token: this.token,
        password: this.form.controls.password.value
      })
      .subscribe({
        next: () => {
          this.submitting.set(false);
          this.done.set(true);
        },
        error: (error: unknown) => {
          this.submitting.set(false);
          // Expired, already-used and unknown tokens are refused identically.
          this.failure.set(describeError(error, this.t, "reset.failed"));
        }
      });
  }
}
