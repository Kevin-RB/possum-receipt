import { describe, expect, it } from "vitest";

import { calendarBounds } from "@/components/receipts/table";
import { simulateBrowserWithPolyfilledTemporal } from "@/test/polyfilled-temporal";

const parts = (day: Date) =>
  [day.getFullYear(), day.getMonth(), day.getDate()] as const;

/**
 * The receipts page's date filter is bounded by the viewer's day: it cannot
 * offer to filter on a day that has not started for them, and it opens on the
 * month they are most likely to want. The day is resolved on the server and
 * passed in, so both halves are plain arithmetic here.
 */
describe(calendarBounds, () => {
  simulateBrowserWithPolyfilledTemporal();

  it("bounds the filter on the day it was given", () => {
    const { latestDay } = calendarBounds("2026-10-07");

    expect(parts(latestDay)).toStrictEqual([2026, 9, 7]);
    expect(latestDay.getHours()).toBe(0);
  });

  it("opens on the first of the previous month", () => {
    expect(
      parts(calendarBounds("2026-10-07").previousMonthStart)
    ).toStrictEqual([2026, 8, 1]);
  });

  it("crosses the year boundary backwards", () => {
    expect(
      parts(calendarBounds("2026-01-15").previousMonthStart)
    ).toStrictEqual([2025, 11, 1]);
  });
});
