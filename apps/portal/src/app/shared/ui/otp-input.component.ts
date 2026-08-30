import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  model,
  output,
  viewChildren
} from "@angular/core";

/**
 * True when every slot holds a digit.
 *
 * Use this rather than checking `value.length`. The value is space-padded while
 * it is being filled, so a partially-entered code can be the full length —
 * length says how many slots exist, never how many are filled.
 */
export function isOtpComplete(value: string, length = 6): boolean {
  return value.length === length && /^\d+$/.test(value);
}

/**
 * A one-time-code field, rendered as separate boxes.
 *
 * Six inputs rather than one, because a segmented field makes the expected
 * length obvious before anything is typed and makes a mistyped digit findable
 * afterwards. The cost is that the browser's own paste and autofill behaviour
 * has to be reimplemented, which is the bulk of what is below.
 *
 * `inputmode="numeric"` opens the number pad on a phone; `autocomplete="one-time-code"`
 * lets iOS and Android offer the code straight from the SMS or authenticator
 * notification, which is the single biggest usability win available here.
 *
 * Deliberately **not** direction-aware. A one-time code is a number, and
 * numbers read left-to-right in Arabic too — mirroring the boxes would have the
 * first digit typed on the right and reverse the value.
 */
@Component({
  selector: "ui-otp-input",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <div class="flex justify-center gap-2" dir="ltr">
      @for (slot of slots(); track $index) {
        <input
          #box
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength="1"
          [attr.aria-label]="label() + ' ' + ($index + 1)"
          [value]="digitAt($index)"
          [disabled]="disabled()"
          [class]="boxClass()"
          (input)="onInput($event, $index)"
          (keydown)="onKeydown($event, $index)"
          (paste)="onPaste($event)"
          (focus)="selectAll($event)"
        />
      }
    </div>
  `
})
export class OtpInputComponent {
  readonly length = input(6);
  readonly disabled = input(false);
  readonly invalid = input(false);
  readonly label = input("Digit");

  readonly value = model("");
  /** Fires once the last box is filled, so the form can submit without a click. */
  readonly completed = output<string>();

  private readonly boxes = viewChildren<ElementRef<HTMLInputElement>>("box");

  protected slots(): number[] {
    return Array.from({ length: this.length() }, (_, index) => index);
  }

  protected digitAt(index: number): string {
    return (this.value()[index] ?? "").trim();
  }

  protected boxClass(): string {
    return [
      "h-12 w-11 rounded-xl border text-center text-lg font-semibold tabular-nums",
      "bg-surface text-foreground transition-all duration-200",
      "focus:outline-none focus:ring-2",
      this.invalid()
        ? "border-danger focus:border-danger focus:ring-danger/25"
        : "border-border hover:border-border-strong focus:border-primary focus:ring-primary/25",
      "disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-60"
    ].join(" ");
  }

  protected onInput(event: Event, index: number): void {
    const element = event.target as HTMLInputElement;
    const digit = element.value.replace(/\D/g, "").slice(-1);

    // Rewriting the element's value keeps it in step with the model even when
    // the character was rejected — otherwise a typed letter lingers on screen.
    element.value = digit;
    this.write(index, digit);

    if (digit) this.focusAt(index + 1);
  }

  protected onKeydown(event: KeyboardEvent, index: number): void {
    if (event.key === "Backspace") {
      event.preventDefault();
      // Backspace on an empty box steps back and clears the previous one, which
      // is what people expect from a segmented field.
      if (this.digitAt(index)) {
        this.write(index, "");
      } else if (index > 0) {
        this.write(index - 1, "");
        this.focusAt(index - 1);
      }
      return;
    }

    if (event.key === "ArrowLeft" && index > 0) {
      event.preventDefault();
      this.focusAt(index - 1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      this.focusAt(index + 1);
    }
  }

  /** A pasted code fills every box, which is how most people enter one. */
  protected onPaste(event: ClipboardEvent): void {
    const pasted = event.clipboardData?.getData("text") ?? "";
    const digits = pasted.replace(/\D/g, "").slice(0, this.length());
    if (!digits) return;

    event.preventDefault();
    this.value.set(digits);
    this.syncBoxes();
    this.focusAt(digits.length);
    this.emitIfComplete(digits);
  }

  protected selectAll(event: FocusEvent): void {
    (event.target as HTMLInputElement).select();
  }

  private write(index: number, digit: string): void {
    const characters = this.value().padEnd(this.length(), " ").split("");
    characters[index] = digit || " ";
    // Kept padded rather than trimmed. Trimming made the value's length depend
    // on *which* box was filled — one digit typed into the last box produced
    // "     1", which is six characters long and not a six-digit code. Callers
    // that gated on `length` then accepted it. Padding keeps the length
    // constant and useless as a completeness signal, which is the point.
    const next = characters.join("");
    this.value.set(next);
    this.syncBoxes();
    this.emitIfComplete(next);
  }

  private emitIfComplete(value: string): void {
    if (isOtpComplete(value, this.length())) this.completed.emit(value);
  }

  /** Pushes the model back into the DOM after a paste or a multi-box change. */
  private syncBoxes(): void {
    const boxes = this.boxes();
    for (let index = 0; index < boxes.length; index++) {
      boxes[index].nativeElement.value = this.digitAt(index).trim();
    }
  }

  private focusAt(index: number): void {
    const boxes = this.boxes();
    const target = boxes[Math.min(Math.max(index, 0), boxes.length - 1)];
    target?.nativeElement.focus();
  }
}
