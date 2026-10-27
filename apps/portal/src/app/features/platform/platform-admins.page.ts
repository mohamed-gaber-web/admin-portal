import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { I18nService, injectT } from "@core/i18n/i18n.service";
import { describeError } from "@core/http/api-error";
import { SessionStore } from "@core/auth/session.store";
import { ToastService } from "@core/notifications/toast.service";
import { asyncError, asyncLoading, type Async } from "@core/models";
import type { OperatorPasswordReset, PlatformAdmin } from "@growpath/contracts";
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
  MenuItemComponent,
  SkeletonComponent,
  TableComponent,
  type BadgeTone
} from "@shared/ui";
import { PageHeaderComponent } from "../../layout/page-header.component";
import { CreateAdminDialogComponent } from "./components/create-admin-dialog.component";
import { ResetLinkDialogComponent } from "./components/reset-link-dialog.component";
import { PlatformService } from "./platform.service";

/**
 * The operators themselves.
 *
 * Everybody holding the platform role — which is not quite everybody in the
 * reserved tenant, and the difference matters: a user row there who was never
 * given the role holds no `platform.*` permission and cannot reach any tenant.
 * The question this screen answers is "who can act across the installation", and
 * the role is what actually decides that.
 *
 * Creating one is the most consequential action in the portal, so it is the one
 * screen that says what the grant means before offering the button.
 */
