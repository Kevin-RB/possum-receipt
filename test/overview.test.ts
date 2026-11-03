import { describe, expect, it } from "vitest";

import {
  OTHER_MERCHANTS_LABEL,
  RANGE_ORDER,
  TOP_MERCHANTS,
  UNCATEGORISED_LABEL,
  UNCATEGORISED_SLUG,
  bucketKey,
  categorySpending,
  dailySpending,
  drilldownCount,
  drilldownTotal,
  integritySummary,
  merchantSpending,
  monthlySpending,
  rangeWindow,
  resolveBucket,
  scopeReceipts,
  spendingByRange,
  toggleBucket,
} from "@/lib/overview";
import type {
  ChartDatum,
  CountedReceipt,
  OverviewItem,
  OverviewReceipt,
  RangeKey,
} from "@/lib/overview";
import { simulateBrowserWithPolyfilledTemporal } from "@/test/polyfilled-temporal";

const TODAY = Temporal.PlainDate.from("2026-11-03");

const pad = (value: number): string => String(value).padStart(2, "0");

const isoDate = (year: number, month: number, day: number): string =>
  `${year}-${pad(month)}-${pad(day)}`;

/** A stored wall clock, the form Postgres returns for `timestamp`. */
const at = (year: number, month: number, day: number): string =>
  `${isoDate(year, month, day)} 12:00:00`;

let sequence = 0;
const nextId = (prefix: string): string => {
  sequence += 1;
  return `${prefix}-${sequence}`;
};

interface ReceiptSpec {
  date?: string | null;
  flagged?: boolean;
  items?: Partial<OverviewItem>[];
  merchant?: string | null;
  total?: number | null;
}

const receipt = (spec: ReceiptSpec = {}): OverviewReceipt => ({
  hasIntegrityWarning: spec.flagged ?? false,
  id: nextId("receipt"),
  items: (spec.items ?? []).map((overrides) => ({
    categoryName: "Groceries",
    categorySlug: "groceries",
    id: nextId("item"),
    kind: "product",
    lineTotal: 1,
    name: "Line item",
    ...overrides,
  })),
  merchantName: spec.merchant === undefined ? "Woolworths" : spec.merchant,
  total: spec.total === undefined ? 10 : spec.total,
  transactionDateTime: spec.date === undefined ? at(2026, 10, 1) : spec.date,
});

const item = (
  lineTotal: number,
  overrides: Partial<OverviewItem> = {}
): Partial<OverviewItem> => ({
  categoryName: "Groceries",
  categorySlug: "groceries",
  kind: "product",
  lineTotal,
  name: "Line item",
  ...overrides,
});

const totals = (data: ChartDatum[]): number[] =>
  data.map((datum) => datum.total);

const labels = (data: ChartDatum[]): string[] =>
  data.map((datum) => datum.label);

/** A receipt from one merchant on one mid-window day. */
const merchant = (name: string, total: number): OverviewReceipt =>
  receipt({ date: at(2026, 10, 10), merchant: name, total });

const totalOf = (data: ChartDatum[], label: string): number | undefined =>
  data.find((datum) => datum.label === label)?.total;

/** A window wide enough to count every receipt a test writes. */
const ALL_TIME = {
  end: Temporal.PlainDate.from("2099-12-31"),
  start: Temporal.PlainDate.from("2000-01-01"),
};

/** The corpus as a resolver sees it: only the receipts a chart can count. */
const counted = (receipts: OverviewReceipt[]): CountedReceipt[] =>
  scopeReceipts(receipts, ALL_TIME);

/** The receipt ids a drill-down lists, in panel order. */
const drilldownIds = (
  drilldown: ReturnType<typeof resolveBucket>
): (string | undefined)[] =>
  drilldown.kind === "receipts"
    ? drilldown.rows.map((row) => row.id)
    : drilldown.groups.map((group) => group.receipt.id);

describe(rangeWindow, () => {
  it("counts thirty whole days, today included", () => {
    const window = rangeWindow("30-days", TODAY);

    expect(window.start.toString()).toBe("2026-10-05");
    expect(window.end.toString()).toBe("2026-11-03");
  });

  it("counts trailing months to their day number", () => {
    expect(rangeWindow("2-months", TODAY).start.toString()).toBe("2026-09-03");
    expect(rangeWindow("3-months", TODAY).start.toString()).toBe("2026-08-03");
  });

  it("starts the 12-month window on the first of its earliest month", () => {
    const window = rangeWindow("12-months", TODAY);

    expect(window.start.toString()).toBe("2025-12-01");
    expect(window.end.toString()).toBe("2026-11-03");
  });
});

