"use client";

import Link from "next/link";

import { drilldownCount, drilldownTotal } from "@/lib/overview";
import type { Drilldown } from "@/lib/overview";
import { currencyFormatter } from "@/lib/overview-chart";
import { formatReceiptShortDate } from "@/lib/receipt/datetime";

const formatMoney = (value: number): string => currencyFormatter.format(value);

/**
 * The rows a chart datum was summed from.
 *
 * Every chart opens this beneath itself, which is why it takes a resolved
 * drill-down rather than a bucket: membership is decided in `lib/overview.ts`,
 * and the header's total is the sum of the very rows listed.
 */
export const DrilldownPanel = ({ drilldown }: { drilldown: Drilldown }) => {
  const count = drilldownCount(drilldown);
  const unit = drilldown.kind === "receipts" ? "receipt" : "line item";

  return (
    <div className="border-border/60 mt-4 border-t pt-4">
      <p className="text-sm font-medium">
        {count.toLocaleString()} {unit}
        {count === 1 ? "" : "s"} ·{" "}
        <span className="tabular-nums">
          {formatMoney(drilldownTotal(drilldown))}
        </span>
      </p>
      {count === 0 ? (
        <p className="text-muted-foreground py-6 text-center text-sm">
          Nothing in this period to show.
        </p>
      ) : (
        // Capped with an internal scroll: a day with fifty receipts must not
        // push the next chart off the page, and there is no pagination to page
        // through instead.
        <div className="mt-2 max-h-64 overflow-y-auto pr-1">
          {drilldown.kind === "receipts" ? (
            <ul className="divide-border/60 divide-y">
              {drilldown.rows.map((row) => (
                <li key={row.id}>
                  <Link
                    className="hover:bg-muted/60 flex items-center justify-between gap-3 rounded-md px-2 py-2"
                    href={`/receipts/${row.id}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">
                        {row.merchantName ?? "Unknown merchant"}
                      </span>
                      <span className="text-muted-foreground block text-xs">
                        {formatReceiptShortDate(row.date)}
                      </span>
                    </span>
                    <span className="shrink-0 text-sm tabular-nums">
                      {formatMoney(row.total)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-col gap-3">
              {drilldown.groups.map((group) => (
                <div key={group.receipt.id}>
                  <Link
                    className="hover:bg-muted/60 flex items-center justify-between gap-3 rounded-md px-2 py-1"
                    href={`/receipts/${group.receipt.id}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {group.receipt.merchantName ?? "Unknown merchant"}
                      </span>
                      <span className="text-muted-foreground block text-xs">
                        {formatReceiptShortDate(group.receipt.date)}
                      </span>
                    </span>
                  </Link>
                  <ul className="mt-1 flex flex-col">
                    {group.items.map((item) => (
                      <li
                        className="flex items-center justify-between gap-3 py-1 pl-3 text-sm"
                        key={item.id}
                      >
                        <span className="min-w-0 truncate">{item.name}</span>
                        <span className="text-muted-foreground shrink-0 tabular-nums">
                          {formatMoney(item.lineTotal)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
