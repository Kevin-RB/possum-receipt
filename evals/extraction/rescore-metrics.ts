import "temporal-polyfill/global";
import { z } from "zod";

import { summariseVariant } from "./reporting";
import {
  matchAmountPairs,
  matchAmounts,
  matchItemPairs,
  normaliseName,
  parseWallClock,
  scoreCategorization,
  scoreExtraction,
} from "./scoring";
import type {
  CategorizationGoldenItem,
  Extraction,
  ExtractionScores,
  ExtractionVariant,
  GoldenItem,
  GoldenReceipt,
  ItemMatch,
  RunIndex,
  RunRecord,
  RunsFile,
  VariantSummary,
} from "./types";
import { extractionVariants } from "./types";

/* -------------------------------------------------------------------------- */
/* Key readings                                                               */
/* -------------------------------------------------------------------------- */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * A golden `transactionDatetime` with no clock time. The photographs do not
 * print one for every receipt, so the key records the day alone; scoring it
 * against a midnight placeholder would invent a time nobody read.
 */
export const isDateOnly = (value: string | null): boolean =>
  value !== null && DATE_ONLY.test(value.trim());

/** True when the predicted wall clock falls on the golden date-only day. */
const sameDate = (
  goldenDate: string,
  predicted: string | undefined
): boolean => {
  const parsed = parseWallClock(predicted);
  return (
    parsed !== null && parsed.toPlainDate().toString() === goldenDate.trim()
  );
};

/* -------------------------------------------------------------------------- */
/* Field exactness                                                            */
/* -------------------------------------------------------------------------- */

export const RESCORE_FIELDS = [
  "merchantName",
  "merchantAbn",
  "merchantStoreId",
  "receiptNumber",
  "subtotal",
  "gst",
] as const;

export type RescoreField = (typeof RESCORE_FIELDS)[number];

const collapse = (value: string): string =>
  value.trim().replaceAll(/\s+/gu, " ").toLowerCase();

