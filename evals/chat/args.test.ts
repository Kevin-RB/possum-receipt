import { describe, expect, it } from "vitest";

import { parseEvalArgs } from "./args";

describe("eval args", () => {
  it("defaults to the catalogue's resolved model", () => {
    expect(parseEvalArgs([])).toStrictEqual({ local: false });
  });

  it("accepts --local", () => {
    expect(parseEvalArgs(["--local"])).toStrictEqual({ local: true });
  });

  it("refuses a mistyped flag instead of falling through to a remote run", () => {
    // The flag exists to avoid spending credit, so a typo must not silently
    // run the default model — which, with a key in .env.local, is the remote one.
    expect(() => parseEvalArgs(["--locl"])).toThrow(/--locl/u);
  });

  it("refuses a positional argument", () => {
    expect(() => parseEvalArgs(["local"])).toThrow(/local/u);
  });
});
