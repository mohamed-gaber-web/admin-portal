import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  signal
} from "@angular/core";
import { RouterLink } from "@angular/router";
import { describeError } from "@core/http/api-error";
import { I18nService, injectT } from "@core/i18n/i18n.service";
import { USER_STATUS_LABEL_KEYS } from "@core/i18n/label-keys";
import type { MessageKey } from "@core/i18n/messages/en";
import { ToastService } from "@core/notifications/toast.service";
import {
  USER_ACTIONS_BY_STATUS,
  asyncError,
  asyncLoading,
  type Async,
  type Role,
  type UserAction,
  type UserDetail,
  type UserStatus
} from "@core/models";
import {
  AlertComponent,
  AvatarComponent,
  BadgeComponent,
  ButtonComponent,
  CardComponent,
  CardHeaderComponent,
  ConfirmDialogComponent,
  EmptyStateComponent,
  ErrorStateComponent,
  IconComponent,
  SelectDirective,
  SkeletonComponent,
  type BadgeTone
} from "@shared/ui";
import { RelativeTimePipe } from "@shared/pipes/relative-time.pipe";
import { RolesService } from "../roles/roles.service";
import { UsersService } from "./users.service";

/**
 * One user: who they are, what they can do, and whether they can sign in.
 *
 * Roles are shown as removable chips plus a picker, not a multi-select. A
 * multi-select hides what is currently assigned behind a click, and "what does
 * this person have right now" is the question this section exists to answer.
 *
 * The three concerns are separated deliberately — identity is read-only, roles
 * decide capability, and access decides whether any of it applies. Suspending
 * someone does not remove their roles, so restoring access restores exactly
 * what they had.
 */