const textOrNull = (value: string | undefined): string | null => {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

const digitsOrNull = (value: string | undefined): string | null => {
  const digits = (value ?? "").replaceAll(/\D/gu, "");
  return digits === "" ? null : digits;
};

const centsOrNull = (value: number | undefined): number | null =>
  typeof value === "number" ? Math.round(value * 100) / 100 : null;

interface FieldDefinition {
  field: RescoreField;
  /** Golden values are already typed; predicted ones may be absent. */
  readGolden: (golden: GoldenReceipt) => string | number | null;
  readPredicted: (extraction: Extraction) => string | number | null;
  normalise: (value: string | number | null) => string | number | null;
}

/**
 * `merchantName` ignores case and whitespace, `merchantAbn` ignores spacing (a
 * printed ABN is grouped in threes), and the rest are exact after trimming,
 * with an empty string read as null. Every receipt's golden value is in the
 * denominator, so reading a value the paper does not print is a miss.
 */
const FIELD_DEFINITIONS: FieldDefinition[] = [
  {
    field: "merchantName",
    normalise: (value) => (value === null ? null : collapse(String(value))),
    readGolden: (golden) => golden.merchantName,
    readPredicted: (extraction) => extraction.merchant.name,
  },
  {
    field: "merchantAbn",
    normalise: (value) => (value === null ? null : digitsOrNull(String(value))),
    readGolden: (golden) => golden.merchantAbn,
    readPredicted: (extraction) => extraction.merchant.abn ?? null,
  },
  {
    field: "merchantStoreId",
    normalise: (value) => (value === null ? null : textOrNull(String(value))),
    readGolden: (golden) => golden.merchantStoreId,
    readPredicted: (extraction) => extraction.merchant.storeId ?? null,
  },
  {
    field: "receiptNumber",
    normalise: (value) => (value === null ? null : textOrNull(String(value))),
    readGolden: (golden) => golden.receiptNumber,
    readPredicted: (extraction) => extraction.transaction.receiptNumber ?? null,
  },
  {
    field: "subtotal",
    normalise: (value) =>
      typeof value === "number" ? centsOrNull(value) : null,
    readGolden: (golden) => golden.subtotal,
    readPredicted: (extraction) => centsOrNull(extraction.totals.subtotal),
  },
  {
    // Scored only where the key has a value: the draft key has none anywhere,
    // and "the paper prints no GST" cannot be a wrong answer.
    field: "gst",
    normalise: (value) =>
      typeof value === "number" ? centsOrNull(value) : null,
    readGolden: (golden) => golden.gst,
    readPredicted: (extraction) => centsOrNull(extraction.totals.gst),
  },
];

/* -------------------------------------------------------------------------- */
/* One run                                                                    */
/* -------------------------------------------------------------------------- */

export interface LineSnapshot {
  kind: string;
  lineTotal: number;
  name: string;
}

export const describeLine = (line: LineSnapshot): string =>
  `${line.name.trim()} @ ${line.lineTotal.toFixed(2)}${
    line.kind === "product" ? "" : ` [${line.kind}]`
  }`;

const goldenLine = (item: GoldenItem): LineSnapshot => ({
  kind: item.kind,
  lineTotal: item.lineTotal,
  name: item.name,
});

const predictedLine = (item: Extraction["items"][number]): LineSnapshot => ({
  kind: item.kind,
  lineTotal: item.lineTotal,
  name: item.name,
});

/** A failed run scores zero everywhere, exactly as the matrix recorded it. */
const failedScores = (): ExtractionScores => ({
  datetimeExact: null,
  gstReported: false,
  lineItemF1: null,
  lineItemMatch: null,
  paymentExact: null,
  reconcileMatches: null,
  schemaValid: false,
  totalExact: null,
});

const zeroMatch = (goldenCount: number): ItemMatch => ({
  f1: 0,
  golden: goldenCount,
  matched: 0,
  precision: 0,
  predicted: 0,
  recall: 0,
  unmatchedGolden: Array.from({ length: goldenCount }, (_, index) => index),
});

export interface RescoredRun {
  amount: ItemMatch;
  /** Golden lines no predicted line matched on amount alone. */
  amountUnmatchedGolden: LineSnapshot[];
  amountUnmatchedPredicted: LineSnapshot[];
  dateExact: boolean | null;
  failed: boolean;
  /** `null` where the field is not scored; a failed run is a miss. */
  fields: Record<RescoreField, boolean | null>;
  gstReported: boolean;
  nameExact: number;
  nameMatched: number;
  record: RunRecord;
  unmatchedGolden: LineSnapshot[];
  unmatchedPredicted: LineSnapshot[];
}

const failedRun = (golden: GoldenReceipt, record: RunRecord): RescoredRun => {
  const fields = {} as Record<RescoreField, boolean | null>;
  for (const definition of FIELD_DEFINITIONS) {
    fields[definition.field] =
      definition.field === "gst" && golden.gst === null ? null : false;
  }

  return {
    amount: zeroMatch(golden.items.length),
    amountUnmatchedGolden: golden.items.map(goldenLine),
    amountUnmatchedPredicted: [],
    dateExact: isDateOnly(golden.transactionDatetime) ? false : null,
    failed: true,
    fields,
    gstReported: false,
    nameExact: 0,
    nameMatched: 0,
    record: { ...record, scores: failedScores() },
    unmatchedGolden: golden.items.map(goldenLine),
    unmatchedPredicted: [],
  };
};

/**
 * Re-scores one recorded run against one key. Everything comes from the run's
 * own `extraction`, so the only input that varies between keys is the golden.
 */
export const rescoreRun = (
  golden: GoldenReceipt,
  record: RunRecord
): RescoredRun => {
  const { extraction } = record;
  if (extraction === null) {
    return failedRun(golden, record);
  }

  const pairs = matchItemPairs(golden.items, extraction.items);
  const pairedGolden = new Set(pairs.map((pair) => pair.goldenIndex));
  const pairedPredicted = new Set(pairs.map((pair) => pair.predictedIndex));
  let nameExact = 0;
  for (const pair of pairs) {
    const expected = golden.items[pair.goldenIndex];
    const actual = extraction.items[pair.predictedIndex];
    if (normaliseName(expected.name) === normaliseName(actual.name)) {
      nameExact += 1;
    }
  }

  const fields = {} as Record<RescoreField, boolean | null>;
  for (const definition of FIELD_DEFINITIONS) {
    const expected = definition.normalise(definition.readGolden(golden));
    const actual = definition.normalise(definition.readPredicted(extraction));
    const unscored = definition.field === "gst" && expected === null;
    fields[definition.field] = unscored ? null : expected === actual;
  }

  const scores = scoreExtraction(golden, extraction);
  const dateOnly = isDateOnly(golden.transactionDatetime);
  const amountPairs = matchAmountPairs(golden.items, extraction.items);
  const amountGolden = new Set(amountPairs.map((pair) => pair.goldenIndex));
  const amountPredicted = new Set(
    amountPairs.map((pair) => pair.predictedIndex)
  );
  // A date-only key never enters the datetime column: the two are reported
  // apart so a placeholder `00:00:00` cannot look like a read clock time.
  const rescored: ExtractionScores = dateOnly
    ? { ...scores, datetimeExact: null }
    : scores;

  return {
    amount: matchAmounts(golden.items, extraction.items),
    amountUnmatchedGolden: golden.items
      .map((item, index) => ({ index, item }))
      .filter(({ index }) => !amountGolden.has(index))
      .map(({ item }) => goldenLine(item)),
    amountUnmatchedPredicted: extraction.items
      .map((item, index) => ({ index, item }))
      .filter(({ index }) => !amountPredicted.has(index))
      .map(({ item }) => predictedLine(item)),
    dateExact: dateOnly
      ? sameDate(
          golden.transactionDatetime ?? "",
          extraction.transaction.datetime
        )
      : null,
    failed: false,
    fields,
    gstReported: scores.gstReported,
    nameExact,
    nameMatched: pairs.length,
    record: { ...record, scores: rescored },
    unmatchedGolden: golden.items
      .map((item, index) => ({ index, item }))
      .filter(({ index }) => !pairedGolden.has(index))
      .map(({ item }) => goldenLine(item)),
    unmatchedPredicted: extraction.items
      .map((item, index) => ({ index, item }))
      .filter(({ index }) => !pairedPredicted.has(index))
      .map(({ item }) => predictedLine(item)),
  };
};

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                */
/* -------------------------------------------------------------------------- */

export interface FieldCounts {
  exact: number;
  scored: number;
}

export interface MetricNumbers {
  amountF1Sum: number;
  amountPrecisionSum: number;
  amountRecallSum: number;
  date: FieldCounts;
  datetime: FieldCounts;
  f1Sum: number;
  fields: Record<RescoreField, FieldCounts>;
  gstReported: number;
  nameExact: number;
  nameMatched: number;
  paymentExact: number;
  reconcilePass: number;
  runs: number;
  schemaValid: number;
  totalExact: number;
}

const emptyFields = (): Record<RescoreField, FieldCounts> => ({
  gst: { exact: 0, scored: 0 },
  merchantAbn: { exact: 0, scored: 0 },
  merchantName: { exact: 0, scored: 0 },
  merchantStoreId: { exact: 0, scored: 0 },
  receiptNumber: { exact: 0, scored: 0 },
  subtotal: { exact: 0, scored: 0 },
});

export const emptyMetrics = (): MetricNumbers => ({
  amountF1Sum: 0,
  amountPrecisionSum: 0,
  amountRecallSum: 0,
  date: { exact: 0, scored: 0 },
  datetime: { exact: 0, scored: 0 },
  f1Sum: 0,
  fields: emptyFields(),
  gstReported: 0,
  nameExact: 0,
  nameMatched: 0,
  paymentExact: 0,
  reconcilePass: 0,
  runs: 0,
  schemaValid: 0,
  totalExact: 0,
});

/** A `null` outcome is unscored and leaves the denominator alone. */
const tally = (outcome: boolean | null, counts: FieldCounts): void => {
  if (outcome === null) {
    return;
  }
  counts.scored += 1;
  counts.exact += outcome ? 1 : 0;
};

export const measureRuns = (runs: RescoredRun[]): MetricNumbers => {
  const metrics = emptyMetrics();
  for (const run of runs) {
    metrics.runs += 1;
    const { scores } = run.record;
    if (scores?.schemaValid) {
      metrics.schemaValid += 1;
    }
    if (scores?.totalExact === true) {
      metrics.totalExact += 1;
    }
    if (scores?.paymentExact === true) {
      metrics.paymentExact += 1;
    }
    if (scores?.reconcileMatches === true) {
      metrics.reconcilePass += 1;
    }
    tally(scores?.datetimeExact ?? null, metrics.datetime);
    tally(run.dateExact, metrics.date);
    metrics.f1Sum += scores?.lineItemF1 ?? 0;
    metrics.amountPrecisionSum += run.amount.precision;
    metrics.amountRecallSum += run.amount.recall;
    metrics.amountF1Sum += run.amount.f1;
    metrics.nameExact += run.nameExact;
    metrics.nameMatched += run.nameMatched;
    metrics.gstReported += run.gstReported ? 1 : 0;
    for (const definition of FIELD_DEFINITIONS) {
      tally(run.fields[definition.field], metrics.fields[definition.field]);
    }
  }
  return metrics;
};

/** Adds one count set into another, in place. */
const merge = (into: FieldCounts, from: FieldCounts): void => {
  into.exact += from.exact;
  into.scored += from.scored;
};

/** Every counter is additive, so pooling variants just adds them up. */
export const poolMetrics = (list: MetricNumbers[]): MetricNumbers => {
  const pooled = emptyMetrics();
  for (const metrics of list) {
    pooled.amountF1Sum += metrics.amountF1Sum;
    pooled.amountPrecisionSum += metrics.amountPrecisionSum;
    pooled.amountRecallSum += metrics.amountRecallSum;
    merge(pooled.date, metrics.date);
    merge(pooled.datetime, metrics.datetime);
    pooled.f1Sum += metrics.f1Sum;
    pooled.gstReported += metrics.gstReported;
    pooled.nameExact += metrics.nameExact;
    pooled.nameMatched += metrics.nameMatched;
    pooled.paymentExact += metrics.paymentExact;
    pooled.reconcilePass += metrics.reconcilePass;
    pooled.runs += metrics.runs;
    pooled.schemaValid += metrics.schemaValid;
    pooled.totalExact += metrics.totalExact;
    for (const definition of FIELD_DEFINITIONS) {
      merge(pooled.fields[definition.field], metrics.fields[definition.field]);
    }
  }
  return pooled;
};

export const meanOf = (sum: number, runs: number): number | null =>
  runs === 0 ? null : sum / runs;

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

export interface KeyDigest {
  gst: number | null;
  hasIntegrityWarning: boolean;
  items: GoldenItem[];
  merchantAbn: string | null;
  merchantAddress: string | null;
  merchantName: string;
  merchantStoreId: string | null;
  paymentMethod: string;
  receiptNumber: string | null;
  subtotal: number | null;
  total: number;
  transactionDatetime: string | null;
}

export const keyDigest = (golden: GoldenReceipt): KeyDigest => ({
  gst: golden.gst,
  hasIntegrityWarning: golden.hasIntegrityWarning,
  items: golden.items,
  merchantAbn: golden.merchantAbn,
  merchantAddress: golden.merchantAddress,
  merchantName: golden.merchantName,
  merchantStoreId: golden.merchantStoreId,
  paymentMethod: golden.paymentMethod,
  receiptNumber: golden.receiptNumber,
  subtotal: golden.subtotal,
  total: golden.total,
  transactionDatetime: golden.transactionDatetime,
});

export interface ReceiptReport {
  id: string;
  key: KeyDigest;
  label: string;
  merchant: string;
  variants: Record<
    ExtractionVariant,
    { metrics: MetricNumbers; runs: RescoredRun[] }
  >;
}

export interface CategorizationRun {
  agreed: number;
  agreement: number;
  calls: number;
  cost: number | null;
  latencyMs: number;
  mismatches: { golden: string; name: string; predicted: string | null }[];
  run: number;
  total: number;
}

export interface RescoreReport {
  categorization: {
    meanAgreement: number | null;
    mismatches: {
      count: number;
      golden: string;
      name: string;
      predicted: string | null;
    }[];
    runs: CategorizationRun[];
  } | null;
  comparison: { differing: number; records: number } | null;
  detail: Record<ExtractionVariant, Record<string, RescoredRun[]>>;
  generatedAt: string;
  golden: GoldenReceipt[];
  goldenFilePath: string;
  key: { dateOnly: string[]; gst: string[] };
  label: string;
  model: string;
  numbers: Record<ExtractionVariant, MetricNumbers>;
  overall: MetricNumbers;
  receipts: ReceiptReport[];
  runs: RunIndex;
  runsFilePath: string;
  runsGeneratedAt: string;
  runsPerReceipt: number;
  summaries: Record<ExtractionVariant, VariantSummary>;
}

export interface RescoreReportInput {
  categorizationGolden: CategorizationGoldenItem[] | null;
  generatedAt: string;
  golden: GoldenReceipt[];
  goldenFilePath: string;
  label: string;
  runsFile: RunsFile;
  runsFilePath: string;
}

const sameScore = (
  left: ExtractionScores | null,
  right: ExtractionScores | null
): boolean => {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.datetimeExact === right.datetimeExact &&
    left.gstReported === right.gstReported &&
    left.lineItemF1 === right.lineItemF1 &&
    left.paymentExact === right.paymentExact &&
    left.reconcileMatches === right.reconcileMatches &&
    left.schemaValid === right.schemaValid &&
    left.totalExact === right.totalExact
  );
};

