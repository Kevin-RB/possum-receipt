import { tool } from "ai";
import { z } from "zod";

import { receiptSummariesSchema } from "../output-schemas";
import { listReceiptSummaries } from "../queries";
import { resolvePeriod } from "../range";
import { dateRangeInput } from "./date-range";

export const list_receipts = (ownerId: string, today: Temporal.PlainDate) =>
  tool({
    description:
      "List the user's individual receipts, optionally filtered by period and merchant. Use to show or find receipts ('my Woolworths receipts from last month'), not to calculate spending — use spend_by_merchant for a merchant total. Returns receipt ids for use with receipt_detail.",
    execute: ({ from, merchant, range, to }) =>
      listReceiptSummaries(ownerId, {
        ...resolvePeriod({ from, range, to }, today),
        merchant,
      }),
    inputSchema: z.object({
      ...dateRangeInput,
      merchant: z.string().optional(),
    }),
    outputSchema: receiptSummariesSchema,
  });
