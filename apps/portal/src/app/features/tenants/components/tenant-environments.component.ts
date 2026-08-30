import { ChangeDetectionStrategy, Component, input } from "@angular/core";
import { injectT } from "@core/i18n/i18n.service";
import type { MessageKey } from "@core/i18n/messages/en";
import type {
  ConnectionState,
  EnvironmentKind,
  TenantEnvironment
} from "@core/models";
import {
  BadgeComponent,
  EmptyStateComponent,
  IconComponent,
  type BadgeTone
} from "@shared/ui";

/**
 * A tenant's D365 environments, each with its legal entities nested inside.
 *
 * The nesting is the point. US-010 models tenant → environment → company as
 * three levels and calls collapsing them the most expensive mistake available
 * here; a screen that showed a tenant's companies as one flat list would be
 * that mistake in the UI, and would have no place to put the fact that the same
 * `dataAreaId` means different data in PROD and in UAT.
 *
 * Connection state is shown and not actionable. Configuring an environment and
 * testing it is US-065 — surfacing the state without offering the action is
 * where this story stops.
 */
@Component({
  selector: "app-tenant-environments",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BadgeComponent, EmptyStateComponent, IconComponent],
  host: { class: "block" },
  template: `
    @if (environments().length === 0) {
      <ui-empty-state
        icon="database"
        [title]="t('tenantDetail.environmentsEmpty')"
        [description]="t('tenantDetail.environmentsEmptyBody')"
      />
    } @else {
      <ul class="space-y-4">
        @for (env of environments(); track env.id) {
          <li class="rounded-xl border border-border">
            <div
              class="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4"
            >
              <div class="min-w-0 space-y-1">
                <div class="flex flex-wrap items-center gap-2">
                  <span
                    class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-foreground-muted"
                  >
                    <ui-icon name="database" [size]="14" />
                  </span>
                  <p class="truncate text-sm font-semibold text-foreground">
                    {{ env.name }}
                  </p>
                  <ui-badge [tone]="env.kind === 'production' ? 'primary' : 'neutral'">
                    {{ t(KIND_LABELS[env.kind]) }}
                  </ui-badge>
                </div>
                <!-- dir="ltr": a URL is a machine string and does not mirror. -->
                <p dir="ltr" class="truncate font-mono text-xs text-foreground-subtle">
                  {{ env.url }}
                </p>
              </div>

              <ui-badge [tone]="CONNECTION_TONES[env.connection]" [dot]="true">
                {{ t(CONNECTION_LABELS[env.connection]) }}
              </ui-badge>
            </div>

            <div class="p-4">
              @if (env.companies.length === 0) {
                <p class="text-sm text-foreground-muted">
                  {{ t("tenantDetail.companiesEmpty") }}
                </p>
              } @else {
                <p
                  class="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground-subtle"
                >
                  {{ t("tenantDetail.companies") }}
                </p>
                <ul class="divide-y divide-border">
                  @for (company of env.companies; track company.id) {
                    <li class="flex items-center justify-between gap-3 py-2.5">
                      <span class="truncate text-sm text-foreground">
                        {{ company.name }}
                      </span>
                      <span
                        dir="ltr"
                        class="shrink-0 rounded-md bg-surface-muted px-2 py-0.5 font-mono text-xs text-foreground-muted"
                        [title]="t('tenantDetail.dataAreaId')"
                      >
                        {{ company.dataAreaId }}
                      </span>
                    </li>
                  }
                </ul>
              }
            </div>
          </li>
        }
      </ul>
    }
  `
})
export class TenantEnvironmentsComponent {
  readonly environments = input.required<readonly TenantEnvironment[]>();

  protected readonly t = injectT();

  protected readonly KIND_LABELS: Record<EnvironmentKind, MessageKey> = {
    production: "environmentKind.production",
    sandbox: "environmentKind.sandbox"
  };

  protected readonly CONNECTION_LABELS: Record<ConnectionState, MessageKey> = {
    connected: "connection.connected",
    failing: "connection.failing",
    not_configured: "connection.not_configured"
  };

  protected readonly CONNECTION_TONES: Record<ConnectionState, BadgeTone> = {
    connected: "success",
    failing: "danger",
    not_configured: "neutral"
  };
}
