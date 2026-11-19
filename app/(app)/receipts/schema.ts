import { z } from "zod";

import { extractionModelIdSchema } from "@/lib/ai/models";

export const reprocessReceiptSchema = z.object({
  model: extractionModelIdSchema,
  receiptId: z.uuid({ message: "Invalid receipt ID" }),
});

export type ReprocessReceiptInput = z.infer<typeof reprocessReceiptSchema>;
