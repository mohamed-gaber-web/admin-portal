import {
  ChangeDetectionStrategy,
  Component,
  input,
  model
} from "@angular/core";

export interface Tab {
  id: string;
  label: string;
}

/**
 * A segmented control for switching panels within one screen.
 *
 * Deliberately not routed. These are views of the same page — the Appearance
 * and Security halves of Settings — and giving each its own URL implies a
 * navigation that the browser's back button then has to make good on.
 * When a tab should be linkable, use child routes instead.
 *
 * `model()` rather than an input/output pair so a caller can two-way bind with
 * `[(active)]` or drive it manually, whichever suits.
 */
@Component({
  selector: "ui-tabs",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <div
      role="tablist"
      class="inline-flex items-center gap-1 rounded-xl border border-border bg-surface-muted p-1"
    >
      @for (tab of tabs(); track tab.id) {
        <button
          type="button"
          role="tab"
          [attr.aria-selected]="active() === tab.id"
          [class]="
            'rounded-lg px-3.5 py-1.5 text-sm font-medium transition-all duration-200 ' +
            (active() === tab.id
              ? 'bg-surface text-foreground shadow-sm'
              : 'text-foreground-muted hover:text-foreground')
          "
          (click)="active.set(tab.id)"
        >
          {{ tab.label }}
        </button>
      }
    </div>
  `
})
export class TabsComponent {
  readonly tabs = input.required<readonly Tab[]>();
  readonly active = model.required<string>();
}
