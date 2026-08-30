/**
 * Tailwind is the only styling layer in the portal — there is no component CSS
 * and no per-feature stylesheet.
 *
 * Every colour below resolves to a CSS variable rather than a literal. That is
 * what makes dark mode a single class on <html> instead of a `dark:` variant on
 * every element: the variable changes, the utility does not. Values are stored
 * as bare HSL channels ("222 47% 11%") so `<alpha-value>` still works, which
 * means `bg-primary/10` composes exactly as it would with a literal colour.
 *
 * Rule of thumb when adding a colour: name it for its job (`surface`, `danger`)
 * and not its appearance (`gray-800`, `red`). A palette named by appearance
 * cannot be re-themed, which defeats the point of the variables.
 */

/** @param {string} variable */
const token = (variable) => `hsl(var(${variable}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: ["./src/**/*.{html,ts}"],
  theme: {
    extend: {
      colors: {
        // Page and chrome
        background: token("--color-background"),
        surface: {
          DEFAULT: token("--color-surface"),
          muted: token("--color-surface-muted"),
          hover: token("--color-surface-hover")
        },
        border: {
          DEFAULT: token("--color-border"),
          strong: token("--color-border-strong")
        },

        // Text
        foreground: {
          DEFAULT: token("--color-foreground"),
          muted: token("--color-foreground-muted"),
          subtle: token("--color-foreground-subtle")
        },

        // Intent
        primary: {
          DEFAULT: token("--color-primary"),
          hover: token("--color-primary-hover"),
          foreground: token("--color-primary-foreground"),
          subtle: token("--color-primary-subtle")
        },
        success: {
          DEFAULT: token("--color-success"),
          foreground: token("--color-success-foreground"),
          subtle: token("--color-success-subtle")
        },
        warning: {
          DEFAULT: token("--color-warning"),
          foreground: token("--color-warning-foreground"),
          subtle: token("--color-warning-subtle")
        },
        danger: {
          DEFAULT: token("--color-danger"),
          hover: token("--color-danger-hover"),
          foreground: token("--color-danger-foreground"),
          subtle: token("--color-danger-subtle")
        },
        info: {
          DEFAULT: token("--color-info"),
          foreground: token("--color-info-foreground"),
          subtle: token("--color-info-subtle")
        },

        ring: token("--color-ring"),

        // Series slots. Assigned in fixed order and never cycled — see the
        // note beside the tokens in styles.css.
        chart: {
          1: token("--color-chart-1"),
          2: token("--color-chart-2")
        },
        grid: token("--color-grid")
      },

      borderRadius: {
        // The house radiuses. `rounded-xl` for controls, `rounded-2xl` for
        // containers — anything else is a deviation worth justifying.
        xl: "0.75rem",
        "2xl": "1rem"
      },

      boxShadow: {
        // Each is defined per theme in styles.css, because a shadow tuned for a
        // white ground is nearly invisible on a dark one. Referencing the
        // variable keeps one name working in both.
        card: "var(--shadow-card)",
        popover: "var(--shadow-popover)",
        modal: "var(--shadow-modal)",
        primary: "var(--shadow-primary)"
      },

      fontFamily: {
        // "Inter Variable" is the family name @fontsource-variable/inter
        // registers; plain "Inter" only matches a locally installed static cut.
        sans: [
          "Inter Variable",
          "Inter",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif"
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Cascadia Code",
          "Menlo",
          "monospace"
        ]
      },

      keyframes: {
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" }
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" }
        },
        /**
         * The mobile drawer entering from the leading edge.
         *
         * The offset is a CSS variable rather than a literal `-100%` because a
         * keyframe cannot read the writing direction — `--slide-from` is
         * flipped by a `[dir="rtl"]` rule in styles.css, so one animation
         * serves both directions instead of needing an `rtl:` twin.
         */
        "slide-in-start": {
          from: { transform: "translateX(calc(var(--slide-from, -1) * 100%))" },
          to: { transform: "translateX(0)" }
        },
        // Travels along the reading direction, so the highlight sweeps
        // right-to-left in Arabic. Same `--slide-from` switch as the drawer.
        shimmer: {
          "100%": { transform: "translateX(calc(var(--slide-from, -1) * -100%))" }
        }
      },
      animation: {
        "fade-in": "fade-in 150ms ease-out",
        "slide-up": "slide-up 200ms cubic-bezier(0.16, 1, 0.3, 1)",
        "slide-in-start": "slide-in-start 200ms cubic-bezier(0.16, 1, 0.3, 1)",
        shimmer: "shimmer 1.6s infinite"
      }
    }
  },
  plugins: []
};
