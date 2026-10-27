import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild
} from "@angular/core";
import { describeError } from "@core/http/api-error";
import { injectT } from "@core/i18n/i18n.service";
import { ToastService } from "@core/notifications/toast.service";
import {
  TENANT_LOGO_CONTENT_TYPES,
  TENANT_LOGO_MAX_BYTES,
  type MobileConfig
} from "@growpath/contracts";
import { ButtonComponent } from "@shared/ui";
import { ConfigurationService } from "@features/configuration/configuration.service";

/**
 * The box a logo is scaled into before upload, in pixels.
 *
 * About twice what the app draws, so it stays sharp on a high-density screen,
 * and small enough that the result fits the 64 KB cap without the administrator
 * having to resize anything themselves.
 */
const MAX_WIDTH = 480;
const MAX_HEIGHT = 240;

/**
 * Encodings tried in order, first one under the cap wins.
 *
 * PNG first because it keeps a logo's sharp edges and transparency exactly;
 * WebP when a detailed image makes the PNG too large. No JPEG: it would put a
 * white box behind every transparent logo.
 */
const ENCODINGS: readonly { type: string; quality?: number }[] = [
  { type: "image/png" },
  { type: "image/webp", quality: 0.92 },
  { type: "image/webp", quality: 0.8 }
];

/** Decoded size of a base64 `data:` URL, without decoding it. */
const decodedBytes = (dataUrl: string): number => {
  const payload = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return Math.floor((payload.length * 3) / 4) - (payload.match(/=+$/)?.[0].length ?? 0);
};

/**
 * The tenant's logo, shown in the mobile app beside the Grow Path mark.
 *
 * The image is scaled and re-encoded in the browser before it is sent. That is
 * what lets an administrator pick whatever file they have — a 4 MB export from
 * the marketing folder — and still land under the cap the API enforces, and it
 * means the server only ever receives a clean PNG or WebP drawn from pixels.
 *
 * Lives on Settings → Appearance. Rendered only once the mobile configuration
 * exists: the API answers 404 otherwise, because a logo with no devices to show
 * it on is not worth storing. The card around it carries the title.
 */
@Component({
  selector: "app-mobile-logo",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent],
  host: { class: "block" },
  template: `
    <div class="space-y-4">
      <div class="flex flex-wrap items-center gap-4">
        <div
          class="flex h-20 w-48 shrink-0 items-center justify-center rounded-lg border border-dashed border-border bg-white p-2"
        >
          @if (config().logoDataUrl; as logo) {
            <img
              [src]="logo"
              [alt]="t('mobileLogo.previewAlt')"
              class="max-h-full max-w-full object-contain"
            />
          } @else {
            <span class="text-xs text-foreground-subtle">{{ t("mobileLogo.none") }}</span>
          }
        </div>

        @if (!readOnly()) {
          <div class="flex flex-wrap items-center gap-2">
            <input
              #fileInput
              type="file"
              class="hidden"
              [accept]="accept"
              (change)="onFileSelected($event)"
            />
            <button
              uiButton
              type="button"
              variant="outline"
              size="sm"
              [loading]="busy() === 'upload'"
              [disabled]="busy() !== null"
              (click)="fileInput.click()"
            >
              {{ config().logoDataUrl ? t("mobileLogo.replace") : t("mobileLogo.upload") }}
            </button>
            @if (config().logoDataUrl) {
              <button
                uiButton
                type="button"
                variant="ghost"
                size="sm"
                [loading]="busy() === 'remove'"
                [disabled]="busy() !== null"
                (click)="remove()"
              >
                {{ t("mobileLogo.remove") }}
              </button>
            }
          </div>
        }
      </div>

      <p class="text-xs text-foreground-subtle">{{ t("mobileLogo.hint") }}</p>
    </div>
  `
})
export class MobileLogoComponent {
  readonly config = input.required<MobileConfig>();
  readonly readOnly = input(false);

  /** Emits the configuration as the server now holds it. */
  readonly changed = output<MobileConfig>();

  private readonly configuration = inject(ConfigurationService);
  private readonly toasts = inject(ToastService);
  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>("fileInput");

  protected readonly t = injectT();
  protected readonly busy = signal<"upload" | "remove" | null>(null);
  protected readonly accept = TENANT_LOGO_CONTENT_TYPES.join(",");

  protected async onFileSelected(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    // Cleared so picking the same file again still fires `change`.
    const picker = this.fileInput()?.nativeElement;
    if (picker) picker.value = "";
    if (!file || this.readOnly()) return;

    if (!(TENANT_LOGO_CONTENT_TYPES as readonly string[]).includes(file.type)) {
      this.toasts.error(this.t("mobileLogo.wrongType"));
      return;
    }

    this.busy.set("upload");
    let dataUrl: string | null;
    try {
      dataUrl = await this.shrink(file);
    } catch {
      this.busy.set(null);
      this.toasts.error(this.t("mobileLogo.unreadable"));
      return;
    }
    if (!dataUrl) {
      this.busy.set(null);
      this.toasts.error(this.t("mobileLogo.tooLarge"));
      return;
    }

    this.configuration.saveMobileLogo(dataUrl).subscribe({
      next: (updated) => {
        this.busy.set(null);
        this.changed.emit(updated);
        this.toasts.success(this.t("mobileLogo.saved"));
      },
      error: (error: unknown) => {
        this.busy.set(null);
        this.toasts.error(describeError(error, this.t, "mobileLogo.failed"));
      }
    });
  }

  protected remove(): void {
    if (this.readOnly()) return;
    this.busy.set("remove");

    this.configuration.removeMobileLogo().subscribe({
      next: (updated) => {
        this.busy.set(null);
        this.changed.emit(updated);
        this.toasts.success(this.t("mobileLogo.removed"));
      },
      error: (error: unknown) => {
        this.busy.set(null);
        this.toasts.error(describeError(error, this.t, "mobileLogo.failed"));
      }
    });
  }

  /**
   * Scales the image into the box, never up, and returns the first encoding
   * that fits the cap. Null when even the smallest one does not.
   */
  private async shrink(file: File): Promise<string | null> {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_WIDTH / bitmap.width, MAX_HEIGHT / bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d context");
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    for (const encoding of ENCODINGS) {
      const dataUrl = canvas.toDataURL(encoding.type, encoding.quality);
      // A browser that cannot encode WebP silently hands back PNG; skip it
      // rather than upload the same oversized PNG twice.
      if (!dataUrl.startsWith(`data:${encoding.type};`)) continue;
      if (decodedBytes(dataUrl) <= TENANT_LOGO_MAX_BYTES) return dataUrl;
    }
    return null;
  }
}
