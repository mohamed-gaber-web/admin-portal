import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { I18nService, injectT } from "@core/i18n/i18n.service";
import { describeError } from "@core/http/api-error";
import { asyncError, asyncLoading, type Async } from "@core/models";
import type { CatalogPermission } from "@growpath/contracts";
import {
  BadgeComponent,
  CardComponent,
  CardHeaderComponent,
  ErrorStateComponent,
  SkeletonComponent,
  TableComponent
} from "@shared/ui";
import { PageHeaderComponent } from "../../layout/page-header.component";
import { PlatformService } from "./platform.service";

/**
 * Every permission the installation defines.
 *
 * Read-only, and there is no writing counterpart anywhere in the product:
 * `permission` is a global table the application holds `SELECT` on and nothing
 * else, so a screen offering to add or rename one would be offering an operation
 * the database refuses. What *is* editable is which permissions a role holds,
 * which is a tenant-scoped screen (`/roles`).
 *
 * ### Why an operator needs this and a tenant administrator does not
 *
 * The role matrix at `/roles` shows a tenant the seven keys they may grant. It
 * deliberately does not show the `platform.*` half, because those may not be
 * granted inside a tenant at all — the database refuses it with a trigger. So
 * there is no screen anywhere that shows the catalogue *whole*, which makes
 * "what can this system authorise, and who currently holds it" a question only
 * answerable by reading migrations. This is the answer.
 *
 * The role counts span every tenant, which is what makes the screen worth having
 * rather than a static list in the documentation: it answers "is anybody
 * actually using this", the question asked before a permission is retired.
 */
@Component({
  selector: "app-platform-permissions-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BadgeComponent,
    CardComponent,
    CardHeaderComponent,
    ErrorStateComponent,
    PageHeaderComponent,
    SkeletonComponent,
    TableComponent
  ],
  template: `
    <app-page-header
      [title]="t('platformPermissions.title')"
      [description]="t('platformPermissions.subtitle')"
    />

    @switch (state().status) {
      @case ("error") {
        <ui-card>
          <ui-error-state
            [title]="t('platformPermissions.loadFailed')"
            [message]="state().error ?? ''"
            (retry)="load()"
          />
        </ui-card>
      }

      @case ("loading") {
        <ui-card>
          <div
            class="space-y-3"
            aria-busy="true"
            [attr.aria-label]="t('platformPermissions.loadingLabel')"
          >
            @for (row of [1, 2, 3, 4, 5, 6]; track row) {
              <ui-skeleton shape="h-10 w-full rounded-xl" />
            }
          </div>
        </ui-card>
      }

      @default {
        <!--
          Two tables rather than one with a column, because the two halves are
          not comparable. A tenant key authorises something inside one customer;
          a platform key authorises it across all of them, and the database
          refuses to grant one to the other's roles. Listing them together with a
          badge would suggest they sit on the same axis.
        -->
        <div class="space-y-6">
          <ui-card [padded]="false">
            <div class="p-6 pb-0">
              <ui-card-header
                [title]="t('platformPermissions.tenantScoped')"
                [description]="t('platformPermissions.tenantScopedBody')"
              />
            </div>
            <div class="mt-6">
              <ui-table>
                <thead>
                  <tr>
                    <th scope="col">{{ t("platformPermissions.columnKey") }}</th>
                    <th scope="col">{{ t("platformPermissions.columnMeaning") }}</th>
                    <th scope="col">{{ t("platformPermissions.columnRoles") }}</th>
                  </tr>
                </thead>
                <tbody>
                  @for (permission of tenantPermissions(); track permission.key) {
                    <tr>
                      <td dir="ltr" class="font-mono text-xs text-foreground">
                        {{ permission.key }}
                      </td>
                      <td class="text-foreground-muted">{{ permission.description }}</td>
                      <td class="tabular-nums text-foreground-muted">
                        {{ i18n.formatNumber(permission.roleCount) }}
                      </td>
                    </tr>
                  }
                </tbody>
              </ui-table>
            </div>
          </ui-card>

          <ui-card [padded]="false">
            <div class="p-6 pb-0">
              <ui-card-header
                [title]="t('platformPermissions.platformScoped')"
                [description]="t('platformPermissions.platformScopedBody')"
              />
            </div>
            <div class="mt-6">
              <ui-table>
                <thead>
                  <tr>
                    <th scope="col">{{ t("platformPermissions.columnKey") }}</th>
                    <th scope="col">{{ t("platformPermissions.columnMeaning") }}</th>
                    <th scope="col">{{ t("platformPermissions.columnRoles") }}</th>
                  </tr>
                </thead>
                <tbody>
                  @for (permission of platformPermissions(); track permission.key) {
                    <tr>
                      <td dir="ltr" class="font-mono text-xs text-foreground">
                        {{ permission.key }}
                        <ui-badge tone="warning" class="ms-2">
                          {{ t("platformPermissions.crossTenant") }}
                        </ui-badge>
                      </td>
                      <td class="text-foreground-muted">{{ permission.description }}</td>
                      <td class="tabular-nums text-foreground-muted">
                        {{ i18n.formatNumber(permission.roleCount) }}
                      </td>
                    </tr>
                  }
                </tbody>
              </ui-table>
            </div>
          </ui-card>
        </div>
      }
    }
  `
})
export class PlatformPermissionsPage {
  private readonly platform = inject(PlatformService);

  protected readonly t = injectT();
  protected readonly i18n = inject(I18nService);

  protected readonly state = signal<Async<CatalogPermission[]>>(asyncLoading());

  protected readonly tenantPermissions = computed(() =>
    (this.state().data ?? []).filter((permission) => !permission.platform)
  );

  protected readonly platformPermissions = computed(() =>
    (this.state().data ?? []).filter((permission) => permission.platform)
  );

  constructor() {
    this.load();
  }

  protected load(): void {
    this.state.set(asyncLoading(this.state().data));

    this.platform.listPermissions().subscribe({
      next: (permissions) =>
        this.state.set({ status: "success", data: permissions, error: null }),
      error: (error: unknown) =>
        this.state.set(
          asyncError(describeError(error, this.t, "platformPermissions.loadError"))
        )
    });
  }
}
