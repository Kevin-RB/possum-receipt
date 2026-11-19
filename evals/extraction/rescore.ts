import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { z } from "zod";

import { ExtractionEvalUsageError } from "./args";
import { goldenReceiptSchema } from "./inputs";
import {
  buildDisputes,
  printTable,
  VARIANT_TABLE_HEADERS,
  variantTableRows,
} from "./reporting";
import {
  buildDeltaMarkdown,
  buildRescoreMarkdown,
  buildRescoreReport,
  buildRescoreSummary,
  meanOf,
  summaryJsonSchema,
} from "./rescore-report";
import type {
  CategorizationGoldenItem,
  CorpusEntry,
  Extraction,
  GoldenReceipt,
  RunRecord,
  RunsFile,
} from "./types";
import { extractionVariants } from "./types";

export const RESCORE_USAGE = [
  "Usage: pnpm exec tsx ./evals/extraction/rescore.ts --runs <runs.json> --golden <key.json> --out <dir> [--label <name>] [--categorization <file>] [--compare <summary.json>]",
  "--runs is a runs.json written by run.ts, --golden is the answer key to score it",
  "against (an array of receipts, or { receipts: [...] }), and --out is where",
  "summary.md, summary.json and disputes.json are written. --label names the key in",
  "the report. --categorization is categorization.golden.json, needed only to",
  "re-score variant D from its recorded slugs. --compare takes another re-score's",
  "summary.json and writes DELTA.md comparing the two. No model is called and no",
  "credential is read: this only re-scores records that already exist.",
].join("\n");

export interface RescoreOptions {
  categorizationPath: string | null;
  comparePath: string | null;
  goldenPath: string;
  label: string;
  outDir: string;
  runsPath: string;
}

/**
 * `parseArgs` in strict mode, like `parseExtractionEvalArgs`: an unknown or
 * mistyped flag is refused before any file is read, so a typo cannot silently
 * produce a report against the wrong key.
 */
export const parseRescoreArgs = (args: readonly string[]): RescoreOptions => {
  try {
    const { values } = parseArgs({
      args: [...args],
      options: {
        categorization: { type: "string" },
        compare: { type: "string" },
        golden: { type: "string" },
        label: { type: "string" },
        out: { type: "string" },
        runs: { type: "string" },
      },
      strict: true,
    });

    if (!values.runs || !values.golden || !values.out) {
      throw new ExtractionEvalUsageError(
        `--runs, --golden and --out are required.\n${RESCORE_USAGE}`
      );
    }

    return {
      categorizationPath:
        values.categorization === undefined
          ? null
          : path.resolve(values.categorization),
      comparePath:
        values.compare === undefined ? null : path.resolve(values.compare),
      goldenPath: path.resolve(values.golden),
      label: values.label ?? path.basename(values.golden, ".json"),
      outDir: path.resolve(values.out),
      runsPath: path.resolve(values.runs),
    };
  } catch (error) {
    if (error instanceof ExtractionEvalUsageError) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new ExtractionEvalUsageError(`${reason}\n${RESCORE_USAGE}`);
  }
};

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

const readJson = async (file: string): Promise<unknown> => {
  const text = await readFile(file, "utf-8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ExtractionEvalUsageError(
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

const parseOrThrow = <T>(
  schema: z.ZodType<T>,
  value: unknown,
  file: string
): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ExtractionEvalUsageError(
      `${file} does not match the expected shape:\n${z.prettifyError(result.error)}`
    );
  }
  return result.data;
};

const goldenFileSchema = z.union([
  z.array(goldenReceiptSchema).min(1),
  z.object({ receipts: z.array(goldenReceiptSchema).min(1) }),
]);

/**
 * The key is either the bare array `golden.draft.json` is, or an object with a
 * `receipts` array, so an adjudication export can wrap it without a conversion
 * step. Unknown keys — the proposed key's `notes` block among them — are read
 * and dropped: they document the reading, they are not scored.
 */
export const readGoldenFile = async (
  file: string
): Promise<GoldenReceipt[]> => {
  const value = parseOrThrow(goldenFileSchema, await readJson(file), file);
  return Array.isArray(value) ? value : value.receipts;
};

const readCategorizationGolden = async (
  file: string
): Promise<CategorizationGoldenItem[]> =>
  parseOrThrow(
    z
      .array(
        z.object({
          categorySlug: z.string().min(1),
          kind: z.string(),
          name: z.string(),
        })
      )
      .min(1),
    await readJson(file),
    file
  );

const callRecordSchema = z.object({
  cost: z.number().nullable(),
  error: z.string().nullable(),
  host: z.string().nullable(),
  inputTokens: z.number().nullable(),
  latencyMs: z.number(),
  outputTokens: z.number().nullable(),
});

