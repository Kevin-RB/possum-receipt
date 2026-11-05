import { z } from "zod";

import { CHAT_RANGES } from "../range";

/**
 * The period a tool call covers, as the user named it.
 *
 * The model chooses from this enum instead of converting "last month" into
 * dates: `resolvePeriod` in `lib/chat/range.ts` does the arithmetic against the
 * viewer's own day, so the window a tool queries and the "today" its prompt
 * states cannot disagree.
 */
export const chatRange = z
  .enum(CHAT_RANGES)
  .describe("The period the user asked about. Prefer this to from/to.");

/** An inclusive calendar date in the receipt timezone, as `YYYY-MM-DD`. */
export const isoDate = z.iso.date().describe("An inclusive date (YYYY-MM-DD).");

/**
 * Shared by every date-filtered read tool: a named period, or the explicit dates
 * the enum cannot express ("between 3 and 9 March").
 *
 * All three are optional because an omitted period means all time. A tool that
 * is worth nothing without a period says so in its description instead, so the
 * model asks the user rather than the schema rejecting the call.
 */
export const dateRangeInput = {
  from: isoDate
    .optional()
    .describe("First date, only for dates the user named themselves."),
  range: chatRange.optional(),
  to: isoDate
    .optional()
    .describe("Last date, only for dates the user named themselves."),
};
