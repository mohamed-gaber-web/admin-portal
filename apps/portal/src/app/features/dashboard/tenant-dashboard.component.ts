import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import type { ModuleKey, TenantModule } from "@growpath/contracts";
import { SessionStore } from "@core/auth/session.store";
import { describeError } from "@core/http/api-error";
import { injectT } from "@core/i18n/i18n.service";
import { MODULE_DESCRIPTION_KEYS, MODULE_LABEL_KEYS } from "@core/i18n/label-keys";
import type { MessageKey } from "@core/i18n/messages/en";
import { asyncError, asyncLoading, type Async } from "@core/models";
import {
  ButtonComponent,
  CardComponent,
  CardHeaderComponent,
  ErrorStateComponent,
  IconComponent,
  SkeletonComponent,
  type IconName
} from "@shared/ui";
import { CountUpComponent } from "./components/count-up.component";
import {
  TenantDashboardService,
  type TenantDashboardData
} from "./tenant-dashboard.service";

interface SetupStep {
  id: string;
  icon: IconName;
  titleKey: MessageKey;
  bodyKey: MessageKey;
  ctaKey: MessageKey;
  route: string;
  done: boolean;
}

interface GlanceStat {
  key: string;
  icon: IconName;
  labelKey: MessageKey;
  value: number;
  /** When set, the figure reads "3 of 13". */
  total?: number;
  route: string;
}

interface ExploreCard {
  icon: IconName;
  titleKey: MessageKey;
  bodyKey: MessageKey;
  route: string;
}

/**
 * Glyphs for the modules. A record over `ModuleKey`, so a module added to the
 * contract fails the build here until it is given one.
 */
const MODULE_ICONS: Record<ModuleKey, IconName> = {
  inventory: "package",
  "purchase-order": "cart",
  "sales-order": "trending-up",
  "return-order": "refresh",
  project: "calendar",
  production: "factory",
  warehouse: "building",
  inquiry: "search",
  "van-sales": "truck",
  "route-tracking": "map-pin",
  "trade-payments": "wallet",
  performance: "bar-chart",
  distribution: "network"
};

/** The portal's tenant-facing screens, in the order an administrator meets them. */
const EXPLORE: readonly ExploreCard[] = [
  {
    icon: "users",
    titleKey: "tenantDashboard.explore.users.title",
    bodyKey: "tenantDashboard.explore.users.body",
    route: "/users"
  },
  {
    icon: "shield",
    titleKey: "tenantDashboard.explore.roles.title",
    bodyKey: "tenantDashboard.explore.roles.body",
    route: "/roles"
  },
  {
    icon: "database",
    titleKey: "tenantDashboard.explore.configuration.title",
    bodyKey: "tenantDashboard.explore.configuration.body",
    route: "/configuration"
  },
  {
    icon: "activity",
    titleKey: "tenantDashboard.explore.activity.title",
    bodyKey: "tenantDashboard.explore.activity.body",
    route: "/activity"
  },
  {
    icon: "lock",
    titleKey: "tenantDashboard.explore.settings.title",
    bodyKey: "tenantDashboard.explore.settings.body",
    route: "/settings"
  }
];

/** Circumference of the progress ring, r = 34. */
const RING = 2 * Math.PI * 34;

/**
 * A tenant's landing screen: what to set up next, and what there is to find.
 *
 * Separate from the operator dashboard rather than a filtered copy of it. A
 * workspace that was provisioned five minutes ago has no growth curve and no
 * audit history worth charting — what it has is an empty D365 connection and a
 * team of one, and the useful screen for that moment is a checklist, not a row
 * of zeroes.
 *
 * Every step's done-state is read from the API, never stored: the checklist
 * cannot drift from reality, and there is nothing to dismiss or reset.
 *
 * The motion is an entrance, played once per visit — cards rise in sequence,
 * the ring fills, the figures count up. It all collapses under
 * `prefers-reduced-motion` (the CSS by the global rule in styles.css, the
 * counters by `CountUpComponent` itself).
 */
