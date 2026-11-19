import "temporal-polyfill/global";
import { z } from "zod";

import {
  formatLatency,
  formatUsd,
  markdownTable,
  summariseVariant,
  VARIANT_TABLE_HEADERS,
  variantTableRows,
} from "./reporting";
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
  DisputesFile,
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

const emptyMetrics = (): MetricNumbers => ({
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

/* -------------------------------------------------------------------------- */
/* summary.md                                                                 */
/* -------------------------------------------------------------------------- */

const count = (numerator: number, denominator: number): string =>
  `${numerator}/${denominator}`;

const ratio = (sum: number, runs: number): string => {
  const value = meanOf(sum, runs);
  return value === null ? "—" : value.toFixed(3);
};

const fieldCell = (counts: FieldCounts): string =>
  counts.scored === 0 ? "—" : count(counts.exact, counts.scored);

const dateCell = (metrics: MetricNumbers): string =>
  metrics.datetime.scored === 0
    ? "—"
    : `${count(metrics.datetime.exact, metrics.datetime.scored)}${
        metrics.datetime.scored < metrics.runs
          ? ` (${metrics.runs - metrics.datetime.scored} unscored)`
          : ""
      }`;

const dateOnlyCell = (metrics: MetricNumbers): string =>
  metrics.date.scored === 0
    ? "—"
    : count(metrics.date.exact, metrics.date.scored);

const recordedIds = (report: RescoreReport) => {
  const labels = new Map(report.receipts.map((r) => [r.id, r.label]));
  return (ids: string[]): string =>
    ids.length === 0
      ? "none"
      : ids.map((id) => labels.get(id) ?? id).join(", ");
};

const lossesSection = (report: RescoreReport): string => {
  const blocks: string[] = [];
  let clean = 0;
  for (const receipt of report.receipts) {
    for (const variant of extractionVariants) {
      const { runs, metrics } = receipt.variants[variant];
      if (runs.length === 0) {
        continue;
      }
      const failed = runs.filter((run) => run.failed).length;
      const lost = runs.filter(
        (run) =>
          run.failed ||
          run.unmatchedGolden.length > 0 ||
          run.unmatchedPredicted.length > 0
      );
      if (lost.length === 0) {
        clean += 1;
        continue;
      }
      const lines = lost.map((run) => {
        const missed = run.unmatchedGolden.map(describeLine);
        const spare = run.unmatchedPredicted.map(describeLine);
        const parts: string[] = [];
        if (failed > 0 && run.failed) {
          parts.push("the run failed");
        }
        if (missed.length > 0) {
          parts.push(
            `missed ${missed.map((line) => `\`${line}\``).join(", ")}`
          );
        }
        if (spare.length > 0) {
          parts.push(
            `left over ${spare.map((line) => `\`${line}\``).join(", ")}`
          );
        }
        return `  - run ${run.record.run}: ${parts.join("; ")}`;
      });
      blocks.push(
        [
          `**${receipt.label} · ${variant}** — mean F1 ${ratio(
            metrics.f1Sum,
            metrics.runs
          )}, amount F1 ${ratio(metrics.amountF1Sum, metrics.runs)}${
            failed > 0 ? `, ${failed} failed` : ""
          }`,
          ...lines,
        ].join("\n")
      );
    }
  }
  const note =
    clean === 0
      ? ""
      : `Every golden line matched in every run for the other ${clean} receipt × variant pairs.\n\n`;
  return `${note}${blocks.join("\n\n")}`;
};

const moneyLossTable = (report: RescoreReport): string => {
  const rows: string[][] = [];
  for (const receipt of report.receipts) {
    for (const variant of extractionVariants) {
      for (const run of receipt.variants[variant].runs) {
        if (run.amountUnmatchedGolden.length === 0) {
          continue;
        }
        rows.push([
          receipt.label,
          variant,
          `${run.record.run}`,
          run.amountUnmatchedGolden.map(describeLine).join(", "),
          run.amountUnmatchedPredicted.map(describeLine).join(", ") || "—",
        ]);
      }
    }
  }
  return rows.length === 0
    ? "No run missed a golden amount."
    : markdownTable(
        [
          "receipt",
          "variant",
          "run",
          "golden line missed",
          "predicted line left over",
        ],
        rows
      );
};

const categorizationSection = (report: RescoreReport): string => {
  const section = report.categorization;
  if (section === null) {
    return "## Categorization (variant D)\n\nNo categorization runs recorded.\n";
  }

  const rows = section.runs.map((run) => [
    `${run.run}`,
    count(run.agreed, run.total),
    run.agreement.toFixed(3),
    `${run.calls}`,
    formatUsd(run.cost),
    formatLatency(run.latencyMs),
  ]);
  const mismatchRows = section.mismatches.map((entry) => [
    entry.name,
    entry.golden,
    entry.predicted ?? "null",
    `${entry.count}`,
  ]);

  return [
    "## Categorization (variant D)",
    "",
    "Agreement is exact slug equality, re-scored with `scoreCategorization` where the predicted slugs are recorded.",
    "",
    `Mean agreement: **${section.meanAgreement === null ? "—" : section.meanAgreement.toFixed(3)}** over ${section.runs.length} runs.`,
    "",
    markdownTable(
      ["run", "agreement", "ratio", "calls", "cost", "latency"],
      rows
    ),
    "",
    mismatchRows.length === 0
      ? "Every item agreed with the owner's slug in every run."
      : [
          "Repeated disagreements (a slug that differs from the owner's label):",
          "",
          markdownTable(
            ["item", "owner slug", "predicted slug", "occurrences"],
            mismatchRows
          ),
        ].join("\n"),
    "",
  ].join("\n");
};

export const buildRescoreMarkdown = (report: RescoreReport): string => {
  const label = recordedIds(report);
  const dateOnly = report.key.dateOnly.map((id) => label([id]));
  const gstIds = report.key.gst.map((id) => label([id]));
  const gstReceipts = report.key.gst.length;

  const header = [
    `# Extraction re-score — ${report.label}`,
    "",
    `Generated ${report.generatedAt}. This is a re-score, not a run: \`${report.runsFilePath}\` was read and its extraction records were re-scored. No model was called and no network request was made.`,
    "",
    `Runs recorded ${report.runsGeneratedAt} against \`${report.model}\`, ${report.runsPerReceipt} runs per receipt per variant, ${report.receipts.length} receipts.`,
    "",
    `Answer key: \`${report.goldenFilePath}\`.`,
    "",
    "Scoring is the matrix's own code — `scoreExtraction` for A/B/C and `scoreCategorization` for D — so a number moves only because the key moved. Three policies apply:",
    "",
    `- A golden \`transactionDatetime\` with no clock time (\`YYYY-MM-DD\`) is **date-only**: ${dateOnly.length === 0 ? "no receipt in this key is date-only" : `${dateOnly.join(", ")} ${dateOnly.length === 1 ? "is" : "are"} scored on date equality in \`date exact\` and left out of \`datetime exact\``}.`,
    `- \`gst\` exactness is scored only over receipts whose golden \`gst\` is non-null — ${gstReceipts === 0 ? "none here" : `${gstIds.join(", ")}, so its denominator is ${gstReceipts} × ${report.runsPerReceipt} runs per variant`}.`,
    "- A failed run counts as zero in every pass rate and as zero in the mean F1.",
    "",
  ].join("\n");

  const variantTable = markdownTable(
    VARIANT_TABLE_HEADERS,
    variantTableRows(report.runs)
  );

  const datesTable = markdownTable(
    ["variant", "datetime exact", "date exact"],
    extractionVariants.map((variant) => {
      const metrics = report.numbers[variant];
      return [variant, dateCell(metrics), dateOnlyCell(metrics)];
    })
  );

  const itemRows = extractionVariants.map((variant) => {
    const metrics = report.numbers[variant];
    return [
      variant,
      ratio(metrics.f1Sum, metrics.runs),
      ratio(metrics.amountPrecisionSum, metrics.runs),
      ratio(metrics.amountRecallSum, metrics.runs),
      ratio(metrics.amountF1Sum, metrics.runs),
      metrics.nameMatched === 0
        ? "—"
        : count(metrics.nameExact, metrics.nameMatched),
    ];
  });

  const fieldRows = extractionVariants.map((variant) => {
    const metrics = report.numbers[variant];
    return [
      variant,
      fieldCell(metrics.fields.merchantName),
      fieldCell(metrics.fields.merchantAbn),
      fieldCell(metrics.fields.merchantStoreId),
      fieldCell(metrics.fields.receiptNumber),
      fieldCell(metrics.fields.subtotal),
      fieldCell(metrics.fields.gst),
    ];
  });

  const gstRows = report.receipts.map((receipt) => [
    receipt.label,
    ...extractionVariants.map((variant) => {
      const { metrics } = receipt.variants[variant];
      return count(metrics.gstReported, metrics.runs);
    }),
  ]);

  const perReceiptRows = report.receipts.flatMap((receipt) =>
    extractionVariants.map((variant) => {
      const { metrics } = receipt.variants[variant];
      return [
        receipt.label,
        receipt.merchant,
        variant,
        count(metrics.totalExact, metrics.runs),
        dateCell(metrics),
        dateOnlyCell(metrics),
        count(metrics.paymentExact, metrics.runs),
        ratio(metrics.f1Sum, metrics.runs),
        ratio(metrics.amountF1Sum, metrics.runs),
        metrics.nameMatched === 0
          ? "—"
          : count(metrics.nameExact, metrics.nameMatched),
        count(metrics.reconcilePass, metrics.runs),
      ];
    })
  );

  const reproduction = report.comparison;

  return [
    header,
    "## Variants",
    "",
    variantTable,
    "",
    "`datetime exact` excludes runs where the golden key has no date, and every date-only receipt. A failed run counts against every pass rate and as zero in the mean F1.",
    "",
    "## Dates",
    "",
    datesTable,
    "",
    "`date exact` is the date-only column: the prediction must carry the golden day, and any clock time is ignored because the paper prints none.",
    "",
    "## Line items",
    "",
    markdownTable(
      [
        "variant",
        "mean F1",
        "amount precision",
        "amount recall",
        "amount F1",
        "name exact",
      ],
      itemRows
    ),
    "",
    "`mean F1` is the matrix's metric: amount within a cent and names at least 0.75 similar. `amount` ignores names entirely — the same `kind` and the same magnitude — so it measures money accuracy alone, and a name-only disagreement passes it. `name exact` counts matched pairs whose names are identical after `normaliseName`, out of the pairs that matched.",
    "",
    "## Fields",
    "",
    markdownTable(
      [
        "variant",
        "merchantName",
        "merchantAbn",
        "merchantStoreId",
        "receiptNumber",
        "subtotal",
        "gst",
      ],
      fieldRows
    ),
    "",
    "Each cell is exact reads over the runs that scored. `merchantName` ignores case and whitespace, `merchantAbn` compares digits only, and the rest are exact after trimming with an empty string read as null. Only `gst` restricts its denominator to receipts the key has a value for; for the others a null golden value is a scored answer, so reporting a value the paper does not print is a miss.",
    "",
    "## GST reported",
    "",
    markdownTable(["receipt", ...extractionVariants], gstRows),
    "",
    "How many of the runs returned a numeric `gst` at all, whatever the amount — the count the field table cannot show, since a wrong GST and no GST both fail.",
    "",
    "## Per receipt",
    "",
    markdownTable(
      [
        "receipt",
        "merchant",
        "variant",
        "total exact",
        "datetime exact",
        "date exact",
        "payment exact",
        "mean F1",
        "amount F1",
        "name exact",
        "reconcile",
      ],
      perReceiptRows
    ),
    "",
    "Receipts are labelled by the first eight characters of their id; the key's own `merchantName` is beside it.",
    "",
    "## Remaining losses",
    "",
    lossesSection(report),
    "",
    "## Money-only losses",
    "",
    "The same check with names ignored: a golden line whose `kind` and magnitude no predicted line matched. What is left here is a missing, duplicated or wrong amount (or a wrong `kind`), never a formatting difference.",
    "",
    moneyLossTable(report),
    "",
    categorizationSection(report),
    "## Reproduction",
    "",
    reproduction === null
      ? "No comparison against `runs.json` was recorded."
      : `${reproduction.records} extraction records were re-scored; ${reproduction.differing} of them now carry a different metric set than \`runs.json\` records. Against the key the matrix scored, that count is zero.`,
    "",
  ].join("\n");
};

/* -------------------------------------------------------------------------- */
/* DELTA.md                                                                   */
/* -------------------------------------------------------------------------- */

const KEY_FIELDS = [
  "merchantName",
  "merchantAbn",
  "merchantAddress",
  "merchantStoreId",
  "transactionDatetime",
  "receiptNumber",
  "paymentMethod",
  "subtotal",
  "gst",
  "total",
  "hasIntegrityWarning",
] as const;

const show = (value: string | number | boolean | null): string => {
  if (value === null) {
    return "null";
  }
  return typeof value === "string" ? `"${value}"` : String(value);
};

const itemLabel = (item: GoldenItem): string =>
  `${item.name.trim()} @ ${item.lineTotal.toFixed(2)}`;

const changedQuantities = (
  before: GoldenItem[],
  after: GoldenItem[]
): boolean => {
  const previous = new Map(before.map((item) => [itemLabel(item), item]));
  for (const item of after) {
    const was = previous.get(itemLabel(item));
    if (
      was &&
      (was.quantity !== item.quantity || was.unitPrice !== item.unitPrice)
    ) {
      return true;
    }
  }
  return false;
};

const keyChanges = (
  baseline: RescoreSummary,
  current: RescoreSummary
): string[][] => {
  const previous = new Map(
    baseline.receipts.map((receipt) => [receipt.id, receipt])
  );
  const rows: string[][] = [];
  for (const receipt of current.receipts) {
    const before = previous.get(receipt.id);
    if (!before) {
      rows.push([receipt.label, "not in the baseline key", "—", "—"]);
      continue;
    }
    const changes: string[] = [];
    for (const field of KEY_FIELDS) {
      if (before.key[field] !== receipt.key[field]) {
        changes.push(
          `${field}: ${show(before.key[field])} → ${show(receipt.key[field])}`
        );
      }
    }
    const beforeItems = new Map(
      before.key.items.map((item) => [itemLabel(item), item])
    );
    const afterItems = new Map(
      receipt.key.items.map((item) => [itemLabel(item), item])
    );
    const removed = [...beforeItems.keys()].filter(
      (label) => !afterItems.has(label)
    );
    const added = [...afterItems.keys()].filter(
      (label) => !beforeItems.has(label)
    );
    const itemSummary = `${before.key.items.length} → ${receipt.key.items.length} lines`;
    for (const label of removed) {
      changes.push(`line removed: \`${label}\``);
    }
    for (const label of added) {
      changes.push(`line added: \`${label}\``);
    }
    if (changedQuantities(before.key.items, receipt.key.items)) {
      changes.push("a line's quantity or unit price changed");
    }
    rows.push([
      receipt.label,
      changes.length === 0 ? "unchanged" : changes.join("; "),
      itemSummary,
      before.key.transactionDatetime === receipt.key.transactionDatetime
        ? show(receipt.key.transactionDatetime)
        : `${show(before.key.transactionDatetime)} → ${show(receipt.key.transactionDatetime)}`,
    ]);
  }
  return rows;
};

interface DeltaCell {
  after: string;
  before: string;
  delta: string;
}

const signed = (value: number, places: number): string => {
  const text = value.toFixed(places);
  return value >= 0 ? `+${text}` : text;
};

const countDelta = (
  before: { exact: number; scored: number },
  after: { exact: number; scored: number }
): DeltaCell => ({
  after: `${after.exact}/${after.scored}`,
  before: `${before.exact}/${before.scored}`,
  delta:
    before.scored === after.scored
      ? signed(after.exact - before.exact, 0)
      : `${signed(after.exact - before.exact, 0)}, scored ${before.scored}→${after.scored}`,
});

const ratioDelta = (
  before: number | null,
  after: number | null
): DeltaCell => ({
  after: after === null ? "—" : after.toFixed(3),
  before: before === null ? "—" : before.toFixed(3),
  delta: before === null || after === null ? "—" : signed(after - before, 3),
});

const cell = (value: DeltaCell): string =>
  `${value.before} → ${value.after} (${value.delta})`;

const meanRatio = (sum: number, runs: number): number | null =>
  runs === 0 ? null : sum / runs;

const deltaRows = (
  baseline: RescoreSummary,
  current: RescoreSummary
): string[][] => {
  const columns: ("overall" | ExtractionVariant)[] = [
    ...extractionVariants,
    "overall",
  ];
  const metricsOf = (
    summary: RescoreSummary,
    column: "overall" | ExtractionVariant
  ): MetricNumbers =>
    column === "overall"
      ? summary.overall
      : (summary.variants[column] ?? emptyMetrics());

  const definitions: {
    label: string;
    build: (before: MetricNumbers, after: MetricNumbers) => DeltaCell;
  }[] = [
    {
      build: (before, after) =>
        ratioDelta(
          meanRatio(before.f1Sum, before.runs),
          meanRatio(after.f1Sum, after.runs)
        ),
      label: "mean F1",
    },
    {
      build: (before, after) =>
        ratioDelta(
          meanRatio(before.amountPrecisionSum, before.runs),
          meanRatio(after.amountPrecisionSum, after.runs)
        ),
      label: "amount precision",
    },
    {
      build: (before, after) =>
        ratioDelta(
          meanRatio(before.amountRecallSum, before.runs),
          meanRatio(after.amountRecallSum, after.runs)
        ),
      label: "amount recall",
    },
    {
      build: (before, after) =>
        ratioDelta(
          meanRatio(before.amountF1Sum, before.runs),
          meanRatio(after.amountF1Sum, after.runs)
        ),
      label: "amount F1",
    },
    {
      build: (before, after) => {
        const beforeMatched = before.nameMatched;
        const afterMatched = after.nameMatched;
        return {
          after: `${after.nameExact}/${afterMatched}`,
          before: `${before.nameExact}/${beforeMatched}`,
          delta: signed(after.nameExact - before.nameExact, 0),
        };
      },
      label: "name exact",
    },
    {
      build: (before, after) =>
        countDelta(
          { exact: before.schemaValid, scored: before.runs },
          { exact: after.schemaValid, scored: after.runs }
        ),
      label: "schema valid",
    },
    {
      build: (before, after) =>
        countDelta(
          { exact: before.totalExact, scored: before.runs },
          { exact: after.totalExact, scored: after.runs }
        ),
      label: "total exact",
    },
    {
      build: (before, after) =>
        countDelta(
          { exact: before.paymentExact, scored: before.runs },
          { exact: after.paymentExact, scored: after.runs }
        ),
      label: "payment exact",
    },
    {
      build: (before, after) =>
        countDelta(
          { exact: before.reconcilePass, scored: before.runs },
          { exact: after.reconcilePass, scored: after.runs }
        ),
      label: "reconcile",
    },
    {
      build: (before, after) => countDelta(before.datetime, after.datetime),
      label: "datetime exact",
    },
    {
      build: (before, after) => countDelta(before.date, after.date),
      label: "date exact",
    },
    ...RESCORE_FIELDS.map((field) => ({
      build: (before: MetricNumbers, after: MetricNumbers) =>
        countDelta(before.fields[field], after.fields[field]),
      label: field,
    })),
    {
      build: (before, after) =>
        countDelta(
          { exact: before.gstReported, scored: before.runs },
          { exact: after.gstReported, scored: after.runs }
        ),
      label: "gst reported",
    },
  ];

  return definitions.map((definition) => [
    definition.label,
    ...columns.map((column) =>
      cell(
        definition.build(
          metricsOf(baseline, column),
          metricsOf(current, column)
        )
      )
    ),
  ]);
};

const deltaDisputes = (
  report: DisputesFile,
  summary: RescoreSummary
): string => {
  const labels = new Map(summary.receipts.map((r) => [r.id, r.label]));
  const rows: string[][] = [];
  for (const receipt of report.receipts) {
    const disputed = Object.entries(receipt.fields).filter(
      ([, field]) => field.disputed
    );
    if (disputed.length === 0) {
      continue;
    }
    rows.push([
      labels.get(receipt.receiptId) ?? receipt.receiptId,
      disputed
        .map(([field, value]) => {
          const observed = value.observed
            .map(
              (entry) =>
                `${show(entry.value)}${entry.count > 1 ? ` ×${entry.count}` : ""}`
            )
            .join(", ");
          return `${field}: key ${show(value.golden)} vs ${observed}`;
        })
        .join("; "),
    ]);
  }
  return rows.length === 0
    ? "Every model value matched the key."
    : markdownTable(["receipt", "fields still disputed"], rows);
};

const deltaLosses = (summary: RescoreSummary): string => {
  const blocks: string[] = [];
  let clean = 0;
  for (const receipt of summary.receipts) {
    for (const variant of extractionVariants) {
      const entry = receipt.variants[variant];
      if (!entry) {
        continue;
      }
      const lost = entry.runs.filter(
        (run) =>
          run.failed ||
          run.unmatchedGolden.length > 0 ||
          run.unmatchedPredicted.length > 0
      );
      if (lost.length === 0) {
        clean += 1;
        continue;
      }
      const lines = lost.map((run) => {
        const missed = run.unmatchedGolden.map(describeLine);
        const spare = run.unmatchedPredicted.map(describeLine);
        const parts: string[] = [];
        if (run.failed) {
          parts.push("the run failed");
        }
        if (missed.length > 0) {
          parts.push(
            `missed ${missed.map((line) => `\`${line}\``).join(", ")}`
          );
        }
        if (spare.length > 0) {
          parts.push(
            `left over ${spare.map((line) => `\`${line}\``).join(", ")}`
          );
        }
        return `  - run ${run.run}: ${parts.join("; ")}`;
      });
      const mean =
        entry.metrics.runs === 0
          ? "—"
          : (entry.metrics.f1Sum / entry.metrics.runs).toFixed(3);
      blocks.push(
        [
          `**${receipt.label} · ${variant}** — mean F1 ${mean}, amount F1 ${
            entry.metrics.runs === 0
              ? "—"
              : (entry.metrics.amountF1Sum / entry.metrics.runs).toFixed(3)
          }`,
          ...lines,
        ].join("\n")
      );
    }
  }
  const note =
    clean === 0
      ? ""
      : `Every golden line matched in every run for the other ${clean} receipt × variant pairs.\n\n`;
  return `${note}${blocks.join("\n\n")}`;
};

const deltaMoneyLosses = (summary: RescoreSummary): string => {
  const rows: string[][] = [];
  for (const receipt of summary.receipts) {
    for (const variant of extractionVariants) {
      const entry = receipt.variants[variant];
      if (!entry) {
        continue;
      }
      for (const run of entry.runs) {
        if (run.amountUnmatchedGolden.length === 0) {
          continue;
        }
        rows.push([
          receipt.label,
          variant,
          `${run.run}`,
          run.amountUnmatchedGolden.map(describeLine).join(", "),
          run.amountUnmatchedPredicted.map(describeLine).join(", ") || "—",
        ]);
      }
    }
  }
  return rows.length === 0
    ? "No run missed a golden amount against the corrected key."
    : markdownTable(
        [
          "receipt",
          "variant",
          "run",
          "golden line missed",
          "predicted line left over",
        ],
        rows
      );
};

const deltaNotes = (
  baseline: RescoreSummary,
  current: RescoreSummary
): string[] => {
  const label = (summary: RescoreSummary, ids: string[]): string =>
    ids
      .map(
        (id) =>
          summary.receipts.find((receipt) => receipt.id === id)?.label ?? id
      )
      .join(", ");
  const notes: string[] = [];

  if (
    baseline.receipts.every((receipt) => receipt.key.merchantAbn === null) &&
    current.receipts.some((receipt) => receipt.key.merchantAbn !== null)
  ) {
    notes.push(
      "The baseline key holds no ABN on any receipt, so its `merchantAbn` numerator only counted runs that also returned nothing — a null-vs-null match was never evidence of accuracy. The corrected key has the printed ABN, which is why that row falls: the metric starts measuring something."
    );
  }
  if (baseline.key.gst.length === 0 && current.key.gst.length > 0) {
    notes.push(
      `The baseline key has no GST anywhere, so \`gst\` had nothing to score (0/0). The corrected key prints a GST on ${current.key.gst.length} receipts, and \`gst reported\` shows the models rarely return one at all, so the gap is recall, not a wrong amount.`
    );
  }
  if (current.key.dateOnly.length > 0) {
    notes.push(
      `${label(current, current.key.dateOnly)} is date-only in the corrected key, so ${current.key.dateOnly.length === 1 ? "it is" : "they are"} counted in \`date exact\` and removed from the \`datetime exact\` denominator. The model answers with a midnight placeholder, which is why the receipt still appears in the disputes list even when the day is right.`
    );
  }

  return notes;
};

export const buildDeltaMarkdown = (
  baseline: RescoreSummary,
  current: RescoreSummary,
  disputes: DisputesFile
): string => {
  const perReceipt = current.receipts.map((receipt) => {
    const before = baseline.receipts.find((entry) => entry.id === receipt.id);
    return [
      receipt.label,
      receipt.merchant,
      ...extractionVariants.map((variant) => {
        const after = receipt.variants[variant];
        const previous = before?.variants[variant];
        const beforeF1 =
          previous && previous.metrics.runs > 0
            ? (previous.metrics.f1Sum / previous.metrics.runs).toFixed(3)
            : "—";
        const afterF1 =
          after && after.metrics.runs > 0
            ? (after.metrics.f1Sum / after.metrics.runs).toFixed(3)
            : "—";
        if (beforeF1 === "—" || afterF1 === "—") {
          return `${beforeF1} → ${afterF1}`;
        }
        return `${beforeF1} → ${afterF1} (${signed(Number(afterF1) - Number(beforeF1), 3)})`;
      }),
    ];
  });

  return [
    `# ${baseline.label} → ${current.label}: what the corrected key changes`,
    "",
    `The same ${current.overall.runs} recorded runs (${current.runs.model}, ${current.receipts.length} receipts × ${current.runs.runsPerReceipt} runs × 4 variants) scored against two keys. No model was called: \`${current.runs.path}\` was re-read and re-scored.`,
    "",
    `- baseline key: \`${baseline.goldenPath}\` (${baseline.label})`,
    `- corrected key: \`${current.goldenPath}\` (${current.label})`,
    "",
    "`mean F1` is the matrix metric (amount within a cent and name similarity ≥ 0.75); `amount` and `name exact` are the new metrics; `date exact` is the date-only column, so `datetime exact` has a smaller denominator once Nike leaves it, and `gst` is scored only on receipts whose golden value is non-null. Every count is `exact/scored`, and the parenthesised change is the count difference **or** the ratio difference.",
    "",
    "## What changed in the key",
    "",
    markdownTable(
      ["receipt", "changed fields", "line items", "transactionDatetime"],
      keyChanges(baseline, current)
    ),
    "",
    "## Metric deltas",
    "",
    markdownTable(
      ["metric", ...extractionVariants, "overall"],
      deltaRows(baseline, current)
    ),
    "",
    "`overall` pools all four variants into one row per metric, which is why its denominators are four times the per-variant ones.",
    ...(deltaNotes(baseline, current).length === 0
      ? []
      : [
          "",
          "What moves, and why:",
          "",
          ...deltaNotes(baseline, current).map((note) => `- ${note}`),
        ]),
    "",
    "## Per-receipt F1",
    "",
    markdownTable(["receipt", "merchant", ...extractionVariants], perReceipt),
    "",
    "Each cell is `before → after (change)` for the mean of the three runs.",
    "",
    "## What the corrected key still cannot match",
    "",
    "Per receipt and variant, the golden lines no predicted line matched in at least one run, beside the predicted lines left over. A name on the left that appears unpaired on the right is a formatting difference; an amount that appears on one side only is a missing or wrong line.",
    "",
    deltaLosses(current),
    "",
    "## Money-only losses against the corrected key",
    "",
    "Names ignored, `kind` and magnitude compared. A row here is a money error — a wrong amount, a missing line, a duplicated line, or a discount recorded as a product — not a spelling.",
    "",
    deltaMoneyLosses(current),
    "",
    "## Fields the corrected key still disputes",
    "",
    deltaDisputes(disputes, current),
    "",
    "The disputes list compares raw strings, so a date-only key that the model answers with a midnight placeholder reads as disputed there while `date exact` counts it correct. That is the point of splitting the two columns, and it is why the Nike row appears in the table above.",
    "",
  ].join("\n");
};
