import "temporal-polyfill/global";
import type { CategorySelect } from "@/lib/db/schema/category";
import type { ReceiptSelect } from "@/lib/db/schema/receipt";
import type { ReceiptItemSelect } from "@/lib/db/schema/receipt-item";
import { wallClockToISODate } from "@/lib/receipt/datetime";

/**
 * A receipt as the overview sees it: the total it contributes, the day it
 * belongs to, and the line items it is composed of.
 *
 * The row type the page loads, not a narrowed projection: every chart
 * aggregates from this array and the drill-down filters the same one, so a bar
 * and the panel beneath it cannot disagree about what the bar was summed from.
 * Fields come from the tables themselves, so the schema stays their single
 * source of truth.
 */
export type OverviewReceipt = Pick<
  ReceiptSelect,
  | "hasIntegrityWarning"
  | "id"
  | "merchantName"
  | "total"
  | "transactionDateTime"
> & { items: OverviewItem[] };

/** A line item as the overview sees it: the money it contributes and its category. */
export type OverviewItem = Pick<
  ReceiptItemSelect,
  "id" | "kind" | "lineTotal" | "name"
> & {
  categoryName: CategorySelect["name"] | null;
  categorySlug: CategorySelect["slug"] | null;
};

/**
 * A receipt a chart can count: it printed both a total and a day.
 *
 * One predicate, applied once in `scopeReceipts`, is what keeps a drill-down
 * listing exactly the rows a bar was summed from — a receipt with no total
 * contributed nothing, so it belongs to neither.
 */
export type CountedReceipt = OverviewReceipt & {
  total: number;
  transactionDateTime: string;
};

const isCounted = (receipt: OverviewReceipt): receipt is CountedReceipt =>
  receipt.total !== null && receipt.transactionDateTime !== null;

/** The receipt's spending day — the date part of its own wall clock, never a
 * conversion into another zone. */
const spentOn = (receipt: CountedReceipt): string =>
  wallClockToISODate(receipt.transactionDateTime);

export type RangeKey = "30-days" | "2-months" | "3-months" | "12-months";

/** What one bar of a range stands for: a single day, or a whole calendar month. */
export type RangeGrain = "day" | "month";

interface RangeSpec {
  grain: RangeGrain;
  label: string;
  /** How far back from today the window begins. */
  span: { days: number } | { months: number };
}

// Twelve calendar months — eleven back plus the current, partial one — which
// is why the window starts on the first of the month rather than on today's day
// number. A month bucket is then exactly that calendar month. `RANGE_ORDER`
// holds the order the menu lists them in.
const RANGES: Record<RangeKey, RangeSpec> = {
  "12-months": { grain: "month", label: "12 months", span: { months: 11 } },
  "2-months": { grain: "day", label: "2 months", span: { months: 2 } },
  "3-months": { grain: "day", label: "3 months", span: { months: 3 } },
  "30-days": { grain: "day", label: "30 days", span: { days: 30 } },
};

export const RANGE_ORDER: RangeKey[] = [
  "30-days",
  "2-months",
  "3-months",
  "12-months",
];

export const rangeLabel = (range: RangeKey): string => RANGES[range].label;

export const rangeGrain = (range: RangeKey): RangeGrain => RANGES[range].grain;

/** The period selector's items, in the order the menu lists them. */
export const RANGE_ITEMS = RANGE_ORDER.map((range) => ({
  label: rangeLabel(range),
  value: range,
}));

export interface Window {
  /** The viewer's today, inclusive. */
  end: Temporal.PlainDate;
  /** The first day the range covers, inclusive. */
  start: Temporal.PlainDate;
}

export const rangeWindow = (
  range: RangeKey,
  today: Temporal.PlainDate
): Window => {
  const { grain, span } = RANGES[range];
  const start =
    "days" in span
      ? today.subtract({ days: span.days - 1 })
      : today.subtract({ months: span.months });

  // A monthly chart starts on the first of its earliest month, so no bar is a
  // trailing slice of one.
  return {
    end: today,
    start: grain === "month" ? start.with({ day: 1 }) : start,
  };
};

export interface OverviewScope {
  /** The range that produced the window. */
  range: RangeKey;
  /** The widest window any chart can ask for — the page's one query bound. */
  window: Window;
}

/**
 * What the page loads, and what to call it.
 *
 * Derived from the ranges rather than written down again, so adding a longer
 * range cannot leave the query loading less than a chart needs — and so a card
 * with no period selector (the integrity gauge) can say what it covers without
 * spelling out a second, independent bound.
 */
