import { setTimeout as sleep } from "node:timers/promises";

import { and, eq } from "drizzle-orm";

import { db, listStaleUploadSignalReceipts, receipts } from "@/lib/db";
import type { ProcessingStatus } from "@/lib/db";
import { reportError } from "@/lib/errors";
import { inngest } from "@/lib/inngest/client";
import { BUCKET, objectExists } from "@/lib/storage/client";
import { UPLOAD_SETTLE_SECONDS } from "@/lib/storage/constants";

/**
 * Everything the upload signal needs to know about a receipt. The object key is
 * server-owned: it is read from the row, never from the caller (ADR-0021), so
 * no client-supplied key can point the verification at a different object.
 */
export interface UploadCandidate {
  id: string;
  objectKey: string | null;
  userId: string;
}

export type UploadVerification = "promoted" | "absent";

/**
 * A row the page-load reconciliation may act on: still `uploading` (its browser
 * call never settled the row) or already `pending` (promoted, but its run may
 * never have been enqueued).
 */
interface StaleUploadSignalReceipt extends UploadCandidate {
  status: ProcessingStatus;
}

// Three HEADs inside one request. R2 is read-after-write consistent, so a first
// check straight after a successful PUT is already decisive; the other two are
// for a browser that reports a fraction early, not for a slow store. The delay
// keeps the whole retry inside ~200ms, which no reader will notice.
export const UPLOAD_VERIFY_ATTEMPTS = 3;
const VERIFY_RETRY_MS = 100;

/**
 * Enqueue extraction for a receipt. The event id is deterministic, so a repeat
 * send — a replay, a redelivery, a repeat call after a committed promotion whose
 * enqueue failed — is deduped by Inngest instead of starting a second run.
 */
export const sendReceiptUploaded = async ({
  id,
  userId,
}: UploadCandidate): Promise<void> => {
  await inngest.send({
    data: { receiptId: id, userId },
    id: `receipt-uploaded-${id}`,
    name: "receipt/uploaded",
  });
};

/**
 * Move an `uploading` row to `pending`.
 *
 * Conditional on the row still being `uploading`, so a concurrent promotion (the
 * browser's call racing the page-load reconciliation) is a no-op rather than an
 * overwrite of a receipt that a run has already claimed.
 */
const markPending = async (receiptId: string): Promise<void> => {
  await db
    .update(receipts)
    .set({ status: "pending" })
    .where(and(eq(receipts.id, receiptId), eq(receipts.status, "uploading")));
};

/**
 * Move an `uploading` row to `error`: its presigned window closed and the object
 * is not in the bucket, so the upload never happened. Conditional for the same
 * reason as `markPending` — a row a run has picked up in the meantime is not
 * this decision's to change.
 */
const markUploadFailed = async (receiptId: string): Promise<void> => {
  await db
    .update(receipts)
    .set({ status: "error" })
    .where(and(eq(receipts.id, receiptId), eq(receipts.status, "uploading")));
};

/**
 * Promote and enqueue, with no verification — for a caller the storage layer
 * itself vouched for (the RustFS webhook, which only fires once an object
 * exists).
 */
export const promoteUpload = async (
  receipt: UploadCandidate
): Promise<void> => {
  await markPending(receipt.id);
  await sendReceiptUploaded(receipt);
};

/**
 * Whether the receipt's object is in the bucket.
 *
 * - `present` on a successful HEAD.
 * - `absent` when the store answered "not found" on every attempt.
 * - throws when a HEAD could not be answered at all (credentials, network),
 *   which is a fault to report rather than evidence about the object.
 */
export const verifyUploadObject = async (
  objectKey: string,
  attempts = 1
): Promise<"present" | "absent"> => {
  if (await objectExists({ bucket: BUCKET, key: objectKey })) {
    return "present";
  }

  if (attempts <= 1) {
    return "absent";
  }

  await sleep(VERIFY_RETRY_MS);
  return verifyUploadObject(objectKey, attempts - 1);
};

/**
 * Verify the object exists, then promote and enqueue.
 *
 * This is the trusted half of the upload signal: `pending` means an object is
 * really in the bucket because a HEAD said so, not because a client said so
 * (ADR-0021). `absent` leaves the row untouched — the caller decides whether
 * that is a retryable failure (the browser's call) or a dead upload (the
 * page-load reconciliation).
 */
export const promoteVerifiedUpload = async (
  receipt: UploadCandidate,
  attempts = 1
): Promise<UploadVerification> => {
  if (!receipt.objectKey) {
    return "absent";
  }

  if ((await verifyUploadObject(receipt.objectKey, attempts)) === "absent") {
    return "absent";
  }

  await promoteUpload(receipt);
  return "promoted";
};

/**
 * Settle this owner's stale upload signals: rows older than
 * `UPLOAD_SETTLE_SECONDS` that are still `uploading` or already `pending`
 * (ADR-0021). The threshold is the presign window plus a grace, because the
 * window bounds when a `PUT` may start, not how long it may run.
 *
 * - `uploading`: a `HeadObject` decides. Present → promoted and extraction
 *   starts, so a browser tab that died between the PUT and its call costs the
 *   reader nothing. Absent → `error`, an upload that never happened.
 * - `pending`: the promotion committed but its enqueue did not (the caller gave
 *   up, or the send failed), so nothing would ever send again — there is no
 *   browser left to repeat the call. Re-sending with the same deterministic id
 *   starts the missing run, and Inngest dedupes a row whose run is merely queued.
 *   No HEAD and no status change: a `pending` row is not in doubt.
 *
 * A row whose HEAD or send fails is logged and left for the next visit; a
 * misconfigured token must not turn into a receipt that never extracts, and one
 * bad row must not stop the rest.
 *
 * Run one row at a time: a page visit normally has none, and the pass is not
 * worth a burst of HEADs against the bucket.
 */
const settleStaleSignal = async ({
  status,
  ...receipt
}: StaleUploadSignalReceipt): Promise<void> => {
  try {
    if (status === "pending") {
      await sendReceiptUploaded(receipt);
      return;
    }

    const verification = await promoteVerifiedUpload(receipt);

    if (verification === "absent") {
      await markUploadFailed(receipt.id);
    }
  } catch (error) {
    reportError("receipts.reconcile-uploads", error);
  }
};

export const reconcileStaleUploads = async (
  ownerId: string,
  now: Date = new Date()
): Promise<void> => {
  const before = new Date(now.getTime() - UPLOAD_SETTLE_SECONDS * 1000);

  for (const receipt of await listStaleUploadSignalReceipts(ownerId, before)) {
    // Sequential on purpose: a page visit normally has no stale rows, so the
    // pass is not worth a burst of HEADs against the bucket.
    // eslint-disable-next-line no-await-in-loop -- one row at a time
    await settleStaleSignal(receipt);
  }
};
