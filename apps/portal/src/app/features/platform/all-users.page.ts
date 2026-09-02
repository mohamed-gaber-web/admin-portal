import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { describeError } from "@core/http/api-error";
import { injectT } from "@core/i18n/i18n.service";
import { USER_STATUS_LABEL_KEYS } from "@core/i18n/label-keys";
import { ToastService } from "@core/notifications/toast.service";
import { MAX_PAGE_SIZE } from "@growpath/contracts";
import {
  DEFAULT_PAGE_SIZE,
  USER_STATUSES,
  asyncError,
  asyncLoading,
  type Async,
  type Page,
  type TenantSummary,
  type UserStatus,
  type UserSummary
} from "@core/models";
import {
  AvatarComponent,
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
  SelectDirective,
  SkeletonComponent,
  TableComponent,
  type BadgeTone
} from "@shared/ui";
import { RelativeTimePipe } from "@shared/pipes/relative-time.pipe";
import { PageHeaderComponent } from "../../layout/page-header.component";
import { InviteTenantUserDialogComponent } from "./components/invite-tenant-user-dialog.component";
import { PlatformService } from "./platform.service";

/**
 * Every user across every tenant.
 *
 * The tenant column is the reason this screen exists as its own thing rather
 * than as `/users` with a wider result set: the same address can belong to
 * several tenants — `user.email` is unique per tenant, not globally — so a row
 * without its tenant is genuinely ambiguous here in a way it never is on the
 * tenant-scoped list.
 *
 * Platform operators appear in it too. An operator needs to see who else holds
 * the tier, and filtering themselves out of their own list would be a blind
 * spot in exactly the wrong place.
 */
