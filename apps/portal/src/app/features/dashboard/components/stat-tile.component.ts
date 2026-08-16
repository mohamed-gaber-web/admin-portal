import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input
} from "@angular/core";
import { I18nService, injectT } from "@core/i18n/i18n.service";
import type { Metric } from "@core/models";
import { IconComponent, SparklineComponent } from "@shared/ui";

/**
 * A headline number with its movement and a small history.
 *
 * An attribute on an `<a>`, so the whole tile is one real link — middle-click,
 * keyboard activation and the browser's status bar all work, and every number
 * on the dashboard leads somewhere. A number that prompts "why is that up?"
 * with nothing to click is the most common dead end on a dashboard.
 *
 * The delta's colour comes from `direction`, not from its sign. Failed sign-ins
 * rising 22% is bad and tenants rising 12% is good, and a tile that paints
 * every increase green tells the operator the opposite of what happened on
 * exactly the metric they most need to notice. The arrow does the same work a
 * second time, so the good/bad reading never rests on red-versus-green alone.
 */
@Component({
  selector: "a[appStatTile]",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, SparklineComponent],
  host: {
    class:
      "raised group flex flex-col gap-4 rounded-2xl border border-border bg-surface p-5 " +
      "shadow-card transition-all duration-200 hover:-translate-y-0.5 " +
      "hover:border-border-strong hover:shadow-popover"
  },
  template: `
    <div class="flex items-center gap-2.5">
      <span
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-foreground-muted transition-colors duration-200 group-hover:bg-primary-subtle group-hover:text-primary"
      >
        <ui-icon [name]="metric().icon" [size]="16" />
      </span>

      <p class="min-w-0 flex-1 truncate text-sm font-medium text-foreground-muted">
        {{ t(metric().labelKey) }}
      </p>

      <!-- Appears on hover: says "this goes somewhere" without adding
           permanent chrome to four tiles in a row. -->
      <ui-icon
        name="chevron-right"
        [size]="15"
        class="shrink-0 text-foreground-subtle opacity-0 transition-opacity duration-200 group-hover:opacity-100"
      />
    </div>

    <div class="flex flex-wrap items-center gap-x-2.5 gap-y-2">
      <!-- Proportional figures: tabular-nums makes a big number look gappy. -->
      <span class="text-[1.75rem] font-semibold leading-none tracking-tight text-foreground">
        {{ formatted() }}
      </span>

      <span
        [class]="
          'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-semibold ' +
          deltaClass()
        "
      >
        <ui-icon [name]="metric().delta >= 0 ? 'arrow-up' : 'arrow-down'" [size]="12" />
        {{ absDelta() }}%
      </span>
    </div>

    <ui-sparkline [values]="metric().series" class="mt-auto" />
  `
})
export class StatTileComponent {
  readonly metric = input.required<Metric>();

  protected readonly t = injectT();
  private readonly i18n = inject(I18nService);

  /**
   * Compact above four digits — "12.9K" reads faster than "12,904" at tile size.
   *
   * Formatted through the active locale rather than the browser's default, so
   * grouping separators, the compact suffix and the digit system all follow the
   * language the user chose instead of the one their OS is set to.
   */
  protected readonly formatted = computed(() => {
    const { value, format } = this.metric();
    if (format === "percent") return this.i18n.formatNumber(value / 100, { style: "percent" });
    if (format === "currency") {
      return this.i18n.formatNumber(value, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0
      });
    }
    return value >= 10_000
      ? this.i18n.formatNumber(value, {
          notation: "compact",
          maximumFractionDigits: 1
        })
      : this.i18n.formatNumber(value);
  });

  protected readonly absDelta = computed(() =>
    this.i18n.formatNumber(Math.abs(this.metric().delta), {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1
    })
  );

  protected readonly deltaClass = computed(() => {
    const { delta, direction } = this.metric();
    if (delta === 0) return "bg-surface-muted text-foreground-subtle";
    const rose = delta > 0;
    const isGood = direction === "up-is-good" ? rose : !rose;
    return isGood
      ? "bg-success-subtle text-success"
      : "bg-danger-subtle text-danger";
  });
}
