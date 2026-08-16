import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { SessionStore } from "@core/auth/session.store";
import { describeError } from "@core/http/api-error";
import { injectT } from "@core/i18n/i18n.service";
import { TENANT_PLAN_LABEL_KEYS } from "@core/i18n/label-keys";
import type { MessageKey } from "@core/i18n/messages/en";
import { asyncError, asyncLoading, type Async } from "@core/models";
import {
  BarChartComponent,
  ButtonComponent,
  CardComponent,
  CardHeaderComponent,
  ErrorStateComponent,
  IconComponent,
  SkeletonComponent,
  TabsComponent,
  TrendChartComponent,
  type Tab,
  type TrendSeries
} from "@shared/ui";
import { ActivityListComponent } from "@shared/components/activity-list.component";
import { AttentionPanelComponent } from "./components/attention-panel.component";
import { StatTileComponent } from "./components/stat-tile.component";
import {
  DashboardService,
  type DashboardData,
  type TrendRange
} from "./dashboard.service";

/**
 * The landing screen.
 *
 * Laid out so the eye lands in a deliberate order rather than on four
 * equal-weight boxes: what is true (the metric row), what to do about it
 * (attention), what is moving (the chart), and what happened (activity). The
 * previous version reported that failed sign-ins were up 22% in a tile styled
 * identically to the three good-news tiles beside it, which is a fine way to
 * publish a warning nobody reads.
 *
 * All three load states are real, not decoration: the skeleton mirrors the
 * final layout so nothing jumps when data lands, and the error state offers a
 * retry rather than a dead end.
 */
@Component({
  selector: "app-dashboard-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    ActivityListComponent,
    AttentionPanelComponent,
    BarChartComponent,
    ButtonComponent,
    CardComponent,
    CardHeaderComponent,
    ErrorStateComponent,
    IconComponent,
    SkeletonComponent,
    StatTileComponent,
    TabsComponent,
    TrendChartComponent
  ],
  template: `
    <div class="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div class="min-w-0 space-y-1">
        <h1 class="text-2xl font-semibold tracking-tight text-foreground">
          {{ heading() }}
        </h1>
        <!-- One interpolated sentence rather than three fragments around a
             styled span. Arabic puts the tenant name elsewhere in the clause,
             and a sentence split across elements cannot be reordered. -->
        <p class="text-sm text-foreground-muted">{{ subtitle() }}</p>
      </div>

      <a uiButton routerLink="/tenants" variant="outline" size="md">
        <ui-icon name="building" [size]="16" />
        {{ t("dashboard.manageTenants") }}
      </a>
    </div>

    @switch (state().status) {
      @case ("error") {
        <ui-card>
          <ui-error-state
            [title]="t('dashboard.loadFailed')"
            [message]="state().error ?? ''"
            (retry)="load()"
          />
        </ui-card>
      }

      @case ("success") {
        <div class="space-y-6 animate-fade-in">
          <section [attr.aria-label]="t('dashboard.keyMetrics')">
            <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              @for (metric of state().data!.metrics; track metric.key) {
                <a appStatTile [metric]="metric" [routerLink]="metric.route"></a>
              }
            </div>
            <!-- Said once, rather than repeated under all four tiles. -->
            <p class="mt-2.5 text-xs text-foreground-subtle">
              {{ t("dashboard.deltaCaption") }}
            </p>
          </section>

          <div class="grid gap-6 xl:grid-cols-3">
            <ui-card class="xl:col-span-2">
              <ui-card-header
                [title]="t('dashboard.growth')"
                [description]="t('dashboard.growthSubtitle')"
              >
                <!-- Scoped to this chart, and placed inside its header to say
                     so — the metric tiles above are fixed to 30 days. -->
                <ui-tabs
                  [tabs]="ranges()"
                  [active]="range()"
                  (activeChange)="setRange($event)"
                />
              </ui-card-header>
              <div class="mt-6">
                <ui-trend-chart [labels]="trendLabels()" [series]="trendSeries()" />
              </div>
            </ui-card>

            <ui-card>
              <ui-card-header
                [title]="t('dashboard.attention')"
                [description]="t('dashboard.attentionSubtitle')"
              />
              <div class="mt-4">
                <app-attention-panel [items]="state().data!.attention" />
              </div>
            </ui-card>
          </div>

          <div class="grid gap-6 xl:grid-cols-3">
            <ui-card class="xl:col-span-2">
              <ui-card-header
                [title]="t('dashboard.recentActivity')"
                [description]="t('dashboard.recentActivitySubtitle')"
              >
                <a uiButton routerLink="/activity" variant="ghost" size="sm">
                  {{ t("common.viewAll") }}
                  <ui-icon name="chevron-right" [size]="14" />
                </a>
              </ui-card-header>
              <div class="mt-4">
                <app-activity-list [entries]="state().data!.activity" />
              </div>
            </ui-card>

            <ui-card>
              <ui-card-header
                [title]="t('dashboard.plans')"
                [description]="t('dashboard.plansSubtitle')"
              />
              <div class="mt-6">
                <ui-bar-chart [data]="planPoints()" />
              </div>
            </ui-card>
          </div>
        </div>
      }

      @default {
        <!-- Skeleton in the shape of the real layout, so nothing shifts. -->
        <div
          class="space-y-6"
          aria-busy="true"
          [attr.aria-label]="t('dashboard.loadingLabel')"
        >
          <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            @for (placeholder of [1, 2, 3, 4]; track placeholder) {
              <div class="space-y-4 rounded-2xl border border-border bg-surface p-5">
                <ui-skeleton shape="h-8 w-8 rounded-lg" />
                <ui-skeleton shape="h-7 w-24" />
                <ui-skeleton shape="h-8 w-full" />
              </div>
            }
          </div>

          <div class="grid gap-6 xl:grid-cols-3">
            <div class="rounded-2xl border border-border bg-surface p-6 xl:col-span-2">
              <ui-skeleton shape="h-5 w-32" />
              <ui-skeleton shape="h-[260px] w-full mt-6" />
            </div>
            <div class="space-y-4 rounded-2xl border border-border bg-surface p-6">
              <ui-skeleton shape="h-5 w-36" />
              @for (placeholder of [1, 2, 3, 4]; track placeholder) {
                <ui-skeleton shape="h-12 w-full" />
              }
            </div>
          </div>

          <div class="grid gap-6 xl:grid-cols-3">
            <div class="space-y-4 rounded-2xl border border-border bg-surface p-6 xl:col-span-2">
              <ui-skeleton shape="h-5 w-36" />
              @for (placeholder of [1, 2, 3, 4, 5]; track placeholder) {
                <ui-skeleton shape="h-10 w-full" />
              }
            </div>
            <div class="space-y-4 rounded-2xl border border-border bg-surface p-6">
              <ui-skeleton shape="h-5 w-32" />
              @for (placeholder of [1, 2, 3, 4]; track placeholder) {
                <ui-skeleton shape="h-8 w-full" />
              }
            </div>
          </div>
        </div>
      }
    }
  `
})
export class DashboardPage {
  private readonly dashboard = inject(DashboardService);
  protected readonly session = inject(SessionStore);

