import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal
} from "@angular/core";
import { FormBuilder, ReactiveFormsModule, Validators } from "@angular/forms";
import { ApiError, describeError } from "@core/http/api-error";
import { I18nService, injectT } from "@core/i18n/i18n.service";
import type { MessageKey } from "@core/i18n/messages/en";
import { ToastService } from "@core/notifications/toast.service";
import {
  AUTHORITY_HOSTS,
  CONNECTION_ERRORS,
  secretNeedsAttention,
  type AuthorityHost,
  type Connection,
  type ConnectionError,
  type ConnectionTestResult
} from "@growpath/contracts";
import {
  AlertComponent,
  BadgeComponent,
  ButtonComponent,
  FieldComponent,
  IconComponent,
  InputDirective,
  type BadgeTone
} from "@shared/ui";
import { ConfigurationService } from "../configuration.service";

/** A GUID, matching what the contract's `.uuid()` will accept. */
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * One D365 environment's credential (US-065).
 *
 * ### The secret is write-only, and the form is shaped around that
 *
 * Nothing can display the stored client secret — the API seals it and
 * `connectionSchema` has no field it could occupy, which is US-045's whole
 * point. So the input is always empty, and leaving it empty means *keep what is
 * stored*. Prefilling it with dots would be a lie the user then has to guess
 * the meaning of; requiring it on every edit would force somebody correcting an
 * expiry date to re-type a credential they may not have, and the predictable
 * result of that is a placeholder typed in to get past validation — a working
 * connection broken by its own form.
 *
 * The one exception is a connection that has never been configured, where there
 * is nothing to keep. The field is required then, and the hint says why.
 *
 * ### Read-only for anybody without `connection.write`
 *
 * A `viewer` sees the whole card — the environment, its state, when it was last
 * checked, how long the secret has left — and can submit none of it. The fields
 * are disabled rather than hidden, because the values *are* the information
 * this screen exists to give: hiding them would leave a read-only user unable
 * to answer "which Entra tenant are we pointed at", which is the most common
 * reason to open this page at all.
 *
 * The API refuses the same requests independently (`connection.write` on the
 * save and on the test), so this is what spares somebody a form that could only
 * end in a 403 — not the thing that stops them.
 *
 * ### Saving runs a real check
 *
 * The API tests the credential against Entra and persists only if it passes, so
 * a rejected save has written nothing. The failure comes back as one of five
 * codes rather than the identity provider's own prose — that text carries
 * correlation ids and the client id, and changes without notice.
 */
