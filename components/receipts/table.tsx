"use client";

import "temporal-polyfill/global";
import { useTable } from "@tanstack/react-table";
import type { ColumnDef } from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  BadgeAlert,
  CalendarIcon,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
} from "lucide-react";
import Link from "next/link";
import type { CSSProperties } from "react";
import { useEffect, useRef } from "react";
import type { DateRange } from "react-day-picker";

import type { ReceiptTable } from "@/components/receipts/columns";
import { features } from "@/components/receipts/features";
import type { DataTableFeatures } from "@/components/receipts/features";
import type { DateRangeFilterValue } from "@/components/receipts/filters";
import { ReceiptStatus } from "@/components/receipts/receipt-status";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatReceiptShortDate } from "@/lib/receipt/datetime";

interface DataTableProps {
  columns: ColumnDef<DataTableFeatures, ReceiptTable>[];
  data: ReceiptTable[];
}

const SortIcon = ({ sorted }: { sorted: false | "asc" | "desc" }) => {
  if (sorted === "asc") {
    return <ArrowUp aria-hidden="true" className="size-3.5" />;
  }
  if (sorted === "desc") {
    return <ArrowDown aria-hidden="true" className="size-3.5" />;
  }
  return (
    <ChevronsUpDown
      aria-hidden="true"
      className="text-muted-foreground size-3.5"
    />
  );
};

const sortActionLabel = (sorted: false | "asc" | "desc") => {
  if (sorted === "asc") {
    return "Sort descending";
  }
  if (sorted === "desc") {
    return "Clear sorting";
  }
  return "Sort ascending";
};

const ARIA_SORT: Record<"asc" | "desc", "ascending" | "descending"> = {
  asc: "ascending",
  desc: "descending",
};

const rangeDateFormatter = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const currencyFormatter = new Intl.NumberFormat("en-AU", {
  currency: "AUD",
  style: "currency",
});

/**
 * The phone's version of a table row. Four of the table's seven columns are
 * off-screen at 390px, and the two that matter — merchant and total — are the
 * ones furthest right, so a scrolling table hides exactly what the list is for.
 */
