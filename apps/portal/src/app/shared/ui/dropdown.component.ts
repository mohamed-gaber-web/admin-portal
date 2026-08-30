import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  signal
} from "@angular/core";

export type DropdownAlign = "start" | "end";

/**
 * A menu hung off a trigger.
 *
 * The trigger goes in the default slot, the menu items in `[dropdownMenu]`.
 * Both live inside this element so a click anywhere within counts as inside —
 * which is how the outside-click check stays a single containment test rather
 * than a list of exceptions.
 *
 * Positioned with plain absolute layout, not a floating-element library. The
 * menus in this app hang off a topbar or a table row and never need collision
 * detection; when one does, that is the moment to reach for a real positioner,
 * not before.
 */
@Component({
  selector: "ui-dropdown",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: "relative inline-block",
    "(document:click)": "onDocumentClick($event)",
    "(keydown.escape)": "close()"
  },
  template: `
    <div (click)="toggle()">
      <ng-content />
    </div>

    @if (isOpen()) {
      <div
        role="menu"
        [class]="menuClasses()"
        (click)="close()"
      >
        <ng-content select="[dropdownMenu]" />
      </div>
    }
  `
})
export class DropdownComponent {
  readonly align = input<DropdownAlign>("end");
  /** Tailwind width utility for the panel. */
  readonly width = input("w-56");

  private readonly open = signal(false);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly isOpen = this.open.asReadonly();

  toggle(): void {
    this.open.update((current) => !current);
  }

  close(): void {
    this.open.set(false);
  }

  protected onDocumentClick(event: Event): void {
    if (!this.open()) return;
    const target = event.target as Node | null;
    // `contains` rather than a ref equality check, so a click on an icon inside
    // the trigger still counts as a click on the trigger.
    if (target && !this.host.nativeElement.contains(target)) this.close();
  }

  protected readonly menuClasses = computed(() =>
    [
      "absolute top-[calc(100%+0.5rem)] z-40",
      // Logical, so "end" is the left edge in Arabic — a menu pinned to `right`
      // would hang off the wrong side of its trigger under RTL.
      this.align() === "end" ? "end-0" : "start-0",
      this.width(),
      "raised overflow-hidden rounded-xl border border-border bg-surface p-1.5",
      "shadow-popover animate-slide-up"
    ].join(" ")
  );
}

/**
 * One row in a dropdown menu.
 *
 * An attribute on a real `<button>` or `<a>`, so menu items are focusable and
 * activate on Enter without this component owning a keyboard model.
 */
@Component({
  selector: "button[uiMenuItem], a[uiMenuItem]",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class]": "classes()", role: "menuitem" },
  template: `<ng-content />`
})
export class MenuItemComponent {
  readonly tone = input<"default" | "danger">("default");

  protected readonly classes = computed(() =>
    [
      "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2",
      "text-start text-sm transition-colors duration-150",
      this.tone() === "danger"
        ? "text-danger hover:bg-danger-subtle"
        : "text-foreground-muted hover:bg-surface-muted hover:text-foreground"
    ].join(" ")
  );
}
