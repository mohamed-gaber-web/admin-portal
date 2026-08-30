import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";
import { IconComponent } from "./icon.component";
import type { SortDirection } from "@core/models";

/**
 * The scroll container and styling for a native table.
 *
 * Deliberately not a generic data-grid. A `<ui-table [columns] [rows]>` has to
 * invent a language for every cell that is not plain text — badges, avatars,
 * row menus, two-line cells — and each screen here has several. Projecting real
 * `<thead>`/`<tbody>` keeps the markup obvious and the type checking real,
 * while this component owns the parts that must not drift: the overflow
 * behaviour, the row rhythm, the header treatment.
 *
 * The horizontal scroll lives here rather than on the page so a wide table
 * scrolls inside its card instead of dragging the whole layout sideways on a
 * phone.
 */
@Component({
  selector: "ui-table",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block w-full overflow-x-auto" },
  template: `
    <table class="w-full min-w-[42rem] border-collapse text-sm">
      <ng-content />
    </table>
  `,
  styles: [
    `
      /* text-start, not text-left, so headers align to the right of the cell in
         Arabic — the most visible thing a table gets wrong under RTL. */
      :host ::ng-deep thead th {
        @apply whitespace-nowrap border-b border-border bg-surface-muted/60 px-4 py-3
          text-start text-xs font-semibold uppercase tracking-wide text-foreground-muted;
      }

      :host ::ng-deep tbody td {
        @apply border-b border-border px-4 py-3 align-middle text-foreground;
      }

      :host ::ng-deep tbody tr {
        @apply transition-colors duration-150;
      }

      :host ::ng-deep tbody tr:hover {
        @apply bg-surface-muted/50;
      }

      /* No rule under the final row: the card's own border already closes it. */
      :host ::ng-deep tbody tr:last-child td {
        @apply border-b-0;
      }
    `
  ]
})
export class TableComponent {}

/**
 * A sortable column header.
 *
 * A real `<button>` inside the `<th>` rather than a click handler on the cell,
 * so the control is reachable by keyboard and announced as something you can
 * press. `aria-sort` on the header is what tells a screen reader the table is
 * currently ordered by this column.
 */
@Component({
  selector: "th[uiSortHeader]",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: {
    "[attr.aria-sort]": "ariaSort()",
    "class": "cursor-pointer select-none"
  },
  template: `
    <span class="inline-flex items-center gap-1.5">
      <ng-content />
      <ui-icon
        [name]="active() && direction() === 'asc' ? 'arrow-up' : 'arrow-down'"
        [size]="13"
        [class]="
          active()
            ? 'text-primary'
            : 'text-foreground-subtle opacity-0 transition-opacity duration-200 group-hover:opacity-60'
        "
      />
    </span>
  `
})
export class SortHeaderComponent {
  readonly active = input(false);
  readonly direction = input<SortDirection>("asc");

  protected readonly ariaSort = computed(() => {
    if (!this.active()) return "none";
    return this.direction() === "asc" ? "ascending" : "descending";
  });
}
