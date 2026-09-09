import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  model,
  signal
} from "@angular/core";
import { I18nService, injectT } from "@core/i18n/i18n.service";
import { MODULE_DESCRIPTION_KEYS, MODULE_LABEL_KEYS } from "@core/i18n/label-keys";
import { MODULE_KEYS, type ModuleKey } from "@growpath/contracts";
import { IconComponent } from "@shared/ui";

/**
 * One row the picker renders.
 *
 * Deliberately not `TenantModule` from the contracts package. This component is
 * used in two places that know different amounts: the tenant profile has a
 * server response, and the create form has no tenant yet and therefore no
 * response at all — only the compile-time catalogue. Taking the smaller shape
 * lets both call it without one of them inventing fields it cannot know.
 */
export interface PickableModule {
  key: string;
  /** The API's English description. Used only when this build lacks a label. */
  description: string;
  /** ISO-8601 grant date, when the caller has one. Null or absent otherwise. */
  enabledAt?: string | null;
}

/**
 * The catalogue as the create form sees it: keys, in order, and nothing else.
 *
 * A tenant that does not exist yet holds nothing and was granted nothing on any
 * date, so there is no response to render and no fetch worth making. The
 * descriptions come from the same i18n catalogue the fetched rows resolve
 * against, so both callers render identical text.
 */
export const CATALOGUE_AS_PICKABLE: readonly PickableModule[] = MODULE_KEYS.map((key) => ({
  key,
  description: "",
  enabledAt: null
}));

/**
 * Choosing which modules a tenant is entitled to.
 *
 * Shared by the create-tenant dialog and the tenant profile, which is the point
 * of it existing: the two screens ask the same question about the same
 * catalogue, and the alternative — two lists of checkboxes with two ideas about
 * ordering, labelling and what "selected" looks like — is how they drift.
 *
 * Presentational. It owns the selection through a `model()` and owns nothing
 * else: no fetching, no saving, no toasts. The profile screen loads and persists
 * around it; the create form carries the value into its own submit. That split
 * is what lets the create form use it before a tenant exists to save against.
 *
 * ### On the search box
 *
 * Thirteen rows is not many, and a filter over thirteen rows is usually
 * clutter. It earns its place because the catalogue is the one part of this
 * screen expected to grow — it tracks the app's navigation groups — and because
 * it is hidden below a threshold rather than always shown.
 */
