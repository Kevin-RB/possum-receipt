import { describe, expect, it } from "vitest";

import {
  DEFAULT_TIMEZONE,
  isTimezone,
  resolveToday,
  resolveTimezone,
  weekdayOf,
} from "@/lib/time";

/** The calendar date at an instant in a zone, read independently of the app. */
const isoDayIn = (instant: number, timezone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).format(new Date(instant));

/**
 * "What day is it now" is a property of the viewer's clock, so the answer is
 * a chain rather than a constant: the zone the edge reported, then the zone
 * the account was created in, then the fallback for work with no viewer behind
 * it. These pin the chain and the fact that a bad value never throws.
 */

describe(resolveTimezone, () => {
  it("takes the first candidate that names a real zone", () => {
    expect(resolveTimezone("America/Bogota", "Asia/Tokyo")).toBe(
      "America/Bogota"
    );
  });

  it("skips absent candidates and moves to the next one", () => {
    expect(resolveTimezone(undefined, null, "", "Asia/Tokyo")).toBe(
      "Asia/Tokyo"
    );
  });

  it("skips a candidate that is not a zone name", () => {
    // The value crossed a boundary the app does not own — a cookie, a request
    // body — so it is validated rather than trusted.
    expect(resolveTimezone("Not/AZone", "Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(resolveTimezone("Australia", "Mars/Olympus")).toBe(DEFAULT_TIMEZONE);
  });

  it("falls back to the constant when nothing names a zone", () => {
    expect(resolveTimezone()).toBe(DEFAULT_TIMEZONE);
    expect(resolveTimezone(undefined, null, "")).toBe(DEFAULT_TIMEZONE);
    expect(resolveTimezone("Not/AZone")).toBe(DEFAULT_TIMEZONE);
  });
});

describe(resolveToday, () => {
  it("answers the date that zone is on, whatever the runtime's own zone", () => {
    const instant = Date.now();

    for (const zone of [
      "America/Bogota",
      "Pacific/Kiritimati",
      "Pacific/Midway",
    ]) {
      expect(resolveToday(zone).toString()).toBe(isoDayIn(instant, zone));
    }
  });

  it("answers a different day on either side of the date line", () => {
    // UTC+14 and UTC-11 are 25 hours apart, so they can never agree on the
    // date: at any instant one of them is reading a different day.
    expect(resolveToday("Pacific/Kiritimati").toString()).not.toBe(
      resolveToday("Pacific/Midway").toString()
    );
  });

  it("never throws on an invalid zone", () => {
    expect(() => resolveToday("Not/AZone")).not.toThrow();
    expect(resolveToday("Not/AZone").toString()).toBe(
      isoDayIn(Date.now(), DEFAULT_TIMEZONE)
    );
  });
});

describe(weekdayOf, () => {
  /**
   * The prompt states the weekday because a model asked to work it out from an
   * ISO date gets it wrong: with only the date, the local model answered
   * "Thursday, November 1, 2026" two runs in three, and copied the weekday out
   * of the prompt's own format example. Stating it left 6 of 6 correct.
   */
  it("names the weekday of a plain date, whatever the runtime's zone", () => {
    expect(weekdayOf(Temporal.PlainDate.from("2026-11-01"))).toBe("Sunday");
    expect(weekdayOf(Temporal.PlainDate.from("2026-10-07"))).toBe("Wednesday");
  });

  it("does not shift the day for a runtime west of UTC", () => {
    // The carrier is a `Date` at UTC holding the plain date's components, so a
    // runtime whose own midnight falls earlier cannot read back the day before.
    expect(weekdayOf(Temporal.PlainDate.from("2026-01-01"))).toBe("Thursday");
  });
});

describe(isTimezone, () => {
  it("accepts a zone name and rejects everything else", () => {
    expect(isTimezone("America/Bogota")).toBeTruthy();
    expect(isTimezone("")).toBeFalsy();
    expect(isTimezone("Not/AZone")).toBeFalsy();
    expect(isTimezone(42)).toBeFalsy();
  });
});
