"use client";

import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import {
  Label,
  PolarAngleAxis,
  PolarGrid,
  RadialBar,
  RadialBarChart,
} from "recharts";

import { DrilldownPanel } from "@/components/overview/drilldown-panel";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { integritySummary, resolveBucket } from "@/lib/overview";
import type { OverviewReceipt } from "@/lib/overview";

const chartConfig = {
  warnings: {
    color: "var(--destructive)",
    label: "Integrity warnings",
  },
} satisfies ChartConfig;

interface CenterLabelProps {
  warnings: number;
  viewBox?: {
    cx?: number;
    cy?: number;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
}

const CenterLabel = ({ warnings, viewBox }: CenterLabelProps) => {
  const cx = viewBox?.cx ?? (viewBox?.x ?? 0) + (viewBox?.width ?? 0) / 2;
  const cy = viewBox?.cy ?? (viewBox?.y ?? 0) + (viewBox?.height ?? 0) / 2;
  return (
    <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle">
      <tspan x={cx} y={cy} className="fill-foreground text-4xl font-bold">
        {warnings.toLocaleString()}
      </tspan>
      <tspan x={cx} y={cy + 24} className="fill-muted-foreground">
        Flagged
      </tspan>
    </text>
  );
};

export const IntegrityChart = ({
  period,
  receipts,
}: {
  /** The span the corpus covers, spelled out because the gauge has no period
   * selector — otherwise "N of M" reads as the whole account. */
  period: string;
  receipts: OverviewReceipt[];
}) => {
  const [open, setOpen] = useState(false);

  // The count, the datum and the receipt list come from one call, so "N of M
  // flagged" and the disclosure cannot disagree.
  const { datum, flagged, total } = useMemo(
    () => integritySummary(receipts),
    [receipts]
  );
  const drilldown = useMemo(
    () => resolveBucket(datum.bucket, flagged),
    [datum, flagged]
  );

  const warnings = flagged.length;
  const clean = total > 0 && warnings === 0;

  const data = [{ name: "warnings", warnings }];

  return (
    <Card className="flex flex-col">
      <CardHeader className="items-center">
        <CardTitle>Integrity</CardTitle>
        <CardDescription>
          Matching vs. flagged receipts in the last {period}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1">
        <ChartContainer
          config={chartConfig}
          className="mx-auto aspect-square max-h-70"
        >
          <RadialBarChart
            data={data}
            startAngle={0}
            endAngle={360}
            outerRadius={90}
            innerRadius={75}
          >
            <PolarGrid
              gridType="circle"
              radialLines={false}
              stroke="none"
              className={
                clean
                  ? "first:fill-chart-1 last:fill-background"
                  : "first:fill-muted last:fill-background"
              }
              polarRadius={[90, 75]}
            />
            <RadialBar dataKey="warnings" fill="var(--color-warnings)" />
            <PolarAngleAxis
              type="number"
              domain={[0, Math.max(total, 1)]}
              tick={false}
              tickLine={false}
              axisLine={false}
            />
            <ChartTooltip
              cursor={false}
              content={<ChartTooltipContent hideLabel />}
            />
            <Label
              position="center"
              content={<CenterLabel warnings={warnings} />}
            />
          </RadialBarChart>
        </ChartContainer>
      </CardContent>
      <CardFooter className="flex-col">
        <div className="drilldown-disclosure w-full">
          <Collapsible onOpenChange={setOpen} open={open}>
            <CollapsibleTrigger
              disabled={warnings === 0}
              render={<Button className="w-full" size="sm" variant="ghost" />}
            >
              {warnings.toLocaleString()} of {total.toLocaleString()} flagged
              <ChevronDown
                className={open ? "rotate-180" : undefined}
                data-icon="inline-end"
              />
            </CollapsibleTrigger>
            <CollapsibleContent className="w-full">
              <DrilldownPanel drilldown={drilldown} />
            </CollapsibleContent>
          </Collapsible>
        </div>
        <div className="text-muted-foreground mt-2 text-center leading-none">
          Line items do not sum to the stated total
        </div>
      </CardFooter>
    </Card>
  );
};
