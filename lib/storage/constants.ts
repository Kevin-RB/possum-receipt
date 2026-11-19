export const ACCEPTED_MIME_TYPES = ["image/jpeg", "image/png"] as const;

export type AcceptedMimeType = (typeof ACCEPTED_MIME_TYPES)[number];

/**
 * How long a presigned upload URL stays valid, and therefore how long a row may
 * legitimately sit at `uploading` before it is certainly not mid-upload any
 * more. The `/receipts` reconciliation waits this long before it checks a stale
 * row with `HeadObject` (ADR-0021); checking earlier would manufacture a false
 * `error` for an upload that is simply still in flight.
 */
export const PRESIGNED_URL_EXPIRY_SECONDS = 60 * 5;