@Component({
  selector: "app-connection-card",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    AlertComponent,
    BadgeComponent,
    ButtonComponent,
    FieldComponent,
    IconComponent,
    InputDirective
  ],
  host: { class: "block" },
  template: `
    <div class="rounded-xl border border-border">
      <!-- Identity -->
      <div class="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
        <div class="min-w-0 space-y-1">
          <div class="flex flex-wrap items-center gap-2">
            <span
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-foreground-muted"
            >
              <ui-icon name="database" [size]="14" />
            </span>
            <p class="truncate text-sm font-semibold text-foreground">
              {{ connection().environmentName }}
            </p>
            <ui-badge
              [tone]="connection().environmentKind === 'production' ? 'primary' : 'neutral'"
            >
              {{ t(KIND_LABELS[connection().environmentKind]) }}
            </ui-badge>
          </div>
          <p dir="ltr" class="truncate font-mono text-xs text-foreground-subtle">
            {{ connection().url }}
          </p>
        </div>

        <div class="flex items-center gap-2">
          <ui-badge [tone]="STATE_TONES[connection().state]" [dot]="true">
            {{ t(STATE_LABELS[connection().state]) }}
          </ui-badge>
          @if (!readOnly()) {
            <!--
              Absent rather than disabled for a viewer. A test spends a live
              credential and records its outcome, so it is a write — and a
              greyed-out button here would read as "temporarily unavailable"
              rather than "not yours to run".
            -->
            <button
              uiButton
              variant="outline"
              size="sm"
              type="button"
              [loading]="testing()"
              (click)="test()"
            >
              <ui-icon name="refresh" [size]="15" />
              {{ t("connections.test") }}
            </button>
          }
        </div>
      </div>

      <div class="space-y-4 p-4">
        <!--
          The last check, with its age. A state with no timestamp is not
          evidence: "connected" from three weeks ago and "connected" from a
          minute ago are different claims, and a secret can expire in between.
        -->
        @if (connection().checkedAt; as checkedAt) {
          <p class="flex items-center gap-1.5 text-xs text-foreground-subtle">
            <ui-icon name="calendar" [size]="13" />
            {{ t("connections.lastChecked", { date: i18n.formatDate(checkedAt, DATE_TIME) }) }}
          </p>
        }

        @if (lastError(); as error) {
          <ui-alert tone="danger" [title]="t('connections.testFailed')">
            {{ t(ERROR_LABELS[error]) }}
          </ui-alert>
        }

        <!--
          Expiry, warned about 30 days ahead — the same threshold the API uses,
          shared as a constant so the badge and the alerting cannot disagree
          about when a secret becomes urgent (US-044).
        -->
        @if (secretUrgent()) {
          <ui-alert [tone]="secretExpired() ? 'danger' : 'warning'">
            {{
              secretExpired()
                ? t("connections.secretExpired")
                : t("connections.secretExpiring", { days: daysUntilExpiry() })
            }}
          </ui-alert>
        }

        <form [formGroup]="form" class="space-y-4" (ngSubmit)="save()">
          <div class="grid gap-4 sm:grid-cols-2">
            <ui-field
              [label]="t('connections.entraTenantId')"
              [controlId]="'entra-tenant-' + connection().environmentId"
              [hint]="t('connections.entraTenantIdHint')"
              [required]="true"
              [error]="errorFor('entraTenantId')"
            >
              <input
                uiInput
                dir="ltr"
                class="!font-mono !text-xs"
                [id]="'entra-tenant-' + connection().environmentId"
                formControlName="entraTenantId"
                autocomplete="off"
                spellcheck="false"
                [invalid]="!!errorFor('entraTenantId')"
              />
            </ui-field>

            <ui-field
              [label]="t('connections.clientId')"
              [controlId]="'client-id-' + connection().environmentId"
              [hint]="t('connections.clientIdHint')"
              [required]="true"
              [error]="errorFor('clientId')"
            >
              <input
                uiInput
                dir="ltr"
                class="!font-mono !text-xs"
                [id]="'client-id-' + connection().environmentId"
                formControlName="clientId"
                autocomplete="off"
                spellcheck="false"
                [invalid]="!!errorFor('clientId')"
              />
            </ui-field>
          </div>

          @if (readOnly()) {
            <!--
              A stored secret cannot be displayed, so on a read-only card an
              empty password box would read as "no secret configured" — which is
              a different and often untrue statement. Say which it is instead.
            -->
            <p class="text-xs text-foreground-subtle">
              {{
                connection().hasClientSecret
                  ? t("connections.clientSecretStored")
                  : t("connections.clientSecretMissing")
              }}
            </p>
          } @else {
            <ui-field
              [label]="t('connections.clientSecret')"
              [controlId]="'client-secret-' + connection().environmentId"
              [hint]="
                connection().hasClientSecret
                  ? t('connections.clientSecretKeepHint')
                  : t('connections.clientSecretFirstHint')
              "
              [required]="!connection().hasClientSecret"
              [error]="errorFor('clientSecret')"
            >
              <input
                uiInput
                type="password"
                dir="ltr"
                [id]="'client-secret-' + connection().environmentId"
                formControlName="clientSecret"
                autocomplete="new-password"
                [invalid]="!!errorFor('clientSecret')"
              />
            </ui-field>
          }

          <div class="grid gap-4 sm:grid-cols-2">
            <ui-field
              [label]="t('connections.authorityHost')"
              [controlId]="'authority-' + connection().environmentId"
              [hint]="t('connections.authorityHostHint')"
            >
              <select
                uiInput
                dir="ltr"
                class="!font-mono !text-xs"
                [id]="'authority-' + connection().environmentId"
                formControlName="authorityHost"
              >
                @for (host of AUTHORITY_HOSTS; track host) {
                  <option [value]="host">{{ host }}</option>
                }
              </select>
            </ui-field>

            <ui-field
              [label]="t('connections.secretExpiresAt')"
              [controlId]="'expires-' + connection().environmentId"
              [hint]="t('connections.secretExpiresAtHint')"
            >
              <input
                uiInput
                type="date"
                [id]="'expires-' + connection().environmentId"
                formControlName="clientSecretExpiresAt"
              />
            </ui-field>
          </div>

          <!--
            The request the server will actually make, spelled out. Derived
            server-side and returned rather than assembled here, so an
            administrator can confirm it instead of inferring it from three
            fields — and so this cannot drift from what the API does.
          -->
          @if (connection().tokenUrl; as tokenUrl) {
            <dl class="space-y-1 rounded-lg bg-surface-muted p-3 text-xs">
              <div class="flex flex-wrap gap-2">
                <dt class="text-foreground-subtle">{{ t("connections.tokenUrl") }}</dt>
                <dd dir="ltr" class="min-w-0 break-all font-mono text-foreground-muted">
                  {{ tokenUrl }}
                </dd>
              </div>
              <div class="flex flex-wrap gap-2">
                <dt class="text-foreground-subtle">{{ t("connections.scope") }}</dt>
                <dd dir="ltr" class="min-w-0 break-all font-mono text-foreground-muted">
                  {{ connection().scope }}
                </dd>
              </div>
            </dl>
          }

          @if (!readOnly()) {
            <div class="flex items-center gap-2">
              <button uiButton size="sm" type="submit" [loading]="saving()">
                {{ t("connections.save") }}
              </button>
              <span class="text-xs text-foreground-subtle">
                {{ t("connections.saveHint") }}
              </span>
            </div>
          }
        </form>
      </div>
    </div>
  `
})
export class ConnectionCardComponent {
  readonly connection = input.required<Connection>();

