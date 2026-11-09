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

/**
 * The calls a check should read: those matching the scenario's expected tools.
 * An extra read-only lookup is allowed, but a figure or a row count from a call
 * the scenario did not ask for must not decide the verdict — otherwise a
 * `last_year` lookup can answer a `this_year` question, because it ran later.
 *
 * No fallback to every call: when nothing matches, the run has not made the
 * lookup the question needed, and `expectTools` — which takes the same spec —
 * has already failed it. Widening the scope here would let a broader lookup
 * decide a narrower question.
 */
const callsFor = (
  observation: Observation,
  expected: readonly ExpectedTool[]
): ToolCall[] => {
  if (expected.length === 0) {
    return observation.tools;
  }

  return observation.tools.filter((call) =>
    expected.some(
      (want) =>
        call.name === want.name &&
        (want.input === undefined || matchesInput(want.input, call.input))
    )
  );
};

/** The keys that decide *which period* a lookup covers. */
const PERIOD_KEYS = ["from", "range", "to"] as const;

/**
 * Whether a lookup covers the period the pinned spec names. Only the keys the
 * spec pins are compared — the subset rule `matchesInput` applies — so a
 * redundant explicit bound beside a named range is the same period, while
 * `range: "this_year"` and no range at all are not.
 */
const coversPeriod = (
  pinned: Record<string, unknown>,
  actual: Record<string, unknown>
): boolean =>
  PERIOD_KEYS.every((key) =>
    pinned[key] === undefined ? true : pinned[key] === actual[key]
  );

/**
 * The calls whose figures may vouch for an answer: those covering the question's
 * period, **whichever tool produced them**. The tool name is deliberately not
 * part of the scope — a merchant total beside a category total is a figure the
 * model was allowed to look up, and reporting it as invented is the expensive
 * direction (it fails a correct answer).
 *
 * What the scope must still keep out is a *different period*: an all-time lookup
 * cannot vouch for a "this year" answer.
 */
const amountCalls = (
  observation: Observation,
  expected: readonly ExpectedTool[]
): ToolCall[] => {
  if (expected.length === 0) {
    return observation.tools;
  }

  return observation.tools.filter((call) =>
    expected.some((want) => coversPeriod(want.input ?? {}, call.input))
  );
};

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
 * than of sentences: "no peanut purchases", "no peanuts in the last two weeks",
 * "nothing matching turned up", "I couldn't find any cheese" all mean the same
 * thing, and an answer that says one of them is right however it was phrased.
 *
 * The bare-"no" shape needs a period or place after the item — "no peanuts in
 * the last two weeks", "no cheese this year" — which is what keeps a hedge out:
 * "no way to know" is not a claim that the corpus is empty.
 */
