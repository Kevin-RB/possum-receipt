import { z } from "zod/v4";

/**
 * The app's own storage event: an object finished uploading, named by its
 * object key.
 *
 * This is the only thing the storage-event webhook acts on. A provider's bucket
 * notification reaches it through that provider's adapter and nothing else, so
 * no provider field is read outside an adapter.
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

// R2 delivers bucket notifications to a Queue, and the Worker (#252) forwards
// each message body unchanged, so this is R2's message shape as documented. The
// object key is used as is: R2 sends it unencoded, unlike RustFS, so decoding it
// would corrupt a key that contains `%`.
// Only `action` and `object.key` are required: delete messages carry no `size`
// or `eTag`, and requiring either would reject them as a parse failure instead
// of ignoring them as something that is not an upload. `CopyObject` is not an
// upload even though it creates an object: the app never copies one.
const r2Adapter = z
  .looseObject({
    action: z.string(),
    object: z.looseObject({ key: z.string() }),
  })
  .transform((body): StorageEvent | null =>
    body.action === "PutObject" || body.action === "CompleteMultipartUpload"
      ? { objectKey: body.object.key }
      : null
  );

/**
 * A provider's bucket notification, turned into the app's storage event.
 *
 * The adapter is picked by the payload's shape, not by an environment setting:
 * a setting that named the wrong provider would reject every notification, and
 * an upload would sit in `uploading` with nothing in the UI to say why. The two
 * shapes cannot be confused — RustFS sends a `Records[]` envelope, R2 sends a
 * top-level `action` and `object` — so shape is a reliable choice.
 *
 * `null` means a bucket notification that is not an upload: a delete from
 * either provider, or a copy from R2. A RustFS copy is an `s3:ObjectCreated:*`
 * event, so it counts, following the bucket rule (`--event put`).
 */
export const storageEventSchema: z.ZodType<StorageEvent | null> = z.union([
  rustfsAdapter,
  r2Adapter,
]);
