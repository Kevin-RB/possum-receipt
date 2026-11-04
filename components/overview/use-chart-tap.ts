"use client";

import { useRef } from "react";
import type { TouchEvent as ReactTouchEvent } from "react";
import type { MouseHandlerDataParam } from "recharts";

import type { Bucket, ChartDatum } from "@/lib/overview";
import { datumAtIndex, isScrubGesture } from "@/lib/overview-chart";

type TouchLike = Pick<
  ReactTouchEvent<SVGGraphicsElement>,
  "changedTouches" | "touches"
>;

/**
 * Selecting a chart datum from the chart, not from the datum.
 *
 * On a phone the 30-day chart is 30 bands in ~210px: a bar is about 7px wide
 * and a fingertip covers five or six of them, so "tap the bar" is a coin flip
 * and "tap the gap between bars" does nothing at all. Recharts already maps any
 * pointer position to the nearest band and drives the tooltip from it, including
 * `touchmove` — so the chart itself can answer "which datum is under the finger"
 * and the finger only has to be over the plot.
 *
 * That also makes the tooltip a scrub preview: drag across the plot, watch the
 * day under your finger, lift to open it.
 *
 * Two triggers, on purpose. A tap is resolved by the click handler, which
 * recharts answers from the click's own coordinates; a drag is resolved on
 * release, because no click follows one — and only a horizontal drag counts, so
 * flicking the page never opens whatever datum the scroll happened to end on.
 */
export const useChartTap = (
  data: ChartDatum[],
  toggle: (bucket: Bucket) => void
) => {
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const toggleIndex = (index: MouseHandlerDataParam["activeTooltipIndex"]) => {
    const datum = datumAtIndex(data, index);
    if (datum) {
      toggle(datum.bucket);
    }
  };

  return {
    onClick: (state: MouseHandlerDataParam) => {
      toggleIndex(state.activeTooltipIndex);
    },
    onTouchEnd: (state: MouseHandlerDataParam, event: TouchLike) => {
      const start = touchStart.current;
      touchStart.current = null;
      const touch = event.changedTouches.item(0);

      if (
        !start ||
        !touch ||
        !isScrubGesture(start, { x: touch.clientX, y: touch.clientY })
      ) {
        return;
      }

      toggleIndex(state.activeTooltipIndex);
    },
    onTouchStart: (_state: MouseHandlerDataParam, event: TouchLike) => {
      const touch = event.touches.item(0);
      touchStart.current = touch
        ? { x: touch.clientX, y: touch.clientY }
        : null;
    },
  };
};
