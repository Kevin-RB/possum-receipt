"use client";

import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { bucketKey } from "@/lib/overview";
import type { Bucket, ChartDatum } from "@/lib/overview";
import { currencyFormatter } from "@/lib/overview-chart";
import { cn } from "@/lib/utils";

/**
 * The dotted run that carries the eye from a row's label to its amount, the
 * same one a drill-down row draws.
 */
const LEADER_CLASS =
  "border-foreground/15 mx-1 min-w-4 flex-1 self-baseline border-b border-dotted";

/** A whole row is the target, so the amount is not a 20px tap area of its own. */
const ROW_CLASS =
  "flex w-full items-baseline gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors duration-150 hover:bg-foreground/5 focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none active:bg-foreground/10";

/** Neither an hour-long list nor a cap that clips a category off the card. */
const LIST_CLASS =
  "drilldown-scroll border-border divide-border/60 mt-1 flex max-h-64 flex-col divide-y overflow-y-auto overscroll-contain border-t";

/**
 * The chart's data as a list of buttons — its keyboard and screen-reader path.
 *
 * Recharts' accessibility layer moves a tooltip with the arrow keys, but Enter
 * does not fire the mark's `onClick`, so a bar or a slice opens its drill-down
 * only for a pointer. This is the same data drawn as a list: one real button
 * per datum, `aria-pressed` on the open one, calling the very `toggle` the mark
 * calls — so the two paths cannot resolve different rows.
 *
 * Behind a disclosure rather than visually hidden in place: thirty tab stops
 * between one card and the next would be paid by every keyboard reader whether
 * or not they wanted the numbers, while a reader who does gets one button that
 * announces itself as expanded. The list is capped and scrolls, so the panel it
 * opens lands just below it rather than past the end of a screenful.
 */
export const ChartDataList = ({
  data,
  nameOf,
  onSelect,
  selected,
  title,
}: {
  data: ChartDatum[];
  /** A datum's name in words — a day bucket's label is an ISO date. */
  nameOf: (datum: ChartDatum) => string;
  /** The chart's own toggle, so a row opens what the bar opens. */
  onSelect: (bucket: Bucket) => void;
  selected: Bucket | null;
  /** The chart's title, so each card's toggle names itself out of context. */
  title: string;
}) => {
  const [open, setOpen] = useState(false);
  const listId = useId();

  return (
    <div className="mt-3">
      <Button
        aria-controls={listId}
        aria-expanded={open}
        aria-label={`${open ? "Hide" : "Show"} data for ${title}`}
        onClick={() => setOpen((current) => !current)}
        size="sm"
        type="button"
        variant="ghost"
      >
        {open ? "Hide data" : "Show data"}
      </Button>
      {/* Always rendered, so `aria-controls` names an element that exists. */}
      <div id={listId}>
        {open ? (
          <ul aria-label={`${title} data`} className={LIST_CLASS}>
            {data.map((datum) => {
              const pressed =
                selected !== null &&
                bucketKey(selected) === bucketKey(datum.bucket);

              return (
                <li key={bucketKey(datum.bucket)}>
                  <button
                    aria-pressed={pressed}
                    className={cn(ROW_CLASS, pressed && "bg-foreground/5")}
                    onClick={() => onSelect(datum.bucket)}
                    type="button"
                  >
                    <span className="min-w-0 truncate">{nameOf(datum)}</span>
                    <span aria-hidden className={LEADER_CLASS} />
                    <span className="shrink-0 tabular-nums">
                      {currencyFormatter.format(datum.total)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </div>
  );
};