const buildCategorization = (
  records: RunRecord[],
  golden: CategorizationGoldenItem[] | null
): RescoreReport["categorization"] => {
  if (records.length === 0) {
    return null;
  }

  const runs: CategorizationRun[] = [];
  let agreementSum = 0;
  let agreementRuns = 0;
  const mismatchCounts = new Map<
    string,
    { count: number; golden: string; name: string; predicted: string | null }
  >();

  for (const record of records) {
    const scores =
      golden !== null && record.categories !== null
        ? scoreCategorization(golden, record.categories)
        : record.categorization;
    if (scores === null) {
      runs.push({
        agreed: 0,
        agreement: 0,
        calls: record.calls.length,
        cost: record.cost,
        latencyMs: record.latencyMs,
        mismatches: [],
        run: record.run,
        total: golden?.length ?? 0,
      });
      continue;
    }

    agreementSum += scores.agreement;
    agreementRuns += 1;
    for (const mismatch of scores.mismatches) {
      const key = `${mismatch.name}|${mismatch.golden}|${mismatch.predicted ?? "null"}`;
      const existing = mismatchCounts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        mismatchCounts.set(key, { count: 1, ...mismatch });
      }
    }
    runs.push({
      agreed: scores.agreed,
      agreement: scores.agreement,
      calls: record.calls.length,
      cost: record.cost,
      latencyMs: record.latencyMs,
      mismatches: scores.mismatches,
      run: record.run,
      total: scores.total,
    });
  }

  return {
    meanAgreement: agreementRuns === 0 ? null : agreementSum / agreementRuns,
    mismatches: [...mismatchCounts.values()].toSorted(
      (left, right) =>
        right.count - left.count || left.name.localeCompare(right.name)
    ),
    runs,
  };
};

