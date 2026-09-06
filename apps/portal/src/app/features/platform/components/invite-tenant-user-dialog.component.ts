import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  output,
  signal
} from "@angular/core";
import { FormBuilder, ReactiveFormsModule, Validators } from "@angular/forms";
import { describeError } from "@core/http/api-error";
import { I18nService, injectT } from "@core/i18n/i18n.service";
import { ToastService } from "@core/notifications/toast.service";
import type { MessageKey } from "@core/i18n/messages/en";
import { DEFAULT_TENANT_ROLES, type IssuedUserInvitation } from "@growpath/contracts";
import type { TenantSummary } from "@core/models";
import {
  AlertComponent,
  ButtonComponent,
  FieldComponent,
  IconComponent,
  InputDirective,
  ModalComponent,
  SelectDirective
} from "@shared/ui";
import { PlatformService } from "../platform.service";

/**
 * Adding a user to any tenant (US-073).
 *
 * The cross-tenant twin of the invite dialog on `/users`, and the tenant field
 * is the whole difference. On the tenant-scoped screen there is nothing to
 * choose — the tenant comes from the token — whereas an operator standing
 * outside every tenant has to say which one, and that is the field this dialog
 * exists to add.
 *
 * Two phases in one dialog, like its twin: the form issues the invitation, then
 * the panel that replaces it shows the link once. Only a digest of the token is
 * stored, so a link that is not copied here is reissued rather than recovered.
 *
 * ### Why the role is a short fixed list
 *
 * Roles are tenant-scoped and there is no endpoint that lists another tenant's
 * roles — nor should one exist purely to fill a dropdown. Every tenant is
 * provisioned with `admin` and `viewer`, so offering those two is honest, and
 * the API resolves the name inside the target tenant and answers 400 naming the
 * role if that tenant has renamed them. The failure is legible either way,
 * which is what matters for a case this rare.
 */
@Component({
  selector: "app-invite-tenant-user-dialog",
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
      [title]="t(issued() ? 'invite.createdTitle' : 'platformInvite.newTitle')"
      [description]="t(issued() ? 'invite.createdSubtitle' : 'platformInvite.newSubtitle')"
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
              · {{ result.user.email }} · {{ result.user.tenantSlug }}
            </p>
          </div>
        </div>
      } @else {
        <form
          [formGroup]="form"
          id="invite-tenant-user"
          class="space-y-4"
          (ngSubmit)="submit()"
        >
          @if (failure()) {
            <ui-alert tone="danger">{{ failure() }}</ui-alert>
          }

          <!--
            The tenant first, because it is the field that decides what the
            invitation does: an address identifies one person installation-wide,
            so naming the wrong workspace here does not create a spare account
            somewhere harmless — it puts a real person in a customer's tenant.
          -->
          <ui-field
            [label]="t('platformInvite.tenantLabel')"
            controlId="platform-invite-tenant"
            [hint]="t('platformInvite.tenantHint')"
            [required]="true"
            [error]="tenantError()"
          >
            <select uiSelect id="platform-invite-tenant" formControlName="tenantId">
              @for (tenant of tenants(); track tenant.id) {
                <option [value]="tenant.id">{{ tenant.name }} ({{ tenant.slug }})</option>
              }
            </select>
          </ui-field>

          <ui-field
            [label]="t('invite.emailLabel')"
            controlId="platform-invite-email"
            [required]="true"
            [error]="emailError()"
          >
            <input
              uiInput
              id="platform-invite-email"
              type="email"
              formControlName="email"
              placeholder="you@company.com"
              [invalid]="!!emailError()"
            />
          </ui-field>

          <ui-field
            [label]="t('invite.roleLabel')"
            controlId="platform-invite-role"
            [hint]="t('platformInvite.roleHint')"
            [required]="true"
          >
            <select uiSelect id="platform-invite-role" formControlName="role">
              @for (role of ROLES; track role) {
                <option [value]="role">{{ t(ROLE_LABELS[role]) }}</option>
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
          <button
            uiButton
            type="submit"
            form="invite-tenant-user"
            [loading]="submitting()"
            [disabled]="tenants().length === 0"
          >
            {{ t("invite.send") }}
          </button>
        }
      </div>
    </ui-modal>
  `
})
export class InviteTenantUserDialogComponent {
  /**
   * Every tenant the operator may add somebody to.
   *
   * Passed in rather than fetched here: the page that opens this dialog is a
   * platform screen that can already list tenants, and a dialog that fetched
   * its own would open on an empty select while it did.
   */
  readonly tenants = input.required<readonly TenantSummary[]>();

  /** Emits once an invitation exists, so the list can refresh behind the dialog. */
  readonly created = output<void>();
  readonly closed = output<void>();

  private readonly platform = inject(PlatformService);
  private readonly toasts = inject(ToastService);

  protected readonly t = injectT();
  protected readonly i18n = inject(I18nService);
  protected readonly submitting = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly issued = signal<IssuedUserInvitation | null>(null);
  protected readonly copied = signal(false);

  protected readonly ROLES = DEFAULT_TENANT_ROLES;
  protected readonly ROLE_LABELS: Record<string, MessageKey> = {
    admin: "role.admin",
    viewer: "role.viewer"
  };

  protected readonly form = inject(FormBuilder).nonNullable.group({
    tenantId: ["", [Validators.required]],
    email: ["", [Validators.required, Validators.email]],
    // The narrower of the two, deliberately. An operator adding somebody to a
    // customer's tenant is answering a support request, and defaulting that to
    // an administrator would make the careless outcome the powerful one.
    role: ["viewer" as string, [Validators.required]]
  });

  constructor() {
    /**
     * Preselects a tenant once the list arrives.
     *
     * The control starts empty, which matches no `<option>` — so the select
     * renders blank, and a blank required field is one an operator can submit
     * without noticing. They then get nothing at all: `submit()` marks the form
     * touched and returns, and "Send" looks broken. Defaulting to the first row
     * means the field always shows what it holds; `tenantError()` covers the
     * case where there is no list to default from.
     */
    effect(
      () => {
        const first = this.tenants()[0];
        if (first && !this.form.controls.tenantId.value) {
          this.form.controls.tenantId.setValue(first.id);
        }
      },
      { allowSignalWrites: true }
    );
  }

  /**
   * The tenant field's error, which without this could not be shown at all.
   *
   * `ui-field` renders nothing it is not given, so a required control with no
   * `[error]` binding fails silently — and the state where that matters is an
   * empty tenant list, which leaves the operator staring at a form that refuses
   * to submit and says nothing about why.
   */
  protected tenantError(): string | null {
    const field = this.form.controls.tenantId;
    return field.touched && field.invalid ? this.t("common.required") : null;
  }

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

    const { tenantId, email, role } = this.form.getRawValue();
    this.submitting.set(true);

    this.platform.inviteUser({ tenantId, email, role }).subscribe({
      next: (result) => {
        this.submitting.set(false);
        this.issued.set(result);
        this.created.emit();
      },
      error: (error: unknown) => {
        this.submitting.set(false);
        // Carries the API's own message where there is one: a full tenant (409)
        // and a role the tenant does not have (400) are both things the
        // operator can act on, and "invitation failed" would hide which.
        this.failure.set(describeError(error, this.t, "platformInvite.failed"));
      }
    });
  }

  protected dismiss(): void {
    this.closed.emit();
  }
}
