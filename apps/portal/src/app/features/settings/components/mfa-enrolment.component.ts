import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import type { MfaEnabled, MfaEnrolmentStarted } from "@growpath/contracts";
import { AuthService } from "@core/auth/auth.service";
import { describeError } from "@core/http/api-error";
import { injectT } from "@core/i18n/i18n.service";
import { ToastService } from "@core/notifications/toast.service";
import {
  AlertComponent,
  ButtonComponent,
  IconComponent,
  OtpInputComponent,
  isOtpComplete
} from "@shared/ui";
// Direct import, not via the barrel — see the note there. This keeps the qrcode
// encoder inside the Settings chunk instead of the initial bundle.
import { QrCodeComponent } from "@shared/ui/qr-code.component";

type Phase = "idle" | "enrolling" | "enabled";

/**
 * TOTP enrolment, in three phases.
 *
 * `idle` → a button. `enrolling` → the secret, as a QR and as text. `enabled` →
 * the recovery codes, once.
 *
 * Both "shown once" moments are real and both are handled the same way as the
 * invitation token: the API stores only digests, so neither the secret nor the
 * codes can ever be retrieved again. The copy says so rather than leaving the
 * user to find out.
 *
 * The manual key is not a fallback for the QR — it is a peer. Someone enrolling
 * on the same device the code is displayed on cannot scan their own screen, and
 * that is a common case for a desktop admin portal.
 */
@Component({
  selector: "app-mfa-enrolment",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AlertComponent,
    ButtonComponent,
    IconComponent,
    OtpInputComponent,
    QrCodeComponent
  ],
  host: { class: "block" },
  template: `
    @switch (phase()) {
      @case ("enrolling") {
        <div class="space-y-5 animate-fade-in">
          <div class="space-y-1">
            <p class="text-sm font-medium text-foreground">
              {{ t("mfaSetup.scanTitle") }}
            </p>
            <p class="text-sm text-foreground-muted">{{ t("mfaSetup.scanBody") }}</p>
          </div>

          @if (enrolment(); as started) {
            <!-- dir="ltr": an otpauth URI and a base32 key are machine strings.
                 Mirroring them would not translate anything and would make the
                 key hard to read against its Latin characters. -->
            <div class="flex flex-col items-center gap-4" dir="ltr">
              <ui-qr-code
                #qr
                [value]="started.uri"
                [label]="t('mfaSetup.scanTitle')"
                [size]="176"
              />
              @if (qr.failed()) {
                <ui-alert tone="warning">{{ t("mfaSetup.qrFailed") }}</ui-alert>
              }
            </div>

            <div class="space-y-1.5">
              <p class="text-sm font-medium text-foreground">
                {{ t("mfaSetup.manualLabel") }}
              </p>
              <div class="flex gap-2">
                <code
                  dir="ltr"
                  class="flex-1 select-all rounded-xl border border-border bg-surface-muted px-3 py-2.5 font-mono text-xs tracking-wider text-foreground"
                >
                  {{ started.secret }}
                </code>
                <button
                  uiButton
                  variant="outline"
                  size="icon"
                  type="button"
                  [attr.aria-label]="t('mfaSetup.copyKey')"
                  (click)="copy(started.secret, 'mfaSetup.copyKey')"
                >
                  <ui-icon name="copy" [size]="16" />
                </button>
              </div>
            </div>
          }

          <div class="space-y-2 border-t border-border pt-5">
            <p class="text-sm font-medium text-foreground">
              {{ t("mfaSetup.confirmLabel") }}
            </p>
            @if (failure()) {
              <ui-alert tone="danger">{{ failure() }}</ui-alert>
            }
            <ui-otp-input
              [(value)]="code"
              [label]="t('mfa.digit')"
              [invalid]="!!failure()"
              [disabled]="busy()"
              (completed)="confirm()"
            />
          </div>

          <div class="flex flex-wrap gap-2">
            <button
              uiButton
              type="button"
              [loading]="busy()"
              [disabled]="!codeComplete()"
              (click)="confirm()"
            >
              {{ busy() ? t("mfaSetup.confirming") : t("mfaSetup.confirm") }}
            </button>
            <button uiButton variant="ghost" type="button" (click)="cancel()">
              {{ t("mfaSetup.cancel") }}
            </button>
          </div>
        </div>
      }

      @case ("enabled") {
        <div class="space-y-4 animate-fade-in">
          <div class="flex items-center gap-2 text-success">
            <ui-icon name="check-circle" [size]="18" />
            <p class="text-sm font-semibold">{{ t("mfaSetup.enabled") }}</p>
          </div>

          <ui-alert tone="warning" [title]="t('mfaSetup.recoveryWarning')">
            {{ t("mfaSetup.recoveryBody") }}
          </ui-alert>

          <div class="space-y-2">
            <p class="text-sm font-medium text-foreground">
              {{ t("mfaSetup.recoveryTitle") }}
            </p>
            <ul
              dir="ltr"
              class="grid grid-cols-2 gap-2 rounded-xl border border-border bg-surface-muted p-3"
            >
              @for (recoveryCode of recoveryCodes(); track recoveryCode) {
                <li class="select-all text-center font-mono text-xs text-foreground">
                  {{ recoveryCode }}
                </li>
              }
            </ul>
            <button
              uiButton
              variant="outline"
              size="sm"
              type="button"
              (click)="copy(recoveryCodes().join('\\n'), 'mfaSetup.codesCopied')"
            >
              <ui-icon name="copy" [size]="15" />
              {{ t("mfaSetup.copyCodes") }}
            </button>
          </div>
        </div>
      }

      @default {
        <div class="space-y-4">
          @if (failure()) {
            <ui-alert tone="danger">{{ failure() }}</ui-alert>
          }
          <button uiButton type="button" [loading]="busy()" (click)="start()">
            <ui-icon name="shield" [size]="16" />
            {{ busy() ? t("mfaSetup.starting") : t("mfaSetup.start") }}
          </button>
        </div>
      }
    }
  `
})
export class MfaEnrolmentComponent {
  private readonly auth = inject(AuthService);
  private readonly toasts = inject(ToastService);

