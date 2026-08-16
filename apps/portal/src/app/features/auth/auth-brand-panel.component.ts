import { ChangeDetectionStrategy, Component } from "@angular/core";
import { injectT } from "@core/i18n/i18n.service";
import { IconComponent } from "@shared/ui";

/**
 * The decorative half of the authentication screens.
 *
 * Drawn rather than photographed. An inline SVG costs no request, scales to any
 * viewport without a second asset, and — because every colour is a design token
 * rather than a baked-in hex — it follows the theme instead of glowing white in
 * dark mode. It also keeps `angular.json`'s `assets` array empty, so nothing
 * about the build has to change to ship it.
 *
 * Hidden below `lg`. On a phone the sign-in form is the entire point of the
 * screen, and a decorative panel above it would push the fields under the fold.
 *
 * The artwork is `aria-hidden`; the words beside it are not. A screen reader
 * that announced "decorative blob" would be worse than silence, but the value
 * proposition is real content and is read normally.
 */
@Component({
  selector: "app-auth-brand-panel",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: "contents" },
  template: `
    <aside
      class="relative hidden overflow-hidden bg-primary text-primary-foreground lg:flex lg:flex-col lg:justify-between lg:p-12"
    >
      <!--
        Two washes and a dot grid, layered behind the copy.

        The washes use preserveAspectRatio="none" so they stretch to whatever
        shape the column ends up being — they are atmosphere, not a figure, and
        letterboxing them would leave hard edges at the corners.
      -->
      <svg
        class="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 600 900"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <radialGradient id="auth-wash-a" cx="20%" cy="10%" r="70%">
            <stop offset="0%" stop-color="currentColor" stop-opacity="0.28" />
            <stop offset="100%" stop-color="currentColor" stop-opacity="0" />
          </radialGradient>
          <radialGradient id="auth-wash-b" cx="90%" cy="95%" r="65%">
            <stop offset="0%" stop-color="currentColor" stop-opacity="0.2" />
            <stop offset="100%" stop-color="currentColor" stop-opacity="0" />
          </radialGradient>
          <pattern
            id="auth-dots"
            width="28"
            height="28"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="2" cy="2" r="1.5" fill="currentColor" fill-opacity="0.16" />
          </pattern>
        </defs>

        <rect width="600" height="900" fill="url(#auth-dots)" />
        <rect width="600" height="900" fill="url(#auth-wash-a)" />
        <rect width="600" height="900" fill="url(#auth-wash-b)" />
      </svg>

      <!--
        The mark: three overlapping rounded squares.

        A tenant, its environments, its companies — the hierarchy the product is
        actually about, drawn as nesting rather than as a stack of unrelated
        tiles. Fixed aspect ratio here, unlike the washes, because a squashed
        logo reads as a rendering bug.
      -->
      <svg
        class="relative h-16 w-16"
        viewBox="0 0 64 64"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <rect
          x="4"
          y="4"
          width="38"
          height="38"
          rx="11"
          fill="currentColor"
          fill-opacity="0.22"
        />
        <rect
          x="15"
          y="15"
          width="38"
          height="38"
          rx="11"
          fill="currentColor"
          fill-opacity="0.3"
        />
        <rect
          x="26"
          y="26"
          width="34"
          height="34"
          rx="10"
          stroke="currentColor"
          stroke-opacity="0.85"
          stroke-width="2.5"
        />
      </svg>

      <div class="relative max-w-md space-y-8">
        <div class="space-y-4">
          <h2 class="text-3xl font-semibold leading-tight tracking-tight">
            {{ t("auth.panelTitle") }}
          </h2>
          <p class="text-base leading-relaxed text-primary-foreground/75">
            {{ t("auth.panelBody") }}
          </p>
        </div>

        <ul class="space-y-3.5">
          @for (point of POINTS; track point.key) {
            <li class="flex items-center gap-3">
              <span
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/15"
              >
                <ui-icon [name]="point.icon" [size]="15" />
              </span>
              <span class="text-sm text-primary-foreground/85">{{ t(point.key) }}</span>
            </li>
          }
        </ul>
      </div>

      <p class="relative text-xs text-primary-foreground/60">
        {{ t("auth.panelFooter") }}
      </p>
    </aside>
  `
})
export class AuthBrandPanelComponent {
  protected readonly t = injectT();

  /**
   * Declared as data rather than as three copies of the same markup, so adding
   * a fourth is one line and cannot drift in spacing from its neighbours.
   */
  protected readonly POINTS = [
    { key: "auth.panelTenants", icon: "building" },
    { key: "auth.panelRoles", icon: "shield" },
    { key: "auth.panelAudit", icon: "users" }
  ] as const;
}
