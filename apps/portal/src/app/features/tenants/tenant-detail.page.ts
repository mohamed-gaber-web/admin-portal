import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from "@angular/core";
import { RouterLink } from "@angular/router";
import { describeError } from "@core/http/api-error";
import { I18nService, injectT } from "@core/i18n/i18n.service";
import {
  TENANT_PLAN_LABEL_KEYS,
  TENANT_STATUS_LABEL_KEYS
} from "@core/i18n/label-keys";
import {
  asyncError,
  asyncLoading,
  type ActivityEntry,
  type Async,
  type TenantDetail,
  type TenantStatus,
  type TenantSummary
} from "@core/models";
import {
  BadgeComponent,
  ButtonComponent,
  CardComponent,
  CardHeaderComponent,
  EmptyStateComponent,
  ErrorStateComponent,
  IconComponent,
  SkeletonComponent,
  type BadgeTone
} from "@shared/ui";
import { ActivityListComponent } from "@shared/components/activity-list.component";
import { TenantEnvironmentsComponent } from "./components/tenant-environments.component";
import { TenantLifecycleComponent } from "./components/tenant-lifecycle.component";
import { TenantsService } from "./tenants.service";

/**
 * One tenant.
 *
 * The id arrives as a component input rather than through `ActivatedRoute`,
 * because the router is configured `withComponentInputBinding()`. That keeps
 * the page a plain function of its input and makes the reload-on-id-change an
 * effect rather than a subscription.
 *
 * A missing tenant is an empty state, not an error state: asking for an id that
 * does not exist is a normal thing to do with a stale link, and an alarming red
 * "something went wrong" for it teaches people to distrust the screen. A failed
 * *request* still gets the error state, with a retry.
 */
@Component({
  selector: "app-tenant-detail-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    ActivityListComponent,
    BadgeComponent,
    ButtonComponent,
    CardComponent,
    CardHeaderComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    IconComponent,
    SkeletonComponent,
    TenantEnvironmentsComponent,
    TenantLifecycleComponent
  ],
  template: `
    <a
      routerLink="/tenants"
      class="mb-5 inline-flex items-center gap-1.5 text-sm text-foreground-muted transition-colors duration-200 hover:text-foreground"
    >
      <ui-icon name="chevron-left" [size]="15" />
      {{ t("tenantDetail.back") }}
    </a>

    @switch (state().status) {
      @case ("error") {
        <ui-card>
          <ui-error-state
            [title]="t('tenantDetail.loadFailed')"
            [message]="state().error ?? ''"
            (retry)="load()"
          />
        </ui-card>
      }

      @case ("loading") {
        <div
          class="space-y-6"
          aria-busy="true"
          [attr.aria-label]="t('tenantDetail.loadingLabel')"
        >
          <div class="space-y-3 rounded-2xl border border-border bg-surface p-6">
            <ui-skeleton shape="h-7 w-56" />
            <ui-skeleton shape="h-4 w-32" />
          </div>
          <div class="grid gap-6 xl:grid-cols-3">
            <div class="space-y-3 rounded-2xl border border-border bg-surface p-6 xl:col-span-2">
              <ui-skeleton shape="h-5 w-40" />
              @for (row of [1, 2, 3]; track row) {
                <ui-skeleton shape="h-16 w-full" />
              }
            </div>
            <div class="space-y-3 rounded-2xl border border-border bg-surface p-6">
              <ui-skeleton shape="h-5 w-28" />
              <ui-skeleton shape="h-10 w-full" />
            </div>
          </div>
        </div>
      }

      @default {
        @if (state().data; as tenant) {
          <div class="space-y-6 animate-fade-in">
            <!-- Identity -->
            <div class="flex flex-wrap items-start justify-between gap-4">
              <div class="min-w-0 space-y-2">
                <div class="flex flex-wrap items-center gap-3">
                  <h1 class="text-2xl font-semibold tracking-tight text-foreground">
                    {{ tenant.name }}
                  </h1>
                  <ui-badge [tone]="STATUS_TONES[tenant.status]" [dot]="true">
                    {{ t(STATUS_LABELS[tenant.status]) }}
                  </ui-badge>
                </div>
                <p dir="ltr" class="font-mono text-sm text-foreground-subtle">
                  {{ tenant.slug }}
                </p>
              </div>

              <a uiButton routerLink="/users" variant="outline" size="md">
                <ui-icon name="users" [size]="16" />
                {{ t("tenantDetail.viewUsers") }}
              </a>
            </div>

            <!-- Overview -->
            <ui-card>
              <ui-card-header [title]="t('tenantDetail.overview')" />
              <dl class="mt-6 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
                <div>
                  <dt class="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                    {{ t("tenants.columnPlan") }}
                  </dt>
                  <dd class="mt-1 text-sm text-foreground">
                    {{ t(PLAN_LABELS[tenant.plan]) }}
                  </dd>
                </div>
                <div>
                  <dt class="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                    {{ t("tenantDetail.userCount") }}
                  </dt>
                  <!--
                    Used against included. The bare count was the right thing to
                    show while a tenant had no allowance; now that it has one,
                    the count alone hides the reason an invitation gets refused.
                  -->
                  <dd
                    class="mt-1 text-sm tabular-nums text-foreground"
                    [class.text-danger]="tenant.userCount >= tenant.userLimit"
                  >
                    {{
                      t("tenants.seatsUsed", {
                        used: i18n.formatNumber(tenant.userCount),
                        limit: i18n.formatNumber(tenant.userLimit)
                      })
                    }}
                  </dd>
                </div>
                <div>
                  <dt class="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                    {{ t("tenantDetail.created") }}
                  </dt>
                  <dd class="mt-1 text-sm text-foreground">
                    {{ i18n.formatDate(tenant.createdAt) }}
                  </dd>
                </div>
                <div class="min-w-0">
                  <dt class="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                    {{ t("tenantDetail.adminEmail") }}
                  </dt>
                  <dd dir="ltr" class="mt-1 truncate font-mono text-xs text-foreground-muted">
                    {{ tenant.adminEmail }}
                  </dd>
                </div>
              </dl>
            </ui-card>

            <div class="grid gap-6 xl:grid-cols-3">
              <ui-card class="xl:col-span-2">
                <ui-card-header
                  [title]="t('tenantDetail.environments')"
                  [description]="t('tenantDetail.environmentsSubtitle')"
                />
                <div class="mt-6">
                  <app-tenant-environments [environments]="tenant.environments" />
                </div>
              </ui-card>

              <div class="space-y-6">
                <ui-card>
                  <ui-card-header
                    [title]="t('lifecycle.title')"
                    [description]="t('lifecycle.subtitle')"
                  />
                  <div class="mt-6">
                    <app-tenant-lifecycle
                      [tenant]="tenant"
                      (changed)="onStatusChanged($event)"
                    />
                  </div>
                </ui-card>

                <ui-card>
                  <ui-card-header
                    [title]="t('tenantDetail.activity')"
                    [description]="t('tenantDetail.activitySubtitle')"
                  />
                  <div class="mt-4">
                    @if (activity().length === 0) {
                      <ui-empty-state
                        icon="activity"
                        [title]="t('tenantDetail.activityEmpty')"
                      />
                    } @else {
                      <app-activity-list [entries]="activity()" />
                    }
                  </div>
                </ui-card>
              </div>
            </div>
          </div>
        } @else {
          <ui-card>
            <ui-empty-state
              icon="building"
              [title]="t('tenantDetail.notFoundTitle')"
              [description]="t('tenantDetail.notFoundBody')"
            >
              <a uiButton routerLink="/tenants" variant="outline" size="sm">
                {{ t("tenantDetail.back") }}
              </a>
            </ui-empty-state>
          </ui-card>
        }
      }
    }
  `
})
export class TenantDetailPage {
  /** Bound from the `:id` route param by `withComponentInputBinding()`. */
  readonly id = input.required<string>();

