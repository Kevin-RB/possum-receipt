import "temporal-polyfill/global";

/** Money as the overview renders it — one formatter, so every surface agrees. */
export const currencyFormatter = new Intl.NumberFormat("en-AU", {
  currency: "AUD",
  style: "currency",
});

/** The pie's slice colours, cycled in chart order. */
export const PIE_PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

/** A day bucket's axis tick: short enough for a 375px viewport. */
export const formatDayTick = (value: unknown): string =>
  Temporal.PlainDate.from(String(value)).toLocaleString("en-AU", {
    day: "numeric",
    month: "short",
  });

export const formatDayTooltipLabel = (value: unknown): string =>
  Temporal.PlainDate.from(String(value)).toLocaleString("en-AU", {
    day: "numeric",
    month: "short",
    weekday: "short",
  });

/**
 * A month bucket's labels.
 *
 * Parsed as the first of the month rather than as a `Temporal.PlainYearMonth`:
 * `PlainYearMonth#toLocaleString` throws `RangeError: Mismatched calendars` in a
 * browser with native Temporal (it has no day to resolve the locale's calendar
 * against), which took the whole chart down the moment the twelve-month range
 * rendered. A `PlainDate` carries the day it needs.
 */
const monthStart = (value: unknown): Temporal.PlainDate =>
  Temporal.PlainDate.from(`${String(value)}-01`);

/** A month bucket's axis tick: the month only, because the year repeats. */
export const formatMonthTick = (value: unknown): string =>
  monthStart(value).toLocaleString("en-AU", { month: "short" });

export const formatMonthTooltipLabel = (value: unknown): string =>
  monthStart(value).toLocaleString("en-AU", {
    month: "long",
    year: "numeric",
  });

/**
 * A category label short enough to leave the bars room on a phone.
 *
 * The label column is a fixed slice of a narrow chart, so an overlong leaf
 * category is truncated rather than pushing the plot out of the card.
 */
const LABEL_LIMIT = 18;

export const truncateLabel = (value: string): string =>
  value.length <= LABEL_LIMIT ? value : `${value.slice(0, LABEL_LIMIT - 1)}…`;
