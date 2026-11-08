/**
 * Scenario definitions for the real-model chat eval. Each check asserts one
 * part of a run's behaviour — which tools were called, with which arguments,
 * how far a loop ran, or what the answer said — so a regression report names
 * the part that broke rather than just failing the prompt.
 *
 * **A run passes when it answered correctly with the lookups the question
 * needed.** Steps and latency are reported, not scored: a model that searches a
 * synonym after an empty result has still answered the question, and charging
 * it a failure for the extra call made the score fall while the answers stayed
 * right. The one efficiency failure kept is a run that reaches the agent's step
 * ceiling, because that is a loop rather than an extra look.
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
   * Tools the model may call on top of the expected ones, in any order. It
   * defaults to the read-only queries, because a second lookup — a synonym
   * after an empty result, a `list_receipts` after a spend total — is still the
   * model answering the question. Pass `[]` where the scenario is about *not*
   * acting first: a greeting, or a clarifying question that must be asked
   * before any query runs.
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

/**
 * Typography is not meaning. A model writes "17 May 2026" with a U+202F narrow
 * space and "couldn’t" with a curly apostrophe; comparing raw bytes fails a
 * correct answer for the font it chose, which is exactly the false negative
 * these checks exist to avoid.
 */
const normalise = (text: string): string =>
  text
    .replaceAll(/[\u00A0\u2009\u202F]/gu, " ")
    .replaceAll(/[\u2018\u2019]/gu, "'");

const includes = (text: string, phrase: string): boolean =>
  normalise(text).toLowerCase().includes(normalise(phrase).toLowerCase());

/**
 * The read-only queries a chat can run. Every one of them is owner-scoped and
 * side-effect free, so an extra one costs tokens and a little latency but
 * cannot change the answer's correctness — which is what this eval scores.
 * `ask_user` is deliberately absent: stopping to ask when the reader asked a
 * question is a different behaviour, and the scenarios that want it say so.
 */
const READ_TOOLS = [
  "list_receipts",
  "receipt_detail",
  "search_line_items",
  "spend_by_category",
  "spend_by_merchant",
];

/**
 * Asserts the expected tool calls appear, in order, with the expected
 * arguments. Anything else on top is allowed when it is a read-only query;
 * `ask_user`, or anything outside the read set, still fails unless the
 * scenario names it.
 */
export const expectTools = (
  expected: ExpectedTool[],
  { allowExtra = READ_TOOLS }: ToolsOptions = {}
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

export const expectNoTools: Check = expectTools([], { allowExtra: [] });

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
      .filter((sentence) => !HEDGE.test(normalise(sentence)))
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

/**
 * The only efficiency check that fails a run. Every scenario gets it appended
 * by the runner: a model that needs the agent's whole step budget has looped,
 * which no amount of correct wording makes up for. A run that merely took one
 * more lookup than usual is normal, and shows up in the reported step count.
 */
export const expectNoRunaway = (maxSteps: number): Check => ({
  expected: `fewer than ${maxSteps} steps`,
  kind: "steps",
  run: (observation) => ({
    actual: `${observation.steps} ${observation.steps === 1 ? "step" : "steps"}`,
    ok: observation.steps < maxSteps,
  }),
});

/**
 * Ways a model reports that nothing was found. A short list of shapes rather
 * than of sentences: "no peanut purchases", "nothing matching turned up",
 * "I found no cheese", "that list is empty" all mean the same thing, and an
 * answer that says one of them is right however it was phrased.
 */
const SAYS_NOTHING = [
  /\bno\b[^.!?]{0,60}\b(?:receipts?|records?|results?|purchases?|matches?|items?)\b/iu,
  /\bnothing\b[^.!?]{0,40}\b(?:came|comes|matches?|matched|matching|turned|turns|found|on file|recorded|shows?)\b/iu,
  /\b(?:found|find|finds|have|has)\s+no\b/iu,
  // "I couldn't find", "you didn't buy", "don't have", "there aren't any".
  /\b(?:can'?t|cannot|couldn'?t|could not|didn'?t|did not|don'?t|do not|doesn'?t|does not|haven'?t|have not)\s+(?:find|see|locate|record|purchase|buy|have)\b/iu,
  /\b(?:isn'?t|aren'?t|wasn'?t|weren'?t)\s+any\b/iu,
  /\bnone\b|\bempty\b/iu,
];

const saysNothing = (text: string): boolean =>
  SAYS_NOTHING.some((pattern) => pattern.test(normalise(text)));

/**
 * The narrower half: the answer *claims the search found nothing*, which is a
 * denial rather than a passing mention of an absence ("none in June" is fine on
 * a question that did find rows; "I couldn't find any" is not).
 */
const CLAIMS_NOT_FOUND = [
  /\b(?:can'?t|cannot|couldn'?t|could not|didn'?t|did not|have not|haven'?t)\s+(?:find|see|locate|record)\b/iu,
  /\bnothing\b[^.!?]{0,40}\b(?:came|comes|turned|turns|matches?|matched|matching)\b/iu,
  /\bno\b[^.!?]{0,40}\b(?:records?|results?|matches?)\b/iu,
  /\bempty\b/iu,
];

const claimsNotFound = (text: string): boolean =>
  CLAIMS_NOT_FOUND.some((pattern) => pattern.test(normalise(text)));

const DATE_PATTERN = /\b\d{4}-\d{2}-\d{2}\b/u;

/**
 * The fields a tool result carries money in. A count or an id is a number too,
 * and collecting those would let `$12.00` pass because some lookup returned
 * `count: 12` — the invented-amount hole this check exists to close.
 */
const MONEY_FIELDS = new Set([
  "gst",
  "lineTotal",
  "subtotal",
  "total",
  "unitPrice",
]);

/**
 * Every amount a tool returned, and only those. An answer may state a figure
 * the question needs, but only one the data produced: a model inventing or
 * mis-adding an amount is the failure this eval exists to catch (a real trace
 * claimed $372.66 for rows summing to $373.16). A summary that quotes nothing
 * is fine — the number is on screen in the rendered table.
 */
const amountsReturned = (value: unknown, isMoney = false): number[] => {
  if (typeof value === "number") {
    return isMoney && Number.isFinite(value) ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => amountsReturned(item, isMoney));
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, child]) =>
      amountsReturned(child, MONEY_FIELDS.has(key))
    );
  }
  return [];
};