const ReceiptCard = ({
  index,
  receipt,
}: {
  index: number;
  receipt: ReceiptTable;
}) => (
  // `--i` is the card's position in the list: the entrance stagger reads it in
  // `globals.css`, and Tailwind cannot express a value only known at runtime.
  <li style={{ "--i": index } as CSSProperties}>
    <Link
      className="active:bg-muted/60 flex flex-col gap-1 rounded-lg border p-3 transition-colors"
      href={`/receipts/${receipt.id}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate font-medium">{receipt.merchantName}</span>
        <span className="shrink-0 font-medium tabular-nums">
          {currencyFormatter.format(receipt.total)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-xs">
          {formatReceiptShortDate(receipt.transactionDateTime)}
        </span>
        {receipt.hasIntegrityWarning ? (
          <BadgeAlert
            aria-label="Integrity warning"
            className="text-destructive size-3.5 shrink-0"
          />
        ) : null}
        <span className="ml-auto">
          <ReceiptStatus id={receipt.id} status={receipt.status} />
        </span>
      </div>
    </Link>
  </li>
);

export const getToday = () =>
  new Date(Temporal.Now.instant().epochMilliseconds);

export const getStartOfPreviousMonth = () => {
  const previousMonth = Temporal.Now.plainDateISO().subtract({ months: 1 });
  return new Date(previousMonth.year, previousMonth.month - 1, 1);
};

/**
 * How many receipts one page holds. Every receipt the owner has is already
 * loaded for filtering and sorting, so this is a rendering window, not a query
 * limit — the count is what keeps the list scannable on a phone.
 */
export const PAGE_SIZE = 10;

export const DataTable = ({ columns, data }: DataTableProps) => {
  const table = useTable({
    // The page belongs to the reader, not to the data: the page re-renders
    // whenever a receipt finishes (`router.refresh()` in
    // `receipts-realtime.tsx`), and the default would walk them back to page one
    // mid-scroll. Filtering and sorting still return to page one — see the
    // handlers below, where the reader's own action caused the change.
    autoResetPageIndex: false,
    columns,
    data,
    features,
    initialState: { pagination: { pageIndex: 0, pageSize: PAGE_SIZE } },
  });
  const { pageIndex, pageSize } = table.state.pagination;
  const pageCount = table.getPageCount();
  const rowCount = table.getRowCount();
  const listRef = useRef<HTMLUListElement>(null);
  const merchantColumn = table.getColumn("merchantName");
  const dateColumn = table.getColumn("transactionDateTime");
  const dateRange =
    (dateColumn?.getFilterValue() as DateRange | undefined) ?? undefined;
  const today = getToday();
  const defaultMonth = dateRange?.from ?? getStartOfPreviousMonth();

  // With `autoResetPageIndex` off, nothing rescues the page when the list
  // shrinks under it — a delete that empties the last page, for instance.
  // Filters and sorting reset to page one in the handlers below; this lands on
  // the last page that still exists, so the table never renders empty with
  // pagination pointing past the end.
  useEffect(() => {
    if (pageIndex > 0 && pageIndex >= pageCount) {
      table.setPageIndex(Math.max(0, pageCount - 1));
    }
  }, [pageCount, pageIndex, table]);

  // Reveals the phone list's cards as they scroll into view, once each.
  //
  // Arming is JS-only on purpose: a card is hidden by `data-reveal="pending"`
  // only after this runs, so the server-rendered list — and anything with
  // scripting off — shows every card. Only cards that start below the fold are
  // armed; arming one the reader can already see would flash it. The desktop
  // table's list is `display: none`, so its rects are all zero and nothing is
  // armed there. Cards added later are not armed either: the observer is set up
  // once, and a receipt that arrives while the page is open has already been
  // announced by its toast.
  useEffect(() => {
    const list = listRef.current;
    if (
      !list ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    const offscreen = [
      ...list.querySelectorAll<HTMLElement>(":scope > li"),
    ].filter((card) => card.getBoundingClientRect().top > window.innerHeight);
    if (offscreen.length === 0) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        // Sorted top-to-bottom so a batch crossing the fold together cascades
        // down the list. `boundingClientRect` is captured at observation time,
        // which is the moment the batch is considering, not wherever the
        // element has scrolled to by the time this runs.
        const entering = entries
          .filter(
            (entry) =>
              entry.isIntersecting && entry.target instanceof HTMLElement
          )
          .toSorted(
            (a, b) => a.boundingClientRect.top - b.boundingClientRect.top
          );

        for (const [index, entry] of entering.entries()) {
          if (!(entry.target instanceof HTMLElement)) {
            continue;
          }
          entry.target.style.setProperty(
            "--reveal-delay",
            `${Math.min(index, 4) * 40}ms`
          );
          entry.target.dataset.reveal = "in";
          observer.unobserve(entry.target);
        }
      },
      // Starts the rise as the card's top edge crosses the fold, so it is
      // settled rather than still arriving when the card reaches reading
      // position.
      { rootMargin: "0px 0px -40px 0px" }
    );

    for (const card of offscreen) {
      card.dataset.reveal = "pending";
      observer.observe(card);
    }

    return () => observer.disconnect();
  }, []);

  const rangeLabel = (() => {
    if (!dateRange?.from) {
      return "Any date";
    }
    if (dateRange.to) {
      return `${rangeDateFormatter.format(dateRange.from)} - ${rangeDateFormatter.format(dateRange.to)}`;
    }
    return rangeDateFormatter.format(dateRange.from);
  })();

  // Filtering and sorting renumber every row, so the page the reader was on no
  // longer means what it did: page four of the old result is not page four of
  // the new one, and a narrower filter can leave the current page past the end.
  // `autoResetPageIndex` is off (see above), so the change that reorders the
  // list is also the one that goes back to the first page.
  const setMerchantFilter = (value: string) => {
    merchantColumn?.setFilterValue(value);
    table.firstPage();
  };

  const setDateRangeFilter = (value: DateRangeFilterValue | undefined) => {
    dateColumn?.setFilterValue(value);
    table.firstPage();
  };

  const firstRowOnPage = pageIndex * pageSize + 1;
  const lastRowOnPage = Math.min(rowCount, (pageIndex + 1) * pageSize);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Filter by merchant"
          className="max-w-xs"
          onChange={(event) => setMerchantFilter(event.target.value)}
          placeholder="Filter merchants…"
          value={(merchantColumn?.getFilterValue() as string | undefined) ?? ""}
        />
        <Popover>
          <PopoverTrigger
            aria-label={`Filter by date range: ${rangeLabel}`}
            render={
              <Button
                className="justify-start"
                id="date-range-filter"
                variant="outline"
              >
                <CalendarIcon data-icon="inline-start" />
                {rangeLabel}
              </Button>
            }
          />
          <PopoverContent align="start" className="w-auto">
            <Calendar
              defaultMonth={defaultMonth}
              disabled={{ after: today }}
              mode="range"
              numberOfMonths={2}
              onSelect={(next) => setDateRangeFilter(next ?? {})}
              selected={dateRange}
            />
            <div className="border-t p-1">
              <Button
                onClick={() => setDateRangeFilter(undefined)}
                size="sm"
                variant="ghost"
              >
                Clear dates
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        {/* Pagination sits above the table, not below it: a footer rides up as
            the last page's shorter list ends, so the controls move under the
            reader's cursor exactly when they are about to click one. The
            toolbar is anchored to the top of the table and holds still. */}
        {rowCount > 0 ? (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {/* `aria-live` on a node that stays mounted is what announces a
                page change; the visible rows themselves are replaced, not
                focused. */}
            <p aria-live="polite" className="text-muted-foreground text-sm">
              Showing {firstRowOnPage}-{lastRowOnPage} of {rowCount}{" "}
              {rowCount === 1 ? "receipt" : "receipts"}
            </p>
            {pageCount > 1 ? (
              <nav
                aria-label="Receipt pages"
                className="flex items-center gap-2"
              >
                <Button
                  disabled={!table.getCanPreviousPage()}
                  onClick={() => table.previousPage()}
                  size="sm"
                  variant="outline"
                >
                  <ChevronLeft data-icon="inline-start" />
                  Previous
                </Button>
                <span className="text-sm tabular-nums">
                  Page {pageIndex + 1} of {pageCount}
                </span>
                <Button
                  disabled={!table.getCanNextPage()}
                  onClick={() => table.nextPage()}
                  size="sm"
                  variant="outline"
                >
                  Next
                  <ChevronRight data-icon="inline-end" />
                </Button>
              </nav>
            ) : null}
          </div>
        ) : null}
      </div>
      <ul className="receipt-cards flex flex-col gap-2 md:hidden" ref={listRef}>
        {table.getRowModel().rows.length ? (
          table
            .getRowModel()
            .rows.map((row, index) => (
              <ReceiptCard index={index} key={row.id} receipt={row.original} />
            ))
        ) : (
          <li className="text-muted-foreground py-12 text-center text-sm">
            No results.
          </li>
        )}
      </ul>
      <div className="hidden overflow-hidden rounded-md border md:block">
        {/* `table-fixed` is what makes the widths in the column definitions
            binding: with auto layout the browser fits every column to the
            longest cell on the page, so each page change re-measured the table
            and the columns jumped. The columns are shares of the container, so
            they hold their proportions at any width.

            `min-w` is the width the tightest column needs for its widest
            content — the `processing`/`extracting` status badge, the longest
            date. Below it the columns would be narrower than their own content
            and a badge would spill over the date, so the container scrolls
            sideways instead (which is what the table did before any of this). */}
        <Table className="min-w-[58rem] table-fixed">
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  let content = <table.FlexRender header={header} />;
                  if (!header.isPlaceholder && header.column.getCanSort()) {
                    content = (
                      <button
                        className="hover:text-foreground flex items-center gap-1"
                        onClick={(event) => {
                          header.column.getToggleSortingHandler()?.(event);
                          table.firstPage();
                        }}
                        type="button"
                      >
                        {content}
                        <SortIcon sorted={sorted} />
                        <span className="sr-only">
                          {sortActionLabel(sorted)}
                        </span>
                      </button>
                    );
                  }
                  return (
                    <TableHead
                      aria-sort={sorted ? ARIA_SORT[sorted] : undefined}
                      className="w-(--column-width)"
                      key={header.id}
                      // The width comes from the column definition, so the
                      // table's geometry is declared with the columns rather
                      // than inferred from whichever page is showing. Unset for
                      // the merchant column, which takes the remaining space.
                      style={
                        {
                          "--column-width": header.column.columnDef.meta?.width,
                        } as CSSProperties
                      }
                    >
                      {header.isPlaceholder ? null : content}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                >
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id}>
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center"
                >
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
};