  /**
   * True for a session without `connection.write`.
   *
   * Passed in rather than read from the session here, so the page decides once
   * what the whole screen is and every card on it agrees — and so this stays a
   * component that can be rendered either way in a test.
   */
  readonly readOnly = input(false);

  /** Emits the connection as the server now holds it. */
  readonly changed = output<Connection>();

  private readonly configuration = inject(ConfigurationService);
  private readonly toasts = inject(ToastService);

  protected readonly t = injectT();
  protected readonly i18n = inject(I18nService);
  protected readonly AUTHORITY_HOSTS = AUTHORITY_HOSTS;

  /**
   * A check's age needs the clock, not just the day.
   *
   * "Checked 4 March" and "checked 4 March at 09:12" answer different
   * questions, and on this card the question is "is this evidence current".
   */
  protected readonly DATE_TIME: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  };

  protected readonly saving = signal(false);
  protected readonly testing = signal(false);

  /**
   * The most recent failure reason, from a test or a refused save.
   *
   * Seeded from the stored connection so a failure recorded before this page
   * loaded is still visible — the state badge alone says "failing" without
   * saying why, and the why is the actionable half.
   */
  protected readonly lastError = signal<ConnectionError | null>(null);

  protected readonly form = inject(FormBuilder).nonNullable.group({
    entraTenantId: ["", [Validators.required, Validators.pattern(GUID)]],
    clientId: ["", [Validators.required, Validators.pattern(GUID)]],
    clientSecret: [""],
    authorityHost: ["login.microsoftonline.com" as AuthorityHost],
    clientSecretExpiresAt: [""]
  });

  protected readonly secretExpired = computed(() => {
    const days = this.connection().daysUntilSecretExpiry;
    return days !== null && days <= 0;
  });

  protected readonly secretUrgent = computed(() =>
    secretNeedsAttention(this.connection().daysUntilSecretExpiry)
  );

  /**
   * Days remaining, as a number the message interpolation can take.
   *
   * Only read behind `secretUrgent()`, which is false when the field is null —
   * but the template cannot narrow across two signals, and defaulting to 0 in
   * the type is honest: an unknown expiry is not an expiry in the future.
   */
  protected readonly daysUntilExpiry = computed(
    () => this.connection().daysUntilSecretExpiry ?? 0
  );

  protected readonly KIND_LABELS: Record<string, MessageKey> = {
    production: "environmentKind.production",
    sandbox: "environmentKind.sandbox"
  };

  protected readonly STATE_LABELS: Record<string, MessageKey> = {
    connected: "connection.connected",
    failing: "connection.failing",
    not_configured: "connection.not_configured"
  };

  protected readonly STATE_TONES: Record<string, BadgeTone> = {
    connected: "success",
    failing: "danger",
    not_configured: "neutral"
  };

  protected readonly ERROR_LABELS: Record<ConnectionError, MessageKey> = {
    invalid_client: "connections.error.invalid_client",
    invalid_tenant: "connections.error.invalid_tenant",
    invalid_scope: "connections.error.invalid_scope",
    unreachable: "connections.error.unreachable",
    unexpected: "connections.error.unexpected"
  };

  constructor() {
    effect(
      () => {
        const connection = this.connection();
        this.form.patchValue({
          entraTenantId: connection.entraTenantId ?? "",
          clientId: connection.clientId ?? "",
          // Always empty. There is nothing to prefill it with, and a row of dots
          // standing in for a value nobody can read is a lie about what happens
          // when you submit.
          clientSecret: "",
          authorityHost: connection.authorityHost,
          clientSecretExpiresAt: connection.clientSecretExpiresAt
            ? connection.clientSecretExpiresAt.slice(0, 10)
            : ""
        });
        this.lastError.set(connection.error);

        // Disabled controls rather than a second read-only template. One
        // template means the values a viewer reads are literally the ones an
        // administrator edits, and there is no second copy to fall behind.
        if (this.readOnly()) this.form.disable({ emitEvent: false });
        else this.form.enable({ emitEvent: false });
      },
      { allowSignalWrites: true }
    );
  }

  protected errorFor(control: keyof typeof this.form.controls): string | null {
    const field = this.form.controls[control];
    if (!field.touched || field.valid) return null;
    if (control === "clientSecret") return this.t("connections.secretRequired");
    return field.hasError("required")
      ? this.t("common.required")
      : this.t("connections.guidInvalid");
  }

  protected save(): void {
    // The button is not rendered for a viewer, so reaching this is a bug rather
    // than an attack — the API refuses the request either way. Returning early
    // keeps a stray submit (an Enter key in a disabled-looking form) from
    // producing a toast that says the save failed.
    if (this.readOnly()) return;

    const first = !this.connection().hasClientSecret;
    const secret = this.form.controls.clientSecret;

    // Required only when there is no stored secret to keep. Applied here rather
    // than as a static validator because it depends on the connection, and a
    // validator that reads an input would have to be rebuilt whenever it changed.
    secret.setValidators(first ? [Validators.required] : []);
    secret.updateValueAndValidity({ emitEvent: false });

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const value = this.form.getRawValue();
    this.saving.set(true);
    this.lastError.set(null);

    this.configuration
      .saveConnection(this.connection().environmentId, {
        entraTenantId: value.entraTenantId.trim(),
        clientId: value.clientId.trim(),
        authorityHost: value.authorityHost,
        // Omitted rather than sent empty: an empty string would be a request to
        // store an empty secret, and the contract would refuse it.
        ...(value.clientSecret ? { clientSecret: value.clientSecret } : {}),
        // Sent as an instant, since the contract takes a datetime and the input
        // gives a date. End of day, so "expires on the 4th" means the 4th is
        // still usable.
        clientSecretExpiresAt: value.clientSecretExpiresAt
          ? new Date(`${value.clientSecretExpiresAt}T23:59:59.000Z`).toISOString()
          : null
      })
      .subscribe({
        next: (updated) => {
          this.saving.set(false);
          this.changed.emit(updated);
          this.toasts.success(
            this.t("connections.saved", { name: updated.environmentName })
          );
        },
        error: (error: unknown) => {
          this.saving.set(false);
          // A 422 means the credential was rejected and nothing was written —
          // worth saying explicitly, because "save failed" would leave somebody
          // wondering whether half of it landed.
          this.lastError.set(errorCodeFrom(error));
          this.toasts.error(describeError(error, this.t, "connections.saveFailed"));
        }
      });
  }

  protected test(): void {
    if (this.readOnly()) return;

    this.testing.set(true);
    this.lastError.set(null);

    this.configuration.testConnection(this.connection().environmentId).subscribe({
      next: (result: ConnectionTestResult) => {
        this.testing.set(false);
        this.lastError.set(result.error);

        // The card's own badge comes from `connection()`, which the page owns.
        // Emitting the merged state keeps the badge and this result in step
        // without a refetch that would flash the whole list.
        this.changed.emit({
          ...this.connection(),
          state: result.state,
          error: result.error,
          checkedAt: result.checkedAt
        });

        if (result.ok) {
          this.toasts.success(this.t("connections.testPassed"));
        } else {
          this.toasts.error(this.t("connections.testFailed"));
        }
      },
      error: (error: unknown) => {
        this.testing.set(false);
        this.toasts.error(describeError(error, this.t, "connections.testError"));
      }
    });
  }
}

/**
 * Pulls the reason code out of a refused save.
 *
 * The API puts it on the 422 body alongside the message. Read defensively —
 * anything unrecognised becomes null rather than being rendered as a
 * translation key that does not exist.
 */
function errorCodeFrom(error: unknown): ConnectionError | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body;
  if (!body || typeof body !== "object") return null;

  const code = (body as { error?: unknown }).error;
  const known: readonly string[] = CONNECTION_ERRORS;
  return typeof code === "string" && known.includes(code) ? (code as ConnectionError) : null;
}
