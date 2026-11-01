import { describe, expect, it } from "vitest";

import {
  sumDailySpending,
  sumSpendingByCategory,
  sumSpendingByMerchant,
  windowDays,
} from "@/lib/overview";
import type {
  CategorySpendInput,
  MerchantSpendingInput,
  SpendingInput,
} from "@/lib/overview";
import { simulateBrowserWithPolyfilledTemporal } from "@/test/polyfilled-temporal";

const TODAY = Temporal.PlainDate.from("2026-08-19");

const at = (year: number, monthIndex: number, day: number): string =>
  `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}T12:00:00`;

const receipt = (overrides: Partial<SpendingInput> = {}): SpendingInput => ({
  total: 10,
  transactionDateTime: at(2026, 7, 1),
  ...overrides,
});

const merchantReceipt = (
  overrides: Partial<MerchantSpendingInput> = {}
): MerchantSpendingInput => ({
  merchantName: "Woolworths",
  total: 10,
  transactionDateTime: at(2026, 7, 1),
  ...overrides,
});

const dayKey = (value: string): string => value.slice(0, 10);

const totalFor = (
  result: ReturnType<typeof sumDailySpending>,
  label: string
): number => result.find((entry) => entry.label === label)?.total ?? -1;

describe(windowDays, () => {
  it("counts the inclusive window of trailing months", () => {
    expect(windowDays(TODAY, 2)).toBe(62);
    expect(windowDays(TODAY, 3)).toBe(93);
  });
});

describe(sumDailySpending, () => {
  it("returns one bucket per day covering the requested number of days", () => {
    const result = sumDailySpending([], 30, TODAY);

    expect(result).toHaveLength(30);
    expect(result[0]?.label).toBe(TODAY.subtract({ days: 29 }).toString());
    expect(result[29]?.label).toBe(TODAY.toString());
  });

  it("returns daily buckets across a month window", () => {
    const twoMonths = sumDailySpending([], windowDays(TODAY, 2), TODAY);

    expect(twoMonths).toHaveLength(62);
    expect(twoMonths[0]?.label).toBe("2026-06-19");
    expect(twoMonths[61]?.label).toBe(TODAY.toString());

    const threeMonths = sumDailySpending([], windowDays(TODAY, 3), TODAY);

    expect(threeMonths).toHaveLength(93);
    expect(threeMonths[0]?.label).toBe("2026-05-19");
  });

  it("sums totals of receipts into their transaction day", () => {
    const result = sumDailySpending(
      [
        receipt({ total: 12.34, transactionDateTime: at(2026, 7, 3) }),
        receipt({ total: 20, transactionDateTime: at(2026, 7, 3) }),
        receipt({ total: 5, transactionDateTime: at(2026, 7, 1) }),
      ],
      30,
      TODAY
    );

    expect(totalFor(result, dayKey(at(2026, 7, 3)))).toBe(32.34);
    expect(totalFor(result, dayKey(at(2026, 7, 1)))).toBe(5);
  });

  it("skips receipts without a total or transaction datetime", () => {
    const result = sumDailySpending(
      [receipt({ total: null }), receipt({ transactionDateTime: null })],
      30,
      TODAY
    );

    expect(result.every((entry) => entry.total === 0)).toBeTruthy();
  });

  it("ignores receipts outside the day window", () => {
    const result = sumDailySpending(
      [
        receipt({ transactionDateTime: at(2026, 6, 20) }),
        receipt({ transactionDateTime: at(2026, 8, 1) }),
      ],
      30,
      TODAY
    );

    expect(result.every((entry) => entry.total === 0)).toBeTruthy();
  });

  it("rounds totals to cents", () => {
    const result = sumDailySpending(
      [
        receipt({ total: 0.1, transactionDateTime: at(2026, 7, 1) }),
        receipt({ total: 0.2, transactionDateTime: at(2026, 7, 1) }),
      ],
      30,
      TODAY
    );

    expect(totalFor(result, dayKey(at(2026, 7, 1)))).toBe(0.3);
  });
});

describe(sumSpendingByMerchant, () => {
  it("sums totals per merchant and sorts descending", () => {
    const result = sumSpendingByMerchant([
      merchantReceipt({ merchantName: "Coles", total: 5 }),
      merchantReceipt({ merchantName: "Woolworths" }),
      merchantReceipt({ merchantName: "Coles", total: 30 }),
    ]);

    expect(result).toStrictEqual([
      { label: "Coles", total: 35 },
      { label: "Woolworths", total: 10 },
    ]);
  });

  it("skips receipts without a total or merchant name", () => {
    const result = sumSpendingByMerchant([
      merchantReceipt({ total: null }),
      merchantReceipt({ merchantName: null }),
    ]);

    expect(result).toStrictEqual([]);
  });

  it("rounds totals to cents", () => {
    const result = sumSpendingByMerchant([
      merchantReceipt({ merchantName: "Coles", total: 0.1 }),
      merchantReceipt({ merchantName: "Coles", total: 0.2 }),
    ]);

    expect(result).toStrictEqual([{ label: "Coles", total: 0.3 }]);
  });
});

const row = (
  overrides: Partial<CategorySpendInput> = {}
): CategorySpendInput => ({
  categoryName: "Groceries",
  date: TODAY.subtract({ days: 1 }).toString(),
  total: 10,
  ...overrides,
});

describe(sumSpendingByCategory, () => {
  it("sums totals per category within the window and sorts descending", () => {
    const result = sumSpendingByCategory(
      [
        row({ categoryName: "Groceries", total: 5 }),
        row({ categoryName: "Dining & Takeaway", total: 30 }),
        row({ categoryName: "Groceries", total: 12.5 }),
      ],
      30,
      TODAY
    );

    expect(result).toStrictEqual([
      { label: "Dining & Takeaway", total: 30 },
      { label: "Groceries", total: 17.5 },
    ]);
  });

  it("ignores rows outside the day window", () => {
    const result = sumSpendingByCategory(
      [
        row({ date: TODAY.subtract({ days: 40 }).toString(), total: 99 }),
        row({ date: TODAY.add({ days: 1 }).toString(), total: 50 }),
        row({ date: TODAY.toString(), total: 7 }),
      ],
      30,
      TODAY
    );

    expect(result).toStrictEqual([{ label: "Groceries", total: 7 }]);
  });

  it("rounds totals to cents", () => {
    const result = sumSpendingByCategory(
      [row({ total: 0.1 }), row({ total: 0.2 })],
      30,
      TODAY
    );

    expect(result).toStrictEqual([{ label: "Groceries", total: 0.3 }]);
  });
});

describe("with only the polyfill installed (older browsers)", () => {
  simulateBrowserWithPolyfilledTemporal();

  it("computes spending windows and buckets", () => {
    expect(windowDays(TODAY, 2)).toBe(62);

    const result = sumDailySpending(
      [receipt({ total: 12.34, transactionDateTime: at(2026, 7, 3) })],
      30,
      TODAY
    );

    expect(totalFor(result, dayKey(at(2026, 7, 3)))).toBe(12.34);
  });
});
