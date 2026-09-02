import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output
} from "@angular/core";
import { injectT } from "@core/i18n/i18n.service";
import type { MessageKey } from "@core/i18n/messages/en";
import {
  PERMISSION_CATALOGUE,
  PERMISSION_GROUPS,
  type PermissionGroup,
  type PermissionKey,
  type Role
} from "@core/models";
import { AlertComponent, IconComponent } from "@shared/ui";

export interface PermissionToggle {
  roleId: string;
  permission: PermissionKey;
  granted: boolean;
}

/**
 * Roles down the side, permissions across the top.
 *
 * A matrix rather than a permission list per role, because the question people
 * actually bring here is comparative — "who can manage connections?" — and
 * answering it from three separate lists means holding three lists in your head.
 *
 * The catalogue is not editable and the notice says why: `permission` is global
 * and the application holds `SELECT` on it and nothing else. Only the ticks are
 * editable, and each one is `role_permission`.
 *
 * `readOnly` disables the ticks for a session without `user.write`. The matrix
 * still renders in full, because "who can do what here" is a fair question for
 * anybody in the tenant to ask — and because the alternative, hiding it, would
 * leave a viewer unable to find out why they cannot save the configuration
 * screen.
 */
@Component({
  selector: "app-permission-matrix",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AlertComponent, IconComponent],
  host: { class: "block space-y-4" },
  template: `
    <ui-alert tone="info">{{ t("roles.catalogueReadOnly") }}</ui-alert>

    <div class="overflow-x-auto">
      <table class="w-full min-w-[36rem] border-collapse text-sm">
        <thead>
          <tr>
            <th
              scope="col"
              class="border-b border-border px-3 py-2.5 text-start text-xs font-semibold uppercase tracking-wide text-foreground-muted"
            >
              {{ t("roles.matrixTitle") }}
            </th>
            @for (role of roles(); track role.id) {
              <th
                scope="col"
                class="border-b border-border px-3 py-2.5 text-center text-xs font-semibold text-foreground"
              >
                {{ t(role.descriptionKey) }}
              </th>
            }
          </tr>
        </thead>

        <tbody>
          @for (group of groups(); track group.name) {
            <tr>
              <th
                [attr.colspan]="roles().length + 1"
                scope="colgroup"
                class="bg-surface-muted/60 px-3 py-2 text-start text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground-subtle"
              >
                {{ t(GROUP_LABELS[group.name]) }}
              </th>
            </tr>

            @for (permission of group.permissions; track permission.key) {
              <tr class="border-b border-border last:border-b-0">
                <th scope="row" class="px-3 py-2.5 text-start font-normal">
                  <span class="block text-sm text-foreground">
                    {{ t(permission.descriptionKey) }}
                  </span>
                  <span dir="ltr" class="block font-mono text-xs text-foreground-subtle">
                    {{ permission.key }}
                  </span>
                </th>

                @for (role of roles(); track role.id) {
                  <td class="px-3 py-2.5 text-center">
                    <label class="inline-flex cursor-pointer items-center justify-center">
                      <input
                        type="checkbox"
                        class="peer sr-only"
                        [checked]="holds(role, permission.key)"
                        [disabled]="busy() || readOnly()"
                        [attr.aria-label]="
                          t(role.descriptionKey) + ' — ' + t(permission.descriptionKey)
                        "
                        (change)="onToggle(role, permission.key, $event)"
                      />
                      <span
                        class="flex h-6 w-6 items-center justify-center rounded-md border border-border bg-surface text-transparent transition-all duration-200 peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background peer-disabled:opacity-50"
                      >
                        <ui-icon name="check" [size]="14" [strokeWidth]="3" />
                      </span>
                    </label>
                  </td>
                }
              </tr>
            }
          }
        </tbody>
      </table>
    </div>

    <p class="text-xs text-foreground-subtle">{{ t("roles.impliedRead") }}</p>
  `
})
export class PermissionMatrixComponent {
  readonly roles = input.required<readonly Role[]>();
  readonly busy = input(false);
  /** True for a session without `user.write`; the ticks become read-only. */
  readonly readOnly = input(false);
  readonly toggled = output<PermissionToggle>();

  protected readonly t = injectT();

  protected readonly GROUP_LABELS: Record<PermissionGroup, MessageKey> = {
    tenant: "permissionGroup.tenant",
    user: "permissionGroup.user",
    connection: "permissionGroup.connection",
    audit: "permissionGroup.audit"
  };

  protected readonly groups = computed(() =>
    PERMISSION_GROUPS.map((name) => ({
      name,
      permissions: PERMISSION_CATALOGUE.filter((entry) => entry.group === name)
    })).filter((group) => group.permissions.length > 0)
  );

  protected holds(role: Role, permission: PermissionKey): boolean {
    return role.permissions.includes(permission);
  }

  protected onToggle(role: Role, permission: PermissionKey, event: Event): void {
    // Disabled inputs do not fire this, so it is belt and braces — and it keeps
    // a programmatic toggle from emitting a change the API would refuse.
    if (this.readOnly()) return;

    this.toggled.emit({
      roleId: role.id,
      permission,
      granted: (event.target as HTMLInputElement).checked
    });
  }
}
