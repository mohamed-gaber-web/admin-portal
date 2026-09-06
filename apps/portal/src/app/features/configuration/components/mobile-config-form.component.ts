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
import type { MobileConfig } from "@growpath/contracts";
import {
  AlertComponent,
  ButtonComponent,
  FieldComponent,
  InputDirective
} from "@shared/ui";
import { ConfigurationService } from "../configuration.service";

/** Absolute https, matching what `saveMobileConfigSchema` will accept. */
const HTTPS_URL = /^https:\/\/[^\s]+$/;

/**
 * What devices download at launch (US-040).
 *
 * This replaced the `environment.ts` bundled into the mobile app, so one binary
 * serves every tenant. That is the reason `apiBaseUrl` is the most consequential
 * field on this screen: it redirects every device in the field to whatever it
 * names, and a typo that happens to resolve is the worst outcome available here.
 * `http://` is refused outright — an access token on a cleartext hop is an
 * access token that has been disclosed.
 *
 * ### What is deliberately absent
 *
 * There is no D365 client secret here and there must never be one. That
 * credential is a confidential client with unrestricted application access to
 * the ERP; it lives on the server, is configured on the connection card above,
 * and the API calls D365 on the device's behalf. Putting it in a response the
 * same devices download would relocate the problem rather than fix it — a secret
 * shipped in a bundle and a secret fetched over TLS by anybody who knows a slug
 * are equally extractable.
 *
 * ### Read-only without `tenant.write`
 *
 * A viewer reads every field and submits none of them — the controls are
 * disabled and the button is gone. Disabled rather than hidden for the same
 * reason as the connection card: what this screen *says* is the useful half for
 * somebody who is not allowed to change it, and `apiBaseUrl` in particular is
 * the answer to "where are the devices pointed", which is a support question
 * long before it is an editing one.
 *
 * `userAuth` **is** here and belongs here: a public client holds no secret by
 * definition, and the app cannot begin an interactive sign-in without it.
 * Clearing the block is what a tenant past the portal-native cutover looks like,
 * so it is a deliberate action rather than four fields somebody blanks by hand.
 */
