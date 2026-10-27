import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { TENANT_PLANS, TENANT_STATUSES } from "@growpath/contracts";
import { SessionStore } from "@core/auth/session.store";
import { describeError } from "@core/http/api-error";
import { I18nService, injectT } from "@core/i18n/i18n.service";
import { TENANT_PLAN_LABEL_KEYS, TENANT_STATUS_LABEL_KEYS } from "@core/i18n/label-keys";
import type { MessageKey } from "@core/i18n/messages/en";
import {
  asyncError,
  asyncLoading,
  type Async,
  type TenantStatus,
  type TenantSummary
} from "@core/models";
import {
  AvatarComponent,
  BadgeComponent,
  BarChartComponent,
  ButtonComponent,
  CardComponent,
  CardHeaderComponent,
  ErrorStateComponent,
  IconComponent,
  SkeletonComponent,
  SparklineComponent,
  TabsComponent,
  TrendChartComponent,
  type BadgeTone,
  type IconName,
  type Tab,
  type TrendSeries
} from "@shared/ui";
import { RelativeTimePipe } from "@shared/pipes/relative-time.pipe";
import { AttentionPanelComponent, type AttentionItem } from "./components/attention-panel.component";
import { CountUpComponent } from "./components/count-up.component";
import {
  PlatformDashboardService,
  type PlatformDashboardData
} from "./platform-dashboard.service";

type TrendRange = "30d" | "90d" | "12m";

interface Trend {
  labels: string[];
  values: number[];
  /** Tenants created inside the range. */
  added: number;
}

interface PulseTile {
  key: string;
  icon: IconName;
  labelKey: MessageKey;
  hintKey: MessageKey;
  value: number;
  route: string;
  /** Painted only when the figure is non-zero — a zero is good news. */
  tone: "info" | "warning" | "danger" | "neutral";
}

interface Renewal {
  tenant: TenantSummary;
  daysLeft: number;
  /** Share of the contract term already elapsed, 0–100. */
  elapsed: number;
}

interface GuideCard {
  icon: IconName;
  titleKey: MessageKey;
  bodyKey: MessageKey;
  route: string;
}

const DAY = 86_400_000;
const RING = 2 * Math.PI * 34;

/** Status colours, shared by the breakdown bar, its legend and the badges. */
const STATUS_TONES: Record<TenantStatus, BadgeTone> = {
  active: "success",
  pending: "info",
  suspended: "warning",
  archived: "neutral"
};

const STATUS_BAR: Record<TenantStatus, string> = {
  active: "bg-success",
  pending: "bg-info",
  suspended: "bg-warning",
  archived: "bg-foreground-subtle"
};

const TILE_TONES: Record<PulseTile["tone"], string> = {
  info: "bg-info-subtle text-info",
  warning: "bg-warning-subtle text-warning",
  danger: "bg-danger-subtle text-danger",
  neutral: "bg-primary-subtle text-primary"
};

/** Every operator screen, explained once, in the order the sidebar lists them. */
const GUIDE: readonly GuideCard[] = [
  {
    icon: "building",
    titleKey: "opsDashboard.guide.tenants.title",
    bodyKey: "opsDashboard.guide.tenants.body",
    route: "/platform/tenants"
  },
  {
    icon: "users",
    titleKey: "opsDashboard.guide.users.title",
    bodyKey: "opsDashboard.guide.users.body",
    route: "/platform/users"
  },
  {
    icon: "package",
    titleKey: "opsDashboard.guide.packages.title",
    bodyKey: "opsDashboard.guide.packages.body",
    route: "/platform/packages"
  },
  {
    icon: "shield",
    titleKey: "opsDashboard.guide.admins.title",
    bodyKey: "opsDashboard.guide.admins.body",
    route: "/platform/admins"
  },
  {
    icon: "key",
    titleKey: "opsDashboard.guide.permissions.title",
    bodyKey: "opsDashboard.guide.permissions.body",
    route: "/platform/permissions"
  }
];

const TIPS: readonly { icon: IconName; titleKey: MessageKey; bodyKey: MessageKey }[] = [
  { icon: "key", titleKey: "opsDashboard.tip.modules.title", bodyKey: "opsDashboard.tip.modules.body" },
  { icon: "refresh", titleKey: "opsDashboard.tip.archive.title", bodyKey: "opsDashboard.tip.archive.body" },
  { icon: "lock", titleKey: "opsDashboard.tip.links.title", bodyKey: "opsDashboard.tip.links.body" }
];

/**
 * The operator's landing screen — the whole installation, read live.
 *
 * It used to be a fixture: 48 tenants, a plan mix and a 22% rise in failed
 * sign-ins that described no installation in particular. Every figure here is
 * now derived from `GET /platform/tenants` and friends, so the screen is true
 * on day one with one customer and stays true at five hundred.
 *
 * Laid out so the eye lands in a deliberate order: the state of the business
 * (hero), its pulse (secondary tiles), what to act on (attention, beside the
 * growth curve), how it is made up (plans, status, seats), who is new and who
 * is due — then, for a newer operator, what every screen is for.
 *
 * Motion is an entrance, played once per load and collapsed under
 * `prefers-reduced-motion`: cards rise in sequence, figures count up, rings and
 * bars fill from empty.
 */
