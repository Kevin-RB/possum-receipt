"use client";

/*
 * The mobile spending strip is a scroll container: reaching it with the
 * keyboard is the only way to pan it without a pointer, which WCAG 2.1.1 and
 * axe's `scrollable-region-focusable` both ask for. `no-noninteractive-tabindex`
 * does not allow that on a non-interactive element, so it is turned off for the
 * one element in this file where the rule and the requirement disagree.
 */
/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- a scroll strip must be focusable to be panned */

import "temporal-polyfill/global";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Rectangle,
  XAxis,
  YAxis,
} from "recharts";
import type { BarShapeProps } from "recharts";

import { ChartDataList } from "@/components/overview/chart-data-list";
import { ChartPeriodSelect } from "@/components/overview/chart-period-select";
import { DrilldownPanel } from "@/components/overview/drilldown-panel";
import { useChartDrilldown } from "@/components/overview/use-chart-drilldown";
import { useScrollCue } from "@/components/overview/use-scroll-cue";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import type { ChartConfig } from "@/components/ui/chart";
import { rangeGrain, rangeLabel, spendingByRange } from "@/lib/overview";
import type { ChartDatum, OverviewReceipt } from "@/lib/overview";
import {
  currencyFormatter,
  datumOpacity,
  formatDayTick,
  formatDayTooltipLabel,
  formatMonthTick,
  formatMonthTooltipLabel,
} from "@/lib/overview-chart";

/**
 * How much width one day gets once the chart is scrollable.
 *
 * Below `sm` the chart is as wide as its days need rather than squeezed into
 * the card: 32px a day (a ~24px bar) leaves about nine on screen at 375px and
 * turns a 5px bar into a target. Monthly bars are already wide enough to leave
 * alone.
 */
const BAR_SLOT = 32;

const chartConfig = {
  total: {
    color: "var(--chart-1)",
    label: "Total",
  },
} satisfies ChartConfig;

export const SpendingChart = ({
  receipts,
  today,
}: {
  receipts: OverviewReceipt[];
  /** The viewer's day, resolved on the server so both renders agree. */
  today: string;
}) => {
  const { day, drilldown, range, selected, setRange, toggle } =
    useChartDrilldown(receipts, today);

  const data = useMemo(
    () => spendingByRange(receipts, range, day),
    [receipts, range, day]
  );

  const monthly = rangeGrain(range) === "month";

  // A strip that opens on the oldest day hides today; one that opens on today
  // can land on a run of empty days. So it opens around the most recent day
  // that actually has spending — the thing the reader came to look at — and the
  // browser clamps the scroll at either end.
  const scrollRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const strip = scrollRef.current;
    if (!strip) {
      return;
    }

    const lastActive = data.findLastIndex((datum) => datum.total > 0);
    strip.scrollLeft =
      lastActive === -1
        ? 0
        : (lastActive + 1) * BAR_SLOT - strip.clientWidth / 2;
  }, [data]);

  const railRef = useRef<HTMLDivElement>(null);
  useScrollCue(scrollRef, railRef);

  const chartMinWidth = monthly ? undefined : data.length * BAR_SLOT;

  // Drawn through `shape` rather than per-datum `Cell`s: recharts deprecated
  // `Cell` in 3.x and points at this instead. The missing bar is the point —
  // once the pointer leaves, nothing else says which day the panel belongs to.
  const renderBar = (props: BarShapeProps) => {
    const datum = props.payload as ChartDatum | undefined;
    return (
      <Rectangle
        className={props.className}
        fill={props.fill}
        fillOpacity={datum ? datumOpacity(datum.bucket, selected) : 1}
        height={props.height}
        radius={props.radius}
        width={props.width}
        x={props.x}
        y={props.y}
      />
    );
  };

  return (
    <Card className="w-full">
      <CardHeader className="flex flex-row items-start justify-between">
        <div className="flex flex-col gap-1">
          <CardTitle>Spending</CardTitle>
          <CardDescription>
            Total spent in the last {rangeLabel(range)}. Select a bar for the
            receipts behind it.
          </CardDescription>
        </div>
        <ChartPeriodSelect
          label="Spending period"
          onChange={setRange}
          value={range}
        />
      </CardHeader>
      <CardContent>
        {/*
          Focusable on purpose: with the scrollbar hidden and the strip panning
          sideways below `sm`, tabbing to it is the only way to pan the chart
          without a pointer.
        */}
        <section
          aria-label={`Spending by ${monthly ? "month" : "day"}, scrollable`}
          className="overview-chart-scroll focus-visible:ring-ring/50 rounded-lg focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
          ref={scrollRef}
          tabIndex={0}
        >
          <div
            className="overview-chart-inner"
            style={
              chartMinWidth
                ? ({
                    "--chart-min-width": `${chartMinWidth}px`,
                  } as CSSProperties)
                : undefined
            }
          >
            <ChartContainer
              className="aspect-auto h-100 w-full sm:h-75"
              config={chartConfig}
            >
              <BarChart
                accessibilityLayer
                data={data}
                margin={{
                  left: 12,
                  right: 12,
                }}
              >
                <CartesianGrid vertical={false} />
                <XAxis
                  axisLine={false}
                  dataKey="label"
                  minTickGap={32}
                  tick={{ fontSize: 11 }}
                  tickFormatter={monthly ? formatMonthTick : formatDayTick}
                  tickLine={false}
                  tickMargin={8}
                />
                <YAxis
                  axisLine={false}
                  tick={{ fontSize: 11 }}
                  tickFormatter={(value) =>
                    currencyFormatter.format(Number(value))
                  }
                  tickLine={false}
                  tickMargin={8}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      formatter={(value) =>
                        currencyFormatter.format(Number(value))
                      }
                      labelFormatter={
                        monthly
                          ? formatMonthTooltipLabel
                          : formatDayTooltipLabel
                      }
                    />
                  }
                />
                <Bar
                  className="cursor-pointer"
                  dataKey="total"
                  fill="var(--color-total)"
                  shape={renderBar}
                  onClick={(entry) => {
                    // The index recharts hands back counts the bars it drew,
                    // not the days in `data`; `originalDataIndex` is its own.
                    const datum = data[entry.originalDataIndex];
                    if (datum) {
                      toggle(datum.bucket);
                    }
                  }}
                />
              </BarChart>
            </ChartContainer>
          </div>
        </section>
        <div
          aria-hidden
          className="overview-chart-rail sm:hidden"
          ref={railRef}
        >
          <div className="overview-chart-thumb" />
        </div>
        <ChartDataList
          data={data}
          nameOf={(datum) =>
            monthly
              ? formatMonthTooltipLabel(datum.label)
              : formatDayTooltipLabel(datum.label)
          }
          onSelect={toggle}
          selected={selected}
          title="Spending"
        />
        {drilldown ? <DrilldownPanel drilldown={drilldown} /> : null}
      </CardContent>
    </Card>
  );
};
