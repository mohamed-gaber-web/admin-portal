import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { describeError } from "@core/http/api-error";
import { injectT } from "@core/i18n/i18n.service";
import { SEVERITY_LABEL_KEYS } from "@core/i18n/label-keys";
import {
  DEFAULT_PAGE_SIZE,
  asyncError,
  asyncLoading,
  type ActivityEntry,
  type ActivitySeverity,
  type Async,
  type Page
} from "@core/models";
import {
  ButtonComponent,
  CardComponent,
  EmptyStateComponent,
  ErrorStateComponent,
  IconComponent,
  InputDirective,
  PaginationComponent,
  SelectDirective,
  SkeletonComponent
} from "@shared/ui";
import { ActivityListComponent } from "@shared/components/activity-list.component";
import { PageHeaderComponent } from "../../layout/page-header.component";
import { ActivityService } from "./activity.service";

const SEVERITIES: readonly ActivitySeverity[] = ["info", "success", "warning", "danger"];

/**
 * The full audit log.
 *
 * Shares `ActivityListComponent` with the dashboard, so an event reads the same
 * on both screens. The dashboard shows the last handful; this pages through all
 * of it and filters.
 */
@Component({
  selector: "app-activity-page",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ActivityListComponent,
    ButtonComponent,
    CardComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    IconComponent,
    InputDirective,
    PageHeaderComponent,
    PaginationComponent,
    SelectDirective,
    SkeletonComponent
  ],
  template: `
    <app-page-header
      [title]="t('activity.title')"
      [description]="t('activity.subtitle')"
    />

    <ui-card [padded]="false">
      <div class="flex flex-wrap items-center gap-3 p-4">
        <div class="relative min-w-0 flex-1 sm:max-w-xs">
          <span
            class="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-foreground-subtle"
          >
            <ui-icon name="search" [size]="16" />
          </span>
          <input
            uiInput
            type="search"
            class="!py-2 !ps-9"
            [attr.placeholder]="t('activity.searchPlaceholder')"
            [attr.aria-label]="t('activity.searchLabel')"
            [value]="search()"
            (input)="onSearch($event)"
          />
        </div>

        <select
          uiSelect
          class="!w-auto !py-2"
          [attr.aria-label]="t('activity.filterSeverity')"
          [value]="severity()"
          (change)="onSeverity($event)"
        >
          <option value="all">{{ t("activity.allSeverities") }}</option>
          @for (option of severities; track option) {
            <option [value]="option">{{ t(SEVERITY_LABELS[option]) }}</option>
          }
        </select>
      </div>

      @switch (state().status) {
        @case ("error") {
          <ui-error-state
            [title]="t('activity.loadFailed')"
            [message]="state().error ?? ''"
            (retry)="load()"
          />
        }

        @case ("loading") {
          <div class="space-y-3 p-4" aria-busy="true" [attr.aria-label]="t('activity.loadingLabel')">
            @for (row of [1, 2, 3, 4, 5, 6, 7, 8]; track row) {
              <ui-skeleton shape="h-12 w-full rounded-xl" />
            }
          </div>
        }

        @default {
          @if (state().data!.items.length === 0) {
            <ui-empty-state
              icon="activity"
              [title]="t('activity.emptyTitle')"
              [description]="t('activity.emptyBody')"
            >
              <button uiButton variant="outline" size="sm" (click)="reset()">
                {{ t("common.clearFilters") }}
              </button>
            </ui-empty-state>
          } @else {
            <div class="px-4">
              <app-activity-list [entries]="state().data!.items" />
            </div>
            <ui-pagination
              [page]="state().data!.page"
              [pageSize]="state().data!.pageSize"
              [total]="state().data!.total"
              (pageChange)="goToPage($event)"
            />
          }
        }
      }
    </ui-card>
  `
})
export class ActivityPage {
  private readonly activity = inject(ActivityService);

  protected readonly t = injectT();
  protected readonly SEVERITY_LABELS = SEVERITY_LABEL_KEYS;
  protected readonly severities = SEVERITIES;
  protected readonly state = signal<Async<Page<ActivityEntry>>>(asyncLoading());
  protected readonly search = signal("");
  protected readonly severity = signal<ActivitySeverity | "all">("all");
  protected readonly page = signal(1);

  private searchTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    this.load();
  }

  protected load(): void {
    this.state.set(asyncLoading(this.state().data));
    this.activity
      .list({
        page: this.page(),
        pageSize: DEFAULT_PAGE_SIZE,
        search: this.search(),
        severity: this.severity()
      })
      .subscribe({
        next: (data) => this.state.set({ status: "success", data, error: null }),
        error: (error: unknown) =>
          this.state.set(asyncError(describeError(error, this.t, "activity.loadError")))
      });
  }

  protected onSearch(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.search.set(value);
      this.page.set(1);
      this.load();
    }, 300);
  }

  protected onSeverity(event: Event): void {
    this.severity.set(
      (event.target as HTMLSelectElement).value as ActivitySeverity | "all"
    );
    this.page.set(1);
    this.load();
  }

  protected reset(): void {
    this.search.set("");
    this.severity.set("all");
    this.page.set(1);
    this.load();
  }

  protected goToPage(page: number): void {
    this.page.set(page);
    this.load();
  }
}
