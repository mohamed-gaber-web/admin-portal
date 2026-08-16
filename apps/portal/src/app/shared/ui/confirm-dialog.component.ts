import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal
} from "@angular/core";
import { injectT } from "@core/i18n/i18n.service";
import { AlertComponent } from "./alert.component";
import { ButtonComponent } from "./button.component";
import { FieldComponent } from "./field.component";
import { InputDirective } from "./input.directive";
import { ModalComponent } from "./modal.component";

/**
 * A confirmation before something the user cannot easily undo.
 *
 * `confirmPhrase` turns it into a type-to-confirm dialog. That friction is
 * deliberate and belongs only on genuinely destructive actions: its value is
 * that it cannot be dismissed by reflex, which is exactly what happens to a
 * plain "are you sure" the fiftieth time someone sees it. Used everywhere it
 * stops working, so most confirmations should leave it unset.
 *
 * The phrase is the thing being acted on — a tenant slug, a workspace name —
 * so typing it also forces a last look at *which* row this is.
 */
@Component({
  selector: "ui-confirm-dialog",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AlertComponent,
    ButtonComponent,
    FieldComponent,
    InputDirective,
    ModalComponent
  ],
  template: `
    <ui-modal [title]="title()" [description]="description()" (closed)="cancelled.emit()">
      <div class="space-y-4">
        @if (warning()) {
          <ui-alert tone="danger">{{ warning() }}</ui-alert>
        }

        <ng-content />

        @if (confirmPhrase(); as phrase) {
          <ui-field
            [label]="t('confirm.typeToConfirm', { phrase })"
            controlId="confirm-phrase"
            [required]="true"
          >
            <input
              uiInput
              id="confirm-phrase"
              autocomplete="off"
              spellcheck="false"
              class="font-mono"
              dir="ltr"
              [value]="typed()"
              (input)="onType($event)"
            />
          </ui-field>
        }
      </div>

      <div modalFooter>
        <button uiButton variant="ghost" type="button" (click)="cancelled.emit()">
          {{ t("common.cancel") }}
        </button>
        <button
          uiButton
          [variant]="tone()"
          type="button"
          [loading]="busy()"
          [disabled]="!canConfirm()"
          (click)="confirmed.emit()"
        >
          {{ confirmLabel() }}
        </button>
      </div>
    </ui-modal>
  `
})
export class ConfirmDialogComponent {
  readonly title = input.required<string>();
  readonly description = input<string>();
  readonly warning = input<string>();
  readonly confirmLabel = input.required<string>();
  readonly tone = input<"primary" | "danger">("danger");
  readonly busy = input(false);
  /** Set to require the user to type this exactly before confirming. */
  readonly confirmPhrase = input<string>();

  readonly confirmed = output<void>();
  readonly cancelled = output<void>();

  protected readonly t = injectT();
  protected readonly typed = signal("");

  protected readonly canConfirm = computed(() => {
    if (this.busy()) return false;
    const phrase = this.confirmPhrase();
    // Compared exactly, not case-insensitively. A slug is lowercase by schema
    // rule, so a loose match would accept something the system never stores.
    return !phrase || this.typed() === phrase;
  });

  protected onType(event: Event): void {
    this.typed.set((event.target as HTMLInputElement).value);
  }
}
