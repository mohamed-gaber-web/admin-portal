/** The locales the portal ships. */
export const LOCALES = ["en", "ar"] as const;

export type Locale = (typeof LOCALES)[number];

export type Direction = "ltr" | "rtl";

export interface LocaleMeta {
  code: Locale;
  /** The language's own name, as its speakers write it. */
  label: string;
  dir: Direction;
  /**
   * The BCP-47 tag handed to `Intl`.
   *
   * Arabic is pinned to `-u-nu-latn` so numbers render as 1,284 rather than
   * ١٬٢٨٤. Gulf business software overwhelmingly uses Latin digits, and mixing
   * Arabic-Indic digits into a table of figures that also appears in exports and
   * D365 makes the two impossible to compare at a glance. Change this one string
   * to switch the whole app, including charts and dates.
   */
  intl: string;
}

export const LOCALE_META: Record<Locale, LocaleMeta> = {
  en: { code: "en", label: "English", dir: "ltr", intl: "en-GB" },
  ar: { code: "ar", label: "العربية", dir: "rtl", intl: "ar-SA-u-nu-latn" }
};

export const DEFAULT_LOCALE: Locale = "en";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}
