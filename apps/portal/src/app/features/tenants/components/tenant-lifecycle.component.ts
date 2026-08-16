import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal
} from "@angular/core";
import { describeError } from "@core/http/api-error";
import { injectT } from "@core/i18n/i18n.service";
import type { MessageKey } from "@core/i18n/messages/en";
import { ToastService } from "@core/notifications/toast.service";
import {
  TENANT_ACTIONS_BY_STATUS,
  TENANT_ACTIONS_NEEDING_PHRASE,
  TENANT_ACTION_RESULT,
  type TenantAction,
  type TenantSummary
} from "@core/models";
import {
  AlertComponent,
  ButtonComponent,
  ConfirmDialogComponent,
  IconComponent,
  type IconName
} from "@shared/ui";
import { TenantsService } from "../tenants.service";

/**
 * Suspend, reactivate, archive and restore.
 *
 * The screen the route manifest was waiting for: `tenant.soft_deleted` and
 * `tenant.restored` sit in `NON_ROUTE_AUDIT_ACTIONS` with a note that this is
 * what would claim them.
 *
 * Which buttons appear comes from `TENANT_ACTIONS_BY_STATUS`, not from
 * conditionals here. A table makes the illegal combinations unrepresentable —
 * you cannot reactivate an archived tenant without restoring it first — where
 * a chain of `@if`s would make them merely unlikely.
 *
 * Archiving asks for the slug to be typed. It is the only action that hides the
 * tenant from every other screen, and the only one people do to the wrong row.
 */
@Component({
  selector: "app-tenant-lifecycle",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AlertComponent,
    ButtonComponent,
    ConfirmDialogComponent,
    IconComponent
  ],
  host: { class: "block" },
  template: `
    <div class="space-y-4">
      @if (failure()) {
        <ui-alert tone="danger">{{ failure() }}</ui-alert>
      }

      <div class="flex flex-wrap gap-2">
        @for (action of available(); track action) {
          <button
            uiButton
            type="button"
            [variant]="action === 'archive' ? 'danger' : 'outline'"
            [disabled]="busy()"
            (click)="ask(action)"
          >
            <ui-icon [name]="ICONS[action]" [size]="16" />
            {{ t(LABELS[action]) }}
          </button>
        }
      </div>
    </div>

    @if (pending(); as action) {
      <ui-confirm-dialog
        [title]="t(TITLES[action])"
        [description]="t(BODIES[action], { name: tenant().name })"
        [warning]="action === 'archive' ? t('lifecycle.archiveWarning') : undefined"
        [confirmLabel]="t(LABELS[action])"
        [tone]="action === 'archive' ? 'danger' : 'primary'"
        [confirmPhrase]="needsPhrase(action) ? tenant().slug : undefined"
        [busy]="busy()"
        (confirmed)="apply(action)"
        (cancelled)="pending.set(null)"
      >
        @if (AUDIT_ACTIONS[action]; as auditAction) {
          <p class="text-xs text-foreground-subtle">
            {{ t("lifecycle.auditNote", { action: auditAction }) }}
          </p>
        }
      </ui-confirm-dialog>
    }
  `
})
export class TenantLifecycleComponent {
  readonly tenant = input.required<TenantSummary>();
  /** Emits the updated tenant so the page can refresh without a round trip. */
  readonly changed = output<TenantSummary>();

  private readonly tenants = inject(TenantsService);
  private readonly toasts = inject(ToastService);

  protected readonly t = injectT();
  protected readonly busy = signal(false);
  protected readonly failure = signal<string | null>(null);
  protected readonly pending = signal<TenantAction | null>(null);

  protected readonly available = computed(
    () => TENANT_ACTIONS_BY_STATUS[this.tenant().status]
  );

  protected readonly LABELS: Record<TenantAction, MessageKey> = {
    suspend: "lifecycle.suspend",
    reactivate: "lifecycle.reactivate",
    archive: "lifecycle.archive",
    restore: "lifecycle.restore"
  };

  protected readonly TITLES: Record<TenantAction, MessageKey> = {
    suspend: "lifecycle.suspendTitle",
    reactivate: "lifecycle.reactivateTitle",
    archive: "lifecycle.archiveTitle",
    restore: "lifecycle.restoreTitle"
  };

  protected readonly BODIES: Record<TenantAction, MessageKey> = {
    suspend: "lifecycle.suspendBody",
    reactivate: "lifecycle.reactivateBody",
    archive: "lifecycle.archiveBody",
    restore: "lifecycle.restoreBody"
  };

  protected readonly ICONS: Record<TenantAction, IconName> = {
    suspend: "lock",
    reactivate: "check-circle",
    archive: "trash",
    restore: "refresh"
  };

  /**
   * The audit action each transition writes, shown in the confirmation.
   *
   * All four now, and each name is one `PATCH /tenants/:id/status` genuinely
   * records — the route declares exactly these in the manifest, and the US-015
   * guard holds that declaration to a real `recordAuditEntry` call in the
   * source. Showing a name nothing writes would send an operator searching the
   * log for an entry that will never be there.
   */
  protected readonly AUDIT_ACTIONS: Record<TenantAction, string | null> = {
    suspend: "tenant.suspended",
    reactivate: "tenant.reactivated",
    archive: "tenant.soft_deleted",
    restore: "tenant.restored"
  };

  private readonly TOASTS: Record<TenantAction, MessageKey> = {
    suspend: "lifecycle.suspended",
    reactivate: "lifecycle.reactivated",
    archive: "lifecycle.archived",
    restore: "lifecycle.restored"
  };

  protected needsPhrase(action: TenantAction): boolean {
    return TENANT_ACTIONS_NEEDING_PHRASE.includes(action);
  }

  protected ask(action: TenantAction): void {
    this.failure.set(null);
    this.pending.set(action);
  }

  protected apply(action: TenantAction): void {
    this.busy.set(true);

    this.tenants
      .setStatus(this.tenant().id, TENANT_ACTION_RESULT[action])
      .subscribe({
        next: (updated) => {
          this.busy.set(false);
          this.pending.set(null);
          this.changed.emit(updated);
          this.toasts.success(
            this.t(this.TOASTS[action], { name: updated.name })
          );
        },
        error: (error: unknown) => {
          this.busy.set(false);
          this.pending.set(null);
          this.failure.set(describeError(error, this.t, "lifecycle.failed"));
        }
      });
  }
}
