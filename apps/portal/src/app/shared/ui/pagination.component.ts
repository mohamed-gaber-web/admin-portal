import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output
} from "@angular/core";
import { I18nService, injectT } from "@core/i18n/i18n.service";
import { ButtonComponent } from "./button.component";
import { IconComponent } from "./icon.component";

/**
 * Page controls for a list.
 *
 * Shows the range in words ("1–10 of 47") as well as the page buttons, because
 * "page 3 of 5" does not answer the question people actually have, which is how
 * much is left.
 *
 * Hidden entirely when everything fits on one page — a pagination bar with a
 * single disabled button is clutter that implies there is more to see.
 */
@Component({
  selector: "ui-pagination",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent],
  host: { class: "block" },
  template: `
    @if (totalPages() > 1) {
      <nav
        class="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3"
        [attr.aria-label]="t('common.previousPage')"
      >
        <!-- One sentence with the numbers interpolated, not three fragments
             concatenated in the template. Arabic puts them in a different
             order, and a split sentence cannot be reordered by a translator. -->
        <p class="text-xs text-foreground-muted">{{ rangeLabel() }}</p>

        <div class="flex items-center gap-1">
          <button
            uiButton
            variant="ghost"
            size="icon"
            type="button"
            [attr.aria-label]="t('common.previousPage')"
            [disabled]="page() <= 1"
            (click)="goTo(page() - 1)"
          >
            <ui-icon name="chevron-left" [size]="16" />
          </button>

          @for (entry of pages(); track $index) {
            @if (entry === null) {
              <span class="px-1.5 text-sm text-foreground-subtle" aria-hidden="true">…</span>
            } @else {
              <button
                uiButton
                [variant]="entry === page() ? 'primary' : 'ghost'"
                size="icon"
                type="button"
                [attr.aria-current]="entry === page() ? 'page' : null"
                (click)="goTo(entry)"
              >
                {{ entry }}
              </button>
            }
          }

          <button
            uiButton
            variant="ghost"
            size="icon"
            type="button"
            [attr.aria-label]="t('common.nextPage')"
            [disabled]="page() >= totalPages()"
            (click)="goTo(page() + 1)"
          >
            <ui-icon name="chevron-right" [size]="16" />
          </button>
        </div>
      </nav>
    }
  `
})
export class PaginationComponent {
  readonly page = input.required<number>();
  readonly pageSize = input.required<number>();
  readonly total = input.required<number>();
  readonly pageChange = output<number>();

  protected readonly t = injectT();
  private readonly i18n = inject(I18nService);

  /** Numbers formatted for the locale, so the digit system matches the text. */
  protected readonly rangeLabel = computed(() =>
    this.t("common.showingRange", {
      start: this.i18n.formatNumber(this.rangeStart()),
      end: this.i18n.formatNumber(this.rangeEnd()),
      total: this.i18n.formatNumber(this.total())
    })
  );

  protected readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.total() / this.pageSize()))
  );

  protected readonly rangeStart = computed(() =>
    this.total() === 0 ? 0 : (this.page() - 1) * this.pageSize() + 1
  );

  protected readonly rangeEnd = computed(() =>
    Math.min(this.page() * this.pageSize(), this.total())
  );

  /**
   * Page numbers to render, with `null` standing for a gap.
   *
   * Always first and last, always the current page and its neighbours,
   * ellipses for the rest — so the control keeps a fixed width instead of
   * growing a hundred buttons wide on a long list.
   */
  protected readonly pages = computed<(number | null)[]>(() => {
    const last = this.totalPages();
    const current = this.page();

    if (last <= 7) {
      return Array.from({ length: last }, (_, index) => index + 1);
    }

    const middle = [current - 1, current, current + 1].filter(
      (candidate) => candidate > 1 && candidate < last
    );

    const result: (number | null)[] = [1];
    if (middle[0] > 2) result.push(null);
    result.push(...middle);
    if (middle[middle.length - 1] < last - 1) result.push(null);
    result.push(last);
    return result;
  });

  protected goTo(page: number): void {
    if (page < 1 || page > this.totalPages() || page === this.page()) return;
    this.pageChange.emit(page);
  }
}
