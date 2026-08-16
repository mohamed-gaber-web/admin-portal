import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";
import { IconComponent, type IconName } from "./icon.component";

export type AlertTone = "info" | "success" | "warning" | "danger";

/**
 * An inline message attached to the thing it is about.
 *
 * Where a toast is for something already finished, an alert stays put — form
 * errors, a warning about what a destructive action will do, a note that a
 * feature is not wired up yet. It does not time out, because the reader may
 * need it while they type.
 *
 * `role="alert"` only on the two tones that report a problem: the role
 * interrupts a screen reader mid-sentence, which is right for a failure and
 * rude for a hint.
 */
@Component({
  selector: "ui-alert",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: {
    "[class]": "classes()",
    "[attr.role]": "isProblem() ? 'alert' : 'note'"
  },
  template: `
    <ui-icon [name]="icon()" [size]="18" class="mt-px shrink-0" />
    <div class="min-w-0 space-y-1">
      @if (title()) {
        <p class="text-sm font-semibold">{{ title() }}</p>
      }
      <div class="text-sm leading-relaxed opacity-90"><ng-content /></div>
    </div>
  `
})
export class AlertComponent {
  readonly tone = input<AlertTone>("info");
  readonly title = input<string>();

  protected readonly isProblem = computed(
    () => this.tone() === "danger" || this.tone() === "warning"
  );

  protected readonly icon = computed<IconName>(() => ICONS[this.tone()]);

  protected readonly classes = computed(() =>
    [
      "flex items-start gap-3 rounded-xl border px-4 py-3 animate-fade-in",
      TONES[this.tone()]
    ].join(" ")
  );
}

const ICONS: Record<AlertTone, IconName> = {
  info: "info",
  success: "check-circle",
  warning: "warning",
  danger: "error"
};

const TONES: Record<AlertTone, string> = {
  info: "border-info/25 bg-info-subtle text-info",
  success: "border-success/25 bg-success-subtle text-success",
  warning: "border-warning/30 bg-warning-subtle text-warning",
  danger: "border-danger/25 bg-danger-subtle text-danger"
};
