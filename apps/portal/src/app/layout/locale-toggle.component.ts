import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { I18nService } from "@core/i18n/i18n.service";
import { LOCALES, LOCALE_META } from "@core/i18n/locale";

/**
 * The language switch.
 *
 * Each option is labelled in its own language — "English", "العربية" — never
 * translated into the currently active one. Someone who has landed in a
 * language they cannot read needs to recognise their own on sight, and
 * "الإنجليزية" is no help to a reader who only knows English.
 *
 * Switching is instant: the locale signal drives both the catalogue and the
 * `dir` attribute, so the whole layout mirrors without a reload.
 */
@Component({
  selector: "app-locale-toggle",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "inline-flex" },
  template: `
    <div
      role="radiogroup"
      [attr.aria-label]="i18n.t('locale.label')"
      class="inline-flex items-center gap-0.5 rounded-xl border border-border bg-surface-muted p-0.5"
    >
      @for (option of locales; track option) {
        <button
          type="button"
          role="radio"
          [attr.aria-checked]="i18n.locale() === option"
          [attr.lang]="option"
          [class]="
            'rounded-lg px-2.5 py-1 text-xs font-semibold transition-all duration-200 ' +
            (i18n.locale() === option
              ? 'bg-surface text-foreground shadow-sm'
              : 'text-foreground-subtle hover:text-foreground')
          "
          (click)="i18n.set(option)"
        >
          {{ meta[option].label }}
        </button>
      }
    </div>
  `
})
export class LocaleToggleComponent {
  protected readonly i18n = inject(I18nService);
  protected readonly locales = LOCALES;
  protected readonly meta = LOCALE_META;
}
