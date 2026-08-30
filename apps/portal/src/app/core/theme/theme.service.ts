import { DOCUMENT } from "@angular/common";
import { Injectable, computed, effect, inject, signal } from "@angular/core";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "growpath.theme";

/**
 * Light/dark, as a preference and as a resolution.
 *
 * Those are two different things and conflating them is the usual bug: someone
 * on "system" who changes their OS to dark at dusk must see the app follow,
 * which only works if "system" is stored as itself rather than flattened to
 * whichever mode was current when they chose it.
 *
 * All the toggle does is put `.dark` on <html>. Every colour in the app comes
 * from a CSS variable defined under that class, so nothing else has to react.
 */
@Injectable({ providedIn: "root" })
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly systemPrefersDark = signal(false);

  private readonly state = signal<ThemePreference>(restore());

  readonly preference = this.state.asReadonly();

  readonly resolved = computed<ResolvedTheme>(() => {
    const preference = this.state();
    if (preference !== "system") return preference;
    return this.systemPrefersDark() ? "dark" : "light";
  });

  readonly isDark = computed(() => this.resolved() === "dark");

  constructor() {
    const query = this.document.defaultView?.matchMedia?.(
      "(prefers-color-scheme: dark)"
    );
    if (query) {
      this.systemPrefersDark.set(query.matches);
      query.addEventListener("change", (event) =>
        this.systemPrefersDark.set(event.matches)
      );
    }

    effect(() => this.apply(this.resolved()));
  }

  set(preference: ThemePreference): void {
    this.state.set(preference);
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // Private browsing. The theme still applies for this session.
    }
  }

  /** Flips to the opposite of what is on screen, and pins it. */
  toggle(): void {
    this.set(this.isDark() ? "light" : "dark");
  }

  private apply(theme: ResolvedTheme): void {
    const root = this.document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    // Tells the browser to draw native widgets — scrollbars, form controls,
    // the address bar on mobile — in the matching mode. Without it a dark page
    // gets a bright white scrollbar down its edge.
    root.style.colorScheme = theme;
  }
}

function restore(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // Fall through to the default.
  }
  return "system";
}
