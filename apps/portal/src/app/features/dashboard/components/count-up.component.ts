import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked
} from "@angular/core";
import { I18nService } from "@core/i18n/i18n.service";

/**
 * A number that counts up to its value when it first appears.
 *
 * Driven by `requestAnimationFrame` rather than a CSS trick, because the digits
 * have to go through the active locale's formatter — Arabic shows Arabic-Indic
 * digits, and a CSS counter cannot. Skipped entirely under
 * `prefers-reduced-motion`: the global rule in styles.css only shortens CSS
 * animations, and this is not one.
 */
@Component({
  selector: "app-count-up",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `{{ formatted() }}`
})
export class CountUpComponent {
  readonly value = input.required<number>();
  readonly duration = input(900);

  private readonly i18n = inject(I18nService);
  private readonly shown = signal(0);
  private frame = 0;

  protected readonly formatted = computed(() =>
    this.i18n.formatNumber(Math.round(this.shown()))
  );

  constructor() {
    // `allowSignalWrites`: the reduced-motion path sets the figure synchronously.
    effect(
      () => {
        const target = this.value();
        untracked(() => this.animateTo(target));
      },
      { allowSignalWrites: true }
    );
    inject(DestroyRef).onDestroy(() => cancelAnimationFrame(this.frame));
  }

  private animateTo(target: number): void {
    cancelAnimationFrame(this.frame);
    const reduced =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || target === 0) {
      this.shown.set(target);
      return;
    }

    const from = this.shown();
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / this.duration());
      // Ease-out cubic: fast start, settles gently on the final figure.
      const eased = 1 - Math.pow(1 - progress, 3);
      this.shown.set(from + (target - from) * eased);
      if (progress < 1) this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }
}