/**
 * Re-scores every recorded run against `golden` and groups the results the way
 * the matrix did. Pure: no I/O, so the CLI is the only part that touches disk.
 */
export const buildRescoreReport = (
  input: RescoreReportInput
): RescoreReport => {
  const goldenById = new Map(input.golden.map((row) => [row.id, row]));
  const runs: RunIndex = {
    "A-fp8": { ...input.runsFile.runs["A-fp8"] },
    "A-free": { ...input.runsFile.runs["A-free"] },
    "B-fp8": { ...input.runsFile.runs["B-fp8"] },
    "C-fp8": { ...input.runsFile.runs["C-fp8"] },
    D: { ...input.runsFile.runs.D },
  };

  const detail = {} as Record<ExtractionVariant, Record<string, RescoredRun[]>>;
  let comparedRecords = 0;
  let differingRecords = 0;

  for (const variant of extractionVariants) {
    const byReceipt: Record<string, RescoredRun[]> = {};
    for (const [receiptId, records] of Object.entries(runs[variant])) {
      const golden = goldenById.get(receiptId);
      if (!golden) {
        throw new Error(
          `${input.runsFilePath} holds ${variant} runs for ${receiptId}, which the key does not have.`
        );
      }
      const rescored: RescoredRun[] = [];
      for (const record of records) {
        const run = rescoreRun(golden, record);
        comparedRecords += 1;
        if (!sameScore(record.scores, run.record.scores)) {
          differingRecords += 1;
        }
        rescored.push(run);
      }
      byReceipt[receiptId] = rescored;
      runs[variant][receiptId] = rescored.map((run) => run.record);
    }
    detail[variant] = byReceipt;
  }

  for (const record of runs.D.categorization ?? []) {
    if (input.categorizationGolden && record.categories) {
      record.categorization = scoreCategorization(
        input.categorizationGolden,
        record.categories
      );
    }
  }

  const numbers = {} as Record<ExtractionVariant, MetricNumbers>;
  const summaries = {} as Record<ExtractionVariant, VariantSummary>;
  for (const variant of extractionVariants) {
    const variantRuns = Object.values(detail[variant]).flat();
    numbers[variant] = measureRuns(variantRuns);
    summaries[variant] = summariseVariant(
      variant,
      Object.values(runs[variant]).flat()
    );
  }

  const receipts: ReceiptReport[] = input.golden.map((golden) => {
    const variants = {} as ReceiptReport["variants"];
    for (const variant of extractionVariants) {
      const variantRuns = detail[variant][golden.id] ?? [];
      variants[variant] = {
        metrics: measureRuns(variantRuns),
        runs: variantRuns,
      };
    }
    return {
      id: golden.id,
      key: keyDigest(golden),
      label: golden.id.slice(0, 8),
      merchant: golden.merchantName,
      variants,
    };
  });

  const recorded =
    Object.keys(runs.D).length === 0 ? [] : runs.D.categorization;

  return {
    categorization: buildCategorization(
      recorded ?? [],
      input.categorizationGolden
    ),
    comparison: { differing: differingRecords, records: comparedRecords },
    detail,
    generatedAt: input.generatedAt,
    golden: input.golden,
    goldenFilePath: input.goldenFilePath,
    key: {
      dateOnly: input.golden
        .filter((golden) => isDateOnly(golden.transactionDatetime))
        .map((golden) => golden.id),
      gst: input.golden
        .filter((golden) => golden.gst !== null)
        .map((golden) => golden.id),
    },
    label: input.label,
    model: input.runsFile.model,
    numbers,
    overall: poolMetrics(extractionVariants.map((variant) => numbers[variant])),
    receipts,
    runs,
    runsFilePath: input.runsFilePath,
    runsGeneratedAt: input.runsFile.generatedAt,
    runsPerReceipt: input.runsFile.runsPerReceipt,
    summaries,
  };
};