@Component({
  selector: "app-mobile-config-form",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    AlertComponent,
    ButtonComponent,
    FieldComponent,
    InputDirective
  ],
  host: { class: "block" },
  template: `
    <form [formGroup]="form" class="space-y-5" (ngSubmit)="save()">
      <!--
        First-time setup is the normal way to arrive here for a new tenant, so
        it gets an explanation rather than an error. The API answers 404 until
        this is saved once; the save itself is an upsert, so there is no
        separate "create" call to make.
      -->
      @if (!config()) {
        <ui-alert tone="info" [title]="t('mobileConfig.notConfiguredTitle')">
          {{ t("mobileConfig.notConfiguredBody") }}
        </ui-alert>
      }

      <ui-field
        [label]="t('mobileConfig.apiBaseUrl')"
        controlId="mobile-api-base-url"
        [hint]="t('mobileConfig.apiBaseUrlHint')"
        [required]="true"
        [error]="errorFor('apiBaseUrl')"
      >
        <input
          uiInput
          id="mobile-api-base-url"
          dir="ltr"
          type="url"
          class="!font-mono !text-xs"
          formControlName="apiBaseUrl"
          spellcheck="false"
          [invalid]="!!errorFor('apiBaseUrl')"
        />
      </ui-field>

      <ui-field
        [label]="t('mobileConfig.minimumAppVersion')"
        controlId="mobile-minimum-version"
        [hint]="t('mobileConfig.minimumAppVersionHint')"
      >
        <input
          uiInput
          id="mobile-minimum-version"
          dir="ltr"
          class="!font-mono !text-xs"
          formControlName="minimumAppVersion"
          placeholder="2.0.0"
          spellcheck="false"
        />
      </ui-field>

      <!-- Entra sign-in -->
      <div class="space-y-4 rounded-xl border border-border p-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="text-sm font-semibold text-foreground">
              {{ t("mobileConfig.userAuthTitle") }}
            </p>
            <p class="mt-0.5 text-xs leading-relaxed text-foreground-muted">
              {{ t("mobileConfig.userAuthSubtitle") }}
            </p>
          </div>
          <label class="flex shrink-0 items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              class="h-4 w-4 accent-primary"
              [checked]="entraEnabled()"
              [disabled]="readOnly()"
              (change)="toggleEntra()"
            />
            {{ t("mobileConfig.userAuthEnabled") }}
          </label>
        </div>

        @if (entraEnabled()) {
          <div class="grid gap-4 sm:grid-cols-2">
            <ui-field
              [label]="t('mobileConfig.clientId')"
              controlId="mobile-client-id"
              [hint]="t('mobileConfig.clientIdHint')"
              [required]="true"
              [error]="errorFor('clientId')"
            >
              <input
                uiInput
                id="mobile-client-id"
                dir="ltr"
                class="!font-mono !text-xs"
                formControlName="clientId"
                autocomplete="off"
                spellcheck="false"
                [invalid]="!!errorFor('clientId')"
              />
            </ui-field>

            <ui-field
              [label]="t('mobileConfig.authority')"
              controlId="mobile-authority"
              [required]="true"
              [error]="errorFor('authority')"
            >
              <input
                uiInput
                id="mobile-authority"
                dir="ltr"
                class="!font-mono !text-xs"
                formControlName="authority"
                spellcheck="false"
                [invalid]="!!errorFor('authority')"
              />
            </ui-field>

            <ui-field
              [label]="t('mobileConfig.redirectUri')"
              controlId="mobile-redirect-uri"
              [required]="true"
              [error]="errorFor('redirectUri')"
            >
              <input
                uiInput
                id="mobile-redirect-uri"
                dir="ltr"
                class="!font-mono !text-xs"
                formControlName="redirectUri"
                spellcheck="false"
                [invalid]="!!errorFor('redirectUri')"
              />
            </ui-field>

            <ui-field
              [label]="t('mobileConfig.scopes')"
              controlId="mobile-scopes"
              [hint]="t('mobileConfig.scopesHint')"
            >
              <input
                uiInput
                id="mobile-scopes"
                dir="ltr"
                class="!font-mono !text-xs"
                formControlName="scopes"
                spellcheck="false"
              />
            </ui-field>
          </div>
        } @else {
          <!--
            Not an empty form with the fields hidden. "This tenant does not use
            Entra sign-in" and "it is configured with blanks" are different
            states, and only one of them is a misconfiguration — the contract
            models the difference as null rather than an empty object, and the
            screen has to as well.
          -->
          <ui-alert tone="info">{{ t("mobileConfig.userAuthCleared") }}</ui-alert>
        }
      </div>

      <div class="flex flex-wrap items-center gap-3">
        @if (!readOnly()) {
          <button uiButton type="submit" [loading]="saving()">
            {{ config() ? t("mobileConfig.save") : t("mobileConfig.create") }}
          </button>
        }
        @if (config()?.updatedAt; as updatedAt) {
          <span class="text-xs text-foreground-subtle">
            {{ t("mobileConfig.updatedAt", { date: i18n.formatDate(updatedAt) }) }}
          </span>
        }
      </div>
    </form>
  `
})
export class MobileConfigFormComponent {
  /**
   * Null for a tenant that has never configured one.
   *
   * The form is the same either way — the API's `PUT` upserts, so there is no
   * separate create path to model. What changes is the explanation above it and
   * the label on the button.
   */
  readonly config = input.required<MobileConfig | null>();

  /**
   * True for a session without `tenant.write`.
   *
   * An input rather than a session lookup here, so the page makes the decision
   * once and the form stays renderable both ways without a store.
   */
  readonly readOnly = input(false);