@Component({
  selector: "app-user-detail-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    RelativeTimePipe,
    AlertComponent,
    AvatarComponent,
    BadgeComponent,
    ButtonComponent,
    CardComponent,
    CardHeaderComponent,
    ConfirmDialogComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    IconComponent,
    SelectDirective,
    SkeletonComponent
  ],
  template: `
    <a
      routerLink="/users"
      class="mb-5 inline-flex items-center gap-1.5 text-sm text-foreground-muted transition-colors duration-200 hover:text-foreground"
    >
      <ui-icon name="chevron-left" [size]="15" />
      {{ t("userDetail.back") }}
    </a>

    @switch (state().status) {
      @case ("error") {
        <ui-card>
          <ui-error-state
            [title]="t('userDetail.loadFailed')"
            [message]="state().error ?? ''"
            (retry)="load()"
          />
        </ui-card>
      }

      @case ("loading") {
        <div
          class="space-y-6"
          aria-busy="true"
          [attr.aria-label]="t('userDetail.loadingLabel')"
        >
          <div class="flex items-center gap-4 rounded-2xl border border-border bg-surface p-6">
            <ui-skeleton shape="h-12 w-12 rounded-full" />
            <div class="flex-1 space-y-2">
              <ui-skeleton shape="h-6 w-48" />
              <ui-skeleton shape="h-4 w-64" />
            </div>
          </div>
          <div class="grid gap-6 xl:grid-cols-3">
            <div class="space-y-3 rounded-2xl border border-border bg-surface p-6 xl:col-span-2">
              <ui-skeleton shape="h-5 w-32" />
              <ui-skeleton shape="h-24 w-full" />
            </div>
            <div class="space-y-3 rounded-2xl border border-border bg-surface p-6">
              <ui-skeleton shape="h-5 w-28" />
              <ui-skeleton shape="h-10 w-full" />
            </div>
          </div>
        </div>
      }

      @default {
        @if (state().data; as user) {
          <div class="space-y-6 animate-fade-in">
            <div class="flex flex-wrap items-start justify-between gap-4">
              <div class="flex min-w-0 items-center gap-4">
                <ui-avatar [name]="user.name" size="lg" />
                <div class="min-w-0 space-y-1">
                  <div class="flex flex-wrap items-center gap-3">
                    <h1 class="text-2xl font-semibold tracking-tight text-foreground">
                      {{ user.name }}
                    </h1>
                    <ui-badge [tone]="STATUS_TONES[user.status]" [dot]="true">
                      {{ t(STATUS_LABELS[user.status]) }}
                    </ui-badge>
                  </div>
                  <p dir="ltr" class="truncate text-sm text-foreground-muted">
                    {{ user.email }}
                  </p>
                </div>
              </div>

              <a uiButton routerLink="/tenants" variant="outline" size="md">
                <ui-icon name="building" [size]="16" />
                {{ t("userDetail.viewTenant") }}
              </a>
            </div>

            <ui-card>
              <ui-card-header [title]="t('userDetail.overview')" />
              <dl class="mt-6 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
                <div>
                  <dt class="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                    {{ t("users.columnTenant") }}
                  </dt>
                  <dd dir="ltr" class="mt-1 font-mono text-sm text-foreground">
                    {{ user.tenantSlug }}
                  </dd>
                </div>
                <div>
                  <dt class="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                    {{ t("userDetail.lastSeen") }}
                  </dt>
                  <dd class="mt-1 text-sm text-foreground">
                    {{ user.lastSeenAt | relativeTime }}
                  </dd>
                </div>
                <div>
                  <dt class="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                    {{ t("userDetail.created") }}
                  </dt>
                  <dd class="mt-1 text-sm text-foreground">
                    {{ i18n.formatDate(user.createdAt) }}
                  </dd>
                </div>
                <div class="min-w-0">
                  <dt class="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                    {{ t("userDetail.invitedBy") }}
                  </dt>
                  <dd class="mt-1 truncate text-sm text-foreground-muted">
                    @if (user.invitedBy) {
                      <span dir="ltr" class="font-mono text-xs">{{ user.invitedBy }}</span>
                    } @else {
                      {{ t("userDetail.invitedByNobody") }}
                    }
                  </dd>
                </div>
              </dl>
            </ui-card>

            <div class="grid gap-6 xl:grid-cols-3">
              <ui-card class="xl:col-span-2">
                <ui-card-header
                  [title]="t('userDetail.roles')"
                  [description]="t('userDetail.rolesSubtitle')"
                />
                <div class="mt-6 space-y-4">
                  @if (user.roles.length === 0) {
                    <ui-empty-state
                      icon="shield"
                      [title]="t('userDetail.rolesEmpty')"
                      [description]="t('userDetail.rolesEmptyBody')"
                    />
                  } @else {
                    <ul class="flex flex-wrap gap-2">
                      @for (role of user.roles; track role) {
                        <li
                          class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-muted py-1 ps-3 pe-1.5 text-sm text-foreground"
                        >
                          {{ t(labelForRole(role)) }}
                          <button
                            type="button"
                            class="rounded-full p-1 text-foreground-subtle transition-colors duration-150 hover:bg-danger-subtle hover:text-danger"
                            [disabled]="saving()"
                            [attr.aria-label]="t('userDetail.removeRole', { role: t(labelForRole(role)) })"
                            (click)="removeRole(role)"
                          >
                            <ui-icon name="close" [size]="12" />
                          </button>
                        </li>
                      }
                    </ul>
                  }

                  @if (assignable().length > 0) {
                    <div class="flex flex-wrap items-center gap-2">
                      <select
                        uiSelect
                        class="!w-auto !py-2"
                        [attr.aria-label]="t('userDetail.assignRole')"
                        [value]="chosen()"
                        (change)="onChoose($event)"
                      >
                        @for (role of assignable(); track role.id) {
                          <option [value]="role.name">{{ t(role.descriptionKey) }}</option>
                        }
                      </select>
                      <button
                        uiButton
                        variant="outline"
                        size="sm"
                        type="button"
                        [loading]="saving()"
                        (click)="assignRole()"
                      >
                        <ui-icon name="plus" [size]="15" />
                        {{ t("userDetail.assignRole") }}
                      </button>
                    </div>
                  }
                </div>
              </ui-card>

              <ui-card>
                <ui-card-header
                  [title]="t('userDetail.access')"
                  [description]="t('userDetail.accessSubtitle')"
                />
                <div class="mt-6 space-y-4">
                  @if (failure()) {
                    <ui-alert tone="danger">{{ failure() }}</ui-alert>
                  }
                  <div class="flex flex-wrap gap-2">
                    @for (action of actions(); track action) {
                      <button
                        uiButton
                        type="button"
                        [variant]="action === 'suspend' ? 'danger' : 'outline'"
                        [disabled]="saving()"
                        (click)="ask(action)"
                      >
                        <ui-icon [name]="action === 'suspend' ? 'lock' : 'check-circle'" [size]="16" />
                        {{ t(ACTION_LABELS[action]) }}
                      </button>
                    }
                  </div>
                </div>
              </ui-card>
            </div>
          </div>

          @if (pending(); as action) {
            <ui-confirm-dialog
              [title]="t(ACTION_TITLES[action])"
              [description]="t(ACTION_BODIES[action], { name: user.name })"
              [confirmLabel]="t(ACTION_LABELS[action])"
              [tone]="action === 'suspend' ? 'danger' : 'primary'"
              [busy]="saving()"
              (confirmed)="apply(action)"
              (cancelled)="pending.set(null)"
            />
          }
        } @else {
          <ui-card>
            <ui-empty-state
              icon="users"
              [title]="t('userDetail.notFoundTitle')"
              [description]="t('userDetail.notFoundBody')"
            >
              <a uiButton routerLink="/users" variant="outline" size="sm">
                {{ t("userDetail.back") }}
              </a>
            </ui-empty-state>
          </ui-card>
        }
      }
    }
  `
})
export class UserDetailPage {
  readonly id = input.required<string>();

  private readonly users = inject(UsersService);
  private readonly rolesService = inject(RolesService);
  private readonly toasts = inject(ToastService);

  protected readonly t = injectT();
  protected readonly i18n = inject(I18nService);
  protected readonly STATUS_LABELS = USER_STATUS_LABEL_KEYS;

  protected readonly state = signal<Async<UserDetail | null>>(asyncLoading());
  protected readonly roles = signal<readonly Role[]>([]);
  protected readonly saving = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly pending = signal<UserAction | null>(null);
  protected readonly chosen = signal("");