/* -------------------------------------------------------------------------- */
/* summary.json                                                               */
/* -------------------------------------------------------------------------- */

const fieldCountsSchema = z.object({ exact: z.number(), scored: z.number() });

const metricNumbersSchema = z.object({
  amountF1Sum: z.number(),
  amountPrecisionSum: z.number(),
  amountRecallSum: z.number(),
  date: fieldCountsSchema,
  datetime: fieldCountsSchema,
  f1Sum: z.number(),
  fields: z.object({
    gst: fieldCountsSchema,
    merchantAbn: fieldCountsSchema,
    merchantName: fieldCountsSchema,
    merchantStoreId: fieldCountsSchema,
    receiptNumber: fieldCountsSchema,
    subtotal: fieldCountsSchema,
  }),
  gstReported: z.number(),
  nameExact: z.number(),
  nameMatched: z.number(),
  paymentExact: z.number(),
  reconcilePass: z.number(),
  runs: z.number(),
  schemaValid: z.number(),
  totalExact: z.number(),
});

const lineSchema = z.object({
  kind: z.string(),
  lineTotal: z.number(),
  name: z.string(),
});

const goldenItemSchema = z.object({
  kind: z.string(),
  lineTotal: z.number(),
  name: z.string(),
  quantity: z.number().nullable(),
  unitPrice: z.number().nullable(),
});

