import { APICallError, NoObjectGeneratedError } from "ai";
import { and, eq } from "drizzle-orm";
import { NonRetriableError } from "inngest";

import { extractReceipt } from "@/lib/ai/extract-receipt";
import {
  isRetryableProviderFailure,
  openRouterConfigured,
} from "@/lib/ai/provider";
import { db, findReceiptByIdForOwner, receiptItems, receipts } from "@/lib/db";
import { receiptToFlat } from "@/lib/db/receipt-mapping";
import type { ProcessingStatus } from "@/lib/db/schema/receipt";
import { USER_ERROR } from "@/lib/errors";
import { receiptsChannel } from "@/lib/inngest/channels";
import { inngest } from "@/lib/inngest/client";
import {
  receiptExtractedEvent,
  receiptReprocessEvent,
  receiptUploadedEvent,
} from "@/lib/inngest/events";
import { normalizeExtractedItems } from "@/lib/receipt/extraction";
import { reconcile } from "@/lib/receipt/integrity";
import { BUCKET, downloadObject } from "@/lib/storage/client";
import { contentTypeFromKey } from "@/lib/storage/content-type";

/**
 * Sets a receipt's status, scoped to its owner.
 *
 * The owner is part of the write rather than something the caller is trusted to
 * have checked, so no call site in this function can move a receipt that belongs
 * to someone else — the failure path included, which is where an unscoped write
 * was reachable from an event naming another user's receipt.
 */
const setReceiptStatus = (
  id: string,
  status: ProcessingStatus,
  ownerId: string
) =>
  db
    .update(receipts)
    .set({
      status,
      // Stamped with the claim, not with the status: a receipt in `processing`
      // with nothing behind it is what the lease is there to recover, and this
      // is the moment the run commits to being behind it.
      ...(status === "processing" ? { processingStartedAt: new Date() } : {}),
    })
    .where(and(eq(receipts.id, id), eq(receipts.userId, ownerId)));

const formatFailureMessage = (error: Error): string => {
  if (NoObjectGeneratedError.isInstance(error)) {
    return `Model did not return valid structured output: ${error.message}`;
  }
  if (APICallError.isInstance(error)) {
    return `AI provider error: ${error.message}`;
  }
  return error.message;
};

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/**
 * The status a failed run writes, or `null` when it must write nothing.
 *
 * Two cases write nothing, and both are load-bearing:
 *
 * - The receipt is not there for the event's user. The event names a row, and
 *   the sender may not own it, so a failed run has nothing to report about it.
 *   Writing anyway would let a forged event flip the status of any receipt by
 *   id — hiding it from the editor and from every spend query.
 * - The receipt is already `done`, because `storing` writes `done` as its last
 *   act. Restoring the pre-run status over it would report a failure against
 *   data that is there and correct.
 *
 * Otherwise a re-process restores the status it started from: the stored
 * extraction is only replaced in the final `storing` step, so an earlier
 * failure leaves it fully intact and the receipt should keep saying so. A first
 * extraction has nothing to fall back to and is `error`.
 */
export const statusAfterFailedRun = (
  // `undefined` as well as `null`: the lookup returns the former when there is
  // no such row for the user, and both mean the same thing here.
  current: { status: ProcessingStatus } | null | undefined,
  previousStatus?: ProcessingStatus
): ProcessingStatus | null => {
  if (!current || current.status === "done") {
    return null;
  }

  return previousStatus ?? "error";
};