@Component({
  selector: "app-tenant-dashboard",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    ButtonComponent,
    CardComponent,
    CardHeaderComponent,
    CountUpComponent,
    ErrorStateComponent,
    IconComponent,
    SkeletonComponent
  ],
  template: `
    <div class="mb-6 min-w-0 space-y-1 animate-rise">
      <h1 class="text-2xl font-semibold tracking-tight text-foreground">{{ heading() }}</h1>
      <p class="text-sm text-foreground-muted">
        {{ t("tenantDashboard.subtitle", { workspace: workspace() }) }}
      </p>
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
        <div class="space-y-6">
          <!-- Hero: where setup stands, and the one thing to do next. -->
          <section
            class="relative isolate overflow-hidden rounded-2xl bg-primary bg-gradient-to-br from-primary via-primary to-info p-6 text-primary-foreground shadow-primary animate-rise sm:p-8"
          >
            <span
              class="pointer-events-none absolute -end-16 -top-20 -z-10 h-64 w-64 rounded-full bg-white/20 blur-3xl animate-float"
              aria-hidden="true"
            ></span>
            <span
              class="pointer-events-none absolute -bottom-24 start-1/4 -z-10 h-56 w-56 rounded-full bg-info/40 blur-3xl animate-float [animation-delay:-4s]"
              aria-hidden="true"
            ></span>

            <div class="flex flex-col gap-6 md:flex-row md:items-center">
              <div class="min-w-0 flex-1 space-y-3">
                <p
                  class="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold uppercase tracking-[0.08em] backdrop-blur"
                >
                  <ui-icon [name]="allDone() ? 'sparkles' : 'rocket'" [size]="14" />
                  {{ t(allDone() ? "tenantDashboard.heroDoneEyebrow" : "tenantDashboard.heroEyebrow") }}
                </p>
                <h2 class="text-2xl font-semibold tracking-tight sm:text-3xl">
                  {{
                    t(allDone() ? "tenantDashboard.heroDoneTitle" : "tenantDashboard.heroTitle", {
                      workspace: workspace()
                    })
                  }}
                </h2>
                <p class="max-w-xl text-sm leading-relaxed text-primary-foreground/85">
                  {{ t(allDone() ? "tenantDashboard.heroDoneBody" : "tenantDashboard.heroBody") }}
                </p>

                @if (nextStep(); as next) {
                  <a
                    [routerLink]="next.route"
                    class="group mt-2 inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-primary shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:shadow-popover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                  >
                    {{ t("tenantDashboard.continue", { step: t(next.titleKey) }) }}
                    <ui-icon
                      name="chevron-right"
                      [size]="16"
                      class="transition-transform duration-200 group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5"
                    />
                  </a>
                }
              </div>

              @if (steps().length) {
                <div
                  class="flex shrink-0 items-center gap-4 md:flex-col md:gap-2"
                  role="img"
                  [attr.aria-label]="progressText()"
                >
                  <svg viewBox="0 0 80 80" class="h-24 w-24 -rotate-90" aria-hidden="true">
                    <circle cx="40" cy="40" r="34" fill="none" stroke-width="7" class="stroke-white/20" />
                    <circle
                      cx="40"
                      cy="40"
                      r="34"
                      fill="none"
                      stroke-width="7"
                      stroke-linecap="round"
                      class="stroke-white animate-ring-fill"
                      [attr.stroke-dasharray]="ring"
                      [style.stroke-dashoffset]="ringOffset()"
                      [style.--ring-from]="ring"
                      [style.--ring-to]="ringOffset()"
                    />
                  </svg>
                  <div class="text-start md:text-center">
                    <p class="text-3xl font-semibold leading-none">
                      <app-count-up [value]="percent()" />%
                    </p>
                    <p class="mt-1 text-xs text-primary-foreground/80">{{ progressText() }}</p>
                  </div>
                </div>
              }
            </div>
          </section>

          <div class="grid gap-6 xl:grid-cols-5">
            <!-- Checklist -->
            @if (steps().length) {
              <ui-card class="animate-rise xl:col-span-3 [animation-delay:80ms]">
                <ui-card-header
                  [title]="t('tenantDashboard.checklist')"
                  [description]="t('tenantDashboard.checklistSubtitle')"
                />
                <ol class="mt-5 space-y-3">
                  @for (step of steps(); track step.id; let i = $index) {
                    <li
                      class="group relative flex items-start gap-4 rounded-xl border p-4 transition-all duration-200 animate-rise"
                      [style.animation-delay.ms]="160 + i * 90"
                      [class]="stepClass(step)"
                    >
                      <span
                        class="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors duration-200"
                        [class]="step.done ? 'bg-success text-success-foreground' : step.id === nextStep()?.id ? 'bg-primary text-primary-foreground shadow-primary' : 'bg-surface-muted text-foreground-muted'"
                      >
                        @if (step.done) {
                          <ui-icon name="check" [size]="18" [strokeWidth]="2.5" class="animate-pop" [style.animation-delay.ms]="400 + i * 90" />
                        } @else {
                          <ui-icon [name]="step.icon" [size]="18" />
                        }
                        @if (step.id === nextStep()?.id) {
                          <span class="absolute inset-0 -z-10 animate-ping rounded-xl bg-primary/30" aria-hidden="true"></span>
                        }
                      </span>

                      <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-center gap-2">
                          <p
                            class="text-sm font-semibold text-foreground"
                            [class.line-through]="step.done"
                            [class.decoration-foreground-subtle]="step.done"
                          >
                            {{ t(step.titleKey) }}
                          </p>
                          @if (step.done) {
                            <span class="rounded-full bg-success-subtle px-2 py-0.5 text-[11px] font-semibold text-success">
                              {{ t("tenantDashboard.stepDone") }}
                            </span>
                          } @else if (step.id === nextStep()?.id) {
                            <span class="rounded-full bg-primary-subtle px-2 py-0.5 text-[11px] font-semibold text-primary">
                              {{ t("tenantDashboard.stepNext") }}
                            </span>
                          }
                        </div>
                        <p class="mt-1 text-xs leading-relaxed text-foreground-muted">{{ t(step.bodyKey) }}</p>
                      </div>

                      @if (!step.done) {
                        <a
                          uiButton
                          [routerLink]="step.route"
                          [variant]="step.id === nextStep()?.id ? 'primary' : 'outline'"
                          size="sm"
                          class="shrink-0 self-center"
                        >
                          {{ t(step.ctaKey) }}
                        </a>
                      }
                    </li>
                  }
                </ol>
              </ui-card>
            }

            <!-- At a glance -->
            @if (stats().length) {
              <section
                class="grid content-start gap-4 sm:grid-cols-2"
                [class.xl:col-span-2]="steps().length"
                [class.xl:col-span-5]="!steps().length"
                [class.xl:grid-cols-4]="!steps().length"
                [attr.aria-label]="t('tenantDashboard.atAGlance')"
              >
                @for (stat of stats(); track stat.key; let i = $index) {
                  <a
                    [routerLink]="stat.route"
                    class="raised group flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5 shadow-card transition-all duration-200 animate-rise hover:-translate-y-1 hover:border-border-strong hover:shadow-popover"
                    [style.animation-delay.ms]="200 + i * 80"
                  >
                    <span
                      class="flex h-9 w-9 items-center justify-center rounded-xl bg-primary-subtle text-primary transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-6"
                    >
                      <ui-icon [name]="stat.icon" [size]="18" />
                    </span>
                    <p class="text-[1.75rem] font-semibold leading-none tracking-tight text-foreground">
                      <app-count-up [value]="stat.value" />
                      @if (stat.total !== undefined) {
                        <span class="ms-1 text-sm font-medium text-foreground-subtle">
                          {{ t("tenantDashboard.ofTotal", { total: stat.total }) }}
                        </span>
                      }
                    </p>
                    <p class="text-sm font-medium text-foreground-muted">{{ t(stat.labelKey) }}</p>
                  </a>
                }
              </section>
            }
          </div>

          <!-- Modules -->
          @if (state().data!.modules; as modules) {
            <ui-card class="animate-rise [animation-delay:240ms]">
              <ui-card-header
                [title]="t('tenantDashboard.modules')"
                [description]="t('tenantDashboard.modulesSubtitle')"
              >
                <a uiButton routerLink="/configuration" variant="ghost" size="sm">
                  {{ t("common.viewAll") }}
                  <ui-icon name="chevron-right" [size]="14" class="rtl:rotate-180" />
                </a>
              </ui-card-header>

              @if (enabledModules().length) {
                <div class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  @for (module of enabledModules(); track module.key; let i = $index) {
                    <div
                      class="group relative overflow-hidden rounded-xl border border-border bg-surface p-4 transition-all duration-300 animate-rise hover:-translate-y-1 hover:border-primary/40 hover:shadow-popover"
                      [style.animation-delay.ms]="300 + i * 60"
                    >
                      <span
                        class="pointer-events-none absolute -end-10 -top-10 h-28 w-28 rounded-full bg-primary/10 opacity-0 blur-2xl transition-opacity duration-300 group-hover:opacity-100"
                        aria-hidden="true"
                      ></span>
                      <div class="flex items-start gap-3">
                        <span
                          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-info text-primary-foreground shadow-primary transition-transform duration-300 group-hover:scale-110"
                        >
                          <ui-icon [name]="moduleIcon(module)" [size]="18" />
                        </span>
                        <div class="min-w-0 flex-1">
                          <p class="text-sm font-semibold text-foreground">{{ moduleLabel(module) }}</p>
                          <p class="mt-0.5 text-xs leading-relaxed text-foreground-muted">
                            {{ moduleDescription(module) }}
                          </p>
                        </div>
                      </div>
                    </div>
                  }
                </div>
              } @else {
                <div class="mt-5 flex items-center gap-3 rounded-xl border border-dashed border-border p-4 text-sm text-foreground-muted">
                  <ui-icon name="info" [size]="18" class="shrink-0 text-info" />
                  {{ t("tenantDashboard.modulesEmpty") }}
                </div>
              }

              @if (availableModules().length) {
                <div class="mt-6 border-t border-border pt-5">
                  <p class="text-sm font-semibold text-foreground">{{ t("tenantDashboard.availableTitle") }}</p>
                  <p class="mt-0.5 text-xs text-foreground-muted">{{ t("tenantDashboard.availableBody") }}</p>
                  <ul class="mt-3 flex flex-wrap gap-2">
                    @for (module of availableModules(); track module.key; let i = $index) {
                      <li
                        class="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-3 py-1.5 text-xs font-medium text-foreground-muted transition-colors duration-200 animate-rise hover:border-primary/50 hover:text-primary"
                        [style.animation-delay.ms]="400 + i * 40"
                        [attr.title]="moduleDescription(module)"
                      >
                        <ui-icon [name]="moduleIcon(module)" [size]="13" />
                        {{ moduleLabel(module) }}
                      </li>
                    }
                  </ul>
                </div>
              }
            </ui-card>
          }

          <!-- Explore -->
          <section class="animate-rise [animation-delay:320ms]">
            <div class="mb-4">
              <h2 class="text-base font-semibold text-foreground">{{ t("tenantDashboard.explore") }}</h2>
              <p class="text-sm text-foreground-muted">{{ t("tenantDashboard.exploreSubtitle") }}</p>
            </div>
            <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
              @for (card of explore; track card.route; let i = $index) {
                <a
                  [routerLink]="card.route"
                  class="raised group flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5 shadow-card transition-all duration-300 animate-rise hover:-translate-y-1 hover:border-primary/40 hover:shadow-popover"
                  [style.animation-delay.ms]="380 + i * 70"
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
          </section>
        </div>
      }

      @default {
        <div class="space-y-6" aria-busy="true" [attr.aria-label]="t('dashboard.loadingLabel')">
          <ui-skeleton shape="h-52 w-full rounded-2xl" />
          <div class="grid gap-6 xl:grid-cols-5">
            <div class="space-y-3 rounded-2xl border border-border bg-surface p-6 xl:col-span-3">
              <ui-skeleton shape="h-5 w-40" />
              @for (placeholder of [1, 2, 3]; track placeholder) {
                <ui-skeleton shape="h-20 w-full rounded-xl" />
              }
            </div>
            <div class="grid content-start gap-4 sm:grid-cols-2 xl:col-span-2">
              @for (placeholder of [1, 2, 3, 4]; track placeholder) {
                <div class="space-y-3 rounded-2xl border border-border bg-surface p-5">
                  <ui-skeleton shape="h-9 w-9 rounded-xl" />
                  <ui-skeleton shape="h-7 w-16" />
                  <ui-skeleton shape="h-4 w-24" />
                </div>
              }
            </div>
          </div>
        </div>
      }
    }
  `
})
export class TenantDashboardComponent {
  private readonly dashboard = inject(TenantDashboardService);
  private readonly session = inject(SessionStore);