const SAYS_NOTHING = [
  /\bno\b[^.!?]{0,60}\b(?:receipts?|records?|results?|purchases?|matches?|items?)\b/iu,
  /\bno\s+(?:[\w'-]+\s+){0,4}(?:in|on|for|from|during|over|this|last|that|at|with|anywhere|at all)\b/iu,
  // A terse denial ending the sentence: "No peanuts." / "No yogurt." The
  // hedge nouns are excluded so "there's no way to know." stays a hedge.
  /\bno\s+(?!way\b|idea\b|doubt\b|need\b|problem\b|chance\b|reason\b)[\w'-]+(?:\s+[\w'-]+){0,2}\s*[.!?,;]/iu,
  /\bnothing\b[^.!?]{0,40}\b(?:came|comes|matches?|matched|matching|turned|turns|found|on file|recorded|shows?)\b/iu,
  /\b(?:found|find|finds|have|has|are|is|were|was)\s+no\b/iu,
  // "I couldn't find", "you didn't buy", "don't have", "haven't purchased",
  // "there aren't any". The inflections are listed because `\b` after the stem
  // rejects "purchased".
  /\b(?:can'?t|cannot|couldn'?t|could not|didn'?t|did not|don'?t|do not|doesn'?t|does not|haven'?t|have not|hasn'?t|has not)\s+(?:find|see|locate|record|purchas(?:e|ed|es|ing)|bought|buy|buying|have|had)\b/iu,
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
  /\b(?:can'?t|cannot|couldn'?t|could not|didn'?t|did not|have not|haven'?t)\s+(?:find|see|locate|record|purchas(?:e|ed|es|ing)|bought|buy)\b/iu,
  /\bnothing\b[^.!?]{0,40}\b(?:came|comes|turned|turns|matches?|matched|matching)\b/iu,
  // "you have no Woolworths receipts", "I found no cheese".
  /\b(?:found|find|finds|have|has|had|are|is|were|was)\s+no\b/iu,
  /\bno\b[^.!?]{0,40}\b(?:receipts?|records?|results?|purchases?|matches?|items?)\b/iu,
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

/**
 * A figure written as money, in either of the two shapes an answer uses: a
 * currency-marked number at any precision (`$500`, `$1,203.87`, `aud 42`), or
 * an unmarked one with cents (`49.67`), because a count or a year has no cents.
 *
 * The marker is what lets a whole-dollar amount be inspected without turning
 * every bare number back into money — the hole `MONEY_FIELDS` closed on the
 * tool side. The trailing guard is `(?!\d)` and not `(?![\d,])`: a figure is
 * routinely followed by a comma in prose ("$1,203.87, of which…"), and
 * rejecting that made the engine fall back to the whole-dollar prefix.
 */
const MONEY_PATTERN =
  /(?:\$|aud\s?)(?<markedWhole>\d{1,3}(?:,\d{3})+|\d+)(?:\.(?<markedCents>\d{2}))?(?!\d)|(?<![\d.,])(?<bareWhole>\d{1,3}(?:,\d{3})+|\d+)\.(?<bareCents>\d{2})(?!\d)/giu;

const amountsIn = (text: string): number[] =>
  [...text.matchAll(MONEY_PATTERN)].map(({ groups }) => {
    const whole = (groups?.markedWhole ?? groups?.bareWhole ?? "0").replaceAll(
      ",",
      ""
    );

    return Number(
      `${whole}.${groups?.markedCents ?? groups?.bareCents ?? "00"}`
    );
  });

/**
 * Compared by magnitude: a discount is quoted as a positive figure ("a $3.20
 * discount") against a negative line total, and the claim this check makes is
 * about the number, not its sign.
 */
const sameAmount = (a: number, b: number): boolean =>
  Math.abs(Math.abs(a) - Math.abs(b)) < 0.005;

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

const rowCount = (call: ToolCall): number | undefined => {
  if (isRecord(call.output) && typeof call.output.count === "number") {
    return call.output.count;
  }
  return rowsOf(call.output)?.length;
};

/**
 * Every amount a tool returned, and only those, from the calls the scenario
 * asked for. An answer may state a figure the question needs, but only one the
 * data produced: a model inventing or mis-adding an amount is the failure this
 * eval exists to catch (a real trace claimed $372.66 for rows summing to
 * $373.16). A summary that quotes nothing is fine — the number is on screen in
 * the rendered table.
 *
 * Scoped, so an all-time total cannot pass for a "this year" answer just
 * because the model ran an all-time lookup on the way.
 */
export const expectNoMismatchedAmounts = (
  expected: readonly ExpectedTool[]
): Check => ({
  expected: "no amount the tools did not return",
  kind: "answer",
  run: (observation) => {
    const known = amountCalls(observation, expected).flatMap((tool) =>
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
});

/**
 * "Did I buy …?" is answered yes or no, and the tool said which. This is the
 * assertion that the answer agrees with the data rather than merely looking
 * plausible: a model that searched, found nothing, and answered "none" passes;
 * one that searched, found nothing, and described a purchase does not. When
 * rows did come back it asserts the weaker, checkable half — that the answer
 * does not deny them — rather than reading a count back out of prose.
 *
 * Reads every call the scenario asked for and takes the largest row count: the
 * answer must not deny rows that came back from any of them, whichever lookup
 * ran last. A count of zero therefore means every such lookup was empty.
 */
export const expectAnswerAgreesWithRows = (expected: ExpectedTool): Check => ({
  expected: `answer agrees with whether ${formatTool(expected)} found rows`,
  kind: "answer",
  run: (observation) => {
    const counts = callsFor(observation, [expected])
      .map(rowCount)
      .filter((count): count is number => count !== undefined);

    if (counts.length === 0) {
      return {
        actual: `${expected.name} returned no count to check against`,
        ok: false,
      };
    }

    const count = Math.max(...counts);

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

export const expectAnswerNamesNewestDate = (expected: ExpectedTool): Check => ({
  expected: `answer names the newest ${expected.name} date, or reports no records`,
  kind: "answer",
  run: (observation) => {
    const newest =
      callsFor(observation, [expected])
        .flatMap((call) =>
          isRecord(call.output) && Array.isArray(call.output.items)
            ? (call.output.items as { date?: string | null }[])
            : []
        )
        .map((item) => item.date)
        .filter((date): date is string => Boolean(date))
        .toSorted()
        .at(-1) ?? null;

    if (!newest) {
      const saysNone = saysNothing(observation.answer);
      const claimsDate = DATE_PATTERN.test(observation.answer);
      return {
        actual: saysNone
          ? `${expected.name} returned no dated rows and the answer says so`
          : `${expected.name} returned no dated rows but the answer does not say so`,
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
 * The lookups each scenario pins. One spec feeds both `expectTools` and the
 * answer checks, so the answer is judged against the call the question asked
 * for — and a second lookup the model made along the way cannot decide it.
 */
const CATEGORY_BREAKDOWN_THIS_YEAR: ExpectedTool = {
  input: { groupBy: "category", range: "this_year" },
  name: "spend_by_category",
};

const GROCERIES_THIS_YEAR: ExpectedTool = {
  input: { category: "Groceries", range: "this_year" },
  name: "spend_by_category",
};

const CHEESE_SEARCH: ExpectedTool = {
  input: { query: "cheese" },
  name: "search_line_items",
};

const YOGURT_THIS_YEAR: ExpectedTool = {
  input: { query: "yogurt", range: "this_year" },
  name: "search_line_items",
};

const PEANUTS_SEARCH: ExpectedTool = {
  input: { query: "peanuts" },
  name: "search_line_items",
};

const WOOLWORTHS_LAST_YEAR: ExpectedTool = {
  input: { merchant: "Woolworths", range: "last_year" },
  name: "list_receipts",
};

const CHICKEN_THIS_YEAR: ExpectedTool = {
  input: { query: "chicken", range: "this_year" },
  name: "search_line_items",
};

/** "When did I last buy …?" takes no period: the whole history is the answer. */
const ANY_YOGURT: ExpectedTool = { name: "search_line_items" };

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
      expectTools([CATEGORY_BREAKDOWN_THIS_YEAR]),
      expectNoMismatchedAmounts([CATEGORY_BREAKDOWN_THIS_YEAR]),
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
      expectTools([CHEESE_SEARCH]),
      expectAnswerAgreesWithRows(CHEESE_SEARCH),
    ],
    name: "find a product",
    prompt: "Find cheese",
  },
  {
    checks: [
      expectTools([GROCERIES_THIS_YEAR]),
      expectNoMismatchedAmounts([GROCERIES_THIS_YEAR]),
    ],
    name: "top-level category total",
    prompt: "How much did I spend on groceries this year?",
  },
  {
    checks: [
      expectTools([YOGURT_THIS_YEAR]),
      expectAnswerAgreesWithRows(YOGURT_THIS_YEAR),
    ],
    name: "product history, period given",
    prompt: "Did I buy yogurt this year?",
  },
  {
    // No peanuts in the corpus. The point is that a period the user supplied
    // sends the model straight to the product search, not to ask_user. "The last
    // two weeks" is a period no range names, so whichever range the model takes
    // as nearest is not asserted — only that it did not stop to ask. The row
    // check reads every peanut lookup for the same reason: the answer must agree
    // with the one that found something, not with whichever ran last.
    checks: [
      expectTools([PEANUTS_SEARCH]),
      expectAnswerAgreesWithRows(PEANUTS_SEARCH),
    ],
    name: "product history, no match",
    prompt: "Did I buy peanuts in the last two weeks?",
  },
  {
    // "last year" is the range a model reaches for "this year" when the enum
    // does not offer it, and the answer is then confidently about the wrong
    // calendar year. What the fixture holds in the prior year depends on the
    // month it was provisioned (receipts sit relative to `asOf`, `last_year` is
    // a calendar year), so the check is agreement with the rows, not a
    // hardcoded "none" that would invert in January.
    //
    // The merchant is pinned with the range: a broad "all receipts last year"
    // lookup would otherwise be the call the answer is judged against, and a
    // correct "no Woolworths receipts" would fail on its rows.
    checks: [
      expectTools([WOOLWORTHS_LAST_YEAR]),
      expectAnswerAgreesWithRows(WOOLWORTHS_LAST_YEAR),
    ],
    name: "receipts from last year",
    prompt: "Show me my Woolworths receipts from last year",
  },
  {
    checks: [
      expectTools([CHICKEN_THIS_YEAR]),
      expectNoMismatchedAmounts([CHICKEN_THIS_YEAR]),
    ],
    name: "product spend",
    prompt: "How much did I spend on chicken this year?",
  },
  {
    checks: [
      expectTools([ANY_YOGURT]),
      expectAnswerNamesNewestDate(ANY_YOGURT),
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
