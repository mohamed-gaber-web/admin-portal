import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { FormBuilder, ReactiveFormsModule, Validators } from "@angular/forms";
import { RouterLink } from "@angular/router";
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
 * Asking for a reset link.
 *
 * The address alone, matching sign-in. Asking for a workspace here would have
 * been the worst place to ask: somebody who has forgotten their password is the
 * person least likely to remember which slug their organisation was given.
 *
 * The confirmation deliberately does not say whether an account was found. The
 * API answers identically either way — that is the entire design of
 * `passwordResetRequestedSchema`, which has exactly one field and no room for a
 * boolean — and copy like "if we found your account" would hand back the
 * enumeration oracle the contract works to remove. So the success state shows
 * regardless of what the server knew, and says only what is true for everyone.
 */
@Component({
  selector: "app-forgot-password-page",
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
    <app-auth-layout [title]="t('forgot.title')" [subtitle]="t('forgot.subtitle')">
      @if (sent()) {
        <div class="space-y-5 text-center">
          <span
            class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-info-subtle text-info"
          >
            <ui-icon name="mail" [size]="24" />
          </span>
          <div class="space-y-1">
            <p class="text-sm font-semibold text-foreground">
              {{ t("forgot.sentTitle") }}
            </p>
            <p class="text-sm leading-relaxed text-foreground-muted">
              {{ t("forgot.sentBody") }}
            </p>
          </div>
          <a uiButton routerLink="/login" variant="outline" size="lg" [block]="true">
            {{ t("forgot.backToSignIn") }}
          </a>
        </div>
      } @else {
        <form [formGroup]="form" class="space-y-4" (ngSubmit)="submit()">
          @if (failure()) {
            <ui-alert tone="danger">{{ failure() }}</ui-alert>
          }

          <ui-field
            [label]="t('login.email')"
            controlId="forgot-email"
            [required]="true"
            [error]="errorFor('email')"
          >
            <input
              uiInput
              id="forgot-email"
              type="email"
              formControlName="email"
              autocomplete="username"
              placeholder="you@company.com"
              [invalid]="!!errorFor('email')"
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
            {{ submitting() ? t("forgot.submitting") : t("forgot.submit") }}
          </button>

          <div class="pt-1 text-center">
            <a
              routerLink="/login"
              class="text-sm text-foreground-muted transition-colors duration-200 hover:text-foreground"
            >
              {{ t("forgot.backToSignIn") }}
            </a>
          </div>
        </form>
      }
    </app-auth-layout>
  `
})
export class ForgotPasswordPage {
  private readonly auth = inject(AuthService);

  protected readonly t = injectT();
  protected readonly submitting = signal(false);
  protected readonly sent = signal(false);
  protected readonly failure = signal<string | null>(null);

  protected readonly form = inject(FormBuilder).nonNullable.group({
    email: ["", [Validators.required]]
  });

  protected errorFor(control: "email"): string | null {
    const field = this.form.controls[control];
    if (!field.touched || field.valid) return null;
    return this.t("common.required");
  }

  protected submit(): void {
    this.failure.set(null);

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    this.submitting.set(true);
    this.auth.requestPasswordReset(this.form.getRawValue()).subscribe({
      // No branch on the response: there is only one, by design.
      next: () => {
        this.submitting.set(false);
        this.sent.set(true);
      },
      // A failure here is a transport or server fault, never "no such account".
      error: (error: unknown) => {
        this.submitting.set(false);
        this.failure.set(describeError(error, this.t, "forgot.failed"));
      }
    });
  }
}