describe(scopeReceipts, () => {
  it("keeps receipts inside the window and drops the rest", () => {
    const scoped = scopeReceipts(
      [
        receipt({ date: at(2026, 10, 4) }),
        receipt({ date: at(2026, 10, 5) }),
        receipt({ date: at(2026, 11, 4) }),
        receipt({ date: null }),
      ],
      rangeWindow("30-days", TODAY)
    );

    expect(scoped.map((entry) => entry.transactionDateTime)).toStrictEqual([
      at(2026, 10, 5),
    ]);
  });

  it("drops receipts that printed no total, so a panel lists what a bar summed", () => {
    const scoped = counted([receipt({ total: 12 }), receipt({ total: null })]);

    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.total).toBe(12);
  });
});

describe(dailySpending, () => {
  const window = rangeWindow("30-days", TODAY);

  it("returns one bucket per day, covering the window", () => {
    const data = dailySpending([], window);

    expect(data).toHaveLength(30);
    expect(data[0]?.label).toBe("2026-10-05");
    expect(data.at(-1)?.label).toBe(TODAY.toString());
    expect(data[0]?.bucket).toStrictEqual({
      date: "2026-10-05",
      kind: "day",
    });
  });

  it("sums a receipt into its own spending day", () => {
    const data = dailySpending(
      [
        receipt({ date: at(2026, 10, 20), total: 12.34 }),
        receipt({ date: at(2026, 10, 20), total: 20 }),
        receipt({ date: at(2026, 10, 6), total: 5 }),
      ],
      window
    );

    expect(totalOf(data, "2026-10-20")).toBe(32.34);
    expect(totalOf(data, "2026-10-06")).toBe(5);
  });

  it("skips receipts without a total or a transaction datetime", () => {
    const data = dailySpending(
      [receipt({ total: null }), receipt({ date: null })],
      window
    );

    expect(totals(data).every((total) => total === 0)).toBeTruthy();
  });

  it("rounds totals to cents", () => {
    const data = dailySpending(
      [
        receipt({ date: at(2026, 10, 7), total: 0.1 }),
        receipt({ date: at(2026, 10, 7), total: 0.2 }),
      ],
      window
    );

    expect(totalOf(data, "2026-10-07")).toBe(0.3);
  });
});

describe(monthlySpending, () => {
  const window = rangeWindow("12-months", TODAY);

  it("renders twelve calendar months, the current one last", () => {
    const data = monthlySpending([], window);

    expect(data).toHaveLength(12);
    expect(labels(data)).toStrictEqual([
      "2025-12",
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
      "2026-11",
    ]);
    expect(data[0]?.bucket).toStrictEqual({ kind: "month", month: "2025-12" });
  });

  it("puts a receipt in exactly its own calendar month", () => {
    const data = monthlySpending(
      [
        receipt({ date: at(2026, 8, 1), total: 1 }),
        receipt({ date: at(2026, 8, 31), total: 2 }),
        receipt({ date: at(2026, 7, 31), total: 4 }),
        receipt({ date: at(2026, 9, 1), total: 8 }),
      ],
      window
    );

    expect(totalOf(data, "2026-08")).toBe(3);
    expect(totalOf(data, "2026-07")).toBe(4);
    expect(totalOf(data, "2026-09")).toBe(8);
  });

  it("drops a receipt from before the window's first month", () => {
    const data = monthlySpending(
      [receipt({ date: at(2025, 11, 30), total: 99 })],
      window
    );

    expect(totals(data).every((total) => total === 0)).toBeTruthy();
  });
});

describe(spendingByRange, () => {
  it("buckets the 12-month range by month and every other range by day", () => {
    for (const range of RANGE_ORDER) {
      const data = spendingByRange([], range, TODAY);
      const kinds = new Set(data.map((datum) => datum.bucket.kind));

      expect(kinds).toStrictEqual(
        new Set([range === "12-months" ? "month" : "day"])
      );
    }

    expect(spendingByRange([], "3-months", TODAY)).toHaveLength(93);
  });
});

