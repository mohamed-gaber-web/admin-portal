import { ChangeDetectionStrategy, Component, input } from "@angular/core";
import type { ActivityEntry, ActivitySeverity } from "@core/models";
import { IconComponent, type IconName } from "@shared/ui";
import { RelativeTimePipe } from "@shared/pipes/relative-time.pipe";

/**
 * Audit-log entries as a feed.
 *
 * Shared between the dashboard (last six) and the activity screen (paged), so
 * the two never drift into describing the same event differently.
 *
 * Action names are shown verbatim — `tenant.provisioned`, not "Tenant created".
 * They are the strings the audit log actually stores and the route manifest
 * declares, and an operator reading this screen is usually about to search the
 * logs for one of them. A prettified label breaks that copy-and-paste.
 */
@Component({
  selector: "app-activity-list",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, RelativeTimePipe],
  host: { class: "block" },
  template: `
    <ul class="divide-y divide-border">
      @for (entry of entries(); track entry.id) {
        <li class="flex items-start gap-3 py-3.5 first:pt-0 last:pb-0">
          <span
            [class]="
              'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ' +
              TONES[entry.severity]
            "
          >
            <ui-icon [name]="ICONS[entry.severity]" [size]="15" />
          </span>

          <div class="min-w-0 flex-1">
            <p class="truncate font-mono text-xs font-medium text-foreground">
              {{ entry.action }}
            </p>
            <p class="truncate text-xs text-foreground-muted">
              {{ entry.actor }} → {{ entry.target }}
            </p>
          </div>

          <!-- Exact time in the tooltip; the relative label is the summary. -->
          <time
            [attr.datetime]="entry.at"
            [title]="entry.at"
            class="shrink-0 whitespace-nowrap text-xs text-foreground-subtle"
          >
            {{ entry.at | relativeTime }}
          </time>
        </li>
      }
    </ul>
  `
})
export class ActivityListComponent {
  readonly entries = input.required<readonly ActivityEntry[]>();

  protected readonly TONES: Record<ActivitySeverity, string> = {
    info: "bg-info-subtle text-info",
    success: "bg-success-subtle text-success",
    warning: "bg-warning-subtle text-warning",
    danger: "bg-danger-subtle text-danger"
  };

  protected readonly ICONS: Record<ActivitySeverity, IconName> = {
    info: "info",
    success: "check-circle",
    warning: "warning",
    danger: "error"
  };
}