@Component({
  selector: "app-all-users-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RelativeTimePipe,
    AvatarComponent,
    InviteTenantUserDialogComponent,
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
    PageHeaderComponent,
    PaginationComponent,
    SelectDirective,
    SkeletonComponent,
    TableComponent
  ],
  template: `
    <app-page-header
      [title]="t('platformUsers.title')"
      [description]="t('platformUsers.subtitle')"
    >
      <button uiButton variant="outline" (click)="inviteOpen.set(true)">
        <ui-icon name="mail" [size]="16" />
        {{ t("platformInvite.action") }}
      </button>
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
            [attr.placeholder]="t('platformUsers.searchPlaceholder')"
            [attr.aria-label]="t('users.searchLabel')"
            [value]="search()"
            (input)="onSearch($event)"
          />
        </div>

        <select
          uiSelect
          class="!w-auto !py-2"
          [attr.aria-label]="t('users.filterStatus')"
          [value]="status()"
          (change)="onStatus($event)"
        >
          <option value="all">{{ t("common.allStatuses") }}</option>
          @for (option of statuses; track option) {
            <option [value]="option">{{ t(STATUS_LABELS[option]) }}</option>
          }
        </select>

        <button uiButton variant="ghost" size="sm" type="button" (click)="load()">
          <ui-icon name="refresh" [size]="15" />
          {{ t("common.refresh") }}
        </button>
      </div>

      @switch (state().status) {
        @case ("error") {
          <ui-error-state
            [title]="t('users.loadFailed')"
            [message]="state().error ?? ''"
            (retry)="load()"
          />
        }

        @case ("loading") {
          <div class="space-y-3 p-4" aria-busy="true" [attr.aria-label]="t('users.loadingLabel')">
            @for (row of [1, 2, 3, 4, 5, 6]; track row) {
              <ui-skeleton shape="h-12 w-full rounded-xl" />
            }
          </div>
        }

        @default {
          @if (state().data!.items.length === 0) {
            <ui-empty-state
              icon="users"
              [title]="t('platformUsers.emptyTitle')"
              [description]="t('platformUsers.emptyBody')"
            >
              <button uiButton variant="outline" size="sm" (click)="reset()">
                {{ t("common.clearFilters") }}
              </button>
            </ui-empty-state>
          } @else {
            <ui-table>
              <thead>
                <tr>
                  <th scope="col">{{ t("users.columnUser") }}</th>
                  <th scope="col">{{ t("users.columnTenant") }}</th>
                  <th scope="col">{{ t("users.columnRole") }}</th>
                  <th scope="col">{{ t("common.status") }}</th>
                  <th scope="col">{{ t("users.columnLastSeen") }}</th>
                  <th scope="col">
                    <span class="sr-only">{{ t("common.actions") }}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                @for (user of state().data!.items; track user.id) {
                  <tr>
                    <td>
                      <div class="flex items-center gap-3">
                        <ui-avatar [name]="user.name" size="sm" />
                        <div class="min-w-0">
                          <p class="truncate font-medium text-foreground">{{ user.name }}</p>
                          <p dir="ltr" class="truncate text-xs text-foreground-subtle">
                            {{ user.email }}
                          </p>
                        </div>
                      </div>
                    </td>
                    <!-- The disambiguating column: one address can exist in
                         several tenants, so a row without this is ambiguous. -->
                    <td dir="ltr" class="font-mono text-xs text-foreground-muted">
                      {{ user.tenantSlug }}
                    </td>
                    <!-- Not translated, unlike the tenant-scoped list. Role
                         names are tenant-defined, and this screen spans every
                         tenant, so there is no catalogue to resolve them
                         against — printing the raw name is the honest option. -->
                    <td class="text-foreground-muted">{{ user.role }}</td>
                    <td>
                      <ui-badge [tone]="STATUS_TONES[user.status]" [dot]="true">
                        {{ t(STATUS_LABELS[user.status]) }}
                      </ui-badge>
                    </td>
                    <td class="whitespace-nowrap text-foreground-muted">
                      {{ user.lastSeenAt | relativeTime }}
                    </td>
                    <td class="text-end">
                      <ui-dropdown align="end">
                        <button
                          type="button"
                          class="rounded-lg p-1.5 text-foreground-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-foreground"
                          [attr.aria-label]="t('users.rowActions', { name: user.name })"
                        >
                          <ui-icon name="more" [size]="16" />
                        </button>
                        <div dropdownMenu>
                          @if (user.status === "suspended") {
                            <button uiMenuItem type="button" (click)="ask(user, 'active')">
                              <ui-icon name="refresh" [size]="15" />
                              {{ t("platformUsers.reactivate") }}
                            </button>
                          }
                          <!-- Absent for an invited account: reactivating one
                               that never had a password is refused by the API,
                               and suspending it changes nothing anybody can
                               observe. -->
                          @if (user.status === "active") {
                            <button
                              uiMenuItem
                              type="button"
                              tone="danger"
                              (click)="ask(user, 'suspended')"
                            >
                              <ui-icon name="lock" [size]="15" />
                              {{ t("users.suspend") }}
                            </button>
                          }
                        </div>
                      </ui-dropdown>
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

    @if (inviteOpen()) {
      <app-invite-tenant-user-dialog
        [tenants]="tenants()"
        (created)="load()"
        (closed)="inviteOpen.set(false)"
      />
    }

    @if (pending(); as request) {
      <ui-confirm-dialog
        [title]="t('platformUsers.confirmTitle', { name: request.user.name })"
        [description]="
          t(
            request.status === 'suspended'
              ? 'platformUsers.confirmSuspend'
              : 'platformUsers.confirmReactivate',
            { tenant: request.user.tenantSlug }
          )
        "
        [confirmLabel]="
          t(request.status === 'suspended' ? 'users.suspend' : 'platformUsers.reactivate')
        "
        [tone]="request.status === 'suspended' ? 'danger' : 'primary'"
        [busy]="busy()"
        (confirmed)="apply(request)"
        (cancelled)="pending.set(null)"
      />
    }
  `
})
export class AllUsersPage {
  private readonly platform = inject(PlatformService);
  private readonly toasts = inject(ToastService);

