import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked
} from "@angular/core";
import { describeError } from "@core/http/api-error";
import { injectT } from "@core/i18n/i18n.service";
import { ToastService } from "@core/notifications/toast.service";
import { asyncError, asyncLoading, type Async } from "@core/models";
import { MODULE_DESCRIPTION_KEYS, MODULE_LABEL_KEYS } from "@core/i18n/label-keys";
import { isModuleKey, type ModuleKey, type TenantModule } from "@growpath/contracts";
import { ModulePickerComponent } from "@shared/components/module-picker.component";
import {
  ButtonComponent,
  ErrorStateComponent,
  IconComponent,
  SkeletonComponent
} from "@shared/ui";
import { PlatformService } from "../platform.service";

/**
 * Which modules a tenant is entitled to (US-072).
 *
 * Distinct from permissions, and worth being clear about because the two are
 * easily confused: a permission answers "may this *user* do it", and a tenant's
 * own administrator grants those. A module answers "has this *customer* bought
 * this area at all", and only an operator grants those. A user holding every
 * permission in a tenant with no warehouse module still cannot use the
 * warehouse, which is correct — nobody sold it to them.
 *
 * The list itself is `ModulePickerComponent`, shared with the create-tenant
 * dialog so the two screens cannot disagree about ordering or labelling. What
 * lives here is everything the create form does *not* have: a fetch, a save, and
 * the dirty-tracking that decides whether the save button is live.
 *
 * Submits the whole set rather than one toggle at a time. A screen of switches
 * has a state, and turning that state into a sequence of grant and revoke calls
 * makes "half of what I clicked was applied" the normal result of a dropped
 * connection.
 */
@Component({
  selector: "app-tenant-modules",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ButtonComponent,
    ErrorStateComponent,
    IconComponent,
    ModulePickerComponent,
    SkeletonComponent
  ],
  template: `
    @switch (state().status) {
      @case ("error") {
        <ui-error-state
          [title]="t('modules.loadFailed')"
          [message]="state().error ?? ''"
          (retry)="load()"
        />
      }

      @case ("loading") {
        <div class="space-y-3" aria-busy="true" [attr.aria-label]="t('modules.loadingLabel')">
          <ui-skeleton shape="h-8 w-full rounded-lg" />
          <div class="grid gap-2 sm:grid-cols-2">
            @for (row of SKELETON_ROWS; track row) {
              <ui-skeleton shape="h-20 w-full rounded-xl" />
            }
          </div>
        </div>
      }

      @default {
        <div class="space-y-4">
          @if (editing()) {
            <app-module-picker
              [modules]="state().data ?? []"
              [(selected)]="selected"
              [disabled]="saving()"
            />

            <div class="flex items-center gap-2 border-t border-border pt-4">
              <button
                uiButton
                size="sm"
                type="button"
                [loading]="saving()"
                [disabled]="!hasChange()"
                (click)="save()"
              >
                {{ t("modules.save") }}
              </button>
              <button
                uiButton
                variant="ghost"
                size="sm"
                type="button"
                [disabled]="saving()"
                (click)="cancel()"
              >
                {{ t("common.cancel") }}
              </button>
              @if (hasChange()) {
                <span class="text-xs text-foreground-subtle">{{ t("modules.unsaved") }}</span>
              }
            </div>
          } @else {
            <!--
              The granted set, read-only.

              A profile is somewhere an operator most often comes to *look* —
              answering "what does this customer have" during a support call —
              and a screen full of live checkboxes turns every one of those
              visits into a chance to change an entitlement with a stray click.
              Editing is a thing you opt into.
            -->
            <div class="flex items-start justify-between gap-3">
              <p class="text-sm text-foreground-muted">
                {{ t("modules.grantedCount", { count: granted().length, total: (state().data ?? []).length }) }}
              </p>

              @if (canEdit()) {
                <button uiButton variant="outline" size="sm" type="button" (click)="edit()">
                  <ui-icon name="edit" [size]="14" />
                  {{ t("common.edit") }}
                </button>
              }
            </div>

            @if (granted().length === 0) {
              <p class="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-foreground-muted">
                {{ t("modules.noneGranted") }}
              </p>
            } @else {
              <ul class="flex flex-wrap gap-2">
                @for (module of granted(); track module.key) {
                  <li
                    class="flex items-center gap-1.5 rounded-lg border border-border bg-surface-muted px-2.5 py-1.5 text-xs font-medium text-foreground"
                    [attr.title]="describe(module)"
                  >
                    <ui-icon name="check-circle" [size]="12" class="text-success" />
                    {{ label(module) }}
                  </li>
                }
              </ul>
            }
          }
        </div>
      }
    }
  `
})
export class TenantModulesComponent {
  readonly tenantId = input.required<string>();

