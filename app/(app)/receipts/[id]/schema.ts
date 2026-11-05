import { z } from "zod";

import {
  merchantSchema,
  paymentSchema,
  totalsSchema,
  transactionSchema,
} from "@/lib/db/schema/receipt";
import {
  lineItemKindEnum,
  receiptItemInsertSchema,
} from "@/lib/db/schema/receipt-item";
import { isTimezone } from "@/lib/time";

/** An amount the receipt states: never negative, except a discount's unit price. */
const money = z.number().min(0);

/**
 * The unit price of a line item. Unlike quantity and the receipt totals, this
 * may be negative — a discount's unit price is negated alongside its line total
 * so `quantity × unitPrice` still reconciles, and the sign follows the kind
 * rather than the input. Rejecting it here would make a stored discount
 * unsaveable.
 */
const unitPrice = z.number();

export const updateReceiptSchema = z.object({
  items: z.array(
    receiptItemInsertSchema
      .omit({ categorySource: true, id: true, receiptId: true })
      .extend({
        // Whether the user changed this item's category in the form. The
        // submitted `categoryId` is only meaningful alongside it: without the
        // signal, a category filled in by a categorization run after the page
        // loaded would be overwritten by the stale form value and recorded as
        // a user decision.
        categoryTouched: z.boolean().default(false),
        // Named `itemId` rather than `id` because `useFieldArray` generates its
        // own `id` for each row and overwrites the field of that name, so a
        // payload key of `id` would be ambiguous.
        itemId: z.uuid({ message: "Invalid line item ID" }).optional(),
        kind: lineItemKindEnum.default("product"),
        lineTotal: z.number(),
        quantity: money.nullable().optional(),
        // `unitPrice`, not `money`: a discount's unit price is negative, and
        // rejecting it here would make a stored discount unsaveable.
        unitPrice: unitPrice.nullable().optional(),
      })
  ),
  merchant: merchantSchema.extend({ name: z.string().min(1) }),
  payment: paymentSchema,
  receiptId: z.uuid({ message: "Invalid receipt ID" }),
  totals: totalsSchema.extend({
    gst: money.optional(),
    subtotal: money.optional(),
    total: money,
  }),
  transaction: transactionSchema,
  /**
   * The zone the receipt was added from, correctable here because the upload
   * only knows where the photo was taken (#200). Validated as a real zone: the
   * picker offers nothing else, and an unrecognised name would make the caption
   * claim something the app cannot render.
   */
  transactionTimezone: z
    .string()
    .refine(isTimezone, { message: "Unknown timezone" })
    .optional(),
});

export type UpdateReceiptInput = z.infer<typeof updateReceiptSchema>;