@Component({
  selector: "app-platform-dashboard",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    AttentionPanelComponent,
    AvatarComponent,
    BadgeComponent,
    BarChartComponent,
    ButtonComponent,
    CardComponent,
    CardHeaderComponent,
    CountUpComponent,
    ErrorStateComponent,
    IconComponent,
    RelativeTimePipe,
    SkeletonComponent,
    SparklineComponent,
    TabsComponent,
    TrendChartComponent
  ],
  template: `
    @if (state().status === "error") {
        <ui-card>
          <ui-error-state
            [title]="t('dashboard.loadFailed')"
            [message]="state().error ?? ''"
            (retry)="load()"
          />
        </ui-card>
    } @else if (state().data) {
        <div class="space-y-6">
          <!-- Hero: the business at a glance, and the two things operators do most. -->
          <section
            class="relative isolate overflow-hidden rounded-2xl bg-primary bg-gradient-to-br from-primary via-primary to-info p-6 text-primary-foreground shadow-primary animate-rise sm:p-8"
          >
            <span
              class="pointer-events-none absolute -end-20 -top-24 -z-10 h-72 w-72 rounded-full bg-white/20 blur-3xl animate-float"
              aria-hidden="true"
            ></span>
            <span
              class="pointer-events-none absolute -bottom-28 start-1/3 -z-10 h-64 w-64 rounded-full bg-info/50 blur-3xl animate-float [animation-delay:-4s]"
              aria-hidden="true"
            ></span>

            <div class="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
              <div class="min-w-0 space-y-3">
                <p
                  class="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold uppercase tracking-[0.08em] backdrop-blur"
                >
                  <span class="relative flex h-2 w-2" aria-hidden="true">
                    <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/70"></span>
                    <span class="relative inline-flex h-2 w-2 rounded-full bg-white"></span>
                  </span>
                  {{ t("opsDashboard.eyebrow") }}
                </p>
                <h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">{{ heading() }}</h1>
                <p class="max-w-xl text-sm leading-relaxed text-primary-foreground/85">
                  {{ t("opsDashboard.subtitle") }}
                </p>

                <div class="flex flex-wrap items-center gap-2 pt-2">
                  @if (canCreateTenant()) {
                    <a
                      routerLink="/platform/tenants"
                      [queryParams]="{ create: 1 }"
                      class="group inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-primary shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:shadow-popover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                    >
                      <ui-icon name="plus" [size]="16" class="transition-transform duration-300 group-hover:rotate-90" />
                      {{ t("opsDashboard.createTenant") }}
                    </a>
                  }
                  @if (canInviteUser()) {
                    <a
                      routerLink="/platform/users"
                      [queryParams]="{ invite: 1 }"
                      class="inline-flex items-center gap-2 rounded-xl bg-white/15 px-4 py-2.5 text-sm font-semibold backdrop-blur transition-all duration-200 hover:-translate-y-0.5 hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                    >
                      <ui-icon name="mail" [size]="16" />
                      {{ t("opsDashboard.inviteUser") }}
                    </a>
                  }
                  <button
                    type="button"
                    (click)="load()"
                    [disabled]="refreshing()"
                    class="inline-flex items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-medium text-primary-foreground/85 transition-colors duration-200 hover:bg-white/10 disabled:opacity-70"
                    [attr.aria-label]="t('opsDashboard.refresh')"
                  >
                    <ui-icon name="refresh" [size]="14" [class.animate-spin]="refreshing()" />
                    {{ t("opsDashboard.updatedAt", { time: updatedAt() }) }}
                  </button>
                </div>
              </div>

              <!-- Headline figures. -->
              <dl class="grid shrink-0 grid-cols-3 gap-3 sm:gap-4">
                <div class="rounded-2xl bg-white/10 p-4 backdrop-blur animate-rise [animation-delay:120ms]">
                  <dt class="text-xs font-medium text-primary-foreground/80">{{ t("opsDashboard.hero.tenants") }}</dt>
                  <dd class="mt-2 text-3xl font-semibold leading-none">
                    @if (live(); as live) { <app-count-up [value]="live.length" /> } @else { · }
                  </dd>
                  @if (live()) {
                    <dd class="mt-2 text-[11px] text-primary-foreground/80">
                      {{ t("opsDashboard.hero.newThisMonth", { count: newThisMonth() }) }}
                    </dd>
                  }
                </div>
                <div class="rounded-2xl bg-white/10 p-4 backdrop-blur animate-rise [animation-delay:200ms]">
                  <dt class="text-xs font-medium text-primary-foreground/80">{{ t("opsDashboard.hero.users") }}</dt>
                  <dd class="mt-2 text-3xl font-semibold leading-none">
                    @if (data().userTotal !== null) { <app-count-up [value]="data().userTotal!" /> } @else { · }
                  </dd>
                  @if (data().suspendedUsers !== null) {
                    <dd class="mt-2 text-[11px] text-primary-foreground/80">
                      {{ t("opsDashboard.hero.suspendedUsers", { count: data().suspendedUsers! }) }}
                    </dd>
                  }
                </div>
                <div class="flex flex-col items-center rounded-2xl bg-white/10 p-4 backdrop-blur animate-rise [animation-delay:280ms]">
                  <dt class="self-start text-xs font-medium text-primary-foreground/80">{{ t("opsDashboard.hero.seats") }}</dt>
                  <dd class="relative mt-1 h-16 w-16">
                    <svg viewBox="0 0 80 80" class="h-16 w-16 -rotate-90" aria-hidden="true">
                      <circle cx="40" cy="40" r="34" fill="none" stroke-width="8" class="stroke-white/20" />
                      <circle
                        cx="40" cy="40" r="34" fill="none" stroke-width="8" stroke-linecap="round"
                        class="stroke-white animate-ring-fill"
                        [attr.stroke-dasharray]="ring"
                        [style.stroke-dashoffset]="seatRingOffset()"
                        [style.--ring-from]="ring"
                        [style.--ring-to]="seatRingOffset()"
                      />
                    </svg>
                    <span class="absolute inset-0 flex items-center justify-center text-sm font-semibold">
                      <app-count-up [value]="seatPercent()" />%
                    </span>
                  </dd>
                </div>
              </dl>
            </div>
          </section>

          <!-- Pulse: the counts worth knowing, each a link to where it is acted on. -->
          @if (pulse().length) {
            <section class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6" [attr.aria-label]="t('opsDashboard.pulse')">
              @for (tile of pulse(); track tile.key; let i = $index) {
                <a
                  [routerLink]="tile.route"
                  class="raised group relative flex flex-col gap-3 overflow-hidden rounded-2xl border border-border bg-surface p-5 shadow-card transition-all duration-300 animate-rise hover:-translate-y-1 hover:border-border-strong hover:shadow-popover"
                  [style.animation-delay.ms]="160 + i * 60"
                  [attr.title]="t(tile.hintKey)"
                >
                  <div class="flex items-center justify-between">
                    <span
                      class="flex h-9 w-9 items-center justify-center rounded-xl transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-6"
                      [class]="tile.value > 0 ? TILE_TONES[tile.tone] : 'bg-surface-muted text-foreground-muted'"
                    >
                      <ui-icon [name]="tile.icon" [size]="18" />
                    </span>
                    <ui-icon
                      name="chevron-right"
                      [size]="15"
                      class="text-foreground-subtle opacity-0 transition-all duration-200 group-hover:translate-x-0.5 group-hover:opacity-100 rtl:rotate-180"
                    />
                  </div>
                  <p class="text-[1.75rem] font-semibold leading-none tracking-tight text-foreground">
                    <app-count-up [value]="tile.value" />
                  </p>
                  <div>
                    <p class="text-sm font-medium text-foreground">{{ t(tile.labelKey) }}</p>
                    <p class="mt-0.5 text-xs leading-relaxed text-foreground-muted">{{ t(tile.hintKey) }}</p>
                  </div>
                </a>
              }
            </section>
          }

          @if (live(); as live) {
            <!-- Growth and attention. -->
            <div class="grid gap-6 xl:grid-cols-3">
              <ui-card class="animate-rise [animation-delay:200ms] xl:col-span-2">
                <ui-card-header
                  [title]="t('opsDashboard.growth')"
                  [description]="t('opsDashboard.growthSubtitle', { count: trend().added })"
                >
                  <ui-tabs [tabs]="ranges()" [active]="range()" (activeChange)="setRange($event)" />
                </ui-card-header>
                <div class="mt-6">
                  <ui-trend-chart [labels]="trend().labels" [series]="trendSeries()" />
                </div>
              </ui-card>

              <ui-card class="animate-rise [animation-delay:260ms]">
                <ui-card-header
                  [title]="t('dashboard.attention')"
                  [description]="t('opsDashboard.attentionSubtitle')"
                />
                <div class="mt-4">
                  <app-attention-panel [items]="attention()" />
                </div>
              </ui-card>
            </div>

            <!-- Composition: plans, status, seats. -->
            <div class="grid gap-6 lg:grid-cols-2 xl:grid-cols-3">
              <ui-card class="animate-rise [animation-delay:300ms]">
                <ui-card-header
                  [title]="t('dashboard.plans')"
                  [description]="t('opsDashboard.plansSubtitle')"
                />
                <div class="mt-6">
                  <ui-bar-chart [data]="planPoints()" />
                </div>
              </ui-card>

              <ui-card class="animate-rise [animation-delay:360ms]">
                <ui-card-header
                  [title]="t('opsDashboard.status')"
                  [description]="t('opsDashboard.statusSubtitle')"
                />
                <div class="mt-6 space-y-5">
                  <div class="flex h-3 w-full gap-1 overflow-hidden rounded-full bg-surface-muted">
                    @for (segment of statusSegments(); track segment.status; let i = $index) {
                      @if (segment.count > 0) {
                        <span
                          class="h-full origin-left animate-grow-x rounded-full rtl:origin-right"
                          [class]="STATUS_BAR[segment.status]"
                          [style.width.%]="segment.percent"
                          [style.animation-delay.ms]="420 + i * 120"
                          [attr.title]="t(STATUS_LABELS[segment.status])"
                        ></span>
                      }
                    }
                  </div>
                  <ul class="grid grid-cols-2 gap-3">
                    @for (segment of statusSegments(); track segment.status) {
                      <li class="flex items-center gap-2.5 rounded-xl border border-border p-3">
                        <span class="h-2.5 w-2.5 shrink-0 rounded-full" [class]="STATUS_BAR[segment.status]"></span>
                        <span class="min-w-0 flex-1 truncate text-sm text-foreground-muted">
                          {{ t(STATUS_LABELS[segment.status]) }}
                        </span>
                        <span class="text-sm font-semibold text-foreground">
                          <app-count-up [value]="segment.count" />
                        </span>
                      </li>
                    }
                  </ul>
                </div>
              </ui-card>

              <ui-card class="animate-rise [animation-delay:420ms] lg:col-span-2 xl:col-span-1">
                <ui-card-header
                  [title]="t('opsDashboard.seats')"
                  [description]="t('opsDashboard.seatsSubtitle', { used: seats().used, total: seats().total })"
                />
                @if (busiest().length) {
                  <ul class="mt-6 space-y-4">
                    @for (row of busiest(); track row.tenant.id; let i = $index) {
                      <li>
                        <a [routerLink]="['/platform/tenants', row.tenant.id]" class="group block space-y-1.5">
                          <div class="flex items-baseline justify-between gap-3">
                            <span class="truncate text-sm font-medium text-foreground transition-colors group-hover:text-primary">
                              {{ row.tenant.name }}
                            </span>
                            <span class="shrink-0 text-xs text-foreground-muted">
                              {{ t("opsDashboard.seatsOf", { used: row.tenant.userCount, total: row.tenant.userLimit }) }}
                            </span>
                          </div>
                          <div class="h-2 w-full overflow-hidden rounded-full bg-surface-muted">
                            <div
                              class="h-full origin-left animate-grow-x rounded-full rtl:origin-right"
                              [class]="row.percent >= 100 ? 'bg-danger' : row.percent >= 80 ? 'bg-warning' : 'bg-primary'"
                              [style.width.%]="row.percent > 100 ? 100 : row.percent"
                              [style.animation-delay.ms]="480 + i * 90"
                            ></div>
                          </div>
                        </a>
                      </li>
                    }
                  </ul>
                } @else {
                  <p class="mt-6 text-sm text-foreground-muted">{{ t("opsDashboard.noTenants") }}</p>
                }
              </ui-card>
            </div>

            <!-- Newest and renewing. -->
            <div class="grid gap-6 xl:grid-cols-3">
              <ui-card class="animate-rise [animation-delay:460ms] xl:col-span-2">
                <ui-card-header
                  [title]="t('opsDashboard.newest')"
                  [description]="t('opsDashboard.newestSubtitle')"
                >
                  <a uiButton routerLink="/platform/tenants" variant="ghost" size="sm">
                    {{ t("common.viewAll") }}
                    <ui-icon name="chevron-right" [size]="14" class="rtl:rotate-180" />
                  </a>
                </ui-card-header>
                @if (newest().length) {
                  <ul class="mt-4 divide-y divide-border">
                    @for (tenant of newest(); track tenant.id; let i = $index) {
                      <li class="animate-rise" [style.animation-delay.ms]="520 + i * 60">
                        <a
                          [routerLink]="['/platform/tenants', tenant.id]"
                          class="group -mx-2 flex items-center gap-3 rounded-xl px-2 py-3 transition-colors duration-200 hover:bg-surface-muted"
                        >
                          <ui-avatar [name]="tenant.name" />
                          <div class="min-w-0 flex-1">
                            <p class="truncate text-sm font-medium text-foreground">{{ tenant.name }}</p>
                            <p class="truncate text-xs text-foreground-muted" dir="ltr">{{ tenant.slug }}</p>
                          </div>
                          <div class="hidden items-center gap-2 sm:flex">
                            <ui-badge tone="primary">{{ t(PLAN_LABELS[tenant.plan]) }}</ui-badge>
                            <ui-badge [tone]="STATUS_TONES[tenant.status]" [dot]="true">
                              {{ t(STATUS_LABELS[tenant.status]) }}
                            </ui-badge>
                          </div>
                          <span class="hidden w-24 shrink-0 text-end text-xs text-foreground-subtle md:block">
                            {{ tenant.createdAt | relativeTime }}
                          </span>
                          <ui-icon
                            name="chevron-right"
                            [size]="15"
                            class="shrink-0 text-foreground-subtle opacity-0 transition-opacity duration-200 group-hover:opacity-100 rtl:rotate-180"
                          />
                        </a>
                      </li>
                    }
                  </ul>
                } @else {
                  <p class="mt-6 text-sm text-foreground-muted">{{ t("opsDashboard.noTenants") }}</p>
                }
              </ui-card>

              <ui-card class="animate-rise [animation-delay:520ms]">
                <ui-card-header
                  [title]="t('opsDashboard.renewals')"
                  [description]="t('opsDashboard.renewalsSubtitle')"
                />
                @if (renewals().length) {
                  <ul class="mt-4 space-y-3">
                    @for (row of renewals(); track row.tenant.id; let i = $index) {
                      <li class="animate-rise" [style.animation-delay.ms]="560 + i * 60">
                        <a
                          [routerLink]="['/platform/tenants', row.tenant.id]"
                          class="group block rounded-xl border border-border p-3 transition-all duration-200 hover:border-border-strong hover:shadow-card"
                        >
                          <div class="flex items-center justify-between gap-3">
                            <span class="truncate text-sm font-medium text-foreground group-hover:text-primary">
                              {{ row.tenant.name }}
                            </span>
                            <ui-badge [tone]="row.daysLeft < 0 ? 'danger' : row.daysLeft <= 30 ? 'warning' : 'neutral'">
                              {{ renewalLabel(row) }}
                            </ui-badge>
                          </div>
                          <div class="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
                            <div
                              class="h-full origin-left animate-grow-x rounded-full rtl:origin-right"
                              [class]="row.daysLeft < 0 ? 'bg-danger' : row.daysLeft <= 30 ? 'bg-warning' : 'bg-primary'"
                              [style.width.%]="row.elapsed"
                              [style.animation-delay.ms]="620 + i * 60"
                            ></div>
                          </div>
                          <p class="mt-1.5 text-[11px] text-foreground-subtle">
                            {{ t("opsDashboard.contractEnds", { date: i18n.formatDate(row.tenant.contractEndDate!) }) }}
                          </p>
                        </a>
                      </li>
                    }
                  </ul>
                } @else {
                  <div class="mt-6 flex flex-col items-center gap-2 py-6 text-center">
                    <span class="flex h-10 w-10 animate-pop items-center justify-center rounded-xl bg-success-subtle text-success">
                      <ui-icon name="calendar" [size]="18" />
                    </span>
                    <p class="text-sm font-medium text-foreground">{{ t("opsDashboard.noRenewals") }}</p>
                    <p class="text-xs text-foreground-muted">{{ t("opsDashboard.noRenewalsBody") }}</p>
                  </div>
                }
              </ui-card>
            </div>
          }

          <!-- Operator guide: what every screen is for. -->
          <section class="animate-rise [animation-delay:560ms]">
            <div class="mb-4 flex items-end justify-between gap-4">
              <div>
                <h2 class="flex items-center gap-2 text-base font-semibold text-foreground">
                  <ui-icon name="sparkles" [size]="16" class="text-primary" />
                  {{ t("opsDashboard.guide") }}
                </h2>
                <p class="text-sm text-foreground-muted">{{ t("opsDashboard.guideSubtitle") }}</p>
              </div>
            </div>
            <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
              @for (card of guide; track card.route; let i = $index) {
                <a
                  [routerLink]="card.route"
                  class="raised group flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5 shadow-card transition-all duration-300 animate-rise hover:-translate-y-1 hover:border-primary/40 hover:shadow-popover"
                  [style.animation-delay.ms]="600 + i * 70"
                >
                  <span
                    class="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-muted text-foreground-muted transition-all duration-300 group-hover:bg-primary group-hover:text-primary-foreground group-hover:shadow-primary"
                  >
                    <ui-icon [name]="card.icon" [size]="18" />
                  </span>
                  <div class="flex-1">
                    <p class="text-sm font-semibold text-foreground">{{ t(card.titleKey) }}</p>
                    <p class="mt-1 text-xs leading-relaxed text-foreground-muted">{{ t(card.bodyKey) }}</p>
                  </div>
                  <span class="inline-flex items-center gap-1 text-xs font-semibold text-primary">
                    {{ t("tenantDashboard.open") }}
                    <ui-icon
                      name="chevron-right"
                      [size]="13"
                      class="transition-transform duration-200 group-hover:translate-x-1 rtl:rotate-180 rtl:group-hover:-translate-x-1"
                    />
                  </span>
                </a>
              }
            </div>

            <div class="mt-4 grid gap-4 rounded-2xl border border-dashed border-border bg-surface-muted/50 p-5 md:grid-cols-3">
              <p class="text-xs font-semibold uppercase tracking-[0.08em] text-foreground-subtle md:col-span-3">
                {{ t("opsDashboard.tips") }}
              </p>
              @for (tip of tips; track tip.titleKey; let i = $index) {
                <div class="flex items-start gap-3 animate-rise" [style.animation-delay.ms]="700 + i * 80">
                  <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-info-subtle text-info">
                    <ui-icon [name]="tip.icon" [size]="15" />
                  </span>
                  <div>
                    <p class="text-sm font-medium text-foreground">{{ t(tip.titleKey) }}</p>
                    <p class="mt-0.5 text-xs leading-relaxed text-foreground-muted">{{ t(tip.bodyKey) }}</p>
                  </div>
                </div>
              }
            </div>
          </section>
        </div>
    } @else {
        <div class="space-y-6" aria-busy="true" [attr.aria-label]="t('dashboard.loadingLabel')">
          <ui-skeleton shape="h-64 w-full rounded-2xl" />
          <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
            @for (placeholder of [1, 2, 3, 4, 5, 6]; track placeholder) {
              <div class="space-y-3 rounded-2xl border border-border bg-surface p-5">
                <ui-skeleton shape="h-9 w-9 rounded-xl" />
                <ui-skeleton shape="h-7 w-14" />
                <ui-skeleton shape="h-4 w-28" />
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
        </div>
    }
  `
})
export class PlatformDashboardComponent {
  private readonly dashboard = inject(PlatformDashboardService);
  private readonly session = inject(SessionStore);
  protected readonly i18n = inject(I18nService);

