import type { ReceiptSelect } from "@/lib/db/schema/receipt";
import { wallClockToISODate } from "@/lib/receipt/datetime";
import "temporal-polyfill/global";

export type SpendingInput = Pick<
  ReceiptSelect,
  "total" | "transactionDateTime"
>;

export type MerchantSpendingInput = Pick<
  ReceiptSelect,
  "total" | "transactionDateTime" | "merchantName"
>;

export type IntegrityInput = Pick<ReceiptSelect, "hasIntegrityWarning">;

export interface SpendingBucket {
  label: string;
  total: number;
}

const roundToCents = (value: number): number => Math.round(value * 100) / 100;

export const windowDays = (today: Temporal.PlainDate, months: number): number =>
  today.since(today.subtract({ months })).days + 1;

export const sumDailySpending = (
  receipts: SpendingInput[],
  days: number,
  today = Temporal.Now.plainDateISO()
): SpendingBucket[] => {
  const totals = new Map<string, number>();

  for (const receipt of receipts) {
    if (receipt.total === null || receipt.transactionDateTime === null) {
      continue;
    }
    // The stored value is the receipt's own wall clock, so the day is its date
    // part. Converting an instant in the browser's zone is what used to put a
    // 07:00 purchase on the previous day for anyone west of Brisbane.
    const key = wallClockToISODate(receipt.transactionDateTime);
    totals.set(key, (totals.get(key) ?? 0) + receipt.total);
  }

  const start = today.subtract({ days: days - 1 });
  const range: string[] = [];
  for (
    let day = start;
    Temporal.PlainDate.compare(day, today) <= 0;
    day = day.add({ days: 1 })
  ) {
    range.push(day.toString());
  }

  return range.map((key) => ({
    label: key,
    total: roundToCents(totals.get(key) ?? 0),
  }));
};

export const sumSpendingByMerchant = (
  receipts: MerchantSpendingInput[]
): SpendingBucket[] => {
  const totals = new Map<string, number>();

  for (const receipt of receipts) {
    if (receipt.total === null || receipt.merchantName === null) {
      continue;
    }
    totals.set(
      receipt.merchantName,
      (totals.get(receipt.merchantName) ?? 0) + receipt.total
    );
  }

  return [...totals.entries()]
    .map(([label, total]) => ({ label, total: roundToCents(total) }))
    .toSorted((a, b) => b.total - a.total);
};

export interface CategorySpendInput {
  categoryName: string;
  date: string;
  total: number;
}

export const sumSpendingByCategory = (
  rows: CategorySpendInput[],
  days: number,
  today = Temporal.Now.plainDateISO()
): SpendingBucket[] => {
  const start = today.subtract({ days: days - 1 });
  const totals = new Map<string, number>();

  for (const row of rows) {
    const date = Temporal.PlainDate.from(row.date);
    if (Temporal.PlainDate.compare(date, start) < 0) {
      continue;
    }
    if (Temporal.PlainDate.compare(date, today) > 0) {
      continue;
    }
    totals.set(
      row.categoryName,
      (totals.get(row.categoryName) ?? 0) + row.total
    );
  }

  return [...totals.entries()]
    .map(([label, total]) => ({ label, total: roundToCents(total) }))
    .toSorted((a, b) => b.total - a.total);
};
