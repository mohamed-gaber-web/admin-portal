import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from "@angular/core";
import { RouterLink } from "@angular/router";
import type { ReissuedInvitation } from "@growpath/contracts";
import { SessionStore } from "@core/auth/session.store";
import { ToastService } from "@core/notifications/toast.service";
import { describeError } from "@core/http/api-error";
import { I18nService, injectT } from "@core/i18n/i18n.service";
import {
  TENANT_PLAN_LABEL_KEYS,
  TENANT_STATUS_LABEL_KEYS
} from "@core/i18n/label-keys";
import {
  asyncError,
  asyncLoading,
  type ActivityEntry,
  type Async,
  type TenantDetail,
  type TenantStatus
} from "@core/models";
import {
  AlertComponent,
  BadgeComponent,
  ButtonComponent,
  CardComponent,
  CardHeaderComponent,
  EmptyStateComponent,
  ConfirmDialogComponent,
  ErrorStateComponent,
  FieldComponent,
  IconComponent,
  InputDirective,
  ModalComponent,
  SkeletonComponent,
  type BadgeTone
} from "@shared/ui";
import { ActivityListComponent } from "@shared/components/activity-list.component";
import { TenantEnvironmentsComponent } from "../tenants/components/tenant-environments.component";
import { TenantModulesComponent } from "./components/tenant-modules.component";
import { TenantSubscriptionComponent } from "./components/tenant-subscription.component";
import { PlatformService } from "./platform.service";

/**
 * One tenant, seen by whoever operates the installation.
 *
 * The cross-tenant twin of `/tenants/:id`, and a separate page rather than that
 * one with extra cards. The difference is the same difference the two list
 * screens draw: `/tenants/:id` is an administrator looking at their own
 * organisation, and this is an operator looking at a customer. Only one of them
 * gets to change what that customer has paid for, and a single page whose
 * controls appeared or vanished by permission is a page where forgetting the
 * check hands a tenant administrator their own billing.
 *
 * What is here and not on the tenant-facing page:
 *
 *   - **Subscription** — the plan, and cancelling it.
 *   - **Modules** — which functional areas the customer is entitled to.
 *
 * What is deliberately *not* here: the lifecycle controls. Suspending and
 * archiving live on the list screen, where the row being acted on is next to the
 * rows it is not — and where the archive confirmation already asks for the slug.
 */
