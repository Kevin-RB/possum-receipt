import { describe, expect, it } from "vitest";

import type { Observation } from "./scenarios";
import {
  expectAnswerNamesNewestDate,
  expectNoClaim,
  expectTools,
} from "./scenarios";

const observation = (overrides: Partial<Observation> = {}): Observation => ({
  answer: "",
  steps: 1,
  tools: [],
  ...overrides,
});

describe(expectTools, () => {
  it("matches tool names and a partial input case-insensitively", () => {
    const result = expectTools([
      { input: { query: "cheese" }, name: "search_line_items" },
    ]).run(
      observation({
        tools: [
          {
            input: { query: "Cheese", range: "last_month" },
            name: "search_line_items",
            output: {},
          },
        ],
      })
    );

    expect(result).toStrictEqual({
      actual: 'search_line_items {"query":"Cheese","range":"last_month"}',
      ok: true,
    });
  });

  it("does not accept a category whose case differs, since the query is exact", () => {
    expect(
      expectTools([
        { input: { category: "Groceries" }, name: "spend_by_category" },
      ]).run(
        observation({
          tools: [
            {
              input: { category: "groceries" },
              name: "spend_by_category",
              output: {},
            },
          ],
        })
      ).ok
    ).toBeFalsy();
  });

  it("fails an extra tool call rather than ignoring it", () => {
    expect(
      expectTools([{ name: "search_line_items" }]).run(
        observation({
          tools: [
            { input: {}, name: "search_line_items", output: {} },
            { input: {}, name: "receipt_detail", output: {} },
          ],
        })
      ).ok
    ).toBeFalsy();
  });

  it("allows an extra tool that the scenario names", () => {
    expect(
      expectTools([{ name: "spend_by_merchant" }], {
        allowExtra: ["list_receipts"],
      }).run(
        observation({
          tools: [
            { input: {}, name: "spend_by_merchant", output: {} },
            { input: {}, name: "list_receipts", output: {} },
          ],
        })
      ).ok
    ).toBeTruthy();
  });
});

describe(expectNoClaim, () => {
  const check = expectNoClaim(["you have yogurt at home"]);

  it("ignores a hedged sentence that repeats the words", () => {
    expect(
      check.run(
        observation({
          answer:
            "I can't tell whether you have yogurt at home from receipts alone.",
        })
      ).ok
    ).toBeTruthy();
  });

  it("fails an unhedged claim", () => {
    expect(
      check.run(observation({ answer: "You have yogurt at home." })).ok
    ).toBeFalsy();
  });

  it("ignores a disclaimer about not having information", () => {
    expect(
      check.run(
        observation({
          answer:
            "I do not have any information about what you currently have stored at home.",
        })
      ).ok
    ).toBeTruthy();
  });

  it("ignores a sentence that contrasts purchases with current stock", () => {
    expect(
      check.run(
        observation({
          answer:
            "Receipts only show purchases, not what you currently have at home.",
        })
      ).ok
    ).toBeTruthy();
  });

  it("does not treat a reassurance as a hedge", () => {
    expect(
      check.run(
        observation({
          answer: "You don't need to worry, you have yogurt at home.",
        })
      ).ok
    ).toBeFalsy();
  });
});

describe(expectAnswerNamesNewestDate, () => {
  const check = expectAnswerNamesNewestDate("search_line_items");

  it("passes when the answer names the newest returned date", () => {
    expect(
      check.run(
        observation({
          answer: "The most recent purchase was on 2026-09-12.",
          tools: [
            {
              input: {},
              name: "search_line_items",
              output: {
                items: [{ date: "2026-09-12" }, { date: "2026-08-01" }],
              },
            },
          ],
        })
      ).ok
    ).toBeTruthy();
  });

  it("passes when no rows came back and the answer says so", () => {
    expect(
      check.run(
        observation({
          answer: "I could not find any records of you buying yogurt.",
          tools: [
            { input: {}, name: "search_line_items", output: { items: [] } },
          ],
        })
      ).ok
    ).toBeTruthy();
  });

  it("fails when no rows came back but the answer invents a date", () => {
    expect(
      check.run(
        observation({
          answer: "You last bought yogurt on 2026-09-12.",
          tools: [
            { input: {}, name: "search_line_items", output: { items: [] } },
          ],
        })
      ).ok
    ).toBeFalsy();
  });
});