describe(categorySpending, () => {
  const window = rangeWindow("30-days", TODAY);

  it("sums product line items per category, largest first", () => {
    const data = categorySpending(
      [
        receipt({
          date: at(2026, 10, 20),
          items: [
            item(5, { categoryName: "Groceries", categorySlug: "groceries" }),
            item(30, {
              categoryName: "Dining & Takeaway",
              categorySlug: "dining-takeaway",
            }),
          ],
        }),
        receipt({
          date: at(2026, 10, 21),
          items: [
            item(12.5, {
              categoryName: "Groceries",
              categorySlug: "groceries",
            }),
          ],
        }),
      ],
      window
    );

    expect(data).toStrictEqual([
      {
        bucket: { kind: "category", slug: "dining-takeaway" },
        label: "Dining & Takeaway",
        total: 30,
      },
      {
        bucket: { kind: "category", slug: "groceries" },
        label: "Groceries",
        total: 17.5,
      },
    ]);
  });

  it("counts only product items, never a discount or a surcharge", () => {
    const data = categorySpending(
      [
        receipt({
          date: at(2026, 10, 20),
          items: [
            item(20),
            item(-5, { kind: "discount", name: "Discount" }),
            item(0.5, { kind: "surcharge", name: "Card surcharge" }),
          ],
        }),
      ],
      window
    );

    expect(data).toStrictEqual([
      {
        bucket: { kind: "category", slug: "groceries" },
        label: "Groceries",
        total: 20,
      },
    ]);
  });

  it("collects uncategorised items under one bucket", () => {
    const data = categorySpending(
      [
        receipt({
          date: at(2026, 10, 20),
          items: [
            item(4, { categoryName: null, categorySlug: null }),
            item(6, { categoryName: null, categorySlug: null }),
          ],
        }),
      ],
      window
    );

    expect(data).toStrictEqual([
      {
        bucket: { kind: "category", slug: UNCATEGORISED_SLUG },
        label: UNCATEGORISED_LABEL,
        total: 10,
      },
    ]);
  });

  it("ignores items outside the window", () => {
    const data = categorySpending(
      [receipt({ date: at(2026, 9, 1), items: [item(99)] })],
      window
    );

    expect(data).toStrictEqual([]);
  });
});

describe(merchantSpending, () => {
  const window = rangeWindow("30-days", TODAY);

  it("draws the top five merchants plus one folded Other slice", () => {
    const data = merchantSpending(
      [
        merchant("A", 60),
        merchant("B", 50),
        merchant("C", 40),
        merchant("D", 30),
        merchant("E", 20),
        merchant("F", 10),
        merchant("G", 5),
      ],
      window
    );

    expect(data).toHaveLength(TOP_MERCHANTS + 1);
    expect(labels(data)).toStrictEqual(["A", "B", "C", "D", "E", "Other"]);
    expect(data.at(-1)).toStrictEqual({
      bucket: { kind: "other-merchants" },
      label: OTHER_MERCHANTS_LABEL,
      total: 15,
    });
  });

  it("omits Other when every merchant has its own slice", () => {
    const data = merchantSpending(
      [merchant("A", 60), merchant("B", 50)],
      window
    );

    expect(labels(data)).toStrictEqual(["A", "B"]);
  });

  it("skips receipts without a merchant name or a total", () => {
    const data = merchantSpending(
      [
        merchant("A", 60),
        receipt({ total: null }),
        receipt({ merchant: null }),
      ],
      window
    );

    expect(labels(data)).toStrictEqual(["A"]);
  });

  it("scopes to the window", () => {
    const data = merchantSpending(
      [
        merchant("A", 60),
        receipt({ date: at(2026, 1, 1), merchant: "B", total: 90 }),
      ],
      window
    );

    expect(labels(data)).toStrictEqual(["A"]);
  });
});

describe(integritySummary, () => {
  it("totals the flagged receipts it counts, out of every receipt it counts", () => {
    const summary = integritySummary([
      receipt({ flagged: true, total: 10 }),
      receipt({ flagged: true, total: 2.5 }),
      receipt({ total: 900 }),
      receipt({ total: null }),
      receipt({ date: null }),
    ]);

    expect(summary.datum).toStrictEqual({
      bucket: { kind: "integrity" },
      label: "Flagged",
      total: 12.5,
    });
    expect(summary.flagged).toHaveLength(2);
    expect(summary.total).toBe(3);
  });
});

