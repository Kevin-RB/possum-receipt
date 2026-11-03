// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DrilldownPanel } from "@/components/overview/drilldown-panel";
import type { Drilldown } from "@/lib/overview";

const body = (drilldown: Drilldown): string => {
  const { container } = render(<DrilldownPanel drilldown={drilldown} />);
  return container.textContent ?? "";
};

describe(DrilldownPanel, () => {
  it("heads a receipt panel with its count and the sum of its rows", () => {
    const text = body({
      kind: "receipts",
      rows: [
        {
          date: "2026-11-03",
          id: "receipt-1",
          merchantName: "Woolworths",
          total: 400,
        },
        {
          date: "2026-11-01",
          id: "receipt-2",
          merchantName: "Coles",
          total: 12.3,
        },
      ],
    });

    expect(text).toContain("2 receipts · $412.30");
    expect(text).toContain("Woolworths");
    expect(text).toContain("3 Nov 2026");
  });

  it("links every receipt row to its receipt page", () => {
    render(
      <DrilldownPanel
        drilldown={{
          kind: "receipts",
          rows: [
            {
              date: "2026-11-03",
              id: "receipt-1",
              merchantName: "Woolworths",
              total: 400,
            },
          ],
        }}
      />
    );

    expect(
      screen.getByRole("link", { name: /Woolworths/u }).getAttribute("href")
    ).toBe("/receipts/receipt-1");
  });

  it("shows an empty state rather than nothing for an empty bucket", () => {
    const text = body({ kind: "receipts", rows: [] });

    expect(text).toContain("0 receipts · $0.00");
    expect(text).toContain("Nothing in this period to show.");
  });

  it("heads a category panel with its line-item count and total", () => {
    const text = body({
      groups: [
        {
          items: [
            { id: "item-1", lineTotal: 12, name: "Sourdough" },
            { id: "item-2", lineTotal: 8.5, name: "Milk" },
          ],
          receipt: {
            date: "2026-11-03",
            id: "receipt-1",
            merchantName: "Woolworths",
            total: 20.5,
          },
        },
      ],
      kind: "items",
    });

    expect(text).toContain("2 line items · $20.50");
    expect(text).toContain("Sourdough");
    expect(text).toContain("Milk");
  });

  it("links a category item's receipt to its receipt page", () => {
    render(
      <DrilldownPanel
        drilldown={{
          groups: [
            {
              items: [
                { id: "item-1", lineTotal: 12, name: "Sourdough" },
                { id: "item-2", lineTotal: 8.5, name: "Milk" },
              ],
              receipt: {
                date: "2026-11-03",
                id: "receipt-1",
                merchantName: "Woolworths",
                total: 20.5,
              },
            },
          ],
          kind: "items",
        }}
      />
    );

    expect(
      screen.getByRole("link", { name: /Woolworths/u }).getAttribute("href")
    ).toBe("/receipts/receipt-1");
  });

  it("names a receipt with no merchant rather than leaving the row blank", () => {
    const text = body({
      kind: "receipts",
      rows: [
        {
          date: "2026-11-03",
          id: "receipt-1",
          merchantName: null,
          total: 12.5,
        },
      ],
    });

    expect(text).toContain("Unknown merchant");
    expect(text).toContain("1 receipt · $12.50");
  });
});
