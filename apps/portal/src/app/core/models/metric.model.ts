import type { MessageKey } from "@core/i18n/messages/en";
import type { IconName } from "@shared/ui/icon.component";

/** A headline number on the dashboard, with its period-over-period movement. */
export interface Metric {
  key: string;
  /**
   * A message key, not display text.
   *
   * The metrics endpoint does not exist yet. When it does, it should return
   * exactly this — a key — rather than a translated label: an API that answers
   * in one language is how a localised product ends up with a permanently
   * English dashboard.
   */
  labelKey: MessageKey;
  value: number;
  /** Scanning aid. Carries no meaning the label does not already give. */
  icon: IconName;
  /**
   * Where the tile leads. A dashboard number that raises a question and offers
   * nowhere to answer it is a dead end — every tile here is a way in.
   */
  route: string;
  /** Percent change against the previous period. Negative means down. */
  delta: number;
  /**
   * Whether a rise is good. Sign-in failures rise and that is bad; tenants rise
   * and that is good — so the arrow's colour cannot be derived from the sign
   * alone.
   */
  direction: "up-is-good" | "down-is-good";
  format: "number" | "percent" | "currency";
  /** Recent values, oldest first, for the tile's sparkline. */
  series: number[];
}

/**
 * A single (label, value) pair in a chart.
 *
 * `label` is display text because a series label can be a date, a tenant name
 * or a translated category — the caller resolves it before handing it over.
 */
export interface SeriesPoint {
  label: string;
  value: number;
}