describe(resolveBucket, () => {
  const window = rangeWindow("12-months", TODAY);

  it("lists the receipts of one spending day", () => {
    const scoped = scopeReceipts(
      [
        receipt({ date: at(2026, 10, 7), total: 5 }),
        receipt({ date: at(2026, 10, 8), total: 6 }),
      ],
      window
    );

    const drilldown = resolveBucket(
      { date: "2026-10-07", kind: "day" },
      scoped
    );

    expect(drilldown).toStrictEqual({
      kind: "receipts",
      rows: [
        {
          date: "2026-10-07",
          id: scoped[0]?.id,
          merchantName: "Woolworths",
          total: 5,
        },
      ],
    });
  });

  it("lists exactly one calendar month's receipts", () => {
    const scoped = counted([
      receipt({ date: at(2026, 8, 1) }),
      receipt({ date: at(2026, 8, 31) }),
      receipt({ date: at(2026, 9, 1) }),
    ]);

    const drilldown = resolveBucket(
      { kind: "month", month: "2026-08" },
      scoped
    );

    expect(drilldownIds(drilldown)).toStrictEqual([
      scoped[1]?.id,
      scoped[0]?.id,
    ]);
  });

  it("lists a merchant's receipts, newest first", () => {
    const scoped = counted([
      receipt({ date: at(2026, 10, 1), merchant: "Coles" }),
      receipt({ date: at(2026, 10, 2), merchant: "Woolworths" }),
      receipt({ date: at(2026, 10, 3), merchant: "Coles" }),
    ]);

    const drilldown = resolveBucket(
      { kind: "merchant", merchant: "Coles" },
      scoped
    );

    expect(drilldownIds(drilldown)).toStrictEqual([
      scoped[2]?.id,
      scoped[0]?.id,
    ]);
  });

  it("lists the complement of the top five for Other", () => {
    const scoped = counted(
      ["A", "B", "C", "D", "E", "F", "G"].map((name, index) =>
        receipt({
          date: at(2026, 10, index + 1),
          merchant: name,
          total: 100 - index * 10,
        })
      )
    );

    const drilldown = resolveBucket({ kind: "other-merchants" }, scoped);

    expect(drilldownIds(drilldown)).toStrictEqual([
      scoped[6]?.id,
      scoped[5]?.id,
    ]);
  });

  it("groups a category's product items under their receipt", () => {
    const scoped = counted([
      receipt({
        date: at(2026, 10, 1),
        items: [
          item(12, { categoryName: "Groceries", categorySlug: "groceries" }),
          item(3, { categoryName: "Bakery", categorySlug: "bakery" }),
        ],
        merchant: "Coles",
      }),
      receipt({
        date: at(2026, 10, 2),
        items: [
          item(8, { categoryName: "Groceries", categorySlug: "groceries" }),
          item(-2, {
            categoryName: "Groceries",
            categorySlug: "groceries",
            kind: "discount",
            name: "Discount",
          }),
        ],
        merchant: "Woolworths",
      }),
    ]);

    const drilldown = resolveBucket(
      { kind: "category", slug: "groceries" },
      scoped
    );

    if (drilldown.kind !== "items") {
      throw new Error("A category bucket lists items");
    }

    expect(drilldown.groups).toHaveLength(2);
    expect(
      drilldown.groups.map((group) => group.receipt.merchantName)
    ).toStrictEqual(["Woolworths", "Coles"]);
    // The discount is a line item but not a product one, and the bar never
    // counted it.
    expect(
      drilldown.groups[0]?.items.map((row) => row.lineTotal)
    ).toStrictEqual([8]);
    expect(
      drilldown.groups[1]?.items.map((row) => row.lineTotal)
    ).toStrictEqual([12]);
  });

  it("lists only flagged receipts for the integrity bucket", () => {
    const scoped = counted([
      receipt({ date: at(2026, 10, 1), flagged: true }),
      receipt({ date: at(2026, 10, 2) }),
    ]);

    const drilldown = resolveBucket({ kind: "integrity" }, scoped);

    expect(drilldownIds(drilldown)).toStrictEqual([scoped[0]?.id]);
  });

  it("leaves a receipt a chart cannot count out of every bucket", () => {
    const undated = counted([receipt({ date: null, flagged: true })]);
    const untotalled = counted([receipt({ flagged: true, total: null })]);

    expect(drilldownCount(resolveBucket({ kind: "integrity" }, undated))).toBe(
      0
    );
    expect(
      drilldownCount(resolveBucket({ kind: "integrity" }, untotalled))
    ).toBe(0);
  });
});

