import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { SessionStore } from "@core/auth/session.store";
import { describeError } from "@core/http/api-error";
import { I18nService, injectT } from "@core/i18n/i18n.service";
import {
  TENANT_PLAN_LABEL_KEYS,
  TENANT_STATUS_LABEL_KEYS
} from "@core/i18n/label-keys";
import { ToastService } from "@core/notifications/toast.service";
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
  ConfirmDialogComponent,
  DropdownComponent,
  EmptyStateComponent,
  ErrorStateComponent,
  IconComponent,
  InputDirective,
  MenuItemComponent,
  PaginationComponent,
  SkeletonComponent,
  SortHeaderComponent,
  TableComponent,
  type BadgeTone
} from "@shared/ui";
import { PageHeaderComponent } from "../../layout/page-header.component";
import { CreateTenantDialogComponent } from "./components/create-tenant-dialog.component";
import { PlatformService } from "./platform.service";

/**
 * Every tenant on the installation.
 *
 * The cross-tenant twin of `/tenants`, which shows the caller their own
 * organisation and nothing else. Two screens rather than one that changes shape
 * by permission: the difference between "my tenant" and "every customer" is
 * exactly the difference worth being unable to confuse, and a single screen
 * whose reach depended on a flag is one wrong default away from showing the
 * customer list to a tenant administrator.
 *
 * The reserved platform tenant is absent, because the API leaves it out — it is
 * the operators' own workspace rather than a customer, and archiving it would
 * soft-delete the only tenant from which a tenant can be created.
 */
