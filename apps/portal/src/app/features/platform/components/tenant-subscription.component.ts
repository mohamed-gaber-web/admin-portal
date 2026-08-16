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
import { TENANT_PLANS, type TenantDetail, type TenantPlan } from "@core/models";
import {
  BadgeComponent,
  ButtonComponent,
  ConfirmDialogComponent,
  IconComponent
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
  imports: [BadgeComponent, ButtonComponent, ConfirmDialogComponent, IconComponent],
  template: `
    <div class="space-y-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="space-y-1">
          <p class="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
            {{ t("subscription.currentPlan") }}
          </p>
          <ui-badge tone="info">{{ t(PLAN_LABELS[tenant().plan]) }}</ui-badge>
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
          </label>
        }
      </fieldset>

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

  constructor() {
    // Seeds the selection once the input arrives, and re-seeds it whenever the
    // tenant's own plan changes underneath — which happens after a save, and is
    // exactly when the pending selection should stop being pending.
    //
    // `allowSignalWrites` for the same reason the tenant detail page needs it:
    // reacting to an input by writing a signal is the whole job here. (Angular
    // 19 permits this by default and the flag becomes redundant.)
    effect(() => this.selected.set(this.tenant().plan), { allowSignalWrites: true });
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
