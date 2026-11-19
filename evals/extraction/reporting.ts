import path from "node:path";

import type { CategoryOption } from "@/lib/ai/categorize";

import { describeGoldenItem } from "./scoring";
import { extractionVariants } from "./types";
import type {
  CorpusEntry,
  DisputesFile,
  Extraction,
  ExtractionVariant,
  FieldDispute,
  GoldenReceipt,
  ItemDispute,
  ItemDisputeRun,
  RunIndex,
  RunRecord,
  ScalarValue,
  CallRecord,
  Variant,
  VariantSummary,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                */
/* -------------------------------------------------------------------------- */

const median = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

const mean = (values: number[]): number | null =>
  values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;

export const flattenRuns = (runs: RunIndex): RunRecord[] => {
  const records: RunRecord[] = [];
  for (const byReceipt of Object.values(runs)) {
    for (const list of Object.values(byReceipt)) {
      records.push(...list);
    }
  }
  return records;
};

export const summariseVariant = (
  variant: Variant,
  records: RunRecord[]
): VariantSummary => {
  const hosts: Record<string, number> = {};
  let schemaValid = 0;
  let totalExact = 0;
  let datetimeScored = 0;
  let datetimeExact = 0;
  let paymentExact = 0;
  let reconcilePass = 0;
  let f1Sum = 0;
  const costs: number[] = [];
  const latencies: number[] = [];

  for (const record of records) {
    latencies.push(record.latencyMs);
    for (const call of record.calls) {
      if (call.cost !== null) {
        costs.push(call.cost);
      }
      const host = call.host ?? "unknown";
      hosts[host] = (hosts[host] ?? 0) + 1;
    }
    if (record.scores === null) {
      continue;
    }
    if (record.scores.schemaValid) {
      schemaValid += 1;
    }
    if (record.scores.totalExact === true) {
      totalExact += 1;
    }
    if (record.scores.datetimeExact !== null) {
      datetimeScored += 1;
      if (record.scores.datetimeExact) {
        datetimeExact += 1;
      }
    }
    if (record.scores.paymentExact === true) {
      paymentExact += 1;
    }
    if (record.scores.reconcileMatches === true) {
      reconcilePass += 1;
    }
    // A failed run has no F1 and scores zero: it is an extraction the pipeline
    // did not produce. That keeps the mean honest rather than flattering.
    f1Sum += record.scores.lineItemF1 ?? 0;
  }

  return {
    costs,
    datetimeExact,
    datetimeScored,
    f1Sum,
    hosts,
    latencies,
    meanCost: mean(costs),
    meanF1: records.length === 0 ? null : f1Sum / records.length,
    p50LatencyMs: median(latencies),
    paymentExact,
    reconcilePass,
    runs: records.length,
    schemaValid,
    totalExact,
    variant,
  };
};

export const totalSpend = (records: RunRecord[]): number => {
  let total = 0;
  for (const record of records) {
    for (const call of record.calls) {
      if (call.cost !== null) {
        total += call.cost;
      }
    }
  }
  return total;
};

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

export const formatUsd = (value: number | null, digits = 5): string =>
  value === null ? "—" : `$${value.toFixed(digits)}`;

export const formatLatency = (milliseconds: number): string =>
  milliseconds < 1000
    ? `${Math.round(milliseconds)}ms`
    : `${(milliseconds / 1000).toFixed(1)}s`;

const formatMeanF1 = (summary: VariantSummary): string =>
  summary.meanF1 === null ? "—" : summary.meanF1.toFixed(3);

const formatCost = (summary: VariantSummary): string =>
  formatUsd(summary.meanCost);

const formatCount = (numerator: number, denominator: number): string =>
  `${numerator}/${denominator}`;

const formatDatetime = (summary: VariantSummary): string =>
  `${formatCount(summary.datetimeExact, summary.datetimeScored)}${
    summary.datetimeScored < summary.runs
      ? ` (${summary.runs - summary.datetimeScored} unscored)`
      : ""
  }`;

const hostCounts = (calls: CallRecord[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const call of calls) {
    const host = call.host ?? "unknown";
    counts[host] = (counts[host] ?? 0) + 1;
  }
  return counts;
};

const formatHosts = (hosts: Record<string, number>): string => {
  const entries = Object.entries(hosts).toSorted(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0])
  );
  return entries.length === 0
    ? "—"
    : entries.map(([host, count]) => `${host} ×${count}`).join(", ");
};

const escapeTableCell = (value: string): string => value.replaceAll("|", "\\|");

export const markdownTable = (headers: string[], rows: string[][]): string => {
  const lines = [
    `| ${headers.map(escapeTableCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeTableCell).join(" | ")} |`),
  ];
  return lines.join("\n");
};