@Component({
  selector: "app-all-tenants-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    BadgeComponent,
    ButtonComponent,
    CardComponent,
    ConfirmDialogComponent,
    CreateTenantDialogComponent,
    DropdownComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    IconComponent,
    InputDirective,
    MenuItemComponent,
    PageHeaderComponent,
    PaginationComponent,
    SkeletonComponent,
    SortHeaderComponent,
    TableComponent
  ],
  template: `
    <app-page-header
      [title]="t('platformTenants.title')"
      [description]="t('platformTenants.subtitle')"
    >
      @if (canManageTenants()) {
        <button uiButton (click)="dialogOpen.set(true)">
          <ui-icon name="plus" [size]="16" />
          {{ t("tenants.new") }}
        </button>
      }
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
              <!--
                The description changes with the permission, rather than only
                the button disappearing. An empty list under a heading that offers
                no way forward reads as a broken screen; saying where tenants
                come from instead is the difference between "nothing here" and
                "nothing here, and here is why".
              -->
              <ui-empty-state
                icon="building"
                [title]="t('platformTenants.emptyTitle')"
                [description]="
                  canManageTenants()
                    ? t('platformTenants.emptyBody')
                    : t('platformTenants.emptyBodyNoCreate')
                "
              >
                @if (canManageTenants()) {
                  <button uiButton size="sm" (click)="dialogOpen.set(true)">
                    <ui-icon name="plus" [size]="15" />
                    {{ t("tenants.new") }}
                  </button>
                }
              </ui-empty-state>
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
                  <th scope="col">
                    <span class="sr-only">{{ t("common.actions") }}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                @for (tenant of state().data!.items; track tenant.id) {
                  <tr>
                    <td>
                      <!--
                        The name is the link, not a separate "view" action in
                        the row menu. The menu holds the destructive lifecycle
                        transitions, and putting a harmless navigation beside
                        "archive" is how somebody archives a tenant they meant
                        to open.
                      -->
                      <a
                        [routerLink]="['/platform/tenants', tenant.id]"
                        class="font-medium text-foreground transition-colors duration-200 hover:text-primary"
                      >
                        {{ tenant.name }}
                      </a>
                      <p dir="ltr" class="font-mono text-xs text-foreground-subtle">
                        {{ tenant.slug }}
                      </p>
                      <!--
                        The address to contact about this customer. In the name
                        cell rather than a column of its own: it is an attribute
                        of who this tenant is, and a sixth column would push the
                        lifecycle menu off a laptop screen.
                      -->
                      @if (tenant.adminEmail) {
                        <p dir="ltr" class="truncate text-xs text-foreground-muted">
                          {{ tenant.adminEmail }}
                        </p>
                      }
                    </td>
                    <td>
                      <ui-badge [tone]="STATUS_TONES[tenant.status]" [dot]="true">
                        {{ t(STATUS_LABELS[tenant.status]) }}
                      </ui-badge>
                    </td>
                    <td class="text-foreground-muted">{{ t(PLAN_LABELS[tenant.plan]) }}</td>
                    <!--
                      Used against included, not a bare count. The bare number
                      cannot be acted on; the fraction says whether this customer
                      is about to be unable to add anyone. Turns red at the
                      limit, which is the row an operator is looking for.
                    -->
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
                    <td class="whitespace-nowrap text-foreground-muted">
                      {{ i18n.formatDate(tenant.createdAt) }}
                    </td>
                    <td class="text-end">
                      <!--
                        The whole menu goes, not each item: the only actions in
                        it are the lifecycle transitions, so a reader with no
                        write permission would otherwise get a trigger that
                        opens an empty popover.
                      -->
                      @if (canManageTenants()) {
                        <ui-dropdown align="end">
                          <button
                            type="button"
                            class="rounded-lg p-1.5 text-foreground-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-foreground"
                            [attr.aria-label]="
                              t('platformTenants.rowActions', { name: tenant.name })
                            "
                          >
                            <ui-icon name="more" [size]="16" />
                          </button>
                          <div dropdownMenu>
                            <!-- Offered by current state, not all four at once: a
                                 menu that lets you suspend an already-suspended
                                 tenant invites a click that does nothing and
                                 reads as a failure. -->
                            @if (tenant.status !== "suspended" && tenant.status !== "archived") {
                              <button uiMenuItem type="button" (click)="ask(tenant, 'suspended')">
                                <ui-icon name="lock" [size]="15" />
                                {{ t("lifecycle.suspend") }}
                              </button>
                            }
                            @if (tenant.status === "suspended" || tenant.status === "archived") {
                              <button uiMenuItem type="button" (click)="ask(tenant, 'active')">
                                <ui-icon name="refresh" [size]="15" />
                                {{ t("lifecycle.reactivate") }}
                              </button>
                            }
                            @if (tenant.status !== "archived") {
                              <button
                                uiMenuItem
                                type="button"
                                tone="danger"
                                (click)="ask(tenant, 'archived')"
                              >
                                <ui-icon name="trash" [size]="15" />
                                {{ t("lifecycle.archive") }}
                              </button>
                            }
                          </div>
                        </ui-dropdown>
                      }
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

    @if (pending(); as request) {
      <!--
        Type-to-confirm on the slug, and only for archiving. This is somebody
        acting on a tenant that is not their own and whose users are not in the
        room; typing the slug forces a last look at which row this is.
      -->
      <ui-confirm-dialog
        [title]="t(CONFIRM_TITLE[request.status])"
        [description]="t(CONFIRM_BODY[request.status], { name: request.tenant.name })"
        [confirmLabel]="t(CONFIRM_LABEL[request.status])"
        [warning]="
          request.status === 'archived' ? t('lifecycle.archiveWarning') : undefined
        "
        [tone]="request.status === 'archived' ? 'danger' : 'primary'"
        [confirmPhrase]="request.status === 'archived' ? request.tenant.slug : undefined"
        [busy]="busy()"
        (confirmed)="apply(request)"
        (cancelled)="pending.set(null)"
      />
    }

    <!--
      Guarded on the permission as well as on the signal, so the dialog cannot
      be opened by anything that sets dialogOpen without going through a button
      that was never drawn.
    -->
    @if (canManageTenants() && dialogOpen()) {
      <app-create-tenant-dialog (created)="load()" (closed)="dialogOpen.set(false)" />
    }
  `
})
export class AllTenantsPage {
  private readonly platform = inject(PlatformService);
  private readonly toasts = inject(ToastService);

