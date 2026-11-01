// @vitest-environment jsdom

import { createColumnHelper } from "@tanstack/react-table";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { UseRealtimeConnectionStatus } from "inngest/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ReceiptTable } from "@/components/receipts/columns";
import type { DataTableFeatures } from "@/components/receipts/features";
import { ReceiptsRealtimeContext } from "@/components/receipts/receipts-realtime-context";
import type { ReceiptsRealtimeValue } from "@/components/receipts/receipts-realtime-context";

import { DataTable, PAGE_SIZE } from "./table";

const columnHelper = createColumnHelper<DataTableFeatures, ReceiptTable>();

const columns = columnHelper.columns([
  columnHelper.accessor("merchantName", {
    header: "Merchant",
    meta: { width: "20%" },
  }),
]);

const receipt = (index: number): ReceiptTable => ({
  hasIntegrityWarning: false,
  id: `receipt-${index}`,
  merchantName: `Merchant ${index}`,
  paymentMethod: "Visa",
  status: "done",
  total: index,
  transactionDateTime: "2026-01-01T12:00:00",
});

const realtimeValue: ReceiptsRealtimeValue = {
  byReceipt: new Map(),
  // The page's live stage is not what this table renders; the provider only
  // has to exist because every status badge reads it.
  connectionStatus: "connected" as UseRealtimeConnectionStatus,
  error: null,
};

const renderTable = (count: number) =>
  render(
    <ReceiptsRealtimeContext.Provider value={realtimeValue}>
      <DataTable
        columns={columns}
        data={Array.from({ length: count }, (_, index) => receipt(index))}
      />
    </ReceiptsRealtimeContext.Provider>
  );

const tableRows = () => within(screen.getByRole("table")).getAllByRole("row");

describe(DataTable, () => {
  // jsdom has no `matchMedia`. Reduced motion is `true` so the reveal observer —
  // and the `IntersectionObserver` behind it — never runs; this test is about
  // pages, not motion.
  beforeAll(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: true,
        media: query,
      }))
    );
  });

  it("shows one page of rows and reports the range", () => {
    renderTable(PAGE_SIZE + 3);

    // The header row plus a full page.
    expect(tableRows()).toHaveLength(PAGE_SIZE + 1);
    expect(
      screen.getByText(`Showing 1-${PAGE_SIZE} of ${PAGE_SIZE + 3} receipts`)
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Previous" }).matches(":disabled")
    ).toBeTruthy();
  });

  it("moves through the pages and ends on the remaining rows", () => {
    renderTable(PAGE_SIZE * 2 + 3);

    const next = screen.getByRole("button", { name: "Next" });
    fireEvent.click(next);
    fireEvent.click(next);

    expect(tableRows()).toHaveLength(3 + 1);
    expect(
      screen.getByText(
        `Showing ${PAGE_SIZE * 2 + 1}-${PAGE_SIZE * 2 + 3} of ${PAGE_SIZE * 2 + 3} receipts`
      )
    ).toBeDefined();
    expect(next.matches(":disabled")).toBeTruthy();
  });

  it("stays on the page when the data changes underneath it", () => {
    const { rerender } = renderTable(PAGE_SIZE * 2);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Page 2 of 2")).toBeDefined();

    // What `router.refresh()` does when a receipt finishes: new array, same
    // receipts. The reader's page must survive it.
    rerender(
      <ReceiptsRealtimeContext.Provider value={realtimeValue}>
        <DataTable
          columns={columns}
          data={Array.from({ length: PAGE_SIZE * 2 }, (_, index) =>
            receipt(index)
          )}
        />
      </ReceiptsRealtimeContext.Provider>
    );

    expect(screen.getByText("Page 2 of 2")).toBeDefined();
  });

  it("returns to the first page when a filter changes", () => {
    renderTable(PAGE_SIZE * 2);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Page 2 of 2")).toBeDefined();

    // Eleven of the twenty match, so page two still exists — the reader goes to
    // page one because the list changed, not because the page ran out.
    fireEvent.change(screen.getByLabelText("Filter by merchant"), {
      target: { value: "Merchant 1" },
    });

    expect(screen.getByText("Page 1 of 2")).toBeDefined();
    expect(
      screen.getByText(`Showing 1-${PAGE_SIZE} of ${PAGE_SIZE + 1} receipts`)
    ).toBeDefined();
  });

  it("falls back to the last page when the list shrinks under it", () => {
    const { rerender } = renderTable(PAGE_SIZE * 2);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Page 2 of 2")).toBeDefined();

    // The last page's only receipt is deleted, so page two no longer exists.
    rerender(
      <ReceiptsRealtimeContext.Provider value={realtimeValue}>
        <DataTable
          columns={columns}
          data={Array.from({ length: PAGE_SIZE }, (_, index) => receipt(index))}
        />
      </ReceiptsRealtimeContext.Provider>
    );

    expect(screen.queryByText("Page 2 of 2")).toBeNull();
    expect(
      screen.getByText(`Showing 1-${PAGE_SIZE} of ${PAGE_SIZE} receipts`)
    ).toBeDefined();
  });

  it("takes its column widths from the column definitions, not the page", () => {
    renderTable(PAGE_SIZE * 2);

    // `table-fixed` plus a width per column is what stops a page of longer
    // merchants or dates from re-measuring the table between pages.
    expect(screen.getByRole("table").classList).toContain("table-fixed");
    expect(
      screen
        .getByRole("columnheader", { name: /^Merchant/u })
        .style.getPropertyValue("--column-width")
    ).toBe("20%");
  });
});
