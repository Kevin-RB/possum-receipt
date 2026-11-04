"use client";

import "temporal-polyfill/global";
import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Rectangle,
  XAxis,
  YAxis,
} from "recharts";
import type { BarShapeProps } from "recharts";

import { ChartPeriodSelect } from "@/components/overview/chart-period-select";
import { DrilldownPanel } from "@/components/overview/drilldown-panel";
import { useChartDrilldown } from "@/components/overview/use-chart-drilldown";
import { useChartTap } from "@/components/overview/use-chart-tap";
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

  // The whole plot is the target: on a phone a day is ~7px wide, narrower than
  // the finger reading it.
  const tap = useChartTap(data, toggle);

  const monthly = rangeGrain(range) === "month";

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
        <ChartContainer
          className="aspect-auto h-100 w-full sm:h-75"
          config={chartConfig}
        >
          <BarChart
            {...tap}
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
              tickFormatter={(value) => currencyFormatter.format(Number(value))}
              tickLine={false}
              tickMargin={8}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value) => currencyFormatter.format(Number(value))}
                  labelFormatter={
                    monthly ? formatMonthTooltipLabel : formatDayTooltipLabel
                  }
                />
              }
            />
            <Bar
              className="cursor-pointer"
              dataKey="total"
              fill="var(--color-total)"
              shape={renderBar}
            />
          </BarChart>
        </ChartContainer>
        {drilldown ? <DrilldownPanel drilldown={drilldown} /> : null}
      </CardContent>
    </Card>
  );
};
