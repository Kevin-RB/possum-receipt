"use client";

import "temporal-polyfill/global";
import type { CSSProperties } from "react";
import { useMemo } from "react";
import { Pie, PieChart, Sector } from "recharts";
import type {
  PieLabelRenderProps,
  PieSectorShapeProps,
  TooltipPayloadEntry,
  TooltipValueType,
} from "recharts";

import { ChartPeriodSelect } from "@/components/overview/chart-period-select";
import { DrilldownPanel } from "@/components/overview/drilldown-panel";
import { useChartDrilldown } from "@/components/overview/use-chart-drilldown";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { ChartConfig } from "@/components/ui/chart";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { merchantSpending, rangeLabel } from "@/lib/overview";
import type { ChartDatum, OverviewReceipt } from "@/lib/overview";
import { PIE_PALETTE, currencyFormatter } from "@/lib/overview-chart";

interface MerchantDatum extends ChartDatum {
  fill: string;
  percent: number;
}

const percentOf = (value: number, sum: number): number =>
  sum === 0 ? 0 : value / sum;

const formatTooltipValue = (
  value: TooltipValueType | undefined,
  name: number | string | undefined,
  item: TooltipPayloadEntry<TooltipValueType, number | string>
) => (
  <div className="flex w-full items-center justify-between gap-4">
    <div className="flex items-center gap-2">
      <div
        className="h-2.5 w-2.5 shrink-0 rounded-xs bg-(--swatch-color)"
        style={{ "--swatch-color": item.payload.fill } as CSSProperties}
      />
      <span className="text-muted-foreground">{name}</span>
    </div>
    <span className="text-foreground font-medium tabular-nums">
      {currencyFormatter.format(Number(value))}
    </span>
  </div>
);

const renderPercentLabel = (props: PieLabelRenderProps) => (
  <text
    cx={props.cx}
    cy={props.cy}
    dominantBaseline={props.dominantBaseline}
    fill="var(--foreground)"
    textAnchor={props.textAnchor}
    x={props.x}
    y={props.y}
  >
    {Math.round((props.percent ?? 0) * 100)}%
  </text>
);

const renderSector = (props: PieSectorShapeProps) => (
  <Sector {...props} fill={props.payload.fill} />
);

export const MerchantSpendingChart = ({
  receipts,
  today,
}: {
  receipts: OverviewReceipt[];
  /** The viewer's day, resolved on the server so both renders agree. */
  today: string;
}) => {
  const { drilldown, period, range, setRange, toggle } = useChartDrilldown(
    receipts,
    today
  );

  const data = useMemo(() => {
    const buckets = merchantSpending(receipts, period);
    const sum = buckets.reduce((total, bucket) => total + bucket.total, 0);

    return buckets.map(
      (bucket, index): MerchantDatum => ({
        ...bucket,
        fill: PIE_PALETTE[index % PIE_PALETTE.length] ?? PIE_PALETTE[0],
        percent: percentOf(bucket.total, sum),
      })
    );
  }, [receipts, period]);

  const chartConfig = useMemo(() => {
    const config: ChartConfig = {};
    for (const bucket of data) {
      config[bucket.label] = { label: bucket.label };
    }
    return config;
  }, [data]);

  return (
    <Card className="w-full">
      <CardHeader className="flex flex-row items-start justify-between">
        <div className="flex flex-col gap-1">
          <CardTitle>Spending by merchant</CardTitle>
          <CardDescription>
            Share of the last {rangeLabel(range)}. Select a slice for its
            receipts.
          </CardDescription>
        </div>
        <ChartPeriodSelect
          label="Merchant spending period"
          onChange={setRange}
          value={range}
        />
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-muted-foreground py-10 text-center text-sm">
            No merchant spending in this period.
          </p>
        ) : (
          <>
            <ChartContainer
              className="aspect-auto h-80 w-full sm:h-75"
              config={chartConfig}
            >
              <PieChart>
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      formatter={formatTooltipValue}
                      hideLabel
                    />
                  }
                />
                <Pie
                  className="cursor-pointer"
                  cx="50%"
                  cy="50%"
                  data={data}
                  dataKey="total"
                  label={renderPercentLabel}
                  labelLine={false}
                  nameKey="label"
                  // Unlike a bar, every datum draws a sector, so this index is
                  // the datum's own.
                  onClick={(_, index) => {
                    const datum = data[index];
                    if (datum) {
                      toggle(datum.bucket);
                    }
                  }}
                  shape={renderSector}
                  strokeWidth={5}
                />
                {/* Six entries are the maximum, so the legend has to wrap
                    rather than push the pie out of the card on a phone. */}
                <ChartLegend
                  content={
                    <ChartLegendContent className="flex-wrap" nameKey="label" />
                  }
                />
              </PieChart>
            </ChartContainer>
            {drilldown ? <DrilldownPanel drilldown={drilldown} /> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
};
