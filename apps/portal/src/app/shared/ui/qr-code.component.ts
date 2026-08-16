import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  signal
} from "@angular/core";
import { DomSanitizer, type SafeHtml } from "@angular/platform-browser";
import { toString as qrToString } from "qrcode";

/**
 * Renders a string as a QR code.
 *
 * SVG rather than canvas: it stays sharp on any display, scales with the
 * layout, and prints — and someone enrolling an authenticator on a second
 * device does sometimes print the page.
 *
 * Colours are fixed black-on-white regardless of theme. A QR is read by a
 * camera, not a person, and scanners want maximum contrast in the conventional
 * polarity; a "dark mode" QR of light modules on a dark ground scans poorly on
 * cheap sensors. The white quiet zone around it is part of the spec, not
 * padding — cropping it is a common reason a code will not scan.
 *
 * Rendering is asynchronous and can fail on absurd input lengths, so the
 * failure is surfaced rather than swallowed: the caller shows the secret for
 * manual entry, which must work anyway for anyone who cannot scan.
 */
@Component({
  selector: "ui-qr-code",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    @if (markup(); as svg) {
      <div
        class="inline-block rounded-xl bg-white p-3 shadow-card ring-1 ring-black/5"
        role="img"
        [attr.aria-label]="label()"
        [innerHTML]="svg"
      ></div>
    }
  `
})
export class QrCodeComponent {
  readonly value = input.required<string>();
  readonly size = input(180);
  readonly label = input("QR code");
  /** Emits when the code could not be rendered, so the caller can fall back. */
  readonly failed = signal(false);

  private readonly sanitizer = inject(DomSanitizer);
  protected readonly markup = signal<SafeHtml | null>(null);

  constructor() {
    effect(() => {
      const value = this.value();
      const size = this.size();

      void qrToString(value, {
        type: "svg",
        width: size,
        margin: 2,
        // Medium recovers ~15% of a damaged or partly obscured code, which is
        // the usual default and plenty for a code shown on a screen.
        errorCorrectionLevel: "M",
        color: { dark: "#000000", light: "#ffffff" }
      }).then(
        (svg) => {
          this.failed.set(false);
          // Trusted deliberately: the markup is generated locally by the qrcode
          // library from the value, never returned by a server, and Angular's
          // sanitiser strips SVG children — which would leave an empty box.
          this.markup.set(this.sanitizer.bypassSecurityTrustHtml(svg));
        },
        () => {
          this.markup.set(null);
          this.failed.set(true);
        }
      );
    });
  }
}
