import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  output,
  signal
} from "@angular/core";
import { FormBuilder, ReactiveFormsModule, Validators } from "@angular/forms";
import { describeError } from "@core/http/api-error";
import { I18nService, injectT } from "@core/i18n/i18n.service";
import { ToastService } from "@core/notifications/toast.service";
import type { Role } from "@core/models";
import {
  AlertComponent,
  ButtonComponent,
  FieldComponent,
  IconComponent,
  InputDirective,
  ModalComponent,
  SelectDirective
} from "@shared/ui";
import { UsersService, type IssuedUserInvitation } from "../users.service";

/**
 * Inviting someone.
 *
 * Two phases in one dialog, the same shape as tenant provisioning: the form
 * creates the invitation, then the panel that replaces it shows the link once.
 * The API stores only a digest of the token, so a link that is not copied here
 * has to be reissued — the copy says so, and the footer button says "Done"
 * rather than "Close" to make it clear the flow finished rather than being
 * abandoned.
 */
@Component({
  selector: "app-invite-user-dialog",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    AlertComponent,
    ButtonComponent,
    FieldComponent,
    IconComponent,
    InputDirective,
    ModalComponent,
    SelectDirective
  ],
  template: `
    <ui-modal
      [title]="t(issued() ? 'invite.createdTitle' : 'invite.newTitle')"
      [description]="t(issued() ? 'invite.createdSubtitle' : 'invite.newSubtitle')"
      (closed)="dismiss()"
    >
      @if (issued(); as result) {
        <div class="space-y-4">
          <ui-alert tone="warning" [title]="t('createTenant.tokenWarningTitle')">
            {{ t("createTenant.tokenWarningBody") }}
          </ui-alert>

          <div class="space-y-1.5">
            <p class="text-sm font-medium text-foreground">{{ t("invite.linkLabel") }}</p>
            <div class="flex gap-2">
              <input
                uiInput
                readonly
                dir="ltr"
                [value]="inviteUrl(result)"
                class="font-mono !text-xs"
                [attr.aria-label]="t('invite.linkLabel')"
              />
              <button
                uiButton
                variant="outline"
                size="icon"
                type="button"
                [attr.aria-label]="t('invite.copyLink')"
                (click)="copy(inviteUrl(result))"
              >
                <ui-icon [name]="copied() ? 'check' : 'copy'" [size]="16" />
              </button>
            </div>
            <p class="text-xs text-foreground-subtle">
              {{ t("invite.expires", { date: i18n.formatDate(result.expiresAt) }) }}
              · {{ result.user.email }}
            </p>
          </div>
        </div>
      } @else {
        <form [formGroup]="form" id="invite-user" class="space-y-4" (ngSubmit)="submit()">
          @if (failure()) {
            <ui-alert tone="danger">{{ failure() }}</ui-alert>
          }

          <ui-field
            [label]="t('invite.emailLabel')"
            controlId="invite-email"
            [required]="true"
            [error]="emailError()"
          >
            <input
              uiInput
              id="invite-email"
              type="email"
              formControlName="email"
              placeholder="you@company.com"
              [invalid]="!!emailError()"
            />
          </ui-field>

          <ui-field
            [label]="t('invite.roleLabel')"
            controlId="invite-role"
            [hint]="t('invite.roleHint')"
            [required]="true"
          >
            <select uiSelect id="invite-role" formControlName="role">
              @for (role of roles(); track role.id) {
                <option [value]="role.name">{{ t(role.descriptionKey) }}</option>
              }
            </select>
          </ui-field>
        </form>
      }

      <div modalFooter>
        @if (issued()) {
          <button uiButton type="button" (click)="dismiss()">
            {{ t("common.done") }}
          </button>
        } @else {
          <button uiButton variant="ghost" type="button" (click)="dismiss()">
            {{ t("common.cancel") }}
          </button>
          <button uiButton type="submit" form="invite-user" [loading]="submitting()">
            {{ t("invite.send") }}
          </button>
        }
      </div>
    </ui-modal>
  `
})
export class InviteUserDialogComponent {
  readonly roles = input.required<readonly Role[]>();
  /** Emits once an invitation exists, so the list can refresh behind the dialog. */
  readonly created = output<void>();
  readonly closed = output<void>();

  private readonly users = inject(UsersService);
  private readonly toasts = inject(ToastService);

  protected readonly t = injectT();
  protected readonly i18n = inject(I18nService);
  protected readonly submitting = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly issued = signal<IssuedUserInvitation | null>(null);
  protected readonly copied = signal(false);

  protected readonly form = inject(FormBuilder).nonNullable.group({
    email: ["", [Validators.required, Validators.email]],
    role: ["viewer", [Validators.required]]
  });

  protected emailError(): string | null {
    const field = this.form.controls.email;
    if (!field.touched || field.valid) return null;
    return this.t("common.required");
  }

  protected inviteUrl(result: IssuedUserInvitation): string {
    return `${location.origin}/accept-invitation?token=${result.token}`;
  }

  protected copy(value: string): void {
    navigator.clipboard.writeText(value).then(
      () => {
        this.copied.set(true);
        setTimeout(() => this.copied.set(false), 2000);
      },
      () =>
        this.toasts.error(
          this.t("createTenant.copyFailed"),
          this.t("createTenant.copyFailedBody")
        )
    );
  }

  protected submit(): void {
    this.failure.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const { email, role } = this.form.getRawValue();
    this.submitting.set(true);

    this.users.invite(email, role).subscribe({
      next: (result) => {
        this.submitting.set(false);
        this.issued.set(result);
        this.created.emit();
      },
      error: (error: unknown) => {
        this.submitting.set(false);
        this.failure.set(describeError(error, this.t, "invite.newFailed"));
      }
    });
  }

  protected dismiss(): void {
    this.closed.emit();
  }
}
