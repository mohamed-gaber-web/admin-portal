import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal
} from "@angular/core";
import { describeError } from "@core/http/api-error";
import { I18nService, injectT } from "@core/i18n/i18n.service";
import { MODULE_DESCRIPTION_KEYS, MODULE_LABEL_KEYS } from "@core/i18n/label-keys";
import { ToastService } from "@core/notifications/toast.service";
import {
  asyncError,
  asyncLoading,
  type Async
} from "@core/models";
import { MODULE_KEYS, type ModuleKey, type TenantModule } from "@growpath/contracts";
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
 * Submits the whole set rather than one toggle at a time. A screen of switches
 * has a state, and turning that state into a sequence of grant and revoke calls
 * makes "half of what I clicked was applied" the normal result of a dropped
 * connection.
 */
@Component({
  selector: "app-tenant-modules",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, ErrorStateComponent, IconComponent, SkeletonComponent],
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
          @for (row of [1, 2, 3, 4]; track row) {
            <ui-skeleton shape="h-16 w-full rounded-xl" />
          }
        </div>
      }

      @default {
        <div class="space-y-4">
          <ul class="space-y-2">
            @for (module of state().data ?? []; track module.key) {
              <li>
                <label
                  class="flex cursor-pointer items-start gap-3 rounded-xl border border-border px-4 py-3 transition-colors duration-200 hover:bg-surface-muted"
                >
                  <input
                    type="checkbox"
                    class="mt-0.5 h-4 w-4 accent-primary"
                    [checked]="isSelected(module.key)"
                    [disabled]="saving()"
                    (change)="toggle(module.key)"
                  />
                  <span class="min-w-0 flex-1">
                    <span class="block text-sm font-medium text-foreground">
                      {{ label(module) }}
                    </span>
                    <span class="mt-0.5 block text-xs leading-relaxed text-foreground-muted">
                      {{ description(module) }}
                    </span>
                    <!--
                      The grant date, not a "held" badge. "Since 4 March"
                      answers a question a support call actually asks; a tick
                      that the checkbox already shows answers none.
                    -->
                    @if (module.enabledAt; as at) {
                      <span class="mt-1 flex items-center gap-1 text-xs text-foreground-subtle">
                        <ui-icon name="check" [size]="12" />
                        {{ t("modules.enabledSince", { date: i18n.formatDate(at) }) }}
                      </span>
                    }
                  </span>
                </label>
              </li>
            }
          </ul>

          <div class="flex items-center gap-2">
            <button
              uiButton
              size="sm"
              type="button"
              [disabled]="!hasChange()"
              [loading]="saving()"
              (click)="save()"
            >
              {{ t("modules.save") }}
            </button>
            @if (hasChange()) {
              <button uiButton variant="ghost" size="sm" type="button" (click)="reset()">
                {{ t("common.cancel") }}
              </button>
            }
          </div>
        </div>
      }
    }
  `
})
export class TenantModulesComponent {
  readonly tenantId = input.required<string>();

  private readonly platform = inject(PlatformService);
  private readonly toasts = inject(ToastService);

  protected readonly t = injectT();
  protected readonly i18n = inject(I18nService);

  protected readonly state = signal<Async<TenantModule[]>>(asyncLoading());
  protected readonly saving = signal(false);

  /** What the switches currently show. Diverges from the server until saved. */
  protected readonly selected = signal<readonly string[]>([]);

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
        this.load();
      },
      { allowSignalWrites: true }
    );
  }

  protected load(): void {
    this.state.set(asyncLoading(this.state().data));

    this.platform.listTenantModules(this.tenantId()).subscribe({
      next: (modules) => {
        this.state.set({ status: "success", data: modules, error: null });
        this.selected.set(modules.filter((module) => module.enabled).map((m) => m.key));
      },
      error: (error: unknown) =>
        this.state.set(asyncError(describeError(error, this.t, "modules.loadError")))
    });
  }

  protected isSelected(key: string): boolean {
    return this.selected().includes(key);
  }

  protected toggle(key: string): void {
    const current = this.selected();
    this.selected.set(
      current.includes(key) ? current.filter((held) => held !== key) : [...current, key]
    );
  }

  protected reset(): void {
    this.selected.set(this.stored());
  }

  protected save(): void {
    if (!this.hasChange()) return;

    // Narrowed to keys this build knows. The API ignores unknown ones anyway,
    // but sending a key that is not in the contract would mean the request no
    // longer matches the schema the response is parsed against.
    const modules = this.selected().filter((key): key is ModuleKey =>
      (MODULE_KEYS as readonly string[]).includes(key)
    );

    this.saving.set(true);
    this.platform.setTenantModules(this.tenantId(), modules).subscribe({
      next: (updated) => {
        this.saving.set(false);
        this.state.set({ status: "success", data: updated, error: null });
        this.selected.set(updated.filter((module) => module.enabled).map((m) => m.key));
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

  /**
   * The module's name, translated.
   *
   * Falls back to the API's English description for a key this build has never
   * heard of — which happens when the database's catalogue is ahead of the
   * deployed portal. Showing the raw description is worse than a translation and
   * much better than a blank row.
   */
  protected label(module: TenantModule): string {
    const key = MODULE_LABEL_KEYS[module.key as ModuleKey];
    return key ? this.t(key) : module.key;
  }

  protected description(module: TenantModule): string {
    const key = MODULE_DESCRIPTION_KEYS[module.key as ModuleKey];
    return key ? this.t(key) : module.description;
  }
}
