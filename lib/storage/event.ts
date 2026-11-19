import { z } from "zod/v4";

/**
 * The app's own storage event: an object finished uploading, named by its
 * object key.
 *
 * This is the only thing the storage-event webhook acts on. A provider's bucket
 * notification reaches it through that provider's adapter and nothing else, so
 * no provider field is read outside an adapter. RustFS is the one provider that
 * calls back (local development); production R2 never posts a payload to the
 * app, so its browser call names a receipt id instead and is verified with
 * `HeadObject` (ADR-0021).
 */
export interface StorageEvent {
  objectKey: string;
}

// RustFS percent-encodes the object key in the notification payload (slashes
// become `%2F`), so decode it before it is used to look a receipt up. Fall back
// to the raw value if it is not valid percent-encoding rather than throwing.
const decodeObjectKey = (key: string): string => {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
};

// RustFS bucket-notification envelope. It follows the S3 event shape but the
// detail nodes differ from MinIO's (RustFS puts the request header map in
// `requestParameters` and omits MinIO's `x-minio-*` response elements), so we
// validate only the fields this consumer reads: the event name and object key
// of the first record. Everything else is intentionally unvalidated.
const rustfsAdapter = z
  .looseObject({
    Records: z
      .array(
        z.looseObject({
          eventName: z.string(),
          s3: z.looseObject({
            object: z.looseObject({
              key: z.string().transform(decodeObjectKey),
            }),
          }),
        })
      )
      .min(1),
  })
  .transform((body): StorageEvent | null => {
    const [record] = body.Records;
    // Only object-created events are an upload. A removal notification is a
    // bucket notification the app has no use for.
    return record.eventName.startsWith("s3:ObjectCreated:")
      ? { objectKey: record.s3.object.key }
      : null;
  });

/**
 * A provider's bucket notification, turned into the app's storage event.
 *
 * The shape is the provider's own envelope rather than an app-owned format that
 * every provider is translated into: only RustFS calls back, and a second
 * adapter would be written when a provider that calls back is added. A payload
 * in another shape is a parse failure, which the route logs and rejects.
 *
 * `null` means a bucket notification that is not an upload: a removal, or any
 * event that does not create an object. A RustFS copy is an
 * `s3:ObjectCreated:*` event, so it counts, following the bucket rule
 * (`--event put`).
 */
export const storageEventSchema: z.ZodType<StorageEvent | null> = rustfsAdapter;
