import { describe, it, expect } from "vitest";
import {
  CONTRACT_ENDING_IMMINENT_DAYS,
  CONTRACT_EXPIRING_SOON_DAYS,
  MAX_DAYS_SHOWN_AS_WEEKS,
  daysSinceExpiry,
  describeDuration,
  resolveContractPeriod,
  todayIso
} from "../packages/contracts/src/schemas/contract";
import { setTenantContractSchema } from "../packages/contracts/src/schemas/contract";

/**
 * The contract period, at its boundaries.
 *
 * Date arithmetic is where this kind of code goes wrong, and it goes wrong
 * quietly: an off-by-one puts "expires today" on the wrong day, and a timezone
 * assumption puts it on the wrong day for half the world only. `today` is a
 * parameter to `resolveContractPeriod` precisely so every one of those edges is
 * reachable without moving a clock.
 */
describe("resolveContractPeriod", () => {
  const period = (start: string | null, end: string | null, today: string) =>
    resolveContractPeriod(start, end, today);

  it("reports nothing recorded when neither date is set", () => {
    expect(period(null, null, "2026-06-15")).toEqual({
      state: "none",
      daysRemaining: null,
      totalDays: null,
      elapsedFraction: null
    });
  });

  it("counts the end date itself as a remaining day", () => {
    // A contract ending today is still in force today. Zero would mean it had
    // already lapsed, and the card would say "expired" on the last valid day.
    expect(period("2026-01-01", "2026-06-15", "2026-06-15").daysRemaining).toBe(1);
    expect(period("2026-01-01", "2026-06-15", "2026-06-15").state).toBe("imminent");
  });

  it("flips to expired the day after the end date", () => {
    const result = period("2026-01-01", "2026-06-15", "2026-06-16");
    expect(result.state).toBe("expired");
    expect(result.daysRemaining).toBe(0);
    // Not zero. The first day past the end is one day ago, and rendering
    // "expired 0 days ago" is what negating the inclusive count would produce.
    expect(daysSinceExpiry(result)).toBe(1);
  });

  it("reports no elapsed days for a period that has not expired", () => {
    expect(daysSinceExpiry(period("2026-01-01", "2026-12-31", "2026-06-15"))).toBe(0);
    expect(daysSinceExpiry(period(null, null, "2026-06-15"))).toBe(0);
  });

  it("converts a lapsed term into days ago without losing one", () => {
    const expired = period("2026-01-01", "2026-06-15", "2026-06-27");
    // Inclusive, so the raw count is -11: the term ended on the 15th and the
    // 27th is the 12th day since. `daysSinceExpiry` is what renders.
    expect(expired.daysRemaining).toBe(-11);
    expect(daysSinceExpiry(expired)).toBe(12);
  });

  it("treats a future start as upcoming, whatever the end date says", () => {
    // A term that has not begun is not expiring, even when its end is close.
    const result = period("2026-07-01", "2026-07-05", "2026-06-15");
    expect(result.state).toBe("upcoming");
  });

  it("is active on the first day of the term", () => {
    expect(period("2026-06-15", "2026-12-31", "2026-06-15").state).toBe("active");
  });

  it("escalates through expiring and imminent at the documented thresholds", () => {
    /** Builds a term whose `daysRemaining` is exactly `remaining`. */
    const withRemaining = (remaining: number) => {
      // daysRemaining is inclusive of the end date, so the end is
      // `remaining - 1` days after today.
      const end = new Date(Date.UTC(2026, 5, 15) + (remaining - 1) * 86_400_000);
      return period("2026-01-01", end.toISOString().slice(0, 10), "2026-06-15");
    };

    expect(withRemaining(CONTRACT_EXPIRING_SOON_DAYS).daysRemaining).toBe(
      CONTRACT_EXPIRING_SOON_DAYS
    );

    expect(withRemaining(CONTRACT_EXPIRING_SOON_DAYS).state).toBe("expiring");
    expect(withRemaining(CONTRACT_EXPIRING_SOON_DAYS + 1).state).toBe("active");
    expect(withRemaining(CONTRACT_ENDING_IMMINENT_DAYS).state).toBe("imminent");
    expect(withRemaining(CONTRACT_ENDING_IMMINENT_DAYS + 1).state).toBe("expiring");
  });

  it("is open-ended and active with a start but no end", () => {
    const result = period("2026-01-01", null, "2026-06-15");
    expect(result.state).toBe("active");
    expect(result.daysRemaining).toBeNull();
    // No bar: a progress bar drawn to an unknown end would invent a number.
    expect(result.elapsedFraction).toBeNull();
  });

  it("draws no bar when only an end date is known", () => {
    expect(period(null, "2026-12-31", "2026-06-15").elapsedFraction).toBeNull();
  });

  it("counts a single-day contract as one day, not zero", () => {
    const result = period("2026-06-15", "2026-06-15", "2026-06-15");
    expect(result.totalDays).toBe(1);
    expect(result.daysRemaining).toBe(1);
    expect(result.elapsedFraction).toBe(1);
  });

  it("clamps the bar outside the term rather than reporting past 100%", () => {
    expect(period("2026-01-01", "2026-06-15", "2026-09-01").elapsedFraction).toBe(1);
    expect(period("2026-07-01", "2026-12-31", "2026-06-01").elapsedFraction).toBe(0);
  });

  it("counts a leap day", () => {
    // 2028 is a leap year: February has 29 days, so the term is one longer than
    // the same span in 2027 would be.
    expect(period("2028-02-01", "2028-03-01", "2028-02-01").totalDays).toBe(30);
    expect(period("2027-02-01", "2027-03-01", "2027-02-01").totalDays).toBe(29);
  });

  it("crosses a daylight-saving boundary without losing a day", () => {
    // Europe/London springs forward on 29 March 2026. Computed with local-time
    // Date arithmetic, a 23-hour day rounds a day out of the answer; in UTC day
    // numbers it cannot.
    expect(period("2026-03-01", "2026-04-30", "2026-03-01").totalDays).toBe(61);
  });
});