  protected readonly t = injectT();
  protected readonly STATUS_LABELS = USER_STATUS_LABEL_KEYS;
  protected readonly statuses = USER_STATUSES;

  protected readonly inviteOpen = signal(false);

  /**
   * Every tenant, for the dialog's picker.
   *
   * Fetched once alongside the list rather than when the dialog opens, so the
   * select is populated the moment it appears — an empty dropdown that fills in
   * a beat later is the kind of thing somebody submits before it settles.
   *
   * One page at the API's ceiling — `pageSize` is capped at 100 and a request
   * above it silently falls back to the default, so asking for more would
   * quietly fetch fewer. An installation that outgrows a hundred tenants needs
   * a searchable picker rather than a bigger page, and this is where that
   * change goes.
   */
  protected readonly tenants = signal<readonly TenantSummary[]>([]);

  protected readonly state = signal<Async<Page<UserSummary>>>(asyncLoading());
  protected readonly busy = signal(false);
  protected readonly pending = signal<{
    user: UserSummary;
    status: "active" | "suspended";
  } | null>(null);

  protected readonly search = signal("");
  protected readonly status = signal<UserStatus | "all">("all");
  protected readonly page = signal(1);

  private searchTimer?: ReturnType<typeof setTimeout>;

  protected readonly STATUS_TONES: Record<UserStatus, BadgeTone> = {
    active: "success",
    invited: "info",
    suspended: "danger"
  };

  constructor() {
    this.load();
    this.loadTenants();
  }

  private loadTenants(): void {
    this.platform.listTenants({ page: 1, pageSize: MAX_PAGE_SIZE }).subscribe({
      next: (page) => this.tenants.set(page.items),
      // Reported rather than swallowed. With no tenants the invite dialog can
      // do nothing, and a picker that is empty for a reason nobody stated reads
      // as "there are no tenants" — which would be a much stranger fact.
      error: (error: unknown) =>
        this.toasts.error(
          this.t("platformInvite.tenantsFailed"),
          describeError(error, this.t, "users.loadError")
        )
    });
  }

  protected load(): void {
    this.state.set(asyncLoading(this.state().data));
    this.platform
      .listUsers({
        page: this.page(),
        pageSize: DEFAULT_PAGE_SIZE,
        search: this.search(),
        status: this.status()
      })
      .subscribe({
        next: (data) => this.state.set({ status: "success", data, error: null }),
        error: (error: unknown) =>
          this.state.set(asyncError(describeError(error, this.t, "users.loadError")))
      });
  }

  protected ask(user: UserSummary, status: "active" | "suspended"): void {
    this.pending.set({ user, status });
  }

  protected apply(request: { user: UserSummary; status: UserStatus }): void {
    this.busy.set(true);
    this.platform.setUserStatus(request.user.id, request.status).subscribe({
      next: () => {
        this.busy.set(false);
        this.pending.set(null);
        this.toasts.success(this.t("platformUsers.updated", { name: request.user.name }));
        this.load();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        // The API's message is worth showing rather than a generic one: the two
        // refusals here — suspending your own account, reactivating an account
        // that never had a password — both tell the operator what to do
        // instead, and a fixed string would throw that away.
        this.toasts.error(
          this.t("platformUsers.updateFailed"),
          describeError(error, this.t, "users.loadError")
        );
      }
    });
  }

  protected onSearch(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.search.set(value);
      this.page.set(1);
      this.load();
    }, 300);
  }

  protected onStatus(event: Event): void {
    this.status.set((event.target as HTMLSelectElement).value as UserStatus | "all");
    this.page.set(1);
    this.load();
  }

  protected reset(): void {
    this.search.set("");
    this.status.set("all");
    this.page.set(1);
    this.load();
  }

  protected goToPage(page: number): void {
    this.page.set(page);
    this.load();
  }
}