export const printTable = (headers: string[], rows: string[][]): void => {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length))
  );
  const render = (row: string[]) =>
    row.map((value, index) => value.padEnd(widths[index])).join("  ");

  console.log(render(headers));
  console.log(widths.map((width) => "─".repeat(width)).join("  "));
  for (const row of rows) {
    console.log(render(row));
  }
};

export const receiptLabel = (entry: CorpusEntry): string => {
  const base = path.basename(entry.imagePath, path.extname(entry.imagePath));
  return base.startsWith(`${entry.id}-`)
    ? base.slice(entry.id.length + 1)
    : base;
};

/* -------------------------------------------------------------------------- */
/* summary.md                                                                 */
/* -------------------------------------------------------------------------- */

export interface SummaryInput {
  categories: CategoryOption[];
  categorizationGoldenLength: number;
  corpus: CorpusEntry[];
  generatedAt: string;
  guard: { aborted: boolean; reason: string | null; totalUsd: number };
  notes: string[];
  runs: RunIndex;
  runsPerReceipt: number;
  /** Every call this session made, including the smoke test. */
  sessionCalls: CallRecord[];
  strictOutputs: boolean;
}

/**
 * The variant table, shared with the offline re-score so a key swap cannot
 * change the columns or the arithmetic that produced the first run's numbers.
 */
export const VARIANT_TABLE_HEADERS = [
  "variant",
  "schema valid",
  "total exact",
  "datetime exact",
  "mean F1",
  "reconcile",
  "payment exact",
  "mean cost",
  "p50 latency",
  "hosts",
];

export const variantTableRows = (runs: RunIndex): string[][] =>
  extractionVariants.map((variant) => {
    const summary = summariseVariant(
      variant,
      runs[variant] ? Object.values(runs[variant]).flat() : []
    );
    return [
      variant,
      formatCount(summary.schemaValid, summary.runs),
      formatCount(summary.totalExact, summary.runs),
      formatDatetime(summary),
      formatMeanF1(summary),
      formatCount(summary.reconcilePass, summary.runs),
      formatCount(summary.paymentExact, summary.runs),
      formatCost(summary),
      formatLatency(summary.p50LatencyMs),
      formatHosts(summary.hosts),
    ];
  });

const formatDatetimeCell = (records: RunRecord[]): string => {
  const scored = records.filter(
    (record) => record.scores !== null && record.scores.datetimeExact !== null
  );
  if (scored.length === 0) {
    return "—";
  }
  return formatCount(
    scored.filter((record) => record.scores?.datetimeExact === true).length,
    scored.length
  );
};

const perReceiptRows = (corpus: CorpusEntry[], runs: RunIndex): string[][] => {
  const rows: string[][] = [];
  for (const entry of corpus) {
    for (const variant of extractionVariants) {
      const records = runs[variant]?.[entry.id] ?? [];
      const withScores = records.filter((record) => record.scores !== null);
      const f1 = withScores
        .map((record) => record.scores?.lineItemF1 ?? 0)
        .reduce((sum, value) => sum + value, 0);
      rows.push([
        receiptLabel(entry),
        variant,
        formatCount(
          records.filter((record) => record.scores?.totalExact === true).length,
          records.length
        ),
        formatDatetimeCell(records),
        formatCount(
          records.filter((record) => record.scores?.paymentExact === true)
            .length,
          records.length
        ),
        records.length === 0 ? "—" : (f1 / records.length).toFixed(3),
        formatCount(
          records.filter((record) => record.scores?.reconcileMatches === true)
            .length,
          records.length
        ),
      ]);
    }
  }
  return rows;
};