  protected readonly t = injectT();
  protected readonly phase = signal<Phase>("idle");
  protected readonly busy = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly code = signal("");
  protected readonly enrolment = signal<MfaEnrolmentStarted | null>(null);
  protected readonly recoveryCodes = signal<readonly string[]>([]);

  /** Length is not completeness — the value is space-padded while being filled. */
  protected codeComplete(): boolean {
    return isOtpComplete(this.code());
  }

  protected start(): void {
    this.failure.set(null);
    this.busy.set(true);

    this.auth.startMfaEnrolment().subscribe({
      next: (started: MfaEnrolmentStarted) => {
        this.busy.set(false);
        this.enrolment.set(started);
        this.phase.set("enrolling");
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.failure.set(describeError(error, this.t, "mfaSetup.failed"));
      }
    });
  }

  protected confirm(): void {
    if (this.busy() || !this.codeComplete()) return;

    this.failure.set(null);
    this.busy.set(true);

    this.auth.confirmMfaEnrolment({ code: this.code() }).subscribe({
      next: (result: MfaEnabled) => {
        this.busy.set(false);
        this.recoveryCodes.set(result.recoveryCodes);
        // The secret is no longer needed and should not linger in memory once
        // enrolment is confirmed.
        this.enrolment.set(null);
        this.phase.set("enabled");
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.code.set("");
        this.failure.set(describeError(error, this.t, "mfaSetup.failed"));
      }
    });
  }

  protected cancel(): void {
    // Nothing to undo server-side: starting an enrolment mints a secret but
    // enables nothing, which is why the route writes no audit entry.
    this.phase.set("idle");
    this.enrolment.set(null);
    this.code.set("");
    this.failure.set(null);
  }

  protected copy(value: string, successKey: "mfaSetup.copyKey" | "mfaSetup.codesCopied"): void {
    navigator.clipboard.writeText(value).then(
      () => this.toasts.success(this.t(successKey)),
      () =>
        this.toasts.error(
          this.t("createTenant.copyFailed"),
          this.t("createTenant.copyFailedBody")
        )
    );
  }
}
