import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router, RouterLink } from "@angular/router";
import { AuthService } from "@core/auth/auth.service";
import { MfaChallengeStore } from "@core/auth/mfa-challenge.store";
import { describeError } from "@core/http/api-error";
import { injectT } from "@core/i18n/i18n.service";
import {
  AlertComponent,
  ButtonComponent,
  FieldComponent,
  InputDirective,
  OtpInputComponent,
  isOtpComplete
} from "@shared/ui";
import { AuthLayoutComponent } from "./auth-layout.component";

/**
 * The second factor.
 *
 * Reached only when sign-in answered `mfa_required`. The challenge token lives
 * in memory on `MfaChallengeStore`; a reload loses it and sends the user back
 * to sign in, which is correct — the token is short-lived and re-authenticating
 * is cheap.
 *
 * Two ways in, because an authenticator app can be lost and a recovery code is
 * the whole reason recovery codes exist. They are different shapes — six digits
 * against a longer alphanumeric string — so they get different inputs rather
 * than one field that has to accept both and validate neither.
 *
 * The failure message never distinguishes a wrong code from a replayed one or a
 * spent recovery code. Neither does the API, deliberately.
 */
@Component({
  selector: "app-mfa-challenge-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    RouterLink,
    AlertComponent,
    AuthLayoutComponent,
    ButtonComponent,
    FieldComponent,
    InputDirective,
    OtpInputComponent
  ],
  template: `
    <app-auth-layout [title]="t('mfa.title')" [subtitle]="t('mfa.subtitle')">
      <form class="space-y-5" (ngSubmit)="submit()">
        @if (failure()) {
          <ui-alert tone="danger">{{ failure() }}</ui-alert>
        }

        @if (usingRecovery()) {
          <ui-field
            [label]="t('mfa.recoveryLabel')"
            controlId="mfa-recovery"
            [hint]="t('mfa.recoveryHint')"
            [required]="true"
          >
            <input
              uiInput
              id="mfa-recovery"
              name="recovery"
              autocomplete="one-time-code"
              spellcheck="false"
              class="font-mono"
              [(ngModel)]="recoveryCode"
              [invalid]="!!failure()"
            />
          </ui-field>
        } @else {
          <div class="space-y-2">
            <p class="text-center text-sm font-medium text-foreground">
              {{ t("mfa.codeLabel") }}
            </p>
            <ui-otp-input
              [(value)]="code"
              [label]="t('mfa.digit')"
              [invalid]="!!failure()"
              [disabled]="submitting()"
              (completed)="submit()"
            />
          </div>
        }

        <button
          uiButton
          type="submit"
          size="lg"
          [block]="true"
          [loading]="submitting()"
          [disabled]="!hasInput()"
        >
          {{ submitting() ? t("mfa.verifying") : t("mfa.verify") }}
        </button>

        <div class="flex flex-col items-center gap-2 pt-1">
          <button
            type="button"
            class="text-sm font-medium text-primary transition-opacity duration-200 hover:opacity-80"
            (click)="toggleMethod()"
          >
            {{ usingRecovery() ? t("mfa.useAuthenticator") : t("mfa.useRecovery") }}
          </button>
          <a
            routerLink="/login"
            class="text-sm text-foreground-muted transition-colors duration-200 hover:text-foreground"
          >
            {{ t("mfa.backToSignIn") }}
          </a>
        </div>
      </form>
    </app-auth-layout>
  `
})
export class MfaChallengePage {
  private readonly auth = inject(AuthService);
  private readonly challenge = inject(MfaChallengeStore);
  private readonly router = inject(Router);

  protected readonly t = injectT();
  protected readonly submitting = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly usingRecovery = signal(false);
  protected readonly code = signal("");
  protected readonly recoveryCode = signal("");

  protected hasInput(): boolean {
    return this.usingRecovery()
      ? this.recoveryCode().trim().length > 0
      : isOtpComplete(this.code());
  }

  protected toggleMethod(): void {
    this.usingRecovery.update((current) => !current);
    this.failure.set(null);
    this.code.set("");
    this.recoveryCode.set("");
  }

  protected submit(): void {
    if (this.submitting() || !this.hasInput()) return;

    const challengeToken = this.challenge.token();
    if (!challengeToken) {
      // The challenge is gone — a reload, or a tab left open past its expiry.
      // Nothing here can recover it, so say so and send them back.
      this.failure.set(this.t("mfa.expired"));
      return;
    }

    this.failure.set(null);
    this.submitting.set(true);

    const code = this.usingRecovery() ? this.recoveryCode().trim() : this.code();

    this.auth.verifyMfa({ challengeToken, code }).subscribe({
      next: () => {
        this.challenge.clear();
        void this.router.navigateByUrl("/dashboard");
      },
      error: (error: unknown) => {
        this.submitting.set(false);
        this.code.set("");
        this.failure.set(describeError(error, this.t, "mfa.failed"));
      }
    });
  }
}
