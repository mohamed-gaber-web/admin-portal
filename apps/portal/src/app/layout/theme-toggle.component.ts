import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { injectT } from "@core/i18n/i18n.service";
import type { MessageKey } from "@core/i18n/messages/en";
import { ThemeService, type ThemePreference } from "@core/theme/theme.service";
import { IconComponent, type IconName } from "@shared/ui";

/**
 * Light / dark / system, as a three-way segmented control.
 *
 * A two-state toggle is the common shortcut and it silently drops the option
 * most people are actually on — following the OS. Once someone taps a two-state
 * toggle they are pinned to that mode forever, with no way back to "whatever my
 * phone is doing at 9pm".
 */
@Component({
  selector: "app-theme-toggle",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: "inline-flex" },
  template: `
    <div
      role="radiogroup"
      [attr.aria-label]="t('theme.label')"
      class="inline-flex items-center gap-0.5 rounded-xl border border-border bg-surface-muted p-0.5"
    >
      @for (option of options; track option.value) {
        <button
          type="button"
          role="radio"
          [attr.aria-checked]="theme.preference() === option.value"
          [attr.aria-label]="t(option.labelKey)"
          [title]="t(option.labelKey)"
          [class]="
            'rounded-lg p-1.5 transition-all duration-200 ' +
            (theme.preference() === option.value
              ? 'bg-surface text-foreground shadow-sm'
              : 'text-foreground-subtle hover:text-foreground')
          "
          (click)="theme.set(option.value)"
        >
          <ui-icon [name]="option.icon" [size]="15" />
        </button>
      }
    </div>
  `
})
export class ThemeToggleComponent {
  protected readonly theme = inject(ThemeService);
  protected readonly t = injectT();

  protected readonly options: {
    value: ThemePreference;
    icon: IconName;
    labelKey: MessageKey;
  }[] = [
    { value: "light", icon: "sun", labelKey: "theme.light" },
    { value: "dark", icon: "moon", labelKey: "theme.dark" },
    { value: "system", icon: "monitor", labelKey: "theme.system" }
  ];
}
