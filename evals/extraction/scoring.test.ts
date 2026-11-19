import { describe, expect, it } from "vitest";

import {
  describeGoldenItem,
  levenshtein,
  matchItems,
  nameSimilarity,
  normaliseName,
  parseWallClock,
  scoreCategorization,
  scoreExtraction,
} from "./scoring";
import type { Extraction, GoldenReceipt } from "./types";

const extraction = (overrides: Partial<Extraction> = {}): Extraction => ({
  items: [{ kind: "product", lineTotal: 1.99, name: "Milk 1L", quantity: 1 }],
  merchant: { name: "Woolworths" },
  payment: { method: "card" },
  totals: { total: 1.99 },
  transaction: { datetime: "2026-07-28T18:51:00" },
  ...overrides,
});

const golden = (overrides: Partial<GoldenReceipt> = {}): GoldenReceipt => ({
  gst: null,
  hasIntegrityWarning: false,
  id: "receipt",
  items: [
    {
      kind: "product",
      lineTotal: 1.99,
      name: "Milk 1L",
      quantity: 1,
      unitPrice: null,
    },
  ],
  merchantAbn: null,
  merchantAddress: null,
  merchantName: "Woolworths",
  merchantStoreId: null,
  paymentMethod: "card",
  receiptNumber: null,
  subtotal: null,
  total: 1.99,
  transactionDatetime: "2026-07-28T18:51:00",
  ...overrides,
});

describe("name normalisation", () => {
  it("lowercases and collapses punctuation and whitespace", () => {
    expect(normaliseName("  NICE N' TASTY  CHICKE 400GRAM ")).toBe(
      "nice n tasty chicke 400gram"
    );
  });

  it("measures edit distance over the normalised strings", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(nameSimilarity("Small Big Mac Meal", "Small Big Mac Meal")).toBe(1);
    expect(
      nameSimilarity("1 Sml Fries 3.55", "Small Big Mac Mea")
    ).toBeLessThan(0.75);
  });
});

describe(matchItems, () => {
  it("matches as a multiset, not by index", () => {
    const result = matchItems(
      [
        {
          kind: "product",
          lineTotal: 3.4,
          name: "Milk",
          quantity: 1,
          unitPrice: null,
        },
        {
          kind: "product",
          lineTotal: 15.5,
          name: "Chicken",
          quantity: 1,
          unitPrice: null,
        },
      ],
      [
        { kind: "product", lineTotal: 15.5, name: "Chicken", quantity: 1 },
        { kind: "product", lineTotal: 3.4, name: "Milk", quantity: 1 },
      ]
    );
    expect(result.matched).toBe(2);
    expect(result.f1).toBe(1);
    expect(result.unmatchedGolden).toStrictEqual([]);
  });

  it("requires the amount within a cent and the name at least 0.75 similar", () => {
    const result = matchItems(
      [
        {
          kind: "product",
          lineTotal: 3.4,
          name: "Milk",
          quantity: 1,
          unitPrice: null,
        },
      ],
      [{ kind: "product", lineTotal: 3.42, name: "Milk", quantity: 1 }]
    );
    expect(result.matched).toBe(0);
    expect(result.unmatchedGolden).toStrictEqual([0]);
  });

  it("takes the best pair when two candidates are one-to-one", () => {
    const result = matchItems(
      [
        {
          kind: "product",
          lineTotal: 5,
          name: "Blueberries 170g",
          quantity: 1,
          unitPrice: null,
        },
      ],
      [
        {
          kind: "product",
          lineTotal: 5,
          name: "Blueberries 125g",
          quantity: 1,
        },
        {
          kind: "product",
          lineTotal: 5,
          name: "Blueberries 170g",
          quantity: 1,
        },
      ]
    );
    expect(result.matched).toBe(1);
    expect(result.precision).toBe(0.5);
  });

  it("scores zero when nothing is predicted", () => {
    const result = matchItems(
      [
        {
          kind: "product",
          lineTotal: 1,
          name: "Milk",
          quantity: 1,
          unitPrice: null,
        },
      ],
      []
    );
    expect(result.f1).toBe(0);
    expect(result.precision).toBe(0);
    expect(result.recall).toBe(0);
  });
});

describe(parseWallClock, () => {
  it("accepts the shapes a model emits", () => {
    expect(parseWallClock("2026-07-28T18:51:00Z")?.minute).toBe(51);
    expect(parseWallClock("2026-07-28T18:51")?.minute).toBe(51);
    expect(parseWallClock("2026-07-28 18:51:00")?.hour).toBe(18);
    expect(parseWallClock("2026-07-28T18:51:00+10:00")?.hour).toBe(18);
    expect(parseWallClock("2026-07-28T18:51:00.123")?.second).toBe(0);
  });

  it("treats a date-only value as midnight rather than throwing", () => {
    const parsed = parseWallClock("2026-07-28");
    expect(parsed?.hour).toBe(0);
    expect(parsed?.minute).toBe(0);
  });

  it("returns null for nothing usable", () => {
    expect(parseWallClock("")).toBeNull();
    expect(parseWallClock(null)).toBeNull();
    expect(parseWallClock("not a date")).toBeNull();
  });
});

describe(scoreExtraction, () => {
  it("scores an exact read", () => {
    const scores = scoreExtraction(golden(), extraction());
    expect(scores.totalExact).toBeTruthy();
    expect(scores.datetimeExact).toBeTruthy();
    expect(scores.paymentExact).toBeTruthy();
    expect(scores.reconcileMatches).toBeTruthy();
    expect(scores.lineItemF1).toBe(1);
  });

  it("reports GST only when one came back", () => {
    const scores = scoreExtraction(golden(), extraction());
    expect(scores.schemaValid).toBeTruthy();
    expect(scores.gstReported).toBeFalsy();
  });

  it("leaves datetime unscored when the golden key has none", () => {
    const scores = scoreExtraction(
      golden({ transactionDatetime: null }),
      extraction()
    );
    expect(scores.datetimeExact).toBeNull();
  });

  it("tolerates half a cent on the total", () => {
    const scores = scoreExtraction(
      golden({ total: 1.99 }),
      extraction({ totals: { total: 1.994 } })
    );
    expect(scores.totalExact).toBeTruthy();
  });

  it("reports GST when the model read it", () => {
    const scores = scoreExtraction(
      golden(),
      extraction({ totals: { gst: 0.18, total: 1.99 } })
    );
    expect(scores.gstReported).toBeTruthy();
  });

  it("fails reconciliation when the lines do not add to the total", () => {
    const scores = scoreExtraction(
      golden({ total: 10 }),
      extraction({ totals: { total: 10 } })
    );
    expect(scores.reconcileMatches).toBeFalsy();
  });
});

describe("categorization scoring", () => {
  it("counts exact slug agreement and names the mismatches", () => {
    const scores = scoreCategorization(
      [
        { categorySlug: "produce", kind: "product", name: "Carrots" },
        { categorySlug: "pantry", kind: "product", name: "Rice" },
      ],
      ["produce", null]
    );
    expect(scores.agreed).toBe(1);
    expect(scores.agreement).toBe(0.5);
    expect(scores.mismatches).toStrictEqual([
      { golden: "pantry", name: "Rice", predicted: null },
    ]);
  });
});

describe(describeGoldenItem, () => {
  it("labels a line with its amount", () => {
    expect(
      describeGoldenItem({
        kind: "product",
        lineTotal: 3.55,
        name: " Small Big Mac Mea ",
        quantity: 1,
        unitPrice: null,
      })
    ).toBe("Small Big Mac Mea @ 3.55");
  });
});
