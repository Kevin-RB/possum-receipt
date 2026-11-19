import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { generateText, NoObjectGeneratedError, Output } from "ai";

import type { CategoryOption, CategorizeItem } from "@/lib/ai/categorize";
import { categorizeItems } from "@/lib/ai/categorize";
import {
  PARSE_PROMPT,
  TRANSCRIPTION_PROMPT,
} from "@/lib/ai/transcribe-receipt-image";
import { ReceiptInformationExtractionSchema } from "@/lib/db/contract";

import { ExtractionEvalUsageError, parseExtractionEvalArgs } from "./args";
import { loadEvalInputs } from "./inputs";
import type { EvalInputs, ReceiptImage } from "./inputs";
import type { ModelOptions } from "./model";
import {
  MODEL_ID,
  SpendAbortError,
  createMeteredModel,
  createSpendGuard,
  describeError,
  isStrictSchemaRejection,
} from "./model";
import { IMAGE_PARSE_PROMPT, TranscriptExtractionSchema } from "./prompts";
import {
  buildDisputes,
  buildSummaryMarkdown,
  flattenRuns,
  formatLatency,
  formatUsd,
  printTable,
  receiptLabel,
  summariseVariant,
} from "./reporting";
import { scoreCategorization, scoreExtraction } from "./scoring";
import type {
  CallRecord,
  CategorizationGoldenItem,
  CorpusEntry,
  Extraction,
  ExtractionVariant,
  GoldenReceipt,
  Meter,
  Routing,
  RunIndex,
  RunRecord,
  RunsFile,
  Variant,
} from "./types";
import { extractionVariants, VARIANT_SPECS } from "./types";

type SpendGuard = ReturnType<typeof createSpendGuard>;

/** Runs per receipt for A/B/C, and runs of the categorization variant. */
const RUNS_PER_RECEIPT = 3;
const CATEGORIZATION_RUNS = 3;

const CATEGORIZATION_RECEIPT_ID = "categorization";

const RESULTS_FILES = {
  disputes: "disputes.json",
  runs: "runs.json",
  summary: "summary.md",
} as const;

interface RunContext {
  /** Flips to false when the provider rejects the strict schema envelope. */
  strict: boolean;
}

interface RecordTotals {
  calls: CallRecord[];
  cost: number | null;
  host: string | null;
  hosts: string[];
  inputTokens: number | null;
  latencyMs: number;
  outputTokens: number | null;
}

const sumOrNull = (values: (number | null)[]): number | null => {
  const numbers = values.filter((value): value is number => value !== null);
  return numbers.length === 0
    ? null
    : numbers.reduce((sum, value) => sum + value, 0);
};

const totalsFromMeter = (meter: Meter): RecordTotals => {
  const hosts = [
    ...new Set(
      meter.calls
        .map((call) => call.host)
        .filter((host): host is string => host !== null)
    ),
  ];
  return {
    calls: meter.calls,
    cost: sumOrNull(meter.calls.map((call) => call.cost)),
    host: hosts[0] ?? null,
    hosts,
    inputTokens: sumOrNull(meter.calls.map((call) => call.inputTokens)),
    latencyMs: meter.calls.reduce((sum, call) => sum + call.latencyMs, 0),
    outputTokens: sumOrNull(meter.calls.map((call) => call.outputTokens)),
  };
};

/**
 * One attempt, retried once on a strict-schema rejection. That is the only
 * failure the owner allowed to be retried: it is an adapter/schema-envelope
 * problem, not a model that cannot read. Everything else propagates and is
 * recorded as a failed run.
 */
const attemptWithFallback = async <T>(
  context: RunContext,
  routing: Routing,
  attempt: (options: ModelOptions) => Promise<T>
): Promise<{ strictFallback: boolean; value: T }> => {
  try {
    return {
      strictFallback: false,
      value: await attempt({ routing, strict: context.strict }),
    };
  } catch (error) {
    if (!context.strict || !isStrictSchemaRejection(error)) {
      throw error;
    }
    context.strict = false;
    return {
      strictFallback: true,
      value: await attempt({ routing, strict: false }),
    };
  }
};

interface ExtractionCallResult {
  extraction: Extraction;
  strictFallback: boolean;
  transcript: string | null;
}

const imageMessage = (prompt: string, image: ReceiptImage) => ({
  content: [
    { text: prompt, type: "text" as const },
    {
      data: image.base64,
      mediaType: image.mediaType,
      type: "file" as const,
    },
  ],
  role: "user" as const,
});

const requestOptions = {
  maxRetries: 1,
  temperature: 0,
} as const;

