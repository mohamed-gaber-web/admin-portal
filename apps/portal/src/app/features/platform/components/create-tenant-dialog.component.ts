import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal
} from "@angular/core";
import { FormBuilder, ReactiveFormsModule, Validators } from "@angular/forms";
import {
  DEFAULT_TENANT_PLAN,
  isModuleKey,
  type ModuleKey,
  type ProvisionedTenant
} from "@growpath/contracts";
import { describeError } from "@core/http/api-error";
import { I18nService, injectT } from "@core/i18n/i18n.service";
import { ToastService } from "@core/notifications/toast.service";
import {
  AlertComponent,
  ButtonComponent,
  FieldComponent,
  IconComponent,
  InputDirective,
  ModalComponent,
  SelectDirective
} from "@shared/ui";
import {
  CATALOGUE_AS_PICKABLE,
  ModulePickerComponent
} from "@shared/components/module-picker.component";
import { MODULE_LABEL_KEYS, TENANT_PLAN_LABEL_KEYS } from "@core/i18n/label-keys";
import { TENANT_PLANS, type TenantPlan } from "@core/models";
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
    ModalComponent,
    ModulePickerComponent,
    SelectDirective
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
          <!--
            Modules that were ticked and did not come back.

            The API returns what it actually granted, which is the intersection
            of the request and the module table. They differ when the portal
            is deployed ahead of the migration that installs a key: every key
            passes validation, none of the new ones match a row, and the tenant
            is created holding nothing. Without this the operator sees an
            ordinary success dialog, and finds out weeks later.
          -->
          @if (droppedModules(); as dropped) {
            <ui-alert tone="warning" [title]="t('createTenant.modulesDroppedTitle')">
              {{ t("createTenant.modulesDroppedBody", { modules: dropped }) }}
            </ui-alert>
          }

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

          <!--
            The package, and so the seat allowance the tenant starts with.

            A select rather than the radio group the subscription card uses:
            that card is a screen whose whole subject is the package, and this is
            one field among four on a create form. The seat count rides in the
            option text because it is the thing that actually distinguishes the
            choices — "Growth" means nothing without "25 users" beside it.

            Falls back to the plain labels until the catalogue loads, so the
            field is usable immediately and never shows a package that appears
            to include no users.
          -->
          <ui-field
            [label]="t('createTenant.plan')"
            controlId="tenant-plan"
            [hint]="t('createTenant.planHint')"
          >
            <select uiSelect id="tenant-plan" formControlName="plan">
              @for (plan of PLANS; track plan) {
                <option [value]="plan">{{ optionLabel(plan) }}</option>
              }
            </select>
          </ui-field>

          <ui-field
            [label]="t('createTenant.adminEmail')"
            controlId="tenant-admin"
            [hint]="t('createTenant.adminEmailHint')"
          >
            <input uiInput id="tenant-admin" type="email" formControlName="adminEmail" />
          </ui-field>

          <!--
            Which modules the customer has bought.

            Here rather than on the profile screen afterwards because
            provisioning issues the first admin invitation as its last act: a
            tenant created with nothing granted is one whose administrator can
            accept that invitation and sign in to an empty mobile sidebar before
            an operator has reached the second screen.

            Starts empty rather than fully ticked. A default of everything would
            make the careless path the generous one, and entitlements are what
            stop a customer using what nobody sold them.
          -->
          <div class="space-y-2 border-t border-border pt-4">
            <div>
              <p class="text-sm font-medium text-foreground">{{ t("createTenant.modules") }}</p>
              <p class="mt-0.5 text-xs text-foreground-muted">
                {{ t("createTenant.modulesHint") }}
              </p>
            </div>

            <app-module-picker [modules]="CATALOGUE" [(selected)]="modules" />
          </div>
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
    /**
     * Pre-selected to the same package the database would have applied.
     *
     * So the form states the default rather than leaving it implicit: an
     * operator who does not touch this field gets exactly what they would have
     * got before it existed, and one who does can see what they are changing
     * from.
     */
    plan: [DEFAULT_TENANT_PLAN as TenantPlan],
    adminEmail: [""]
  });

  protected readonly PLANS = TENANT_PLANS;

  /**
   * The catalogue, from the contracts package rather than from a fetch.
   *
   * There is no tenant yet, so `GET /platform/tenants/:id/modules` — the call
   * the profile screen makes — has no id to be given. The compile-time list is
   * the same thirteen keys in the same order, and the labels both screens render
   * come from the i18n catalogue either way.
   */
  protected readonly CATALOGUE = CATALOGUE_AS_PICKABLE;

  /**
   * The chosen modules.
   *
   * A signal beside the form rather than a control inside it. The reactive form
   * holds four scalars that each map to one input; a set of keys edited by a
   * child component through a two-way binding is not that shape, and modelling
   * it as a `FormControl<string[]>` would buy validation nothing has a rule for
   * and dirty-tracking this dialog does not use.
   */
  protected readonly modules = signal<readonly string[]>([]);

  /**
   * What the last submit asked for, kept so the response can be checked
   * against it.
   *
   * Separate from `modules` because the picker is still editable in principle
   * and this has to be the set that was actually sent, not the set on screen.
   */
  private readonly requested = signal<readonly string[]>([]);

  /**
   * Modules that were requested and not granted, as a readable list — or null
   * when everything asked for came back.
   *
   * Labelled through the same i18n catalogue the picker uses, falling back to
   * the raw key: a key this build cannot name is precisely the case where the
   * portal and the database disagree, so the key itself is the useful thing to
   * show.
   */
  protected readonly droppedModules = computed(() => {
    const result = this.provisioned();
    if (!result) return null;

    const granted = new Set(result.modules);
    const dropped = this.requested().filter((key) => !granted.has(key));
    if (dropped.length === 0) return null;

    return dropped
      .map((key) => {
        const label = MODULE_LABEL_KEYS[key as ModuleKey];
        return label ? this.t(label) : key;
      })
      .join(this.t("common.listSeparator"));
  });

  /** Seats per package, once the catalogue arrives. Empty until then. */
  private readonly seats = signal<Map<string, number>>(new Map());

  constructor() {
    /*
     * Fetched so the options can say what each package includes. The failure
     * branch is deliberately silent: the labels still render, choosing a
     * package still works, and an operator creating a tenant does not need to
     * be told that an annotation could not be fetched.
     */
    this.platform.listPlans().subscribe({
      next: (plans) => this.seats.set(new Map(plans.map((plan) => [plan.key, plan.userLimit]))),
      error: () => this.seats.set(new Map())
    });
  }

  /** "Growth — 25 users", or just "Growth" while the catalogue is loading. */
  protected optionLabel(plan: string): string {
    const label = this.t(TENANT_PLAN_LABEL_KEYS[plan as TenantPlan]);
    const included = this.seats().get(plan);
    return included === undefined
      ? label
      : `${label} — ${this.t("createTenant.planSeats", { count: included })}`;
  }

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

    const { name, slug, plan, adminEmail } = this.form.getRawValue();
    // Narrowed to keys this build knows. The picker only offers catalogue keys,
    // so this filters nothing today — it is what keeps the request matching the
    // schema if the two ever diverge.
    const modules = this.modules().filter((key): key is ModuleKey => isModuleKey(key));

    this.requested.set(modules);
    this.submitting.set(true);

    this.platform
      // `adminEmail` is omitted rather than sent empty: the schema marks it
      // optional, and "" would fail its email check. `modules` is sent even when
      // empty, because an operator who ticked nothing has said something — and
      // the API distinguishes an absent list from a deliberate one only in what
      // it writes to the audit log.
      .createTenant({ name, slug, plan, modules, ...(adminEmail ? { adminEmail } : {}) })
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