const itemMatchSchema = z.object({
  f1: z.number(),
  golden: z.number(),
  matched: z.number(),
  precision: z.number(),
  predicted: z.number(),
  recall: z.number(),
  unmatchedGolden: z.array(z.number()),
});

const extractionScoresSchema = z.object({
  datetimeExact: z.boolean().nullable(),
  gstReported: z.boolean(),
  lineItemF1: z.number().nullable(),
  lineItemMatch: itemMatchSchema.nullable(),
  paymentExact: z.boolean().nullable(),
  reconcileMatches: z.boolean().nullable(),
  schemaValid: z.boolean(),
  totalExact: z.boolean().nullable(),
});

const categorizationScoresSchema = z.object({
  agreed: z.number(),
  agreement: z.number(),
  mismatches: z.array(
    z.object({
      golden: z.string(),
      name: z.string(),
      predicted: z.string().nullable(),
    })
  ),
  total: z.number(),
});

const errorDetailSchema = z.object({
  message: z.string(),
  name: z.string(),
  rawText: z.string().optional(),
  responseBody: z.string().optional(),
  statusCode: z.number().optional(),
  url: z.string().optional(),
});

const variantSchema = z.enum(["A-free", "A-fp8", "B-fp8", "C-fp8", "D"]);

/**
 * A recorded extraction is trusted as written: `run.ts` only stored a value
 * that came back through the production contract, and re-validating it here
 * would let a schema `.default()` rewrite the very data being scored. The
 * re-score reads the fields the scorer reads, and a malformed one fails loudly
 * with the receipt id in the message.
 */
const extractionSchema = z.custom<Extraction>(
  (value) => typeof value === "object" && value !== null,
  { message: "not an extraction object" }
);

const runRecordSchema = z.object({
  calls: z.array(callRecordSchema),
  categories: z.array(z.string().nullable()).nullable(),
  categorization: categorizationScoresSchema.nullable(),
  cost: z.number().nullable(),
  error: errorDetailSchema.nullable(),
  extraction: extractionSchema.nullable(),
  host: z.string().nullable(),
  hosts: z.array(z.string()),
  inputTokens: z.number().nullable(),
  latencyMs: z.number(),
  outputTokens: z.number().nullable(),
  receiptId: z.string(),
  run: z.number(),
  scores: extractionScoresSchema.nullable(),
  strictFallback: z.boolean(),
  transcript: z.string().nullable(),
  variant: variantSchema,
});

const runsFileSchema = z.object({
  generatedAt: z.string(),
  model: z.string(),
  // Partial: a matrix the spend guard stopped leaves later variants missing,
  // and the re-score still reports what was recorded.
  runs: z.partialRecord(
    variantSchema,
    z.record(z.string(), z.array(runRecordSchema))
  ),
  runsPerReceipt: z.number(),
  spend: z.object({
    aborted: z.boolean(),
    reason: z.string().nullable(),
    totalUsd: z.number(),
  }),
  strictOutputs: z.boolean(),
});

export const readRunsFile = async (file: string): Promise<RunsFile> => {
  const parsed = parseOrThrow(runsFileSchema, await readJson(file), file);
  const records = (variant: keyof typeof parsed.runs): RunRecord[] =>
    Object.values(parsed.runs[variant] ?? {}).flat();
  if (records("A-free").length + records("A-fp8").length === 0) {
    throw new ExtractionEvalUsageError(
      `${file} holds no A runs; is it a runs.json from run.ts?`
    );
  }
  return {
    generatedAt: parsed.generatedAt,
    model: parsed.model,
    runs: {
      "A-fp8": parsed.runs["A-fp8"] ?? {},
      "A-free": parsed.runs["A-free"] ?? {},
      "B-fp8": parsed.runs["B-fp8"] ?? {},
      "C-fp8": parsed.runs["C-fp8"] ?? {},
      D: parsed.runs.D ?? {},
    },
    runsPerReceipt: parsed.runsPerReceipt,
    spend: parsed.spend,
    strictOutputs: parsed.strictOutputs,
  };
};

/**
 * `buildDisputes` only ever reads a receipt's `id` and `merchant`, so the
 * corpus is rebuilt from the key instead of a corpus.json the re-score has no
 * other use for. Order matches the key, which matches the corpus.
 */
const corpusFromGolden = (golden: GoldenReceipt[]): CorpusEntry[] =>
  golden.map((row) => ({
    bytes: 0,
    height: 0,
    id: row.id,
    imagePath: "",
    merchant: row.merchantName,
    objectKey: "",
    sha256: "",
    total: row.total,
    transactionDatetime: row.transactionDatetime,
    width: 0,
  }));

/* -------------------------------------------------------------------------- */
/* Output                                                                     */
/* -------------------------------------------------------------------------- */

const writeJson = async (file: string, value: unknown): Promise<void> => {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
};

const ratio = (sum: number, runs: number): string => {
  const value = meanOf(sum, runs);
  return value === null ? "—" : value.toFixed(3);
};