interface VariantCallParams {
  context: RunContext;
  guard: SpendGuard;
  image: ReceiptImage;
  meter: Meter;
  routing: Routing;
}

/** Variant A: one multimodal call, transcript first in the schema. */
const runVariantA = async ({
  context,
  guard,
  image,
  meter,
  routing,
}: VariantCallParams): Promise<ExtractionCallResult> => {
  const { value, strictFallback } = await attemptWithFallback(
    context,
    routing,
    async (options) => {
      guard.assertCanSpend();
      const { output } = await generateText({
        ...requestOptions,
        messages: [imageMessage(IMAGE_PARSE_PROMPT, image)],
        model: createMeteredModel(options, meter, guard),
        output: Output.object({ schema: TranscriptExtractionSchema }),
      });
      return output;
    }
  );

  const { transcript, ...extraction } = value;
  return { extraction, strictFallback, transcript };
};

/** Variant B: the same call and prompt, against the production contract. */
const runVariantB = async ({
  context,
  guard,
  image,
  meter,
  routing,
}: VariantCallParams): Promise<ExtractionCallResult> => {
  const { value, strictFallback } = await attemptWithFallback(
    context,
    routing,
    async (options) => {
      guard.assertCanSpend();
      const { output } = await generateText({
        ...requestOptions,
        messages: [imageMessage(IMAGE_PARSE_PROMPT, image)],
        model: createMeteredModel(options, meter, guard),
        output: Output.object({ schema: ReceiptInformationExtractionSchema }),
      });
      return output;
    }
  );

  return { extraction: value, strictFallback, transcript: null };
};

/**
 * Variant C: the production two-step. The fallback retries the pair, not just
 * the parse call, because a strict rejection can only come from the parse call
 * and the metre has to describe one coherent run.
 */
const runVariantC = async ({
  context,
  guard,
  image,
  meter,
  routing,
}: VariantCallParams): Promise<ExtractionCallResult> => {
  const { value, strictFallback } = await attemptWithFallback(
    context,
    routing,
    async (options) => {
      const model = createMeteredModel(options, meter, guard);
      guard.assertCanSpend();
      const transcription = await generateText({
        ...requestOptions,
        messages: [imageMessage(TRANSCRIPTION_PROMPT, image)],
        model,
      });
      guard.assertCanSpend();
      const parsed = await generateText({
        ...requestOptions,
        messages: [
          {
            content: `${PARSE_PROMPT}\n\nReceipt OCR transcript:\n\n${transcription.text}`,
            role: "user",
          },
        ],
        model,
        output: Output.object({ schema: ReceiptInformationExtractionSchema }),
      });
      return { extraction: parsed.output, transcript: transcription.text };
    }
  );

  return {
    extraction: value.extraction,
    strictFallback,
    transcript: value.transcript,
  };
};

const emptyScores = (): NonNullable<RunRecord["scores"]> => ({
  datetimeExact: null,
  gstReported: false,
  lineItemF1: null,
  lineItemMatch: null,
  paymentExact: null,
  reconcileMatches: null,
  schemaValid: false,
  totalExact: null,
});

const describeFailure = (error: unknown): RunRecord["error"] => {
  const detail = describeError(error);
  // A schema-invalid answer is not an API failure: the HTTP call succeeded and
  // returned text that did not fit the contract. Keep the text, because it is
  // the only evidence of *how* it was wrong.
  if (NoObjectGeneratedError.isInstance(error) && error.text !== undefined) {
    return { ...detail, rawText: error.text.slice(0, 4000) };
  }
  return detail;
};

const failureRecord = (params: {
  error: unknown;
  meter: Meter;
  receiptId: string;
  run: number;
  strictFallback: boolean;
  transcript: string | null;
  variant: Variant;
}): RunRecord => ({
  ...totalsFromMeter(params.meter),
  categories: null,
  categorization: null,
  error: describeFailure(params.error),
  extraction: null,
  receiptId: params.receiptId,
  run: params.run,
  scores: emptyScores(),
  strictFallback: params.strictFallback,
  transcript: params.transcript,
  variant: params.variant,
});

