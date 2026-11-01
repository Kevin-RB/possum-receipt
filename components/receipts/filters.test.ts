import { describe, expect, it } from "vitest";

import { dateRangeFilterFn } from "@/components/receipts/filters";
import type { DateRangeFilterValue } from "@/components/receipts/filters";
import { simulateBrowserWithPolyfilledTemporal } from "@/test/polyfilled-temporal";

const filter = (value: unknown, range: DateRangeFilterValue) =>
  dateRangeFilterFn({ getValue: () => value }, "transactionDateTime", range);

describe(dateRangeFilterFn, () => {
  it("keeps all rows when the range is empty", () => {
    expect(filter("2026-08-01 12:00:00", {})).toBeTruthy();
  });

  it("matches on the receipt's printed day", () => {
    // The stored value is the wall clock printed on the receipt.
    const row = "2026-08-01 00:30:00";
    expect(filter(row, { from: new Date("2026-08-01") })).toBeTruthy();
    expect(filter(row, { from: new Date("2026-08-02") })).toBeFalsy();
  });

  it("respects an inclusive to boundary", () => {
    const row = "2026-08-05 16:00:00";
    expect(
      filter(row, { from: new Date("2026-08-01"), to: new Date("2026-08-05") })
    ).toBeTruthy();
    expect(
      filter(row, { from: new Date("2026-08-01"), to: new Date("2026-08-04") })
    ).toBeFalsy();
  });

  it("rejects non-date values", () => {
    expect(filter("not a date", { from: new Date("2026-01-01") })).toBeFalsy();
  });
});

describe("without the Temporal global (older browsers)", () => {
  simulateBrowserWithPolyfilledTemporal();

  it("still filters by date range", () => {
    const row = "2026-08-01 00:30:00";
    expect(filter(row, { from: new Date("2026-08-01") })).toBeTruthy();
    expect(filter(row, { from: new Date("2026-08-02") })).toBeFalsy();
  });
});
