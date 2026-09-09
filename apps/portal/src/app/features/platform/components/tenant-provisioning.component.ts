import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal
} from "@angular/core";
import { FormBuilder, ReactiveFormsModule, Validators } from "@angular/forms";
import { describeError } from "@core/http/api-error";
import { injectT } from "@core/i18n/i18n.service";
import { ToastService } from "@core/notifications/toast.service";
import type { TenantDetail } from "@core/models";
import { ENVIRONMENT_KINDS } from "@growpath/contracts";
import {
  AlertComponent,
  ButtonComponent,
  FieldComponent,
  IconComponent,
  InputDirective,
  SelectDirective
} from "@shared/ui";
import { PlatformService } from "../platform.service";

const HTTPS_URL = /^https:\/\/.+/;
const DATA_AREA_ID = /^[a-z0-9]+$/;

/**
 * Setting a tenant up to reach Dynamics: its environment, then its companies.
 *
 * This is the step that had no home. `provisionTenant` creates a tenant with no
 * environment, so `findErpBlocker` reports `no_environment` and every user of
 * that tenant is sent to the mobile app's setup screen — and until now nothing
 * in the portal could create the row that clears it. The functions existed in
 * the database package with no caller; a freshly sold customer could only be
 * made to work by running the seed script or editing Postgres by hand.
 *
 * ### Why an operator does this and not the tenant
 *
 * It matches every other decision in the platform tier, and it keeps a customer
 * from pointing the app at an arbitrary Dynamics instance. The tenant's own
 * Configuration screen still owns the *credential* — that is theirs to rotate —
 * and this owns which instance exists at all.
 *
 * ### The order is the guidance
 *
 * A company cannot exist without an environment, so before there is one the
 * company form is not merely disabled, it is absent, and the environment form
 * carries the explanation. A screen that shows both from the start invites
 * somebody to fill in the second and be told no.
 */
@Component({
  selector: "app-tenant-provisioning",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    AlertComponent,
    ButtonComponent,
    FieldComponent,
    IconComponent,
    InputDirective,
    SelectDirective
  ],
  host: { class: "block" },
  template: `
    <div class="space-y-4">
      @if (failure()) {
        <ui-alert tone="danger">{{ failure() }}</ui-alert>
      }

      <!--
        The first-run explanation.

        Shown only while the tenant has no environment, because that is the one
        state where an operator is looking at a customer who cannot use the
        product at all and may not know why. Once one exists this collapses to
        nothing rather than becoming permanent furniture.
      -->
      @if (environments().length === 0) {
        <ui-alert tone="info" [title]="t('provisioning.firstRunTitle')">
          {{ t("provisioning.firstRunBody") }}
        </ui-alert>
      }

      @if (openForm() === "environment") {
        <form [formGroup]="environmentForm" class="space-y-4" (ngSubmit)="saveEnvironment()">
          <ui-field
            [label]="t('provisioning.environmentName')"
            controlId="env-name"
            [required]="true"
            [hint]="t('provisioning.environmentNameHint')"
          >
            <input uiInput id="env-name" formControlName="name" [attr.placeholder]="t('provisioning.environmentNamePlaceholder')" />
          </ui-field>

          <ui-field
            [label]="t('provisioning.environmentUrl')"
            controlId="env-url"
            [required]="true"
            [hint]="t('provisioning.environmentUrlHint')"
            [error]="urlError()"
          >
            <input
              uiInput
              id="env-url"
              formControlName="url"
              spellcheck="false"
              [attr.placeholder]="t('provisioning.environmentUrlPlaceholder')"
              [invalid]="!!urlError()"
            />
          </ui-field>

          <ui-field
            [label]="t('provisioning.environmentKind')"
            controlId="env-kind"
            [hint]="t('provisioning.environmentKindHint')"
          >
            <select uiSelect id="env-kind" formControlName="kind">
              @for (kind of KINDS; track kind) {
                <option [value]="kind">{{ t(kind === "production" ? "environmentKind.production" : "environmentKind.sandbox") }}</option>
              }
            </select>
          </ui-field>

          <div class="flex items-center gap-2">
            <button uiButton size="sm" type="submit" [loading]="saving()">
              {{ t("provisioning.createEnvironment") }}
            </button>
            <button uiButton variant="ghost" size="sm" type="button" [disabled]="saving()" (click)="close()">
              {{ t("common.cancel") }}
            </button>
          </div>
        </form>
      } @else if (openForm() === "company") {
        <form [formGroup]="companyForm" class="space-y-4" (ngSubmit)="saveCompany()">
          <ui-field
            [label]="t('provisioning.companyEnvironment')"
            controlId="co-env"
            [hint]="t('provisioning.companyEnvironmentHint')"
          >
            <select uiSelect id="co-env" formControlName="environmentId">
              @for (env of environments(); track env.id) {
                <option [value]="env.id">{{ env.name }}</option>
              }
            </select>
          </ui-field>

          <ui-field
            [label]="t('provisioning.companyName')"
            controlId="co-name"
            [required]="true"
          >
            <input uiInput id="co-name" formControlName="name" [attr.placeholder]="t('provisioning.companyNamePlaceholder')" />
          </ui-field>

          <ui-field
            [label]="t('provisioning.dataAreaId')"
            controlId="co-area"
            [required]="true"
            [hint]="t('provisioning.dataAreaIdHint')"
            [error]="dataAreaError()"
          >
            <input
              uiInput
              id="co-area"
              formControlName="dataAreaId"
              spellcheck="false"
              [attr.placeholder]="t('provisioning.dataAreaIdPlaceholder')"
              class="font-mono"
              [invalid]="!!dataAreaError()"
            />
          </ui-field>

          <div class="flex items-center gap-2">
            <button uiButton size="sm" type="submit" [loading]="saving()">
              {{ t("provisioning.createCompany") }}
            </button>
            <button uiButton variant="ghost" size="sm" type="button" [disabled]="saving()" (click)="close()">
              {{ t("common.cancel") }}
            </button>
          </div>
        </form>
      } @else {
        <div class="flex flex-wrap items-center gap-2">
          <button uiButton variant="outline" size="sm" type="button" (click)="openEnvironment()">
            <ui-icon name="plus" [size]="14" />
            {{ t("provisioning.addEnvironment") }}
          </button>

          <!--
            Absent, not disabled, until there is somewhere to put a company.
            A disabled control invites a click and explains nothing.
          -->
          @if (environments().length > 0) {
            <button uiButton variant="outline" size="sm" type="button" (click)="openCompany()">
              <ui-icon name="plus" [size]="14" />
              {{ t("provisioning.addCompany") }}
            </button>
          }
        </div>
      }
    </div>
  `
})
export class TenantProvisioningComponent {
  readonly tenant = input.required<TenantDetail>();

