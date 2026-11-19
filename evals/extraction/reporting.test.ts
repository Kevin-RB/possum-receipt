import { describe, expect, it } from "vitest";

import type { CategoryOption } from "@/lib/ai/categorize";

import {
  buildDisputes,
  buildSummaryMarkdown,
  flattenRuns,
  summariseVariant,
} from "./reporting";
import { scoreExtraction } from "./scoring";
import type { Extraction, GoldenReceipt, RunIndex, RunRecord } from "./types";

const extraction = (overrides: Partial<Extraction> = {}): Extraction => ({
  items: [{ kind: "product", lineTotal: 3.4, name: "Milk 1L", quantity: 1 }],
  merchant: { abn: "", name: "Woolworths" },
  payment: { method: "card" },
  totals: { total: 3.4 },
  transaction: { datetime: "2026-07-28T18:51:00" },
  ...overrides,
});

const golden: GoldenReceipt = {
  gst: null,
  hasIntegrityWarning: false,
  id: "receipt-1",
  items: [
    {
      kind: "product",
      lineTotal: 3.4,
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
  total: 3.4,
  transactionDatetime: "2026-07-28T18:51:00",
};

const run = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  calls: [
    {
      cost: 0.0004,
      error: null,
      host: "Wafer",
      inputTokens: 100,
      latencyMs: 2000,
      outputTokens: 50,
    },
  ],
  categories: null,
  categorization: null,
  cost: 0.0004,
  error: null,
  extraction: extraction(),
  host: "Wafer",
  hosts: ["Wafer"],
  inputTokens: 100,
  latencyMs: 2000,
  outputTokens: 50,
  receiptId: "receipt-1",
  run: 1,
  scores: {
    datetimeExact: true,
    gstReported: false,
    lineItemF1: 1,
    lineItemMatch: {
      f1: 1,
      golden: 1,
      matched: 1,
      precision: 1,
      predicted: 1,
      recall: 1,
      unmatchedGolden: [],
    },
    paymentExact: true,
    reconcileMatches: true,
    schemaValid: true,
    totalExact: true,
  },
  strictFallback: false,
  transcript: null,
  variant: "A-free",
  ...overrides,
});

/** A run whose scores are consistent with its extraction. */
const runWith = (
  value: Extraction,
  overrides: Partial<RunRecord> = {}
): RunRecord =>
  run({
    extraction: value,
    scores: scoreExtraction(golden, value),
    ...overrides,
  });

const failed = (variant: RunRecord["variant"]): RunRecord => ({
  ...run(),
  calls: [],
  cost: null,
  error: { message: "APICallError: 400", name: "APICallError" },
  extraction: null,
  scores: {
    datetimeExact: null,
    gstReported: false,
    lineItemF1: null,
    lineItemMatch: null,
    paymentExact: null,
    reconcileMatches: null,
    schemaValid: false,
    totalExact: null,
  },
  variant,
});

const runs = (records: RunRecord[]): RunIndex => ({
  "A-fp8": {},
  "A-free": { "receipt-1": records.filter((r) => r.variant === "A-free") },
  "B-fp8": {},
  "C-fp8": {},
  D: {},
});

describe(summariseVariant, () => {
  it("counts a failed run against the pass rates and as zero F1", () => {
    const summary = summariseVariant("A-free", [run(), failed("A-free")]);
    expect(summary.runs).toBe(2);
    expect(summary.schemaValid).toBe(1);
    expect(summary.totalExact).toBe(1);
    expect(summary.datetimeScored).toBe(1);
    expect(summary.meanF1).toBe(0.5);
  });

  it("averages cost over the runs that reported one", () => {
    const summary = summariseVariant("A-free", [run(), failed("A-free")]);
    expect(summary.meanCost).toBeCloseTo(0.0004);
  });

  it("excludes unscored dates from the datetime denominator", () => {
    const base = run();
    const document = run({
      scores: base.scores
        ? { ...base.scores, datetimeExact: null }
        : base.scores,
    });
    const summary = summariseVariant("A-free", [document]);
    expect(summary.datetimeScored).toBe(0);
    expect(summary.datetimeExact).toBe(0);
  });
});

describe(flattenRuns, () => {
  it("walks every variant and receipt", () => {
    expect(flattenRuns(runs([run(), failed("A-free")]))).toHaveLength(2);
  });
});