  protected readonly t = injectT();
  protected readonly state = signal<Async<PlatformDashboardData>>(asyncLoading());
  protected readonly range = signal<TrendRange>("12m");

  protected readonly ring = RING;
  protected readonly guide = GUIDE;
  protected readonly tips = TIPS;
  protected readonly STATUS_TONES = STATUS_TONES;
  protected readonly STATUS_BAR = STATUS_BAR;
  protected readonly STATUS_LABELS = TENANT_STATUS_LABEL_KEYS;
  protected readonly PLAN_LABELS = TENANT_PLAN_LABEL_KEYS;
  protected readonly TILE_TONES = TILE_TONES;

  protected readonly canCreateTenant = computed(() =>
    this.session.permissions().includes("platform.tenant.write")
  );
  protected readonly canInviteUser = computed(() =>
    this.session.permissions().includes("platform.user.write")
  );

  /** True while a refresh runs over data already on screen. */
  protected readonly refreshing = computed(
    () => this.state().status === "loading" && this.state().data !== null
  );

  /** Only read inside the branch that has data. */
  protected readonly data = computed(() => this.state().data!);

  protected readonly heading = computed(() =>
    this.t("dashboard.greeting", {
      greeting: this.t(greetingKey()),
      name: this.session.displayName()
    })
  );

