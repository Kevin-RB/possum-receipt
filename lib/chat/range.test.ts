import { describe, expect, it } from "vitest";

import { resolvePeriod, resolveRange } from "./range";

/**
 * The whole point of moving the arithmetic server-side is that it can be
 * tested: `resolveRange` is pure, so every boundary below is pinned rather than
 * described. The model only ever supplies the name.
 */

const day = (isoDate: string): Temporal.PlainDate =>
  Temporal.PlainDate.from(isoDate);

/** 2026-11-04 is a Wednesday, so the week has days behind it and ahead of it. */
const WEDNESDAY = day("2026-11-04");

describe(resolveRange, () => {
  it("resolves today and yesterday to single days", () => {
    expect(resolveRange("today", WEDNESDAY)).toStrictEqual({
      from: "2026-11-04",
      to: "2026-11-04",
    });
    expect(resolveRange("yesterday", WEDNESDAY)).toStrictEqual({
      from: "2026-11-03",
      to: "2026-11-03",
    });
  });

  it("resolves the weeks from Monday, this week ending today", () => {
    expect(resolveRange("this_week", WEDNESDAY)).toStrictEqual({
      from: "2026-11-02",
      to: "2026-11-04",
    });
    expect(resolveRange("last_week", WEDNESDAY)).toStrictEqual({
      from: "2026-10-26",
      to: "2026-11-01",
    });
  });

  it("resolves the months, this month ending today", () => {
    expect(resolveRange("this_month", WEDNESDAY)).toStrictEqual({
      from: "2026-11-01",
      to: "2026-11-04",
    });
    expect(resolveRange("last_month", WEDNESDAY)).toStrictEqual({
      from: "2026-10-01",
      to: "2026-10-31",
    });
  });

  it("resolves this year from January, ending today", () => {
    expect(resolveRange("this_year", WEDNESDAY)).toStrictEqual({
      from: "2026-01-01",
      to: "2026-11-04",
    });
  });

  it("leaves all_time open at both ends", () => {
    expect(resolveRange("all_time", WEDNESDAY)).toStrictEqual({});
  });

  it("ends last_month on a short month's final day", () => {
    const today = day("2026-03-31");

    expect(resolveRange("last_month", today)).toStrictEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(resolveRange("this_month", today)).toStrictEqual({
      from: "2026-03-01",
      to: "2026-03-31",
    });
  });

  it("ends last_month on 29 February in a leap year", () => {
    expect(resolveRange("last_month", day("2028-03-15"))).toStrictEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
  });

  it("walks back across a year boundary", () => {
    const today = day("2027-01-01");

    expect(resolveRange("last_month", today)).toStrictEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
    expect(resolveRange("yesterday", today)).toStrictEqual({
      from: "2026-12-31",
      to: "2026-12-31",
    });
  });

  it("starts this_week on Monday and last_week seven days earlier, for every weekday", () => {
    // Monday 2026-11-02 through Sunday 2026-11-08. A viewer asking on the Monday
    // must not get an empty week, and one asking on the Sunday must not have the
    // week run past today.
    const monday = day("2026-11-02");
    const weekdays = Array.from({ length: 7 }, (_, offset) =>
      monday.add({ days: offset })
    );

    expect(weekdays.map((today) => today.dayOfWeek)).toStrictEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(
      weekdays.map((today) => resolveRange("this_week", today))
    ).toStrictEqual(
      weekdays.map((today) => ({
        from: "2026-11-02",
        to: today.toString(),
      }))
    );
    expect(
      weekdays.map((today) => resolveRange("last_week", today))
    ).toStrictEqual(
      Array.from({ length: 7 }, () => ({
        from: "2026-10-26",
        to: "2026-11-01",
      }))
    );
  });
});

describe(resolvePeriod, () => {
  const today = WEDNESDAY;

  it("resolves a named range", () => {
    expect(resolvePeriod({ range: "last_month" }, today)).toStrictEqual({
      from: "2026-10-01",
      to: "2026-10-31",
    });
  });

  it("prefers the named range over explicit dates", () => {
    expect(
      resolvePeriod(
        { from: "2026-01-01", range: "today", to: "2026-01-31" },
        today
      )
    ).toStrictEqual({ from: "2026-11-04", to: "2026-11-04" });
  });

  it("keeps explicit dates when the enum cannot express them", () => {
    expect(
      resolvePeriod({ from: "2026-03-03", to: "2026-03-09" }, today)
    ).toStrictEqual({ from: "2026-03-03", to: "2026-03-09" });
  });

  it("keeps a single explicit bound", () => {
    expect(resolvePeriod({ from: "2026-03-03" }, today)).toStrictEqual({
      from: "2026-03-03",
      to: undefined,
    });
  });

  it("treats no period at all as all time", () => {
    expect(resolvePeriod({}, today)).toStrictEqual({});
  });
});
