"use client";

import "temporal-polyfill/global";
import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { sumDailySpending, windowDays } from "@/lib/overview";
import type { SpendingInput } from "@/lib/overview";
import {
  currencyFormatter,
  RANGE_ITEMS,
  RANGE_LABELS,
  RANGE_MONTHS,
} from "@/lib/overview-chart";
import type { RangeKey } from "@/lib/overview-chart";

const chartConfig = {
  total: {
    color: "var(--chart-1)",
    label: "Total",
  },
} satisfies ChartConfig;

const formatDayTick = (value: unknown) =>
  Temporal.PlainDate.from(String(value)).toLocaleString("en-AU", {
    day: "numeric",
    month: "short",
  });

const formatDayTooltipLabel = (value: unknown) =>
  Temporal.PlainDate.from(String(value)).toLocaleString("en-AU", {
    day: "numeric",
    month: "short",
    weekday: "short",
  });

export const SpendingChart = ({
  receipts,
  today,
}: {
  receipts: SpendingInput[];
  /** The viewer's day, resolved on the server so both renders agree. */
  today: string;
}) => {
  const [range, setRange] = useState<RangeKey>("30-days");

  const day = useMemo(() => Temporal.PlainDate.from(today), [today]);

  const data = useMemo(() => {
    const months = RANGE_MONTHS[range];
    const days = months === null ? 30 : windowDays(day, months);
    return sumDailySpending(receipts, days, day);
  }, [receipts, range, day]);

  return (
    <Card className="w-full">
      <CardHeader className="flex flex-row items-start justify-between">
        <div className="flex flex-col gap-1">
          <CardTitle>Spending</CardTitle>
          <CardDescription>
            Total spent in the last {RANGE_LABELS[range]}
          </CardDescription>
        </div>
        <Select
          items={RANGE_ITEMS}
          onValueChange={(value) => setRange(value as RangeKey)}
          value={range}
        >
          <SelectTrigger aria-label="Spending period" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {Object.entries(RANGE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent>
        <ChartContainer
          config={chartConfig}
          className="aspect-auto h-75 w-full"
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
              tickFormatter={formatDayTick}
              tickLine={false}
              tickMargin={8}
            />
            <YAxis
              axisLine={false}
              tickFormatter={(value) => currencyFormatter.format(Number(value))}
              tickLine={false}
              tickMargin={8}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value) => currencyFormatter.format(Number(value))}
                  labelFormatter={formatDayTooltipLabel}
                />
              }
            />
            <Bar dataKey="total" fill="var(--color-total)" />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
};
