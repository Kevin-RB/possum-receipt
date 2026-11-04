"use server";

import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { listAvailableModels } from "@/lib/ai/models";
import { ORC_MODEL, PARSE_MODEL } from "@/lib/ai/provider";
import { getSession } from "@/lib/auth/dal";
import { db, receipts } from "@/lib/db";
import { reportError, USER_ERROR } from "@/lib/errors";
import { inngest } from "@/lib/inngest/client";
import { receiptReprocessEvent } from "@/lib/inngest/events";
import { BUCKET, deleteObject } from "@/lib/storage/client";

import { reprocessReceiptSchema } from "./schema";

export const deleteReceipt = async (receiptId: string) => {
  const session = await getSession();

  if (!session) {
    return { error: USER_ERROR.unauthorized, success: false as const };
  }

  const existing = await db.query.receipts.findFirst({
    where: { id: receiptId, userId: session.user.id },
  });

  if (!existing) {
    return { error: USER_ERROR.notFound, success: false as const };
  }

  try {
    if (existing.objectKey) {
      await deleteObject({ bucket: BUCKET, key: existing.objectKey });
    }

    await db.delete(receipts).where(eq(receipts.id, receiptId));
  } catch (error) {
    reportError("receipts.delete", error);
    return { error: USER_ERROR.deleteFailed, success: false as const };
  }

  revalidatePath("/");

  return { success: true as const };
};

/**
 * The models the re-process picker offers: exactly what the provider reports,
 * since a model it has not loaded would only fail at request time.
 *
 * An empty list means the provider could not be asked, and the dialog says so
 * rather than filling the select with models the trigger would refuse — the
 * action rejects the run outright in that case, because nothing can run without
 * the provider.
 *
 * Server actions are HTTP endpoints, so this one is as reachable as any other
 * without a session. It answers with the ids the model server has loaded and the
 * models this app is configured to use, which is not an anonymous answer, so an
 * unauthenticated caller gets an empty list rather than either.
 */
export const listExtractionModels = async () => {
  const session = await getSession();

  if (!session) {
    return { available: [], defaults: { ocr: "", parse: "" } };
  }

  return {
    available: await listAvailableModels(),
    defaults: { ocr: ORC_MODEL, parse: PARSE_MODEL },
  };
};

/**
 * How long a claim is honoured before another attempt may take it over.
 *
 * A claim is the only thing standing between a receipt and being re-processed,
 * and nothing guarantees the run that owes it will ever appear: the event can be
 * accepted by Inngest when no function matches it, or the process holding the
 * run can die before its failure handler fires. Either way the row sits in
 * `pending` or `processing` with nothing behind it, and no other path in the app
 * moves it — so the claim has to expire, or the receipt is a dead end.
 *
 * Generous on purpose. A local extraction runs for six to ten minutes, and
 * taking a claim that is genuinely still running produces two runs against one
 * receipt; waiting longer costs the owner a cooldown, taking it too early costs
 * them their data.
 */
const PROCESSING_LEASE_MS = 30 * 60 * 1000;

/**
 * Runs extraction again over a stored receipt.
 *
 * The claim is a single conditional update whose result is what proves this
 * request was the one that moved the receipt, so two rapid clicks cannot start
 * two runs. It accepts a finished receipt as well as one whose claim has
 * expired, which is the way back in for a receipt whose run never arrived.
 *
 * If the run cannot be enqueued the claim is handed back, because a receipt
 * left claimed with nothing running is indistinguishable from one that is
 * genuinely mid-run.
 */
export const reprocessReceipt = async (input: unknown) => {
  const session = await getSession();

  if (!session) {
    return { error: USER_ERROR.unauthorized, success: false as const };
  }

  const parsed = reprocessReceiptSchema.safeParse(input);

  if (!parsed.success) {
    return { error: USER_ERROR.invalidInput, success: false as const };
  }

  const { models, receiptId } = parsed.data;

  const receipt = await db.query.receipts.findFirst({
    where: { id: receiptId, userId: session.user.id },
  });

  if (!receipt) {
    return { error: USER_ERROR.notFound, success: false as const };
  }

  if (receipt.status === "uploading") {
    return {
      error: USER_ERROR.reprocessNotReady,
      success: false as const,
    };
  }

  if (!receipt.objectKey) {
    return {
      error: USER_ERROR.reprocessNoImage,
      success: false as const,
    };
  }

  // Checked against what the provider actually has loaded rather than trusted
  // from the picker: a run cannot get anywhere without LM Studio, so asking now
  // turns an opaque provider error into a message naming the real problem. An
  // empty list means the question could not be asked at all, which is a
  // different fault from the model not being loaded and must not read as one.
  const reported = await listAvailableModels();

  if (reported.length === 0) {
    return {
      error: USER_ERROR.modelServerUnreachable,
      success: false as const,
    };
  }

  const available = new Set(reported);

  if (!available.has(models.ocr) || !available.has(models.parse)) {
    return { error: USER_ERROR.modelNotAvailable, success: false as const };
  }

  const leaseExpiredBefore = new Date(Date.now() - PROCESSING_LEASE_MS);

  const claimed = await db
    .update(receipts)
    .set({ processingStartedAt: new Date(), status: "processing" })
    .where(
      and(
        eq(receipts.id, receiptId),
        or(
          // Finished, so nothing is in flight and the claim is free.
          inArray(receipts.status, ["done", "error"]),
          // Mid-run, but by an attempt that is no longer plausible. A null
          // stamp is a receipt claimed before this column existed, which is
          // exactly a receipt whose run is long gone.
          //
          // `pending` is deliberately not claimable. It is recoverable without
          // this — a receipt waiting for a slot has never been extracted, so
          // deleting and re-uploading loses nothing — and taking it over would
          // race a live `receipt/uploaded` run whose guard expects it to still
          // be `pending`. `processing` is the one with data at stake.
          and(
            eq(receipts.status, "processing"),
            or(
              isNull(receipts.processingStartedAt),
              lt(receipts.processingStartedAt, leaseExpiredBefore)
            )
          )
        )
      )
    )
    .returning({ id: receipts.id });

  if (claimed.length === 0) {
    return {
      error: USER_ERROR.reprocessInFlight,
      success: false as const,
    };
  }

  try {
    await inngest.send([
      receiptReprocessEvent.create(
        {
          models,
          // Restored by the function's failure handler, so a run that fails
          // leaves the receipt as findable as it was before. A receipt taken
          // over from an expired claim has no usable prior status — the run
          // that abandoned it is the thing that would have known — so it falls
          // back to `error`, which is itself re-processable rather than a row
          // that returns to being claimed.
          previousStatus:
            receipt.status === "done" || receipt.status === "error"
              ? receipt.status
              : "error",
          receiptId,
          userId: session.user.id,
        },
        { id: crypto.randomUUID() }
      ),
    ]);
  } catch (error) {
    reportError("receipts.reprocess", error);

    // Puts back both halves of the claim. The stamp matters as much as the
    // status: a takeover wrote a fresh one, and leaving it behind re-locks the
    // receipt for another full lease — after the owner had already waited one
    // out to get here. Guarded on the claim this request made, so a rollback
    // can never undo a status something else moved the receipt to meanwhile.
    await db
      .update(receipts)
      .set({
        processingStartedAt: receipt.processingStartedAt ?? null,
        status: receipt.status,
      })
      .where(
        and(eq(receipts.id, receiptId), eq(receipts.status, "processing"))
      );

    return { error: USER_ERROR.reprocessFailed, success: false as const };
  }

  revalidatePath("/receipts");

  return { success: true as const };
};