  protected readonly updatedAt = computed(() => {
    const at = this.state().data?.loadedAt;
    return at ? this.i18n.formatDate(at, { hour: "2-digit", minute: "2-digit" }) : "";
  });

  protected readonly ranges = computed<Tab[]>(() => [
    { id: "30d", label: this.t("dashboard.range30d") },
    { id: "90d", label: this.t("dashboard.range90d") },
    { id: "12m", label: this.t("dashboard.range12m") }
  ]);

  private readonly now = computed(() => this.state().data?.loadedAt ?? new Date());

  /** Tenants that are still customers — everything but the archived. */
  protected readonly live = computed(() => {
    const tenants = this.state().data?.tenants;
    return tenants ? tenants.filter((tenant) => tenant.status !== "archived") : null;
  });

  protected readonly newThisMonth = computed(() => {
    const now = this.now();
    const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    return (this.live() ?? []).filter((tenant) => Date.parse(tenant.createdAt) >= start).length;
  });

  protected readonly seats = computed(() => {
    const live = this.live() ?? [];
    return {
      used: live.reduce((sum, tenant) => sum + tenant.userCount, 0),
      total: live.reduce((sum, tenant) => sum + tenant.userLimit, 0)
    };
  });

  protected readonly seatPercent = computed(() => {
    const { used, total } = this.seats();
    return total ? Math.min(100, Math.round((used / total) * 100)) : 0;
  });

