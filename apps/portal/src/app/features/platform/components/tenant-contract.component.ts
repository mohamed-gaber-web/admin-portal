import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal
} from "@angular/core";
import { FormBuilder, ReactiveFormsModule } from "@angular/forms";
import { describeError } from "@core/http/api-error";
import { I18nService, injectT } from "@core/i18n/i18n.service";
import { ToastService } from "@core/notifications/toast.service";
import type { TenantDetail } from "@core/models";
import {
  daysSinceExpiry,
  describeDuration,
  resolveContractPeriod,
  todayIso,
  type ContractState,
  type Duration
} from "@growpath/contracts";
import {
  AlertComponent,
  ButtonComponent,
  FieldComponent,
  IconComponent,
  InputDirective
} from "@shared/ui";
import { PlatformService } from "../platform.service";

/**
 * How each state paints. Tailwind classes rather than a colour, so the bar, the
 * dot and the heading cannot drift apart.
 */
const STATE_TONE: Record<ContractState, { bar: string; dot: string; text: string }> = {
  none: { bar: "bg-border-strong", dot: "bg-foreground-subtle", text: "text-foreground-muted" },
  upcoming: { bar: "bg-info", dot: "bg-info", text: "text-info" },
  active: { bar: "bg-success", dot: "bg-success", text: "text-success" },
  expiring: { bar: "bg-warning", dot: "bg-warning", text: "text-warning" },
  imminent: { bar: "bg-danger", dot: "bg-danger", text: "text-danger" },
  expired: { bar: "bg-danger", dot: "bg-danger", text: "text-danger" }
};

/**
 * The period a tenant's contract runs for.
 *
 * Three things on one card, because they are one question an operator asks —
 * "where is this customer up to": the dates they signed for, how much of that
 * term is left, and what that currently means for the account.
 *
 * ### The bar measures the term, not the month
 *
 * It fills from the start date to the end date, so "68% through" means 68% of
 * what the customer bought. A bar over the calendar month would reset on the
 * 1st and say nothing about the contract at all.
 *
 * It is deliberately absent when either date is missing: a bar drawn from an
 * unknown end is a bar that invents a number, and "no end date recorded" is
 * better said in words.
 *
 * ### Nothing here enforces anything
 *
 * An expired contract is shown loudly and changes nothing else. Users keep
 * signing in, modules keep working, and the account stays open — which is what
 * the explanation below the bar says in as many words, because an operator
 * seeing red needs to know whether the lockout already happened. Cutting a
 * customer off is a separate, harsher decision, and it has its own control on
 * the lifecycle card.
 */
@Component({
  selector: "app-tenant-contract",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    AlertComponent,
    ButtonComponent,
    FieldComponent,
    IconComponent,
    InputDirective
  ],
  template: `
    @if (editing()) {
      <form [formGroup]="form" class="space-y-4" (ngSubmit)="save()">
        @if (failure()) {
          <ui-alert tone="danger">{{ failure() }}</ui-alert>
        }

        <div class="grid gap-3 sm:grid-cols-2">
          <ui-field [label]="t('contract.startDate')" controlId="contract-start">
            <input uiInput id="contract-start" type="date" formControlName="startDate" />
          </ui-field>

          <ui-field
            [label]="t('contract.endDate')"
            controlId="contract-end"
            [error]="orderError()"
          >
            <input
              uiInput
              id="contract-end"
              type="date"
              formControlName="endDate"
              [invalid]="!!orderError()"
            />
          </ui-field>
        </div>

        <p class="text-xs text-foreground-subtle">{{ t("contract.editHint") }}</p>

        <div class="flex items-center gap-2">
          <button uiButton size="sm" type="submit" [loading]="saving()" [disabled]="!!orderError()">
            {{ t("common.save") }}
          </button>
          <button
            uiButton
            variant="ghost"
            size="sm"
            type="button"
            [disabled]="saving()"
            (click)="cancel()"
          >
            {{ t("common.cancel") }}
          </button>
        </div>
      </form>
    } @else {
      <div class="space-y-4">
        <!--
          The notice, when there is something to notice.

          Above the dates rather than below them, because it is the thing an
          operator opening this profile needs to read first — "this ends in a
          week and three days" is the fact that prompts an action, and the exact
          dates are the detail they check afterwards.

          Silent while a term is comfortably running, has not started, or was
          never recorded. A banner that is always present is a banner nobody
          reads by the second week.
        -->
        @if (notice(); as message) {
          <ui-alert [tone]="noticeTone()">{{ message }}</ui-alert>
        }

        <!-- The state, as a sentence rather than a badge. -->
        <div class="flex items-start justify-between gap-3">
          <p class="flex items-center gap-2 text-sm font-medium" [class]="tone().text">
            <span class="h-2 w-2 shrink-0 rounded-full" [class]="tone().dot"></span>
            {{ headline() }}
          </p>

          @if (canEdit()) {
            <button uiButton variant="outline" size="sm" type="button" (click)="edit()">
              <ui-icon name="edit" [size]="14" />
              {{ t("common.edit") }}
            </button>
          }
        </div>

        @if (period().elapsedFraction !== null) {
          <div class="space-y-1.5">
            <div class="flex items-baseline justify-between gap-2 text-xs text-foreground-muted">
              <span>{{ i18n.formatCalendarDate(tenant().contractStartDate!) }}</span>
              <span>{{ i18n.formatCalendarDate(tenant().contractEndDate!) }}</span>
            </div>

            <div
              class="h-2 w-full overflow-hidden rounded-full bg-surface-muted"
              role="progressbar"
              [attr.aria-valuenow]="percent()"
              aria-valuemin="0"
              aria-valuemax="100"
              [attr.aria-label]="t('contract.progressLabel')"
            >
              <div
                class="h-full rounded-full transition-all duration-500"
                [class]="tone().bar"
                [style.width.%]="percent()"
              ></div>
            </div>

            <p class="text-xs text-foreground-subtle">
              {{ t("contract.elapsed", { percent: percent(), total: totalDays() }) }}
            </p>
          </div>
        }

        <!--
          What this means for the account, in plain words.

          The point of this paragraph is that red does not mean "locked out".
          An operator looking at an expired contract has to be able to tell
          whether access has already stopped, and here it never has.
        -->
        <p class="rounded-xl bg-surface-muted px-3.5 py-3 text-xs leading-relaxed text-foreground-muted">
          {{ explanation() }}
        </p>
      </div>
    }
  `
})
export class TenantContractComponent {
  readonly tenant = input.required<TenantDetail>();
  readonly canEdit = input(false);

