// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CategorySpendingChart } from "@/components/overview/category-spending-chart";
import { MerchantSpendingChart } from "@/components/overview/merchant-spending-chart";
import { SpendingChart } from "@/components/overview/spending-chart";
import type { ChartDatum, OverviewReceipt } from "@/lib/overview";
import { formatDayTooltipLabel } from "@/lib/overview-chart";

/**
 * The chart's window is built from the day the server resolved and handed in,
 * never from the clock the component happens to run on: a client component is
 * server-rendered too, and the two clocks disagree for any viewer outside the
 * server's zone — a hydration mismatch on every overview load, and a rightmost
 * bar sitting on a day that has not started for that viewer.
 *
 * Recharts' own drawing is not what is under test, so `BarChart` and `Pie` are
 * replaced by captures of the data they were given.
 */
const bars = vi.hoisted(() => [] as ChartDatum[][]);
const pies = vi.hoisted(() => [] as ChartDatum[][]);

// @ts-expect-error recharts' chart props are generic over the datum, so stubs
// that only record what they were handed cannot match them.
vi.mock(import("recharts"), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    BarChart: ({ data }: { data: ChartDatum[] }) => {
      bars.push(data);
      return null;
    },
    Pie: ({ data }: { data: ChartDatum[] }) => {
      pies.push(data);
      return null;
    },
  };
});

const TODAY = "2026-11-03";

const receipt = (
  overrides: Partial<OverviewReceipt> = {}
): OverviewReceipt => ({
  hasIntegrityWarning: false,
  id: `receipt-${overrides.total ?? 0}`,
  items: [],
  merchantName: "Woolworths",
  total: 10,
  transactionDateTime: `${TODAY} 09:15:00`,
  ...overrides,
});

const latestBar = (): ChartDatum[] => bars.at(-1) ?? [];

const latestPie = (): ChartDatum[] => pies.at(-1) ?? [];

/**
 * The chart's data list, opened by its own toggle.
 *
 * Each card carries one, and each names itself from the chart, so the three
 * "Show data" buttons are told apart by the accessible name alone.
 */
const showData = (title: string) => {
  fireEvent.click(
    screen.getByRole("button", { name: `Show data for ${title}` })
  );
};

describe("the overview charts' window", () => {
  beforeEach(() => {
    bars.length = 0;
    pies.length = 0;
  });

  it("ends the daily window on the day it was given", () => {
    render(<SpendingChart receipts={[]} today={TODAY} />);

    const buckets = latestBar();

    expect(buckets).toHaveLength(30);
    expect(buckets.at(-1)?.label).toBe(TODAY);
    expect(buckets[0]?.label).toBe("2026-10-05");
  });

  it("puts that day's spending in its last bucket", () => {
    render(
      <SpendingChart receipts={[receipt({ total: 42.5 })]} today={TODAY} />
    );

    expect(latestBar().at(-1)).toStrictEqual({
      bucket: { date: TODAY, kind: "day" },
      label: TODAY,
      total: 42.5,
    });
  });

  it("keeps the category window's last day and drops anything after it", () => {
    render(
      <CategorySpendingChart
        receipts={[
          receipt({
            items: [
              {
                categoryName: "Bakery",
                categorySlug: "bakery",
                id: "item-1",
                kind: "product",
                lineTotal: 5,
                name: "Sourdough",
              },
            ],
            transactionDateTime: `${TODAY} 08:00:00`,
          }),
          receipt({
            items: [
              {
                categoryName: "Bakery",
                categorySlug: "bakery",
                id: "item-2",
                kind: "product",
                lineTotal: 99,
                name: "Tomorrow's loaf",
              },
            ],
            transactionDateTime: "2026-11-04 08:00:00",
          }),
        ]}
        today={TODAY}
      />
    );

    expect(latestBar()).toStrictEqual([
      {
        bucket: { kind: "category", slug: "bakery" },
        label: "Bakery",
        total: 5,
      },
    ]);
  });

  it("draws at most six merchant slices, with Other last", () => {
    const merchants = ["A", "B", "C", "D", "E", "F", "G"];

    render(
      <MerchantSpendingChart
        receipts={merchants.map((merchantName, index) =>
          receipt({ merchantName, total: 100 - index * 10 })
        )}
        today={TODAY}
      />
    );

    const slices = latestPie();

    expect(slices).toHaveLength(6);
    expect(slices.at(-1)).toMatchObject({
      bucket: { kind: "other-merchants" },
      label: "Other",
      // F and G are the two smallest of the seven merchants.
      total: 90,
    });
  });

  it("defaults the merchant chart to the last 30 days", () => {
    render(
      <MerchantSpendingChart
        receipts={[
          receipt({ merchantName: "Inside", total: 10 }),
          receipt({
            merchantName: "Outside",
            total: 90,
            transactionDateTime: "2026-06-01 09:00:00",
          }),
        ]}
        today={TODAY}
      />
    );

    expect(latestPie().map((datum) => datum.label)).toStrictEqual(["Inside"]);
  });
});

