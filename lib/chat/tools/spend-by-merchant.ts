import { tool } from "ai";
import { z } from "zod";

import { merchantSpendSchema } from "../output-schemas";
import { spendByMerchant } from "../queries";
import { resolvePeriod } from "../range";
import { dateRangeInput } from "./date-range";

export const spend_by_merchant = (ownerId: string, today: Temporal.PlainDate) =>
  tool({
    description:
      "Total spend per merchant over a period, with the overall total. Use for 'how much did I spend at <merchant>?' questions. Pass the period the user named as range. It counts every merchant and does not filter by product or category — use search_line_items for a product and spend_by_category for a category.",
    execute: ({ from, range, to }) =>
      spendByMerchant(ownerId, resolvePeriod({ from, range, to }, today)),
    inputSchema: z.object(dateRangeInput),
    outputSchema: merchantSpendSchema,
  });