const keyDigestSchema = z.object({
  gst: z.number().nullable(),
  hasIntegrityWarning: z.boolean(),
  items: z.array(goldenItemSchema),
  merchantAbn: z.string().nullable(),
  merchantAddress: z.string().nullable(),
  merchantName: z.string(),
  merchantStoreId: z.string().nullable(),
  paymentMethod: z.string(),
  receiptNumber: z.string().nullable(),
  subtotal: z.number().nullable(),
  total: z.number(),
  transactionDatetime: z.string().nullable(),
});

const lossRunSchema = z.object({
  amountUnmatchedGolden: z.array(lineSchema),
  amountUnmatchedPredicted: z.array(lineSchema),
  f1: z.number().nullable(),
  failed: z.boolean(),
  run: z.number(),
  unmatchedGolden: z.array(lineSchema),
  unmatchedPredicted: z.array(lineSchema),
});

const receiptSummarySchema = z.object({
  id: z.string(),
  key: keyDigestSchema,
  label: z.string(),
  merchant: z.string(),
  variants: z.record(
    z.string(),
    z.object({
      metrics: metricNumbersSchema,
      runs: z.array(lossRunSchema),
    })
  ),
});

export const summaryJsonSchema = z.object({
  categorization: z
    .object({
      meanAgreement: z.number().nullable(),
      mismatches: z.array(
        z.object({
          count: z.number(),
          golden: z.string(),
          name: z.string(),
          predicted: z.string().nullable(),
        })
      ),
      runs: z.array(
        z.object({
          agreed: z.number(),
          agreement: z.number(),
          calls: z.number(),
          cost: z.number().nullable(),
          latencyMs: z.number(),
          run: z.number(),
          total: z.number(),
        })
      ),
    })
    .nullable(),
  comparison: z
    .object({ differing: z.number(), records: z.number() })
    .nullable(),
  generatedAt: z.string(),
  goldenPath: z.string(),
  key: z.object({
    dateOnly: z.array(z.string()),
    gst: z.array(z.string()),
  }),
  label: z.string(),
  overall: metricNumbersSchema,
  receipts: z.array(receiptSummarySchema),
  runs: z.object({
    generatedAt: z.string(),
    model: z.string(),
    path: z.string(),
    runsPerReceipt: z.number(),
  }),
  variants: z.record(z.string(), metricNumbersSchema),
});