  /**
   * Whether the operator may change entitlements at all.
   *
   * Separate from "is the edit form open": a reader without
   * `platform.module.write` never sees the button, and the API refuses them
   * regardless. This only decides whether to offer the affordance.
   */
  readonly canEdit = input(false);

  private readonly platform = inject(PlatformService);
  private readonly toasts = inject(ToastService);

  protected readonly t = injectT();

  protected readonly state = signal<Async<TenantModule[]>>(asyncLoading());
  protected readonly saving = signal(false);

  /** What the picker currently shows. Diverges from the server until saved. */
  protected readonly selected = signal<readonly string[]>([]);

  /** Placeholder rows, sized to the catalogue so the layout does not jump. */
  protected readonly SKELETON_ROWS = [1, 2, 3, 4, 5, 6];

  /**
   * Whether the picker is open.
   *
   * The card reads as a summary by default and becomes editable on request. A
   * profile is mostly somewhere an operator comes to *look* — "what does this
   * customer have" during a support call — and a wall of live checkboxes turns
   * every one of those visits into a chance to revoke something with a stray
   * click. The endpoint is unchanged; only the affordance is.
   */
  protected readonly editing = signal(false);

  /** The modules the tenant actually holds, in catalogue order. */
  protected readonly granted = computed(() =>
    (this.state().data ?? []).filter((module) => module.enabled)
  );

  /**
   * What the server last told us this tenant holds.
   *
   * Kept separate from `selected` so "has anything changed" is a comparison
   * rather than a flag somebody has to remember to set on every interaction.
   */
  private readonly stored = computed(() =>
    (this.state().data ?? [])
      .filter((module) => module.enabled)
      .map((module) => module.key)
      .sort()
  );

  protected readonly hasChange = computed(
    () => [...this.selected()].sort().join(",") !== this.stored().join(",")
  );

  constructor() {
    effect(
      () => {
        this.tenantId();
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

    this.platform.listTenantModules(this.tenantId()).subscribe({
      next: (modules) => this.settle(modules),
      error: (error: unknown) =>
        this.state.set(asyncError(describeError(error, this.t, "modules.loadError")))
    });
  }

  protected edit(): void {
    // Re-seed from the server's answer rather than from whatever a previous,
    // cancelled edit left behind.
    this.selected.set(this.stored());
    this.editing.set(true);
  }

  /** Leaves the picker, discarding anything unsaved. */
  protected cancel(): void {
    this.selected.set(this.stored());
    this.editing.set(false);
  }

  /**
   * The module's name, translated.
   *
   * Falls back to the key for one this build has never heard of, which happens
   * when the database's catalogue is ahead of the deployed portal. A bare key
   * is worse than a translation and much better than a blank chip.
   */
  protected label(module: TenantModule): string {
    const key = MODULE_LABEL_KEYS[module.key as ModuleKey];
    return key ? this.t(key) : module.key;
  }

  /** The longer description, shown on hover — the chips carry names only. */
  protected describe(module: TenantModule): string {
    const key = MODULE_DESCRIPTION_KEYS[module.key as ModuleKey];
    return key ? this.t(key) : module.description;
  }

  protected save(): void {
    if (!this.hasChange()) return;

    // Narrowed to keys this build knows. The API tolerates unknown ones, but
    // sending a key outside the contract would mean the request no longer
    // matches the schema the response is parsed against.
    const modules = this.selected().filter((key): key is ModuleKey => isModuleKey(key));

    this.saving.set(true);
    this.platform.setTenantModules(this.tenantId(), modules).subscribe({
      next: (updated) => {
        this.saving.set(false);
        this.settle(updated);
        this.editing.set(false);
        this.toasts.success(this.t("modules.saved"));
      },
      error: (error: unknown) => {
        this.saving.set(false);
        // The switches stay where the user left them, so a retry does not mean
        // re-doing the clicks.
        this.toasts.error(describeError(error, this.t, "modules.failed"));
      }
    });
  }

  /** Adopts a server response as both the rendered list and the clean baseline. */
  private settle(modules: TenantModule[]): void {
    this.state.set({ status: "success", data: modules, error: null });
    this.selected.set(modules.filter((module) => module.enabled).map((module) => module.key));
  }
}
