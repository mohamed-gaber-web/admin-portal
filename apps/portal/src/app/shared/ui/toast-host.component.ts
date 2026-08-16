import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { injectT } from "@core/i18n/i18n.service";
import { ToastService, type ToastTone } from "@core/notifications/toast.service";
import { IconComponent, type IconName } from "./icon.component";

/**
 * Where toasts appear. Mounted once, in the root component.
 *
 * `aria-live="polite"` on the container rather than on each toast: the region
 * has to exist in the DOM before the message is inserted into it, or the
 * announcement is missed. Polite, not assertive, because a toast reports
 * something that already succeeded and should not cut off whatever the reader
 * is in the middle of.
 */
@Component({
  selector: "ui-toast-host",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: {
    // `end-4` rather than `right-4`: toasts belong in the trailing corner, which
    // is the left one in Arabic.
    class:
      "pointer-events-none fixed bottom-4 end-4 z-[60] flex w-full max-w-sm flex-col gap-2",
    "aria-live": "polite",
    "aria-atomic": "false"
  },
  template: `
    @for (toast of toasts.toasts(); track toast.id) {
      <div
        class="raised pointer-events-auto flex items-start gap-3 rounded-xl border border-border bg-surface p-3.5 shadow-popover animate-slide-up"
      >
        <span [class]="'mt-px shrink-0 ' + TONE_TEXT[toast.tone]">
          <ui-icon [name]="TONE_ICON[toast.tone]" [size]="18" />
        </span>

        <div class="min-w-0 flex-1 space-y-0.5">
          <p class="text-sm font-medium text-foreground">{{ toast.title }}</p>
          @if (toast.detail) {
            <p class="text-xs leading-relaxed text-foreground-muted">
              {{ toast.detail }}
            </p>
          }
        </div>

        <button
          type="button"
          class="shrink-0 rounded-md p-1 text-foreground-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-foreground"
          [attr.aria-label]="t('common.close')"
          (click)="toasts.dismiss(toast.id)"
        >
          <ui-icon name="close" [size]="14" />
        </button>
      </div>
    }
  `
})
export class ToastHostComponent {
  protected readonly toasts = inject(ToastService);
  protected readonly t = injectT();

  protected readonly TONE_ICON: Record<ToastTone, IconName> = {
    success: "check-circle",
    danger: "error",
    warning: "warning",
    info: "info"
  };

  protected readonly TONE_TEXT: Record<ToastTone, string> = {
    success: "text-success",
    danger: "text-danger",
    warning: "text-warning",
    info: "text-info"
  };
}