export type RescoreSummary = z.infer<typeof summaryJsonSchema>;

export const buildRescoreSummary = (report: RescoreReport): RescoreSummary => ({
  categorization:
    report.categorization === null
      ? null
      : {
          meanAgreement: report.categorization.meanAgreement,
          mismatches: report.categorization.mismatches,
          runs: report.categorization.runs.map((run) => ({
            agreed: run.agreed,
            agreement: run.agreement,
            calls: run.calls,
            cost: run.cost,
            latencyMs: run.latencyMs,
            run: run.run,
            total: run.total,
          })),
        },
  comparison: report.comparison,
  generatedAt: report.generatedAt,
  goldenPath: report.goldenFilePath,
  key: { dateOnly: report.key.dateOnly, gst: report.key.gst },
  label: report.label,
  overall: report.overall,
  receipts: report.receipts.map((receipt) => ({
    id: receipt.id,
    key: receipt.key,
    label: receipt.label,
    merchant: receipt.merchant,
    variants: Object.fromEntries(
      extractionVariants.map((variant) => [
        variant,
        {
          metrics: receipt.variants[variant].metrics,
          runs: receipt.variants[variant].runs.map((run) => ({
            amountUnmatchedGolden: run.amountUnmatchedGolden,
            amountUnmatchedPredicted: run.amountUnmatchedPredicted,
            f1: run.record.scores?.lineItemF1 ?? null,
            failed: run.failed,
            run: run.record.run,
            unmatchedGolden: run.unmatchedGolden,
            unmatchedPredicted: run.unmatchedPredicted,
          })),
        },
      ])
    ),
  })),
  runs: {
    generatedAt: report.runsGeneratedAt,
    model: report.model,
    path: report.runsFilePath,
    runsPerReceipt: report.runsPerReceipt,
  },
  variants: Object.fromEntries(
    extractionVariants.map((variant) => [variant, report.numbers[variant]])
  ),
});