  /** Emits the tenant as the server returned it, so the page re-renders from it. */
  readonly changed = output<TenantDetail>();

  private readonly platform = inject(PlatformService);
  private readonly toasts = inject(ToastService);
  private readonly builder = inject(FormBuilder);

  protected readonly t = injectT();
  protected readonly KINDS = ENVIRONMENT_KINDS;

  protected readonly openForm = signal<"environment" | "company" | null>(null);
  protected readonly saving = signal(false);
  protected readonly failure = signal<string | null>(null);

  protected readonly environments = computed(() => this.tenant().environments);

  protected readonly environmentForm = this.builder.nonNullable.group({
    name: ["", [Validators.required]],
    url: ["", [Validators.required, Validators.pattern(HTTPS_URL)]],
    kind: ["sandbox"]
  });

  protected readonly companyForm = this.builder.nonNullable.group({
    environmentId: ["", [Validators.required]],
    name: ["", [Validators.required]],
    dataAreaId: ["", [Validators.required, Validators.pattern(DATA_AREA_ID)]]
  });

  /**
   * `https://` is a refusal, not a preference.
   *
   * Every ERP access token this environment is later used to obtain is sent to
   * this host, so a cleartext target is a disclosure. The API refuses it too —
   * this exists so the operator is told before the request rather than after.
   */
  protected urlError(): string | null {
    const field = this.environmentForm.controls.url;
    if (!field.touched || field.valid) return null;
    return this.t("provisioning.urlInvalid");
  }

  protected dataAreaError(): string | null {
    const field = this.companyForm.controls.dataAreaId;
    if (!field.touched || field.valid) return null;
    return this.t("provisioning.dataAreaIdInvalid");
  }

  protected openEnvironment(): void {
    this.environmentForm.reset({ name: "", url: "", kind: "sandbox" });
    this.failure.set(null);
    this.openForm.set("environment");
  }

  protected openCompany(): void {
    this.companyForm.reset({
      // Pre-selected, so the common case — one environment — needs no choice.
      environmentId: this.environments()[0]?.id ?? "",
      name: "",
      dataAreaId: ""
    });
    this.failure.set(null);
    this.openForm.set("company");
  }

  protected close(): void {
    this.openForm.set(null);
    this.failure.set(null);
  }

  protected saveEnvironment(): void {
    if (this.environmentForm.invalid) {
      this.environmentForm.markAllAsTouched();
      return;
    }

    const { name, url, kind } = this.environmentForm.getRawValue();
    this.saving.set(true);
    this.failure.set(null);

    this.platform.createEnvironment(this.tenant().id, { name, url, kind }).subscribe({
      next: (tenant) => this.settle(tenant, "provisioning.environmentCreated"),
      error: (error: unknown) => this.fail(error, "provisioning.environmentFailed")
    });
  }

  protected saveCompany(): void {
    if (this.companyForm.invalid) {
      this.companyForm.markAllAsTouched();
      return;
    }

    const { environmentId, name, dataAreaId } = this.companyForm.getRawValue();
    this.saving.set(true);
    this.failure.set(null);

    this.platform
      .createCompany(this.tenant().id, { environmentId, name, dataAreaId })
      .subscribe({
        next: (tenant) => this.settle(tenant, "provisioning.companyCreated"),
        error: (error: unknown) => this.fail(error, "provisioning.companyFailed")
      });
  }

  private settle(tenant: TenantDetail, message: "provisioning.environmentCreated" | "provisioning.companyCreated"): void {
    this.saving.set(false);
    this.openForm.set(null);
    this.changed.emit(tenant);
    this.toasts.success(this.t(message));
  }

  private fail(
    error: unknown,
    fallback: "provisioning.environmentFailed" | "provisioning.companyFailed"
  ): void {
    this.saving.set(false);
    // The form keeps what was typed, so a retry is not a re-type.
    this.failure.set(describeError(error, this.t, fallback));
  }
}
