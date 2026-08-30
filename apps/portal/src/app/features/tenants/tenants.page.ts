import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { describeError } from "@core/http/api-error";
import { I18nService, injectT } from "@core/i18n/i18n.service";
import {
  TENANT_PLAN_LABEL_KEYS,
  TENANT_STATUS_LABEL_KEYS
} from "@core/i18n/label-keys";
import {
  DEFAULT_PAGE_SIZE,
  asyncError,
  asyncLoading,
  type Async,
  type Page,
  type SortDirection,
  type TenantStatus,
  type TenantSummary
} from "@core/models";
import {
  BadgeComponent,
  ButtonComponent,
  CardComponent,
  EmptyStateComponent,
  ErrorStateComponent,
  IconComponent,
  InputDirective,
  PaginationComponent,
  SkeletonComponent,
  SortHeaderComponent,
  TableComponent,
  type BadgeTone
} from "@shared/ui";
import { PageHeaderComponent } from "../../layout/page-header.component";
import { TenantsService } from "./tenants.service";

/**
 * The tenant list.
 *
 * Four states, all reachable and all distinct: loading, loaded, loaded-but-
 * empty, and failed. The empty state splits again by cause, because a search
 * that matched nothing needs a way to clear the search and an empty list does
 * not — telling someone who has eleven tenants and mistyped a filter that they
 * have none is the version of this screen that gets built by accident.
 *
 * The list holds exactly one row: the caller's own tenant, filtered by row
 * level security rather than by anything here. Every tenant on the installation
 * is a different screen, reachable only by a platform administrator.
 */
@Component({
  selector: "app-tenants-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    BadgeComponent,
    ButtonComponent,
    CardComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    IconComponent,
    InputDirective,
    PageHeaderComponent,
    PaginationComponent,
    SkeletonComponent,
    SortHeaderComponent,
    TableComponent
  ],
  template: `
    <app-page-header
      [title]="t('tenants.title')"
      [description]="t('tenants.subtitle')"
    >
      <!--
        No create button. Provisioning is a platform-administrator operation:
        a tenant creating further tenants was never intended, and the API
        refuses it. It lives on the operator console's all-tenants screen,
        which only somebody who can use it can reach.
      -->
    </app-page-header>

    <ui-card [padded]="false">
      <div class="flex flex-wrap items-center gap-3 p-4">
        <div class="relative min-w-0 flex-1 sm:max-w-xs">
          <span
            class="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-foreground-subtle"
          >
            <ui-icon name="search" [size]="16" />
          </span>
          <input
            uiInput
            type="search"
            class="!py-2 !ps-9"
            [attr.placeholder]="t('tenants.searchPlaceholder')"
            [attr.aria-label]="t('tenants.searchLabel')"
            [value]="search()"
            (input)="onSearch($event)"
          />
        </div>

        <button uiButton variant="ghost" size="sm" type="button" (click)="load()">
          <ui-icon name="refresh" [size]="15" />
          {{ t("common.refresh") }}
        </button>
      </div>

      @switch (state().status) {
        @case ("error") {
          <ui-error-state
            [title]="t('tenants.loadFailed')"
            [message]="state().error ?? ''"
            (retry)="load()"
          />
        }

        @case ("loading") {
          <div
            class="space-y-3 p-4"
            aria-busy="true"
            [attr.aria-label]="t('tenants.loadingLabel')"
          >
            @for (row of [1, 2, 3, 4, 5, 6]; track row) {
              <ui-skeleton shape="h-12 w-full rounded-xl" />
            }
          </div>
        }

        @default {
          @if (state().data!.items.length === 0) {
            @if (search()) {
              <ui-empty-state
                icon="search"
                [title]="t('tenants.noMatchTitle')"
                [description]="t('tenants.noMatchBody', { query: search() })"
              >
                <button uiButton variant="outline" size="sm" (click)="clearSearch()">
                  {{ t("common.clearSearch") }}
                </button>
              </ui-empty-state>
            } @else {
              <ui-empty-state
                icon="building"
                [title]="t('tenants.emptyTitle')"
                [description]="t('tenants.emptyBody')"
              />
            }
          } @else {
            <ui-table>
              <thead>
                <tr class="group">
                  <th
                    uiSortHeader
                    scope="col"
                    [active]="sort() === 'name'"
                    [direction]="direction()"
                    (click)="toggleSort('name')"
                  >
                    {{ t("tenants.columnTenant") }}
                  </th>
                  <th scope="col">{{ t("common.status") }}</th>
                  <th scope="col">{{ t("tenants.columnPlan") }}</th>
                  <th
                    uiSortHeader
                    scope="col"
                    [active]="sort() === 'userCount'"
                    [direction]="direction()"
                    (click)="toggleSort('userCount')"
                  >
                    {{ t("tenants.columnUsers") }}
                  </th>
                  <th scope="col">{{ t("tenants.columnCreated") }}</th>
                </tr>
              </thead>
              <tbody>
                @for (tenant of state().data!.items; track tenant.id) {
                  <tr>
                    <td>
                      <!-- The name is the link, not the whole row: a row-wide
                           click target swallows text selection and cannot be
                           opened in a new tab from the keyboard. -->
                      <a
                        [routerLink]="['/tenants', tenant.id]"
                        class="font-medium text-foreground transition-colors duration-200 hover:text-primary"
                      >
                        {{ tenant.name }}
                      </a>
                      <p dir="ltr" class="font-mono text-xs text-foreground-subtle">
                        {{ tenant.slug }}
                      </p>
                    </td>
                    <td>
                      <ui-badge [tone]="STATUS_TONES[tenant.status]" [dot]="true">
                        {{ t(STATUS_LABELS[tenant.status]) }}
                      </ui-badge>
                    </td>
                    <td class="text-foreground-muted">
                      {{ t(PLAN_LABELS[tenant.plan]) }}
                    </td>
                    <td class="tabular-nums text-foreground-muted">
                      <span [class.text-danger]="tenant.userCount >= tenant.userLimit">
                        {{
                          t("tenants.seatsUsed", {
                            used: i18n.formatNumber(tenant.userCount),
                            limit: i18n.formatNumber(tenant.userLimit)
                          })
                        }}
                      </span>
                    </td>
                    <!-- Formatted through the active locale, so an Arabic
                         reader gets an Arabic month name rather than "Aug". -->
                    <td class="whitespace-nowrap text-foreground-muted">
                      {{ i18n.formatDate(tenant.createdAt) }}
                    </td>
                  </tr>
                }
              </tbody>
            </ui-table>

            <ui-pagination
              [page]="state().data!.page"
              [pageSize]="state().data!.pageSize"
              [total]="state().data!.total"
              (pageChange)="goToPage($event)"
            />
          }
        }
      }
    </ui-card>
  `
})
export class TenantsPage {
  private readonly tenants = inject(TenantsService);

