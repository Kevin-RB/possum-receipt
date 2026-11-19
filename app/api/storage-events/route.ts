import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod/v4";

import { auth } from "@/lib/auth";
import { findReceiptByIdForOwner, findReceiptByObjectKey } from "@/lib/db";
import { reportError, USER_ERROR } from "@/lib/errors";
import { storageEventSchema } from "@/lib/storage/event";
import {
  promoteUpload,
  promoteVerifiedUpload,
  sendReceiptUploaded,
  UPLOAD_VERIFY_ATTEMPTS,
} from "@/lib/storage/upload-signal";

const BODY_PREVIEW_LENGTH = 200;

/**
 * Whether a RustFS bucket notification may act.
 *
 * Fails **closed**: with no secret configured there is no way to tell the
 * storage layer from anyone who can reach the route, so nothing is trusted.
 * (The route used to accept every RustFS-shaped body when the variable was
 * unset, which made the check optional in exactly the environment that needed
 * it.) Constant-time so a rejected guess costs the same as any other.
 */
const isAuthorizedNotification = (authorization: string): boolean => {
  const secret = process.env.STORAGE_WEBHOOK_SECRET;

  if (!secret) {
    return false;
  }

  const received = Buffer.from(authorization);
  const expected = Buffer.from(`Bearer ${secret}`);

  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
};

/**
 * The storage layer's own notification: an object has landed, named by its
 * object key. Only RustFS calls this (local development) — production R2 has no
 * webhook, so its browser call takes the other path.
 */
const handleStorageNotification = async (
  request: Request,
  authorization: string
) => {
  if (!isAuthorizedNotification(authorization)) {
    console.warn("storage-events: rejected — unauthorized");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    console.warn("storage-events: rejected — invalid JSON body");
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const parsed = storageEventSchema.safeParse(body);

  if (!parsed.success) {
    console.error(
      "storage-events: parse failed — %s | body: %s",
      JSON.stringify(parsed.error.issues),
      JSON.stringify(body).slice(0, BODY_PREVIEW_LENGTH)
    );
    return NextResponse.json(
      { error: "Invalid event format" },
      { status: 400 }
    );
  }

  const { data: event } = parsed;

  if (!event) {
    console.warn(
      "storage-events: not an upload — ignored | body: %s",
      JSON.stringify(body).slice(0, BODY_PREVIEW_LENGTH)
    );
    return NextResponse.json({ received: true });
  }

  const { objectKey } = event;

  if (!objectKey) {
    console.warn("storage-events: event has an empty object key — ignored");
    return NextResponse.json({ received: true });
  }

  const receipt = await findReceiptByObjectKey(objectKey);

  if (!receipt) {
    console.warn("storage-events: no receipt for key %s — ignored", objectKey);
    return NextResponse.json({ received: true });
  }

  // Redelivery is expected: RustFS redelivers until it gets a 2xx, and a
  // previous attempt may have promoted the row but failed to enqueue.
  // `uploading` (first delivery) and `pending` (retry before the workflow
  // starts) are actionable; anything further along (processing/done/error) is
  // ignored.
  const promoted = receipt.status === "uploading";

  if (!(promoted || receipt.status === "pending")) {
    console.warn(
      "storage-events: receipt %s is %s — ignored",
      receipt.id,
      receipt.status
    );
    return NextResponse.json({ received: true });
  }

  try {
    // The storage layer is the one caller that has already vouched for the
    // object, so a promotion needs no HEAD of its own; a repeat only re-sends.
    await (promoted ? promoteUpload(receipt) : sendReceiptUploaded(receipt));
  } catch (error) {
    // A non-2xx makes RustFS redeliver; the retry takes the `pending` path above
    // and re-sends rather than silently losing the extraction.
    console.error(
      "storage-events: inngest.send failed for receipt %s — will retry",
      receipt.id,
      error
    );
    return NextResponse.json(
      { error: "Failed to enqueue extraction" },
      { status: 500 }
    );
  }

  console.log(
    "storage-events: receipt %s %s",
    receipt.id,
    promoted ? "promoted uploading → pending" : "re-enqueued"
  );

  return NextResponse.json({ received: true });
};

const UploadSignalRequest = z.object({
  receiptId: z.uuid({ message: "Invalid receipt id" }),
});

/**
 * The browser's report, after its presigned PUT succeeds: it names the receipt,
 * never an object key. The server loads the receipt for the caller, verifies the
 * object with `HeadObject`, and only then promotes and enqueues — so `pending`
 * stays a fact about the bucket rather than a claim by a client (ADR-0021).
 */
const handleUploadSignal = async (request: Request) => {
  const session = await auth.api.getSession({ headers: request.headers });

  if (!session) {
    return NextResponse.json(
      { error: USER_ERROR.unauthorized },
      { status: 401 }
    );
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: USER_ERROR.invalidInput },
      { status: 400 }
    );
  }

  const parsed = UploadSignalRequest.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: USER_ERROR.invalidInput },
      { status: 400 }
    );
  }

  // Owner-scoped: a caller can name a receipt but not someone else's, and the
  // key handed to `HeadObject` is the one stored on the row.
  const receipt = await findReceiptByIdForOwner(
    parsed.data.receiptId,
    session.user.id
  );

  if (!receipt) {
    return NextResponse.json({ error: USER_ERROR.notFound }, { status: 404 });
  }

  if (receipt.status === "pending") {
    // Promotion already committed; re-sending with the same deterministic id
    // completes a call whose enqueue failed, and Inngest dedupes it.
    try {
      await sendReceiptUploaded(receipt);
    } catch (error) {
      reportError("storage-events.upload-signal", error);
      return NextResponse.json({ error: USER_ERROR.generic }, { status: 500 });
    }

    return NextResponse.json({ received: true });
  }

  // processing/done/error: the receipt is past the upload, so a repeat call is
  // a no-op rather than a second extraction.
  if (receipt.status !== "uploading") {
    return NextResponse.json({ received: true });
  }

  try {
    const verification = await promoteVerifiedUpload(
      receipt,
      UPLOAD_VERIFY_ATTEMPTS
    );

    if (verification === "absent") {
      console.warn(
        "storage-events: no object for receipt %s — left uploading",
        receipt.id
      );
      return NextResponse.json(
        { error: USER_ERROR.uploadFailed },
        { status: 409 }
      );
    }
  } catch (error) {
    // A HEAD that could not be answered, or a failed enqueue: report it and let
    // the caller try again. The row is unchanged (HEAD failure) or already
    // `pending` (enqueue failure), and a repeat call settles either.
    reportError("storage-events.upload-signal", error);
    return NextResponse.json({ error: USER_ERROR.generic }, { status: 500 });
  }

  console.log(
    "storage-events: receipt %s verified and promoted uploading → pending",
    receipt.id
  );

  return NextResponse.json({ received: true });
};

export const POST = (request: Request) => {
  const authorization = request.headers.get("authorization");

  // The credentials decide the path, and neither can reach the other's: a
  // Bearer token is the storage layer, a session cookie is the browser. A
  // request presenting neither is refused by the browser path.
  return authorization
    ? handleStorageNotification(request, authorization)
    : handleUploadSignal(request);
};