describe("todayIso", () => {
  it("formats a local date without shifting it into another day", () => {
    // Late evening: a UTC-based formatter would already be on the next day for
    // anyone east of Greenwich, and the day count would be off by one for them.
    expect(todayIso(new Date(2026, 5, 15, 23, 30))).toBe("2026-06-15");
    expect(todayIso(new Date(2026, 0, 1, 0, 15))).toBe("2026-01-01");
  });
});

describe("setTenantContractSchema", () => {
  it("accepts a well-formed period, and either date cleared", () => {
    expect(
      setTenantContractSchema.safeParse({ startDate: "2026-01-01", endDate: "2026-12-31" }).success
    ).toBe(true);
    expect(setTenantContractSchema.safeParse({ startDate: null, endDate: null }).success).toBe(true);
    expect(
      setTenantContractSchema.safeParse({ startDate: "2026-01-01", endDate: null }).success
    ).toBe(true);
  });

  it("refuses an end before its start", () => {
    const result = setTenantContractSchema.safeParse({
      startDate: "2026-12-31",
      endDate: "2026-01-01"
    });
    expect(result.success).toBe(false);
  });

  it("accepts equal dates — a one-day term is a real thing", () => {
    expect(
      setTenantContractSchema.safeParse({ startDate: "2026-06-15", endDate: "2026-06-15" }).success
    ).toBe(true);
  });

  it("refuses anything that is not a calendar date", () => {
    // The ordering comparison is lexicographic, which is only date comparison
    // for this exact format — so the format is enforced rather than assumed.
    for (const bad of ["2026-6-15", "15/06/2026", "2026-06-15T00:00:00Z", "yesterday", ""]) {
      expect(
        setTenantContractSchema.safeParse({ startDate: bad, endDate: null }).success,
        `expected "${bad}" to be refused`
      ).toBe(false);
    }
  });

  it("refuses fields the contract does not declare", () => {
    expect(
      setTenantContractSchema.safeParse({
        startDate: null,
        endDate: null,
        renewsAutomatically: true
      }).success
    ).toBe(false);
  });
});

/**
 * How a remaining day count is broken into readable units.
 *
 * The unit is chosen for the reader, not for arithmetic convenience: a week and
 * a bit is a span somebody can plan against, and forty-three weeks is not.
 */
describe("describeDuration", () => {
  it("gives 1 week and 3 days for ten days", () => {
    // The case this was asked for.
    expect(describeDuration(10)).toEqual({ kind: "weeksAndDays", weeks: 1, days: 3 });
  });

  it("stays in days below a week", () => {
    expect(describeDuration(1)).toEqual({ kind: "days", days: 1 });
    expect(describeDuration(6)).toEqual({ kind: "days", days: 6 });
  });

  it("says whole weeks without a trailing zero days", () => {
    // "2 weeks", never "2 weeks and 0 days".
    expect(describeDuration(7)).toEqual({ kind: "weeks", weeks: 1 });
    expect(describeDuration(14)).toEqual({ kind: "weeks", weeks: 2 });
    expect(describeDuration(56)).toEqual({ kind: "weeks", weeks: 8 });
  });

  it("returns to plain days past the readability threshold", () => {
    // 43 weeks and 2 days is arithmetic nobody asked for.
    expect(describeDuration(MAX_DAYS_SHOWN_AS_WEEKS + 1)).toEqual({
      kind: "days",
      days: MAX_DAYS_SHOWN_AS_WEEKS + 1
    });
    expect(describeDuration(303)).toEqual({ kind: "days", days: 303 });
  });

  it("passes zero and negative counts through unchanged", () => {
    // It formats a magnitude; deciding what a magnitude means is the caller's.
    expect(describeDuration(0)).toEqual({ kind: "days", days: 0 });
    expect(describeDuration(-3)).toEqual({ kind: "days", days: -3 });
  });

  it("composes with daysSinceExpiry for a lapsed term", () => {
    // Ten days past the end reads the same way as ten days before it.
    const expired = resolveContractPeriod("2026-01-01", "2026-06-15", "2026-06-25");
    expect(describeDuration(daysSinceExpiry(expired))).toEqual({
      kind: "weeksAndDays",
      weeks: 1,
      days: 3
    });
  });

  it("reads a term with ten days left as a week and three days", () => {
    // End to end from the dates: 10 days remaining, inclusive of the end date.
    const period = resolveContractPeriod("2026-01-01", "2026-06-24", "2026-06-15");
    expect(period.daysRemaining).toBe(10);
    expect(period.state).toBe("expiring");
    expect(describeDuration(period.daysRemaining!)).toEqual({
      kind: "weeksAndDays",
      weeks: 1,
      days: 3
    });
  });
});
