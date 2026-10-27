import { ChangeDetectionStrategy, Component, inject, input, output } from "@angular/core";
import { I18nService, injectT } from "@core/i18n/i18n.service";
import { ToastService } from "@core/notifications/toast.service";
import type { OperatorPasswordReset } from "@growpath/contracts";
import {
  AlertComponent,
  ButtonComponent,
  FieldComponent,
  IconComponent,
  InputDirective,
  ModalComponent
} from "@shared/ui";

/**
 * Shows a password reset link an operator just issued, once.
 *
 * Only the token's digest is stored, so this is the one moment the link exists
 * anywhere — closing the dialog loses it, and the remedy is issuing another,
 * which burns this one. Hence the warning, and a copy button rather than
 * relying on somebody selecting a long monospace string by hand.
 *
 * There is deliberately no password field anywhere in this flow. The operator
 * hands over a link and the account's owner picks the password, so no operator
 * ever knows one and the audit trail can still tell their sign-ins apart.
 */
@Component({
  selector: "app-reset-link-dialog",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AlertComponent,
    ButtonComponent,
    FieldComponent,
    IconComponent,
    InputDirective,
    ModalComponent
  ],
  template: `
    <ui-modal
      [title]="t('platformUsers.resetReadyTitle', { name: name() })"
      [description]="t('platformUsers.resetReadySubtitle')"
      (closed)="closed.emit()"
    >
      <div class="space-y-4">
        <ui-alert tone="warning" [title]="t('platformUsers.resetWarningTitle')">
          {{ t("platformUsers.resetWarningBody") }}
        </ui-alert>

        <ui-field [label]="t('platformUsers.resetLink')" controlId="user-reset-link">
          <div class="flex gap-2">
            <input
              uiInput
              id="user-reset-link"
              dir="ltr"
              class="!font-mono !text-xs"
              readonly
              [value]="link()"
            />
            <button
              uiButton
              variant="outline"
              type="button"
              [attr.aria-label]="t('platformUsers.copyResetLink')"
              (click)="copy()"
            >
              <ui-icon name="copy" [size]="16" />
            </button>
          </div>
        </ui-field>

        <p class="text-xs text-foreground-subtle">
          {{
            t("platformUsers.resetExpires", {
              date: i18n.formatDate(result().expiresAt),
              email: result().email
            })
          }}
        </p>

        <div class="flex justify-end pt-2">
          <button uiButton type="button" (click)="closed.emit()">
            {{ t("common.done") }}
          </button>
        </div>
      </div>
    </ui-modal>
  `
})
export class ResetLinkDialogComponent {
  readonly result = input.required<OperatorPasswordReset>();
  /** The account's display name, for the title. */
  readonly name = input.required<string>();
  readonly closed = output<void>();

  private readonly toasts = inject(ToastService);
  protected readonly t = injectT();
  protected readonly i18n = inject(I18nService);

  /**
   * Built against the portal's own origin, like the invitation links: whoever
   * is looking at this reached the portal somehow, and the reset screen lives
   * at the same address.
   */
  protected link(): string {
    return `${location.origin}/reset-password?token=${encodeURIComponent(this.result().token)}`;
  }

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.link());
      this.toasts.success(this.t("platformUsers.resetCopied"));
    } catch {
      // Clipboard access is denied outside a secure context. The link is in a
      // readable input either way, so this says "select it yourself".
      this.toasts.error(
        this.t("createTenant.copyFailed"),
        this.t("createTenant.copyFailedBody")
      );
    }
  }
}
