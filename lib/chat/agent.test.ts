import { describe, expect, it } from "vitest";

import { buildInstructions } from "./agent";

const CATEGORIES = [
  { name: "Groceries", parentName: null },
  { name: "Bakery", parentName: "Groceries" },
  { name: "Meat & Seafood", parentName: "Groceries" },
];

/**
 * The prompt is pure: the route resolves "today" from the viewer's clock and
 * hands it in, so the date can be pinned here rather than assumed to be the
 * one the suite happens to run on.
 */
const TODAY = Temporal.PlainDate.from("2026-10-07");
const TIMEZONE = "America/Bogota";

const count = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1;

const instructions = buildInstructions(CATEGORIES, TODAY, TIMEZONE);

describe(buildInstructions, () => {
  it("states the viewer's own date and zone", () => {
    // The regression this pins: the date was the server's, read in a hardcoded
    // Brisbane, so a viewer west of it was told tomorrow's date and answered
    // "spend today" from a day that had barely started for them.
    expect(instructions).toContain("Today is 2026-10-07 (America/Bogota)");
  });

  it("leaks no tool-call markup into the prompt", () => {
    for (const fragment of [
      "<tool_call>",
      "</think>",
      "arg_key",
      "arg_value",
    ]) {
      expect(instructions).not.toContain(fragment);
    }
  });

  it("states each asking-questions rule exactly once", () => {
    expect(count(instructions, "do not ask — answer directly")).toBe(1);
    expect(count(instructions, "call ask_user first")).toBe(1);
    expect(count(instructions, "Only when the missing detail")).toBe(1);
  });

  it("keeps the asking-questions rules in order", () => {
    const ask = instructions.indexOf("call ask_user first");
    const answer = instructions.indexOf("do not ask — answer directly");
    const infer = instructions.indexOf("Only when the missing detail");

    expect(ask).toBeGreaterThan(-1);
    expect(answer).toBeGreaterThan(ask);
    expect(infer).toBeGreaterThan(answer);
  });
});
