# ADR-0020: The app owns its storage-event format, with one adapter per provider

Date: 2026-11-19

Issue: #247

## Status

Accepted, and partially superseded by ADR-0021 (2026-11-19). The app-owned `StorageEvent` shape and the RustFS adapter stand: RustFS still notifies the webhook in local development, and `lib/storage/event.ts` still turns that envelope into the app's own event. The `r2Adapter` and the Queue-forwarding Worker it names do not: the R2 upload signal became a verified browser call with page-load reconciliation, so [#252](https://github.com/Kevin-RB/possum-receipt/issues/252) removed the adapter, and the Worker was never written (ADR-0021). Everything below is the record of what was decided and shipped at the time; the update at the end records the removal.

## Context

The bucket notification is the authoritative "upload finished" signal (ADR-0001): a receipt row sits in `uploading` until object storage says the object landed, and that call is what starts extraction.

S3 standardises object operations, not how events are delivered. RustFS POSTs an S3 `Records[]` envelope to the webhook. R2 delivers notifications to a Queue, not to a URL. Tigris and S3 itself, through SNS, have envelopes of their own again. The notification is the part each provider invents.

Until now the route read RustFS's envelope directly (`Records[0].s3.object.key`), so the provider's format was the app's format. Production is moving to Vercel with R2 for images while local development keeps RustFS (issue #240), so the webhook has to accept two providers at once.

This ADR does not record the production move itself: retiring RustFS and the Coolify deployment (ADR-0005) in production belongs to the deployment's own ADR (#251). It only makes the webhook ready for both providers.

## Decision

**The app defines its own storage event, and each provider gets an adapter that produces one.**

- **`StorageEvent` is `{ objectKey: string }`** (`lib/storage/event.ts`): an object finished uploading, named by its object key. That is the only thing the app needs from a notification.
- **One private Zod adapter per provider, in the same file.** `rustfsAdapter` reads the S3 `Records[]` envelope RustFS POSTs, taking `Records[0]` and counting only `eventName` values that start with `s3:ObjectCreated:`; it percent-decodes the key, because RustFS encodes it and `/` becomes `%2F` (ADR-0006). `r2Adapter` reads the Queue message body `{ account, action, bucket, object: { key, size, eTag }, eventTime }` that a Cloudflare Worker forwards to the webhook unchanged with the Bearer token (the Worker is #252); only `PutObject` and `CompleteMultipartUpload` count, and the key is used as it arrives. Each adapter validates only the fields it reads, using loose objects, as ADR-0006 already did. An R2 delete message carries no size or eTag, so only `action` and `object.key` are required.
- **`storageEventSchema = z.union([rustfsAdapter, r2Adapter])`, and the adapter is chosen by the payload's shape.** Its output is `StorageEvent | null`: a well-formed notification that is not an upload yields no event. RustFS sends a `Records[]` array; R2 sends a top-level `action` and `object`. Neither carries the other's fields, so the shapes cannot be confused. There is no environment setting naming the provider, and one deployment accepts both.
- **The webhook works on the storage event alone.** `app/api/storage-events/route.ts` finds the receipt by object key, promotes `uploading → pending`, and sends `receipt/uploaded`. No provider field is read outside an adapter, so adding a provider does not touch the route.
- **A notification that is not an upload is acknowledged, not rejected.** It maps to `null`, is answered 200, and is logged as `storage-events: not an upload — ignored`: a retry could never change it. That is a delete on either provider, and a copy on R2. A RustFS copy is not in the ignored set: the bucket rule registers `--event put`, which is `s3:ObjectCreated:*`, so `s3:ObjectCreated:Copy` is an object-created event and counts as an upload. The asymmetry follows each provider's own event vocabulary; neither app path copies an object, so neither case arises today. An unrecognised shape is still a 400 with a body preview. The Bearer check and redelivery are unchanged: the `receipt/uploaded` event id is deterministic, and a row already `pending` re-sends.
- **Object operations stay on the S3 client** (`lib/storage/client.ts`). Presigning, downloading and deleting differ between RustFS and R2 only in endpoint, credentials and CORS, which the client already reads from the environment; an abstraction there would be a layer over an API both providers implement.

## Considered options

1. **An environment variable naming the provider.** A wrong or missing value rejects every event, and uploads strand in `uploading` with nothing in the UI to say so — precisely the failure the webhook exists to prevent. It also cannot accept two providers at once.
2. **Have the Worker translate R2 messages into the `Records[]` shape the route already parsed.** Provider knowledge would live outside the app, in separately deployed code the app's tests never reach, and the app's own format would still be RustFS's.
3. **Vercel Blob's `onUploadCompleted` callback in place of a bucket notification.** Considered in the hosting research and rejected with the hosting decision: R2 was chosen for storage, and a callback cannot reach localhost, so local development would lose the loop.

## Consequences

- **Adding a provider is an adapter and its tests in `lib/storage/event.ts`.** The route does not change, and neither does the storage event it consumes.
- **Shape selection holds only while the envelopes stay distinguishable.** A provider whose envelope overlapped another's would need a stricter adapter, not an environment switch.
- **ADR-0006's RustFS-specific event schema is superseded.** Its rules — loose objects, and the percent-decoded key — live on inside `rustfsAdapter`.
- **A non-upload notification costs a log line, not a retry loop.** The bucket rules subscribe to creates only (RustFS `--event put`, which is `s3:ObjectCreated:*`, and R2's object-create rule), so a delete should never arrive; if one does, the 200 stops the redelivery.
- **R2 events need a Queue and a Worker in front of the webhook (#252).** The app side does not change for them: the Worker forwards the message body with the Bearer token.
- **The R2 fixture follows Cloudflare's documented message format**, not a captured message; the RustFS fixture is a captured payload. Capturing a real R2 message and checking it against the fixture is #252's job, on the first production upload.

## Related

- ADR-0001 (upload via presigned URL and bucket notification) — the notification as the authority on "upload finished".
- ADR-0006 (migrate object storage to RustFS) — its RustFS event schema is superseded by this ADR.
- Issue #240 — the hosting decision, and its [decision comment](https://github.com/Kevin-RB/possum-receipt/issues/240#issuecomment-6978734679), which settled Vercel with R2 for images and RustFS for local development.
- Issue #247 — this decision; issue #252 — the R2 Queue and Worker.

## Update 2026-11-20

`r2Adapter` is gone: #252 removed it, so `lib/storage/event.ts` keeps `rustfsAdapter` alone and `storageEventSchema` has no second arm to choose between. R2 never posts a payload to the app — the production upload is confirmed by the browser's session-authenticated call naming a receipt id, which the route verifies with a `HeadObject` and reconciles on page load (ADR-0021) — so the adapter had nothing left to parse, and the Queue-and-Worker consequences below are the history of a flow that was declined. The `StorageEvent` shape and the RustFS path stand exactly as recorded above: local development's bucket notification is still the app's only provider-supplied event.
