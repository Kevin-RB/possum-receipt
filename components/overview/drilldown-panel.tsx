"use client";

import Link from "next/link";
import type { CSSProperties } from "react";

import { drilldownCount, drilldownTotal } from "@/lib/overview";
import type { Drilldown, ItemGroup, ReceiptRow } from "@/lib/overview";
import { currencyFormatter } from "@/lib/overview-chart";
import { formatReceiptShortDate } from "@/lib/receipt/datetime";

const formatMoney = (value: number): string => currencyFormatter.format(value);

/**
 * The dotted run that carries the eye from a row's label to its amount.
 *
 * The amount belongs at the right edge — a column of figures is what makes a
 * receipt scannable — but a bare gap leaves it floating a card's width away
 * from the thing it prices. The leader joins the two without giving up the
 * column.
 */
const Leader = () => (
  <span
    aria-hidden
    className="border-foreground/15 mx-1 min-w-4 flex-1 self-baseline border-b border-dotted"
  />
);

/** A whole row is the link, so hovering and pressing read as one target. */
const ROW_CLASS =
  "focus-visible:ring-ring/50 flex items-baseline gap-2 rounded-md px-2 py-2 text-sm transition-colors duration-150 hover:bg-foreground/5 focus-visible:ring-2 focus-visible:outline-none active:bg-foreground/10";

const ReceiptLine = ({ row }: { row: ReceiptRow }) => (
  <>
    <span className="min-w-0 truncate font-medium">
      {row.merchantName ?? "Unknown merchant"}
    </span>
    <span className="text-muted-foreground shrink-0 text-xs">
      {formatReceiptShortDate(row.date)}
    </span>
    <Leader />
    <span className="shrink-0 font-medium tabular-nums">
      {formatMoney(row.total)}
    </span>
  </>
);

const Group = ({ group }: { group: ItemGroup }) => (
  <>
    <Link className={ROW_CLASS} href={`/receipts/${group.receipt.id}`}>
      <span className="min-w-0 truncate font-medium">
        {group.receipt.merchantName ?? "Unknown merchant"}
      </span>
      <span className="text-muted-foreground shrink-0 text-xs">
        {formatReceiptShortDate(group.receipt.date)}
      </span>
    </Link>
    <ul className="border-border mt-0.5 mb-1 flex flex-col border-l pl-2">
      {group.items.map((item) => (
        <li
          className="flex items-baseline gap-2 py-1 pr-2 pl-3 text-sm"
          key={item.id}
        >
          <span className="min-w-0 truncate">{item.name}</span>
          <Leader />
          <span className="tabular-nums">{formatMoney(item.lineTotal)}</span>
        </li>
      ))}
    </ul>
  </>
);

/**
 * The rows a chart datum was summed from.
 *
 * Every chart opens this beneath itself, which is why it takes a resolved
 * drill-down rather than a bucket: membership is decided in `lib/overview.ts`,
 * and the header's total is the sum of the very rows listed.
 */
export const DrilldownPanel = ({ drilldown }: { drilldown: Drilldown }) => {
  const count = drilldownCount(drilldown);
  const noun = drilldown.kind === "receipts" ? "receipt" : "line item";

  return (
    <div className="enter-rise-sm bg-muted/40 ring-foreground/10 mt-4 rounded-lg p-2 ring-1">
      <header className="flex items-baseline justify-between gap-3 px-2 pt-1 pb-2">
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          {count.toLocaleString()} {noun}
          {count === 1 ? "" : "s"}
        </p>
        <p className="text-base font-semibold tabular-nums">
          {formatMoney(drilldownTotal(drilldown))}
        </p>
      </header>
      {count === 0 ? (
        <p className="border-border text-muted-foreground rounded-md border border-dashed px-3 py-6 text-center text-sm text-balance">
          Nothing in this period to show.
        </p>
      ) : (
        // Capped with an internal scroll: a day with fifty receipts must not
        // push the next chart off the page, and there is no pagination to page
        // through instead.
        <div className="drilldown-scroll max-h-64 overflow-y-auto overscroll-contain pr-1">
          {drilldown.kind === "receipts" ? (
            <ul className="drilldown-rows flex flex-col">
              {drilldown.rows.map((row, index) => (
                <li key={row.id} style={{ "--i": index } as CSSProperties}>
                  <Link className={ROW_CLASS} href={`/receipts/${row.id}`}>
                    <ReceiptLine row={row} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="drilldown-rows divide-border/60 flex flex-col divide-y">
              {drilldown.groups.map((group, index) => (
                <div
                  className="pb-1 first:pt-1"
                  key={group.receipt.id}
                  style={{ "--i": index } as CSSProperties}
                >
                  <Group group={group} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