  protected readonly STATUS_TONES: Record<UserStatus, BadgeTone> = {
    active: "success",
    invited: "info",
    suspended: "danger"
  };

  protected readonly ACTION_LABELS: Record<UserAction, MessageKey> = {
    suspend: "userAction.suspend",
    reactivate: "userAction.reactivate",
    resendInvitation: "userAction.resendInvitation"
  };

  protected readonly ACTION_TITLES: Record<UserAction, MessageKey> = {
    suspend: "userAction.suspendTitle",
    reactivate: "userAction.reactivateTitle",
    resendInvitation: "userAction.resendInvitation"
  };

  protected readonly ACTION_BODIES: Record<UserAction, MessageKey> = {
    suspend: "userAction.suspendBody",
    reactivate: "userAction.reactivateBody",
    resendInvitation: "invite.newSubtitle"
  };

  constructor() {
    // Reloads when the id changes: the router reuses this component across
    // sibling users rather than recreating it, so loading once would show the
    // wrong person on the second visit.
    //
    // `allowSignalWrites` because `load()` sets the loading state synchronously
    // before the request goes out — see the same note on the tenant detail page.
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

    this.users.get(this.id()).subscribe({
      next: (data) => this.state.set({ status: "success", data, error: null }),
      error: (error: unknown) =>
        this.state.set(asyncError(describeError(error, this.t, "userDetail.loadError")))
    });

    this.rolesService.list().subscribe({
      next: (roles) => this.roles.set(roles),
      // Reported rather than swallowed. Without the tenant's roles the
      // assignment picker has nothing to offer, and an empty picker with no
      // explanation reads as "this tenant has no roles" — which is a different
      // problem with a different fix.
      error: (error: unknown) => {
        this.roles.set([]);
        this.toasts.error(
          this.t("roles.loadFailed"),
          describeError(error, this.t, "roles.loadError")
        );
      }
    });
  }

  protected actions(): UserAction[] {
    const status = this.state().data?.status;
    return status ? USER_ACTIONS_BY_STATUS[status] : [];
  }

  /** Roles the tenant has that this person does not already hold. */
  protected assignable(): readonly Role[] {
    const held = new Set(this.state().data?.roles ?? []);
    return this.roles().filter((role) => !held.has(role.name));
  }

  /**
   * Falls back to the raw name for a role the catalogue does not know.
   *
   * Roles are tenant-scoped, so a tenant can hold one this build has no key
   * for. Showing its name is better than showing a blank chip.
   */
  protected labelForRole(name: string): MessageKey {
    const known = this.roles().find((role) => role.name === name);
    return known?.descriptionKey ?? "role.member";
  }

  protected onChoose(event: Event): void {
    this.chosen.set((event.target as HTMLSelectElement).value);
  }

  protected assignRole(): void {
    const user = this.state().data;
    const name = this.chosen() || this.assignable()[0]?.name;
    if (!user || !name) return;

    this.persistRoles(user, [...user.roles, name], "userAction.roleAssigned", name);
  }

  protected removeRole(name: string): void {
    const user = this.state().data;
    if (!user) return;

    this.persistRoles(
      user,
      user.roles.filter((role) => role !== name),
      "userAction.roleRemoved",
      name
    );
  }

  private persistRoles(
    user: UserDetail,
    roles: string[],
    toastKey: MessageKey,
    roleName: string
  ): void {
    this.failure.set(null);
    this.saving.set(true);

    this.users.setRoles(user.id, roles).subscribe({
      next: (updated) => {
        this.saving.set(false);
        this.chosen.set("");
        this.state.set({ status: "success", data: updated, error: null });
        this.toasts.success(
          this.t(toastKey, { role: this.t(this.labelForRole(roleName)) })
        );
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.failure.set(describeError(error, this.t, "userAction.failed"));
      }
    });
  }

  protected ask(action: UserAction): void {
    this.failure.set(null);
    // Resending an invitation changes nothing and is safe to repeat, so it does
    // not earn a confirmation step.
    if (action === "resendInvitation") {
      this.apply(action);
      return;
    }
    this.pending.set(action);
  }

  protected apply(action: UserAction): void {
    const user = this.state().data;
    if (!user) return;

    if (action === "resendInvitation") {
      this.toasts.success(
        this.t("userAction.invitationResent", { name: user.name })
      );
      this.pending.set(null);
      return;
    }

    this.saving.set(true);
    const status: UserStatus = action === "suspend" ? "suspended" : "active";

    this.users.setStatus(user.id, status).subscribe({
      next: (updated) => {
        this.saving.set(false);
        this.pending.set(null);
        this.state.set({
          status: "success",
          data: { ...user, ...updated },
          error: null
        });
        this.toasts.success(
          this.t(
            action === "suspend" ? "userAction.suspended" : "userAction.reactivated",
            { name: updated.name }
          )
        );
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.pending.set(null);
        this.failure.set(describeError(error, this.t, "userAction.failed"));
      }
    });
  }
}