export const overviewScope = (today: Temporal.PlainDate): OverviewScope => {
  let widest: OverviewScope = {
    range: RANGE_ORDER[0],
    window: rangeWindow(RANGE_ORDER[0], today),
  };

  for (const range of RANGE_ORDER) {
    const window = rangeWindow(range, today);
    if (Temporal.PlainDate.compare(window.start, widest.window.start) < 0) {
      widest = { range, window };
    }
  }

  return widest;
};

const roundToCents = (value: number): number => Math.round(value * 100) / 100;

const add = (totals: Map<string, number>, key: string, amount: number) => {
  totals.set(key, (totals.get(key) ?? 0) + amount);
};

/**
 * The corpus narrowed to a range — and to the receipts a chart can count.
 *
 * Every chart and every drill-down starts from this one filter, so "the panel
 * sums to the bar" holds by construction rather than by two implementations
 * agreeing.
 */
export const scopeReceipts = (
  receipts: OverviewReceipt[],
  window: Window
): CountedReceipt[] =>
  receipts.filter((receipt): receipt is CountedReceipt => {
    if (!isCounted(receipt)) {
      return false;
    }
    const date = Temporal.PlainDate.from(spentOn(receipt));
    return (
      Temporal.PlainDate.compare(date, window.start) >= 0 &&
      Temporal.PlainDate.compare(date, window.end) <= 0
    );
  });

/**
 * A chart datum treated as a query over the underlying rows.
 *
 * Every chart's datum carries the bucket it represents, so clicking a bar is
 * only ever "resolve this bucket" — the chart never re-derives membership.
 */
export type Bucket =
  | { kind: "day"; date: string }
  | { kind: "month"; month: string }
  | { kind: "merchant"; merchant: string }
  | { kind: "other-merchants" }
  | { kind: "category"; slug: string }
  | { kind: "integrity" };

/** One resolved row behind a receipt-level bucket. */
export interface ReceiptRow {
  /** The receipt's spending day, `YYYY-MM-DD`. */
  date: string;
  id: string;
  merchantName: string | null;
  total: number;
}

export interface ItemRow {
  id: string;
  lineTotal: number;
  name: string;
}

/** A receipt's line items of one category, grouped so the rows keep a date and a link target. */
export interface ItemGroup {
  items: ItemRow[];
  receipt: ReceiptRow;
}

export type Drilldown =
  | { kind: "receipts"; rows: ReceiptRow[] }
  | { kind: "items"; groups: ItemGroup[] };

/** A chart datum: the bucket it stands for, the text it draws, and its total. */
export interface ChartDatum {
  bucket: Bucket;
  label: string;
  total: number;
}

/** One bar per day in the window, including the days with no spending. */
export const dailySpending = (
  receipts: OverviewReceipt[],
  window: Window
): ChartDatum[] => {
  const totals = new Map<string, number>();

  for (const receipt of scopeReceipts(receipts, window)) {
    add(totals, spentOn(receipt), receipt.total);
  }

  const data: ChartDatum[] = [];
  for (
    let day = window.start;
    Temporal.PlainDate.compare(day, window.end) <= 0;
    day = day.add({ days: 1 })
  ) {
    const date = day.toString();
    data.push({
      bucket: { date, kind: "day" },
      label: date,
      total: roundToCents(totals.get(date) ?? 0),
    });
  }

  return data;
};

/** One bar per calendar month in the window; the current month is partial to today. */
export const monthlySpending = (
  receipts: OverviewReceipt[],
  window: Window
): ChartDatum[] => {
  const totals = new Map<string, number>();

  for (const receipt of scopeReceipts(receipts, window)) {
    add(totals, spentOn(receipt).slice(0, "YYYY-MM".length), receipt.total);
  }

  const last = window.end.toPlainYearMonth();
  const data: ChartDatum[] = [];
  for (
    let month = window.start.toPlainYearMonth();
    Temporal.PlainYearMonth.compare(month, last) <= 0;
    month = month.add({ months: 1 })
  ) {
    const key = month.toString();
    data.push({
      bucket: { kind: "month", month: key },
      label: key,
      total: roundToCents(totals.get(key) ?? 0),
    });
  }

  return data;
};

/** The spending chart's bars for a range: daily, or monthly for the 12-month range. */
export const spendingByRange = (
  receipts: OverviewReceipt[],
  range: RangeKey,
  today: Temporal.PlainDate
): ChartDatum[] => {
  const window = rangeWindow(range, today);
  return rangeGrain(range) === "month"
    ? monthlySpending(receipts, window)
    : dailySpending(receipts, window);
};

