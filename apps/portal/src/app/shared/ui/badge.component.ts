import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";

export type BadgeTone =
  | "neutral"
  | "primary"
  | "success"
  | "warning"
  | "danger"
  | "info";

/**
 * A status pill.
 *
 * Every tone pairs a subtle background with a saturated foreground of the same
 * hue, which keeps text contrast well clear of 4.5:1 in both palettes — a solid
 * fill at badge size does not.
 *
 * The optional dot matters more than it looks: it gives the badge a second
 * channel besides hue, so "active" and "suspended" stay distinguishable to a
 * reader who cannot separate green from red.
 */
@Component({
  selector: "ui-badge",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class]": "classes()" },
  template: `
    @if (dot()) {
      <span class="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true"></span>
    }
    <ng-content />
  `
})
export class BadgeComponent {
  readonly tone = input<BadgeTone>("neutral");
  readonly dot = input(false);

  protected readonly classes = computed(() =>
    [
      "inline-flex items-center gap-1.5 rounded-full border",
      "px-2.5 py-0.5 text-xs font-medium capitalize whitespace-nowrap",
      TONES[this.tone()]
    ].join(" ")
  );
}

const TONES: Record<BadgeTone, string> = {
  neutral:
    "border-border bg-surface-muted text-foreground-muted",
  primary: "border-primary/20 bg-primary-subtle text-primary",
  success: "border-success/20 bg-success-subtle text-success",
  warning: "border-warning/25 bg-warning-subtle text-warning",
  danger: "border-danger/20 bg-danger-subtle text-danger",
  info: "border-info/20 bg-info-subtle text-info"
};
