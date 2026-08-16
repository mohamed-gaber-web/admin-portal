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
 * Redeeming an invitation and setting a first password.
 *
 * The token arrives in the query string — `/accept-invitation?token=…` — since
 * the person following the link has no credential yet, which is the whole point
 * of the flow.
 *
 * `MIN_PASSWORD_LENGTH` is imported from the contracts package rather than
 * typed as a number here. The API rejects anything shorter, and a local copy of
 * the rule is a copy that will disagree with the server eventually — at which
 * point the form either accepts a password the API refuses, or refuses one it
 * would have taken. It is interpolated into the message rather than
 * concatenated, so Arabic can place the number where its grammar needs it.
 */
@Component({
  selector: "app-accept-invitation-page",
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
    <app-auth-layout [title]="t('invite.title')" [subtitle]="t('invite.subtitle')">
      @if (accepted()) {
        <div class="space-y-5 text-center">
          <span
            class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-success-subtle text-success"
          >
            <ui-icon name="check-circle" [size]="24" />
          </span>
          <div class="space-y-1">
            <p class="text-sm font-semibold text-foreground">
              {{ t("invite.doneTitle") }}
            </p>
            <p class="text-sm text-foreground-muted">{{ t("invite.doneBody") }}</p>
          </div>
          <a uiButton routerLink="/login" size="lg" [block]="true">
            {{ t("invite.goToSignIn") }}
          </a>
        </div>
      } @else if (!token) {
        <ui-alert tone="danger" [title]="t('invite.invalidTitle')">
          {{ t("invite.invalidBody") }}
        </ui-alert>
      } @else {
        <form [formGroup]="form" class="space-y-4" (ngSubmit)="submit()">
          @if (failure()) {
            <ui-alert tone="danger">{{ failure() }}</ui-alert>
          }

          <ui-field
            [label]="t('invite.newPassword')"
            controlId="invite-password"
            [required]="true"
            [hint]="t('invite.passwordHint', { count: MIN_PASSWORD_LENGTH })"
            [error]="passwordError()"
          >
            <input
              uiInput
              id="invite-password"
              type="password"
              formControlName="password"
              autocomplete="new-password"
              [invalid]="!!passwordError()"
            />
          </ui-field>

          <ui-field
            [label]="t('invite.confirmPassword')"
            controlId="invite-confirm"
            [required]="true"
            [error]="confirmError()"
          >
            <input
              uiInput
              id="invite-confirm"
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
            {{ t("invite.submit") }}
          </button>
        </form>
      }
    </app-auth-layout>
  `
})
export class AcceptInvitationPage {
  protected readonly MIN_PASSWORD_LENGTH = MIN_PASSWORD_LENGTH;

  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly t = injectT();
  protected readonly token =
    this.router.parseUrl(this.router.url).queryParams["token"] ?? "";

  protected readonly submitting = signal(false);
  protected readonly accepted = signal(false);
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
      .acceptInvitation({
        token: this.token,
        password: this.form.controls.password.value
      })
      .subscribe({
        next: () => {
          this.submitting.set(false);
          this.accepted.set(true);
        },
        error: (error: unknown) => {
          this.submitting.set(false);
          // Unknown, expired and already-redeemed tokens are refused
          // identically by the API, so this message stays as vague as it sent.
          this.failure.set(describeError(error, this.t, "invite.failed"));
        }
      });
  }
}
