import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";

/**
 * The container everything on a page sits in.
 *
 * Elevation comes from the border first and the shadow second. On a dark
 * palette a shadow is nearly invisible — there is no lighter ground for it to
 * fall on — so a card that leans on shadow alone dissolves into the page the
 * moment the theme flips. The border carries it in both.
 */
@Component({
  selector: "ui-card",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class]": "classes()" },
  template: `<ng-content />`
})
export class CardComponent {
  /** Lifts on hover. Only for cards that are themselves a link or a button. */
  readonly interactive = input(false);
  readonly padded = input(true);

  protected readonly classes = computed(() =>
    [
      // `raised` adds the top-edge light catch that makes a dark-mode panel
      // read as raised, where a shadow alone cannot.
      "raised block rounded-2xl border border-border bg-surface shadow-card",
      this.padded() ? "p-6" : "",
      this.interactive()
        ? "transition-all duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-popover cursor-pointer"
        : ""
    ]
      .filter(Boolean)
      .join(" ")
  );
}

/**
 * A card's heading block: title on the left, actions on the right.
 *
 * Split out so the title/description pairing and its spacing are decided once.
 * Left to each screen, headers drift — some `text-base`, some `text-lg`, some
 * with the description above the title.
 */
@Component({
  selector: "ui-card-header",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "flex items-start justify-between gap-4" },
  template: `
    <div class="min-w-0 space-y-1">
      <h2 class="text-base font-semibold leading-tight text-foreground">
        {{ title() }}
      </h2>
      @if (description()) {
        <p class="text-sm text-foreground-muted">{{ description() }}</p>
      }
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <ng-content />
    </div>
  `
})
export class CardHeaderComponent {
  readonly title = input.required<string>();
  readonly description = input<string>();
}