@Component({
  selector: "app-platform-tenant-detail-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    ActivityListComponent,
    BadgeComponent,
    ButtonComponent,
    CardComponent,
    CardHeaderComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    IconComponent,
    SkeletonComponent,
    TenantEnvironmentsComponent,
    TenantModulesComponent,
    TenantSubscriptionComponent,
    FieldComponent,
    InputDirective,
    ModalComponent,
    ConfirmDialogComponent,
    AlertComponent
  ],
  template: `
    <a
      routerLink="/platform/tenants"
      class="mb-5 inline-flex items-center gap-1.5 text-sm text-foreground-muted transition-colors duration-200 hover:text-foreground"
    >
      <ui-icon name="chevron-left" [size]="15" />
      {{ t("platformTenantDetail.back") }}
    </a>

    @switch (state().status) {
      @case ("error") {
        <ui-card>
          <ui-error-state
            [title]="t('tenantDetail.loadFailed')"
            [message]="state().error ?? ''"
            (retry)="load()"
          />
        </ui-card>
      }

      @case ("loading") {
        <div
          class="space-y-6"
          aria-busy="true"
          [attr.aria-label]="t('tenantDetail.loadingLabel')"
        >
          <div class="space-y-3 rounded-2xl border border-border bg-surface p-6">
            <ui-skeleton shape="h-7 w-56" />
            <ui-skeleton shape="h-4 w-32" />
          </div>
          <div class="grid gap-6 xl:grid-cols-3">
            <div class="space-y-3 rounded-2xl border border-border bg-surface p-6 xl:col-span-2">
              <ui-skeleton shape="h-5 w-40" />
              @for (row of [1, 2, 3]; track row) {
                <ui-skeleton shape="h-16 w-full" />
              }
            </div>
            <div class="space-y-3 rounded-2xl border border-border bg-surface p-6">
              <ui-skeleton shape="h-5 w-28" />
              <ui-skeleton shape="h-10 w-full" />
            </div>
          </div>
        </div>
      }

      @default {
        @if (state().data; as tenant) {
          <div class="space-y-6 animate-fade-in">
            <!-- Identity -->
            <div class="flex flex-wrap items-start justify-between gap-4">
              <div class="min-w-0 space-y-2">
                <div class="flex flex-wrap items-center gap-3">
                  <h1 class="text-2xl font-semibold tracking-tight text-foreground">
                    {{ tenant.name }}
                  </h1>
                  <ui-badge [tone]="STATUS_TONES[tenant.status]" [dot]="true">
                    {{ t(STATUS_LABELS[tenant.status]) }}
                  </ui-badge>
                  <ui-badge tone="info">{{ t(PLAN_LABELS[tenant.plan]) }}</ui-badge>
                </div>
                <p dir="ltr" class="font-mono text-sm text-foreground-subtle">
                  {{ tenant.slug }}
                </p>
              </div>

              <div class="flex flex-wrap items-center gap-2">
                <!--
                  Renaming is offered here, next to the name, rather than in the
                  subscription card: it is an attribute of the tenant's identity
                  and not a commercial decision. Only for operators who may write
                  — a button that always 403s is worse than no button.
                -->
                @if (canEdit()) {
                  <button uiButton variant="outline" size="md" type="button" (click)="startRename(tenant)">
                    <ui-icon name="edit" [size]="16" />
                    {{ t("tenantDetail.rename") }}
                  </button>

                  <!--
                    Offered by current state rather than all three at once: a
                    button that suspends an already-suspended tenant invites a
                    click that does nothing and reads as a failure.

                    "Pending" is not offered at all, and cannot be — it is
                    derived from whether the first admin has accepted their
                    invitation, so there is no transition an operator could make
                    to reach it.
                  -->
                  @if (tenant.status !== "suspended" && tenant.status !== "archived") {
                    <button uiButton variant="outline" size="md" type="button" (click)="ask(tenant, 'suspended')">
                      <ui-icon name="lock" [size]="16" />
                      {{ t("lifecycle.suspend") }}
                    </button>
                  }
                  @if (tenant.status === "suspended" || tenant.status === "archived") {
                    <button uiButton variant="outline" size="md" type="button" (click)="ask(tenant, 'active')">
                      <ui-icon name="refresh" [size]="16" />
                      {{ t("lifecycle.reactivate") }}
                    </button>
                  }
                  @if (tenant.status !== "archived") {
                    <button uiButton variant="outline" size="md" type="button" (click)="ask(tenant, 'archived')">
                      <ui-icon name="trash" [size]="16" />
                      {{ t("lifecycle.archive") }}
                    </button>
                  }
                }
                <a uiButton routerLink="/platform/users" variant="outline" size="md">
                  <ui-icon name="users" [size]="16" />
                  {{ t("tenantDetail.viewUsers") }}
                </a>
              </div>
            </div>

            <!--
              Why this tenant reads as pending.

              "Pending" is derived, not stored: it means no user in the tenant
              has an active status yet, which in practice means the first admin
              has not accepted their invitation. There is no operator action
              that clears it — reactivating only lifts a suspension, and this
              tenant is not suspended — so a screen that shows the badge without
              this sentence leaves somebody clicking buttons that cannot help.
            -->
            @if (tenant.status === "pending") {
              <ui-alert tone="info" [title]="t('tenantDetail.pendingTitle')">
                <div class="space-y-3">
                  <p>{{ t("tenantDetail.pendingBody", { email: tenant.adminEmail }) }}</p>

                  @if (reissued(); as issued) {
                    <!--
                      The token exists here and nowhere else — it is stored only
                      as a digest — so it is shown as a field to copy rather than
                      as a toast that scrolls away.
                    -->
                    <div class="space-y-1.5">
                      <p class="text-sm font-medium">
                        {{ t("tenantDetail.inviteFor", { email: issued.email }) }}
                      </p>
                      <div class="flex gap-2">
                        <input
                          uiInput
                          readonly
                          class="font-mono !text-xs"
                          [value]="inviteUrl(issued)"
                          [attr.aria-label]="t('createTenant.invitationLink')"
                        />
                        <button
                          uiButton
                          variant="outline"
                          size="icon"
                          type="button"
                          [attr.aria-label]="t('createTenant.copyLink')"
                          (click)="copyInvite(inviteUrl(issued))"
                        >
                          <ui-icon [name]="inviteCopied() ? 'check' : 'copy'" [size]="16" />
                        </button>
                      </div>
                      <p class="text-xs text-foreground-subtle">
                        {{ t("tenantDetail.inviteExpires", { date: i18n.formatDate(issued.invitation.expiresAt) }) }}
                      </p>
                    </div>
                  } @else if (canEdit()) {
                    <button
                      uiButton
                      size="sm"
                      variant="outline"
                      type="button"
                      [loading]="reissuing()"
                      (click)="resendInvitation()"
                    >
                      <ui-icon name="mail" [size]="15" />
                      {{ t("tenantDetail.resendInvite") }}
                    </button>
                  }
                </div>
              </ui-alert>
            }

            <!-- Overview -->
            <ui-card>
              <ui-card-header [title]="t('tenantDetail.overview')" />
              <dl class="mt-6 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
                <div>
                  <dt class="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                    {{ t("tenants.columnPlan") }}
                  </dt>
                  <dd class="mt-1 text-sm text-foreground">
                    {{ t(PLAN_LABELS[tenant.plan]) }}
                  </dd>
                </div>
                <div>
                  <dt class="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                    {{ t("tenantDetail.userCount") }}
                  </dt>
                  <!--
                    Used against included. The bare count was the right thing to
                    show while a tenant had no allowance; now that it has one,
                    the count alone hides the reason an invitation gets refused.
                  -->
                  <dd
                    class="mt-1 text-sm tabular-nums text-foreground"
                    [class.text-danger]="tenant.userCount >= tenant.userLimit"
                  >
                    {{
                      t("tenants.seatsUsed", {
                        used: i18n.formatNumber(tenant.userCount),
                        limit: i18n.formatNumber(tenant.userLimit)
                      })
                    }}
                  </dd>
                </div>
                <div>
                  <dt class="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                    {{ t("tenantDetail.created") }}
                  </dt>
                  <dd class="mt-1 text-sm text-foreground">
                    {{ i18n.formatDate(tenant.createdAt) }}
                  </dd>
                </div>
                <div class="min-w-0">
                  <dt class="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                    {{ t("tenantDetail.adminEmail") }}
                  </dt>
                  <dd dir="ltr" class="mt-1 truncate font-mono text-xs text-foreground-muted">
                    {{ tenant.adminEmail }}
                  </dd>
                </div>
              </dl>
            </ui-card>

            <div class="grid gap-6 xl:grid-cols-3">
              <div class="space-y-6 xl:col-span-2">
                <ui-card>
                  <ui-card-header
                    [title]="t('modules.title')"
                    [description]="t('modules.subtitle')"
                  />
                  <div class="mt-6">
                    <app-tenant-modules [tenantId]="tenant.id" />
                  </div>
                </ui-card>

                <ui-card>
                  <ui-card-header
                    [title]="t('tenantDetail.environments')"
                    [description]="t('tenantDetail.environmentsSubtitle')"
                  />
                  <div class="mt-6">
                    <app-tenant-environments [environments]="tenant.environments" />
                  </div>
                </ui-card>
              </div>

              <div class="space-y-6">
                <ui-card>
                  <ui-card-header
                    [title]="t('subscription.title')"
                    [description]="t('subscription.subtitle')"
                  />
                  <div class="mt-6">
                    <app-tenant-subscription
                      [tenant]="tenant"
                      (changed)="onTenantChanged($event)"
                    />
                  </div>
                </ui-card>

                <ui-card>
                  <ui-card-header
                    [title]="t('tenantDetail.activity')"
                    [description]="t('tenantDetail.activitySubtitle')"
                  />
                  <div class="mt-4">
                    @if (activity().length === 0) {
                      <ui-empty-state
                        icon="activity"
                        [title]="t('tenantDetail.activityEmpty')"
                      />
                    } @else {
                      <app-activity-list [entries]="activity()" />
                    }
                  </div>
                </ui-card>
              </div>
            </div>
          </div>
        } @else {
          <ui-card>
            <ui-empty-state
              icon="building"
              [title]="t('tenantDetail.notFoundTitle')"
              [description]="t('tenantDetail.notFoundBody')"
            >
              <a uiButton routerLink="/platform/tenants" variant="outline" size="sm">
                {{ t("platformTenantDetail.back") }}
              </a>
            </ui-empty-state>
          </ui-card>
        }
      }
    }
    @if (pending(); as request) {
      <!--
        Type-to-confirm on the slug for archiving only, matching the list
        screen: this is somebody acting on a tenant that is not their own and
        whose users are not in the room.
      -->
      <ui-confirm-dialog
        [title]="t(CONFIRM_TITLE[request.status])"
        [description]="t(CONFIRM_BODY[request.status], { name: request.tenant.name })"
        [confirmLabel]="t(CONFIRM_LABEL[request.status])"
        [warning]="request.status === 'archived' ? t('lifecycle.archiveWarning') : undefined"
        [tone]="request.status === 'archived' ? 'danger' : 'primary'"
        [confirmPhrase]="request.status === 'archived' ? request.tenant.slug : undefined"
        [busy]="busy()"
        (confirmed)="apply(request)"
        (cancelled)="pending.set(null)"
      />
    }

    @if (renaming(); as draft) {
      <ui-modal
        [title]="t('tenantDetail.renameTitle')"
        [description]="t('tenantDetail.renameSubtitle')"
        (closed)="cancelRename()"
      >
        <form id="rename-tenant" class="space-y-4" (ngSubmit)="saveRename()">
          <ui-field [label]="t('createTenant.name')" controlId="rename-name" [required]="true">
            <input
              uiInput
              id="rename-name"
              [value]="draft.name"
              [disabled]="renameSaving()"
              (input)="onRenameInput($event)"
            />
          </ui-field>
          <!--
            The slug is shown but not editable, because the obvious next question
            on a rename screen is "can I change this too". Saying no here is
            cheaper than an operator discovering it is absent and filing it as a
            bug.
          -->
          <ui-field [label]="t('createTenant.slug')" controlId="rename-slug" [hint]="t('tenantDetail.slugFixed')">
            <input uiInput id="rename-slug" dir="ltr" readonly [value]="draft.slug" />
          </ui-field>
        </form>

        <div modalFooter>
          <button uiButton variant="ghost" type="button" (click)="cancelRename()">
            {{ t("common.cancel") }}
          </button>
          <button
            uiButton
            type="submit"
            form="rename-tenant"
            [loading]="renameSaving()"
            [disabled]="!renameChanged()"
          >
            {{ t("tenantDetail.renameSave") }}
          </button>
        </div>
      </ui-modal>
    }
  `
})
export class PlatformTenantDetailPage {
  /** Bound from the `:id` route param by `withComponentInputBinding()`. */
  readonly id = input.required<string>();

