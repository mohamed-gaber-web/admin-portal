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
import { describeError } from "@core/http/api-error";
import { injectT } from "@core/i18n/i18n.service";
import { TENANT_PLAN_LABEL_KEYS } from "@core/i18n/label-keys";
import { ToastService } from "@core/notifications/toast.service";
import { TENANT_PLANS, type Plan, type TenantDetail, type TenantPlan } from "@core/models";
import {
  AlertComponent,
  BadgeComponent,
  ButtonComponent,
  ConfirmDialogComponent,
  IconComponent,
  InputDirective
} from "@shared/ui";
import { PlatformService } from "../platform.service";

/**
 * A tenant's commercial plan, and cancelling it.
 *
 * Two controls that write the same column and mean different things. Moving
 * between plans is routine — an upgrade at renewal, a downgrade after a
 * headcount change — and is one click with no confirmation. Cancelling is not:
 * it is the customer leaving, and the button asks first.
 *
 * ### What unsubscribing does not do
 *
 * It does not suspend the tenant, and the separation is deliberate rather than
 * an omission. A customer whose subscription lapsed should stop getting what
 * they no longer pay for; locking them out of their own data at the moment they
 * most need to export it is a different, harsher decision, and it has its own
 * control on the lifecycle card. Anyone who wants both can do both, and will
 * have thought about the second.
 *
 * ### Why "unsubscribed" is not a state you can see
 *
 * The plan column has four values and none of them is "none". Cancelling returns
 * the tenant to `trial`, so afterwards a cancelled customer and a customer who
 * never bought anything look identical here — the difference lives in the audit
 * log, which records `tenant.unsubscribed` with the plan that was cancelled.
 * That is a real limitation of scoping this to the existing column rather than
 * building the subscription model (US-070/071), and the log is what that model
 * will be reconstructed from when it lands.
 */
