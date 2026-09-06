import { ChangeDetectionStrategy, Component, computed, inject, signal } from "@angular/core";
import { SessionStore } from "@core/auth/session.store";
import { describeError } from "@core/http/api-error";
import { injectT } from "@core/i18n/i18n.service";
import { asyncError, asyncLoading, type Async } from "@core/models";
import type { Connection, MobileConfig, TenantModule } from "@growpath/contracts";
import {
  AlertComponent,
  CardComponent,
  CardHeaderComponent,
  EmptyStateComponent,
  ErrorStateComponent,
  SkeletonComponent,
  TabsComponent,
  type Tab
} from "@shared/ui";
import { PageHeaderComponent } from "../../layout/page-header.component";
import { ConnectionCardComponent } from "./components/connection-card.component";
import { MobileConfigFormComponent } from "./components/mobile-config-form.component";
import { OwnModulesComponent } from "./components/own-modules.component";
import { ConfigurationService } from "./configuration.service";

/**
 * The tenant's own configuration (US-065, US-040).
 *
 * Two things an administrator sets up when a tenant goes live, and they were
 * both reachable only through the API until now — the endpoints have existed
 * since the D365 and mobile stories landed, and nothing in the portal called
 * them.
 *
 * Tabs rather than two routes, because they are one task done in one sitting:
 * you configure the ERP connection and then tell the devices where to find the
 * API, and a person doing that should not have to remember two menu entries.
 *
 * Both halves are tenant-scoped. Neither takes a tenant identifier anywhere —
 * it comes from the access token's claims and row level security does the
 * filtering, so there is nothing on this screen to point at somebody else.
 *
 * ### Who may change what
 *
 * Everyone in the tenant may *read* this screen; changing it needs a write
 * permission, and the two halves need different ones — `connection.write` for
 * the ERP credential, `tenant.write` for the device configuration. So the page
 * resolves both here and hands each half a `readOnly` flag, rather than letting
 * two components each go and ask the session the same question slightly
 * differently.
 *
 * A viewer therefore gets the whole screen with its forms disabled and a line
 * saying why, which is the honest rendering: they are not missing a page, they
 * are missing an authority. The API enforces the same split on the claim
 * (`PermissionGuard`), so this is presentation and not protection — a session
 * that edits its stored permissions gets buttons that 403.
 */
@Component({
  selector: "app-configuration-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AlertComponent,
    CardComponent,
    CardHeaderComponent,
    ConnectionCardComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    MobileConfigFormComponent,
    OwnModulesComponent,
    PageHeaderComponent,
    SkeletonComponent,
    TabsComponent
  ],
  template: `
    <app-page-header
      [title]="t('configuration.title')"
      [description]="t('configuration.subtitle')"
    />

    <ui-tabs [tabs]="tabs()" [(active)]="tab" />

    @if (tab() === "connections") {
      <ui-card class="mt-6 block">
        <ui-card-header
          [title]="t('connections.title')"
          [description]="t('connections.subtitle')"
        />

        @if (!canManageConnections()) {
          <ui-alert class="mt-6 block" tone="info" [title]="t('configuration.readOnlyTitle')">
            {{ t("configuration.readOnlyConnections") }}
          </ui-alert>
        }

        <div class="mt-6">
          @switch (connections().status) {
            @case ("error") {
              <ui-error-state
                [title]="t('connections.loadFailed')"
                [message]="connections().error ?? ''"
                (retry)="loadConnections()"
              />
            }

            @case ("loading") {
              <div
                class="space-y-4"
                aria-busy="true"
                [attr.aria-label]="t('connections.loadingLabel')"
              >
                @for (row of [1, 2]; track row) {
                  <ui-skeleton shape="h-64 w-full rounded-xl" />
                }
              </div>
            }

            @default {
              @if ((connections().data ?? []).length === 0) {
                <!--
                  A connection has no identity apart from its environment, so
                  there is no "add connection" button here and there cannot be:
                  the thing to create is an environment, which is provisioning.
                -->
                <ui-empty-state
                  icon="database"
                  [title]="t('connections.emptyTitle')"
                  [description]="t('connections.emptyBody')"
                />
              } @else {
                <div class="space-y-4">
                  @for (connection of connections().data ?? []; track connection.environmentId) {
                    <app-connection-card
                      [connection]="connection"
                      [readOnly]="!canManageConnections()"
                      (changed)="onConnectionChanged($event)"
                    />
                  }
                </div>
              }
            }
          }
        </div>
      </ui-card>
    } @else if (tab() === "modules") {
      <ui-card class="mt-6 block">
        <ui-card-header
          [title]="t('ownModules.title')"
          [description]="t('ownModules.subtitle')"
        />

        <div class="mt-6">
          @switch (modules().status) {
            @case ("error") {
              <ui-error-state
                [title]="t('modules.loadFailed')"
                [message]="modules().error ?? ''"
                (retry)="loadModules()"
              />
            }

            @case ("loading") {
              <div
                class="space-y-3"
                aria-busy="true"
                [attr.aria-label]="t('modules.loadingLabel')"
              >
                @for (row of [1, 2, 3, 4]; track row) {
                  <ui-skeleton shape="h-14 w-full rounded-xl" />
                }
              </div>
            }

            @default {
              <!--
                Read-only, and it says so rather than showing disabled toggles.
                A greyed-out switch invites somebody to hunt for the permission
                that would enable it; there is none, because this is not a
                setting — it is what the customer bought.
              -->
              <app-own-modules [modules]="modules().data ?? []" />
            }
          }
        </div>
      </ui-card>
    } @else {
      <ui-card class="mt-6 block">
        <ui-card-header
          [title]="t('mobileConfig.title')"
          [description]="t('mobileConfig.subtitle')"
        />

        @if (!canManageMobile()) {
          <ui-alert class="mt-6 block" tone="info" [title]="t('configuration.readOnlyTitle')">
            {{ t("configuration.readOnlyMobile") }}
          </ui-alert>
        }

        <div class="mt-6">
          @switch (mobile().status) {
            @case ("error") {
              <ui-error-state
                [title]="t('mobileConfig.loadFailed')"
                [message]="mobile().error ?? ''"
                (retry)="loadMobile()"
              />
            }

            @case ("loading") {
              <div
                class="space-y-4"
                aria-busy="true"
                [attr.aria-label]="t('mobileConfig.loadingLabel')"
              >
                @for (row of [1, 2, 3]; track row) {
                  <ui-skeleton shape="h-16 w-full rounded-xl" />
                }
              </div>
            }

            @default {
              <!--
                Rendered even when the data is null — that is a tenant with no
                configuration yet, not a missing screen. The form seeds itself
                blank and its save creates the record.
              -->
              <app-mobile-config-form
                [config]="mobile().data ?? null"
                [readOnly]="!canManageMobile()"
                (changed)="onMobileChanged($event)"
              />
            }
          }
        </div>
      </ui-card>
    }
  `
})
export class ConfigurationPage {
  private readonly configuration = inject(ConfigurationService);
  private readonly session = inject(SessionStore);