  private readonly platform = inject(PlatformService);

  protected readonly t = injectT();
  protected readonly i18n = inject(I18nService);
  protected readonly STATUS_LABELS = TENANT_STATUS_LABEL_KEYS;
  protected readonly PLAN_LABELS = TENANT_PLAN_LABEL_KEYS;

  protected readonly state = signal<Async<TenantDetail | null>>(asyncLoading());
  protected readonly activity = signal<readonly ActivityEntry[]>([]);

  protected readonly STATUS_TONES: Record<TenantStatus, BadgeTone> = {
    active: "success",
    pending: "warning",
    suspended: "danger",
    archived: "neutral"
  };

  private readonly session = inject(SessionStore);
  private readonly toasts = inject(ToastService);

  /**
   * Whether to offer the rename control.
   *
   * `platform.tenant.write` — the same key as the lifecycle transitions, since
   * renaming is the same kind of operational act. A rendering decision only;
   * the endpoint checks the same claim.
   */
  protected readonly canEdit = () => this.session.hasPermission("platform.tenant.write");

  // ── The pending remedy: a fresh admin invitation ──────────────────

  protected readonly reissuing = signal(false);
  protected readonly reissued = signal<ReissuedInvitation | null>(null);
  protected readonly inviteCopied = signal(false);

