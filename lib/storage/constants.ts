export const ACCEPTED_MIME_TYPES = ["image/jpeg", "image/png"] as const;

export type AcceptedMimeType = (typeof ACCEPTED_MIME_TYPES)[number];

/**
 * How long a presigned upload URL stays valid, and therefore how long a row may
 * legitimately sit at `uploading` before it is certainly not mid-upload any
 * more. See `UPLOAD_SETTLE_SECONDS` for the longer wait reconciliation uses.
 */
export const PRESIGNED_URL_EXPIRY_SECONDS = 60 * 5;

/**
 * How old an unsettled row must be before `/receipts` reconciles it: the
 * presign window plus ten minutes.
 *
 * The presign window bounds when a `PUT` may be *started*, not how long it may
 * run, so a large photo on a slow connection started just inside the window can
 * finish after the window has closed. Checking at exactly
 * `PRESIGNED_URL_EXPIRY_SECONDS` would then find no object, mark the row
 * `error`, and a moment later the browser's confirmation would answer 409 for an
 * upload that in fact arrived. The grace is the expected upload duration, and it
 * is deliberately generous: the cost of waiting is a row that settles on a later
 * visit, while the cost of not waiting is a receipt the reader has to upload
 * again.
 */
export const UPLOAD_SETTLE_SECONDS = PRESIGNED_URL_EXPIRY_SECONDS + 10 * 60;
