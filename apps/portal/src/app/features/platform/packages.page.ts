import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { SessionStore } from "@core/auth/session.store";
import { describeError } from "@core/http/api-error";
import { I18nService, injectT } from "@core/i18n/i18n.service";
import { TENANT_PLAN_LABEL_KEYS } from "@core/i18n/label-keys";
import { ToastService } from "@core/notifications/toast.service";
import { asyncError, asyncLoading, type Async, type Plan } from "@core/models";
import {
  ButtonComponent,
  CardComponent,
  CardHeaderComponent,
  ErrorStateComponent,
  InputDirective,
  SkeletonComponent,
  TableComponent
} from "@shared/ui";
import { PageHeaderComponent } from "../../layout/page-header.component";
import { PlatformService } from "./platform.service";

/**
 * What each package includes, and the one number on it that moves.
 *
 * The seat count was always meant to be operational rather than deployed — the
 * plan-seat-limits migration put it in a table precisely so that raising the
 * enterprise allowance would be an `UPDATE` and not a release. That left it
 * reachable only by whoever had a database prompt, which is a smaller set of
 * people than the set who make the decision. This is the same `UPDATE`, behind
 * the same permission as every other commercial change.
 *
 * ### Why this is not the tenant screen
 *
 * A tenant's own allowance is edited on the tenant, and it overrides whatever
 * its package says. The two are deliberately separate screens because they are
 * separate decisions with different blast radii: one is a concession to one
 * customer, and this is a change to what the product sells to everybody on that
 * package. The tenant count in each row is there to keep that difference in
 * front of whoever is typing.
 *
 * Tenants with a negotiated figure are unaffected by anything done here, which
 * is the whole reason `tenant.seat_limit` is nullable — so the count is an upper
 * bound on who moves, not an exact one.
 */
@Component({
  selector: "app-platform-packages-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ButtonComponent,
    CardComponent,
    CardHeaderComponent,
    ErrorStateComponent,
    InputDirective,
    PageHeaderComponent,
    SkeletonComponent,
    TableComponent
  ],
  template: `
    <app-page-header [title]="t('packages.title')" [description]="t('packages.subtitle')" />

    @switch (state().status) {
      @case ("error") {
        <ui-card>
          <ui-error-state
            [title]="t('packages.loadFailed')"
            [message]="state().error ?? ''"
            (retry)="load()"
          />
        </ui-card>
      }

      @case ("loading") {
        <ui-card>
          <div class="space-y-3" aria-busy="true" [attr.aria-label]="t('packages.loadingLabel')">
            @for (row of [1, 2, 3, 4]; track row) {
              <ui-skeleton shape="h-12 w-full rounded-xl" />
            }
          </div>
        </ui-card>
      }

      @default {
        <ui-card [padded]="false">
          <div class="p-6 pb-0">
            <ui-card-header
              [title]="t('packages.catalogueTitle')"
              [description]="t('packages.catalogueBody')"
            />
          </div>
          <div class="mt-6">
            <ui-table>
              <thead>
                <tr>
                  <th scope="col">{{ t("packages.columnPackage") }}</th>
                  <th scope="col">{{ t("packages.columnSeats") }}</th>
                  <th scope="col">{{ t("packages.columnTenants") }}</th>
                  @if (canEdit()) {
                    <th scope="col" class="text-end">
                      <span class="sr-only">{{ t("packages.columnActions") }}</span>
                    </th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (plan of state().data ?? []; track plan.key) {
                  <tr>
                    <td>
                      <p class="font-medium text-foreground">{{ t(PLAN_LABELS[plan.key]) }}</p>
                      <p dir="ltr" class="font-mono text-xs text-foreground-subtle">
                        {{ plan.key }}
                      </p>
                    </td>
                    <td>
                      <!--
                        Editable in place rather than behind a dialog. There is
                        one field, it is a number, and a modal for it would be
                        three clicks to change a digit.

                        Read-only operators get the number as text, not a
                        disabled input — a greyed-out box invites a click that
                        does nothing and reads as a fault.
                      -->
                      @if (canEdit()) {
                        <input
                          uiInput
                          type="number"
                          min="1"
                          step="1"
                          class="!w-28 tabular-nums"
                          [attr.aria-label]="
                            t('packages.seatsFor', { plan: t(PLAN_LABELS[plan.key]) })
                          "
                          [disabled]="saving() === plan.key"
                          [value]="draftFor(plan)"
                          (input)="onInput(plan.key, $event)"
                        />
                      } @else {
                        <span class="tabular-nums text-foreground-muted">
                          {{ i18n.formatNumber(plan.userLimit) }}
                        </span>
                      }
                    </td>
                    <td class="tabular-nums text-foreground-muted">
                      {{ i18n.formatNumber(plan.tenantCount) }}
                    </td>
                    @if (canEdit()) {
                      <td class="text-end">
                        <button
                          uiButton
                          size="sm"
                          variant="outline"
                          type="button"
                          [disabled]="!isChanged(plan)"
                          [loading]="saving() === plan.key"
                          (click)="save(plan)"
                        >
                          {{ t("packages.save") }}
                        </button>
                      </td>
                    }
                  </tr>
                }
              </tbody>
            </ui-table>
          </div>

          @if (canEdit()) {
            <div class="border-t border-border p-6 pt-4">
              <p class="text-xs text-foreground-subtle">{{ t("packages.reachNote") }}</p>
            </div>
          }
        </ui-card>
      }
    }
  `
})
export class PlatformPackagesPage {
  private readonly platform = inject(PlatformService);
  private readonly session = inject(SessionStore);
  private readonly toasts = inject(ToastService);