@Component({
  selector: "app-tenant-subscription",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AlertComponent,
    BadgeComponent,
    ButtonComponent,
    ConfirmDialogComponent,
    IconComponent,
    InputDirective
  ],
  template: `
    <div class="space-y-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="space-y-1">
          <p class="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
            {{ t("subscription.currentPlan") }}
          </p>
          <ui-badge tone="info">{{ t(PLAN_LABELS[tenant().plan]) }}</ui-badge>
        </div>

        <!--
          Seats used, against what the package includes. On the right of the
          current plan because it is the consequence of it — this is the number
          an operator is usually here to change.
        -->
        <div class="space-y-1 text-end">
          <p class="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
            {{ t("subscription.seats") }}
          </p>
          <p class="text-sm font-medium tabular-nums" [class.text-danger]="seatsFull()">
            {{ t("subscription.seatsUsed", { used: tenant().userCount, limit: tenant().userLimit }) }}
          </p>
        </div>
      </div>

      <!--
        A radio group rather than a <select>. Four options that a person is
        choosing between deliberately, on a screen they visit rarely — the
        trade-off a select makes (compactness for a hidden list) is the wrong
        one when the whole list is four items and the choice has a price.
      -->
      <fieldset class="space-y-2" [disabled]="busy()">
        <legend class="sr-only">{{ t("subscription.choosePlan") }}</legend>
        @for (plan of PLANS; track plan) {
          <label
            class="flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition-colors duration-200"
            [class.border-primary]="plan === selected()"
            [class.bg-primary-subtle]="plan === selected()"
            [class.border-border]="plan !== selected()"
            [class.hover:bg-surface-muted]="plan !== selected()"
          >
            <input
              type="radio"
              name="tenant-plan"
              class="h-4 w-4 accent-primary"
              [value]="plan"
              [checked]="plan === selected()"
              (change)="selected.set(plan)"
            />
            <span class="text-sm font-medium text-foreground">
              {{ t(PLAN_LABELS[plan]) }}
            </span>

            <!--
              The seat count sits on the option itself, because it is what
              distinguishes the options. Absent until the catalogue loads rather
              than shown as a zero or a dash — a package that appears to include
              no users is worse than one that has not said yet, and the choice
              is still safe to make without it.
            -->
            @if (seatsFor(plan); as seats) {
              <span class="ms-auto text-xs tabular-nums text-foreground-subtle">
                {{ t("subscription.planSeats", { count: seats }) }}
              </span>
            }
          </label>
        }
      </fieldset>

      <!--
        A downgrade that does not fit.

        Warned about rather than blocked: the API allows it, and it is sometimes
        exactly what an operator means to do before removing people. What it must
        not be is a surprise — afterwards the tenant is over its allowance and
        cannot invite anyone until they are back under it.
      -->
      @if (shortfall(); as short) {
        <ui-alert tone="warning" [title]="t('subscription.downgradeTitle')">
          {{
            t("subscription.downgradeBody", {
              used: tenant().userCount,
              limit: short.limit,
              plan: t(PLAN_LABELS[short.plan])
            })
          }}
        </ui-alert>
      }

      <!--
        The negotiated allowance.

        Its own row under the packages rather than a fifth radio option, because
        it is not a choice between packages — it is a number layered on top of
        whichever one is selected. Empty means "inherit", which is why the
        placeholder shows the package's figure rather than a zero: the field is
        blank and the tenant still has an allowance.
      -->
      <div class="space-y-2 border-t border-border pt-4">
        <label
          for="seat-override"
          class="block text-xs font-medium uppercase tracking-wide text-foreground-subtle"
        >
          {{ t("seats.overrideLabel") }}
        </label>
        <div class="flex flex-wrap items-center gap-2">
          <input
            uiInput
            id="seat-override"
            type="number"
            min="1"
            step="1"
            class="!w-32 tabular-nums"
            [disabled]="savingSeats()"
            [attr.placeholder]="packageSeatsLabel()"
            [value]="seatDraft()"
            (input)="onSeatInput($event)"
          />
          <button
            uiButton
            size="sm"
            variant="outline"
            type="button"
            [disabled]="!seatsChanged()"
            [loading]="savingSeats()"
            (click)="saveSeats()"
          >
            {{ t("seats.save") }}
          </button>
          @if (tenant().seatLimitOverride !== null) {
            <button
              uiButton
              size="sm"
              variant="ghost"
              type="button"
              [loading]="savingSeats()"
              (click)="clearSeats()"
            >
              {{ t("seats.usePackage") }}
            </button>
          }
        </div>
        <p class="text-xs text-foreground-subtle">
          {{
            tenant().seatLimitOverride === null
              ? t("seats.inheriting", { limit: tenant().userLimit })
              : t("seats.negotiated", { limit: tenant().userLimit })
          }}
        </p>
        @if (seatCutWarning(); as cut) {
          <p class="text-xs text-danger">
            {{ t("seats.belowUsage", { used: tenant().userCount, limit: cut }) }}
          </p>
        }
      </div>

      <div class="flex flex-wrap gap-2">
        <button
          uiButton
          size="sm"
          type="button"
          [disabled]="!hasChange()"
          [loading]="saving()"
          (click)="save()"
        >
          {{ t("subscription.savePlan") }}
        </button>

        <!--
          Offered only when there is a subscription to cancel. A tenant already
          on trial has nothing to unsubscribe from, and a button that would
          write no change reads as broken the moment somebody presses it.
        -->
        @if (canUnsubscribe()) {
          <button
            uiButton
            variant="danger"
            size="sm"
            type="button"
            [loading]="cancelling()"
            (click)="confirming.set(true)"
          >
            <ui-icon name="lock" [size]="15" />
            {{ t("subscription.unsubscribe") }}
          </button>
        }
      </div>
    </div>

    @if (confirming()) {
      <ui-confirm-dialog
        [title]="t('subscription.unsubscribeTitle')"
        [description]="t('subscription.unsubscribeBody', { name: tenant().name })"
        [confirmLabel]="t('subscription.unsubscribeConfirm')"
        [warning]="t('subscription.unsubscribeWarning')"
        tone="danger"
        [busy]="cancelling()"
        (confirmed)="unsubscribe()"
        (cancelled)="confirming.set(false)"
      />
    }
  `
})
export class TenantSubscriptionComponent {
  readonly tenant = input.required<TenantDetail>();