  protected readonly t = injectT();
  protected readonly i18n = inject(I18nService);
  protected readonly STATUS_LABELS = TENANT_STATUS_LABEL_KEYS;
  protected readonly PLAN_LABELS = TENANT_PLAN_LABEL_KEYS;

  protected readonly state = signal<Async<Page<TenantSummary>>>(asyncLoading());
  protected readonly search = signal("");
  protected readonly page = signal(1);
  protected readonly sort = signal<"name" | "userCount">("name");
  protected readonly direction = signal<SortDirection>("asc");

  private searchTimer?: ReturnType<typeof setTimeout>;

  protected readonly STATUS_TONES: Record<TenantStatus, BadgeTone> = {
    active: "success",
    pending: "warning",
    suspended: "danger",
    archived: "neutral"
  };

  constructor() {
    this.load();
  }

  protected load(): void {
    this.state.set(asyncLoading(this.state().data));
    this.tenants
      .list({
        page: this.page(),
        pageSize: DEFAULT_PAGE_SIZE,
        search: this.search(),
        sort: this.sort(),
        direction: this.direction()
      })
      .subscribe({
        next: (data) => this.state.set({ status: "success", data, error: null }),
        error: (error: unknown) =>
          this.state.set(asyncError(describeError(error, this.t, "tenants.loadError")))
      });
  }

  /** Debounced: one request when typing stops, not one per keystroke. */
  protected onSearch(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.search.set(value);
      this.page.set(1);
      this.load();
    }, 300);
  }

  protected clearSearch(): void {
    this.search.set("");
    this.page.set(1);
    this.load();
  }

  protected toggleSort(column: "name" | "userCount"): void {
    if (this.sort() === column) {
      this.direction.set(this.direction() === "asc" ? "desc" : "asc");
    } else {
      this.sort.set(column);
      this.direction.set("asc");
    }
    this.load();
  }

  protected goToPage(page: number): void {
    this.page.set(page);
    this.load();
  }
}