@Component({
  selector: "app-platform-admins-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AvatarComponent,
    BadgeComponent,
    ButtonComponent,
    CardComponent,
    ConfirmDialogComponent,
    CreateAdminDialogComponent,
    DropdownComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    IconComponent,
    MenuItemComponent,
    PageHeaderComponent,
    ResetLinkDialogComponent,
    SkeletonComponent,
    TableComponent
  ],
  template: `
    <app-page-header
      [title]="t('platformAdmins.title')"
      [description]="t('platformAdmins.subtitle')"
    >
      @if (canCreate()) {
        <button uiButton (click)="dialogOpen.set(true)">
          <ui-icon name="plus" [size]="16" />
          {{ t("platformAdmins.new") }}
        </button>
      }
    </app-page-header>

    <ui-card [padded]="false">
      @switch (state().status) {
        @case ("error") {
          <ui-error-state
            [title]="t('platformAdmins.loadFailed')"
            [message]="state().error ?? ''"
            (retry)="load()"
          />
        }

        @case ("loading") {
          <div
            class="space-y-3 p-4"
            aria-busy="true"
            [attr.aria-label]="t('platformAdmins.loadingLabel')"
          >
            @for (row of [1, 2, 3]; track row) {
              <ui-skeleton shape="h-12 w-full rounded-xl" />
            }
          </div>
        }

        @default {
          @if ((state().data ?? []).length === 0) {
            <ui-empty-state
              icon="shield"
              [title]="t('platformAdmins.emptyTitle')"
              [description]="t('platformAdmins.emptyBody')"
            />
          } @else {
            <ui-table>
              <thead>
                <tr>
                  <th scope="col">{{ t("platformAdmins.columnOperator") }}</th>
                  <th scope="col">{{ t("common.status") }}</th>
                  <th scope="col">{{ t("platformAdmins.columnLastSignIn") }}</th>
                  <th scope="col">{{ t("tenantDetail.created") }}</th>
                  @if (canManage()) {
                    <th scope="col">
                      <span class="sr-only">{{ t("common.actions") }}</span>
                    </th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (admin of state().data ?? []; track admin.id) {
                  <tr>
                    <td>
                      <div class="flex items-center gap-3">
                        <ui-avatar [name]="admin.name || admin.email" size="sm" />
                        <div class="min-w-0">
                          <p class="truncate font-medium text-foreground">
                            {{ admin.name || admin.email }}
                            <!--
                              Marked, because an operator about to change
                              something is entitled to know which row is them —
                              the API refuses self-suspension and this is the
                              screen where that refusal would otherwise be a
                              surprise.
                            -->
                            @if (admin.id === currentUserId()) {
                              <span class="ms-1 text-xs font-normal text-foreground-subtle">
                                {{ t("platformAdmins.you") }}
                              </span>
                            }
                          </p>
                          <p dir="ltr" class="truncate text-xs text-foreground-subtle">
                            {{ admin.email }}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td>
                      <ui-badge [tone]="statusTone(admin)" [dot]="true">
                        {{ statusLabel(admin) }}
                      </ui-badge>
                    </td>
                    <td class="whitespace-nowrap text-foreground-muted">
                      {{
                        admin.lastLoginAt
                          ? i18n.formatDate(admin.lastLoginAt)
                          : t("platformAdmins.neverSignedIn")
                      }}
                    </td>
                    <td class="whitespace-nowrap text-foreground-muted">
                      {{ i18n.formatDate(admin.createdAt) }}
                    </td>
                    <!--
                      The same account controls the All users screen has, on the
                      same routes and permission. An operator is an ordinary user
                      row, so nothing here is new to the API.
                    -->
                    @if (canManage()) {
                      <td class="text-end">
                        @if (hasActions(admin)) {
                          <ui-dropdown align="end">
                            <button
                              type="button"
                              class="rounded-lg p-1.5 text-foreground-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-foreground"
                              [attr.aria-label]="t('users.rowActions', { name: displayName(admin) })"
                            >
                              <ui-icon name="more" [size]="16" />
                            </button>
                            <div dropdownMenu>
                              @if (admin.status === "active") {
                                <button uiMenuItem type="button" (click)="resetPending.set(admin)">
                                  <ui-icon name="key" [size]="15" />
                                  {{ t("platformUsers.resetPassword") }}
                                </button>
                              }
                              @if (isRemoved(admin)) {
                                <button uiMenuItem type="button" (click)="ask(admin, 'active')">
                                  <ui-icon name="refresh" [size]="15" />
                                  {{ t("platformUsers.reactivate") }}
                                </button>
                              }
                              <!-- Not on your own row: the API refuses it, and an
                                   operator who removed themselves could not sign
                                   back in to undo it. -->
                              @if (admin.status === "active" && admin.id !== currentUserId()) {
                                <button
                                  uiMenuItem
                                  type="button"
                                  tone="danger"
                                  (click)="ask(admin, 'suspended')"
                                >
                                  <ui-icon name="lock" [size]="15" />
                                  {{ t("users.suspend") }}
                                </button>
                              }
                            </div>
                          </ui-dropdown>
                        }
                      </td>
                    }
                  </tr>
                }
              </tbody>
            </ui-table>
          }
        }
      }
    </ui-card>

    @if (resetPending(); as admin) {
      <ui-confirm-dialog
        [title]="t('platformUsers.resetConfirmTitle', { name: displayName(admin) })"
        [description]="t('platformUsers.resetConfirmBody')"
        [confirmLabel]="t('platformUsers.resetConfirm')"
        tone="primary"
        [busy]="busy()"
        (confirmed)="issueReset(admin)"
        (cancelled)="resetPending.set(null)"
      />
    }

    @if (resetIssued(); as issued) {
      <app-reset-link-dialog
        [result]="issued.result"
        [name]="issued.name"
        (closed)="resetIssued.set(null)"
      />
    }

    @if (pending(); as request) {
      <ui-confirm-dialog
        [title]="t('platformUsers.confirmTitle', { name: displayName(request.admin) })"
        [description]="
          t(
            request.status === 'suspended'
              ? 'platformUsers.confirmSuspend'
              : 'platformUsers.confirmReactivate',
            { tenant: t('nav.platform') }
          )
        "
        [confirmLabel]="
          t(request.status === 'suspended' ? 'users.suspend' : 'platformUsers.reactivate')
        "
        [tone]="request.status === 'suspended' ? 'danger' : 'primary'"
        [busy]="busy()"
        (confirmed)="applyStatus(request)"
        (cancelled)="pending.set(null)"
      />
    }

    @if (dialogOpen()) {
      <app-create-admin-dialog (created)="load()" (closed)="dialogOpen.set(false)" />
    }
  `
})
export class PlatformAdminsPage {
  private readonly platform = inject(PlatformService);
  private readonly session = inject(SessionStore);
  private readonly toasts = inject(ToastService);