const build = (records: RunRecord[]) =>
  buildDisputes({
    corpus: [
      {
        bytes: 1,
        height: 1,
        id: "receipt-1",
        imagePath: "images/receipt-1-shop.jpg",
        merchant: "Woolworths",
        objectKey: "key",
        sha256: "0".repeat(64),
        total: 3.4,
        transactionDatetime: "2026-07-28T18:51:00",
        width: 1,
      },
    ],
    generatedAt: "2026-11-19T00:00:00.000Z",
    golden: new Map([["receipt-1", golden]]),
    runs: runs(records),
  });

describe(buildDisputes, () => {
  it("groups observed scalar values by variant and treats blank as null", () => {
    const file = build([
      run(),
      run({
        extraction: extraction({
          merchant: { abn: undefined, name: "Woolworths" },
        }),
      }),
    ]);
    const [receipt] = file.receipts;
    expect(receipt.fields.merchantAbn.golden).toBeNull();
    expect(receipt.fields.merchantAbn.disputed).toBeFalsy();
    expect(receipt.fields.merchantAbn.observed).toStrictEqual([
      { count: 2, value: null, variants: { "A-free": 2 } },
    ]);
    expect(receipt.fields.merchantAbn.proposed).toBeNull();
  });

  it("flags a value the golden key does not have", () => {
    const file = build([
      runWith(extraction({ transaction: { datetime: "2026-07-25T12:00:00" } })),
    ]);
    const field = file.receipts[0].fields.transactionDatetime;
    expect(field.golden).toBe("2026-07-28T18:51:00");
    expect(field.disputed).toBeTruthy();
    expect(field.observed[0]?.value).toBe("2026-07-25T12:00:00");
  });

  it("has no items entry when the multiset is reproduced", () => {
    const file = build([run()]);
    expect(file.receipts[0].items).toBeNull();
  });

  it("lists the unmatched golden lines when it is not", () => {
    const file = build([
      runWith(
        extraction({
          items: [
            { kind: "product", lineTotal: 9.99, name: "Bread", quantity: 1 },
          ],
        })
      ),
    ]);
    const [{ items }] = file.receipts;
    expect(items?.runs[0]?.predictedCount).toBe(1);
    expect(items?.runs[0]?.matchedCount).toBe(0);
    expect(items?.unmatchedGolden).toStrictEqual(["Milk 1L @ 3.40"]);
  });

  it("rounds numbers to the cent before comparing", () => {
    const file = build([
      run({ extraction: extraction({ totals: { total: 3.400001 } }) }),
    ]);
    expect(file.receipts[0].fields.total.disputed).toBeFalsy();
    expect(file.receipts[0].fields.total.observed[0]?.value).toBe(3.4);
  });
});

describe(buildSummaryMarkdown, () => {
  it("states the spend and includes every variant", () => {
    const categories: CategoryOption[] = [
      { name: "Groceries", parentName: null, slug: "groceries" },
    ];
    const records = [run(), failed("A-free")];
    const markdown = buildSummaryMarkdown({
      categories,
      categorizationGoldenLength: 46,
      corpus: [
        {
          bytes: 1,
          height: 1,
          id: "receipt-1",
          imagePath: "images/receipt-1-shop.jpg",
          merchant: "Woolworths",
          objectKey: "key",
          sha256: "0".repeat(64),
          total: 3.4,
          transactionDatetime: "2026-07-28T18:51:00",
          width: 1,
        },
      ],
      generatedAt: "2026-11-19T00:00:00.000Z",
      guard: { aborted: false, reason: null, totalUsd: 0.0008 },
      notes: ["Smoke test ok."],
      runs: runs(records),
      runsPerReceipt: 3,
      sessionCalls: records.flatMap((record) => record.calls),
      strictOutputs: true,
    });

    expect(markdown).toContain("Total measured spend for the whole session");
    expect(markdown).toContain("$0.0008");
    expect(markdown).toContain("Smoke test ok.");
    expect(markdown).toContain(
      "Structured outputs: `structuredOutputs.strict: true`"
    );
  });

  it("tabulates every extraction variant", () => {
    const markdown = buildSummaryMarkdown({
      categories: [],
      categorizationGoldenLength: 46,
      corpus: [],
      generatedAt: "2026-11-19T00:00:00.000Z",
      guard: { aborted: false, reason: null, totalUsd: 0 },
      notes: [],
      runs: runs([]),
      runsPerReceipt: 3,
      sessionCalls: [],
      strictOutputs: true,
    });

    expect(markdown).toContain("A-free");
    expect(markdown).toContain("C-fp8");
  });
});
