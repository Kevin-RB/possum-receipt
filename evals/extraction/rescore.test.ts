import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ExtractionEvalUsageError } from "./args";
import { parseRescoreArgs, readGoldenFile, readRunsFile } from "./rescore";
import {
  isDateOnly,
  measureRuns,
  poolMetrics,
  rescoreRun,
} from "./rescore-report";
import { matchAmounts, matchItemPairs } from "./scoring";
import type { Extraction, GoldenReceipt, RunRecord } from "./types";

const golden = (overrides: Partial<GoldenReceipt> = {}): GoldenReceipt => ({
  gst: null,
  hasIntegrityWarning: false,
  id: "receipt",
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
  ...overrides,
});

const extraction = (overrides: Partial<Extraction> = {}): Extraction => ({
  items: [{ kind: "product", lineTotal: 3.4, name: "Milk 1L", quantity: 1 }],
  merchant: { name: "Woolworths" },
  payment: { method: "card" },
  totals: { total: 3.4 },
  transaction: { datetime: "2026-07-28T18:51:00" },
  ...overrides,
});

const record = (overrides: Partial<RunRecord> = {}): RunRecord => ({
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
  receiptId: "receipt",
  run: 1,
  scores: null,
  strictFallback: false,
  transcript: null,
  variant: "A-free",
  ...overrides,
});

describe(isDateOnly, () => {
  it("accepts a bare day and nothing else", () => {
    expect(isDateOnly("2026-07-25")).toBeTruthy();
    expect(isDateOnly("2026-07-25T00:00:00")).toBeFalsy();
    expect(isDateOnly("2026-07-25T16:39:25")).toBeFalsy();
    expect(isDateOnly(null)).toBeFalsy();
  });
});

describe(matchAmounts, () => {
  it("ignores names, so a rename still matches", () => {
    const result = matchAmounts(
      [
        {
          kind: "product",
          lineTotal: 3.55,
          name: "Sml Fries",
          quantity: 1,
          unitPrice: null,
        },
      ],
      [{ kind: "product", lineTotal: 3.55, name: "Small Fries", quantity: 1 }]
    );
    expect(result.matched).toBe(1);
    expect(result.f1).toBe(1);
  });

  it("requires the same kind, so a discount recorded as a product misses", () => {
    const result = matchAmounts(
      [
        {
          kind: "discount",
          lineTotal: -2,
          name: "Promo",
          quantity: 1,
          unitPrice: null,
        },
      ],
      [{ kind: "product", lineTotal: -2, name: "Promo", quantity: 1 }]
    );
    expect(result.matched).toBe(0);
    expect(result.unmatchedGolden).toStrictEqual([0]);
  });

  it("ignores the sign but not a cent of drift", () => {
    const flipped = matchAmounts(
      [
        {
          kind: "discount",
          lineTotal: -57,
          name: "Promo",
          quantity: 1,
          unitPrice: null,
        },
      ],
      [{ kind: "discount", lineTotal: 57, name: "Promo", quantity: 1 }]
    );
    expect(flipped.matched).toBe(1);

    const drifted = matchAmounts(
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
    expect(drifted.matched).toBe(0);
  });
});

describe(matchItemPairs, () => {
  it("returns the indexes it paired, one-to-one", () => {
    const pairs = matchItemPairs(
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
    expect(pairs).toStrictEqual([
      { goldenIndex: 0, predictedIndex: 1 },
      { goldenIndex: 1, predictedIndex: 0 },
    ]);
  });
});

describe(rescoreRun, () => {
  it("scores a date-only key on the day and leaves datetime unscored", () => {
    const key = golden({ transactionDatetime: "2026-07-25" });
    const sameDay = rescoreRun(
      key,
      record({
        extraction: extraction({
          transaction: { datetime: "2026-07-25T00:00:00" },
        }),
      })
    );
    expect(sameDay.dateExact).toBeTruthy();
    expect(sameDay.record.scores?.datetimeExact).toBeNull();

    const laterThatDay = rescoreRun(
      key,
      record({
        extraction: extraction({
          transaction: { datetime: "2026-07-25T16:39:25" },
        }),
      })
    );
    expect(laterThatDay.dateExact).toBeTruthy();

    const otherDay = rescoreRun(
      key,
      record({
        extraction: extraction({
          transaction: { datetime: "2026-07-26T16:39:25" },
        }),
      })
    );
    expect(otherDay.dateExact).toBeFalsy();
  });

  it("keeps the minute comparison for a key that prints a time", () => {
    const key = golden({ transactionDatetime: "2026-11-07T16:39:25" });
    const sameMinute = rescoreRun(
      key,
      record({
        extraction: extraction({
          transaction: { datetime: "2026-11-07T16:39:00" },
        }),
      })
    );
    expect(sameMinute.dateExact).toBeNull();
    expect(sameMinute.record.scores?.datetimeExact).toBeTruthy();

    const settled = rescoreRun(
      key,
      record({
        extraction: extraction({
          transaction: { datetime: "2026-11-07T16:41:00" },
        }),
      })
    );
    expect(settled.record.scores?.datetimeExact).toBeFalsy();
  });

  it("leaves GST unscored when the key has none", () => {
    const run = rescoreRun(golden(), record());
    expect(run.fields.gst).toBeNull();
    expect(run.gstReported).toBeFalsy();
  });

  it("scores GST where the key has one, and a missing one is a miss", () => {
    const key = golden({ gst: 0.31 });
    const read = rescoreRun(
      key,
      record({ extraction: extraction({ totals: { gst: 0.31, total: 3.4 } }) })
    );
    expect(read.fields.gst).toBeTruthy();

    const missing = rescoreRun(key, record());
    expect(missing.fields.gst).toBeFalsy();
  });

  it("compares an ABN by digits and a merchant name by case", () => {
    const key = golden({ merchantAbn: "90 196 565 019" });
    const run = rescoreRun(
      key,
      record({
        extraction: extraction({
          merchant: { abn: "90196565019", name: "  woolworths " },
        }),
      })
    );
    expect(run.fields.merchantAbn).toBeTruthy();
    expect(run.fields.merchantName).toBeTruthy();
  });

  it("scores a failed run as zero everywhere", () => {
    const run = rescoreRun(
      golden(),
      record({ error: { message: "boom", name: "Error" }, extraction: null })
    );
    expect(run.failed).toBeTruthy();
    expect(run.record.scores).toStrictEqual({
      datetimeExact: null,
      gstReported: false,
      lineItemF1: null,
      lineItemMatch: null,
      paymentExact: null,
      reconcileMatches: null,
      schemaValid: false,
      totalExact: null,
    });
    expect(run.fields.merchantName).toBeFalsy();
    expect(run.amount.f1).toBe(0);
    expect(run.unmatchedGolden.map((line) => line.name)).toStrictEqual([
      "Milk 1L",
    ]);
  });

  it("reports the leftover predicted line beside the missed golden line", () => {
    const run = rescoreRun(
      golden(),
      record({
        extraction: extraction({
          items: [
            { kind: "product", lineTotal: 3.4, name: "Bread", quantity: 1 },
          ],
        }),
      })
    );
    expect(run.unmatchedGolden.map((line) => line.name)).toStrictEqual([
      "Milk 1L",
    ]);
    expect(run.unmatchedPredicted.map((line) => line.name)).toStrictEqual([
      "Bread",
    ]);
    expect(run.amount.matched).toBe(1);
    expect(run.nameMatched).toBe(0);
  });
});

describe(measureRuns, () => {
  it("counts a failed run in the denominator and as zero F1", () => {
    const ok = rescoreRun(golden(), record());
    const failed = rescoreRun(golden(), record({ extraction: null, run: 2 }));
    const metrics = measureRuns([ok, failed]);
    expect(metrics.runs).toBe(2);
    expect(metrics.schemaValid).toBe(1);
    expect(metrics.f1Sum).toBe(1);
    expect(metrics.fields.merchantName).toStrictEqual({ exact: 1, scored: 2 });
    expect(metrics.gstReported).toBe(0);
  });

  it("pools additively", () => {
    const one = measureRuns([rescoreRun(golden(), record())]);
    const two = measureRuns([
      rescoreRun(golden(), record()),
      rescoreRun(golden({ id: "other" }), record({ run: 2 })),
    ]);
    const pooled = poolMetrics([one, two, poolMetrics([])]);
    expect(pooled.runs).toBe(3);
    expect(pooled.f1Sum).toBe(3);
    expect(pooled.nameMatched).toBe(3);
    expect(pooled.date.scored).toBe(0);
    expect(pooled.datetime.scored).toBe(3);
  });
});

describe(parseRescoreArgs, () => {
  it("refuses an unknown flag", () => {
    expect(() =>
      parseRescoreArgs(["--runs", "a", "--golden", "b", "--out", "c", "--nope"])
    ).toThrow(ExtractionEvalUsageError);
  });

  it("requires runs, golden and out", () => {
    expect(() => parseRescoreArgs(["--runs", "a"])).toThrow(
      /--runs, --golden and --out are required/u
    );
  });

  it("defaults the label to the key's filename", () => {
    const options = parseRescoreArgs([
      "--runs",
      "runs.json",
      "--golden",
      "/tmp/key.proposed.json",
      "--out",
      "out",
    ]);
    expect(options.label).toBe("key.proposed");
    expect(options.comparePath).toBeNull();
    expect(options.categorizationPath).toBeNull();
  });
});

const write = async (value: unknown): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "rescore-"));
  const file = path.join(dir, "key.json");
  await writeFile(file, JSON.stringify(value));
  return file;
};

