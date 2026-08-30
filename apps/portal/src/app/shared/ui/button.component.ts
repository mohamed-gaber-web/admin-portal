import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input
} from "@angular/core";
import { SpinnerComponent } from "./spinner.component";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "outline"
  | "danger";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

/**
 * The button.
 *
 * An attribute selector rather than a wrapper element, so `<button uiButton>`
 * keeps everything the native element already does — form submission, the
 * space and enter keys, focus order — instead of a `<ui-button>` that has to
 * reimplement each of them and gets one wrong.
 *
 * Variants exist to rank actions on a screen, not to decorate them: one primary
 * per view, secondary for the rest, ghost for anything in a toolbar or a table
 * row. Two primaries side by side is a design bug the component cannot catch.
 */
@Component({
  selector: "button[uiButton], a[uiButton]",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SpinnerComponent],
  host: {
    "[class]": "classes()",
    "[attr.disabled]": "isDisabled() && isButton ? '' : null",
    "[attr.aria-disabled]": "isDisabled() ? 'true' : null",
    "[attr.aria-busy]": "loading() ? 'true' : null",
    "[attr.tabindex]": "isDisabled() && !isButton ? '-1' : null"
  },
  template: `
    @if (loading()) {
      <ui-spinner [size]="size() === 'lg' ? 18 : 15" />
    }
    <ng-content />
  `
})
export class ButtonComponent {
  readonly variant = input<ButtonVariant>("primary");
  readonly size = input<ButtonSize>("md");
  readonly loading = input(false);
  readonly disabled = input(false);
  /** Stretches the button to its container — for form submits and mobile. */
  readonly block = input(false);

  /**
   * `disabled` is a real attribute on <button> and meaningless on <a>. Setting
   * it on an anchor would do nothing while looking like it had, so anchors get
   * `aria-disabled` plus the pointer-events rule in BASE instead.
   */
  protected readonly isButton =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement.tagName === "BUTTON";

  protected readonly isDisabled = computed(() => this.disabled() || this.loading());

  protected readonly classes = computed(() => {
    return [
      BASE,
      SIZES[this.size()],
      VARIANTS[this.variant()],
      this.block() ? "w-full" : ""
    ]
      .filter(Boolean)
      .join(" ");
  });
}

const BASE = [
  "inline-flex items-center justify-center gap-2",
  "rounded-xl font-medium whitespace-nowrap select-none",
  "transition-all duration-200",
  // `active:scale` is the whole micro-interaction: a 1% dip on press reads as
  // physical without moving anything around it.
  "active:scale-[0.98]",
  "disabled:pointer-events-none disabled:opacity-50",
  "aria-disabled:pointer-events-none aria-disabled:opacity-50"
].join(" ");

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
  lg: "h-11 px-5 text-sm",
  // Square, for a lone icon. Anything with a label should use a sized variant
  // so the text has room to breathe.
  icon: "h-9 w-9 p-0"
};

/**
 * The sheen.
 *
 * A hairline white gradient over the fill, not a gradient *between* two brand
 * colours. A two-stop brand gradient has to be redefined per theme — in dark
 * mode `primary-hover` is *lighter* than `primary`, so the same top-to-bottom
 * ramp lights the wrong edge — whereas a translucent overlay reads correctly
 * over any fill in either palette.
 */
const SHEEN = "bg-gradient-to-b from-white/[0.14] to-transparent";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: `bg-primary ${SHEEN} text-primary-foreground shadow-primary hover:bg-primary-hover`,
  secondary:
    "border border-border bg-surface-muted text-foreground shadow-card hover:bg-surface-hover hover:border-border-strong",
  outline:
    "border border-border bg-surface text-foreground shadow-card hover:bg-surface-muted hover:border-border-strong",
  ghost: "text-foreground-muted hover:bg-surface-muted hover:text-foreground",
  danger: `bg-danger ${SHEEN} text-danger-foreground shadow-card hover:bg-danger-hover`
};