  protected readonly t = injectT();

  // A plain string, because `ui-tabs` binds `model.required<string>()`. The
  // template compares against the two literals it renders.
  protected readonly tab = signal("connections");

  /**
   * Whether this session may change each half.
   *
   * Computed from the session's permissions, which are a signal — so a
   * re-issued token with a different set re-renders the screen rather than
   * leaving a stale set of buttons behind.
   */
  protected readonly canManageConnections = computed(() =>
    this.session.hasPermission("connection.write")
  );
  protected readonly canManageMobile = computed(() =>
    this.session.hasPermission("tenant.write")
  );

  protected readonly connections = signal<Async<Connection[]>>(asyncLoading());
  protected readonly mobile = signal<Async<MobileConfig | null>>(asyncLoading());
  protected readonly modules = signal<Async<TenantModule[]>>(asyncLoading());

  protected readonly tabs = (): Tab[] => [
    { id: "connections", label: this.t("configuration.tabConnections") },
    { id: "mobile", label: this.t("configuration.tabMobile") },
    { id: "modules", label: this.t("configuration.tabModules") }
  ];

  constructor() {
    // Both up front rather than on tab activation. There are two small requests
    // and switching tabs is the common case — paying for them at load means the
    // second tab is instant, and a spinner on a tab click reads as a page load.
    this.loadConnections();
    this.loadMobile();
    this.loadModules();
  }

  protected loadModules(): void {
    this.modules.set(asyncLoading(this.modules().data));

    this.configuration.listOwnModules().subscribe({
      next: (data) => this.modules.set({ status: "success", data, error: null }),
      error: (error: unknown) =>
        this.modules.set(asyncError(describeError(error, this.t, "modules.loadError")))
    });
  }

  protected loadConnections(): void {
    this.connections.set(asyncLoading(this.connections().data));

    this.configuration.listConnections().subscribe({
      next: (data) => this.connections.set({ status: "success", data, error: null }),
      error: (error: unknown) =>
        this.connections.set(asyncError(describeError(error, this.t, "connections.loadError")))
    });
  }

  protected loadMobile(): void {
    this.mobile.set(asyncLoading(this.mobile().data));

    this.configuration.getMobileConfig().subscribe({
      next: (data) => this.mobile.set({ status: "success", data, error: null }),
      error: (error: unknown) =>
        this.mobile.set(asyncError(describeError(error, this.t, "mobileConfig.loadError")))
    });
  }

  /**
   * Replaces one card's connection in place.
   *
   * Rather than refetching the list: the card already holds what the server
   * returned, and reloading would flash every other card on the screen for a
   * change that touched one of them.
   */
  protected onConnectionChanged(updated: Connection): void {
    const current = this.connections().data ?? [];
    this.connections.set({
      status: "success",
      data: current.map((connection) =>
        connection.environmentId === updated.environmentId ? updated : connection
      ),
      error: null
    });
  }

  protected onMobileChanged(updated: MobileConfig): void {
    this.mobile.set({ status: "success", data: updated, error: null });
  }
}
