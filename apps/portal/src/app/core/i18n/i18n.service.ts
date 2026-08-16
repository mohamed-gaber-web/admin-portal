import { DOCUMENT } from "@angular/common";
import { Injectable, computed, effect, inject, signal } from "@angular/core";
import {
  DEFAULT_LOCALE,
  LOCALE_META,
  isLocale,
  type Direction,
  type Locale
} from "./locale";
import { ar } from "./messages/ar";
import { en, type MessageKey, type Messages } from "./messages/en";

const STORAGE_KEY = "growpath.locale";

const CATALOGUES: Record<Locale, Messages> = { en, ar };

/** Values substituted into `{placeholder}` slots. */
export type MessageParams = Record<string, string | number>;

/**
 * Base keys of a plural family — any key declared as `<base>.other`.
 *
 * Derived from the catalogue, so `plural()` cannot be called with a base that
 * has no forms defined.
 */
export type PluralBase = MessageKey extends `${infer Base}.other` ? Base : never;

export type TranslateFn = (key: MessageKey, params?: MessageParams) => string;

/**
 * Translation, locale and direction.
 *
 * Runtime switching, not Angular's build-time `$localize` — that compiles one
 * bundle per locale and cannot change language without a page load, which rules
 * out the language switch this portal needs.
 *
 * `t` is an arrow property rather than a method, so a component can hold it
 * directly (`protected readonly t = injectT()`) and call `t('key')` in a
 * template without binding gymnastics. It reads the `locale` signal, so every
 * template that calls it re-renders on a language change — no impure pipe, and
 * no manual subscription.
 */
@Injectable({ providedIn: "root" })
export class I18nService {
  private readonly document = inject(DOCUMENT);
  private readonly state = signal<Locale>(restore());

  readonly locale = this.state.asReadonly();
  readonly meta = computed(() => LOCALE_META[this.state()]);
  readonly dir = computed<Direction>(() => this.meta().dir);
  readonly isRtl = computed(() => this.dir() === "rtl");

  private readonly messages = computed(() => CATALOGUES[this.state()]);

  constructor() {
    effect(() => {
      const root = this.document.documentElement;
      const meta = this.meta();
      // `dir` drives every logical CSS property in the app — `ps-*`, `me-*`,
      // `text-start` — plus Tailwind's `rtl:` variants. Setting it here is what
      // mirrors the layout; no component needs to know the direction.
      root.setAttribute("dir", meta.dir);
      root.setAttribute("lang", meta.code);
    });
  }

  readonly t: TranslateFn = (key, params) =>
    interpolate(this.messages()[key], params);

  set(locale: Locale): void {
    this.state.set(locale);
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // Private browsing. The language still applies for this session.
    }
  }

  /**
   * Picks the right plural form for `count`.
   *
   * Delegates to `Intl.PluralRules`, which is the only correct way to do this
   * for Arabic: it has six categories, and 0, 2, and 3–10 each take a different
   * form. The `count === 1 ? singular : plural` shortcut that works in English
   * is wrong for most Arabic sentences.
   */
  plural(base: PluralBase, count: number, params?: MessageParams): string {
    const category = new Intl.PluralRules(this.meta().intl).select(count);
    const messages = this.messages();
    const key = `${base}.${category}` as MessageKey;
    // Not every language defines every category — English has only `one` and
    // `other` — so fall back to the form every plural family must declare.
    const template = messages[key] ?? messages[`${base}.other` as MessageKey];
    return interpolate(template, { count, ...params });
  }

  /** Locale-aware number formatting, including the digit system. */
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
    return new Intl.NumberFormat(this.meta().intl, options).format(value);
  }

  formatDate(value: string | Date, options?: Intl.DateTimeFormatOptions): string {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return this.t("common.unknown");
    return new Intl.DateTimeFormat(
      this.meta().intl,
      options ?? { day: "numeric", month: "short", year: "numeric" }
    ).format(date);
  }

  relativeTime(value: number, unit: Intl.RelativeTimeFormatUnit): string {
    return new Intl.RelativeTimeFormat(this.meta().intl, {
      numeric: "auto"
    }).format(value, unit);
  }
}

/**
 * Convenience for components: `protected readonly t = injectT()`.
 *
 * Exists so a template reads `{{ t('nav.users') }}` rather than
 * `{{ i18n.t('nav.users') }}` in 38 files.
 */
export function injectT(): TranslateFn {
  return inject(I18nService).t;
}

/**
 * Substitutes `{name}` placeholders.
 *
 * A missing param leaves the placeholder visibly in place rather than printing
 * "undefined" — a visible `{count}` in a review is a bug someone reports, while
 * "undefined" reads like a data problem and gets chased in the wrong file.
 */
function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in params ? String(params[name]) : placeholder
  );
}

function restore(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_LOCALE;
}
