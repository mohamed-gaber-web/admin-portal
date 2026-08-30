import { ChangeDetectionStrategy, Component, input } from "@angular/core";
import { injectT } from "@core/i18n/i18n.service";
import { LocaleToggleComponent } from "../../layout/locale-toggle.component";
import { ThemeToggleComponent } from "../../layout/theme-toggle.component";
import { AuthBrandPanelComponent } from "./auth-brand-panel.component";

/**
 * The frame for every screen that exists outside the shell.
 *
 * Sign-in, the MFA challenge, both halves of password reset, invitation
 * redemption and tenant sign-up are all reached without a session, so none can
 * render the sidebar or the account menu. They share this: a brand panel on the
 * start side, the form on the end side, and the theme and locale toggles —
 * which belong out here rather than only inside the app, because someone who
 * prefers dark mode or Arabic prefers it before they sign in too.
 *
 * The split is a two-column grid above `lg` and a single column below it. Grid
 * tracks follow the writing direction, so the panel sits on the left in English
 * and mirrors to the right in Arabic with no separate rule — which is the whole
 * reason the columns are ordered by flow rather than positioned.
 */
@Component({
  selector: "app-auth-layout",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AuthBrandPanelComponent, LocaleToggleComponent, ThemeToggleComponent],
  host: { class: "grid min-h-screen bg-background lg:grid-cols-2" },
  template: `
    <app-auth-brand-panel />

    <!--
      The auth-ambience class paints two very faint colour washes behind the
      form, so the column does not read as a flat field next to a saturated
      panel. It moved here from the page root when the layout split: applied to
      the whole screen it would have sat under the brand panel too, muddying it.
    -->
    <div class="auth-ambience flex min-h-screen flex-col">
      <header class="flex items-center justify-between px-6 py-5">
        <!--
          The logo alone. The file is a full lockup — mark, wordmark and
          tagline — so setting "Grow Path Admin" next to it would print the
          product name twice.
        -->
        <!--
          The dark-mode filter is a stopgap, and worth naming as one.

          The asset is a flattened raster whose wordmark and tagline are dark
          navy — legible on white, close to invisible on the dark surface. The
          rest of the theme switches by CSS variable, but an image has no
          variable to switch, so the only lever is a filter over the whole
          thing: brightness-0 crushes it to black, invert lifts that to white.
          The result is a legible monochrome mark that loses the blue-and-orange
          glyph. A second asset drawn for dark backgrounds would keep both, and
          is the right fix when one exists.
        -->
        <img
          src="assets/images/grow-path-logo.svg"
          [alt]="t('app.name')"
          width="206"
          height="64"
          class="h-9 w-auto dark:brightness-0 dark:invert"
        />
        <div class="flex items-center gap-2">
          <app-locale-toggle />
          <app-theme-toggle />
        </div>
      </header>

      <main class="flex flex-1 items-center justify-center px-4 pb-16 pt-2">
        <div class="w-full max-w-md">
          <div class="mb-7 space-y-1.5 text-center">
            <h1 class="text-2xl font-semibold tracking-tight text-foreground">
              {{ title() }}
            </h1>
            <p class="text-sm text-foreground-muted">{{ subtitle() }}</p>
          </div>

          <div
            class="raised rounded-2xl border border-border bg-surface p-6 shadow-popover sm:p-7"
          >
            <ng-content />
          </div>

          <!--
            Projected below the card rather than inside it: a link away from
            this screen is not part of the form, and putting it in the card
            makes it look like one more thing to fill in.
          -->
          <ng-content select="[authFooter]" />
        </div>
      </main>
    </div>
  `
})
export class AuthLayoutComponent {
  readonly title = input.required<string>();
  readonly subtitle = input.required<string>();

  protected readonly t = injectT();
}
