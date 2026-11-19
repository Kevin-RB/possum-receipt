# ADR-0021: Upload-finished is verified, not notified

Date: 2026-11-19

## Status

Accepted

## Context

Production receipt images are moving from the Mac mini's RustFS bucket to Cloudflare R2 ([#240](https://github.com/Kevin-RB/possum-receipt/issues/240)). R2 is reached over the plain S3 API that `lib/storage/client.ts` already speaks, so the app does not need to know which object store answers. What it does not have is the signal the current design is built on: RustFS calls a webhook when an object lands, and that call is what promotes a receipt from `uploading` to `pending` and starts extraction (ADR-0001, ADR-0006).

R2 has no equivalent webhook to an arbitrary HTTP endpoint. Its event notifications deliver to a Queue, and Queues, Workers and cron triggers all sit behind the Workers Paid plan — a US$5/month minimum per account. The storage map for [#240](https://github.com/Kevin-RB/possum-receipt/issues/240) assumed US$0/month, so the designed R2 → Queue → consumer Worker flow does not fit inside it. R2 itself needs no Workers subscription: buckets, the S3 API, presigned URLs, bucket locks and lifecycle rules, and plain S3 writes from CI are all included, with 10 GB of storage and 1M class-A operations a month free.

Tigris was the alternative that would have delivered a native webhook for free, and it was rejected. It would make the image store and the backup store the same, newer, smaller vendor, giving up the hedge [#240](https://github.com/Kevin-RB/possum-receipt/issues/240) chose R2 to keep: backups on a different provider from the primary. A free signal is not worth collapsing that separation.

R2 is strongly consistent, including read-after-write: a `HeadObject` issued after a successful `PutObject` sees the object immediately. Plain S3 is not, for overwrites, which is why the property is worth naming here rather than assuming it. It is what makes a check immediately after an upload decisive rather than hopeful.

The flow the signal has to fit is already in place. `POST /api/upload` inserts the row with `status = "uploading"` and returns a presigned `PUT` that expires in five minutes, so the browser uploads straight to storage and the app never handles the bytes. The retry route re-presigns a row only while it is still `uploading`, which is the affordance a stuck row needs. Everything after that has hung on the storage layer saying the object arrived; this decision replaces that one sentence and leaves the rest of the lifecycle (`uploading → pending → processing → done/error`) alone.

An optimistic promotion — flipping the row to `pending` because the browser said its `PUT` succeeded — was the obvious cheap option and is not taken. `pending` is read by the receipts table and the realtime subscription as "queued for extraction", and the extraction run then treats the object as present. A row that says `pending` without an object turns one claim into a failed run, a retry that looks like a storage fault, and an `error` nobody can explain. The status is worth one `HEAD`.

The owner decided on 2026-11-19 that images stay on R2, that the upload signal becomes a browser call plus reconciliation, and that the monthly cost is $0. The paid Queue flow was explicitly declined. This ADR records that decision and supersedes the Queue-and-consumer half of the storage decision in [#240](https://github.com/Kevin-RB/possum-receipt/issues/240).

ADR-0020 recorded the app-owned storage event with one adapter per provider, and its `r2Adapter` was written against the Queue message a forwarding Worker would deliver (#252). The RustFS adapter and the app-owned event shape stand: RustFS still calls the webhook in local development, and the event it produces is still what the route acts on. The `r2Adapter` and the Worker it names do not, because nothing will ever call them now that no Queue exists. `lib/storage/event.ts` therefore keeps the RustFS adapter alone.

## Decision

**The browser reports the receipt; the server verifies the object, and the server is the authority.**

- **One authenticated call after the `PUT`.** When the presigned upload succeeds, the browser calls the app — the storage-events route or its successor — naming the **receipt**, not an object key. The receipt id is what the browser was given; the key is server-owned data and has no business travelling back from the client.
- **Owner-scoped, like the retry route.** The call resolves the session and loads the receipt for that owner before it does anything else, so a caller can name a receipt but cannot name someone else's. The key it passes to `HeadObject` is the one already stored on the row, which is both the authorisation check and the correctness one: no client-supplied key can point the verification at a different object.
- **Verification before promotion.** The server checks the object exists with `HeadObject` before it flips the row to `pending` and sends `receipt/uploaded` to Inngest. It may retry that check once or twice inside the same request rather than trusting the caller. Because R2 is read-after-write consistent, a `HeadObject` straight after a successful `PUT` is decisive: present means the bytes are there, absent means the call was wrong or early. If it is still absent after those retries, the call answers with a failure and the row stays `uploading`, leaving reconciliation — which waits out the presign window — to settle it, rather than turning a doubtful moment into a permanent `error`.
- **A repeat call is a no-op.** The row is already `pending`, so promotion is idempotent — the same property the RustFS webhook relies on today when it redelivers. A user who retries, or a browser that fires twice, cannot start two extractions. The repeat still re-sends the event, with the same deterministic id, so a call whose promotion committed but whose enqueue failed can be completed by trying again, and Inngest dedupes it.
- **The call has one job.** It promotes and enqueues, and answers with an acknowledgement; it does not return the image, the transcript or an estimate. Keeping the response to an acknowledgement means a lost reply costs nothing, because the promotion is already committed and the next page load reads it.
- **Reconciliation on page load, not on a schedule.** When `/receipts` loads, rows still `uploading` and older than the five-minute presign window (`PRESIGNED_URL_EXPIRY_SECONDS`) are checked once each with `HeadObject`. An object that is present is promoted to `pending` and extraction starts; an object that is absent sets `error`, which is the state that renders the existing retry affordance. So a reader whose tab died sees the truth on their very next visit rather than waiting for a sweep, and an upload that never happened becomes a retryable error instead of a row stuck at `uploading` for ever. The presign window is what makes "old enough" well defined: before it expires a row may legitimately still be mid-upload, and checking it would produce a false `error`.
- **The guarantee that survives.** The app no longer receives a signal from the storage layer itself. The browser is a messenger that can be lost — closed tab, dropped connection, a crash between the `PUT` and the call — and the design does not pretend otherwise. Verification and reconciliation are what make the guarantee survive the messenger: `pending` still means an object is really in the bucket, because a `HeadObject` said so, not because a client said so.

## Considered options

1. **R2 event notifications into a Queue, consumed by a Worker.** The designed flow, and the one the [#240](https://github.com/Kevin-RB/possum-receipt/issues/240) map drew. Rejected on price alone: notifications, Queues, Workers and cron triggers all require Workers Paid, and the map's US$0/month cannot include it.
2. **Tigris, for its free native webhook.** Rejected above: it would put the image store and the backup store on the same newer, smaller vendor and give up the provider hedge.
3. **Promote on the browser's word, without `HeadObject`.** Rejected: it makes `pending` a claim rather than a fact and pushes the failure into extraction, where it reads as a storage fault instead of a rejected upload.
4. **A nightly reconciliation sweep instead of page load.** Rejected because cron is paid, and because a sweep answers hours after the reader asked; the page load answers on the visit where the reader is looking at the row.

## Consequences

- **There is no `r2` payload adapter.** The event-adapter set in `lib/storage/event.ts` stays `rustfs` (and whatever the browser's call becomes), because R2 never speaks to the app. A future provider that does speak to the app gets an adapter then; nothing is written speculatively now.
- **"The storage layer notifies us" is no longer an assumption anywhere.** A future storage provider must either call back or be reconciled the same way. The verification step is the part that must not be dropped in the swap, since it is what makes either path trustworthy.
- **The upload UI carries new work.** It has to make the call after a successful `PUT` and surface a failure as the retry affordance instead of an optimistic confirmation. That is the cost of the browser being the messenger, and it is bounded to one request.
- **Better Auth's rate limit stays per-instance, in memory.** Database-backed rate-limit storage and Durable Objects were declined with the paid plan, so limits do not survive a restart and do not agree across instances. That is a known limitation of running on the free plan, recorded rather than papered over.
- **There is no delivery log.** When the browser's call is lost, nothing records a failure anywhere: the symptom is the absence of a promotion, and the page-load reconciliation is the only detector. That is why it runs on every visit rather than at some convenient interval — what it looks for fails silently.
- **The free tier is not close.** The rescued corpus is 75 objects and about 16 MB against 10 GB of storage and 1M class-A operations a month; each upload costs a `PUT` and one `HEAD`, and reconciliation adds a `HEAD` per stale row only. The $0 is a real number, not a rounding of a bill that arrives later.
- **No new state is introduced.** `ProcessingStatus` stays `uploading | pending | processing | done | error`. What changes is only who may move a row out of `uploading` — a verified check rather than a notification — so the table, the realtime subscription and the retry route all keep working unchanged.
- **Nothing here needs a cron trigger**, which is just as well, because cron is paid too. Reconciliation runs on page load, where it costs one `HEAD` per stale row and nothing when there is none. No scheduled job has to exist for the system to stay correct.
- **Declined, not forgotten:** paying US$5/month for Workers Paid, the R2 → Queue → consumer Worker design, and Tigris as the image store. Each was considered against this decision and lost for the reason given above, so a later reader finds the reasoning instead of re-proposing the same flow.

## Related

- [#240](https://github.com/Kevin-RB/possum-receipt/issues/240) (hosting and storage) — this ADR supersedes its Queue-Worker half.
- [#253](https://github.com/Kevin-RB/possum-receipt/issues/253) (backups bucket, bucket locks and lifecycle rules).
- ADR-0001 (upload via presigned URL and bucket notification) — the presigned-upload design this refines.
- ADR-0006 (migrate object storage to RustFS) — the webhook this replaces in production.
- ADR-0020 (the app owns its storage-event format) — its RustFS adapter stands; its `r2Adapter` and the Queue-forwarding Worker it names are retired by this decision.
- `docs/guides/r2-bucket-and-token.md` — the bucket and token setup this decision depends on.
