import { tool } from "ai";
import { z } from "zod";

import { lineItemSearchSchema } from "../output-schemas";
import { searchLineItems } from "../queries";
import { resolvePeriod } from "../range";
import { dateRangeInput } from "./date-range";

export const search_line_items = (ownerId: string, today: Temporal.PlainDate) =>
  tool({
    description:
      "Search the user's receipt line items by product-name keyword, optionally within a period. Use for product questions — 'did I buy yogurt in the last week?', 'how much did I spend on chicken this month?', 'when did I last buy milk?' — and pass the user's own words: receipt names are abbreviated and the search tolerates near-misses. The period is optional, so search all time when the user gives none rather than asking for one. Returns the matching items and their summed total, counting products only (up to 25 matches; the total covers them).",
    execute: ({ from, query, range, to }) =>
      searchLineItems(ownerId, {
        ...resolvePeriod({ from, range, to }, today),
        query,
      }),
    inputSchema: z.object({
      ...dateRangeInput,
      query: z
        .string()
        .describe("Keyword to match against item names, e.g. 'cheese'"),
    }),
    outputSchema: lineItemSearchSchema,
  });
