"use client";

import "temporal-polyfill/global";
import { useMemo, useState } from "react";

import {
  rangeWindow,
  resolveBucket,
  scopeReceipts,
  toggleBucket,
} from "@/lib/overview";
import type { Bucket, OverviewReceipt, RangeKey } from "@/lib/overview";

/**
 * The state every overview chart shares: a period, the one datum that is open,
 * and the drill-down it resolves to.
 *
 * Lives here so the three charts cannot drift apart on the parts that make
 * them feel like one page — a single selection, a period change closing it, and
 * the panel reading the same windowed corpus the bars were summed from.
 */
export const useChartDrilldown = (
  receipts: OverviewReceipt[],
  today: string
) => {
  const [range, setRange] = useState<RangeKey>("30-days");
  const [selected, setSelected] = useState<Bucket | null>(null);

  const day = useMemo(() => Temporal.PlainDate.from(today), [today]);

  const period = useMemo(() => rangeWindow(range, day), [range, day]);

  // The same array the bars were summed from, so a panel's rows are exactly
  // the receipts behind the bar that opened it.
  const scoped = useMemo(
    () => scopeReceipts(receipts, period),
    [receipts, period]
  );

  const drilldown = useMemo(
    () => (selected === null ? null : resolveBucket(selected, scoped)),
    [selected, scoped]
  );

  return {
    day,
    drilldown,
    period,
    range,
    selected,
    /** Changing the period closes the panel: its rows belong to the old one. */
    setRange: (next: RangeKey) => {
      setRange(next);
      setSelected(null);
    },
    /** Clicking the open datum again closes it; any other replaces it. */
    toggle: (bucket: Bucket) =>
      setSelected((current) => toggleBucket(current, bucket)),
  };
};
