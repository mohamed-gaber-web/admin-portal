import { ChangeDetectionStrategy, Component, inject, output, signal } from "@angular/core";
import { FormBuilder, ReactiveFormsModule, Validators } from "@angular/forms";
import type { ProvisionedTenant } from "@growpath/contracts";
import { describeError } from "@core/http/api-error";
import { I18nService, injectT } from "@core/i18n/i18n.service";
import { ToastService } from "@core/notifications/toast.service";
import {
  AlertComponent,
  ButtonComponent,
  FieldComponent,
  IconComponent,
  InputDirective,
  ModalComponent
} from "@shared/ui";
import { PlatformService } from "../platform.service";

const SLUG_PATTERN = /^[a-z0-9-]+$/;

/**
 * Provisioning a tenant. Platform administrators only.
 *
 * It lives under `features/platform` rather than `features/tenants` because
 * `POST /tenants` is a platform operation: an ordinary tenant administrator
 * creating further tenants was never intended, and the API now refuses it. The
 * dialog is opened from the all-tenants screen, which is the only screen a
 * caller who is allowed to use it can reach.
 *
 * Two phases in one dialog. The form creates the tenant; the panel that
 * replaces it shows the first admin's invitation token — which the API returns
 * exactly once, because it stores only a digest. Closing this dialog without
 * copying that token means the invitation has to be reissued, so the close
 * button says as much and the success toast repeats it.
 */
@Component({
  selector: "app-create-tenant-dialog",
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
      [title]="t(provisioned() ? 'createTenant.createdTitle' : 'createTenant.title')"
      [description]="
        t(
          provisioned()
            ? 'createTenant.createdSubtitle'
            : 'createTenant.subtitle'
        )
      "
      (closed)="dismiss()"
    >
      @if (provisioned(); as result) {
        <div class="space-y-4">
          <ui-alert tone="warning" [title]="t('createTenant.tokenWarningTitle')">
            {{ t("createTenant.tokenWarningBody") }}
          </ui-alert>

          <div class="space-y-1.5">
            <p class="text-sm font-medium text-foreground">{{ t("createTenant.invitationLink") }}</p>
            <div class="flex gap-2">
              <input
                uiInput
                readonly
                [value]="inviteUrl(result)"
                class="font-mono !text-xs"
                [attr.aria-label]="t('createTenant.invitationLink')"
              />
              <button
                uiButton
                variant="outline"
                size="icon"
                type="button"
                [attr.aria-label]="t('createTenant.copyLink')"
                (click)="copy(inviteUrl(result))"
              >
                <ui-icon [name]="copied() ? 'check' : 'copy'" [size]="16" />
              </button>
            </div>
            <p class="text-xs text-foreground-subtle">
              {{
                t("createTenant.expiresFor", {
                  date: i18n.formatDate(result.invitation.expiresAt),
                  email: result.adminUser.email
                })
              }}
            </p>
          </div>
        </div>
      } @else {
        <form [formGroup]="form" id="create-tenant" class="space-y-4" (ngSubmit)="submit()">
          @if (failure()) {
            <ui-alert tone="danger">{{ failure() }}</ui-alert>
          }

          <ui-field [label]="t('createTenant.name')" controlId="tenant-name" [required]="true">
            <input uiInput id="tenant-name" formControlName="name" [attr.placeholder]="t('createTenant.namePlaceholder')" />
          </ui-field>

          <ui-field
            [label]="t('createTenant.slug')"
            controlId="tenant-slug"
            [hint]="t('createTenant.slugHint')"
            [required]="true"
            [error]="slugError()"
          >
            <input
              uiInput
              id="tenant-slug"
              formControlName="slug"
              spellcheck="false"
              placeholder="acme"
              [invalid]="!!slugError()"
            />
          </ui-field>

          <ui-field
            [label]="t('createTenant.adminEmail')"
            controlId="tenant-admin"
            [hint]="t('createTenant.adminEmailHint')"
          >
            <input uiInput id="tenant-admin" type="email" formControlName="adminEmail" />
          </ui-field>
        </form>
      }

      <!--
        One static root node for the footer slot.

        Content projection is resolved against the template's root nodes, so a
        modalFooter element nested inside an @if never reaches the slot — it
        renders in the body instead, which the compiler warns about but which
        otherwise looks merely like a spacing bug. The branch goes inside.
      -->
      <div modalFooter>
        @if (provisioned()) {
          <button uiButton type="button" (click)="dismiss()">
            {{ t("common.done") }}
          </button>
        } @else {
          <button uiButton variant="ghost" type="button" (click)="dismiss()">
            {{ t("common.cancel") }}
          </button>
          <button uiButton type="submit" form="create-tenant" [loading]="submitting()">
            {{ t("createTenant.submit") }}
          </button>
        }
      </div>
    </ui-modal>
  `
})
export class CreateTenantDialogComponent {
  /** Emits once a tenant exists, so the list can refresh behind the dialog. */
  readonly created = output<void>();
  readonly closed = output<void>();

  private readonly platform = inject(PlatformService);
  private readonly toasts = inject(ToastService);

  protected readonly t = injectT();
  protected readonly i18n = inject(I18nService);

  protected readonly submitting = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly provisioned = signal<ProvisionedTenant | null>(null);
  protected readonly copied = signal(false);

  protected readonly form = inject(FormBuilder).nonNullable.group({
    name: ["", [Validators.required]],
    slug: ["", [Validators.required, Validators.pattern(SLUG_PATTERN)]],
    adminEmail: [""]
  });

  protected slugError(): string | null {
    const field = this.form.controls.slug;
    if (!field.touched || field.valid) return null;
    return this.t("createTenant.slugInvalid");
  }

  protected inviteUrl(result: ProvisionedTenant): string {
    return `${location.origin}/accept-invitation?token=${result.invitation.token}`;
  }

  protected copy(value: string): void {
    navigator.clipboard.writeText(value).then(
      () => {
        this.copied.set(true);
        setTimeout(() => this.copied.set(false), 2000);
      },
      // Clipboard access is refused on an insecure origin and in some embedded
      // browsers. The field is selectable, so say so rather than failing mute.
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

    const { name, slug, adminEmail } = this.form.getRawValue();
    this.submitting.set(true);

    this.platform
      // Omitted rather than sent empty: the schema marks it optional, and ""
      // would fail its email check.
      .createTenant({ name, slug, ...(adminEmail ? { adminEmail } : {}) })
      .subscribe({
        next: (result) => {
          this.submitting.set(false);
          this.provisioned.set(result);
          this.created.emit();
          this.toasts.success(
            this.t("createTenant.created", { name: result.tenant.name }),
            this.t("createTenant.createdToast")
          );
        },
        error: (error: unknown) => {
          this.submitting.set(false);
          this.failure.set(describeError(error, this.t, "createTenant.failed"));
        }
      });
  }

  protected dismiss(): void {
    this.closed.emit();
  }
}
