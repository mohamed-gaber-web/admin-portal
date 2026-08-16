import { Injectable } from "@angular/core";
import type { Observable } from "rxjs";
import { mockResponse } from "@core/http/mock";
import type { ActivityEntry, Metric, TenantPlan } from "@core/models";
import type { AttentionItem } from "./components/attention-panel.component";

/** Periods the growth chart can be shown over. */
export type TrendRange = "30d" | "90d" | "12m";

export interface TrendData {
  labels: string[];
  tenants: number[];
  users: number[];
}

export interface DashboardData {
  metrics: Metric[];
  /**
   * Every range, fetched once.
   *
   * Switching period is then instant and needs no spinner. Three small arrays
   * cost less than the round trip they replace, and the alternative — refetch
   * per range — makes the most-used control on the screen the slowest one.
   */
  trend: Record<TrendRange, TrendData>;
  /**
   * Plan ids and counts, not chart-ready points.
   *
   * The chart wants a display label, and "Growth" has to be translated before
   * it can be one — so the id travels this far and the page resolves it.
   */
  plans: { plan: TenantPlan; value: number }[];
  attention: AttentionItem[];
  activity: ActivityEntry[];
}

/**
 * Everything the dashboard shows, in one call.
 *
 * One request rather than five, because the screen has nothing useful to render
 * until it has all of it — five independent loads means five skeletons
 * resolving at five different moments, and a layout that shifts four times.
 *
 * The data is a fixture (see `mockResponse`): the API has no metrics,
 * audit-log or time-series endpoint yet. When those land, only the body of
 * `load()` changes.
 */
@Injectable({ providedIn: "root" })
export class DashboardService {
  load(): Observable<DashboardData> {
    return mockResponse(FIXTURE, 700);
  }
}

const FIXTURE: DashboardData = {
  metrics: [
    {
      key: "tenants",
      labelKey: "metric.tenants",
      value: 48,
      delta: 12.5,
      direction: "up-is-good",
      format: "number",
      icon: "building",
      route: "/tenants",
      series: [31, 33, 34, 37, 39, 40, 43, 44, 45, 46, 47, 48]
    },
    {
      key: "users",
      labelKey: "metric.users",
      value: 1284,
      delta: 8.2,
      direction: "up-is-good",
      format: "number",
      icon: "users",
      route: "/users",
      series: [903, 942, 981, 1010, 1044, 1071, 1102, 1148, 1183, 1220, 1256, 1284]
    },
    {
      key: "invitations",
      labelKey: "metric.invitations",
      value: 23,
      delta: -14.8,
      direction: "down-is-good",
      format: "number",
      icon: "mail",
      route: "/users",
      series: [41, 39, 36, 38, 34, 33, 30, 29, 27, 26, 24, 23]
    },
    {
      key: "failed-signins",
      labelKey: "metric.failedSignins",
      value: 17,
      delta: 22.4,
      direction: "down-is-good",
      format: "number",
      icon: "shield",
      route: "/activity",
      series: [9, 11, 8, 10, 12, 11, 13, 12, 14, 15, 14, 17]
    }
  ],

  trend: {
    "30d": {
      labels: ["W1", "W2", "W3", "W4"],
      tenants: [44, 45, 47, 48],
      users: [1183, 1220, 1256, 1284]
    },
    "90d": {
      labels: ["Jun", "Jul", "Aug"],
      tenants: [43, 46, 48],
      users: [1102, 1256, 1284]
    },
    "12m": {
      labels: ["Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug"],
      tenants: [26, 28, 29, 31, 33, 35, 37, 39, 41, 43, 46, 48],
      users: [612, 668, 715, 764, 823, 881, 940, 1002, 1061, 1123, 1210, 1284]
    }
  },

  plans: [
    { plan: "enterprise", value: 14 },
    { plan: "growth", value: 19 },
    { plan: "starter", value: 11 },
    { plan: "trial", value: 4 }
  ],

  /**
   * Ordered by how much it matters, not by category. The panel renders them in
   * the order given, so this array is the ranking.
   */
  attention: [
    {
      id: "failed-signins",
      tone: "danger",
      icon: "shield",
      titleKey: "attention.failedSignins.title",
      detailKey: "attention.failedSignins.detail",
      route: "/activity"
    },
    {
      id: "stale-invitations",
      tone: "warning",
      icon: "mail",
      titleKey: "attention.staleInvitations.title",
      detailKey: "attention.staleInvitations.detail",
      route: "/users"
    },
    {
      id: "suspended",
      tone: "warning",
      icon: "building",
      titleKey: "attention.suspended.title",
      detailKey: "attention.suspended.detail",
      route: "/tenants"
    },
    {
      id: "trials",
      tone: "info",
      icon: "calendar",
      titleKey: "attention.trials.title",
      detailKey: "attention.trials.detail",
      route: "/tenants"
    }
  ],

  activity: [
    {
      id: "1",
      action: "tenant.provisioned",
      actor: "platform@growpath.net",
      target: "northwind",
      at: "2026-08-12T09:14:00Z",
      severity: "success"
    },
    {
      id: "2",
      action: "invitation.issued",
      actor: "amelia.hart@acme.com",
      target: "dev@acme.com",
      at: "2026-08-12T08:47:00Z",
      severity: "info"
    },
    {
      id: "3",
      action: "invitation.accepted",
      actor: "dev@acme.com",
      target: "acme",
      at: "2026-08-12T08:31:00Z",
      severity: "success"
    },
    {
      id: "4",
      action: "role.assigned",
      actor: "platform@growpath.net",
      target: "admin · northwind",
      at: "2026-08-11T17:02:00Z",
      severity: "info"
    },
    {
      id: "5",
      action: "auth.sign_in_failed",
      actor: "unknown@acme.com",
      target: "acme",
      at: "2026-08-11T16:40:00Z",
      severity: "warning"
    },
    {
      id: "6",
      action: "tenant.soft_deleted",
      actor: "platform@growpath.net",
      target: "legacy-co",
      at: "2026-08-11T11:20:00Z",
      severity: "danger"
    }
  ]
};