export const UNCATEGORISED_SLUG = "uncategorised";
export const UNCATEGORISED_LABEL = "Uncategorised";

const categorySlugOf = (item: OverviewItem): string =>
  item.categorySlug ?? UNCATEGORISED_SLUG;

/**
 * The product line items of a receipt.
 *
 * A category bar sums only these, so a drill-down that included a discount or
 * a surcharge would list rows the bar never counted.
 */
const productItems = (receipt: OverviewReceipt): OverviewItem[] =>
  receipt.items.filter((item) => item.kind === "product");

/** One bar per category with product spending in the window, largest first. */
export const categorySpending = (
  receipts: OverviewReceipt[],
  window: Window
): ChartDatum[] => {
  const totals = new Map<string, { label: string; total: number }>();

  for (const receipt of scopeReceipts(receipts, window)) {
    for (const item of productItems(receipt)) {
      const slug = categorySlugOf(item);
      const entry = totals.get(slug) ?? {
        label: item.categoryName ?? UNCATEGORISED_LABEL,
        total: 0,
      };
      entry.total += item.lineTotal;
      totals.set(slug, entry);
    }
  }

  const data: ChartDatum[] = [...totals.entries()].map(
    ([slug, { label, total }]) => ({
      bucket: { kind: "category", slug },
      label,
      total: roundToCents(total),
    })
  );

  return data.toSorted((a, b) => b.total - a.total);
};

/** How many merchant slices the pie draws before folding the rest into "Other". */
export const TOP_MERCHANTS = 5;

export const OTHER_MERCHANTS_LABEL = "Other";

/**
 * The merchants the pie draws a slice for, largest first.
 *
 * The same function decides the slices and the complement "Other" stands for,
 * so the six sectors always partition the window's spending.
 */
export const topMerchantNames = (receipts: CountedReceipt[]): string[] => {
  const totals = new Map<string, number>();

  for (const receipt of receipts) {
    if (receipt.merchantName === null) {
      continue;
    }
    add(totals, receipt.merchantName, receipt.total);
  }

  return [...totals.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, TOP_MERCHANTS)
    .map(([merchant]) => merchant);
};

/** The top five merchants plus one folded "Other" slice, largest first. */
export const merchantSpending = (
  receipts: OverviewReceipt[],
  window: Window
): ChartDatum[] => {
  const scoped = scopeReceipts(receipts, window);
  const top = topMerchantNames(scoped);
  const drawn = new Set(top);
  const totals = new Map<string, number>();
  let other = 0;
  let folded = false;

  for (const receipt of scoped) {
    if (receipt.merchantName === null) {
      continue;
    }
    if (drawn.has(receipt.merchantName)) {
      add(totals, receipt.merchantName, receipt.total);
    } else {
      other += receipt.total;
      folded = true;
    }
  }

  const data: ChartDatum[] = top.map((merchant) => ({
    bucket: { kind: "merchant", merchant },
    label: merchant,
    total: roundToCents(totals.get(merchant) ?? 0),
  }));

  if (folded) {
    data.push({
      bucket: { kind: "other-merchants" },
      label: OTHER_MERCHANTS_LABEL,
      total: roundToCents(other),
    });
  }

  return data;
};

export interface IntegritySummary {
  /** The gauge's datum: flagged receipts and what they add up to. */
  datum: ChartDatum;
  /** The receipts the gauge counts — and the ones its disclosure lists. */
  flagged: CountedReceipt[];
  /** Every counted receipt, for the "N of M" denominator. */
  total: number;
}

/**
 * The integrity gauge's numbers.
 *
 * The card has no period selector, so its scope is the whole loaded corpus;
 * the count, the datum and the receipt list behind it all come from this one
 * call, so "N of M flagged" and the disclosure cannot disagree.
 */
export const integritySummary = (
  receipts: OverviewReceipt[]
): IntegritySummary => {
  const counted = receipts.filter(isCounted);
  const flagged = counted.filter((receipt) => receipt.hasIntegrityWarning);

  return {
    datum: {
      bucket: { kind: "integrity" },
      label: "Flagged",
      total: roundToCents(
        flagged.reduce((sum, receipt) => sum + receipt.total, 0)
      ),
    },
    flagged,
    total: counted.length,
  };
};

