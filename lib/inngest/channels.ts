import { channel } from "inngest/realtime";
import { z } from "zod";

export const receiptStateSchema = z.object({
  error: z.string().optional(),
  receiptId: z.string(),
  state: z.enum(["extracting", "storing", "done", "failed"]),
});

export type ReceiptStateData = z.infer<typeof receiptStateSchema>;
export type ReceiptState = ReceiptStateData["state"];

/**
 * One channel per owner, with the receipt carried in the payload. See
 * ADR-0012.
 *
 * The receipts table and the upload toast both watch many receipts at once, and
 * a list view is exactly the "fan-out from each function" shape: every run
 * publishes to the owner's channel and the client routes each message to its
 * row by `receiptId`. A channel per receipt instead opened one subscription —
 * and minted one token, and held one connection — per live row, so a table of N
 * queued receipts paid N times over to watch at most a couple of runs. Worse,
 * `useRealtime` treats a failed token mint as retryable, so one broken token
 * endpoint became a request every few seconds *per row*; a single channel makes
 * the same failure a single request.
 */
export const receiptsChannel = channel({
  name: (userId: string) => `user:${userId}`,
  topics: {
    state: {
      schema: receiptStateSchema,
    },
  },
});
