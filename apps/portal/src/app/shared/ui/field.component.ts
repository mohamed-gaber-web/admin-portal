import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";

let nextFieldId = 0;

/**
 * Label, control, and whatever the control has to say for itself.
 *
 * The point is the wiring, not the spacing: the label's `for`, the hint's and
 * error's ids, and the `aria-describedby` that ties them together are easy to
 * get subtly wrong by hand and invisible when you do — the form looks correct
 * and simply says nothing useful to a screen reader.
 *
 * Hint and error never show together. Once a field is wrong, the correction is
 * the only thing worth reading; leaving the hint underneath it doubles the text
 * at the moment the reader has least patience for it.
 */
@Component({
  selector: "ui-field",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block space-y-1.5" },
  template: `
    <div class="flex items-baseline justify-between gap-3">
      <label [attr.for]="controlId()" class="text-sm font-medium text-foreground">
        {{ label() }}
        @if (required()) {
          <span class="text-danger" aria-hidden="true">*</span>
        }
      </label>
      <ng-content select="[fieldAction]" />
    </div>

    <ng-content />

    @if (error()) {
      <p [id]="messageId()" class="text-xs font-medium text-danger">
        {{ error() }}
      </p>
    } @else if (hint()) {
      <p [id]="messageId()" class="text-xs text-foreground-subtle">{{ hint() }}</p>
    }
  `
})
export class FieldComponent {
  readonly label = input.required<string>();
  readonly hint = input<string>();
  readonly error = input<string | null>(null);
  readonly required = input(false);

  /**
   * Id of the control this labels.
   *
   * Defaulted rather than required so a field is never silently unlabelled;
   * pass your own when the control already has an id you control.
   */
  readonly controlId = input(`field-${nextFieldId++}`);

  protected readonly messageId = computed(() => `${this.controlId()}-message`);
}