  protected readonly t = injectT();
  protected readonly state = signal<Async<TenantDashboardData>>(asyncLoading());
  protected readonly explore = EXPLORE;
  protected readonly ring = RING;

  protected readonly workspace = this.session.workspaceName;

  protected readonly heading = computed(() =>
    this.t("dashboard.greeting", {
      greeting: this.t(greetingKey()),
      name: this.session.displayName()
    })
  );

  /**
   * Only the steps whose state could be read. A step that 403'd is left out
   * rather than shown as undone — telling someone to do a thing they cannot
   * see is worse than not mentioning it.
   */
  protected readonly steps = computed<SetupStep[]>(() => {
    const data = this.state().data;
    if (!data) return [];
    const steps: SetupStep[] = [];

    if (data.connections !== null) {
      steps.push({
        id: "connect",
        icon: "database",
        titleKey: "tenantDashboard.step.connect.title",
        bodyKey: "tenantDashboard.step.connect.body",
        ctaKey: "tenantDashboard.step.connect.cta",
        route: "/configuration",
        done: data.connections.some((connection) => connection.state === "connected")
      });
    }
    if (data.mobileConfig !== undefined) {
      steps.push({
        id: "mobile",
        icon: "smartphone",
        titleKey: "tenantDashboard.step.mobile.title",
        bodyKey: "tenantDashboard.step.mobile.body",
        ctaKey: "tenantDashboard.step.mobile.cta",
        route: "/configuration",
        done: data.mobileConfig !== null
      });
    }
    if (data.teamSize !== null) {
      steps.push({
        id: "team",
        icon: "users",
        titleKey: "tenantDashboard.step.team.title",
        bodyKey: "tenantDashboard.step.team.body",
        ctaKey: "tenantDashboard.step.team.cta",
        route: "/users",
        // More than one: the administrator reading this is the first.
        done: data.teamSize > 1
      });
    }
    return steps;
  });

