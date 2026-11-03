// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CategorySpendingChart } from "@/components/overview/category-spending-chart";
import { MerchantSpendingChart } from "@/components/overview/merchant-spending-chart";
import { SpendingChart } from "@/components/overview/spending-chart";
import type { ChartDatum, OverviewReceipt } from "@/lib/overview";

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