  protected readonly seatRingOffset = computed(() => RING * (1 - this.seatPercent() / 100));

  /** The five tenants closest to their seat limit — the next "we cannot hire" call. */
  protected readonly busiest = computed(() =>
    (this.live() ?? [])
      .map((tenant) => ({
        tenant,
        percent: Math.round((tenant.userCount / tenant.userLimit) * 100)
      }))
      .sort((a, b) => b.percent - a.percent)
      .slice(0, 5)
  );

  private readonly atLimit = computed(() =>
    (this.live() ?? []).filter((tenant) => tenant.userCount >= tenant.userLimit)
  );

  private readonly byStatus = computed(() => {
    const counts = Object.fromEntries(TENANT_STATUSES.map((status) => [status, 0])) as Record<
      TenantStatus,
      number
    >;
    for (const tenant of this.state().data?.tenants ?? []) counts[tenant.status] += 1;
    return counts;
  });

  protected readonly statusSegments = computed(() => {
    const counts = this.byStatus();
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    return TENANT_STATUSES.map((status) => ({
      status,
      count: counts[status],
      percent: total ? (counts[status] / total) * 100 : 0
    }));
  });

  protected readonly planPoints = computed(() => {
    const live = this.live() ?? [];
    return TENANT_PLANS.map((plan) => ({
      label: this.t(TENANT_PLAN_LABEL_KEYS[plan]),
      value: live.filter((tenant) => tenant.plan === plan).length
    }));
  });

