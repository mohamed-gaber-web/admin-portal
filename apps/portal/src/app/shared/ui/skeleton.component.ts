import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";

/**
 * A placeholder in the shape of the content that is coming.
 *
 * Sized by the caller in the shape of the real thing — a skeleton that does not
 * match the layout it replaces causes the page to jump when data lands, which
 * is the one thing a skeleton exists to prevent.
 *
 * `aria-hidden`, because a screen reader announcing a row of grey boxes is
 * noise; the region that owns the skeleton carries `aria-busy` instead.
 */
@Component({
  selector: "ui-skeleton",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class]": "classes()", "aria-hidden": "true" },
  template: ""
})
export class SkeletonComponent {
  /** Any Tailwind height/width/radius utilities — `h-4 w-32`, `h-10 w-10 rounded-full`. */
  readonly shape = input("h-4 w-full");

  protected readonly classes = computed(() => `skeleton block ${this.shape()}`);
}
