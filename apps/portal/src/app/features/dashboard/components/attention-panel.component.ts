import { ChangeDetectionStrategy, Component, input } from "@angular/core";
import { RouterLink } from "@angular/router";
import { injectT } from "@core/i18n/i18n.service";
import type { MessageKey } from "@core/i18n/messages/en";
import { IconComponent, type IconName } from "@shared/ui";

export interface AttentionItem {
  id: string;
  tone: "danger" | "warning" | "info";
  icon: IconName;
  /** Message keys, not text — see the note on `Metric.labelKey`. */
  titleKey: MessageKey;
  detailKey: MessageKey;
  route: string;
}

/**
 * The things an operator should look at, ranked.
 *
 * The metric tiles report what is true; this reports what to do about it. A
 * dashboard made only of numbers leaves the reader to notice that failed
 * sign-ins climbed 22% and to work out on their own that it is worth chasing —
 * most people scanning a dashboard between other tasks will not.
 *
 * Every row is a link to the screen that acts on it. An item with no route is
 * an item that should not be here.
 *
 * The empty state is the healthy one and says so plainly, rather than leaving a
 * blank panel that reads as "failed to load".
 */
@Component({
  selector: "app-attention-panel",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  host: { class: "block" },
  template: `
    @if (items().length === 0) {
      <div class="flex flex-col items-center gap-2 py-8 text-center">
        <span
          class="flex h-10 w-10 items-center justify-center rounded-xl bg-success-subtle text-success"
        >
          <ui-icon name="check-circle" [size]="20" />
        </span>
        <p class="text-sm font-medium text-foreground">
          {{ t("dashboard.attentionClear") }}
        </p>
        <p class="text-xs text-foreground-muted">
          {{ t("dashboard.attentionClearBody") }}
        </p>
      </div>
    } @else {
      <ul class="space-y-1.5">
        @for (item of items(); track item.id) {
          <li>
            <a
              [routerLink]="item.route"
              class="group flex items-start gap-3 rounded-xl p-2.5 transition-colors duration-200 hover:bg-surface-muted"
            >
              <span
                [class]="
                  'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ' +
                  TONES[item.tone]
                "
              >
                <ui-icon [name]="item.icon" [size]="14" />
              </span>

              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium text-foreground">{{ t(item.titleKey) }}</p>
                <p class="text-xs text-foreground-muted">{{ t(item.detailKey) }}</p>
              </div>

              <ui-icon
                name="chevron-right"
                [size]="15"
                class="mt-1.5 shrink-0 text-foreground-subtle opacity-0 transition-opacity duration-200 group-hover:opacity-100"
              />
            </a>
          </li>
        }
      </ul>
    }
  `
})
export class AttentionPanelComponent {
  readonly items = input.required<readonly AttentionItem[]>();

  protected readonly t = injectT();

  protected readonly TONES: Record<AttentionItem["tone"], string> = {
    danger: "bg-danger-subtle text-danger",
    warning: "bg-warning-subtle text-warning",
    info: "bg-info-subtle text-info"
  };
}