  /** Contracts that have ended or end within 90 days, soonest first. */
  protected readonly renewals = computed<Renewal[]>(() => {
    const now = this.now().getTime();
    return (this.live() ?? [])
      .filter((tenant) => tenant.contractEndDate !== null)
      .map((tenant) => {
        const end = Date.parse(tenant.contractEndDate!);
        const start = tenant.contractStartDate ? Date.parse(tenant.contractStartDate) : end - 365 * DAY;
        const span = Math.max(DAY, end - start);
        return {
          tenant,
          daysLeft: Math.ceil((end - now) / DAY),
          elapsed: Math.min(100, Math.max(0, ((now - start) / span) * 100))
        };
      })
      .filter((row) => row.daysLeft <= 90)
      .sort((a, b) => a.daysLeft - b.daysLeft)
      .slice(0, 6);
  });

  protected readonly newest = computed(() =>
    [...(this.live() ?? [])]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 6)
  );

  protected readonly pulse = computed<PulseTile[]>(() => {
    const data = this.state().data;
    if (!data) return [];
    const tiles: PulseTile[] = [];
    const live = this.live();

    if (live) {
      tiles.push({
        key: "pending",
        icon: "mail",
        labelKey: "opsDashboard.pulse.pending",
        hintKey: "opsDashboard.pulse.pendingHint",
        value: this.byStatus().pending,
        route: "/platform/tenants",
        tone: "info"
      });
    }
    if (data.invitedUsers !== null) {
      tiles.push({
        key: "invitations",
        icon: "inbox",
        labelKey: "opsDashboard.pulse.invitations",
        hintKey: "opsDashboard.pulse.invitationsHint",
        value: data.invitedUsers,
        route: "/platform/users",
        tone: "info"
      });
    }
    if (live) {
      tiles.push(
        {
          key: "suspended",
          icon: "lock",
          labelKey: "opsDashboard.pulse.suspended",
          hintKey: "opsDashboard.pulse.suspendedHint",
          value: this.byStatus().suspended,
          route: "/platform/tenants",
          tone: "warning"
        },
        {
          key: "renewals",
          icon: "calendar",
          labelKey: "opsDashboard.pulse.renewals",
          hintKey: "opsDashboard.pulse.renewalsHint",
          value: this.renewals().filter((row) => row.daysLeft <= 30).length,
          route: "/platform/tenants",
          tone: "danger"
        },
        {
          key: "seats",
          icon: "users",
          labelKey: "opsDashboard.pulse.seats",
          hintKey: "opsDashboard.pulse.seatsHint",
          value: this.atLimit().length,
          route: "/platform/tenants",
          tone: "warning"
        }
      );
    }
    if (data.adminCount !== null) {
      tiles.push({
        key: "admins",
        icon: "shield",
        labelKey: "opsDashboard.pulse.admins",
        hintKey: "opsDashboard.pulse.adminsHint",
        value: data.adminCount,
        route: "/platform/admins",
        tone: "neutral"
      });
    }
    return tiles;
  });

  /**
   * What to act on, ranked by consequence: a lapsed contract is a commercial
   * problem today, a full tenant is a support call tomorrow, an unaccepted
   * invitation is a customer who has not started yet.
   *
   * A group of exactly one links straight to that tenant; a larger group links
   * to the list, because there is no single page to send it to.
   */
  protected readonly attention = computed<AttentionItem[]>(() => {
    const live = this.live();
    if (!live) return [];
    const items: AttentionItem[] = [];
    const tenants = (count: number) => this.i18n.plural("opsDashboard.tenantCount", count);
    const routeFor = (group: TenantSummary[]) =>
      group.length === 1 ? `/platform/tenants/${group[0].id}` : "/platform/tenants";

    const lapsed = this.renewals().filter((row) => row.daysLeft < 0);
    if (lapsed.length) {
      items.push({
        id: "lapsed",
        tone: "danger",
        icon: "calendar",
        titleKey: "opsDashboard.attn.lapsed.title",
        detailKey: "opsDashboard.attn.lapsed.detail",
        params: { tenants: tenants(lapsed.length), first: lapsed[0].tenant.name },
        route: routeFor(lapsed.map((row) => row.tenant))
      });
    }

    const renewing = this.renewals().filter((row) => row.daysLeft >= 0 && row.daysLeft <= 30);
    if (renewing.length) {
      items.push({
        id: "renewing",
        tone: "warning",
        icon: "calendar",
        titleKey: "opsDashboard.attn.renewing.title",
        detailKey: "opsDashboard.attn.renewing.detail",
        params: {
          tenants: tenants(renewing.length),
          first: renewing[0].tenant.name,
          days: this.i18n.plural("contract.dayCount", renewing[0].daysLeft)
        },
        route: routeFor(renewing.map((row) => row.tenant))
      });
    }

    const full = this.atLimit();
    if (full.length) {
      items.push({
        id: "full",
        tone: "warning",
        icon: "users",
        titleKey: "opsDashboard.attn.full.title",
        detailKey: "opsDashboard.attn.full.detail",
        params: { tenants: tenants(full.length) },
        route: routeFor(full)
      });
    }

    const suspended = live.filter((tenant) => tenant.status === "suspended");
    if (suspended.length) {
      items.push({
        id: "suspended",
        tone: "warning",
        icon: "lock",
        titleKey: "opsDashboard.attn.suspended.title",
        detailKey: "opsDashboard.attn.suspended.detail",
        params: { tenants: tenants(suspended.length) },
        route: routeFor(suspended)
      });
    }

    const pending = live.filter((tenant) => tenant.status === "pending");
    if (pending.length) {
      items.push({
        id: "pending",
        tone: "info",
        icon: "mail",
        titleKey: "opsDashboard.attn.pending.title",
        detailKey: "opsDashboard.attn.pending.detail",
        params: { tenants: tenants(pending.length) },
        route: routeFor(pending)
      });
    }

    const invited = this.state().data?.invitedUsers ?? 0;
    if (invited > 0) {
      items.push({
        id: "invitations",
        tone: "info",
        icon: "inbox",
        titleKey: "opsDashboard.attn.invitations.title",
        detailKey: "opsDashboard.attn.invitations.detail",
        params: { invitations: this.i18n.plural("opsDashboard.invitationCount", invited) },
        route: "/platform/users"
      });
    }

    return items;
  });

  protected readonly trend = computed<Trend>(() =>
    buildTrend(this.state().data?.tenants ?? [], this.now(), this.range(), (date, monthly) =>
      this.i18n.formatDate(
        date,
        monthly ? { month: "short" } : { day: "numeric", month: "short" }
      )
    )
  );

  protected readonly trendSeries = computed<TrendSeries[]>(() => [
    { name: this.t("dashboard.seriesTenants"), values: this.trend().values, slot: 1 }
  ]);

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

  protected setRange(value: string): void {
    this.range.set(value as TrendRange);
  }

  protected renewalLabel(row: Renewal): string {
    if (row.daysLeft < 0) {
      return this.t("opsDashboard.overdue", {
        days: this.i18n.plural("contract.dayCount", -row.daysLeft)
      });
    }
    return this.t("opsDashboard.inDays", {
      days: this.i18n.plural("contract.dayCount", row.daysLeft)
    });
  }
}

