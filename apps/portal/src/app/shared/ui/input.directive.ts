import { Directive, computed, input } from "@angular/core";

/**
 * Styling for native form controls.
 *
 * A directive rather than a component, so the element stays a real `<input>`.
 * That keeps `formControlName`, `ngModel`, `type`, autofill, browser
 * validation and the mobile keyboard hints working without this file knowing
 * anything about them — all of which a wrapper component would have to proxy.
 *
 * `<select>` gets its own selector for the arrow and the padding it needs to
 * clear it; everything else about the two is shared.
 */
@Directive({
  selector: "input[uiInput], textarea[uiInput]",
  standalone: true,
  host: {
    "[class]": "classes()",
    "[attr.aria-invalid]": "invalid() ? 'true' : null"
  }
})
export class InputDirective {
  readonly invalid = input(false);

  protected readonly classes = computed(() =>
    [CONTROL_BASE, this.invalid() ? INVALID : VALID].join(" ")
  );
}

@Directive({
  selector: "select[uiSelect]",
  standalone: true,
  host: {
    "[class]": "classes()",
    "[attr.aria-invalid]": "invalid() ? 'true' : null"
  }
})
export class SelectDirective {
  readonly invalid = input(false);

  protected readonly classes = computed(() =>
    [
      CONTROL_BASE,
      this.invalid() ? INVALID : VALID,
      // `appearance-none` plus a background arrow, because the native control
      // renders in the OS's colours and cannot be talked out of them — which
      // means a white dropdown wedged into a dark page.
      //
      // `pe-9` reserves the room logically, but `background-position` has no
      // logical equivalent — it is the one place here that needs an explicit
      // `rtl:` variant rather than a logical property.
      "appearance-none bg-no-repeat pe-9",
      "bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%2394a3b8%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22%3E%3Cpath d=%22m6 9 6 6 6-6%22/%3E%3C/svg%3E')]",
      "bg-[length:16px_16px] bg-[right_0.65rem_center] rtl:bg-[left_0.65rem_center]"
    ].join(" ")
  );
}

const CONTROL_BASE = [
  "block w-full rounded-xl border bg-surface px-3.5 py-2.5",
  "text-sm text-foreground placeholder:text-foreground-subtle",
  "transition-all duration-200",
  "focus:outline-none focus-visible:outline-none",
  "disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-60"
].join(" ");

/**
 * The focus treatment is a ring *and* a border change, not a ring alone: at the
 * 1px border weight this UI uses, a ring on its own is easy to miss against a
 * busy form.
 */
const VALID = [
  "border-border hover:border-border-strong",
  "focus:border-primary focus:ring-2 focus:ring-primary/25"
].join(" ");

const INVALID = [
  "border-danger",
  "focus:border-danger focus:ring-2 focus:ring-danger/25"
].join(" ");
