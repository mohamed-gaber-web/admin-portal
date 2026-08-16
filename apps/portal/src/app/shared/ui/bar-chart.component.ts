import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";
import type { SeriesPoint } from "@core/models";

/**
 * A categorical breakdown, as horizontal bars.
 *
 * Answers composition — how a total splits across a handful of categories —
 * which a line chart cannot show and a pie shows badly. Bars beat a pie here
 * because comparing lengths against a shared baseline is something people do
 * accurately and comparing angles is not.
 *
 * The value rides above its bar rather than at the bar's tip. The tip is the
 * usual place, and it is the wrong one in a narrow sidebar column: a bar near
 * 100% leaves no room and the number either overflows or gets clipped. Above
 * the track, the values also align into a readable column.
 *
 * One hue for every bar, because this is one series measured across categories
 * — colouring each category differently would imply an identity encoding that
 * carries no information and burns four categorical slots.
 */
@Component({
  selector: "ui-bar-chart",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <ul class="space-y-3.5">
      @for (row of rows(); track row.label) {
        <li class="space-y-1.5">
          <div class="flex items-baseline justify-between gap-3">
            <span class="truncate text-sm capitalize text-foreground-muted">
              {{ row.label }}
            </span>
            <span class="shrink-0 text-sm font-semibold tabular-nums text-foreground">
              {{ row.value.toLocaleString() }}
              <span class="ms-1 text-xs font-normal text-foreground-subtle">
                {{ row.percent }}%
              </span>
            </span>
          </div>

          <!-- Track in a lighter step of the bar's own hue, so the unfilled
               remainder still reads as part of the same measure. -->
          <div class="h-2 w-full overflow-hidden rounded-full bg-chart-1/[0.14]">
            <!-- rounded-e, not rounded-r, so the rounded data-end stays at the
                 growing end of the bar. Under RTL the bar grows from the
                 right, where a right-rounded corner would sit on the baseline
                 instead of the tip. -->
            <div
              class="h-full rounded-e-[4px] bg-chart-1 transition-[width] duration-500 ease-out"
              [style.width.%]="row.percent"
            ></div>
          </div>
        </li>
      }
    </ul>
  `
})
export class BarChartComponent {
  readonly data = input.required<readonly SeriesPoint[]>();

  protected readonly rows = computed(() => {
    const points = this.data();
    const total = points.reduce((sum, point) => sum + point.value, 0);

    return points.map((point) => ({
      label: point.label,
      value: point.value,
      // Share of the total, not of the largest bar. "40% of tenants are on
      // Growth" is the question this chart is asked; scaling to the peak would
      // make the biggest category always read as 100%.
      percent: total === 0 ? 0 : Math.round((point.value / total) * 100)
    }));
  });
}