/** Amounts written with cents — `$49.67`, `1,234.56` — which is how money reads. */
const MONEY_PATTERN =
  /(?:\$|aud\s?)?(?<whole>\d{1,3}(?:,\d{3})+|\d+)\.(?<cents>\d{2})\b/giu;

const amountsIn = (text: string): number[] =>
  [...text.matchAll(MONEY_PATTERN)].map(({ groups }) =>
    Number(`${groups?.whole.replaceAll(",", "")}.${groups?.cents}`)
  );

const sameAmount = (a: number, b: number): boolean => Math.abs(a - b) < 0.005;

export const expectNoMismatchedAmounts: Check = {
  expected: "no amount the tools did not return",
  kind: "answer",
  run: (observation) => {
    const known = observation.tools.flatMap((tool) =>
      amountsReturned(tool.output)
    );
    const wrong = amountsIn(observation.answer).filter(
      (amount) => !known.some((value) => sameAmount(value, amount))
    );

    return {
      actual:
        wrong.length === 0
          ? "every amount matches a tool result"
          : `states ${wrong[0].toFixed(2)}, which no tool returned`,
      ok: wrong.length === 0,
    };
  },
};

/**
 * For a question whose answer the corpus decides is "none" — no cheese, no
 * Woolworths receipts last year. The fixture is deterministic (ADR-0013), so
 * the expectation can be stated outright instead of derived from whichever
 * lookup the model happened to run last.
 */
export const expectAnswerSaysNothing: Check = {
  expected: "answer reports that there are none",
  kind: "answer",
  run: (observation) => ({
    actual: saysNothing(observation.answer)
      ? "says there are none"
      : "describes something as found",
    ok: saysNothing(observation.answer),
  }),
};

/** The rows of a tool result, whether it returns an array or wraps one. */
const rowsOf = (output: unknown): unknown[] | null => {
  if (Array.isArray(output)) {
    return output;
  }
  if (isRecord(output) && Array.isArray(output.items)) {
    return output.items;
  }
  return null;
};

/**
 * "Did I buy …?" is answered yes or no, and the tool said which. This is the
 * assertion that the answer agrees with the data rather than merely looking
 * plausible: a model that searched, found nothing, and answered "none" passes;
 * one that searched, found nothing, and described a purchase does not. When
 * rows did come back it asserts the weaker, checkable half — that the answer
 * does not deny them — rather than reading a count back out of prose.
 */