  /** Emits the tenant as the server now holds it, so the page can adopt it. */
  readonly changed = output<TenantDetail>();

  private readonly platform = inject(PlatformService);
  private readonly toasts = inject(ToastService);

  protected readonly t = injectT();
  protected readonly PLANS = TENANT_PLANS;
  protected readonly PLAN_LABELS = TENANT_PLAN_LABEL_KEYS;

  protected readonly saving = signal(false);
  protected readonly cancelling = signal(false);
  protected readonly confirming = signal(false);

  /**
   * The plan the radio group is showing.
   *
   * Seeded from the tenant and then owned by the user until they save. Not a
   * computed over `tenant()`, because a computed would snap the selection back
   * the moment anything else on the page refetched — losing a choice somebody
   * had already made and not yet submitted.
   */
  protected readonly selected = signal<TenantPlan>("trial");

  protected readonly busy = computed(() => this.saving() || this.cancelling());
  protected readonly hasChange = computed(() => this.selected() !== this.tenant().plan);
  protected readonly canUnsubscribe = computed(() => this.tenant().plan !== "trial");

  /**
   * The package catalogue, keyed for lookup.
   *
   * Empty until it arrives, and every reader below is written to cope with that
   * rather than to wait for it. The plan picker's job — choosing a package — is
   * doable without the seat numbers, so a catalogue that failed to load should
   * cost the annotation and not the screen.
   */
  private readonly plans = signal<Map<TenantPlan, Plan>>(new Map());

  /** Whether the tenant has used every seat its package includes. */
  protected readonly seatsFull = computed(
    () => this.tenant().userCount >= this.tenant().userLimit
  );

  /**
   * The pending selection, when it holds fewer seats than the tenant is using.
   *
   * Null when there is no pending change, when the catalogue has not loaded, or
   * when the chosen package fits — so the template can treat a value as "there
   * is something to warn about" without repeating the conditions.
   */
  protected readonly shortfall = computed<{ plan: TenantPlan; limit: number } | null>(() => {
    if (!this.hasChange()) return null;
    const plan = this.plans().get(this.selected());
    if (!plan) return null;
    return this.tenant().userCount > plan.userLimit
      ? { plan: plan.key, limit: plan.userLimit }
      : null;
  });

  /** Seats a package includes, or null while the catalogue is still loading. */
  protected seatsFor(plan: TenantPlan): number | null {
    return this.plans().get(plan)?.userLimit ?? null;
  }

  // ── The negotiated allowance ───────────────────────────────────────────

  protected readonly savingSeats = signal(false);

  /**
   * What is typed in the override field, as a string.
   *
   * A string rather than a number, because "" is a state the number cannot
   * express and is the one that matters: it means "inherit the package", which
   * is what gets sent as null. Seeded from the tenant and then owned by the
   * user until they save, for the same reason `selected` is.
   */
  protected readonly seatDraft = signal("");