  private readonly tenants = inject(TenantsService);

  protected readonly t = injectT();
  protected readonly i18n = inject(I18nService);
  protected readonly STATUS_LABELS = TENANT_STATUS_LABEL_KEYS;
  protected readonly PLAN_LABELS = TENANT_PLAN_LABEL_KEYS;

  protected readonly state = signal<Async<TenantDetail | null>>(asyncLoading());
  protected readonly activity = signal<readonly ActivityEntry[]>([]);

  protected readonly STATUS_TONES: Record<TenantStatus, BadgeTone> = {
    active: "success",
    pending: "warning",
    suspended: "danger",
    archived: "neutral"
  };

  constructor() {
    // Reloads when the id changes, which happens when the router reuses this
    // component for a different tenant rather than recreating it.
    //
    // `allowSignalWrites` because `load()` sets the loading state synchronously
    // before the request goes out, and Angular 18 refuses signal writes inside
    // an effect unless they are declared. The write is the point here: the
    // effect exists to react to a new id by starting a fetch, and a fetch that
    // does not show it is loading is worse than one that does. (The flag stops
    // being necessary in v19, where writes are permitted by default.)
    effect(
      () => {
        this.id();
        /*
         * `load()` is untracked, and must stay that way.
         *
         * Its first statement is `state.set(asyncLoading(state().data))` — it
         * *reads* the signal it then *writes*. Called directly here, that read
         * becomes a dependency of this effect, and the write re-triggers the
         * effect that performed it: an unbounded loop that pins a core and
         * takes the tab down with it. `allowSignalWrites` permits the write; it
         * does not break the cycle.
         *
         * The dependency this effect is meant to have is the id above, and only
         * that: reload when the route parameter changes.
         */
        untracked(() => this.load());
      },
      { allowSignalWrites: true }
    );
  }

  protected load(): void {
    this.state.set(asyncLoading(this.state().data));

    this.tenants.get(this.id()).subscribe({
      next: (data) => this.state.set({ status: "success", data, error: null }),
      error: (error: unknown) =>
        this.state.set(asyncError(describeError(error, this.t, "tenantDetail.loadError")))
    });

    // Separate call, and deliberately not awaited with the tenant: the audit
    // feed is supplementary, so a slow or empty one should not hold up the
    // identity and lifecycle controls that the page exists for.
    this.tenants.activity(this.id()).subscribe({
      next: (entries) => this.activity.set(entries),
      error: () => this.activity.set([])
    });
  }

  /**
   * Applies a lifecycle change locally rather than refetching.
   *
   * The service already returned the updated row, so a second round trip would
   * only reintroduce a loading flash on a screen the user is looking at.
   */
  protected onStatusChanged(updated: TenantSummary): void {
    const current = this.state().data;
    if (!current) return;
    this.state.set({
      status: "success",
      data: { ...current, ...updated },
      error: null
    });
  }
}
