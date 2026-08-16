import { ChangeDetectionStrategy, Component, input } from "@angular/core";
import { IconComponent, type IconName } from "./icon.component";

/**
 * "There is nothing here."
 *
 * Distinct from the error state on purpose: empty means the request worked and
 * the answer was zero rows, which is a normal outcome that usually wants an
 * invitation to create the first one. Showing an error face for an empty list
 * teaches people to distrust a working screen.
 *
 * Two flavours worth keeping apart in the copy you pass: a genuinely empty
 * collection ("No tenants yet") and a filter that matched nothing ("No tenants
 * match 'acme'") — the second needs a way back out, not a create button.
 */
@Component({
  selector: "ui-empty-state",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: {
    class:
      "flex flex-col items-center justify-center gap-3 px-6 py-14 text-center animate-fade-in"
  },
  template: `
    <div
      class="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-muted text-foreground-subtle"
    >
      <ui-icon [name]="icon()" [size]="22" />
    </div>

    <div class="space-y-1">
      <p class="text-sm font-semibold text-foreground">{{ title() }}</p>
      @if (description()) {
        <p class="mx-auto max-w-sm text-sm text-foreground-muted">
          {{ description() }}
        </p>
      }
    </div>

    <!-- Actions, if the caller has one to offer. -->
    <div class="mt-1 flex items-center gap-2 empty:hidden">
      <ng-content />
    </div>
  `
})
export class EmptyStateComponent {
  readonly icon = input<IconName>("inbox");
  readonly title = input.required<string>();
  readonly description = input<string>();
}