  protected inviteUrl(issued: ReissuedInvitation): string {
    return `${location.origin}/accept-invitation?token=${issued.invitation.token}`;
  }

  protected resendInvitation(): void {
    this.reissuing.set(true);
    this.platform.reissueAdminInvitation(this.id()).subscribe({
      next: (issued) => {
        this.reissuing.set(false);
        this.reissued.set(issued);
      },
      error: (error: unknown) => {
        this.reissuing.set(false);
        this.toasts.error(describeError(error, this.t, "tenantDetail.resendFailed"));
      }
    });
  }

  protected copyInvite(value: string): void {
    navigator.clipboard.writeText(value).then(
      () => {
        this.inviteCopied.set(true);
        setTimeout(() => this.inviteCopied.set(false), 2000);
      },
      // Clipboard access is refused on an insecure origin. The field is
      // selectable, so say so rather than failing mute.
      () => this.toasts.error(this.t("createTenant.copyFailed"), this.t("createTenant.copyFailedBody"))
    );
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  protected readonly pending = signal<{
    tenant: TenantDetail;
    status: "active" | "suspended" | "archived";
  } | null>(null);
  protected readonly busy = signal(false);

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

  protected ask(
    tenant: TenantDetail,
    status: "active" | "suspended" | "archived"
  ): void {
    this.pending.set({ tenant, status });
  }

  protected apply(request: {
    tenant: TenantDetail;
    status: "active" | "suspended" | "archived";
  }): void {
    this.busy.set(true);
    this.platform.setTenantStatus(request.tenant.id, request.status).subscribe({
      next: () => {
        this.busy.set(false);
        this.pending.set(null);
        this.toasts.success(this.t(this.TOAST[request.status], { name: request.tenant.name }));
        // Reloaded rather than patched: the status the API derives depends on
        // rows this screen does not hold, so a locally computed one could
        // disagree with the next refresh.
        this.load();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.toasts.error(
          this.t("lifecycle.failed"),
          describeError(error, this.t, "tenantDetail.loadError")
        );
      }
    });
  }

  /** The open rename dialog's draft, or null when it is closed. */
  protected readonly renaming = signal<{ name: string; slug: string } | null>(null);
  protected readonly renameSaving = signal(false);

  protected startRename(tenant: TenantDetail): void {
    this.renaming.set({ name: tenant.name, slug: tenant.slug });
  }

  protected cancelRename(): void {
    this.renaming.set(null);
  }

  protected onRenameInput(event: Event): void {
    const name = (event.target as HTMLInputElement).value;
    this.renaming.update((draft) => (draft ? { ...draft, name } : draft));
  }

  /** Blocks a save that is a no-op or an empty name, before the server has to. */
  protected renameChanged(): boolean {
    const draft = this.renaming();
    const current = this.state().data;
    if (!draft || !current) return false;
    const trimmed = draft.name.trim();
    return trimmed !== "" && trimmed !== current.name;
  }

  protected saveRename(): void {
    const draft = this.renaming();
    if (!draft || !this.renameChanged()) return;

    this.renameSaving.set(true);
    this.platform.updateTenant(this.id(), draft.name.trim()).subscribe({
      next: (tenant) => {
        this.renameSaving.set(false);
        this.renaming.set(null);
        this.state.set({ status: "success", data: tenant, error: null });
        this.toasts.success(this.t("tenantDetail.renamed", { name: tenant.name }));
      },
      error: (error: unknown) => {
        this.renameSaving.set(false);
        // The dialog stays open with the typed name, so a retry does not start
        // from the old one.
        this.toasts.error(describeError(error, this.t, "tenantDetail.renameFailed"));
      }
    });
  }

  constructor() {
    effect(
      () => {
        this.id();
        /*
         * `load()` is untracked, and must stay that way.
         *
         * Its first statement is `state.set(asyncLoading(state().data))` — it
         * *reads* the signal it then *writes*. Called directly here, that read
         * becomes a dependency of this effect, and the write re-triggers the
         * effect that performed it: an unbounded loop that pins a core and
         * takes the tab down with it. `allowSignalWrites` permits the write; it
         * does not break the cycle.
         *
         * The dependency this effect is meant to have is the id above, and only
         * that: reload when the route parameter changes.
         */
        untracked(() => this.load());
      },
      { allowSignalWrites: true }
    );
  }

  protected load(): void {
    this.state.set(asyncLoading(this.state().data));

    this.platform.getTenant(this.id()).subscribe({
      next: (data) => this.state.set({ status: "success", data, error: null }),
      error: (error: unknown) =>
        this.state.set(asyncError(describeError(error, this.t, "tenantDetail.loadError")))
    });

    // Supplementary, so it is not awaited with the tenant: a slow audit feed
    // should not hold up the controls the page exists for.
    this.platform.tenantActivity(this.id()).subscribe({
      next: (entries) => this.activity.set(entries),
      error: () => this.activity.set([])
    });
  }

  /**
   * Adopts the tenant the server returned, rather than refetching.
   *
   * The plan endpoint returns the whole tenant precisely so this is possible —
   * a second round trip would only put a loading flash on a screen somebody is
   * looking at, and a locally patched copy is how a screen starts disagreeing
   * with the database.
   */
  protected onTenantChanged(updated: TenantDetail): void {
    this.state.set({ status: "success", data: updated, error: null });
  }
}
