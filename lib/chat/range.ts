import "temporal-polyfill/global";

/**
 * The periods a chat tool can be asked for by name.
 *
 * Picking one is classification, which the local model does well; turning
 * "last month" into a pair of dates is arithmetic, which it does badly —
 * measured against the fixture, "this week" came back as an arbitrary two-day
 * window. So the name is the model's answer and the dates are ours.
 */
export const CHAT_RANGES = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "this_year",
  "last_year",
  "all_time",
] as const;

export type ChatRange = (typeof CHAT_RANGES)[number];

/** Inclusive bounds as receipt-local `YYYY-MM-DD`; either end may be open. */
export interface DateBounds {
  from?: string;
  to?: string;
}

/** What a tool call asked for: a named period, or bounds no name covers. */
export interface PeriodInput extends DateBounds {
  range?: ChatRange;
}

/**
 * Monday, the first day of a week here. `dayOfWeek` is 1 for Monday through 7
 * for Sunday, so subtracting one less than it walks back to the Monday.
 */
const startOfWeek = (day: Temporal.PlainDate): Temporal.PlainDate =>
  day.subtract({ days: day.dayOfWeek - 1 });

const inclusive = (
  from: Temporal.PlainDate,
  to: Temporal.PlainDate
): DateBounds => ({ from: from.toString(), to: to.toString() });

/**
 * A new range must be added here as well as to `CHAT_RANGES`: the `never`
 * argument makes a missing case a type error rather than an empty window.
 */
const unhandledRange = (range: never): never => {
  throw new Error(`Unhandled range: ${JSON.stringify(range)}`);
};

/**
 * The inclusive bounds a named period means, relative to `today`.
 *
 * Pure and clock-free: `today` is the viewer's own day, resolved once by the
 * route (ADR-0016) and handed to both the prompt and the tools, so "last month"
 * means the same thing in the sentence the model reads and in the query it
 * runs. Reading a clock here would put the two back in disagreement.
 *
 * `this_*` ends at today rather than at the end of the period, because "how much
 * this week" asks about the week so far. `all_time` has no bounds at all, which
 * is what an omitted bound already means to the queries.
 */
export const resolveRange = (
  range: ChatRange,
  today: Temporal.PlainDate
): DateBounds => {
  switch (range) {
    case "today": {
      return inclusive(today, today);
    }
    case "yesterday": {
      const yesterday = today.subtract({ days: 1 });
      return inclusive(yesterday, yesterday);
    }
    case "this_week": {
      return inclusive(startOfWeek(today), today);
    }
    case "last_week": {
      const monday = startOfWeek(today).subtract({ days: 7 });
      return inclusive(monday, monday.add({ days: 6 }));
    }
    case "this_month": {
      return inclusive(today.with({ day: 1 }), today);
    }
    case "last_month": {
      const first = today.with({ day: 1 }).subtract({ months: 1 });
      return inclusive(first, first.with({ day: first.daysInMonth }));
    }
    case "this_year": {
      return inclusive(today.with({ day: 1, month: 1 }), today);
    }
    case "last_year": {
      const first = today.with({ day: 1, month: 1, year: today.year - 1 });
      return inclusive(first, first.with({ day: 31, month: 12 }));
    }
    case "all_time": {
      return {};
    }
    default: {
      return unhandledRange(range);
    }
  }
};

/**
 * The bounds a tool call actually means.
 *
 * A named range wins over explicit dates, so a call carrying both — a model
 * repeating an argument, or a client cache of the old shape — cannot move the
 * window away from the period the user named. No period at all is all time:
 * the model is not made to ask for one just because the field is absent.
 */
export const resolvePeriod = (
  { from, range, to }: PeriodInput,
  today: Temporal.PlainDate
): DateBounds => {
  if (range) {
    return resolveRange(range, today);
  }
  if (from || to) {
    return { from, to };
  }
  return {};
};
