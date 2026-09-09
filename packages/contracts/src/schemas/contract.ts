import { z } from "zod";

/**
 * A tenant's contract period, and what it currently means.
 *
 * The dates themselves are two nullable columns on `tenant`. What is interesting
 * is the *state* they imply — is this customer inside their term, near the end
 * of it, past it, or was a term never recorded — and that is derived rather than
 * stored, because a stored copy would be wrong every midnight until something
 * recalculated it.
 *
 * Derived **here**, in the shared package, rather than in the portal component
 * that renders it: the same question is asked by the tenant list, the tenant
 * profile, and eventually by whatever decides to send a renewal reminder. Three
 * implementations of "is this expiring soon" is three thresholds that drift.
 */

/** ISO calendar date, `YYYY-MM-DD`. Matches the `date` columns exactly. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a calendar date in YYYY-MM-DD form");

/**
 * Setting or clearing a tenant's contract period.
 *
 * Both fields are required in the body and independently nullable, which is the
 * combination that makes a PUT safe here: sending one field and omitting the
 * other would make "clear the end date" and "leave the end date alone"
 * indistinguishable, and an operator correcting a start date would silently
 * inherit whatever end date a stale form had.
 *
 * The ordering rule is checked here as well as by the database constraint. The
 * constraint is the authority — it holds against anything that reaches the
 * table — and this exists so the caller gets a 400 naming the problem instead
 * of a 500 carrying a constraint name.
 */
export const setTenantContractSchema = z
  .object({
    startDate: isoDateSchema.nullable(),
    endDate: isoDateSchema.nullable()
  })
  .strict()
  .refine(
    (value) =>
      value.startDate === null ||
      value.endDate === null ||
      // Lexicographic comparison is date comparison for ISO-8601, which is the
      // reason to insist on that format rather than accept anything Date parses.
      value.endDate >= value.startDate,
    {
      message: "The contract cannot end before it starts",
      path: ["endDate"]
    }
  );

export type SetTenantContractInput = z.infer<typeof setTenantContractSchema>;

/**
 * How many days from the end a contract counts as "ending soon".
 *
 * Thirty, because a renewal conversation is a month-long thing rather than a
 * week-long one, and an operator scanning the tenant list wants the warning
 * while there is still time to act on it.
 */
export const CONTRACT_EXPIRING_SOON_DAYS = 30;

/**
 * How many days from the end a contract becomes urgent.
 *
 * Seven. Distinct from the threshold above so the screen can escalate rather
 * than showing one flat warning for a month — a colour that has meant the same
 * thing for four weeks has stopped being read.
 */
export const CONTRACT_ENDING_IMMINENT_DAYS = 7;

/**
 * What a contract period currently amounts to.
 *
 * - `none`      — no dates recorded. Not a problem, just unknown.
 * - `upcoming`  — a start date in the future; the term has not begun.
 * - `active`    — inside the term, with more than 30 days left (or no end date).
 * - `expiring`  — inside the term, 30 days or fewer remaining.
 * - `imminent`  — inside the term, 7 days or fewer remaining.
 * - `expired`   — the end date has passed.
 */
export const CONTRACT_STATES = [
  "none",
  "upcoming",
  "active",
  "expiring",
  "imminent",
  "expired"
] as const;

export const contractStateSchema = z.enum(CONTRACT_STATES);
export type ContractState = z.infer<typeof contractStateSchema>;

/**
 * A contract period, resolved against a given day.
 *
 * `daysRemaining` is inclusive of the end date: a contract ending today has one
 * day left, not zero, because it is still in force today. It goes negative once
 * past — but do **not** negate it to get "days ago", because the inclusive
 * offset makes that answer one short. `daysSinceExpiry` does that conversion.
 *
 * `elapsedFraction` is null unless both dates are known, since a bar cannot be
 * drawn from one end of an unknown span.
 */
export interface ContractPeriod {
  state: ContractState;
  /** Inclusive days until the end date. Null when no end date is recorded. */
  daysRemaining: number | null;
  /** Total days in the term, inclusive of both ends. Null unless both are set. */
  totalDays: number | null;
  /** 0–1, clamped. Null unless both dates are set. */
  elapsedFraction: number | null;
}

/** Parses `YYYY-MM-DD` as a UTC midnight instant, with no local-timezone drift. */
const toUtcDay = (iso: string): number => {
  const [year, month, day] = iso.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
};

const MS_PER_DAY = 86_400_000;