  /**
   * Who is reading this card.
   *
   * The facts are identical; the advice is not. An operator is told they can
   * suspend the tenant on the lifecycle card — a control a customer does not
   * have and should not be pointed at. Reusing the component with one set of
   * strings would have put an instruction in front of the customer that names a
   * screen they cannot reach.
   */
  readonly audience = input<"operator" | "tenant">("operator");

  /** Emits the tenant as the server returned it, so the page re-renders from it. */
  readonly changed = output<TenantDetail>();

  private readonly platform = inject(PlatformService);
  private readonly toasts = inject(ToastService);
  private readonly builder = inject(FormBuilder);

  protected readonly t = injectT();
  protected readonly i18n = inject(I18nService);

  protected readonly editing = signal(false);
  protected readonly saving = signal(false);
  protected readonly failure = signal<string | null>(null);

  protected readonly form = this.builder.nonNullable.group({
    startDate: [""],
    endDate: [""]
  });

  /**
   * Today, captured once when the component is created.
   *
   * Not re-read per change detection: a date that changes underneath a computed
   * makes the bar and the sentence able to disagree within one render, and a
   * portal tab left open across midnight showing yesterday's day count for a
   * few seconds is not a problem worth a timer.
   */
  private readonly today = todayIso();

  protected readonly period = computed(() =>
    resolveContractPeriod(
      this.tenant().contractStartDate,
      this.tenant().contractEndDate,
      this.today
    )
  );

  protected readonly tone = computed(() => STATE_TONE[this.period().state]);

  protected readonly percent = computed(() =>
    Math.round((this.period().elapsedFraction ?? 0) * 100)
  );

  protected readonly totalDays = computed(() => this.period().totalDays ?? 0);

  /**
   * A day count, in the units it reads best in: "3 days", "2 weeks",
   * "1 week and 3 days".
   *
   * Each number is pluralised separately through `Intl.PluralRules` rather than
   * picked with `count === 1`. Arabic has a dual form — two weeks is
   * "أسبوعان", not "2 أسابيع" — and a sentence assembled from an English
   * singular/plural choice gets that wrong every time.
   */
  private duration(count: number): string {
    const parts: Duration = describeDuration(count);

    switch (parts.kind) {
      case "days":
        return this.i18n.plural("contract.dayCount", parts.days, { count: parts.days });
      case "weeks":
        return this.i18n.plural("contract.weekCount", parts.weeks, { count: parts.weeks });
      default:
        return this.t("contract.weeksAndDays", {
          weeks: this.i18n.plural("contract.weekCount", parts.weeks, { count: parts.weeks }),
          days: this.i18n.plural("contract.dayCount", parts.days, { count: parts.days })
        });
    }
  }

