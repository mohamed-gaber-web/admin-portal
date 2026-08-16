import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";

export type AvatarSize = "sm" | "md" | "lg";

/**
 * Initials on a tinted disc.
 *
 * No image support, because there is nowhere to upload one yet — adding an
 * `src` input that is always undefined would be a lie about what the system
 * can do.
 *
 * The tint is derived from the name rather than random, so the same person is
 * the same colour on every screen and across reloads. It is decoration only:
 * nothing is ever conveyed by that colour alone.
 */
@Component({
  selector: "ui-avatar",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class]": "classes()", "[attr.title]": "name()" },
  template: `{{ initials() }}`
})
export class AvatarComponent {
  readonly name = input.required<string>();
  readonly size = input<AvatarSize>("md");

  protected readonly initials = computed(() => {
    const parts = this.name().trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    const picked = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts;
    return picked.map((part) => part.charAt(0).toUpperCase()).join("").slice(0, 2);
  });

  protected readonly classes = computed(() =>
    [
      "inline-flex shrink-0 items-center justify-center rounded-full",
      "font-semibold uppercase select-none ring-1 ring-inset ring-black/[0.04] dark:ring-white/[0.06]",
      SIZES[this.size()],
      TINTS[hashOf(this.name()) % TINTS.length]
    ].join(" ")
  );
}

const SIZES: Record<AvatarSize, string> = {
  sm: "h-7 w-7 text-[10px]",
  md: "h-9 w-9 text-xs",
  lg: "h-12 w-12 text-sm"
};

/**
 * Tints, not the semantic palette.
 *
 * Deliberately kept away from `success`/`danger` so an avatar never reads as a
 * status — a red disc next to a name should not suggest the account is in
 * trouble.
 */
const TINTS = [
  "bg-primary-subtle text-primary",
  "bg-info-subtle text-info",
  "bg-success-subtle text-success",
  "bg-warning-subtle text-warning",
  "bg-surface-muted text-foreground-muted"
];

/** Small stable string hash — same name in, same tint out. */
function hashOf(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}
