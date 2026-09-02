import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { SessionStore } from "@core/auth/session.store";
import { RouterLink } from "@angular/router";
import { describeError } from "@core/http/api-error";
import { injectT } from "@core/i18n/i18n.service";
import { USER_STATUS_LABEL_KEYS } from "@core/i18n/label-keys";
import type { MessageKey } from "@core/i18n/messages/en";
import { ToastService } from "@core/notifications/toast.service";
import {
  DEFAULT_PAGE_SIZE,
  USER_STATUSES,
  asyncError,
  asyncLoading,
  type Async,
  type Page,
  type Role,
  type UserStatus,
  type UserSummary
} from "@core/models";
import {
  AvatarComponent,
  BadgeComponent,
  ButtonComponent,
  CardComponent,
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
import { RolesService } from "../roles/roles.service";
import { InviteUserDialogComponent } from "./components/invite-user-dialog.component";
import { UsersService } from "./users.service";

/**
 * People across every tenant.
 *
 * `invited` is shown as its own status rather than folded into "pending".
 * Provisioning creates a user row with no credential, so between the invitation
 * and its redemption the account exists and cannot sign in — an operator
 * looking at "why can't this person log in" needs that distinction on the row.
 */
@Component({
  selector: "app-users-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    RelativeTimePipe,
    AvatarComponent,
    InviteUserDialogComponent,
    BadgeComponent,
    ButtonComponent,
    CardComponent,
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
      [title]="t('users.title')"
      [description]="t('users.subtitle')"
    >
      @if (canManage()) {
        <!--
          Absent rather than disabled without user.write. There is no state a
          viewer could reach where this button would work, so a greyed-out one
          would only invite them to look for the setting that enables it.
        -->
        <button uiButton variant="outline" (click)="inviteOpen.set(true)">
          <ui-icon name="mail" [size]="16" />
          {{ t("users.invite") }}
        </button>
      }
    </app-page-header>

    <ui-card [padded]="false">
      <!-- Filters in one row above the table, as on every list screen. -->
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
            [attr.placeholder]="t('users.searchPlaceholder')"
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
              [title]="t('users.emptyTitle')"
              [description]="t('users.emptyBody')"
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
                  <th scope="col"><span class="sr-only">{{ t("common.actions") }}</span></th>
                </tr>
              </thead>
              <tbody>
                @for (user of state().data!.items; track user.id) {
                  <tr>
                    <td>
                      <div class="flex items-center gap-3">
                        <ui-avatar [name]="user.name" size="sm" />
                        <div class="min-w-0">
                          <a
                            [routerLink]="['/users', user.id]"
                            class="block truncate font-medium text-foreground transition-colors duration-200 hover:text-primary"
                          >
                            {{ user.name }}
                          </a>
                          <p dir="ltr" class="truncate text-xs text-foreground-subtle">
                            {{ user.email }}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td class="font-mono text-xs text-foreground-muted">
                      {{ user.tenantSlug }}
                    </td>
                    <td class="text-foreground-muted">{{ t(roleLabel(user.role)) }}</td>
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
                          <a uiMenuItem [routerLink]="['/users', user.id]">
                            <ui-icon name="user" [size]="15" />
                            {{ t("users.viewProfile") }}
                          </a>
                          @if (canManage()) {
                            <button uiMenuItem type="button">
                              <ui-icon name="mail" [size]="15" />
                              {{ t("users.resendInvitation") }}
                            </button>
                            <button uiMenuItem type="button" tone="danger">
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
      <app-invite-user-dialog
        [roles]="roles()"
        (created)="load()"
        (closed)="inviteOpen.set(false)"
      />
    }
  `
})
export class UsersPage {
  private readonly users = inject(UsersService);
  private readonly rolesService = inject(RolesService);
  private readonly toasts = inject(ToastService);
  private readonly session = inject(SessionStore);

  /** Whether this session may invite or change a user. */
  protected readonly canManage = computed(() => this.session.hasPermission("user.write"));

  protected readonly inviteOpen = signal(false);
  protected readonly roles = signal<readonly Role[]>([]);

  /**
   * Translates a role name for display.
   *
   * Falls back to `role.member` for a name this build has no key for — roles
   * are tenant-scoped, so a tenant can define one the portal has never seen.
   */
  protected roleLabel(name: string): MessageKey {
    return this.roles().find((role) => role.name === name)?.descriptionKey ?? "role.member";
  }

  protected readonly t = injectT();
  protected readonly STATUS_LABELS = USER_STATUS_LABEL_KEYS;
  protected readonly statuses = USER_STATUSES;
  protected readonly state = signal<Async<Page<UserSummary>>>(asyncLoading());
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
    // Fetched once for the invite dialog's role picker rather than on open, so
    // the dialog never shows an empty select while it loads.
    this.rolesService.list().subscribe({
      next: (roles) => this.roles.set(roles),
      // Says so, rather than leaving an empty picker.
      //
      // This used to set `[]` and nothing else, which made a failed request
      // indistinguishable from a tenant with no roles — the invite dialog
      // simply offered nothing, with no indication that anything had gone
      // wrong. A toast rather than an inline error because the roles are
      // supporting data here: the user list itself has loaded and is worth
      // showing.
      error: (error: unknown) => {
        this.roles.set([]);
        this.toasts.error(
          this.t("roles.loadFailed"),
          describeError(error, this.t, "roles.loadError")
        );
      }
    });
  }

  protected load(): void {
    this.state.set(asyncLoading(this.state().data));
    this.users
      .list({
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
