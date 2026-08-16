import { ChangeDetectionStrategy, Component, inject, input } from "@angular/core";
import { I18nService, injectT } from "@core/i18n/i18n.service";
import { MODULE_DESCRIPTION_KEYS, MODULE_LABEL_KEYS } from "@core/i18n/label-keys";
import type { ModuleKey, TenantModule } from "@growpath/contracts";
import { BadgeComponent, IconComponent } from "@shared/ui";

/**
 * What this tenant is entitled to, read-only (US-072).
 *
 * The tenant-facing twin of the operator's toggles. Deliberately not a disabled
 * version of that screen: a greyed-out switch invites somebody to go looking for
 * the permission that would enable it, and there is none — this is not a setting
 * they lack access to, it is a description of what their organisation bought.
 * So it reads as a list of facts, and the modules they do not hold are shown
 * rather than hidden, because "we could have this" is the useful half for
 * whoever is deciding what to ask their account manager for.
 */
@Component({
  selector: "app-own-modules",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BadgeComponent, IconComponent],
  host: { class: "block" },
  template: `
    <ul class="space-y-2">
      @for (module of modules(); track module.key) {
        <li
          class="flex items-start gap-3 rounded-xl border border-border px-4 py-3"
          [class.opacity-60]="!module.enabled"
        >
          <span
            class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
            [class.bg-success-subtle]="module.enabled"
            [class.text-success]="module.enabled"
            [class.bg-surface-muted]="!module.enabled"
            [class.text-foreground-subtle]="!module.enabled"
          >
            <ui-icon [name]="module.enabled ? 'check' : 'close'" [size]="14" />
          </span>

          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <p class="text-sm font-medium text-foreground">{{ label(module) }}</p>
              <ui-badge [tone]="module.enabled ? 'success' : 'neutral'">
                {{ module.enabled ? t("ownModules.included") : t("ownModules.notIncluded") }}
              </ui-badge>
            </div>
            <p class="mt-0.5 text-xs leading-relaxed text-foreground-muted">
              {{ description(module) }}
            </p>
            @if (module.enabledAt; as at) {
              <p class="mt-1 text-xs text-foreground-subtle">
                {{ t("modules.enabledSince", { date: i18n.formatDate(at) }) }}
              </p>
            }
          </div>
        </li>
      }
    </ul>
  `
})
export class OwnModulesComponent {
  readonly modules = input.required<readonly TenantModule[]>();

  protected readonly t = injectT();
  protected readonly i18n = inject(I18nService);

  /** Translated, falling back to the API's English for an unknown key. */
  protected label(module: TenantModule): string {
    const key = MODULE_LABEL_KEYS[module.key as ModuleKey];
    return key ? this.t(key) : module.key;
  }

  protected description(module: TenantModule): string {
    const key = MODULE_DESCRIPTION_KEYS[module.key as ModuleKey];
    return key ? this.t(key) : module.description;
  }
}
