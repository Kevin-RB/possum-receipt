import { eventType } from "inngest";
import { z } from "zod/v4";

import { extractionModelIdSchema } from "@/lib/ai/models";

/**
 * The events the pipeline is built from, kept apart from the functions that
 * consume them.
 *
 * A producer needs an event and nothing else: the server action that starts a
 * re-process and the script that queues a categorization backfill must not pull
 * in a function module — and with it the whole step graph — just to name an
 * event. Both directions point at this file instead.
 */

export const receiptUploadedEvent = eventType("receipt/uploaded", {
  schema: z.object({ receiptId: z.string(), userId: z.string() }),
});

/**
 * A second run of extraction over a receipt that is already stored.
 *
 * The model travels with the event rather than being read from the environment
 * at run time, so a re-process can use a stronger model than a first extraction
 * without a redeploy. `previousStatus` is what the run restores if it fails: the
 * stored extraction is only replaced in the final write, so a failure leaves
 * that data intact and the receipt must not start claiming otherwise.
 */
export const receiptReprocessEvent = eventType("receipt/reprocess", {
  schema: z.object({
    model: extractionModelIdSchema,
    previousStatus: z.enum(["done", "error"]),
    receiptId: z.string(),
    userId: z.string(),
  }),
});

export const receiptExtractedEvent = eventType("receipt/extracted", {
  schema: z.object({ receiptId: z.string(), userId: z.string() }),
});