@Component({
  selector: "app-module-picker",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <div class="space-y-3">
      <!--
        The summary bar: what is chosen, and the two bulk actions.

        The count is the thing an operator checks against what a customer
        bought, so it reads as a sentence rather than as a bare fraction.
      -->
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-sm text-foreground-muted">
          <span class="font-medium text-foreground">
            {{ t("modulePicker.count", { selected: selected().length, total: modules().length }) }}
          </span>
        </p>

        <div class="flex items-center gap-1">
          <button
            type="button"
            class="rounded-lg px-2.5 py-1 text-xs font-medium text-foreground-muted transition-colors duration-200 hover:bg-surface-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            [disabled]="disabled() || allSelected()"
            (click)="selectAll()"
          >
            {{ t("modulePicker.selectAll") }}
          </button>
          <button
            type="button"
            class="rounded-lg px-2.5 py-1 text-xs font-medium text-foreground-muted transition-colors duration-200 hover:bg-surface-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            [disabled]="disabled() || !anySelected()"
            (click)="clearAll()"
          >
            {{ t("modulePicker.clear") }}
          </button>
        </div>
      </div>

      @if (modules().length > SEARCH_THRESHOLD) {
        <div class="relative">
          <span class="pointer-events-none absolute inset-y-0 start-0 flex items-center ps-3 text-foreground-subtle">
            <ui-icon name="search" [size]="14" />
          </span>
          <input
            type="search"
            class="h-9 w-full rounded-xl border border-border bg-surface ps-9 pe-3 text-sm text-foreground outline-none transition-colors duration-200 placeholder:text-foreground-subtle focus:border-primary"
            [value]="query()"
            [attr.placeholder]="t('modulePicker.searchPlaceholder')"
            [attr.aria-label]="t('modulePicker.searchLabel')"
            (input)="query.set($any($event.target).value)"
          />
        </div>
      }

      @if (visible().length === 0) {
        <p class="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-foreground-muted">
          {{ t("modulePicker.noMatches", { query: query() }) }}
        </p>
      } @else {
        <!--
          A two-column grid above the sm breakpoint, because a module is a
          short label over a one-line description — a single column of thirteen
          of those is a lot of scrolling for a shape that fits side by side.

          A group role rather than a list: these are form controls, and a
          screen reader announcing "list, 13 items" over a set of checkboxes
          describes the markup rather than the choice being made.
        -->
        <div
          role="group"
          class="grid gap-2 sm:grid-cols-2"
          [attr.aria-label]="t('modulePicker.groupLabel')"
        >
          @for (module of visible(); track module.key) {
            <label
              class="group relative flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 transition-all duration-200"
              [class]="
                isSelected(module.key)
                  ? 'border-primary bg-primary/5 shadow-sm'
                  : 'border-border hover:border-border-strong hover:bg-surface-muted'
              "
              [class.cursor-not-allowed]="disabled()"
              [class.opacity-60]="disabled()"
            >
              <input
                type="checkbox"
                class="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                [checked]="isSelected(module.key)"
                [disabled]="disabled()"
                (change)="toggle(module.key)"
              />

              <span class="min-w-0 flex-1">
                <span class="block text-sm font-medium leading-tight text-foreground">
                  {{ label(module) }}
                </span>
                <span class="mt-1 block text-xs leading-relaxed text-foreground-muted">
                  {{ description(module) }}
                </span>

                <!--
                  The grant date, not a "held" badge. "Since 4 March" answers a
                  question a support call actually asks; a tick that the
                  checkbox already shows answers none.

                  Absent on the create form, where nothing has been granted yet
                  and every date would be today.
                -->
                @if (module.enabledAt; as at) {
                  <span class="mt-1.5 flex items-center gap-1 text-xs text-foreground-subtle">
                    <ui-icon name="check-circle" [size]="12" />
                    {{ t("modules.enabledSince", { date: i18n.formatDate(at) }) }}
                  </span>
                }
              </span>
            </label>
          }
        </div>
      }
    </div>
  `
})
export class ModulePickerComponent {
  /** The catalogue to render, in the order it should appear. */
  readonly modules = input.required<readonly PickableModule[]>();

  /**
   * The chosen keys. Two-way: the parent owns the value, this owns the editing.
   *
   * A `model()` rather than an input plus an output, so a parent that only wants
   * the current selection writes `[(selected)]` and one that wants to react to
   * every change still can.
   */
  readonly selected = model.required<readonly string[]>();

  /** Set while a save is in flight, so a second click cannot race the first. */
  readonly disabled = input(false);

  protected readonly t = injectT();
  protected readonly i18n = inject(I18nService);

  /** Above this many rows the filter is worth its space. Below it, it is noise. */
  protected readonly SEARCH_THRESHOLD = 8;

  protected readonly query = signal("");

  /**
   * The rows the filter admits.
   *
   * Matches the *translated* label and description rather than the key, because
   * that is what is on screen — an Arabic reader typing "المستودع" should find
   * the warehouse row, and typing `warehouse` finds nothing they can see.
   */
  protected readonly visible = computed(() => {
    const query = this.query().trim().toLocaleLowerCase();
    if (!query) return this.modules();

    return this.modules().filter((module) =>
      `${this.label(module)} ${this.description(module)}`.toLocaleLowerCase().includes(query)
    );
  });

  /**
   * Whether *Select all* would do anything — i.e. every visible row is ticked.
   *
   * Measured against `visible()` rather than the whole catalogue, so the button
   * disables exactly when it has nothing left to add. Comparing lengths against
   * `modules()` would leave it enabled-but-inert while a filter is narrowing
   * the list, and disabled while a filter hides unticked rows.
   */
  protected readonly allSelected = computed(() => {
    const visible = this.visible();
    if (visible.length === 0) return true;

    const selected = new Set(this.selected());
    return visible.every((module) => selected.has(module.key));
  });

  /** Whether *Clear* would do anything — i.e. any visible row is ticked. */
  protected readonly anySelected = computed(() => {
    const selected = new Set(this.selected());
    return this.visible().some((module) => selected.has(module.key));
  });

  protected isSelected(key: string): boolean {
    return this.selected().includes(key);
  }

  protected toggle(key: string): void {
    if (this.disabled()) return;

    const current = this.selected();
    this.selected.set(
      current.includes(key) ? current.filter((held) => held !== key) : [...current, key]
    );
  }

  /**
   * Both bulk actions act on the rows the filter is showing, and only those.
   *
   * The alternative — acting on the whole catalogue regardless — is defensible
   * for *Select all* and dangerous for *Clear*: an operator who has ticked nine
   * modules, then typed "warehouse" to check one row, and then clicked *Clear*
   * expecting it to affect what is in front of them would lose all nine with no
   * undo. Scoping one and not the other is worse still, because the two buttons
   * sit together and read as a pair.
   *
   * With no filter active `visible()` is the whole catalogue, so this is the
   * obvious behaviour in the common case and the safe one in the other.
   */
  protected selectAll(): void {
    if (this.disabled()) return;

    const keys = new Set(this.selected());
    for (const module of this.visible()) keys.add(module.key);
    this.selected.set([...keys]);
  }

  protected clearAll(): void {
    if (this.disabled()) return;

    const hidden = new Set(this.visible().map((module) => module.key));
    this.selected.set(this.selected().filter((key) => !hidden.has(key)));
  }

  /**
   * The module's name, translated.
   *
   * Falls back to the key for one this build has never heard of, which happens
   * when the database's catalogue is ahead of the deployed portal. A bare key is
   * worse than a translation and much better than a blank row.
   */
  protected label(module: PickableModule): string {
    const key = MODULE_LABEL_KEYS[module.key as ModuleKey];
    return key ? this.t(key) : module.key;
  }

  protected description(module: PickableModule): string {
    const key = MODULE_DESCRIPTION_KEYS[module.key as ModuleKey];
    return key ? this.t(key) : module.description;
  }
}
