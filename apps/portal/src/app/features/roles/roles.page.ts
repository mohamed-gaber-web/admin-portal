import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { SessionStore } from "@core/auth/session.store";
import { describeError } from "@core/http/api-error";
import { I18nService, injectT } from "@core/i18n/i18n.service";
import { ToastService } from "@core/notifications/toast.service";
import {
  PERMISSION_CATALOGUE,
  asyncError,
  asyncLoading,
  type Async,
  type Role
} from "@core/models";
import {
  AlertComponent,
  BadgeComponent,
  CardComponent,
  CardHeaderComponent,
  EmptyStateComponent,
  ErrorStateComponent,
  SkeletonComponent,
  TableComponent
} from "@shared/ui";
import { PageHeaderComponent } from "../../layout/page-header.component";
import {
  PermissionMatrixComponent,
  type PermissionToggle
} from "./components/permission-matrix.component";
import { RolesService } from "./roles.service";

/**
 * Roles and what each may do.
 *
 * Two views of the same data: a summary table for "which roles exist and how
 * many people hold them", and the matrix for "who can do what". The table
 * answers the first question at a glance and the matrix answers the second
 * without either having to compromise for the other.
 *
 * Both are readable by anyone in the tenant; changing a tick takes `user.write`,
 * which the API checks on `PUT /roles/:id/permissions`. Without it the matrix
 * renders disabled and says so, rather than offering a checkbox whose only
 * outcome is a 403 — and rather than hiding the screen, which would leave a
 * viewer with no way to see what their role actually holds.
 */
@Component({
  selector: "app-roles-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AlertComponent,
    BadgeComponent,
    CardComponent,
    CardHeaderComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    PageHeaderComponent,
    PermissionMatrixComponent,
    SkeletonComponent,
    TableComponent
  ],
  template: `
    <app-page-header [title]="t('roles.title')" [description]="t('roles.subtitle')" />

    @switch (state().status) {
      @case ("error") {
        <ui-card>
          <ui-error-state
            [title]="t('roles.loadFailed')"
            [message]="state().error ?? ''"
            (retry)="load()"
          />
        </ui-card>
      }

      @case ("loading") {
        <div
          class="space-y-6"
          aria-busy="true"
          [attr.aria-label]="t('roles.loadingLabel')"
        >
          <div class="space-y-3 rounded-2xl border border-border bg-surface p-6">
            @for (row of [1, 2, 3]; track row) {
              <ui-skeleton shape="h-12 w-full" />
            }
          </div>
          <div class="rounded-2xl border border-border bg-surface p-6">
            <ui-skeleton shape="h-[320px] w-full" />
          </div>
        </div>
      }

      @default {
        @if (state().data!.length === 0) {
          <ui-card>
            <ui-empty-state
              icon="shield"
              [title]="t('roles.emptyTitle')"
              [description]="t('roles.emptyBody')"
            />
          </ui-card>
        } @else {
          <div class="space-y-6 animate-fade-in">
            @if (failure()) {
              <ui-alert tone="danger">{{ failure() }}</ui-alert>
            }

            <ui-card [padded]="false">
              <ui-table>
                <thead>
                  <tr>
                    <th scope="col">{{ t("roles.columnRole") }}</th>
                    <th scope="col">{{ t("roles.columnUsers") }}</th>
                    <th scope="col">{{ t("roles.columnPermissions") }}</th>
                  </tr>
                </thead>
                <tbody>
                  @for (role of state().data!; track role.id) {
                    <tr>
                      <td>
                        <div class="flex flex-wrap items-center gap-2">
                          <span class="font-medium text-foreground">
                            {{ t(role.descriptionKey) }}
                          </span>
                          @if (role.builtIn) {
                            <ui-badge tone="neutral">{{ t("roles.builtIn") }}</ui-badge>
                          }
                        </div>
                        <p dir="ltr" class="font-mono text-xs text-foreground-subtle">
                          {{ role.name }}
                        </p>
                      </td>
                      <td class="tabular-nums text-foreground-muted">
                        {{ i18n.formatNumber(role.userCount) }}
                      </td>
                      <td class="tabular-nums text-foreground-muted">
                        {{
                          t("roles.permissionCount", {
                            granted: role.permissions.length,
                            total: catalogueSize
                          })
                        }}
                      </td>
                    </tr>
                  }
                </tbody>
              </ui-table>
            </ui-card>

            <ui-card>
              <ui-card-header
                [title]="t('roles.matrixTitle')"
                [description]="t('roles.matrixSubtitle')"
              />
              <div class="mt-6">
                @if (!canManage()) {
                  <ui-alert class="mb-4 block" tone="info" [title]="t('roles.readOnlyTitle')">
                    {{ t("roles.readOnlyBody") }}
                  </ui-alert>
                }

                <app-permission-matrix
                  [roles]="state().data!"
                  [busy]="saving()"
                  [readOnly]="!canManage()"
                  (toggled)="onToggle($event)"
                />
              </div>
            </ui-card>
          </div>
        }
      }
    }
  `
})
export class RolesPage {
  private readonly roles = inject(RolesService);
  private readonly toasts = inject(ToastService);
  private readonly session = inject(SessionStore);

  protected readonly t = injectT();
  protected readonly i18n = inject(I18nService);
  protected readonly catalogueSize = PERMISSION_CATALOGUE.length;

  /** Whether this session may change a role's permissions. */
  protected readonly canManage = computed(() => this.session.hasPermission("user.write"));

  protected readonly state = signal<Async<Role[]>>(asyncLoading());
  protected readonly saving = signal(false);
  protected readonly failure = signal<string | null>(null);

  constructor() {
    this.load();
  }

  protected load(): void {
    this.state.set(asyncLoading(this.state().data));
    this.roles.list().subscribe({
      next: (data) => this.state.set({ status: "success", data, error: null }),
      error: (error: unknown) =>
        this.state.set(asyncError(describeError(error, this.t, "roles.loadError")))
    });
  }

  protected onToggle({ roleId, permission, granted }: PermissionToggle): void {
    // The service sends the role's resolved permission set, not the single
    // toggle, so it needs the role as it currently stands. Taken from the
    // loaded state rather than refetched — the matrix is showing it already.
    const role = (this.state().data ?? []).find((entry) => entry.id === roleId);
    if (!role || !this.canManage()) return;

    this.failure.set(null);
    this.saving.set(true);

    this.roles.setPermission(role, permission, granted).subscribe({
      next: (updated) => {
        this.saving.set(false);
        // Replaced in place rather than refetched: the service returned the
        // whole role, and a reload would flash the matrix the user is looking at.
        const current = this.state().data ?? [];
        this.state.set({
          status: "success",
          data: current.map((role) => (role.id === updated.id ? updated : role)),
          error: null
        });
        this.toasts.success(
          this.t("roles.saved", { role: this.t(updated.descriptionKey) })
        );
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.failure.set(describeError(error, this.t, "roles.saveFailed"));
        // The checkbox already moved, so put the truth back on screen.
        this.load();
      }
    });
  }
}
