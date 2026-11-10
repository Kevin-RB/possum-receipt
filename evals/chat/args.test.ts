import { describe, expect, it } from "vitest";

import { EVAL_USAGE, EvalUsageError, parseEvalArgs } from "./args";

/** The usage error `args` raises, so a test can assert on it without a `catch`. */
const usageError = (args: string[]): EvalUsageError => {
  try {
    parseEvalArgs(args);
  } catch (error) {
    if (error instanceof EvalUsageError) {
      return error;
    }
    throw error;
  }
  throw new Error(`parseEvalArgs(${args.join(" ")}) should have thrown`);
};

describe("eval args", () => {
  it("defaults to the catalogue's resolved model", () => {
    expect(parseEvalArgs([])).toStrictEqual({ local: false });
  });

  it("accepts --local", () => {
    expect(parseEvalArgs(["--local"])).toStrictEqual({ local: true });
  });

  it("refuses a mistyped flag instead of falling through to a remote run", () => {
    // The flag exists to avoid spending credit, so a typo must not silently run
    // the default model — which, with a key in .env.local, is the remote one.
    expect(() => parseEvalArgs(["--locl"])).toThrow(EvalUsageError);
  });

  it("refuses a positional argument", () => {
    expect(() => parseEvalArgs(["local"])).toThrow(EvalUsageError);
  });

  it("carries the reason and the usage block, so the script can print them", () => {
    const error = usageError(["--locl"]);

    expect(error.message).toContain("--locl");
    expect(error.message).toContain(EVAL_USAGE);
  });
});
