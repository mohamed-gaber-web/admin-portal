import { DOCUMENT } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  viewChild
} from "@angular/core";
import { injectT } from "@core/i18n/i18n.service";
import { ButtonComponent } from "./button.component";
import { IconComponent } from "./icon.component";

export type ModalSize = "sm" | "md" | "lg";

/**
 * A modal dialog.
 *
 * Render it conditionally — `@if (isOpen()) { <ui-modal …> }` — rather than
 * keeping it mounted and hidden, so its content is genuinely absent from the
 * accessibility tree and its form state resets between openings.
 *
 * What it takes care of, because each is a thing dialogs routinely get wrong:
 * Escape closes it; a click on the backdrop closes it but a click inside does
 * not; focus moves into the panel on open and returns to whatever opened it on
 * close; Tab cycles within the panel instead of wandering into the page behind;
 * and the page behind cannot scroll while it is up.
 */
@Component({
  selector: "ui-modal",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent],
  host: {
    class: "fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center",
    "(keydown.escape)": "requestClose()",
    "(document:keydown.Tab)": "trapFocus($event)"
  },
  template: `
    <!-- Backdrop. Its own element so the panel is not a child of the click target. -->
    <div
      class="absolute inset-0 bg-slate-950/40 backdrop-blur-[2px] animate-fade-in dark:bg-slate-950/70"
      (click)="requestClose()"
      aria-hidden="true"
    ></div>

    <div
      #panel
      role="dialog"
      aria-modal="true"
      [attr.aria-labelledby]="titleId"
      tabindex="-1"
      [class]="panelClasses()"
    >
      <header class="flex items-start justify-between gap-4 p-6 pb-4">
        <div class="min-w-0 space-y-1">
          <h2 [id]="titleId" class="text-base font-semibold text-foreground">
            {{ title() }}
          </h2>
          @if (description()) {
            <p class="text-sm text-foreground-muted">{{ description() }}</p>
          }
        </div>
        <button
          uiButton
          variant="ghost"
          size="icon"
          type="button"
          [attr.aria-label]="t('common.close')"
          (click)="requestClose()"
        >
          <ui-icon name="close" [size]="18" />
        </button>
      </header>

      <div class="max-h-[65vh] overflow-y-auto px-6 pb-2">
        <ng-content />
      </div>

      <!-- empty:hidden, so a dialog with no actions has no empty bar. -->
      <footer
        class="flex flex-wrap items-center justify-end gap-2 p-6 pt-4 empty:hidden"
      >
        <ng-content select="[modalFooter]" />
      </footer>
    </div>
  `
})
export class ModalComponent {
  readonly title = input.required<string>();
  readonly description = input<string>();
  readonly size = input<ModalSize>("md");
  readonly closed = output<void>();

  protected readonly t = injectT();
  protected readonly titleId = `modal-title-${nextModalId++}`;

  private readonly panel = viewChild.required<ElementRef<HTMLElement>>("panel");
  private readonly document = inject(DOCUMENT);
  private readonly openedBy = this.document.activeElement as HTMLElement | null;

  constructor() {
    effect((onCleanup) => {
      const panel = this.panel().nativeElement;
      // Prefer the first control, falling back to the panel itself, so a
      // keyboard user starts inside the dialog rather than at the top of the
      // page behind it.
      (focusableWithin(panel)[0] ?? panel).focus();

      const body = this.document.body;
      const previousOverflow = body.style.overflow;
      body.style.overflow = "hidden";

      onCleanup(() => {
        body.style.overflow = previousOverflow;
        // Returning focus is what makes a dialog feel like a detour rather
        // than a teleport — without it focus resets to <body> and the next Tab
        // starts from the top of the page.
        this.openedBy?.focus?.();
      });
    });
  }

  protected requestClose(): void {
    this.closed.emit();
  }

  protected trapFocus(event: KeyboardEvent): void {
    const focusable = focusableWithin(this.panel().nativeElement);
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = this.document.activeElement;

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  protected readonly panelClasses = computed(() =>
    [
      "raised relative z-10 w-full rounded-2xl border border-border bg-surface shadow-modal",
      "animate-slide-up focus:outline-none",
      SIZES[this.size()]
    ].join(" ")
  );
}

let nextModalId = 0;

const SIZES: Record<ModalSize, string> = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl"
};

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.offsetParent !== null
  );
}