const categorizationSection = (
  runs: RunIndex,
  categories: CategoryOption[],
  categorizationGoldenLength: number
): string => {
  const records = runs.D?.categorization ?? [];
  if (records.length === 0) {
    return "## Categorization (variant D)\n\nNo categorization runs recorded.\n";
  }

  const rows = records.map((record, index) => {
    const scores = record.categorization;
    let status = "—";
    if (record.error) {
      status = `error: ${record.error.message}`;
    } else if (scores) {
      status = `${scores.agreed}/${scores.total} (${scores.agreement.toFixed(3)})`;
    }

    return [
      `${index + 1}`,
      status,
      `${record.calls.length}`,
      formatUsd(record.cost),
      formatLatency(record.latencyMs),
      formatHosts(hostCounts(record.calls)),
    ];
  });

  const agreements = records
    .map((record) => record.categorization?.agreement)
    .filter((value): value is number => typeof value === "number");
  const meanAgreement = mean(agreements);

  const mismatchCounts = new Map<
    string,
    { count: number; golden: string; name: string; predicted: string }
  >();
  for (const record of records) {
    for (const mismatch of record.categorization?.mismatches ?? []) {
      const key = `${mismatch.name}|${mismatch.golden}|${mismatch.predicted ?? "null"}`;
      const existing = mismatchCounts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        mismatchCounts.set(key, {
          count: 1,
          golden: mismatch.golden,
          name: mismatch.name,
          predicted: mismatch.predicted ?? "null",
        });
      }
    }
  }

  const mismatchRows = [...mismatchCounts.values()]
    .toSorted(
      (left, right) =>
        right.count - left.count || left.name.localeCompare(right.name)
    )
    .map((entry) => [
      entry.name,
      entry.golden,
      entry.predicted,
      `${entry.count}`,
    ]);

  return [
    "## Categorization (variant D)",
    "",
    `\`categorizeItems\` over the ${categorizationGoldenLength} user-labelled line items and the ${categories.length} seeded categories. Agreement is exact slug equality.`,
    "",
    `Mean agreement: **${meanAgreement === null ? "—" : meanAgreement.toFixed(3)}** over ${records.length} runs.`,
    "",
    markdownTable(
      ["run", "agreement", "calls", "cost", "latency", "hosts"],
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

export const buildSummaryMarkdown = (input: SummaryInput): string => {
  const spend = input.guard.totalUsd;
  const callCount = input.sessionCalls.length;
  const uncostedCalls = input.sessionCalls.filter(
    (call) => call.cost === null
  ).length;

  const header = [
    "# Receipt extraction accuracy — DeepSeek V4.1 Flash 1017 on OpenRouter",
    "",
    `Generated ${input.generatedAt}.`,
    "",
    `Model: \`deepseek/deepseek-v4.1-flash-1017\`, ${input.runsPerReceipt} runs per receipt per variant, ${input.corpus.length} receipts.`,
    "",
    `Structured outputs: \`structuredOutputs.strict: ${input.strictOutputs}\`.`,
    "",
    ...(input.notes.length > 0
      ? [...input.notes.map((note) => `- ${note}`), ""]
      : []),
    "Variants: **A** one multimodal call with a leading `transcript` field; **B** the same call without it; **C** two calls (transcription, then parse); **D** categorization of the owner-labelled items. A runs on free routing and fp8/bf16-restricted routing; B and C run on fp8 so they are compared with A on the same routing.",
    "",
    "The answer key is `golden.draft.json`, built from the old pipeline's rows. It encodes that pipeline's mistakes: `gst` is null on every receipt (so it is reported as diagnostic only), item order is insertion order (so items are matched as a multiset), and four paper-vs-dump discrepancies are documented in the input README. `disputes.json` lists every place the models disagreed with it.",
    "",
  ].join("\n");

  const variantTable = markdownTable(
    VARIANT_TABLE_HEADERS,
    variantTableRows(input.runs)
  );

  const perReceipt = markdownTable(
    [
      "receipt",
      "variant",
      "total exact",
      "datetime exact",
      "payment exact",
      "mean F1",
      "reconcile",
    ],
    perReceiptRows(input.corpus, input.runs)
  );

  const spendSection = [
    "## Spend",
    "",
    `Total measured spend for the whole session: **${formatUsd(spend, 4)}** across ${callCount} HTTP ${callCount === 1 ? "call" : "calls"} (${uncostedCalls} of them reported no cost).`,
    input.guard.aborted
      ? `**The run stopped early:** ${input.guard.reason ?? "spend guard tripped"}.`
      : "The spend guard (US$1.00) was not reached.",
    "",
  ].join("\n");

  return [
    header,
    "## Variants",
    "",
    variantTable,
    "",
    "`datetime exact` excludes runs where the golden key has no date (Nike). A failed run counts against every pass rate and as zero in the mean F1.",
    "",
    "## Per receipt",
    "",
    perReceipt,
    "",
    categorizationSection(
      input.runs,
      input.categories,
      input.categorizationGoldenLength
    ),
    spendSection,
  ].join("\n");
};

/* -------------------------------------------------------------------------- */
/* disputes.json                                                              */
/* -------------------------------------------------------------------------- */

const normaliseValue = (value: unknown): ScalarValue => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  }
  const text = String(value).trim();
  return text === "" ? null : text;
};

const valueKey = (value: ScalarValue): string =>
  value === null ? "null" : `${typeof value}|${value}`;

interface FieldReader {
  field: string;
  read: (extraction: Extraction) => unknown;
  readGolden: (golden: GoldenReceipt) => unknown;
}

