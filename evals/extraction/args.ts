import path from "node:path";
import { parseArgs } from "node:util";

export const EVAL_USAGE = [
  "Usage: pnpm exec tsx --env-file=.env.local ./evals/extraction/run.ts --corpus <dir> --out <dir>",
  "--corpus is the directory holding corpus.json, golden.draft.json, categories.json,",
  "categorization.golden.json and images/. --out is where runs.json, summary.md and",
  "disputes.json are written. Anything else is refused: a mistyped flag would",
  "otherwise start a paid run against OpenRouter and spend credit.",
].join("\n");

/**
 * A problem with how the command was invoked, as opposed to a run that failed.
 * The script prints the message and exits non-zero without a stack trace, the
 * same way `EvalUsageError` handles `pnpm eval:chat`.
 */
export class ExtractionEvalUsageError extends Error {
  override name = "ExtractionEvalUsageError";
}

export interface ExtractionEvalOptions {
  corpusDir: string;
  outDir: string;
}

/**
 * `parseArgs` in strict mode, so an unknown or mistyped flag is refused before
 * a model is constructed. Both paths are required: the corpus is real owner
 * receipts that must never be defaulted from inside the repository, and the
 * results must land outside it.
 */
export const parseExtractionEvalArgs = (
  args: readonly string[]
): ExtractionEvalOptions => {
  try {
    const { values } = parseArgs({
      args: [...args],
      options: {
        corpus: { type: "string" },
        out: { type: "string" },
      },
      strict: true,
    });

    if (!values.corpus || !values.out) {
      throw new ExtractionEvalUsageError(
        `Both --corpus and --out are required.\n${EVAL_USAGE}`
      );
    }

    return {
      corpusDir: path.resolve(values.corpus),
      outDir: path.resolve(values.out),
    };
  } catch (error) {
    if (error instanceof ExtractionEvalUsageError) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new ExtractionEvalUsageError(`${reason}\n${EVAL_USAGE}`);
  }
};
