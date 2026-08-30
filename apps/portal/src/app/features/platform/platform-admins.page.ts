import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { I18nService, injectT } from "@core/i18n/i18n.service";
import { describeError } from "@core/http/api-error";
import { SessionStore } from "@core/auth/session.store";
import { asyncError, asyncLoading, type Async } from "@core/models";
import type { PlatformAdmin } from "@growpath/contracts";
import {
  AvatarComponent,
  BadgeComponent,
  ButtonComponent,
  CardComponent,
  EmptyStateComponent,
  ErrorStateComponent,
  IconComponent,
  SkeletonComponent,
  TableComponent,
  type BadgeTone
} from "@shared/ui";
import { PageHeaderComponent } from "../../layout/page-header.component";
import { CreateAdminDialogComponent } from "./components/create-admin-dialog.component";
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
    CreateAdminDialogComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    IconComponent,
    PageHeaderComponent,
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
                  </tr>
                }
              </tbody>
            </ui-table>
          }
        }
      }
    </ui-card>

    @if (dialogOpen()) {
      <app-create-admin-dialog (created)="load()" (closed)="dialogOpen.set(false)" />
    }
  `
})
export class PlatformAdminsPage {
  private readonly platform = inject(PlatformService);
  private readonly session = inject(SessionStore);

  protected readonly t = injectT();
  protected readonly i18n = inject(I18nService);

  protected readonly state = signal<Async<PlatformAdmin[]>>(asyncLoading());
  protected readonly dialogOpen = signal(false);

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