/**
 * A bar or a slice opens its drill-down only through recharts' `onClick`, which
 * a keyboard cannot reach: the accessibility layer moves a tooltip with the
 * arrow keys, but Enter on a mark does nothing. Each chart therefore draws the
 * same data as a list of real buttons, and these tests hold that path to the
 * panel the pointer path opens — same toggle, same rows, same count.
 */
describe("the overview charts' data lists", () => {
  beforeEach(() => {
    bars.length = 0;
    pies.length = 0;
  });

  it("lists every bucket the chart drew, each as an unpressed button", () => {
    render(<SpendingChart receipts={[]} today={TODAY} />);

    showData("Spending");

    // The daily chart draws a bar for all thirty days, empty ones included.
    expect(screen.getAllByRole("button", { pressed: false })).toHaveLength(30);
    expect(screen.getByRole("list", { name: "Spending data" }).tagName).toBe(
      "UL"
    );
  });

  it("names a day's row with the day and its total, unpressed until opened", () => {
    render(
      <SpendingChart
        receipts={[receipt({ id: "receipt-1", total: 42.5 })]}
        today={TODAY}
      />
    );

    showData("Spending");

    // The amount is unique to the day with spending, so the row is found the
    // way a reader hears it rather than by an ISO date.
    const day = screen.getByRole("button", { name: /\$42\.50/u });

    // A real button is what makes Enter open the panel — recharts' marks are
    // shapes, which no keyboard can activate.
    expect(day.tagName).toBe("BUTTON");
    expect(day.textContent).toContain(formatDayTooltipLabel(TODAY));
    expect(day.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByText("1 receipt")).toBeNull();
  });

  it("opens a day's drill-down from its list row, and closes it again", () => {
    render(
      <SpendingChart
        receipts={[receipt({ id: "receipt-1", total: 42.5 })]}
        today={TODAY}
      />
    );

    showData("Spending");

    const day = screen.getByRole("button", { name: /\$42\.50/u });

    fireEvent.click(day);

    expect(day.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("1 receipt")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Woolworths/u }).getAttribute("href")
    ).toBe("/receipts/receipt-1");

    fireEvent.click(day);

    expect(day.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByText("1 receipt")).toBeNull();
  });

  it("opens a category's line items from its list row", () => {
    render(
      <CategorySpendingChart
        receipts={[
          receipt({
            id: "receipt-1",
            items: [
              {
                categoryName: "Bakery",
                categorySlug: "bakery",
                id: "item-1",
                kind: "product",
                lineTotal: 5,
                name: "Sourdough",
              },
            ],
            total: 5,
          }),
        ]}
        today={TODAY}
      />
    );

    showData("Spending by category");

    const bakery = screen.getByRole("button", { name: /Bakery/u });

    fireEvent.click(bakery);

    expect(bakery.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("1 line item")).toBeTruthy();
    expect(screen.getByText("Sourdough")).toBeTruthy();
  });

  it("opens a merchant's receipts from its list row", () => {
    render(
      <MerchantSpendingChart
        receipts={[
          receipt({ id: "receipt-1", merchantName: "Woolworths", total: 42.5 }),
        ]}
        today={TODAY}
      />
    );

    showData("Spending by merchant");

    const slice = screen.getByRole("button", { name: /Woolworths/u });

    fireEvent.click(slice);

    expect(slice.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("1 receipt")).toBeTruthy();
  });

  it("makes the scroll strip a focusable region a keyboard can pan", () => {
    render(<SpendingChart receipts={[]} today={TODAY} />);

    const strip = screen.getByRole("region", {
      name: "Spending by day, scrollable",
    });

    expect(strip.tabIndex).toBe(0);
    expect(strip.className).toContain("overview-chart-scroll");
  });
});