  protected readonly t = injectT();
  protected readonly i18n = inject(I18nService);

  protected readonly state = signal<Async<PlatformAdmin[]>>(asyncLoading());
  protected readonly dialogOpen = signal(false);
  protected readonly busy = signal(false);
  protected readonly resetPending = signal<PlatformAdmin | null>(null);
  /** The link just issued; held only while its dialog is open. */
  protected readonly resetIssued = signal<{ result: OperatorPasswordReset; name: string } | null>(
    null
  );
  protected readonly pending = signal<{
    admin: PlatformAdmin;
    status: "active" | "suspended";
  } | null>(null);

  /**
   * Whether to draw the row actions. `platform.user.write` is what the reset
   * and status routes check, against the signed claim.
   */
  protected readonly canManage = () => this.session.hasPermission("platform.user.write");

  protected readonly currentUserId = () => this.session.user()?.id ?? null;

  /**
   * Whether to draw the create button.
   *
   * A rendering decision only. `POST /platform/admins` checks the same
   * permission against the signed token claim, so an operator who edits this out
   * of storage gets a dialog that 403s — which is the correct outcome, and why
   * this can safely be a client-side check.
   */
  protected readonly canCreate = () => this.session.hasPermission("platform.admin.write");

  constructor() {
    this.load();
  }

  protected load(): void {
    this.state.set(asyncLoading(this.state().data));

    this.platform.listAdmins().subscribe({
      next: (admins) => this.state.set({ status: "success", data: admins, error: null }),
      error: (error: unknown) =>
        this.state.set(asyncError(describeError(error, this.t, "platformAdmins.loadError")))
    });
  }

  protected displayName(admin: PlatformAdmin): string {
    return admin.name || admin.email;
  }

  protected isRemoved(admin: PlatformAdmin): boolean {
    return admin.status === "suspended" || admin.status === "disabled";
  }

  /** An invited operator has no password to reset and nothing worth removing yet. */
  protected hasActions(admin: PlatformAdmin): boolean {
    return admin.status === "active" || this.isRemoved(admin);
  }

  protected ask(admin: PlatformAdmin, status: "active" | "suspended"): void {
    this.pending.set({ admin, status });
  }

  protected applyStatus(request: { admin: PlatformAdmin; status: "active" | "suspended" }): void {
    this.busy.set(true);
    this.platform.setUserStatus(request.admin.id, request.status).subscribe({
      next: () => {
        this.busy.set(false);
        this.pending.set(null);
        this.toasts.success(
          this.t("platformUsers.updated", { name: this.displayName(request.admin) })
        );
        this.load();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.toasts.error(
          this.t("platformUsers.updateFailed"),
          describeError(error, this.t, "platformAdmins.loadError")
        );
      }
    });
  }

  protected issueReset(admin: PlatformAdmin): void {
    this.busy.set(true);
    this.platform.issuePasswordReset(admin.id).subscribe({
      next: (result) => {
        this.busy.set(false);
        this.resetPending.set(null);
        this.resetIssued.set({ result, name: this.displayName(admin) });
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.toasts.error(
          this.t("platformUsers.resetFailed"),
          describeError(error, this.t, "platformAdmins.loadError")
        );
      }
    });
  }

  /**
   * The account's state, in the vocabulary the users screen already uses.
   *
   * `status` arrives as the raw column rather than a closed enum, because an
   * operator is an ordinary user row and that column may grow values this build
   * has not heard of. Anything unrecognised renders neutral with its own name
   * rather than being forced into one of the three known buckets.
   */
  protected statusLabel(admin: PlatformAdmin): string {
    switch (admin.status) {
      case "active":
        return this.t("userStatus.active");
      case "invited":
        return this.t("userStatus.invited");
      case "suspended":
      case "disabled":
        return this.t("userStatus.suspended");
      default:
        return admin.status;
    }
  }

  protected statusTone(admin: PlatformAdmin): BadgeTone {
    switch (admin.status) {
      case "active":
        return "success";
      case "invited":
        return "warning";
      case "suspended":
      case "disabled":
        return "danger";
      default:
        return "neutral";
    }
  }
}