  protected readonly t = injectT();
  protected readonly i18n = inject(I18nService);
  protected readonly STATUS_LABELS = TENANT_STATUS_LABEL_KEYS;
  protected readonly PLAN_LABELS = TENANT_PLAN_LABEL_KEYS;

  private readonly session = inject(SessionStore);

  /**
   * Whether to draw the tenant-management controls: the create button, and the
   * lifecycle transitions in each row's menu.
   *
   * One check for both, because the installation defines one permission for
   * both — `platform.tenant.write` is "create tenants and change any tenant's
   * lifecycle state". Splitting it in the client would invent a distinction the
   * API does not enforce.
   *
   * This replaces the former `features.tenantCreation` build flag. That flag was
   * off because provisioning happened outside the portal; now that it happens
   * here, the question is no longer "does this build offer it" but "may this
   * operator do it" — and an operator holding only `platform.tenant.read` should
   * see the list without buttons that would 403.
   *
   * A rendering decision only. `POST /tenants` and
   * `PATCH /platform/tenants/:id/status` both check the same permission against
   * the signed token claim, so an operator who edits this out of storage gets
   * the buttons back and the same 403 they would have got anyway.
   */
  protected readonly canManageTenants = () =>
    this.session.hasPermission("platform.tenant.write");

  protected readonly state = signal<Async<Page<TenantSummary>>>(asyncLoading());
  protected readonly dialogOpen = signal(false);
  protected readonly busy = signal(false);
  protected readonly pending = signal<{
    tenant: TenantSummary;
    status: "active" | "suspended" | "archived";
  } | null>(null);

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

  /**
   * The tenant detail screen's own lifecycle wording, reused.
   *
   * Same actions, same consequences, so a second set of strings would be two
   * translations of one idea — free to drift, and confusing when they do. The
   * maps are written out per state rather than interpolated because
   * `scripts/check-i18n.mjs` can only see a key that appears literally in the
   * source, and one interpolated key would blind the unused-key check for the
   * whole family.
   */
  protected readonly CONFIRM_TITLE = {
    active: "lifecycle.reactivateTitle",
    suspended: "lifecycle.suspendTitle",
    archived: "lifecycle.archiveTitle"
  } as const;

  protected readonly CONFIRM_BODY = {
    active: "lifecycle.reactivateBody",
    suspended: "lifecycle.suspendBody",
    archived: "lifecycle.archiveBody"
  } as const;

  protected readonly CONFIRM_LABEL = {
    active: "lifecycle.reactivate",
    suspended: "lifecycle.suspend",
    archived: "lifecycle.archive"
  } as const;

  private readonly TOAST = {
    active: "lifecycle.reactivated",
    suspended: "lifecycle.suspended",
    archived: "lifecycle.archived"
  } as const;

  constructor() {
    this.load();
  }

  protected load(): void {
    this.state.set(asyncLoading(this.state().data));
    this.platform
      .listTenants({
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

  protected ask(tenant: TenantSummary, status: "active" | "suspended" | "archived"): void {
    this.pending.set({ tenant, status });
  }

  protected apply(request: {
    tenant: TenantSummary;
    status: "active" | "suspended" | "archived";
  }): void {
    this.busy.set(true);
    this.platform.setTenantStatus(request.tenant.id, request.status).subscribe({
      next: () => {
        this.busy.set(false);
        this.pending.set(null);
        this.toasts.success(
          this.t(this.TOAST[request.status], { name: request.tenant.name })
        );
        // Reloaded rather than patched in place: the status the API derives
        // depends on rows this screen does not hold, so a locally computed one
        // could disagree with the next refresh.
        this.load();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.toasts.error(
          this.t("lifecycle.failed"),
          describeError(error, this.t, "tenants.loadError")
        );
      }
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
