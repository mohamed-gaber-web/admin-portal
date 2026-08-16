import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";

/**
 * The twelve-point trend line inside a stat tile.
 *
 * No axes, no labels, no tooltip — a sparkline answers "which way has this been
 * going", and anything more turns a glyph back into a chart. The number beside
 * it carries the value; the delta carries the movement.
 *
 * The line is drawn in a de-emphasised step of the series hue with only the
 * final point in the full accent, so the eye lands on "now" rather than on the
 * middle of the history.
 *
 * `vector-effect="non-scaling-stroke"` is what lets the viewBox stretch to any
 * tile width without the stroke stretching with it — the alternative is a line
 * that is 2px in a narrow tile and 5px in a wide one.
 */
@Component({
  selector: "ui-sparkline",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <svg
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      class="h-8 w-full overflow-visible"
      aria-hidden="true"
    >
      <!-- Area wash first, so the line sits on top of it. -->
      <path [attr.d]="areaPath()" class="fill-chart-1/[0.12]" />
      <path
        [attr.d]="linePath()"
        fill="none"
        class="stroke-chart-1/50"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        vector-effect="non-scaling-stroke"
      />
      <circle
        [attr.cx]="lastPoint().x"
        [attr.cy]="lastPoint().y"
        r="2.5"
        class="fill-chart-1 stroke-surface"
        stroke-width="2"
        vector-effect="non-scaling-stroke"
      />
    </svg>
  `
})
export class SparklineComponent {
  readonly values = input.required<readonly number[]>();

  private readonly points = computed(() => {
    const values = this.values();
    if (values.length < 2) return [{ x: 0, y: 16 }];

    const min = Math.min(...values);
    const max = Math.max(...values);
    // A flat series would divide by zero; drawing it down the middle is the
    // honest rendering of "this did not move".
    const span = max - min || 1;

    return values.map((value, index) => ({
      x: (index / (values.length - 1)) * 100,
      // Inset by 3 top and bottom so the end dot is not clipped by the viewBox.
      y: 29 - ((value - min) / span) * 26
    }));
  });

  protected readonly linePath = computed(() =>
    this.points()
      .map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`)
      .join(" ")
  );

  protected readonly areaPath = computed(() => {
    const points = this.points();
    if (!points.length) return "";
    return `${this.linePath()} L${points[points.length - 1].x} 32 L${points[0].x} 32 Z`;
  });

  protected readonly lastPoint = computed(() => {
    const points = this.points();
    return points[points.length - 1];
  });
}