const main = async () => {
  const options = parseRescoreArgs(process.argv.slice(2));
  const runsFile = await readRunsFile(options.runsPath);
  const golden = await readGoldenFile(options.goldenPath);
  const categorizationGolden =
    options.categorizationPath === null
      ? null
      : await readCategorizationGolden(options.categorizationPath);

  const goldenIds = new Set(golden.map((row) => row.id));
  const seen = new Set<string>();
  for (const variant of extractionVariants) {
    for (const receiptId of Object.keys(runsFile.runs[variant])) {
      seen.add(receiptId);
      if (!goldenIds.has(receiptId)) {
        throw new ExtractionEvalUsageError(
          `${options.runsPath} holds ${variant} runs for ${receiptId}, which ${options.goldenPath} does not have.`
        );
      }
    }
  }
  const missing = golden.filter((row) => !seen.has(row.id));
  if (missing.length > 0) {
    throw new ExtractionEvalUsageError(
      `${options.goldenPath} has ${missing.length} receipt(s) the runs never saw: ${missing
        .map((row) => row.id)
        .join(", ")}. A key must describe exactly the receipts that were run.`
    );
  }

  const report = buildRescoreReport({
    categorizationGolden,
    generatedAt: new Date().toISOString(),
    golden,
    goldenFilePath: options.goldenPath,
    label: options.label,
    runsFile,
    runsFilePath: options.runsPath,
  });
  const summary = buildRescoreSummary(report);

  await mkdir(options.outDir, { recursive: true });

  // The stamp is this re-score's own, not the runs': the file was regenerated
  // now, against a key that did not exist when the runs were recorded.
  const disputes = buildDisputes({
    corpus: corpusFromGolden(golden),
    generatedAt: report.generatedAt,
    golden: new Map(golden.map((row) => [row.id, row])),
    runs: report.runs,
  });

  await writeJson(
    path.join(options.outDir, "summary.json"),
    summaryJsonSchema.parse(summary)
  );
  await writeFile(
    path.join(options.outDir, "summary.md"),
    buildRescoreMarkdown(report)
  );
  await writeJson(path.join(options.outDir, "disputes.json"), disputes);

  if (options.comparePath !== null) {
    const baseline = parseOrThrow(
      summaryJsonSchema,
      await readJson(options.comparePath),
      options.comparePath
    );
    await writeFile(
      path.join(options.outDir, "DELTA.md"),
      buildDeltaMarkdown(baseline, summary, disputes)
    );
  }

  console.log(
    `Re-score: ${report.receipts.length} receipts × ${report.runsPerReceipt} runs × ${extractionVariants.length} variants against ${options.label}`
  );
  console.log(`  runs:   ${options.runsPath}`);
  console.log(`  golden: ${options.goldenPath}`);
  console.log(`  out:    ${options.outDir}\n`);

  console.log("Variants");
  printTable(VARIANT_TABLE_HEADERS, variantTableRows(report.runs));

  console.log("\nLine items");
  printTable(
    ["variant", "mean F1", "amount P", "amount R", "amount F1", "name exact"],
    extractionVariants.map((variant) => {
      const metrics = report.numbers[variant];
      return [
        variant,
        ratio(metrics.f1Sum, metrics.runs),
        ratio(metrics.amountPrecisionSum, metrics.runs),
        ratio(metrics.amountRecallSum, metrics.runs),
        ratio(metrics.amountF1Sum, metrics.runs),
        metrics.nameMatched === 0
          ? "—"
          : `${metrics.nameExact}/${metrics.nameMatched}`,
      ];
    })
  );

  const { categorization } = report;
  if (categorization !== null) {
    console.log(
      `\nCategorization: ${categorization.runs
        .map((run) => `${run.agreed}/${run.total}`)
        .join(", ")}`
    );
  }
  console.log(
    `\nRe-scored ${report.comparison?.records ?? 0} records; ${report.comparison?.differing ?? 0} now differ from runs.json.`
  );
  console.log(`Wrote ${options.outDir}/summary.md`);
  console.log(`Wrote ${options.outDir}/summary.json`);
  console.log(`Wrote ${options.outDir}/disputes.json`);
  if (options.comparePath !== null) {
    console.log(`Wrote ${options.outDir}/DELTA.md`);
  }
};

/**
 * A guard rather than the bare `main()` call `run.ts` uses, so the argument
 * parser and the loaders can be imported by a test without reading files or
 * writing results.
 */
const isEntrypoint = (): boolean => {
  const [entry] = process.argv.slice(1);
  return entry !== undefined && pathToFileURL(entry).href === import.meta.url;
};

if (isEntrypoint()) {
  try {
    await main();
  } catch (error) {
    if (!(error instanceof ExtractionEvalUsageError)) {
      throw error;
    }
    console.error(`${error.message}\n`);
    process.exitCode = 1;
  }
}
