import {
  ChangeDetectionStrategy,
  Component,
  input,
  output
} from "@angular/core";
import { injectT } from "@core/i18n/i18n.service";
import { ButtonComponent } from "./button.component";
import { IconComponent } from "./icon.component";

/**
 * "This did not load."
 *
 * Always offers a retry. A failed request in an admin portal is far more often
 * a dropped connection or a restarting API than anything the user did, and a
 * dead end forces a full page reload to recover from something a single click
 * would have fixed.
 *
 * The message shown is the one `ApiError` normalised — server wording when the
 * server gave any, a plain sentence when it did not, and never a raw stack or
 * a bare status code.
 */
@Component({
  selector: "ui-error-state",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent],
  host: {
    class:
      "flex flex-col items-center justify-center gap-3 px-6 py-14 text-center animate-fade-in",
    role: "alert"
  },
  template: `
    <div
      class="flex h-12 w-12 items-center justify-center rounded-2xl bg-danger-subtle text-danger"
    >
      <ui-icon name="warning" [size]="22" />
    </div>

    <div class="space-y-1">
      <p class="text-sm font-semibold text-foreground">
        {{ title() ?? t("common.somethingWentWrong") }}
      </p>
      <p class="mx-auto max-w-sm text-sm text-foreground-muted">
        {{ message() }}
      </p>
    </div>

    <button uiButton variant="outline" size="sm" class="mt-1" (click)="retry.emit()">
      <ui-icon name="refresh" [size]="15" />
      {{ t("common.tryAgain") }}
    </button>
  `
})
export class ErrorStateComponent {
  /**
   * Optional. Left unset, it falls back to the generic heading in the caller's
   * language — a default of `"Something went wrong"` would have hard-coded
   * English into every screen that did not pass one.
   */
  readonly title = input<string | null>(null);
  readonly message = input.required<string>();
  readonly retry = output<void>();

  protected readonly t = injectT();
}
