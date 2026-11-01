import "temporal-polyfill/global";
import { DEFAULT_TIMEZONE, resolveToday } from "@/lib/time";

/**
 * Scenario definitions for the real-model chat eval. Each check asserts one
 * part of a run's behaviour — which tools were called, with which arguments,
 * how many steps it took, or what the answer said — so a regression report
 * names the part that broke rather than just failing the prompt.
 */

export interface ToolCall {
  input: Record<string, unknown>;
  name: string;
  output: unknown;
}

export interface Observation {
  answer: string;
  steps: number;
  tools: ToolCall[];
}

export interface CheckResult {
  actual: string;
  ok: boolean;
}

export type CheckKind = "answer" | "clarification" | "steps" | "tools";

export interface Check {
  /** What a passing run looks like, printed in the results table. */
  expected: string;
  kind: CheckKind;
  run: (observation: Observation) => CheckResult;
}

export interface Scenario {
  checks: Check[];
  /** Short label for the results table. */
  name: string;
  prompt: string;
}

export interface ExpectedTool {
  input?: Record<string, unknown>;
  name: string;
}

export interface ToolsOptions {
  /**
   * Read tools the model may call on top of the expected ones. A model that
   * double-checks an empty result with `list_receipts` is still answering the
   * question; only unrelated tools are a failure.
   */
  allowExtra?: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A search keyword is matched case-insensitively because `search_line_items`
 * uses `ilike`; every other string is exact, because the query behind it uses
 * `eq` — accepting a lowercased category name would let a call that returns no
 * rows pass.
 */
const CASE_INSENSITIVE_INPUTS = new Set(["query"]);

const sameValue = (key: string, expected: unknown, actual: unknown): boolean =>
  typeof expected === "string" &&
  typeof actual === "string" &&
  CASE_INSENSITIVE_INPUTS.has(key)
    ? expected.trim().toLowerCase() === actual.trim().toLowerCase()
    : expected === actual;

const matchesInput = (
  expected: Record<string, unknown>,
  actual: Record<string, unknown>
): boolean =>
  Object.entries(expected).every(([key, value]) =>
    sameValue(key, value, actual[key])
  );

export const formatTool = (tool: { input?: unknown; name: string }): string =>
  tool.input === undefined
    ? tool.name
    : `${tool.name} ${JSON.stringify(tool.input)}`;

export const describeToolCalls = (tools: { name: string }[]): string =>
  tools.length === 0
    ? "no tools"
    : tools.map((tool) => formatTool(tool)).join("; ");

const quote = (value: string) => JSON.stringify(value);

const includes = (text: string, phrase: string): boolean =>
  text.toLowerCase().includes(phrase.toLowerCase());

/**
 * Asserts the expected tool calls appear in order with the expected arguments.
 * Extra calls fail unless they are explicitly allowed: a question that needs
 * one lookup taking three is the kind of drift this eval exists to see, not a
 * pass with a footnote.
 */
export const expectTools = (
  expected: ExpectedTool[],
  { allowExtra = [] }: ToolsOptions = {}
): Check => ({
  expected:
    describeToolCalls(expected) +
    (allowExtra.length > 0 ? ` (allowing ${allowExtra.join(", ")})` : ""),
  kind: "tools",
  run: (observation) => {
    const actual = describeToolCalls(observation.tools);
    const allowed = new Set(allowExtra);
    let matched = 0;

    for (const called of observation.tools) {
      const next = expected[matched];
      if (
        next &&
        called.name === next.name &&
        (next.input ? matchesInput(next.input, called.input) : true)
      ) {
        matched += 1;
      } else if (!allowed.has(called.name)) {
        return { actual, ok: false };
      }
    }

    return { actual, ok: matched === expected.length };
  },
});

export const expectNoTools: Check = expectTools([]);

export const expectClarification: Check = {
  expected: "ask_user is called",
  kind: "clarification",
  run: (observation) => ({
    actual: describeToolCalls(observation.tools),
    ok: observation.tools.some((tool) => tool.name === "ask_user"),
  }),
};

export const expectAnswerContains = (phrases: string[]): Check => ({
  expected: `answer contains ${phrases.map(quote).join(", ")}`,
  kind: "answer",
  run: (observation) => {
    const missing = phrases.filter(
      (phrase) => !includes(observation.answer, phrase)
    );
    return {
      actual:
        missing.length === 0
          ? "all phrases present"
          : `missing ${missing.map(quote).join(", ")}`,
      ok: missing.length === 0,
    };
  },
});

/**
 * Flags a claim only in an unhedged sentence. A correct answer to "do I have
 * yogurt at home?" often uses the same words as a wrong one — "I can't tell
 * whether you have yogurt at home" — so sentence-level hedging is what
 * separates a refusal from a claim. The hedge is deliberately narrow: a plain
 * "you don't need to worry, you have yogurt at home" is still a claim.
 */
const HEDGE =
  /\b(?:can't|cannot|can not|couldn't|unable|no (?:way|information)|only (?:show|see|record|tell|track)|not (?:what|whether|if)|(?:don't|do not|doesn't|does not|didn't|did not) (?:have|know|record|show|tell|track))\b/iu;

const sentences = (text: string): string[] =>
  text.split(/(?<=[.!?])\s+|\n+/u).filter((sentence) => sentence.length > 0);

export const expectNoClaim = (phrases: string[]): Check => ({
  expected: `answer avoids ${phrases.map(quote).join(", ")}`,
  kind: "answer",
  run: (observation) => {
    const claims = sentences(observation.answer)
      .filter((sentence) => !HEDGE.test(sentence))
      .filter((sentence) =>
        phrases.some((phrase) => includes(sentence, phrase))
      );
    return {
      actual:
        claims.length === 0
          ? "none of those phrases"
          : `claims in ${quote(claims[0])}`,
      ok: claims.length === 0,
    };
  },
});

export const expectMaxSteps = (max: number): Check => ({
  expected: `at most ${max} steps`,
  kind: "steps",
  run: (observation) => ({
    actual: `${observation.steps} ${observation.steps === 1 ? "step" : "steps"}`,
    ok: observation.steps <= max,
  }),
});

/** Ways a model can say the search came back empty without inventing a date. */
const NO_RECORDS = [
  "no records",
  "no results",
  "no purchases",
  "no matching",
  "did not find",
  "didn't find",
  "could not find",
  "couldn't find",
  "have not bought",
  "haven't bought",
];

const DATE_PATTERN = /\b\d{4}-\d{2}-\d{2}\b/u;

/**
 * `search_line_items` returns newest first, so the first row is the answer to
 * "when did I last buy …?". This reads the date out of the tool result rather
 * than the prompt: a scenario must prove the answer matches returned data, not
 * just that it contains a plausible-looking date.
 *
 * The fixture does not stock every product a scenario asks about, so an empty
 * result is a legitimate outcome: then the answer must say no records were
 * found, and must not invent a date.
 */
const pad2 = (value: number): string => value.toString().padStart(2, "0");

/** The ways a model is likely to write a receipt date back to the user. */
const dateForms = (isoDate: string): string[] => {
  const date = new Date(`${isoDate}T00:00:00Z`);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  return [
    isoDate,
    new Intl.DateTimeFormat("en-AU", {
      day: "numeric",
      month: "long",
      timeZone: "UTC",
      year: "numeric",
    }).format(date),
    new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      month: "long",
      timeZone: "UTC",
      year: "numeric",
    }).format(date),
    `${pad2(day)}/${pad2(month)}/${year}`,
  ];
};

export const expectAnswerNamesNewestDate = (toolName: string): Check => ({
  expected: `answer names the newest ${toolName} date, or reports no records`,
  kind: "answer",
  run: (observation) => {
    const call = observation.tools.findLast((tool) => tool.name === toolName);
    const items = isRecord(call?.output)
      ? (call.output.items as { date?: string | null }[] | undefined)
      : undefined;
    const newest =
      items
        ?.map((item) => item.date)
        .filter((date): date is string => Boolean(date))
        .toSorted()
        .at(-1) ?? null;

    if (!newest) {
      const saysNone = NO_RECORDS.some((phrase) =>
        includes(observation.answer, phrase)
      );
      const claimsDate = DATE_PATTERN.test(observation.answer);
      return {
        actual: saysNone
          ? `${toolName} returned no dated rows and the answer says so`
          : `${toolName} returned no dated rows but the answer does not say so`,
        ok: saysNone && !claimsDate,
      };
    }

    const named = dateForms(newest).some((form) =>
      includes(observation.answer, form)
    );
    return {
      actual: named
        ? `newest date ${newest} is in the answer`
        : `newest date ${newest} is missing from the answer`,
      ok: named,
    };
  },
});

/**
 * "Last month" is the previous calendar month in the zone the eval's agent is
 * told today's date in — the default zone, since an eval run has no viewer
 * behind it. Computing it here keeps the expectation correct whenever the eval
 * runs.
 */
const today = resolveToday(DEFAULT_TIMEZONE);
const thisMonthStart = today.with({ day: 1 });
const lastMonth = {
  from: thisMonthStart.subtract({ months: 1 }).toString(),
  to: thisMonthStart.subtract({ days: 1 }).toString(),
};
const thisYear = {
  from: today.with({ day: 1, month: 1 }).toString(),
  to: today.toString(),
};

export const scenarios: Scenario[] = [
  {
    checks: [expectNoTools, expectMaxSteps(1)],
    name: "greeting",
    prompt: "Hello",
  },
  {
    checks: [
      expectTools([
        { input: { groupBy: "category" }, name: "spend_by_category" },
      ]),
      expectMaxSteps(2),
    ],
    name: "category breakdown, period given",
    prompt: "Breakdown by category this year",
  },
  {
    checks: [
      expectClarification,
      expectTools([{ name: "ask_user" }]),
      expectMaxSteps(1),
    ],
    name: "category breakdown, no period",
    prompt: "Breakdown by category",
  },
  {
    checks: [
      expectTools([{ input: lastMonth, name: "spend_by_merchant" }], {
        allowExtra: ["list_receipts"],
      }),
      expectMaxSteps(3),
    ],
    name: "merchant spend, last month",
    prompt: "How much did I spend at Woolworths last month?",
  },
  {
    checks: [
      expectTools([{ input: { query: "cheese" }, name: "search_line_items" }]),
      expectMaxSteps(2),
    ],
    name: "find a product",
    prompt: "Find cheese",
  },
  {
    checks: [
      expectTools([
        { input: { category: "Groceries" }, name: "spend_by_category" },
      ]),
      expectMaxSteps(2),
    ],
    name: "top-level category total",
    prompt: "How much did I spend on groceries this year?",
  },
  {
    checks: [
      expectTools([
        {
          input: { from: thisYear.from, query: "yogurt" },
          name: "search_line_items",
        },
      ]),
      expectMaxSteps(2),
    ],
    name: "product history, period given",
    prompt: "Did I buy yogurt this year?",
  },
  {
    // No peanuts in the corpus. The point is that a period the user supplied
    // sends the model straight to the product search, not to ask_user.
    checks: [
      expectTools([{ input: { query: "peanuts" }, name: "search_line_items" }]),
      expectMaxSteps(2),
    ],
    name: "product history, no match",
    prompt: "Did I buy peanuts in the last two weeks?",
  },
  {
    checks: [
      expectTools([
        {
          input: { from: thisYear.from, query: "chicken" },
          name: "search_line_items",
        },
      ]),
      expectMaxSteps(2),
    ],
    name: "product spend",
    prompt: "How much did I spend on chicken this year?",
  },
  {
    checks: [
      expectTools([{ name: "search_line_items" }]),
      expectAnswerNamesNewestDate("search_line_items"),
      expectMaxSteps(3),
    ],
    name: "last purchase date",
    prompt: "When did I last buy yogurt?",
  },
  {
    checks: [
      // Receipts record purchases, not pantry stock. Either searching or asking
      // is fine, and reporting a past purchase is a good answer; what must not
      // happen is turning that purchase into a current-stock claim.
      expectNoClaim([
        "in your fridge",
        "in your pantry",
        "in stock",
        "right now you have",
        "you currently have",
        "you have some yogurt",
        "you have yogurt at home",
      ]),
    ],
    name: "current stock boundary",
    prompt: "Do I have yogurt at home?",
  },
];
