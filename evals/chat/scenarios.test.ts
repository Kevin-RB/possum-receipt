import { describe, expect, it } from "vitest";

import type { Observation } from "./scenarios";
import {
  expectAnswerAgreesWithRows,
  expectAnswerNamesNewestDate,
  expectNoClaim,
  expectNoMismatchedAmounts,
  expectNoRunaway,
  expectNoTools,
  expectTools,
  scenarios,
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

  it("allows a second read-only lookup after the expected one", () => {
    // The case that used to fail a correct answer: an empty search for
    // "cheese", then the same tool again for a synonym. The model answered the
    // question; the extra call is a cost, and the step count reports it.
    expect(
      expectTools([
        { input: { query: "cheese" }, name: "search_line_items" },
      ]).run(
        observation({
          tools: [
            {
              input: { query: "cheese" },
              name: "search_line_items",
              output: {},
            },
            {
              input: { query: "cheddar" },
              name: "search_line_items",
              output: {},
            },
          ],
        })
      ).ok
    ).toBeTruthy();
  });

  it("still fails a lookup it did not need when the scenario forbids extras", () => {
    expect(
      expectTools([{ name: "ask_user" }], { allowExtra: [] }).run(
        observation({
          tools: [
            { input: {}, name: "spend_by_category", output: {} },
            { input: {}, name: "ask_user", output: {} },
          ],
        })
      ).ok
    ).toBeFalsy();
  });

  it("fails an extra ask_user, because asking is not a lookup", () => {
    expect(
      expectTools([{ name: "search_line_items" }]).run(
        observation({
          tools: [
            { input: {}, name: "search_line_items", output: {} },
            { input: {}, name: "ask_user", output: {} },
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

describe("no tools expected", () => {
  it("fails any lookup, because the prompt asked for none", () => {
    expect(
      expectNoTools.run(
        observation({
          tools: [{ input: {}, name: "search_line_items", output: {} }],
        })
      ).ok
    ).toBeFalsy();
  });

  it("passes a run that answered without one", () => {
    expect(expectNoTools.run(observation()).ok).toBeTruthy();
  });
});

describe(expectNoRunaway, () => {
  const check = expectNoRunaway(8);

  it("passes a run that took a few steps", () => {
    expect(check.run(observation({ steps: 3 })).ok).toBeTruthy();
  });

  it("fails a run that reached the agent's ceiling, which is a loop", () => {
    expect(check.run(observation({ steps: 8 })).ok).toBeFalsy();
  });
});

describe("mismatched amounts", () => {
  const check = expectNoMismatchedAmounts([]);
  const totals = [
    {
      input: {},
      name: "spend_by_category",
      output: {
        categories: [{ category: "Groceries", total: 49.67 }],
        total: 49.67,
      },
    },
  ];

  it("passes when the answer quotes the total the tool returned", () => {
    expect(
      check.run(
        observation({
          answer: "You spent $49.67 on groceries last month.",
          tools: totals,
        })
      ).ok
    ).toBeTruthy();
  });

  it("passes when the answer quotes no figure, because the table carries it", () => {
    expect(
      check.run(
        observation({
          answer: "The figure above is the whole picture for the month.",
          tools: totals,
        })
      ).ok
    ).toBeTruthy();
  });

  it("does not let a count stand in for an amount", () => {
    // $12.00 must not pass because some lookup returned `count: 12`.
    expect(
      check.run(
        observation({
          answer: "You spent $12.00 on groceries.",
          tools: [
            {
              input: {},
              name: "spend_by_category",
              output: {
                categories: [{ category: "Groceries", total: 12.5 }],
                count: 12,
                total: 12.5,
              },
            },
          ],
        })
      ).ok
    ).toBeFalsy();
  });

  it("fails an amount no tool returned", () => {
    expect(
      check.run(
        observation({ answer: "You spent $52.10 on groceries.", tools: totals })
      ).ok
    ).toBeFalsy();
  });
});

describe(expectAnswerAgreesWithRows, () => {
  const check = expectAnswerAgreesWithRows({ name: "search_line_items" });

  it("passes when nothing came back and the answer says so", () => {
    expect(
      check.run(
        observation({
          answer: "I couldn't find any cheese purchases.",
          tools: [
            {
              input: {},
              name: "search_line_items",
              output: { count: 0, items: [], total: 0 },
            },
          ],
        })
      ).ok
    ).toBeTruthy();
  });

  it("fails when nothing came back but the answer describes a purchase", () => {
    expect(
      check.run(
        observation({
          answer: "You last bought cheese on 2026-08-16.",
          tools: [
            {
              input: {},
              name: "search_line_items",
              output: { count: 0, items: [], total: 0 },
            },
          ],
        })
      ).ok
    ).toBeFalsy();
  });

  it("passes when rows came back and the answer reports them", () => {
    expect(
      check.run(
        observation({
          answer:
            "Yes — four yogurt purchases this year, most recently on 2026-09-12.",
          tools: [
            {
              input: {},
              name: "search_line_items",
              output: {
                count: 4,
                items: [{ date: "2026-09-12" }],
                total: 12.5,
              },
            },
          ],
        })
      ).ok
    ).toBeTruthy();
  });

  it("fails when rows came back but the answer says nothing was found", () => {
    expect(
      check.run(
        observation({
          answer: "I couldn't find any yogurt purchases.",
          tools: [
            {
              input: {},
              name: "search_line_items",
              output: {
                count: 4,
                items: [{ date: "2026-09-12" }],
                total: 12.5,
              },
            },
          ],
        })
      ).ok
    ).toBeFalsy();
  });

  it("reads the denials a model actually writes", () => {
    const noneReturned = {
      input: {},
      name: "search_line_items",
      output: { count: 0, items: [], total: 0 },
    };

    const denials = [
      "You don't have any Woolworths receipts on record from last year.",
      "No, you didn’t buy any peanuts this month.",
      "There weren't any matching purchases.",
      "I couldn't find any cheese.",
    ];

    expect(
      denials.map(
        (answer) => check.run(observation({ answer, tools: [noneReturned] })).ok
      )
    ).toStrictEqual([true, true, true, true]);
  });

  it("reads a curly apostrophe as the contraction it is", () => {
    expect(
      check.run(
        observation({
          answer: "I couldn’t find any cheese — nothing matching it.",
          tools: [
            {
              input: {},
              name: "search_line_items",
              output: { count: 0, items: [], total: 0 },
            },
          ],
        })
      ).ok
    ).toBeTruthy();
  });

  it("accepts an absence mentioned in passing on a question that did find rows", () => {
    expect(
      check.run(
        observation({
          answer:
            "Yes — four yogurt purchases this year, most recently 2026-09-12; none since then.",
          tools: [
            {
              input: {},
              name: "search_line_items",
              output: {
                count: 4,
                items: [{ date: "2026-09-12" }],
                total: 12.5,
              },
            },
          ],
        })
      ).ok
    ).toBeTruthy();
  });

  it("reads a list result that is a bare array", () => {
    expect(
      expectAnswerAgreesWithRows({ name: "list_receipts" }).run(
        observation({
          answer: "There are no Woolworths receipts from last year.",
          tools: [{ input: {}, name: "list_receipts", output: [] }],
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
  const check = expectAnswerNamesNewestDate({ name: "search_line_items" });

  it("matches a date written with typographic spaces", () => {
    // OpenAI-style models write "17 May 2026" with a U+202F, not a U+0020.
    expect(
      check.run(
        observation({
          answer: "The most recent purchase was on Sunday, 17 May 2026.",
          tools: [
            {
              input: {},
              name: "search_line_items",
              output: { items: [{ date: "2026-05-17" }] },
            },
          ],
        })
      ).ok
    ).toBeTruthy();
  });

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

/** A yogurt search for one range, with the given number of rows back. */
const searchCall = (range: string, count: number) => ({
  input: { query: "yogurt", range },
  name: "search_line_items",
  output: { count, items: Array.from({ length: count }, () => ({})) },
});

describe("scoping to the lookup the question asked for", () => {
  const YOGURT_THIS_YEAR = {
    input: { query: "yogurt", range: "this_year" },
    name: "search_line_items",
  };

  it("fails a denial when a later, unrelated lookup came back empty", () => {
    // Regression: `findLast` read the empty `last_year` call and passed a run
    // that denied rows the `this_year` lookup returned.
    const check = expectAnswerAgreesWithRows(YOGURT_THIS_YEAR);

    expect(
      check.run(
        observation({
          answer: "No, you didn't buy any yogurt this year.",
          tools: [searchCall("this_year", 4), searchCall("last_year", 0)],
        })
      ).ok
    ).toBeFalsy();
  });

  it("ignores a lookup the scenario did not ask for", () => {
    const check = expectAnswerAgreesWithRows(YOGURT_THIS_YEAR);

    expect(
      check.run(
        observation({
          answer: "You bought yogurt twice this year.",
          tools: [searchCall("last_year", 9), searchCall("this_year", 2)],
        })
      ).ok
    ).toBeTruthy();
  });

  it("passes only when every lookup for the question was empty", () => {
    const check = expectAnswerAgreesWithRows(YOGURT_THIS_YEAR);

    expect(
      check.run(
        observation({
          answer: "No yogurt purchases this year.",
          tools: [searchCall("this_year", 0), searchCall("this_year", 0)],
        })
      ).ok
    ).toBeTruthy();
  });

  it("accepts a figure from a same-period breakdown the model also ran", () => {
    // The mirror of the all-time case: a subcategory total beside the pinned
    // category total answers the same period, so quoting it is legitimate.
    const check = expectNoMismatchedAmounts([
      {
        input: { category: "Groceries", range: "this_year" },
        name: "spend_by_category",
      },
    ]);

    expect(
      check.run(
        observation({
          answer: "Groceries cost $1,203.87, of which produce was $200.",
          tools: [
            {
              input: { category: "Groceries", range: "this_year" },
              name: "spend_by_category",
              output: { total: 1203.87 },
            },
            {
              input: { groupBy: "subcategory", range: "this_year" },
              name: "spend_by_category",
              output: { total: 200 },
            },
          ],
        })
      ).ok
    ).toBeTruthy();
  });

  it("accepts a figure another tool returned for the same period", () => {
    // A merchant total beside the pinned category total is a lookup the model
    // was allowed to make; failing a correct answer for quoting it is the
    // expensive direction. Only a different period is out of scope.
    const check = expectNoMismatchedAmounts([
      {
        input: { category: "Groceries", range: "this_year" },
        name: "spend_by_category",
      },
    ]);

    expect(
      check.run(
        observation({
          answer: "You spent $800 at Woolworths this year.",
          tools: [
            {
              input: { range: "this_year" },
              name: "spend_by_merchant",
              output: { total: 800 },
            },
          ],
        })
      ).ok
    ).toBeTruthy();
  });

  it("treats a redundant bound beside the named range as the same period", () => {
    const check = expectNoMismatchedAmounts([
      {
        input: { query: "chicken", range: "this_year" },
        name: "search_line_items",
      },
    ]);

    expect(
      check.run(
        observation({
          answer: "You spent $26.97 on chicken this year.",
          tools: [
            {
              input: {
                from: "2026-01-01",
                query: "chicken",
                range: "this_year",
              },
              name: "search_line_items",
              output: { total: 26.97 },
            },
          ],
        })
      ).ok
    ).toBeTruthy();
  });

  it("does not let an all-time total vouch for a this-year answer", () => {
    // Regression: the amount check pooled every call, so an extra all-time
    // lookup made its figure "known" for a question scoped to this year.
    const check = expectNoMismatchedAmounts([
      {
        input: { query: "chicken", range: "this_year" },
        name: "search_line_items",
      },
    ]);

    const thisYear = {
      input: { query: "chicken", range: "this_year" },
      name: "search_line_items",
      output: { summary: { total: 26.97 } },
    };
    const allTime = {
      input: { query: "chicken" },
      name: "search_line_items",
      output: { summary: { total: 89.91 } },
    };

    expect(
      check.run(
        observation({
          answer: "You've spent $89.91 on chicken this year.",
          tools: [thisYear, allTime],
        })
      ).ok
    ).toBeFalsy();
    expect(
      check.run(
        observation({
          answer: "You've spent $26.97 on chicken this year.",
          tools: [thisYear, allTime],
        })
      ).ok
    ).toBeTruthy();
  });
});

describe("the denials a model actually writes", () => {
  const check = expectAnswerAgreesWithRows({ name: "search_line_items" });
  const empty = [
    {
      input: { query: "peanuts" },
      name: "search_line_items",
      output: { count: 0, items: [] },
    },
  ];

  it.each([
    "No peanuts in the last two weeks.",
    "You haven't purchased any peanuts in the last two weeks.",
    "There are no peanuts in the last two weeks.",
    "You have no peanut purchases on record.",
    "None.",
    "No peanuts.",
    "No yogurt.",
  ])("accepts %s", (answer) => {
    expect(check.run(observation({ answer, tools: empty })).ok).toBeTruthy();
  });

  it("does not read a hedge as a claim that the corpus is empty", () => {
    expect(
      check.run(
        observation({
          answer: "There's no way to know whether you bought peanuts.",
          tools: empty,
        })
      ).ok
    ).toBeFalsy();
  });

  it("still refuses a hedge that ends the sentence", () => {
    expect(
      check.run(
        observation({ answer: "There's no way to know.", tools: empty })
      ).ok
    ).toBeFalsy();
  });
});

describe("amounts in an answer", () => {
  const totals = [
    {
      input: {},
      name: "spend_by_category",
      output: { categories: [], total: 1203.87 },
    },
  ];

  it("inspects a whole-dollar figure written as money", () => {
    // Regression: the pattern required cents, so "$500" was not read at all and
    // any invented round number passed.
    expect(
      expectNoMismatchedAmounts([]).run(
        observation({ answer: "You spent $500 on groceries.", tools: totals })
      ).ok
    ).toBeFalsy();
    expect(
      expectNoMismatchedAmounts([]).run(
        observation({
          answer: "You spent $1,203.87 on groceries.",
          tools: totals,
        })
      ).ok
    ).toBeTruthy();
  });

  it("does not read a year or a count as money", () => {
    expect(
      expectNoMismatchedAmounts([]).run(
        observation({
          answer: "Across 2026 you bought 3 receipts' worth.",
          tools: totals,
        })
      ).ok
    ).toBeTruthy();
  });

  it("compares a discount by magnitude, which is how it is quoted", () => {
    // Regression: the tool returns -3.20 and the answer says "$3.20 discount".
    expect(
      expectNoMismatchedAmounts([]).run(
        observation({
          answer: "That receipt includes a $3.20 discount.",
          tools: [
            {
              input: {},
              name: "receipt_detail",
              output: { items: [{ lineTotal: -3.2 }] },
            },
          ],
        })
      ).ok
    ).toBeTruthy();
  });
});

/** The filter the scenario pins; a run may also list the period unfiltered. */
const WOOLWORTHS_LAST_YEAR = { merchant: "Woolworths", range: "last_year" };

/** A prior-year lookup that returned the given number of rows. */
const listReceipts = (
  count: number,
  input: Record<string, unknown> = WOOLWORTHS_LAST_YEAR
) => [
  {
    input,
    name: "list_receipts",
    output: { count, items: Array.from({ length: count }, () => ({})) },
  },
];

describe("receipts from last year", () => {
  // The fixture dates receipts relative to the day it was provisioned, so how
  // many fall in the prior calendar year depends on that month — zero in
  // November, several in January. The scenario must pass either way.
  const scenario = scenarios.find(
    (candidate) => candidate.name === "receipts from last year"
  );
  const answerCheck = scenario?.checks.find((check) => check.kind === "answer");

  it("passes when the prior year held none", () => {
    expect(
      answerCheck?.run(
        observation({
          answer: "You have no Woolworths receipts from last year.",
          tools: listReceipts(0),
        })
      ).ok
    ).toBeTruthy();
  });

  it("passes when it held some, as it does for a fixture provisioned in January", () => {
    expect(
      answerCheck?.run(
        observation({
          answer: "You have two Woolworths receipts from last year.",
          tools: listReceipts(2),
        })
      ).ok
    ).toBeTruthy();
    expect(
      answerCheck?.run(
        observation({
          answer: "You have no Woolworths receipts from last year.",
          tools: listReceipts(2),
        })
      ).ok
    ).toBeFalsy();
  });

  it("is not decided by a broader lookup the question did not ask for", () => {
    // "Show me my Woolworths receipts last year": a run that lists every
    // receipt in the prior year and then filters in prose is still correct, so
    // the unfiltered rows must not turn its denial into a failure.
    expect(
      answerCheck?.run(
        observation({
          answer: "You have no Woolworths receipts from last year.",
          tools: [
            ...listReceipts(3, { range: "last_year" }),
            ...listReceipts(0, { merchant: "Woolworths", range: "last_year" }),
          ],
        })
      ).ok
    ).toBeTruthy();
  });

  it("fails when the filtered lookup found receipts the answer denies", () => {
    expect(
      answerCheck?.run(
        observation({
          answer: "You have no Woolworths receipts from last year.",
          tools: listReceipts(2),
        })
      ).ok
    ).toBeFalsy();
  });
});