const runExtraction = async (params: {
  context: RunContext;
  entry: CorpusEntry;
  golden: GoldenReceipt;
  guard: SpendGuard;
  image: ReceiptImage;
  run: number;
  variant: ExtractionVariant;
}): Promise<RunRecord> => {
  const { context, entry, golden, guard, image, run, variant } = params;
  const { kind, routing } = VARIANT_SPECS[variant];
  // The meter lives outside the attempt so a call that throws is still
  // recorded: it cost money and it took time.
  const meter: Meter = { calls: [] };

  try {
    const callParams: VariantCallParams = {
      context,
      guard,
      image,
      meter,
      routing,
    };
    let result: ExtractionCallResult;
    switch (kind) {
      case "A": {
        result = await runVariantA(callParams);
        break;
      }
      case "B": {
        result = await runVariantB(callParams);
        break;
      }
      default: {
        result = await runVariantC(callParams);
      }
    }

    return {
      ...totalsFromMeter(meter),
      categories: null,
      categorization: null,
      error: null,
      extraction: result.extraction,
      receiptId: entry.id,
      run,
      scores: scoreExtraction(golden, result.extraction),
      strictFallback: result.strictFallback,
      transcript: result.transcript,
      variant,
    };
  } catch (error) {
    if (error instanceof SpendAbortError) {
      throw error;
    }
    return failureRecord({
      error,
      meter,
      receiptId: entry.id,
      run,
      strictFallback: false,
      transcript: null,
      variant,
    });
  }
};

const runCategorization = async (params: {
  categories: CategoryOption[];
  golden: CategorizationGoldenItem[];
  guard: SpendGuard;
  items: CategorizeItem[];
  run: number;
  context: RunContext;
}): Promise<RunRecord> => {
  const { categories, golden, guard, items, run, context } = params;
  const meter: Meter = { calls: [] };

  try {
    const { value, strictFallback } = await attemptWithFallback(
      context,
      "fp8",
      async (options) => {
        guard.assertCanSpend();
        const model = createMeteredModel(options, meter, guard);
        return await categorizeItems(items, categories, model);
      }
    );

    return {
      ...totalsFromMeter(meter),
      categories: value,
      categorization: scoreCategorization(golden, value),
      error: null,
      extraction: null,
      receiptId: CATEGORIZATION_RECEIPT_ID,
      run,
      scores: null,
      strictFallback,
      transcript: null,
      variant: "D",
    };
  } catch (error) {
    if (error instanceof SpendAbortError) {
      throw error;
    }
    return {
      ...failureRecord({
        error,
        meter,
        receiptId: CATEGORIZATION_RECEIPT_ID,
        run,
        strictFallback: false,
        transcript: null,
        variant: "D",
      }),
      scores: null,
    };
  }
};

/* -------------------------------------------------------------------------- */
/* Output                                                                     */
/* -------------------------------------------------------------------------- */

const writeJson = async (file: string, value: unknown): Promise<void> => {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
};

const buildRunsFile = (params: {
  runs: RunIndex;
  spend: { aborted: boolean; reason: string | null; totalUsd: number };
  strictOutputs: boolean;
}): RunsFile => ({
  generatedAt: new Date().toISOString(),
  model: MODEL_ID,
  runs: params.runs,
  runsPerReceipt: RUNS_PER_RECEIPT,
  spend: params.spend,
  strictOutputs: params.strictOutputs,
});

const emptyRunIndex = (): RunIndex => ({
  "A-fp8": {},
  "A-free": {},
  "B-fp8": {},
  "C-fp8": {},
  D: {},
});

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

const smokeTest = async (params: {
  context: RunContext;
  entry: CorpusEntry;
  guard: SpendGuard;
  image: ReceiptImage;
  meter: Meter;
}): Promise<void> => {
  const { context, entry, guard, image, meter } = params;
  console.log(
    `Smoke test: variant A, free routing, ${receiptLabel(entry)} (${entry.id})`
  );

  try {
    const result = await runVariantA({
      context,
      guard,
      image,
      meter,
      routing: "free",
    });
    const totals = totalsFromMeter(meter);
    const transcript = result.transcript ?? "";

    console.log("  schema:   valid");
    console.log(`  host:     ${totals.host ?? "unknown"}`);
    console.log(`  cost:     ${formatUsd(totals.cost)}`);
    console.log(
      `  tokens:   ${totals.inputTokens ?? "?"} in / ${totals.outputTokens ?? "?"} out`
    );
    console.log(`  latency:  ${formatLatency(totals.latencyMs)}`);
    console.log(
      `  transcript (first 600 of ${transcript.length} chars):\n\n${transcript.slice(0, 600)}\n`
    );
  } catch (error) {
    const detail = describeError(error);
    console.error("\nSmoke test FAILED — stopping before the matrix.");
    console.error(`  name:     ${detail.name}`);
    if (detail.statusCode !== undefined) {
      console.error(`  status:   ${detail.statusCode}`);
    }
    console.error(`  message:  ${detail.message}`);
    if (detail.url) {
      console.error(`  url:      ${detail.url}`);
    }
    if (detail.responseBody) {
      console.error(`  body:     ${detail.responseBody}`);
    }
    process.exitCode = 1;
    throw new ExtractionEvalUsageError("Smoke test failed; no matrix was run.");
  }
};

