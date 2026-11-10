import { parseArgs } from "node:util";

export const EVAL_USAGE = [
  "Usage: pnpm eval:chat [--local]",
  "--local runs the catalogue's local entry instead of the default, so a keyed",
  ".env.local does not make every run a remote one. Anything else is refused:",
  "a mistyped flag would otherwise start a full remote run and spend credit.",
].join("\n");

/**
 * A problem with how the command was invoked, as opposed to a run that failed.
 * The script prints the message and exits non-zero without a stack trace, the
 * same way `FixtureUsageError` handles `pnpm db:fixture`.
 */
export class EvalUsageError extends Error {
  override name = "EvalUsageError";
}

export interface EvalOptions {
  /**
   * Run the local model even when a remote key resolves. The eval compares
   * models, so it has to be able to measure the one a deployment does not
   * offer — which is the same selection the route refuses for a reader.
   */
  local: boolean;
}

/**
 * `parseArgs` in strict mode, so an unknown or mistyped flag is refused before
 * any model is constructed. That is the point: the flag exists to avoid
 * spending credit, and a typo that fell through to the default would do exactly
 * what it was meant to prevent.
 *
 * The `node:util` error is converted rather than thrown, so the caller decides
 * by type and never has to match on `ERR_PARSE_ARGS_*`.
 */
export const parseEvalArgs = (args: readonly string[]): EvalOptions => {
  try {
    const { values } = parseArgs({
      args: [...args],
      options: { local: { default: false, type: "boolean" } },
      strict: true,
    });

    return { local: values.local };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EvalUsageError(`${reason}\n${EVAL_USAGE}`);
  }
};