export const transcribeReceipt = inngest.createFunction(
  {
    concurrency: [
      // Two at a time per owner, two per account. Sized to what one person can
      // usefully upload at once, now that a call is seconds rather than a GPU
      // job: the cap exists to keep a burst from becoming a provider
      // rate-limit cascade, not to share one machine's engine (ADR-0022).
      {
        key: "event.data.userId",
        limit: 2,
      },
      {
        key: "transcribe",
        limit: 2,
        scope: "account",
      },
    ],
    id: "transcribe-receipt",
    onFailure: async ({ event, step }) => {
      const trigger = event.data.event;
      const { receiptId, userId } = trigger.data;
      const ch = receiptsChannel(userId);
      const errorMessage = event.data.error?.message;
      const previousStatus =
        trigger.name === receiptReprocessEvent.name
          ? trigger.data.previousStatus
          : undefined;

      await step.run("mark-error", async () => {
        const current = await findReceiptByIdForOwner(receiptId, userId);
        const status = statusAfterFailedRun(current, previousStatus);

        if (status) {
          await setReceiptStatus(receiptId, status, userId);
        }
      });

      await step.realtime.publish(`state-${receiptId}-failed`, ch.state, {
        error: errorMessage,
        receiptId,
        state: "failed",
      });
    },
    triggers: [receiptUploadedEvent, receiptReprocessEvent],
  },
  async ({ event, step }) => {
    const { receiptId, userId } = event.data;

    const reprocessing = event.name === receiptReprocessEvent.name;
    const model = reprocessing ? event.data.model : undefined;

    // A re-process arrives already claimed: the server action moved the row to
    // `processing` before sending the event, and that claim is what stops two
    // requests from starting two runs against one receipt.
    const expectedStatus: ProcessingStatus = reprocessing
      ? "processing"
      : "pending";

    const ch = receiptsChannel(userId);

    // Nothing can run without the credential, and a missing key is a
    // deployment fault rather than a transient one — retrying cannot fix it, so
    // the receipt is failed immediately with wording the owner can act on.
    if (!openRouterConfigured()) {
      throw new NonRetriableError(USER_ERROR.extractionUnavailable);
    }

    const receipt = await step.run("lookup-receipt", async () => {
      // Scoped to the user on the event, not just the receipt id. The event is a
      // message anyone holding the event key can send, and this run deletes every
      // line item and overwrites the stored extraction — so a receipt named by
      // someone else's id must not be touched, whoever claims to own it.
      const found = await findReceiptByIdForOwner(receiptId, userId);
      if (!found) {
        throw new NonRetriableError(`Receipt ${receiptId} not found`);
      }
      if (found.status !== expectedStatus) {
        throw new NonRetriableError(
          `Receipt ${receiptId} is ${found.status}, expected ${expectedStatus}`
        );
      }
      return found;
    });

    const key = receipt.objectKey;
    if (!key) {
      throw new NonRetriableError(`Receipt ${receiptId} has no objectKey`);
    }

    await step.run("mark-processing", async () => {
      await setReceiptStatus(receiptId, "processing", userId);
    });

    await step.realtime.publish("publish-extracting", ch.state, {
      receiptId,
      state: "extracting",
    });

    // One call now reads the image and writes the receipt, so there is no pass
    // between reading and structuring that could fail on its own and nothing is
    // written before the store (ADR-0022).
    const attempt = await step.run("extracting", async () => {
      const body = await downloadObject({
        bucket: BUCKET,
        key,
      });
      if (!body) {
        throw new NonRetriableError(`Empty body for object ${key}`);
      }
      const base64 = await body.transformToString("base64");

      try {
        return await extractReceipt({
          base64,
          mediaType: contentTypeFromKey(key),
          model,
        });
      } catch (error) {
        // Classified here, where the step's error is thrown, because this is the
        // error Inngest decides on: a rate limit or a 5xx leaves as itself so
        // the step is retried, and only a failure that cannot succeed on another
        // attempt becomes permanent. The raw failure arrives wrapped in the
        // SDK's `RetryError` — see `isRetryableProviderFailure`.
        if (isRetryableProviderFailure(error)) {
          throw error;
        }

        throw new NonRetriableError(formatFailureMessage(asError(error)));
      }
    });

    if (!attempt.ok) {
      const { rawText, reason } = attempt;

      // A response that does not satisfy the schema still leaves what the model
      // read, which is the only record of it now that reading and structuring
      // are one call (ADR-0008). A first extraction has nothing else on the row
      // to contradict; a re-process does — the row holds an extraction and the
      // transcript that describes it — so a failed re-process writes neither
      // (ADR-0011).
      if (!reprocessing && rawText) {
        await step.run("store-failed-transcript", async () => {
          await db
            .update(receipts)
            .set({ transcript: rawText })
            .where(eq(receipts.id, receiptId));
        });
      }

      throw new NonRetriableError(
        `Model did not return valid structured output: ${reason}`
      );
    }

    const { extraction, transcript } = attempt;

    const items = normalizeExtractedItems(extraction.items);

    const integrityWarning = !reconcile(items, {
      total: extraction.totals.total,
    }).matches;

    await step.realtime.publish("publish-storing", ch.state, {
      receiptId,
      state: "storing",
    });

    await step.run("storing", async () => {
      await db.transaction(async (tx) => {
        await tx
          .update(receipts)
          .set({
            ...receiptToFlat(extraction),
            // The new items carry no categories, so the previous stamp now
            // describes a set of rows that no longer exists.
            categorizedAt: null,
            hasIntegrityWarning: integrityWarning,
            status: "done" as const,
            // Written with the extraction rather than before it, so the
            // transcript on the row always belongs to the data on the row.
            transcript,
          })
          .where(eq(receipts.id, receiptId));

        // Unconditional: a re-process replaces the stored line items, and a
        // first extraction has none to delete. A delete-then-insert rather than
        // an insert alone is what keeps a re-run from doubling every line.
        await tx
          .delete(receiptItems)
          .where(eq(receiptItems.receiptId, receiptId));

        if (items.length > 0) {
          await tx
            .insert(receiptItems)
            .values(items.map((item) => ({ ...item, receiptId })));
        }
      });
    });

    await step.realtime.publish("publish-done", ch.state, {
      receiptId,
      state: "done",
    });

    await step.sendEvent(
      "emit-extracted",
      receiptExtractedEvent.create({ receiptId, userId })
    );

    return {
      extraction: { ...extraction, items },
      integrityWarning,
      receiptId,
    };
  }
);