interface MatrixState {
  context: RunContext;
  guard: SpendGuard;
  inputs: EvalInputs;
  outDir: string;
  runs: RunIndex;
  sessionCalls: CallRecord[];
}

const persistRuns = async (
  state: MatrixState,
  aborted: string | null
): Promise<void> => {
  await writeJson(
    path.join(state.outDir, RESULTS_FILES.runs),
    buildRunsFile({
      runs: state.runs,
      spend: {
        aborted: aborted !== null,
        reason: aborted,
        totalUsd: state.guard.spent(),
      },
      strictOutputs: state.context.strict,
    })
  );
};

const describeRecord = (record: RunRecord): string => {
  if (record.error) {
    return `error: ${record.error.message}`;
  }
  if (record.scores) {
    return `${formatLatency(record.latencyMs)} ${formatUsd(record.cost)} f1=${record.scores.lineItemF1 ?? "—"}`;
  }
  const { categorization } = record;
  if (categorization) {
    return `${categorization.agreed}/${categorization.total} ${formatLatency(record.latencyMs)} ${formatUsd(record.cost)}`;
  }
  return `${formatLatency(record.latencyMs)} ${formatUsd(record.cost)}`;
};

const runExtractionMatrix = async (state: MatrixState): Promise<void> => {
  for (const variant of extractionVariants) {
    for (const entry of state.inputs.corpus) {
      const golden = state.inputs.golden.get(entry.id);
      const image = state.inputs.images.get(entry.id);
      if (!golden || !image) {
        throw new Error(`Inputs incomplete for ${entry.id}`);
      }
      state.runs[variant][entry.id] = [];
      for (let run = 1; run <= RUNS_PER_RECEIPT; run += 1) {
        process.stdout.write(`  ${variant} ${receiptLabel(entry)} ${run} … `);
        // Sequential on purpose: latency is measured, not contended.
        // eslint-disable-next-line no-await-in-loop
        const record = await runExtraction({
          context: state.context,
          entry,
          golden,
          guard: state.guard,
          image,
          run,
          variant,
        });
        state.runs[variant][entry.id].push(record);
        state.sessionCalls.push(...record.calls);
        console.log(describeRecord(record));
        // Persist after every run so a later crash leaves the paid results.
        // eslint-disable-next-line no-await-in-loop
        await persistRuns(state, null);
      }
    }
  }
};

const runCategorizationMatrix = async (state: MatrixState): Promise<void> => {
  const items: CategorizeItem[] = state.inputs.categorizationGolden.map(
    (item) => ({ kind: item.kind, name: item.name })
  );
  state.runs.D[CATEGORIZATION_RECEIPT_ID] = [];
  for (let run = 1; run <= CATEGORIZATION_RUNS; run += 1) {
    process.stdout.write(`  D categorization ${run} … `);
    // eslint-disable-next-line no-await-in-loop
    const record = await runCategorization({
      categories: state.inputs.categories,
      context: state.context,
      golden: state.inputs.categorizationGolden,
      guard: state.guard,
      items,
      run,
    });
    state.runs.D[CATEGORIZATION_RECEIPT_ID].push(record);
    state.sessionCalls.push(...record.calls);
    console.log(describeRecord(record));
  }
};

const printReport = (state: MatrixState): void => {
  console.log("\nVariants");
  printTable(
    [
      "variant",
      "schema",
      "total",
      "datetime",
      "mean F1",
      "reconcile",
      "mean cost",
      "p50",
      "hosts",
    ],
    extractionVariants.map((variant) => {
      const summary = summariseVariant(
        variant,
        Object.values(state.runs[variant]).flat()
      );
      const hosts = Object.entries(summary.hosts)
        .toSorted((left, right) => right[1] - left[1])
        .map(([host, count]) => `${host} ×${count}`)
        .join(", ");
      return [
        variant,
        `${summary.schemaValid}/${summary.runs}`,
        `${summary.totalExact}/${summary.runs}`,
        `${summary.datetimeExact}/${summary.datetimeScored}`,
        summary.meanF1 === null ? "—" : summary.meanF1.toFixed(3),
        `${summary.reconcilePass}/${summary.runs}`,
        formatUsd(summary.meanCost),
        formatLatency(summary.p50LatencyMs),
        hosts || "—",
      ];
    })
  );

  const records = state.runs.D[CATEGORIZATION_RECEIPT_ID] ?? [];
  const agreements = records.flatMap((record) =>
    record.categorization ? [record.categorization] : []
  );
  console.log(
    `\nCategorization: ${agreements.map((scores) => `${scores.agreed}/${scores.total}`).join(", ")}`
  );
  console.log(
    `Total measured spend: ${formatUsd(state.guard.spent(), 4)} across ${state.sessionCalls.length} calls.`
  );
  const matrixCalls = flattenRuns(state.runs).reduce(
    (sum, record) => sum + record.calls.length,
    0
  );
  console.log(
    `  matrix calls: ${matrixCalls}, smoke calls: ${state.sessionCalls.length - matrixCalls}`
  );
};

