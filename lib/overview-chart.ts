import "temporal-polyfill/global";
import { bucketKey } from "@/lib/overview";
import type { Bucket, ChartDatum } from "@/lib/overview";

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

/**
 * How faint an unselected datum draws while a drill-down is open.
 *
 * Low enough to read as "not the one", high enough that the chart still shows
 * its shape — a 0.35 datum on a near-black card is shadow, not information.
 */
export const DIM_OPACITY = 0.4;

/**
 * How strongly a datum draws: the open one at full strength, the rest stepped
 * back.
 *
 * Nothing moves — the dimming is what keeps the panel's provenance legible
 * once the pointer has left the mark that opened it.
 */
export const datumOpacity = (bucket: Bucket, selected: Bucket | null): number =>
  selected === null || bucketKey(selected) === bucketKey(bucket)
    ? 1
    : DIM_OPACITY;

/** How far a finger must travel sideways before it is aiming, not tapping. */
const SCRUB_SLOP = 10;

/**
 * Whether a touch that started and ended at these points was a deliberate scrub
 * across the chart, rather than a tap or the page scrolling.
 *
 * Only a horizontal drag counts: a tap is left to the click handler (which
 * resolves the datum from the click coordinates), and a vertical drag belongs to
 * the page. Selecting on every `touchend` would open whatever datum the last
 * drag left behind when the reader flicks the overview.
 */
export const isScrubGesture = (start: Point, end: Point): boolean => {
  const dx = Math.abs(end.x - start.x);
  const dy = Math.abs(end.y - start.y);

  return dx >= SCRUB_SLOP && dx > dy;
};

export interface Point {
  x: number;
  y: number;
}

/**
 * The datum a chart's active index points at, or nothing when there is none.
 *
 * Recharts starts its tooltip index at `null` and leaves it alone when a click
 * lands outside the plot, so `Number(index)` cannot be trusted on its own:
 * `Number(null)` is `0`, which would open the first day for a click in the
 * margin.
 */
export const datumAtIndex = (
  data: ChartDatum[],
  index?: number | string | null
): ChartDatum | undefined => {
  if (index === null || index === undefined) {
    return;
  }

  const parsed = Number(index);
  return Number.isInteger(parsed) ? data[parsed] : undefined;
};