describe("key loading", () => {
  it("accepts a bare array and drops undocumented keys", async () => {
    const file = await write(
      [[{ ...golden(), notes: { other: "hi" } }]].flat()
    );
    const [row] = await readGoldenFile(file);
    expect(row.id).toBe("receipt");
    expect("notes" in row).toBeFalsy();
  });

  it("accepts { receipts: [...] }", async () => {
    const file = await write({ receipts: [golden()] });
    const rows = await readGoldenFile(file);
    expect(rows).toHaveLength(1);
  });

  it("refuses a key with no receipts", async () => {
    const file = await write({ receipts: [] });
    await expect(readGoldenFile(file)).rejects.toThrow(
      ExtractionEvalUsageError
    );
  });

  it("refuses a runs file that holds no A runs", async () => {
    const file = await write({
      generatedAt: "2026-11-19T00:00:00.000Z",
      model: "model",
      runs: { D: {} },
      runsPerReceipt: 3,
      spend: { aborted: false, reason: null, totalUsd: 0 },
      strictOutputs: true,
    });
    await expect(readRunsFile(file)).rejects.toThrow(/holds no A runs/u);
  });

  it("reads a runs file into the shape the matrix writes", async () => {
    const file = await write({
      generatedAt: "2026-11-19T00:00:00.000Z",
      model: "model",
      runs: { "A-free": { receipt: [record()] } },
      runsPerReceipt: 3,
      spend: { aborted: false, reason: null, totalUsd: 0 },
      strictOutputs: true,
    });
    const runs = await readRunsFile(file);
    expect(Object.keys(runs.runs)).toStrictEqual([
      "A-fp8",
      "A-free",
      "B-fp8",
      "C-fp8",
      "D",
    ]);
    expect(runs.runs["A-free"].receipt).toHaveLength(1);
    expect(runs.runs["B-fp8"]).toStrictEqual({});
  });
});
