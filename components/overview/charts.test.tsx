// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CategorySpendingChart } from "@/components/overview/category-spending-chart";
import { SpendingChart } from "@/components/overview/spending-chart";
import type { SpendingBucket } from "@/lib/overview";

/**
 * The chart's window is built from the day the server resolved and handed in,
 * never from the clock the component happens to run on: a client component is
 * server-rendered too, and the two clocks disagree for any viewer outside the
 * server's zone — a hydration mismatch on every overview load, and a rightmost
 * bar sitting on a day that has not started for that viewer.
 *
 * Recharts' own drawing is not what is under test, so `BarChart` is replaced by
 * a capture of the data it was given.
 */
const captured = vi.hoisted(() => [] as SpendingBucket[][]);

// @ts-expect-error recharts' chart props are generic over the datum, so a stub
// that only records what it was handed cannot match them.
vi.mock(import("recharts"), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    BarChart: ({ data }: { data: SpendingBucket[] }) => {
      captured.push(data);
      return null;
    },
  };
});

const TODAY = "2026-10-07";

const latest = (): SpendingBucket[] => captured.at(-1) ?? [];

describe("the overview charts' window", () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it("ends the daily window on the day it was given", () => {
    render(<SpendingChart receipts={[]} today={TODAY} />);

    const buckets = latest();

    expect(buckets).toHaveLength(30);
    expect(buckets.at(-1)?.label).toBe(TODAY);
    expect(buckets[0]?.label).toBe("2026-09-08");
  });

  it("puts that day's spending in its last bucket", () => {
    render(
      <SpendingChart
        receipts={[{ total: 42.5, transactionDateTime: `${TODAY} 09:15:00` }]}
        today={TODAY}
      />
    );

    expect(latest().at(-1)).toStrictEqual({ label: TODAY, total: 42.5 });
  });

  it("keeps the category window's last day and drops anything after it", () => {
    render(
      <CategorySpendingChart
        rows={[
          { categoryName: "Bakery", date: TODAY, total: 5 },
          { categoryName: "Bakery", date: "2026-10-08", total: 99 },
        ]}
        today={TODAY}
      />
    );

    expect(latest()).toStrictEqual([{ label: "Bakery", total: 5 }]);
  });
});
