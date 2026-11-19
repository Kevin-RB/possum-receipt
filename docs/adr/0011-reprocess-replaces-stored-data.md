# ADR-0011: Re-processing replaces the stored extraction

Date: 2026-10-07

## Status

Accepted. Supersedes ADR-0003. Narrowed by ADR-0022 (2026-11-19), landing with [#250](https://github.com/Kevin-RB/possum-receipt/issues/250): a re-process names one model rather than an `{ ocr, parse }` pair, and a first extraction no longer writes the transcript before anything. The replace semantics, the atomic claim, the failure restore and the transcript-in-`storing` rule stand.

## Context

Some receipts extract badly — a smudged photo OCRs to noise, a receipt layout the parse prompt misreads, a small model that simply cannot read the numbers. Once stored, that extraction is permanent: there is no path back to the pipeline, so the only remedy is to delete the receipt and upload it again, which loses the object key, the transcript, and any manual edit already made.

The owner's stated need is not just "try again" but "try again **with a bigger, smarter model**". Models are currently fixed by environment variables (`ORC_MODEL`, `PARSE_MODEL`, `CATEGORIZE_MODEL`), read at module load. Being able to name the model per run is part of the feature, not a nicety: a re-process with the same model that already failed is not worth performing.

ADR-0003 deferred re-extraction, and its "Revisit when" clause named this exactly: _"Re-extraction becomes a requested feature."_ It is now requested (issue #149). Its second consequence is the live one: _"provenance will be hard to add retroactively — there is no baseline to distinguish old edits from new."_

That provenance worry is real but it is a reason to make the destructive semantics **explicit**, not a reason to keep deferring. The two candidate policies are:

- **Replace** — a re-process overwrites the stored extraction wholesale, including manual edits and user-set categories.
- **Preserve** — a re-process keeps hand-made rows and replaces only machine-made ones.

Preserve requires provenance: a column distinguishing an AI-extracted row from a hand-added one, populated correctly by every future write path (manual edit add, manual edit remove, extraction). That is a schema migration and a permanent obligation on code that does not exist yet, for the sake of a case — "I hand-corrected three lines, now I want a better model for the other twenty" — that has not been reported. Replace is the honest default: it is the same rule the pipeline already uses for its own output, it needs no new state, and it is one thing the owner can be told plainly before they click.

The one thing replace must not do is fail silently. A re-process that fails must leave the receipt exactly as it was.

## Decision

**A re-process is a second run of the existing extraction pipeline over a stored receipt.** It re-runs OCR, parsing, and categorization, and its output **replaces** the stored extraction — all line items, and every field `receiptToFlat` writes. Manual edits and user-set categories on that receipt do not survive it. The confirm dialog says so.

This is deliberately the same code path as a first extraction. `transcribe-receipt` gains a second trigger, `receipt/reprocess`, rather than a second function: the steps are identical and a near-copy is a near-copy that rots.

**Models are chosen per run.** The `receipt/reprocess` event carries `models: { ocr, parse }`. Both already existed as optional parameters on `transcribeReceiptImage` and `parseReceiptText`, so this only widens the event schema and passes the values through. The chosen ids must appear in the list LM Studio reports from `GET /v1/models`, validated server-side at trigger time — a re-process cannot proceed anyway without LM Studio, so validating costs nothing and turns a provider 404 into a message naming the problem.

Categorization re-runs over the new items, exactly as it does after a first extraction, and keeps using the environment-configured `CATEGORIZE_MODEL`. It is a separate model slot with its own existing configuration, and a third picker in a row-action dialog is speculative.

**The claim is atomic, and it happens in the server action.** The action updates the receipt from `done` or `error` to `processing` with a `WHERE status IN (...)` and requires a row back. A request that cannot claim the receipt is refused, so two rapid clicks cannot start two runs against one receipt. The function's own status guard is therefore only a shape check for this trigger — the claim already happened.

**A failed re-process restores the status it started from.** `receipt/reprocess` carries `previousStatus`, and `onFailure` writes that back rather than the usual `error` — unless the receipt is already `done`, which means `storing` committed and the new extraction is the one on the row, so there is nothing to report. Without the restore, a re-process that fails — LM Studio OOMs, the parse model rejects the schema — would leave a receipt whose stored data is still perfectly good marked `error`, which hides the edit form, drops it out of `listDoneReceipts`, and excludes it from every spend query. The data is only replaced in the final `storing` step, so any earlier failure leaves the previous extraction fully intact and the receipt should keep saying so.

**A field the new parse omits is cleared, not kept.** `receiptToFlat` maps every absent field to `null`. Drizzle drops `undefined` from an update, so passing the omission through would leave the previous extraction's value in place — which for a receipt being re-processed to be _fixed_ is the exact opposite of what was asked. (This also fixes the same latent hole in the manual edit: clearing a receipt number and saving used to keep the old one.)

**A claim expires.** A receipt is spoken for from the moment it is queued and until a run finishes with it, and the only paths that release it are the run's own success or its failure handler. Several ways a run never gets that far: the event is accepted by Inngest when no function matches it (a stale app sync — `inngest.send` resolves `200` and no run is created), the process holding the run dies before `onFailure` fires, or `onFailure` itself cannot be delivered. Any of these leaves a receipt spoken for with nothing behind it, and nothing else in the app moves it out of `pending` or `processing`, so it is a dead end reachable only by editing the database.

`receipts.processing_started_at` records when a run claimed the receipt — written by the action's claim for a re-process and by `mark-processing` for any run that reaches it, so a `pending` row carries no stamp — and `reprocessReceipt` will take a claim over once it is older than `PROCESSING_LEASE_MS` (30 minutes). It is generous on purpose: a local extraction runs six to ten minutes, and taking a claim that is genuinely still running produces two runs against one receipt. A stamp that is `null` — a row claimed before this column existed — is treated as expired, which is what makes an already-stuck receipt recoverable on deploy rather than after a further thirty minutes.

`pending` is deliberately excluded from takeover. A receipt waiting for a slot has never been extracted, so replacing it costs nothing and delete-and-re-upload is a real escape; taking it over would race the live `receipt/uploaded` run whose guard expects it to still be `pending`. `processing` is where data is at stake, so it is the one that needs the way back.

A receipt taken over from an expired claim carries `previousStatus: "error"` rather than whatever the row says now. The run that abandoned it is the thing that would have known its prior state, and `error` is at least re-processable rather than a row that returns to being claimed.

**`storing` deletes before it inserts**, unconditionally, in one transaction. A first extraction has no line items to delete, so the delete is a no-op there and there is no branch to reason about. `categorizedAt` is reset to `null` in the same write: the new items carry no categories, so leaving the old stamp would claim a categorization that no longer exists.

**The transcript is written with the extraction, not before it.** A first extraction still writes it as soon as OCR has produced it, because there is nothing else on the row and ADR-0008 made that text the only evidence of what the image said when parsing fails. (Narrowed by ADR-0022, landing with #250: one call produces the transcript with the fields, so there is no OCR step to write it from and a first extraction writes it in `storing` too; the re-process rule in this paragraph is unchanged.) A re-process does not have that case — the row already holds a transcript describing the extraction still stored on it. Writing the new one early would leave a failed re-process showing a receipt that reads as `done`, with the previous extraction and a transcript that produced nothing, which breaks the guarantee above from the side. So a re-process writes it inside the `storing` transaction, and the transcript on a row always belongs to the data on that row.

## Consequences

- A bad extraction is recoverable without re-uploading, and the owner can pick a stronger model for the attempt.
- Manual edits and user-set categories on a re-processed receipt are lost. This is stated in the confirm dialog before the action runs, not discovered afterwards. Provenance tracking remains unshipped; if preserving hand-made rows is later wanted, it is a new column and a new ADR, and this one is the thing to supersede.
- `transcribe-receipt` carries two branches on which trigger fired: one selects the model pair and the expected status, the other decides whether the transcript is written early. (Narrowed by ADR-0022, landing with #250: the transcript branch goes — no run writes the transcript early — while the model-and-expected-status branch survives as the trigger-dependent one, its `{ ocr, parse }` pair becoming a single catalogue model. One branch removed, one narrowed.) The steps themselves are shared, which is the point.
- The table follows a run from `pending` or `processing`, which is the queue as well as the claim: the claim is a step inside the run, so a receipt waiting for a concurrency slot sits in `pending` for as long as the runs ahead of it take. It does not follow a run already `done` on arrival — a re-process started from another tab is not seen here, and closing that would need either a poll or a list of recently active receipts, which is a different feature.
- A run proves it may touch the receipt before it touches it, and cannot write without proving it. The event carries a `userId`; the lookup is scoped to it rather than to the receipt id alone, and the status write carries the owner in its own `WHERE` so no call site can move a receipt the sender does not own. The failure path is where that matters most: a run for a receipt the event's `userId` does not own writes nothing there, rather than reporting a failure against a row it never proved it may touch. The event is a message anyone holding the event key can send, and this run deletes every line item and overwrites the stored extraction. This narrows what `receipt/uploaded` already relied on, and the unscoped helper it used is gone.
- The realtime client has no server-side replay. A stage published before the table's subscription opens is not seen, so a run that starts and finishes inside a dropped connection leaves its row on `processing` until the page is reloaded. This is a limit of the transport, not of the trigger.
- There is no history. A re-process leaves nothing recording that it happened, or with which models, so a receipt that is re-processed and then re-processed again is indistinguishable from one that was never touched. If that matters, it is a run-history table, not a column on `receipts`.
- A receipt is `processing` for the length of a re-process, and `processing` is what `listDoneReceipts` and the spend queries exclude. So a re-processed receipt briefly drops out of the overview and returns when the run lands. `processing` is the only in-flight status the lifecycle has; a separate one would mean touching the enum, both badge maps, the table schema, the spend queries and the edit guard to avoid a one-minute flicker.
- The picker cannot tell a vision model from a text-only one, because LM Studio's model list does not say. A text model can be chosen for OCR and will fail at the provider. The two selects are labelled by role because that is what can honestly be known here. (Narrowed by ADR-0022, landing with #250: one select over the app catalogue instead of two role-labelled ones, so the OCR role — and a text-only model picked for it — is no longer a choice the dialog offers.)
- An unreachable model server is reported rather than degraded around: the picker lists nothing and the trigger refuses, because no run can happen without the provider. (Narrowed by ADR-0022, landing with #250: nothing on the extraction path reaches a model server, so the unreachable case and its copy leave with it; the trigger still refuses an id the catalogue does not list.)
- The model list is fetched server-side. LM Studio is reachable from the app container but not from the browser in production, so the picker is populated by a server action rather than a client fetch. (Narrowed by ADR-0022, landing with #250: the list is the app catalogue rather than LM Studio's `/v1/models`, so the reason for fetching server-side changes even if the plumbing does not.)

## Related

- ADR-0003 (no re-extraction or provenance) — superseded by this ADR; its deferral condition was met.
- ADR-0009, ADR-0010 (categories are derived; a user-set category is a decision) — both survive: a re-process replaces the items they annotate, and the `category_source` marker they rely on still governs a categorization re-run. Issue #149 does not reopen them.
- ADR-0002 (server actions for user mutations) — `reprocessReceipt` is the write path, alongside `deleteReceipt`.
- ADR-0008 (persist the OCR transcript) — still holds for a first extraction, which writes the transcript early so a parse failure leaves the OCR text behind. A re-process defers that write to the store, so this decision narrows when the early write applies rather than removing it. (Narrowed by ADR-0022, landing with #250: with no parse pass, no extraction writes the transcript early — the early write is removed and the transcript stands; see ADR-0008's status.)
- Issue #149.