const byDayDescending = (a: ReceiptRow, b: ReceiptRow): number =>
  b.date.localeCompare(a.date) ||
  (a.merchantName ?? "").localeCompare(b.merchantName ?? "");

const toReceiptRow = (receipt: CountedReceipt): ReceiptRow => ({
  date: spentOn(receipt),
  id: receipt.id,
  merchantName: receipt.merchantName,
  total: receipt.total,
});

const receiptDrilldown = (receipts: CountedReceipt[]): Drilldown => ({
  kind: "receipts",
  rows: receipts.map(toReceiptRow).toSorted(byDayDescending),
});

const categoryDrilldown = (
  receipts: CountedReceipt[],
  slug: string
): Drilldown => {
  const groups: ItemGroup[] = [];

  for (const receipt of receipts) {
    const items = productItems(receipt)
      .filter((item) => categorySlugOf(item) === slug)
      .map(({ id, lineTotal, name }) => ({ id, lineTotal, name }));

    if (items.length === 0) {
      continue;
    }
    groups.push({ items, receipt: toReceiptRow(receipt) });
  }

  return {
    groups: groups.toSorted((a, b) => byDayDescending(a.receipt, b.receipt)),
    kind: "items",
  };
};

const unhandledBucket = (bucket: never): never => {
  throw new Error(`Unhandled bucket: ${JSON.stringify(bucket)}`);
};

/**
 * The rows a chart datum was summed from, within the corpus it was summed from.
 *
 * Pass the same array the chart aggregated — `scopeReceipts(...)` of its window
 * (or `integritySummary(...).flagged` for the gauge) — and the panel's total is
 * the datum's total. The `never` argument is the other half of the contract: a
 * chart whose bucket is not handled here fails to compile, rather than
 * rendering a panel that shows nothing.
 */
export const resolveBucket = (
  bucket: Bucket,
  receipts: CountedReceipt[]
): Drilldown => {
  switch (bucket.kind) {
    case "day": {
      return receiptDrilldown(
        receipts.filter((receipt) => spentOn(receipt) === bucket.date)
      );
    }
    case "month": {
      return receiptDrilldown(
        receipts.filter((receipt) => spentOn(receipt).startsWith(bucket.month))
      );
    }
    case "merchant": {
      return receiptDrilldown(
        receipts.filter((receipt) => receipt.merchantName === bucket.merchant)
      );
    }
    case "other-merchants": {
      const drawn = new Set(topMerchantNames(receipts));
      return receiptDrilldown(
        receipts.filter(
          (receipt) =>
            receipt.merchantName !== null && !drawn.has(receipt.merchantName)
        )
      );
    }
    case "category": {
      return categoryDrilldown(receipts, bucket.slug);
    }
    case "integrity": {
      return receiptDrilldown(
        receipts.filter((receipt) => receipt.hasIntegrityWarning)
      );
    }
    default: {
      return unhandledBucket(bucket);
    }
  }
};

/** A stable identity for a bucket, for selection and toggling. */
export const bucketKey = (bucket: Bucket): string => {
  switch (bucket.kind) {
    case "day": {
      return `day:${bucket.date}`;
    }
    case "month": {
      return `month:${bucket.month}`;
    }
    case "merchant": {
      return `merchant:${bucket.merchant}`;
    }
    case "other-merchants": {
      return "other-merchants";
    }
    case "category": {
      return `category:${bucket.slug}`;
    }
    case "integrity": {
      return "integrity";
    }
    default: {
      return unhandledBucket(bucket);
    }
  }
};

/**
 * Single selection: clicking the datum that is already open closes it, and any
 * other datum replaces it.
 */
export const toggleBucket = (
  current: Bucket | null,
  next: Bucket
): Bucket | null =>
  current !== null && bucketKey(current) === bucketKey(next) ? null : next;

/** The money the resolved rows add up to — equal to the datum's own total. */
export const drilldownTotal = (drilldown: Drilldown): number =>
  roundToCents(
    drilldown.kind === "receipts"
      ? drilldown.rows.reduce((sum, row) => sum + row.total, 0)
      : drilldown.groups.reduce(
          (sum, group) =>
            sum +
            group.items.reduce(
              (groupSum, item) => groupSum + item.lineTotal,
              0
            ),
          0
        )
  );

/** What the panel counts: receipts for a receipt bucket, line items for a category one. */
export const drilldownCount = (drilldown: Drilldown): number =>
  drilldown.kind === "receipts"
    ? drilldown.rows.length
    : drilldown.groups.reduce((count, group) => count + group.items.length, 0);