/**
 * Works out where a contract stands.
 *
 * `today` is a parameter rather than read from the clock inside, so the
 * behaviour at every boundary — the day it starts, the day it ends, the day
 * after — is testable without moving a machine's clock or stubbing `Date`.
 * Callers pass an ISO date; the portal derives it once per render.
 *
 * Everything is computed in UTC day numbers rather than with `Date` arithmetic
 * on local time, because local time has days that are 23 and 25 hours long, and
 * a daylight-saving boundary inside a term would otherwise round a day out of
 * the answer.
 */
export function resolveContractPeriod(
  startDate: string | null,
  endDate: string | null,
  today: string
): ContractPeriod {
  const now = toUtcDay(today);
  const start = startDate === null ? null : toUtcDay(startDate);
  const end = endDate === null ? null : toUtcDay(endDate);

  if (start === null && end === null) {
    return { state: "none", daysRemaining: null, totalDays: null, elapsedFraction: null };
  }

  // Inclusive of the end date: a term ending today is still in force today.
  const daysRemaining = end === null ? null : Math.round((end - now) / MS_PER_DAY) + 1;

  const totalDays =
    start === null || end === null ? null : Math.round((end - start) / MS_PER_DAY) + 1;

  const elapsedFraction =
    start === null || end === null || totalDays === null
      ? null
      : clamp01((Math.round((now - start) / MS_PER_DAY) + 1) / totalDays);

  return {
    state: resolveState(start, now, daysRemaining),
    daysRemaining,
    totalDays,
    elapsedFraction
  };
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const resolveState = (
  start: number | null,
  now: number,
  daysRemaining: number | null
): ContractState => {
  // A future start wins over everything: a term that has not begun is not
  // expiring, whatever its end date says.
  if (start !== null && start > now) return "upcoming";

  // No end date and a started term is open-ended, which is `active` rather than
  // a state of its own — the screen says "no end date" from the dates alone.
  if (daysRemaining === null) return "active";

  if (daysRemaining <= 0) return "expired";
  if (daysRemaining <= CONTRACT_ENDING_IMMINENT_DAYS) return "imminent";
  if (daysRemaining <= CONTRACT_EXPIRING_SOON_DAYS) return "expiring";
  return "active";
};

/**
 * Above this many days, a duration reads better as a plain day count.
 *
 * Eight weeks. Below it, "1 week and 3 days" is a span somebody can picture and
 * plan against; above it, "43 weeks and 2 days" is arithmetic nobody asked for
 * and is harder to read than "303 days". The threshold is the point where the
 * week stops being the unit the reader is thinking in.
 */
export const MAX_DAYS_SHOWN_AS_WEEKS = 56;

/**
 * A duration, in the units it should be read in.
 *
 * A discriminated union rather than a formatted string, because the sentence
 * differs per language and per unit — Arabic has a dual form for exactly two
 * weeks, and "1 week and 3 days" is not built by concatenating translated
 * fragments in every language. The caller picks a message per `kind` and
 * pluralises each number through `Intl.PluralRules`.
 */
export type Duration =
  | { kind: "days"; days: number }
  | { kind: "weeks"; weeks: number }
  | { kind: "weeksAndDays"; weeks: number; days: number };

/**
 * Breaks a day count into the units it reads best in.
 *
 * - Under a week, or over `MAX_DAYS_SHOWN_AS_WEEKS`: plain days.
 * - A whole number of weeks: weeks alone, never "2 weeks and 0 days".
 * - Otherwise: weeks and days.
 *
 * Negative and zero counts come back as `days`, unchanged. This function
 * formats a magnitude and does not decide what it means — a caller with an
 * expired contract passes `daysSinceExpiry`, which is already positive.
 */
export function describeDuration(totalDays: number): Duration {
  if (totalDays < 7 || totalDays > MAX_DAYS_SHOWN_AS_WEEKS) {
    return { kind: "days", days: totalDays };
  }

  const weeks = Math.floor(totalDays / 7);
  const days = totalDays % 7;

  return days === 0 ? { kind: "weeks", weeks } : { kind: "weeksAndDays", weeks, days };
}

/**
 * How many days ago an expired contract ended.
 *
 * Not simply `-daysRemaining`, and the difference is a visible off-by-one.
 * `daysRemaining` is *inclusive* — it counts today as a remaining day, so the
 * end date itself scores 1 and the day after scores 0. Negating that renders
 * "expired 0 days ago" on the first day it is actually expired, and undercounts
 * by one every day after.
 *
 * Returns 0 for a period that has not expired, so a caller cannot render a
 * negative "days ago".
 */
export const daysSinceExpiry = (period: ContractPeriod): number =>
  period.state === "expired" && period.daysRemaining !== null
    ? 1 - period.daysRemaining
    : 0;

/** Today as `YYYY-MM-DD` in the viewer's own timezone. */
export const todayIso = (now: Date = new Date()): string => {
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
};
