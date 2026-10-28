import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { describeError } from "@core/http/api-error";
import { injectT } from "@core/i18n/i18n.service";
import type { Company, UserWarehouse, UserWarehouseInput } from "@growpath/contracts";
import { FieldComponent, SelectDirective } from "@shared/ui";
import { WarehouseLookupService, type D365Warehouse } from "../warehouse-lookup.service";

/**
 * Company, then warehouse — the D365 warehouse a user starts on in the app.
 *
 * The company select is skipped when the tenant has only one, which is the
 * common case. Warehouses are read live from Dynamics for the chosen company,
 * so the list is whatever the ERP holds today; when it cannot be reached the
 * picker says so rather than offering an empty list that looks like "no
 * warehouses".
 *
 * Emits the selection as the API takes it — company id, warehouse id and name
 * — or null for "no default warehouse".
 */
@Component({
  selector: "app-warehouse-picker",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FieldComponent, SelectDirective],
  host: { class: "block" },
  template: `
    <div [class]="companies().length > 1 ? 'grid gap-4 sm:grid-cols-2' : 'grid gap-4'">
      @if (companies().length > 1) {
        <ui-field [label]="t('warehouse.companyLabel')" [controlId]="idPrefix() + '-company'">
          <select
            uiSelect
            [id]="idPrefix() + '-company'"
            [disabled]="disabled()"
            [value]="companyId()"
            (change)="selectCompany($any($event.target).value)"
          >
            @for (company of companies(); track company.id) {
              <option [value]="company.id">{{ company.name }} ({{ company.dataAreaId }})</option>
            }
          </select>
        </ui-field>
      }

      <ui-field
        [label]="t('warehouse.label')"
        [controlId]="idPrefix() + '-warehouse'"
        [hint]="hint()"
      >
        <select
          uiSelect
          [id]="idPrefix() + '-warehouse'"
          [disabled]="disabled() || loading() || !companyId()"
          [value]="warehouseId()"
          (change)="selectWarehouse($any($event.target).value)"
        >
          <option value="">{{ t("warehouse.none") }}</option>
          @for (warehouse of warehouses(); track warehouse.warehouseId) {
            <option [value]="warehouse.warehouseId">
              {{ warehouse.warehouseId }} — {{ warehouse.name }}
            </option>
          }
          <!--
            Keeps a saved warehouse selectable even when Dynamics no longer
            lists it (or cannot be reached), so opening the page does not
            silently show "None" for a user who has one.
          -->
          @if (orphan(); as saved) {
            <option [value]="saved.warehouseId">{{ saved.warehouseId }} — {{ saved.name }}</option>
          }
        </select>
      </ui-field>
    </div>
  `
})
export class WarehousePickerComponent {
  /** The saved warehouse, when editing a user who has one. */
  readonly value = input<UserWarehouse | null>(null);
  readonly disabled = input(false);
  /** Unique per form, so two pickers on a page do not share element ids. */
  readonly idPrefix = input("warehouse");

  readonly selectionChange = output<UserWarehouseInput | null>();

  private readonly lookup = inject(WarehouseLookupService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly t = injectT();
  protected readonly companies = signal<Company[]>([]);
  protected readonly warehouses = signal<D365Warehouse[]>([]);
  protected readonly companyId = signal("");
  protected readonly warehouseId = signal("");
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    this.lookup
      .listCompanies()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (companies) => {
          // Set first: loadWarehouses looks the company up in this list.
          this.companies.set(companies);
          const saved = untracked(this.value);
          const initial = saved?.companyId ?? companies[0]?.id ?? "";
          this.companyId.set(initial);
          this.warehouseId.set(saved?.warehouseId ?? "");
          if (initial) this.loadWarehouses(initial);
        },
        error: (error: unknown) =>
          this.error.set(describeError(error, this.t, "warehouse.companiesFailed"))
      });

    // A new saved value (the page reloaded the user) resets the selection.
    // Ignored until the companies have arrived: the load above applies the
    // first value itself, and acting here too fetched the warehouses twice.
    effect(
      () => {
        const saved = this.value();
        untracked(() => {
          if (this.companies().length === 0) return;
          if (saved && saved.companyId !== this.companyId()) {
            this.companyId.set(saved.companyId);
            this.loadWarehouses(saved.companyId);
          }
          this.warehouseId.set(saved?.warehouseId ?? "");
        });
      },
      { allowSignalWrites: true }
    );
  }

  /** The saved warehouse when the live list does not contain it. */
  protected orphan(): UserWarehouse | null {
    const saved = this.value();
    if (!saved || saved.companyId !== this.companyId()) return null;
    return this.warehouses().some((w) => w.warehouseId === saved.warehouseId) ? null : saved;
  }

  protected hint(): string {
    if (this.error()) return this.error() ?? "";
    if (this.loading()) return this.t("warehouse.loading");
    if (this.companies().length === 0) return this.t("warehouse.noCompanies");
    return this.t("warehouse.hint");
  }

  protected selectCompany(companyId: string): void {
    this.companyId.set(companyId);
    this.warehouseId.set("");
    this.selectionChange.emit(null);
    this.loadWarehouses(companyId);
  }

  protected selectWarehouse(warehouseId: string): void {
    this.warehouseId.set(warehouseId);
    if (!warehouseId) {
      this.selectionChange.emit(null);
      return;
    }
    const match =
      this.warehouses().find((w) => w.warehouseId === warehouseId) ??
      (this.orphan()?.warehouseId === warehouseId
        ? { warehouseId, name: this.orphan()?.name ?? warehouseId }
        : null);
    if (!match) return;
    this.selectionChange.emit({
      companyId: this.companyId(),
      warehouseId: match.warehouseId,
      name: match.name
    });
  }

  private loadWarehouses(companyId: string): void {
    const company = this.companies().find((c) => c.id === companyId);
    if (!company) return;
    this.loading.set(true);
    this.error.set(null);
    this.warehouses.set([]);
    this.lookup
      .listWarehouses(company)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (warehouses) => {
          this.loading.set(false);
          this.warehouses.set(warehouses);
        },
        error: (error: unknown) => {
          this.loading.set(false);
          this.error.set(describeError(error, this.t, "warehouse.loadFailed"));
        }
      });
  }
}