/**
 * Cumulative tenants over the chosen range, from each tenant's `createdAt`.
 *
 * Archived tenants count in the history — they were customers at the time,
 * and a curve that dipped every time one left would rewrite the past.
 */
function buildTrend(
  tenants: readonly TenantSummary[],
  now: Date,
  range: TrendRange,
  label: (date: Date, monthly: boolean) => string
): Trend {
  const created = tenants.map((tenant) => Date.parse(tenant.createdAt));
  const upTo = (end: number) => created.filter((at) => at <= end).length;

  let ends: Date[];
  let spanDays: number;
  if (range === "12m") {
    ends = Array.from(
      { length: 12 },
      (_, i) => new Date(now.getFullYear(), now.getMonth() - 10 + i, 0, 23, 59, 59)
    );
    ends[11] = now;
    spanDays = 365;
  } else {
    const points = range === "90d" ? 13 : 6;
    const step = range === "90d" ? 7 : 6;
    ends = Array.from(
      { length: points },
      (_, i) => new Date(now.getTime() - (points - 1 - i) * step * DAY)
    );
    spanDays = range === "90d" ? 90 : 30;
  }

  const since = now.getTime() - spanDays * DAY;
  return {
    labels: ends.map((end) => label(end, range === "12m")),
    values: ends.map((end) => upTo(end.getTime())),
    added: created.filter((at) => at > since).length
  };
}

function greetingKey(): MessageKey {
  const hour = new Date().getHours();
  if (hour < 12) return "dashboard.morning";
  return hour < 18 ? "dashboard.afternoon" : "dashboard.evening";
}
