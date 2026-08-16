import { ChangeDetectionStrategy, Component, inject, output, signal } from "@angular/core";
import { FormBuilder, ReactiveFormsModule, Validators } from "@angular/forms";
import { describeError } from "@core/http/api-error";
import { I18nService, injectT } from "@core/i18n/i18n.service";
import { ToastService } from "@core/notifications/toast.service";
import type { PlatformAdminCreated } from "@growpath/contracts";
import {
  AlertComponent,
  ButtonComponent,
  FieldComponent,
  IconComponent,
  InputDirective,
  ModalComponent
} from "@shared/ui";
import { PlatformService } from "../platform.service";

/**
 * Adds a super administrator.
 *
 * There is no password field, and that is the design rather than a shortcut.
 * The account is created with no credential and an invitation link, exactly as
 * `pnpm platform-admin` does it from a shell — a form that set a colleague's
 * password would mean one operator knowing another's credential, which defeats
 * the point of having named operators who can be held to what they did.
 *
 * ### The token is shown once
 *
 * Only its digest is stored, so nothing can ever display it again — a lost link
 * is reissued, never recovered. The dialog therefore switches into a "copy this
 * now" state rather than closing on success, and says so plainly. Closing
 * straight back to the list would be the single most annoying possible outcome:
 * the account exists and nobody can sign in as it.
 *
 * ### An address that is already an operator
 *
 * Comes back with `invitation: null` and is reported as success, because it is
 * one — the caller's goal was "this person should be an operator", and they
 * already are. Reissuing an invitation instead would be an account takeover
 * available to anyone who can open this dialog.
 */
@Component({
  selector: "app-create-admin-dialog",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    AlertComponent,
    ButtonComponent,
    FieldComponent,
    IconComponent,
    InputDirective,
    ModalComponent
  ],
  template: `
    <ui-modal
      [title]="result() ? t('platformAdmins.createdTitle') : t('platformAdmins.newTitle')"
      [description]="
        result() ? t('platformAdmins.createdSubtitle') : t('platformAdmins.newSubtitle')
      "
      (closed)="close()"
    >
      @if (result(); as result) {
        <div class="space-y-4">
          @if (result.invitation) {
            <ui-alert tone="warning" [title]="t('platformAdmins.tokenWarningTitle')">
              {{ t("platformAdmins.tokenWarningBody") }}
            </ui-alert>

            <ui-field
              [label]="t('platformAdmins.invitationLink')"
              controlId="admin-invitation-link"
            >
              <div class="flex gap-2">
                <input
                  uiInput
                  id="admin-invitation-link"
                  dir="ltr"
                  class="!font-mono !text-xs"
                  readonly
                  [value]="invitationLink(result)"
                />
                <button
                  uiButton
                  variant="outline"
                  type="button"
                  [attr.aria-label]="t('platformAdmins.copyLink')"
                  (click)="copy(invitationLink(result))"
                >
                  <ui-icon name="copy" [size]="16" />
                </button>
              </div>
            </ui-field>

            <p class="text-xs text-foreground-subtle">
              {{
                t("platformAdmins.expiresFor", {
                  date: i18n.formatDate(result.invitation.expiresAt),
                  email: result.user.email
                })
              }}
            </p>
          } @else {
            <!--
              Not an error. The address already belongs to an active operator,
              and the caller's stated goal is already true — so this says so and
              points at password reset, which is the correct route for somebody
              who has an account and cannot get into it.
            -->
            <ui-alert tone="info" [title]="t('platformAdmins.alreadyTitle')">
              {{ t("platformAdmins.alreadyBody", { email: result.user.email }) }}
            </ui-alert>
          }

          <div class="flex justify-end pt-2">
            <button uiButton type="button" (click)="close()">
              {{ t("common.done") }}
            </button>
          </div>
        </div>
      } @else {
        <form [formGroup]="form" class="space-y-4" (ngSubmit)="submit()">
          <ui-alert tone="warning" [title]="t('platformAdmins.reachWarningTitle')">
            {{ t("platformAdmins.reachWarningBody") }}
          </ui-alert>

          <ui-field
            [label]="t('platformAdmins.email')"
            controlId="admin-email"
            [required]="true"
            [error]="errorFor('email')"
          >
            <input
              uiInput
              id="admin-email"
              type="email"
              dir="ltr"
              formControlName="email"
              autocomplete="off"
              placeholder="operator@example.com"
              [invalid]="!!errorFor('email')"
            />
          </ui-field>

          <ui-field
            [label]="t('platformAdmins.name')"
            controlId="admin-name"
            [hint]="t('platformAdmins.nameHint')"
          >
            <input uiInput id="admin-name" formControlName="name" autocomplete="off" />
          </ui-field>

          <div class="flex justify-end gap-2 pt-2">
            <button uiButton variant="ghost" type="button" (click)="close()">
              {{ t("common.cancel") }}
            </button>
            <button uiButton type="submit" [loading]="submitting()">
              {{ t("platformAdmins.submit") }}
            </button>
          </div>
        </form>
      }
    </ui-modal>
  `
})
export class CreateAdminDialogComponent {
  /** Emitted once the operator exists, so the list can reload. */
  readonly created = output<void>();
  readonly closed = output<void>();

  private readonly platform = inject(PlatformService);
  private readonly toasts = inject(ToastService);

  protected readonly t = injectT();
  protected readonly i18n = inject(I18nService);

  protected readonly submitting = signal(false);

  /** Null until the request lands. Non-null switches the dialog into its
   * "copy this link now" state, which is the only time the token exists. */
  protected readonly result = signal<PlatformAdminCreated | null>(null);

  protected readonly form = inject(FormBuilder).nonNullable.group({
    email: ["", [Validators.required, Validators.email]],
    name: [""]
  });

  protected errorFor(control: "email"): string | null {
    const field = this.form.controls[control];
    if (!field.touched || field.valid) return null;
    return this.t("platformAdmins.emailInvalid");
  }

  protected invitationLink(result: PlatformAdminCreated): string {
    // Built against the portal's own origin rather than a configured base URL:
    // whoever is looking at this dialog reached the portal somehow, and that is
    // the address the invitee needs.
    const token = result.invitation?.token ?? "";
    return `${location.origin}/accept-invitation?token=${encodeURIComponent(token)}`;
  }

  protected submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const { email, name } = this.form.getRawValue();
    this.submitting.set(true);

    this.platform
      .createAdmin({ email, ...(name.trim() ? { name: name.trim() } : {}) })
      .subscribe({
        next: (created) => {
          this.submitting.set(false);
          this.result.set(created);
          this.created.emit();
        },
        error: (error: unknown) => {
          this.submitting.set(false);
          this.toasts.error(describeError(error, this.t, "platformAdmins.failed"));
        }
      });
  }

  protected async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.toasts.success(this.t("platformAdmins.copied"));
    } catch {
      // Clipboard access is denied outside a secure context and in some
      // embedded browsers. The link is in a readable input either way, so this
      // says "select it yourself" rather than failing silently.
      this.toasts.error(
        this.t("createTenant.copyFailed"),
        this.t("createTenant.copyFailedBody")
      );
    }
  }

  protected close(): void {
    this.closed.emit();
  }
}
