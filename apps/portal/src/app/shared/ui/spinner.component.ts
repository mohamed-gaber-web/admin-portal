import { ChangeDetectionStrategy, Component, input } from "@angular/core";
import { injectT } from "@core/i18n/i18n.service";

/**
 * An indeterminate progress indicator.
 *
 * Use it for an action already in flight — a submitting form, a refreshing
 * table. For content that has not arrived yet, prefer a skeleton: a spinner
 * says "wait", a skeleton says "wait, and here is the shape of what is coming",
 * which is the less jarring of the two when the layout then fills in.
 */
@Component({
  selector: "ui-spinner",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "inline-flex" },
  template: `
    <svg
      [attr.width]="size()"
      [attr.height]="size()"
      viewBox="0 0 24 24"
      fill="none"
      class="animate-spin"
      [attr.aria-label]="label() ?? t('common.loading')"
      role="status"
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        stroke-width="2.5"
        class="opacity-20"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
      />
    </svg>
  `
})
export class SpinnerComponent {
  readonly size = input(16);
  /** Falls back to the translated default rather than hard-coding English. */
  readonly label = input<string | null>(null);

  protected readonly t = injectT();
}