  /** The typed value as the API takes it: a positive number, or null to inherit. */
  private parsedSeatDraft(): number | null {
    const raw = this.seatDraft().trim();
    if (raw === "") return null;
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  protected readonly seatsChanged = computed(
    () => this.parsedSeatDraft() !== this.tenant().seatLimitOverride
  );

  /** The package's own figure, shown as the placeholder for the empty field. */
  protected packageSeatsLabel(): string {
    const plan = this.plans().get(this.tenant().plan);
    return plan ? String(plan.userLimit) : "";
  }

  /**
   * A pending override below the tenant's current headcount.
   *
   * Warned about, not blocked — the API allows it and an operator sometimes
   * means it. Null when there is nothing pending or the number fits.
   */
  protected readonly seatCutWarning = computed<number | null>(() => {
    if (!this.seatsChanged()) return null;
    const pending = this.parsedSeatDraft();
    if (pending === null) return null;
    return this.tenant().userCount > pending ? pending : null;
  });

  protected onSeatInput(event: Event): void {
    this.seatDraft.set((event.target as HTMLInputElement).value);
  }

  protected saveSeats(): void {
    if (!this.seatsChanged()) return;
    this.writeSeats(this.parsedSeatDraft());
  }

  /** Puts the tenant back onto its package's number. */
  protected clearSeats(): void {
    this.writeSeats(null);
  }

  private writeSeats(seatLimit: number | null): void {
    this.savingSeats.set(true);
    this.platform.setTenantSeats(this.tenant().id, seatLimit).subscribe({
      next: (updated) => {
        this.savingSeats.set(false);
        this.changed.emit(updated);
        this.toasts.success(
          seatLimit === null
            ? this.t("seats.clearedToast", { limit: updated.userLimit })
            : this.t("seats.savedToast", { limit: updated.userLimit })
        );
      },
      error: (error: unknown) => {
        this.savingSeats.set(false);
        // The draft is left where the user put it, so a retry does not start
        // from a number they did not choose.
        this.toasts.error(describeError(error, this.t, "seats.failed"));
      }
    });
  }

  constructor() {
    // Seeds the selection once the input arrives, and re-seeds it whenever the
    // tenant's own plan changes underneath — which happens after a save, and is
    // exactly when the pending selection should stop being pending.
    //
    // `allowSignalWrites` for the same reason the tenant detail page needs it:
    // reacting to an input by writing a signal is the whole job here. (Angular
    // 19 permits this by default and the flag becomes redundant.)
    effect(() => this.selected.set(this.tenant().plan), { allowSignalWrites: true });

    // Same reasoning as the plan selection above: seeded from the tenant, and
    // re-seeded when the stored value changes underneath — which is exactly when
    // a pending edit should stop being pending.
    effect(
      () => {
        const override = this.tenant().seatLimitOverride;
        this.seatDraft.set(override === null ? "" : String(override));
      },
      { allowSignalWrites: true }
    );

    // Fetched once, when the card is created. The catalogue changes about as
    // often as a price list, so refetching it per selection would be traffic
    // spent on an answer that has not moved.
    //
    // The failure branch is deliberately silent: no toast, no error state. This
    // is an annotation on a control that works without it, and an operator
    // changing a customer's package does not need to be told that a number
    // beside the options could not be fetched.
    this.platform.listPlans().subscribe({
      next: (plans) => this.plans.set(new Map(plans.map((plan) => [plan.key, plan]))),
      error: () => this.plans.set(new Map())
    });
  }

  protected save(): void {
    if (!this.hasChange()) return;

    this.saving.set(true);
    this.platform.setTenantPlan(this.tenant().id, this.selected()).subscribe({
      next: (updated) => {
        this.saving.set(false);
        this.changed.emit(updated);
        this.toasts.success(
          this.t("subscription.saved", { plan: this.t(this.PLAN_LABELS[updated.plan]) })
        );
      },
      error: (error: unknown) => {
        this.saving.set(false);
        // The selection is left where the user put it. Snapping it back to the
        // stored plan would hide what they were trying to do at the exact
        // moment they need to retry it.
        this.toasts.error(describeError(error, this.t, "subscription.failed"));
      }
    });
  }

  protected unsubscribe(): void {
    this.cancelling.set(true);
    // Explicitly to `trial`, matching what the API does, so the request says
    // what it means rather than relying on a server-side default.
    this.platform.unsubscribeTenant(this.tenant().id, "trial").subscribe({
      next: (updated) => {
        this.cancelling.set(false);
        this.confirming.set(false);
        this.selected.set(updated.plan);
        this.changed.emit(updated);
        this.toasts.success(this.t("subscription.unsubscribed", { name: updated.name }));
      },
      error: (error: unknown) => {
        this.cancelling.set(false);
        this.confirming.set(false);
        this.toasts.error(describeError(error, this.t, "subscription.failed"));
      }
    });
  }
}
