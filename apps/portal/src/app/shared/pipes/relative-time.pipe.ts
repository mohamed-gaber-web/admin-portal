import { Pipe, inject, type PipeTransform } from "@angular/core";
import { I18nService } from "@core/i18n/i18n.service";

const MINUTE = 60;
const HOUR = MINUTE * 60;
const DAY = HOUR * 24;

/**
 * "3 hours ago", from an ISO timestamp, in the active language.
 *
 * Built on `Intl.RelativeTimeFormat` via `I18nService`, so the wording and the
 * digit system follow the chosen locale rather than the browser's default — a
 * hand-written English table would need a plural rule per language, and Arabic
 * alone has six.
 *
 * Impure, which is unusual and deliberate. The pipe reads the locale signal, and
 * a pure pipe re-runs only when its *input* changes — so switching to Arabic
 * would leave every already-rendered timestamp in English until something else
 * happened to that row. The cost is a re-run per change-detection pass over a
 * few dozen table cells, which is cheap; a table stuck in the wrong language is
 * not.
 *
 * The absolute timestamp stays in `title` at every call site, so the exact
 * moment is always one hover away.
 */
@Pipe({ name: "relativeTime", standalone: true, pure: false })
export class RelativeTimePipe implements PipeTransform {
  private readonly i18n = inject(I18nService);

  transform(value: string | Date | null | undefined): string {
    if (!value) return this.i18n.t("common.never");

    const then = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(then.getTime())) return this.i18n.t("common.unknown");

    const seconds = Math.round((then.getTime() - Date.now()) / 1000);
    const magnitude = Math.abs(seconds);

    if (magnitude < MINUTE) return this.i18n.t("common.justNow");
    if (magnitude < HOUR) {
      return this.i18n.relativeTime(Math.round(seconds / MINUTE), "minute");
    }
    if (magnitude < DAY) {
      return this.i18n.relativeTime(Math.round(seconds / HOUR), "hour");
    }
    if (magnitude < DAY * 30) {
      return this.i18n.relativeTime(Math.round(seconds / DAY), "day");
    }
    // Past a month, a date is more useful than "2 months ago".
    return this.i18n.formatDate(then);
  }
}