  protected readonly t = injectT();
  protected readonly state = signal<Async<DashboardData>>(asyncLoading());
  protected readonly range = signal<TrendRange>("12m");

  // Computed, not a constant: the labels have to re-resolve when the language
  // changes, and a field initialised once would freeze them at startup.
  protected readonly ranges = computed<Tab[]>(() => [
    { id: "30d", label: this.t("dashboard.range30d") },
    { id: "90d", label: this.t("dashboard.range90d") },
    { id: "12m", label: this.t("dashboard.range12m") }
  ]);

  protected readonly heading = computed(() =>
    this.t("dashboard.greeting", {
      greeting: this.t(greetingKey()),
      name: this.session.displayName()
    })
  );

  protected readonly subtitle = computed(() =>
    this.t("dashboard.subtitle", { tenant: this.session.tenant()?.slug ?? "" })
  );

  protected readonly planPoints = computed(() =>
    (this.state().data?.plans ?? []).map((entry) => ({
      label: this.t(TENANT_PLAN_LABEL_KEYS[entry.plan]),
      value: entry.value
    }))
  );

  constructor() {
    this.load();
  }

  protected load(): void {
    this.state.set(asyncLoading(this.state().data));
    this.dashboard.load().subscribe({
      next: (data) => this.state.set({ status: "success", data, error: null }),
      error: (error: unknown) =>
        this.state.set(asyncError(describeError(error, this.t, "dashboard.loadError")))
    });
  }

  /** `ui-tabs` speaks in plain strings; this is the one place it narrows. */
  protected setRange(value: string): void {
    this.range.set(value as TrendRange);
  }

  private readonly trend = computed(() => this.state().data?.trend[this.range()]);

  protected readonly trendLabels = computed(() => this.trend()?.labels ?? []);

  /**
   * Slots are pinned to the entity, not to position in the array — so if a
   * future filter hides one series, the other keeps its colour instead of
   * inheriting slot 1 and appearing to have changed meaning.
   */
  protected readonly trendSeries = computed<TrendSeries[]>(() => {
    const trend = this.trend();
    if (!trend) return [];
    return [
      { name: this.t("dashboard.seriesTenants"), values: trend.tenants, slot: 1 },
      { name: this.t("dashboard.seriesUsers"), values: trend.users, slot: 2 }
    ];
  });
}

/** Which greeting the clock calls for. Resolved to text by the caller. */
function greetingKey(): MessageKey {
  const hour = new Date().getHours();
  if (hour < 12) return "dashboard.morning";
  return hour < 18 ? "dashboard.afternoon" : "dashboard.evening";
}
