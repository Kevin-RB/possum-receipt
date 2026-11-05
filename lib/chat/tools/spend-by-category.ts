import { tool } from "ai";
import { z } from "zod";

import { categorySpendSchema } from "../output-schemas";
import { spendByCategory } from "../queries";
import { resolvePeriod } from "../range";
import { dateRangeInput } from "./date-range";

/** Exported so its grouping contract can be asserted directly. */
export const spendByCategoryInput = z.object({
  category: z
    .string()
    .optional()
    .describe(
      'Narrow to one category by name: a top-level category such as "Health", which returns its subcategories, or a single subcategory such as "Pharmacy".'
    ),
  ...dateRangeInput,
  groupBy: z
    .enum(["subcategory", "category"])
    .optional()
    .describe(
      'Use "category" for a question about a whole top-level category, such as Groceries; omit it for the subcategory breakdown.'
    ),
});

export const spend_by_category = (ownerId: string, today: Temporal.PlainDate) =>
  tool({
    description:
      "Total spend over a period, counting products only, broken down by subcategory (the leaf categories, the default) or by top-level category, and optionally narrowed to one category. Use for category questions such as 'how much did I spend on groceries?'. Pass the period the user named as range. The overall total is included.",
    execute: ({ category, from, groupBy, range, to }) =>
      spendByCategory(ownerId, {
        ...resolvePeriod({ from, range, to }, today),
        category,
        groupBy,
      }),
    inputSchema: spendByCategoryInput,
    outputSchema: categorySpendSchema,
  });
