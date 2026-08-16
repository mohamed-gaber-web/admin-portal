import { ChangeDetectionStrategy, Component, input } from "@angular/core";

/**
 * The title block every screen opens with.
 *
 * One component so the h1 size, the description colour and the gap to the
 * content below are decided once. Left to each page these drift within a
 * release or two, and the drift is the kind nobody reports but everybody feels.
 *
 * Actions project into the right-hand slot and wrap beneath the title on narrow
 * screens rather than squeezing it.
 */
@Component({
  selector: "app-page-header",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: "mb-6 flex flex-wrap items-start justify-between gap-4"
  },
  template: `
    <div class="min-w-0 space-y-1">
      <h1 class="text-2xl font-semibold tracking-tight text-foreground">
        {{ title() }}
      </h1>
      @if (description()) {
        <p class="max-w-2xl text-sm text-foreground-muted">{{ description() }}</p>
      }
    </div>

    <div class="flex shrink-0 flex-wrap items-center gap-2">
      <ng-content />
    </div>
  `
})
export class PageHeaderComponent {
  readonly title = input.required<string>();
  readonly description = input<string>();
}