describe(drilldownTotal, () => {
  it("sums the receipt rows to cents", () => {
    const scoped = counted([
      receipt({ date: at(2026, 10, 7), total: 0.1 }),
      receipt({ date: at(2026, 10, 7), total: 0.2 }),
    ]);

    const drilldown = resolveBucket(
      { date: "2026-10-07", kind: "day" },
      scoped
    );

    expect(drilldownCount(drilldown)).toBe(2);
    expect(drilldownTotal(drilldown)).toBe(0.3);
  });

  it("counts line items, not receipts, for a category bucket", () => {
    const scoped = counted([
      receipt({
        items: [item(5), item(6)],
      }),
    ]);

    const drilldown = resolveBucket(
      { kind: "category", slug: "groceries" },
      scoped
    );

    expect(drilldownCount(drilldown)).toBe(2);
    expect(drilldownTotal(drilldown)).toBe(11);
  });
});

describe(toggleBucket, () => {
  it("closes the datum that is already open", () => {
    expect(
      toggleBucket(
        { date: "2026-10-07", kind: "day" },
        { date: "2026-10-07", kind: "day" }
      )
    ).toBeNull();
  });

  it("replaces one datum with another", () => {
    expect(
      toggleBucket(
        { date: "2026-10-07", kind: "day" },
        {
          kind: "merchant",
          merchant: "Coles",
        }
      )
    ).toStrictEqual({ kind: "merchant", merchant: "Coles" });
  });

  it("opens a datum when nothing is selected", () => {
    expect(toggleBucket(null, { kind: "integrity" })).toStrictEqual({
      kind: "integrity",
    });
  });

  it("distinguishes two merchants with the same total", () => {
    expect(bucketKey({ kind: "merchant", merchant: "Coles" })).not.toBe(
      bucketKey({ kind: "merchant", merchant: "Woolworths" })
    );
  });
});

/**
 * The fixture corpus the property test walks: fourteen months of receipts
 * across seven merchants, with product, discount and surcharge line items, an
 * uncategorised one, flagged and unflagged receipts, a receipt with no total,
 * one with no spending day, one before every window and one dated in the
 * future.
 */
const corpus: OverviewReceipt[] = [
  receipt({
    date: at(2026, 11, 3),
    items: [
      item(30),
      item(12.5, { categoryName: "Dairy & Eggs", categorySlug: "dairy-eggs" }),
    ],
    merchant: "Woolworths",
    total: 42.5,
  }),
  receipt({
    date: at(2026, 11, 1),
    flagged: true,
    items: [item(18)],
    merchant: "Coles",
    total: 18,
  }),
  receipt({
    date: at(2026, 10, 15),
    items: [
      item(60),
      item(-1.8, { kind: "discount", name: "Markdown" }),
      item(5, { kind: "surcharge", name: "Card surcharge" }),
    ],
    merchant: "Aldi",
    total: 63.2,
  }),
  receipt({
    date: at(2026, 10, 2),
    items: [
      item(89.9, {
        categoryName: "Home & Garden",
        categorySlug: "home-garden",
      }),
    ],
    merchant: "Bunnings",
    total: 89.9,
  }),
  receipt({
    date: at(2026, 9, 20),
    flagged: true,
    items: [
      item(499, { categoryName: "Electronics", categorySlug: "electronics" }),
    ],
    merchant: "JB Hi-Fi",
    total: 499,
  }),
  receipt({
    date: at(2026, 9, 3),
    items: [
      item(25, {
        categoryName: null,
        categorySlug: null,
        name: "Sticky notes",
      }),
    ],
    merchant: "Officeworks",
    total: 25,
  }),
  receipt({
    date: at(2026, 8, 11),
    items: [
      item(14.5, {
        categoryName: "Home & Garden",
        categorySlug: "home-garden",
      }),
    ],
    merchant: "Kmart",
    total: 14.5,
  }),
  receipt({
    date: at(2026, 8, 31),
    items: [item(75)],
    merchant: "Woolworths",
    total: 75,
  }),
  receipt({
    date: at(2026, 7, 5),
    items: [item(30)],
    merchant: "Coles",
    total: 30,
  }),
  receipt({
    date: at(2026, 6, 1),
    items: [item(12)],
    merchant: "Aldi",
    total: 12,
  }),
  receipt({
    date: at(2025, 12, 24),
    flagged: true,
    items: [item(210)],
    merchant: "Woolworths",
    total: 210,
  }),
  receipt({
    date: at(2025, 11, 24),
    items: [item(40)],
    merchant: "Coles",
    total: 40,
  }),
  receipt({
    date: at(2026, 12, 25),
    merchant: "Woolworths",
    total: 99,
  }),
  receipt({ date: at(2026, 11, 2), merchant: "Coles", total: null }),
  receipt({ date: null, merchant: "Woolworths", total: 55 }),
];