  /** Emits the configuration as the server now holds it. */
  readonly changed = output<MobileConfig>();

  private readonly configuration = inject(ConfigurationService);
  private readonly toasts = inject(ToastService);

  protected readonly t = injectT();
  protected readonly i18n = inject(I18nService);

  protected readonly saving = signal(false);
  protected readonly entraEnabled = signal(false);

  protected readonly form = inject(FormBuilder).nonNullable.group({
    apiBaseUrl: ["", [Validators.required, Validators.pattern(HTTPS_URL)]],
    minimumAppVersion: [""],
    clientId: [""],
    authority: [""],
    redirectUri: [""],
    scopes: [""]
  });

  constructor() {
    effect(
      () => {
        const config = this.config();

        // Entra on by default for a brand-new configuration: a tenant that has
        // not cut over to portal sign-in is the common starting point, and it
        // is the state with fields to fill in. Turning it off is one click and
        // is the deliberate act it should be.
        this.entraEnabled.set(config ? config.userAuth !== null : true);

        this.form.patchValue({
          apiBaseUrl: config?.apiBaseUrl ?? "",
          minimumAppVersion: config?.minimumAppVersion ?? "",
          clientId: config?.userAuth?.clientId ?? "",
          authority: config?.userAuth?.authority ?? "",
          redirectUri: config?.userAuth?.redirectUri ?? "",
          // Comma-separated, because a scope list is short and typing one is
          // faster than managing chips. Split on save.
          scopes: config?.userAuth?.scopes.join(", ") ?? ""
        });

        // One template, disabled — not a second read-only rendering that could
        // drift from the fields it mirrors.
        if (this.readOnly()) this.form.disable({ emitEvent: false });
        else this.form.enable({ emitEvent: false });
      },
      { allowSignalWrites: true }
    );
  }

  protected toggleEntra(): void {
    if (this.readOnly()) return;
    this.entraEnabled.set(!this.entraEnabled());
  }

  protected errorFor(control: keyof typeof this.form.controls): string | null {
    const field = this.form.controls[control];
    if (!field.touched || field.valid) return null;
    if (control === "apiBaseUrl" && field.hasError("pattern")) {
      return this.t("mobileConfig.apiBaseUrlInvalid");
    }
    return this.t("common.required");
  }

  protected save(): void {
    // Unreachable through the UI for a viewer — the button is not rendered —
    // and refused by the API regardless. This keeps a stray submit from
    // producing a failure toast for something that was never offered.
    if (this.readOnly()) return;

    // The three Entra fields are required together or not at all — the schema
    // and a database check constraint both say so, because a client id with no
    // authority produces a sign-in attempt against nothing and the app cannot
    // report that usefully.
    const entra = this.entraEnabled();
    for (const key of ["clientId", "authority", "redirectUri"] as const) {
      const control = this.form.controls[key];
      control.setValidators(entra ? [Validators.required] : []);
      control.updateValueAndValidity({ emitEvent: false });
    }

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const value = this.form.getRawValue();
    this.saving.set(true);

    this.configuration
      .saveMobileConfig({
        apiBaseUrl: value.apiBaseUrl.trim(),
        minimumAppVersion: value.minimumAppVersion.trim() || null,
        userAuth: entra
          ? {
              clientId: value.clientId.trim(),
              authority: value.authority.trim(),
              redirectUri: value.redirectUri.trim(),
              scopes: value.scopes
                .split(",")
                .map((scope) => scope.trim())
                .filter(Boolean)
            }
          : null
      })
      .subscribe({
        next: (updated) => {
          this.saving.set(false);
          this.changed.emit(updated);
          this.toasts.success(this.t("mobileConfig.saved"));
        },
        error: (error: unknown) => {
          this.saving.set(false);
          this.toasts.error(describeError(error, this.t, "mobileConfig.failed"));
        }
      });
  }
}