  protected readonly t = injectT();
  protected readonly i18n = inject(I18nService);
  protected readonly PLAN_LABELS = TENANT_PLAN_LABEL_KEYS;

  protected readonly state = signal<Async<Plan[]>>(asyncLoading());

  /** The package whose row is currently saving, or null. */
  protected readonly saving = signal<string | null>(null);

  /**
   * Typed values, keyed by package, for rows the user has touched.
   *
   * Sparse on purpose: a row with no entry renders the server's number, so a
   * reload that shows a package somebody else moved is visible rather than
   * masked by a stale draft. An entry appears only once the field is edited.
   */
  private readonly drafts = signal<Record<string, string>>({});

  /**
   * Whether to offer the inputs at all.
   *
   * `platform.plan.write` — the same key that moves a tenant between packages
   * and sets a tenant's negotiated figure, because all three decide what a
   * customer may have. A rendering decision only: the endpoint checks the same
   * claim, so an operator who edits this out of storage gets the field back and
   * the same 403 they would have got anyway.
   */
  protected readonly canEdit = () => this.session.hasPermission("platform.plan.write");

  protected draftFor(plan: Plan): string {
    return this.drafts()[plan.key] ?? String(plan.userLimit);
  }

  protected isChanged(plan: Plan): boolean {
    const parsed = this.parse(this.draftFor(plan));
    return parsed !== null && parsed !== plan.userLimit;
  }

  /** The typed value as the API takes it, or null when it is not a usable one. */
  private parse(raw: string): number | null {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    const value = Number(trimmed);
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  protected onInput(key: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.drafts.update((drafts) => ({ ...drafts, [key]: value }));
  }

  protected save(plan: Plan): void {
    const userLimit = this.parse(this.draftFor(plan));
    if (userLimit === null || userLimit === plan.userLimit) return;

    this.saving.set(plan.key);
    this.platform.setPlanUserLimit(plan.key, userLimit).subscribe({
      next: (plans) => {
        this.saving.set(null);
        // The draft is dropped rather than kept, so the row goes back to
        // rendering the server's number — which is now the one just saved.
        this.drafts.update((drafts) => {
          const next = { ...drafts };
          delete next[plan.key];
          return next;
        });
        this.state.set({ status: "success", data: plans, error: null });
        this.toasts.success(
          this.t("packages.savedToast", {
            plan: this.t(this.PLAN_LABELS[plan.key]),
            limit: userLimit
          })
        );
      },
      error: (error: unknown) => {
        this.saving.set(null);
        // The draft stays where the user put it, so a retry does not start from
        // a number they did not choose.
        this.toasts.error(describeError(error, this.t, "packages.saveFailed"));
      }
    });
  }

  constructor() {
    this.load();
  }

  protected load(): void {
    this.state.set(asyncLoading(this.state().data));

    this.platform.listPlans().subscribe({
      next: (plans) => this.state.set({ status: "success", data: plans, error: null }),
      error: (error: unknown) =>
        this.state.set(asyncError(describeError(error, this.t, "packages.loadError")))
    });
  }
}