interface ChartCase {
  data: ChartDatum[];
  /** The chart's name, for failure messages. */
  name: string;
  /** The corpus the chart aggregated — and the one its panel resolves. */
  scope: CountedReceipt[];
}

/**
 * Every datum of every chart, for one range, paired with the corpus each chart
 * was aggregated from.
 *
 * The integrity card has no period selector: its gauge counts the whole loaded
 * corpus, so its panel resolves that same array rather than a windowed slice.
 */
const chartsFor = (range: RangeKey): ChartCase[] => {
  const scoped = scopeReceipts(corpus, rangeWindow(range, TODAY));

  return [
    {
      data: spendingByRange(corpus, range, TODAY),
      name: "spending",
      scope: scoped,
    },
    {
      data: categorySpending(corpus, rangeWindow(range, TODAY)),
      name: "category",
      scope: scoped,
    },
    {
      data: merchantSpending(corpus, rangeWindow(range, TODAY)),
      name: "merchant",
      scope: scoped,
    },
    {
      data: [integritySummary(corpus).datum],
      name: "integrity",
      scope: integritySummary(corpus).flagged,
    },
  ];
};

const datumsFor = (
  range: RangeKey
): { chart: ChartCase; datum: ChartDatum }[] =>
  chartsFor(range).flatMap((chart) =>
    chart.data.map((datum) => ({ chart, datum }))
  );

const datums = (): { chart: ChartCase; datum: ChartDatum }[] =>
  RANGE_ORDER.flatMap((range) => datumsFor(range));

describe("every chart datum resolves to a panel that sums to it", () => {
  it("walks all four charts, in both grains, across every range", () => {
    const kinds = new Set(datums().map(({ datum }) => datum.bucket.kind));

    // Without this, the equality below could be a statement about empty arrays.
    expect([...kinds].toSorted()).toStrictEqual([
      "category",
      "day",
      "integrity",
      "merchant",
      "month",
      "other-merchants",
    ]);
    expect(datums().length).toBeGreaterThan(40);
  });

  it("equals the datum's total for every bucket and every range", () => {
    const mismatches = datums()
      .filter(
        ({ chart, datum }) =>
          drilldownTotal(resolveBucket(datum.bucket, chart.scope)) !==
          datum.total
      )
      .map(({ datum }) => bucketKey(datum.bucket));

    expect(mismatches).toStrictEqual([]);
  });

  it("lists the rows behind every bucket that holds money", () => {
    const empty = datums()
      .filter(
        ({ chart, datum }) =>
          datum.total !== 0 &&
          drilldownCount(resolveBucket(datum.bucket, chart.scope)) === 0
      )
      .map(({ datum }) => bucketKey(datum.bucket));

    expect(empty).toStrictEqual([]);
  });

  it("keeps every chart non-empty", () => {
    const sizes = RANGE_ORDER.flatMap((range) =>
      chartsFor(range).map((chart) => chart.data.length)
    );

    expect(Math.min(...sizes)).toBeGreaterThan(0);
  });

  it("opens an empty state, not nothing, for an empty bucket", () => {
    const emptyDay = resolveBucket(
      { date: "2026-10-09", kind: "day" },
      scopeReceipts(corpus, rangeWindow("30-days", TODAY))
    );

    expect(emptyDay).toStrictEqual({ kind: "receipts", rows: [] });
  });
});

describe("with only the polyfill installed (older browsers)", () => {
  simulateBrowserWithPolyfilledTemporal();

  it("computes windows, buckets and drill-downs", () => {
    const window = rangeWindow("12-months", TODAY);

    expect(window.start.toString()).toBe("2025-12-01");

    const december = monthlySpending(corpus, window).find(
      (datum) => datum.label === "2025-12"
    );
    const drilldown = december
      ? resolveBucket(december.bucket, scopeReceipts(corpus, window))
      : null;

    expect(december?.total).toBe(210);
    expect(drilldown === null ? null : drilldownTotal(drilldown)).toBe(210);
  });
});
