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
import { categorySpending, rangeLabel } from "@/lib/overview";
import type { ChartDatum, OverviewReceipt } from "@/lib/overview";
import {
  currencyFormatter,
  datumOpacity,
  truncateLabel,
} from "@/lib/overview-chart";

const chartConfig = {
  total: {
    color: "var(--chart-2)",
    label: "Total",
  },
} satisfies ChartConfig;

export const CategorySpendingChart = ({
  receipts,
  today,
}: {
  receipts: OverviewReceipt[];
  /** The viewer's day, resolved on the server so both renders agree. */
  today: string;
}) => {
  const { drilldown, period, range, selected, setRange, toggle } =
    useChartDrilldown(receipts, today);

  const data = useMemo(
    () => categorySpending(receipts, period),
    [receipts, period]
  );

  // Same target rule as the spending chart: a tap anywhere on the row opens it.
  const tap = useChartTap(data, toggle);

  // `shape` rather than per-datum `Cell`s: recharts deprecated `Cell` in 3.x.
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
          <CardTitle>Spending by category</CardTitle>
          <CardDescription>
            Total spent in the last {rangeLabel(range)}. Select a bar for the
            line items behind it.
          </CardDescription>
        </div>
        <ChartPeriodSelect
          label="Category spending period"
          onChange={setRange}
          value={range}
        />
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-muted-foreground py-10 text-center text-sm">
            No categorised spending in this period.
          </p>
        ) : (
          <>
            <ChartContainer
              className="aspect-auto h-100 w-full sm:h-75"
              config={chartConfig}
            >
              <BarChart
                {...tap}
                accessibilityLayer
                data={data}
                layout="vertical"
                margin={{
                  left: 4,
                  right: 12,
                }}
              >
                <CartesianGrid horizontal={false} />
                <XAxis
                  axisLine={false}
                  tick={{ fontSize: 11 }}
                  tickFormatter={(value) =>
                    currencyFormatter.format(Number(value))
                  }
                  tickLine={false}
                  tickMargin={8}
                  type="number"
                />
                <YAxis
                  axisLine={false}
                  dataKey="label"
                  tick={{ fontSize: 11 }}
                  // A fixed, narrow label column leaves the bars usable on a
                  // phone; truncating keeps long leaves from touching it.
                  tickFormatter={(value) => truncateLabel(String(value))}
                  tickLine={false}
                  tickMargin={8}
                  type="category"
                  width={96}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      formatter={(value) =>
                        currencyFormatter.format(Number(value))
                      }
                    />
                  }
                />
                <Bar
                  className="cursor-pointer"
                  dataKey="total"
                  fill="var(--color-total)"
                  shape={renderBar}
                  radius={4}
                />
              </BarChart>
            </ChartContainer>
            {drilldown ? <DrilldownPanel drilldown={drilldown} /> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
};
