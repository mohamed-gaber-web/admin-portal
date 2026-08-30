import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal
} from "@angular/core";

export interface TrendSeries {
  name: string;
  values: readonly number[];
  /** Categorical slot. Fixed per entity, so a filter never repaints survivors. */
  slot: 1 | 2;
}

/** Plot geometry, in viewBox units. Right padding leaves room for end labels. */
const W = 720;
const H = 260;
const PAD = { top: 16, right: 60, bottom: 30, left: 48 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;
const TICKS = 4;

/**
 * A two-series area-and-line chart over time.
 *
 * One y-axis, always. Two measures of different magnitude get two charts or an
 * indexed common base — a second scale lets any two series be made to cross
 * wherever the author likes, which is the most quietly dishonest thing a chart
 * can do.
 *
 * Both series are always identified twice: by the legend, and by the tooltip
 * that names them on hover. End labels ride the lines only when they are far
 * enough apart to stay attached to the right line; when the series converge the
 * labels are dropped rather than nudged, because a label pushed clear of its
 * own line is worse than no label.
 */
@Component({
  selector: "ui-trend-chart",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <!-- Legend. Always present: identity must never rest on colour alone. -->
    <div class="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2">
      @for (entry of series(); track entry.name) {
        <span class="flex items-center gap-2 text-xs font-medium text-foreground-muted">
          <span
            class="h-0.5 w-4 rounded-full"
            [class]="entry.slot === 1 ? 'bg-chart-1' : 'bg-chart-2'"
            aria-hidden="true"
          ></span>
          {{ entry.name }}
        </span>
      }
    </div>

    <div class="relative">
      <svg
        [attr.viewBox]="'0 0 ' + W + ' ' + H"
        class="w-full"
        [style.aspect-ratio]="W + ' / ' + H"
        role="img"
        [attr.aria-label]="ariaLabel()"
        (pointerleave)="hovered.set(null)"
      >
        <!-- Gridlines: hairline, solid, one step off the surface. -->
        @for (tick of yTicks(); track tick.value) {
          <line
            [attr.x1]="PAD.left"
            [attr.x2]="PAD.left + PLOT_W"
            [attr.y1]="tick.y"
            [attr.y2]="tick.y"
            class="stroke-grid"
            stroke-width="1"
          />
          <text
            [attr.x]="PAD.left - 10"
            [attr.y]="tick.y + 4"
            text-anchor="end"
            class="fill-foreground-subtle text-[11px] tabular-nums"
          >
            {{ tick.label }}
          </text>
        }

        @for (entry of paths(); track entry.name) {
          <path
            [attr.d]="entry.area"
            [class]="entry.slot === 1 ? 'fill-chart-1/10' : 'fill-chart-2/10'"
          />
          <path
            [attr.d]="entry.line"
            fill="none"
            [class]="entry.slot === 1 ? 'stroke-chart-1' : 'stroke-chart-2'"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        }

        <!-- X labels, thinned so they never collide on a narrow container. -->
        @for (tick of xTicks(); track tick.x) {
          <text
            [attr.x]="tick.x"
            [attr.y]="H - 8"
            text-anchor="middle"
            class="fill-foreground-subtle text-[11px]"
          >
            {{ tick.label }}
          </text>
        }

        <!-- End labels, only where the series have separated. -->
        @for (label of endLabels(); track label.name) {
          <text
            [attr.x]="PAD.left + PLOT_W + 10"
            [attr.y]="label.y + 4"
            class="fill-foreground-muted text-[11px] font-semibold tabular-nums"
          >
            {{ label.text }}
          </text>
        }

        @if (hovered() !== null) {
          <line
            [attr.x1]="xAt(hovered()!)"
            [attr.x2]="xAt(hovered()!)"
            [attr.y1]="PAD.top"
            [attr.y2]="PAD.top + PLOT_H"
            class="stroke-border-strong"
            stroke-width="1"
          />
          @for (dot of dotsAt(hovered()!); track dot.name) {
            <circle
              [attr.cx]="dot.x"
              [attr.cy]="dot.y"
              r="4.5"
              [class]="
                (dot.slot === 1 ? 'fill-chart-1' : 'fill-chart-2') + ' stroke-surface'
              "
              stroke-width="2"
            />
          }
        }

        <!-- Hit targets: full-height bands, far bigger than the marks. -->
        @for (label of labels(); track $index) {
          <rect
            [attr.x]="xAt($index) - bandWidth() / 2"
            [attr.y]="PAD.top"
            [attr.width]="bandWidth()"
            [attr.height]="PLOT_H"
            fill="transparent"
            (pointerenter)="hovered.set($index)"
          />
        }
      </svg>

      @if (hovered() !== null) {
        <div
          class="pointer-events-none absolute top-2 z-10 w-40 -translate-x-1/2 rounded-xl border border-border bg-surface p-3 shadow-popover"
          [style.left.%]="(xAt(hovered()!) / W) * 100"
        >
          <p class="mb-2 text-xs font-semibold text-foreground">
            {{ labels()[hovered()!] }}
          </p>
          @for (dot of dotsAt(hovered()!); track dot.name) {
            <p class="flex items-center justify-between gap-3 text-xs">
              <span class="flex items-center gap-1.5 text-foreground-muted">
                <span
                  class="h-2 w-2 rounded-full"
                  [class]="dot.slot === 1 ? 'bg-chart-1' : 'bg-chart-2'"
                ></span>
                {{ dot.name }}
              </span>
              <span class="font-semibold tabular-nums text-foreground">
                {{ dot.value.toLocaleString() }}
              </span>
            </p>
          }
        </div>
      }
    </div>
  `
})
export class TrendChartComponent {
  readonly labels = input.required<readonly string[]>();
  readonly series = input.required<readonly TrendSeries[]>();

  protected readonly W = W;
  protected readonly H = H;
  protected readonly PAD = PAD;
  protected readonly PLOT_W = PLOT_W;
  protected readonly PLOT_H = PLOT_H;

  protected readonly hovered = signal<number | null>(null);

  protected readonly ariaLabel = computed(
    () =>
      `${this.series()
        .map((entry) => entry.name)
        .join(" and ")} over ${this.labels().length} periods`
  );

  /** Axis maximum, rounded up to something a person would say out loud. */
  private readonly max = computed(() => {
    const peak = Math.max(
      1,
      ...this.series().flatMap((entry) => [...entry.values])
    );
    const magnitude = 10 ** Math.floor(Math.log10(peak));
    const normalised = peak / magnitude;
    const step = [1, 1.5, 2, 2.5, 5, 10].find((candidate) => normalised <= candidate) ?? 10;
    return step * magnitude;
  });

  protected readonly yTicks = computed(() =>
    Array.from({ length: TICKS + 1 }, (_, index) => {
      const value = (this.max() / TICKS) * index;
      return {
        value,
        y: this.yAt(value),
        label: value >= 1000 ? `${value / 1000}k` : String(value)
      };
    })
  );

  protected readonly xTicks = computed(() => {
    const labels = this.labels();
    // At most six, evenly spaced, always including the last.
    const stride = Math.max(1, Math.ceil(labels.length / 6));
    return labels
      .map((label, index) => ({ label, index, x: this.xAt(index) }))
      .filter(({ index }) => index % stride === 0 || index === labels.length - 1);
  });

  protected readonly bandWidth = computed(() =>
    Math.max(1, PLOT_W / Math.max(1, this.labels().length - 1))
  );

  protected readonly paths = computed(() =>
    this.series().map((entry) => {
      const line = entry.values
        .map((value, index) => `${index === 0 ? "M" : "L"}${this.xAt(index)} ${this.yAt(value)}`)
        .join(" ");
      const baseline = PAD.top + PLOT_H;
      const lastX = this.xAt(entry.values.length - 1);
      return {
        name: entry.name,
        slot: entry.slot,
        line,
        area: `${line} L${lastX} ${baseline} L${PAD.left} ${baseline} Z`
      };
    })
  );

  /**
   * End labels, dropped when the lines converge.
   *
   * 18 viewBox units is roughly a label height; closer than that and the two
   * would overlap. Nudging them apart is the tempting fix and the wrong one —
   * a label that no longer touches its line stops identifying anything.
   */
  protected readonly endLabels = computed(() => {
    const labels = this.series().map((entry) => {
      const value = entry.values[entry.values.length - 1] ?? 0;
      return {
        name: entry.name,
        y: this.yAt(value),
        text: value.toLocaleString()
      };
    });

    const tooClose = labels.some((label, index) =>
      labels.some(
        (other, otherIndex) =>
          otherIndex !== index && Math.abs(other.y - label.y) < 18
      )
    );
    return tooClose ? [] : labels;
  });

  protected dotsAt(index: number) {
    return this.series().map((entry) => ({
      name: entry.name,
      slot: entry.slot,
      value: entry.values[index] ?? 0,
      x: this.xAt(index),
      y: this.yAt(entry.values[index] ?? 0)
    }));
  }

  protected xAt(index: number): number {
    const count = Math.max(1, this.labels().length - 1);
    return PAD.left + (index / count) * PLOT_W;
  }

  private yAt(value: number): number {
    return PAD.top + PLOT_H * (1 - value / this.max());
  }
}