const SCALAR_FIELDS: FieldReader[] = [
  {
    field: "merchantName",
    read: (e) => e.merchant.name,
    readGolden: (g) => g.merchantName,
  },
  {
    field: "merchantAbn",
    read: (e) => e.merchant.abn,
    readGolden: (g) => g.merchantAbn,
  },
  {
    field: "merchantAddress",
    read: (e) => e.merchant.address,
    readGolden: (g) => g.merchantAddress,
  },
  {
    field: "merchantStoreId",
    read: (e) => e.merchant.storeId,
    readGolden: (g) => g.merchantStoreId,
  },
  {
    field: "transactionDatetime",
    read: (e) => e.transaction.datetime,
    readGolden: (g) => g.transactionDatetime,
  },
  {
    field: "receiptNumber",
    read: (e) => e.transaction.receiptNumber,
    readGolden: (g) => g.receiptNumber,
  },
  {
    field: "paymentMethod",
    read: (e) => e.payment.method,
    readGolden: (g) => g.paymentMethod,
  },
  {
    field: "subtotal",
    read: (e) => e.totals.subtotal,
    readGolden: (g) => g.subtotal,
  },
  { field: "gst", read: (e) => e.totals.gst, readGolden: (g) => g.gst },
  { field: "total", read: (e) => e.totals.total, readGolden: (g) => g.total },
];

export const DISPUTE_FIELDS = SCALAR_FIELDS.map((reader) => reader.field);

interface Observation {
  count: number;
  value: ScalarValue;
  variants: Record<string, number>;
}

const collectFieldDispute = (
  field: string,
  goldenValue: ScalarValue,
  observations: { extraction: Extraction; variant: ExtractionVariant }[]
): FieldDispute => {
  const reader = SCALAR_FIELDS.find((candidate) => candidate.field === field);
  if (!reader) {
    throw new Error(`Unknown dispute field ${field}`);
  }

  const grouped = new Map<string, Observation>();
  for (const { extraction, variant } of observations) {
    const value = normaliseValue(reader.read(extraction));
    const key = valueKey(value);
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
      existing.variants[variant] = (existing.variants[variant] ?? 0) + 1;
    } else {
      grouped.set(key, { count: 1, value, variants: { [variant]: 1 } });
    }
  }

  const observed = [...grouped.values()].toSorted(
    (left, right) =>
      right.count - left.count ||
      valueKey(left.value).localeCompare(valueKey(right.value))
  );

  return {
    disputed: observed.some((entry) => entry.value !== goldenValue),
    golden: goldenValue,
    observed,
    proposed: null,
  };
};

const collectItemDispute = (
  golden: GoldenReceipt,
  records: RunRecord[]
): ItemDispute => {
  const runs: ItemDisputeRun[] = [];
  for (const record of records) {
    const match = record.scores?.lineItemMatch;
    if (record.variant === "D" || !match) {
      continue;
    }
    runs.push({
      matchedCount: match.matched,
      predictedCount: match.predicted,
      run: record.run,
      unmatchedGolden: match.unmatchedGolden.map((index) =>
        describeGoldenItem(golden.items[index])
      ),
      variant: record.variant,
    });
  }

  const union = new Set<string>();
  for (const run of runs) {
    for (const line of run.unmatchedGolden) {
      union.add(line);
    }
  }

  return { runs, unmatchedGolden: [...union] };
};

export interface DisputesInput {
  corpus: CorpusEntry[];
  generatedAt: string;
  golden: Map<string, GoldenReceipt>;
  runs: RunIndex;
}

export const buildDisputes = (input: DisputesInput): DisputesFile => {
  const receipts = input.corpus.map((entry) => {
    const golden = input.golden.get(entry.id);
    if (!golden) {
      throw new Error(`No golden row for ${entry.id}`);
    }

    const observations: {
      extraction: Extraction;
      variant: ExtractionVariant;
    }[] = [];
    for (const variant of extractionVariants) {
      for (const record of input.runs[variant]?.[entry.id] ?? []) {
        if (record.extraction) {
          observations.push({ extraction: record.extraction, variant });
        }
      }
    }

    const fields: Record<string, FieldDispute> = {};
    for (const reader of SCALAR_FIELDS) {
      const goldenValue = normaliseValue(reader.readGolden(golden));
      fields[reader.field] = collectFieldDispute(
        reader.field,
        goldenValue,
        observations
      );
    }

    const records = extractionVariants.flatMap(
      (variant) => input.runs[variant]?.[entry.id] ?? []
    );
    const reproduced = records.some(
      (record) =>
        record.scores?.lineItemMatch !== null &&
        record.scores?.lineItemMatch !== undefined &&
        record.scores.lineItemMatch.matched === golden.items.length &&
        record.scores.lineItemMatch.predicted === golden.items.length
    );

    return {
      fields,
      items: reproduced ? null : collectItemDispute(golden, records),
      merchant: entry.merchant,
      receiptId: entry.id,
    };
  });

  return {
    fields: DISPUTE_FIELDS,
    generatedAt: input.generatedAt,
    receipts,
  };
};