export const expectAnswerAgreesWithRows = (toolName: string): Check => ({
  expected: `answer agrees with whether ${toolName} found rows`,
  kind: "answer",
  run: (observation) => {
    const call = observation.tools.findLast((tool) => tool.name === toolName);
    const output = call?.output;
    const count =
      isRecord(output) && typeof output.count === "number"
        ? output.count
        : rowsOf(output)?.length;

    if (count === undefined) {
      return {
        actual: `${toolName} returned no count to check against`,
        ok: false,
      };
    }

    if (count === 0) {
      const nothing = saysNothing(observation.answer);

      return {
        actual: nothing
          ? "no rows, and the answer says so"
          : "no rows, but the answer does not say so",
        ok: nothing,
      };
    }

    const denies = claimsNotFound(observation.answer);

    return {
      actual: denies
        ? `${count} rows, but the answer says nothing was found`
        : `${count} rows, and the answer does not deny them`,
      ok: !denies,
    };
  },
});

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
      const saysNone = saysNothing(observation.answer);
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
 * "Last month" and "this year" are asserted by name. The model names a period
 * and the tools resolve it against the same day the prompt states, so no date
 * arithmetic — the model's, or this file's — belongs in an expectation.
 */
export const scenarios: Scenario[] = [
  {
    checks: [expectNoTools],
    name: "greeting",
    prompt: "Hello",
  },
  {
    checks: [
      expectTools([
        {
          input: { groupBy: "category", range: "this_year" },
          name: "spend_by_category",
        },
      ]),
      expectNoMismatchedAmounts,
    ],
    name: "category breakdown, period given",
    prompt: "Breakdown by category this year",
  },
  {
    // Asking before looking is the behaviour: with no period the model has
    // nothing to query, so `allowExtra: []` keeps a speculative lookup out.
    checks: [
      expectClarification,
      expectTools([{ name: "ask_user" }], { allowExtra: [] }),
    ],
    name: "category breakdown, no period",
    prompt: "Breakdown by category",
  },
  {
    checks: [
      expectTools([
        { input: { range: "last_month" }, name: "spend_by_merchant" },
      ]),
    ],
    name: "merchant spend, last month",
    prompt: "How much did I spend at Woolworths last month?",
  },
  {
    checks: [
      expectTools([{ input: { query: "cheese" }, name: "search_line_items" }]),
      expectAnswerAgreesWithRows("search_line_items"),
    ],
    name: "find a product",
    prompt: "Find cheese",
  },
  {
    checks: [
      expectTools([
        {
          input: { category: "Groceries", range: "this_year" },
          name: "spend_by_category",
        },
      ]),
      expectNoMismatchedAmounts,
    ],
    name: "top-level category total",
    prompt: "How much did I spend on groceries this year?",
  },
  {
    checks: [
      expectTools([
        {
          input: { query: "yogurt", range: "this_year" },
          name: "search_line_items",
        },
      ]),
      expectAnswerAgreesWithRows("search_line_items"),
    ],
    name: "product history, period given",
    prompt: "Did I buy yogurt this year?",
  },
  {
    // No peanuts in the corpus. The point is that a period the user supplied
    // sends the model straight to the product search, not to ask_user. "The last
    // two weeks" is a period no range names, so whichever range the model takes
    // as nearest is not asserted — only that it did not stop to ask.
    checks: [
      expectTools([{ input: { query: "peanuts" }, name: "search_line_items" }]),
      expectAnswerAgreesWithRows("search_line_items"),
    ],
    name: "product history, no match",
    prompt: "Did I buy peanuts in the last two weeks?",
  },
  {
    // "last year" is the range a model reaches for "this year" when the enum
    // does not offer it, and the answer is then confidently about the wrong
    // calendar year.
    checks: [
      expectTools([{ input: { range: "last_year" }, name: "list_receipts" }]),
      // The fixture holds no Woolworths receipts in 2025, and the model may
      // reach that answer with or without the merchant filter, so the answer
      // is what is checked — not the row count of the call it made last.
      expectAnswerSaysNothing,
    ],
    name: "receipts from last year",
    prompt: "Show me my Woolworths receipts from last year",
  },
  {
    checks: [
      expectTools([
        {
          input: { query: "chicken", range: "this_year" },
          name: "search_line_items",
        },
      ]),
      expectNoMismatchedAmounts,
    ],
    name: "product spend",
    prompt: "How much did I spend on chicken this year?",
  },
  {
    checks: [
      expectTools([{ name: "search_line_items" }]),
      expectAnswerNamesNewestDate("search_line_items"),
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