  protected readonly doneCount = computed(() => this.steps().filter((step) => step.done).length);
  protected readonly allDone = computed(
    () => this.steps().length > 0 && this.doneCount() === this.steps().length
  );
  protected readonly nextStep = computed(() => this.steps().find((step) => !step.done) ?? null);

  protected readonly percent = computed(() => {
    const total = this.steps().length;
    return total ? Math.round((this.doneCount() / total) * 100) : 0;
  });

  protected readonly ringOffset = computed(() => RING * (1 - this.percent() / 100));

  protected readonly progressText = computed(() =>
    this.t("tenantDashboard.progress", {
      done: this.doneCount(),
      total: this.steps().length
    })
  );

  protected readonly enabledModules = computed(() =>
    (this.state().data?.modules ?? []).filter((module) => module.enabled)
  );
  protected readonly availableModules = computed(() =>
    (this.state().data?.modules ?? []).filter((module) => !module.enabled)
  );

  protected readonly stats = computed<GlanceStat[]>(() => {
    const data = this.state().data;
    if (!data) return [];
    const stats: GlanceStat[] = [];
    if (data.teamSize !== null) {
      stats.push({
        key: "team",
        icon: "users",
        labelKey: "tenantDashboard.stat.team",
        value: data.teamSize,
        route: "/users"
      });
    }
    if (data.pendingInvitations !== null) {
      stats.push({
        key: "invitations",
        icon: "mail",
        labelKey: "tenantDashboard.stat.invitations",
        value: data.pendingInvitations,
        route: "/users"
      });
    }
    if (data.modules !== null) {
      stats.push({
        key: "modules",
        icon: "package",
        labelKey: "tenantDashboard.stat.modules",
        value: this.enabledModules().length,
        total: data.modules.length,
        route: "/configuration"
      });
    }
    if (data.connections !== null) {
      stats.push({
        key: "environments",
        icon: "database",
        labelKey: "tenantDashboard.stat.environments",
        value: data.connections.filter((connection) => connection.state === "connected").length,
        total: data.connections.length,
        route: "/configuration"
      });
    }
    return stats;
  });

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

  protected stepClass(step: SetupStep): string {
    if (step.done) return "border-success/30 bg-success-subtle/40";
    if (step.id === this.nextStep()?.id) {
      return "border-primary/40 bg-primary-subtle/40 shadow-card hover:shadow-popover";
    }
    return "border-border bg-surface hover:border-border-strong";
  }

  protected moduleIcon(module: TenantModule): IconName {
    return MODULE_ICONS[module.key as ModuleKey] ?? "package";
  }

  /** Translated, falling back to the API's English for an unknown key. */
  protected moduleLabel(module: TenantModule): string {
    const key = MODULE_LABEL_KEYS[module.key as ModuleKey];
    return key ? this.t(key) : module.key;
  }

  protected moduleDescription(module: TenantModule): string {
    const key = MODULE_DESCRIPTION_KEYS[module.key as ModuleKey];
    return key ? this.t(key) : module.description;
  }
}

function greetingKey(): MessageKey {
  const hour = new Date().getHours();
  if (hour < 12) return "dashboard.morning";
  return hour < 18 ? "dashboard.afternoon" : "dashboard.evening";
}