const main = async () => {
  const options = parseExtractionEvalArgs(process.argv.slice(2));
  const inputs = await loadEvalInputs(options.corpusDir);
  await mkdir(options.outDir, { recursive: true });

  const state: MatrixState = {
    context: { strict: true },
    guard: createSpendGuard(),
    inputs,
    outDir: options.outDir,
    runs: emptyRunIndex(),
    sessionCalls: [],
  };
  const notes: string[] = [];

  console.log(
    `Extraction eval: ${inputs.corpus.length} receipts × ${RUNS_PER_RECEIPT} runs × ${extractionVariants.length} variants, model ${MODEL_ID}`
  );
  console.log(`  corpus: ${options.corpusDir}`);
  console.log(`  out:    ${options.outDir}\n`);

  const smokeReceipt =
    inputs.corpus.find((entry) => /aldi/iu.test(entry.imagePath)) ??
    inputs.corpus[0];
  const smokeImage = inputs.images.get(smokeReceipt.id);
  if (!smokeImage) {
    throw new Error(`No image loaded for ${smokeReceipt.id}`);
  }

  const smokeMeter: Meter = { calls: [] };
  await smokeTest({
    context: state.context,
    entry: smokeReceipt,
    guard: state.guard,
    image: smokeImage,
    meter: smokeMeter,
  });
  state.sessionCalls.push(...smokeMeter.calls);
  const smokeTotals = totalsFromMeter(smokeMeter);
  notes.push(
    `Smoke test (variant A, free routing, ${receiptLabel(smokeReceipt)}): schema valid, served by ${smokeTotals.host ?? "unknown"}, ${formatLatency(smokeTotals.latencyMs)}, ${formatUsd(smokeTotals.cost)}, ${smokeTotals.inputTokens ?? "?"} in / ${smokeTotals.outputTokens ?? "?"} out tokens.`
  );

  let aborted: string | null = null;
  try {
    await runExtractionMatrix(state);
    await runCategorizationMatrix(state);
  } catch (error) {
    if (!(error instanceof SpendAbortError)) {
      throw error;
    }
    aborted = error.message;
  }

  const spend = {
    aborted: aborted !== null,
    reason: aborted,
    totalUsd: state.guard.spent(),
  };
  await persistRuns(state, aborted);

  if (!state.context.strict) {
    notes.push(
      "**`structuredOutputs.strict` was rejected by the provider. The matrix ran with `strict: false`; the rejection is recorded verbatim in the failed call.**"
    );
  }

  const generatedAt = new Date().toISOString();
  const summary = buildSummaryMarkdown({
    categories: inputs.categories,
    categorizationGoldenLength: inputs.categorizationGolden.length,
    corpus: inputs.corpus,
    generatedAt,
    guard: spend,
    notes,
    runs: state.runs,
    runsPerReceipt: RUNS_PER_RECEIPT,
    sessionCalls: state.sessionCalls,
    strictOutputs: state.context.strict,
  });
  await writeFile(path.join(options.outDir, RESULTS_FILES.summary), summary);

  const disputes = buildDisputes({
    corpus: inputs.corpus,
    generatedAt,
    golden: inputs.golden,
    runs: state.runs,
  });
  await writeJson(path.join(options.outDir, RESULTS_FILES.disputes), disputes);

  printReport(state);
  console.log(`Wrote ${options.outDir}/runs.json`);
  console.log(`Wrote ${options.outDir}/summary.md`);
  console.log(`Wrote ${options.outDir}/disputes.json`);

  if (aborted) {
    console.error(`\n${aborted}\nStopped early; partial results were written.`);
    process.exitCode = 1;
  }
};

try {
  await main();
} catch (error) {
  if (!(error instanceof ExtractionEvalUsageError)) {
    throw error;
  }
  console.error(`${error.message}\n`);
  process.exitCode = 1;
}