  /** The one-line state, with its day count. */
  protected readonly headline = computed(() => {
    const { state, daysRemaining } = this.period();

    switch (state) {
      case "none":
        return this.t("contract.stateNone");
      case "upcoming":
        return this.t("contract.stateUpcoming", {
          days: this.duration(this.daysUntilStart())
        });
      case "expired":
        // Through the helper, not `Math.abs(daysRemaining)`: the count is
        // inclusive of the end date, so negating it is off by one and renders
        // "expired 0 days ago" on the first day it is expired.
        return this.t("contract.stateExpired", {
          days: this.duration(daysSinceExpiry(this.period()))
        });
      default:
        return daysRemaining === null
          ? this.t("contract.stateOpenEnded")
          : this.t(
              state === "imminent"
                ? "contract.stateImminent"
                : state === "expiring"
                  ? "contract.stateExpiring"
                  : "contract.stateActive",
              { days: this.duration(daysRemaining) }
            );
    }
  });

  private daysUntilStart(): number {
    const start = this.tenant().contractStartDate;
    if (!start) return 0;
    const ms = Date.parse(`${start}T00:00:00Z`) - Date.parse(`${this.today}T00:00:00Z`);
    return Math.round(ms / 86_400_000);
  }

  /**
   * The message shown at the top of the card, or null when there is none.
   *
   * Says the same remaining time as the headline, in a full sentence and in the
   * units the reader thinks in — "This subscription ends in 1 week and 3 days."
   * The headline is a label; this is the thing meant to be read.
   */
  protected readonly notice = computed(() => {
    const { state, daysRemaining } = this.period();

    const own = this.audience() === "tenant";

    if (state === "expired") {
      return this.t(own ? "contract.ownNoticeExpired" : "contract.noticeExpired", {
        duration: this.duration(daysSinceExpiry(this.period()))
      });
    }

    if ((state === "expiring" || state === "imminent") && daysRemaining !== null) {
      return this.t(own ? "contract.ownNoticeEnding" : "contract.noticeEnding", {
        duration: this.duration(daysRemaining)
      });
    }

    // Running comfortably, not started, or not recorded — nothing to raise.
    return null;
  });

  /** Amber while there is time to act, red once there is not. */
  protected readonly noticeTone = computed(() =>
    this.period().state === "expiring" ? "warning" : "danger"
  );

  /**
   * What the state means for the account.
   *
   * Every branch says the account is open, because it always is — see the class
   * note. The variation is only in what an operator might want to do next.
   */
  protected readonly explanation = computed(() => {
    const own = this.audience() === "tenant";

    switch (this.period().state) {
      case "none":
        return this.t(own ? "contract.ownExplainNone" : "contract.explainNone");
      case "upcoming":
        return this.t(own ? "contract.ownExplainUpcoming" : "contract.explainUpcoming");
      case "expired":
        return this.t(own ? "contract.ownExplainExpired" : "contract.explainExpired");
      case "expiring":
      case "imminent":
        return this.t(own ? "contract.ownExplainEnding" : "contract.explainEnding");
      default:
        return this.t(own ? "contract.ownExplainActive" : "contract.explainActive");
    }
  });

  /** Live ordering check, so the form refuses before the server has to. */
  protected readonly orderError = computed(() => {
    const { startDate, endDate } = this.formValue();
    if (!startDate || !endDate) return null;
    return endDate < startDate ? this.t("contract.endBeforeStart") : null;
  });

  /**
   * The form's value as a signal.
   *
   * Reactive forms are not signal-based here, so `valueChanges` is bridged
   * through one that the template's computeds can depend on. Set in `edit()`
   * and on every change below.
   */
  private readonly formValue = signal<{ startDate: string; endDate: string }>({
    startDate: "",
    endDate: ""
  });

  constructor() {
    this.form.valueChanges.subscribe((value) =>
      this.formValue.set({
        startDate: value.startDate ?? "",
        endDate: value.endDate ?? ""
      })
    );
  }

  protected edit(): void {
    const tenant = this.tenant();
    // `<input type="date">` takes and returns `YYYY-MM-DD`, which is exactly
    // what the API carries — so there is no parsing or formatting on either
    // side of this form, and no timezone to get wrong.
    this.form.setValue({
      startDate: tenant.contractStartDate ?? "",
      endDate: tenant.contractEndDate ?? ""
    });
    this.failure.set(null);
    this.editing.set(true);
  }

  protected cancel(): void {
    this.editing.set(false);
    this.failure.set(null);
  }

  protected save(): void {
    if (this.orderError()) return;

    const { startDate, endDate } = this.form.getRawValue();
    this.saving.set(true);
    this.failure.set(null);

    this.platform
      // Empty means cleared. The API distinguishes null from absent, and an
      // empty string is neither a date nor a way to say "no date".
      .setTenantContract(this.tenant().id, {
        startDate: startDate || null,
        endDate: endDate || null
      })
      .subscribe({
        next: (tenant) => {
          this.saving.set(false);
          this.editing.set(false);
          this.changed.emit(tenant);
          this.toasts.success(this.t("contract.saved"));
        },
        error: (error: unknown) => {
          this.saving.set(false);
          this.failure.set(describeError(error, this.t, "contract.failed"));
        }
      });
  }
}
