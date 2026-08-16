import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from "@angular/core";
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
  type TenantStatus
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
import { TenantEnvironmentsComponent } from "../tenants/components/tenant-environments.component";
import { TenantModulesComponent } from "./components/tenant-modules.component";
import { TenantSubscriptionComponent } from "./components/tenant-subscription.component";
import { PlatformService } from "./platform.service";

/**
 * One tenant, seen by whoever operates the installation.
 *
 * The cross-tenant twin of `/tenants/:id`, and a separate page rather than that
 * one with extra cards. The difference is the same difference the two list
 * screens draw: `/tenants/:id` is an administrator looking at their own
 * organisation, and this is an operator looking at a customer. Only one of them
 * gets to change what that customer has paid for, and a single page whose
 * controls appeared or vanished by permission is a page where forgetting the
 * check hands a tenant administrator their own billing.
 *
 * What is here and not on the tenant-facing page:
 *
 *   - **Subscription** — the plan, and cancelling it.
 *   - **Modules** — which functional areas the customer is entitled to.
 *
 * What is deliberately *not* here: the lifecycle controls. Suspending and
 * archiving live on the list screen, where the row being acted on is next to the
 * rows it is not — and where the archive confirmation already asks for the slug.
 */
@Component({
  selector: "app-platform-tenant-detail-page",
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
    TenantModulesComponent,
    TenantSubscriptionComponent
  ],
  template: `
    <a
      routerLink="/platform/tenants"
      class="mb-5 inline-flex items-center gap-1.5 text-sm text-foreground-muted transition-colors duration-200 hover:text-foreground"
    >
      <ui-icon name="chevron-left" [size]="15" />
      {{ t("platformTenantDetail.back") }}
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
                  <ui-badge tone="info">{{ t(PLAN_LABELS[tenant.plan]) }}</ui-badge>
                </div>
                <p dir="ltr" class="font-mono text-sm text-foreground-subtle">
                  {{ tenant.slug }}
                </p>
              </div>

              <a uiButton routerLink="/platform/users" variant="outline" size="md">
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
                  <dd class="mt-1 text-sm tabular-nums text-foreground">
                    {{ i18n.formatNumber(tenant.userCount) }}
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
              <div class="space-y-6 xl:col-span-2">
                <ui-card>
                  <ui-card-header
                    [title]="t('modules.title')"
                    [description]="t('modules.subtitle')"
                  />
                  <div class="mt-6">
                    <app-tenant-modules [tenantId]="tenant.id" />
                  </div>
                </ui-card>

                <ui-card>
                  <ui-card-header
                    [title]="t('tenantDetail.environments')"
                    [description]="t('tenantDetail.environmentsSubtitle')"
                  />
                  <div class="mt-6">
                    <app-tenant-environments [environments]="tenant.environments" />
                  </div>
                </ui-card>
              </div>

              <div class="space-y-6">
                <ui-card>
                  <ui-card-header
                    [title]="t('subscription.title')"
                    [description]="t('subscription.subtitle')"
                  />
                  <div class="mt-6">
                    <app-tenant-subscription
                      [tenant]="tenant"
                      (changed)="onTenantChanged($event)"
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
              <a uiButton routerLink="/platform/tenants" variant="outline" size="sm">
                {{ t("platformTenantDetail.back") }}
              </a>
            </ui-empty-state>
          </ui-card>
        }
      }
    }
  `
})
export class PlatformTenantDetailPage {
  /** Bound from the `:id` route param by `withComponentInputBinding()`. */
  readonly id = input.required<string>();

  private readonly platform = inject(PlatformService);

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
    effect(
      () => {
        this.id();
        this.load();
      },
      { allowSignalWrites: true }
    );
  }

  protected load(): void {
    this.state.set(asyncLoading(this.state().data));

    this.platform.getTenant(this.id()).subscribe({
      next: (data) => this.state.set({ status: "success", data, error: null }),
      error: (error: unknown) =>
        this.state.set(asyncError(describeError(error, this.t, "tenantDetail.loadError")))
    });

    // Supplementary, so it is not awaited with the tenant: a slow audit feed
    // should not hold up the controls the page exists for.
    this.platform.tenantActivity(this.id()).subscribe({
      next: (entries) => this.activity.set(entries),
      error: () => this.activity.set([])
    });
  }

  /**
   * Adopts the tenant the server returned, rather than refetching.
   *
   * The plan endpoint returns the whole tenant precisely so this is possible —
   * a second round trip would only put a loading flash on a screen somebody is
   * looking at, and a locally patched copy is how a screen starts disagreeing
   * with the database.
   */
  protected onTenantChanged(updated: TenantDetail): void {
    this.state.set({ status: "success", data: updated, error: null });
  }
}
