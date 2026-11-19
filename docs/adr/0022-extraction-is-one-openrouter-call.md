# ADR-0022: Extraction is one multimodal call to DeepSeek V4.1 Flash

Date: 2026-11-19

## Status

Accepted 2026-11-19. The code change is [#250](https://github.com/Kevin-RB/possum-receipt/issues/250); until it lands, the LM Studio two-pass pipeline described in ADR-0008 and ADR-0017 is what runs.

## Context

Extraction and categorization run on LM Studio on the Mac mini. `glm-ocr` transcribes the image, `google/gemma-4-e4b` parses that transcript into the receipt contract and assigns the line-item categories. The mini is being handed back — moving production off it is what the hosting map ([#240](https://github.com/Kevin-RB/possum-receipt/issues/240)) is for — so a pipeline whose only provider is a desktop application on that machine has nowhere to run afterwards.

The destination is already partly built. ADR-0017 put the chat on OpenRouter with `zdr: true`, `require_parameters: true` and a curated catalogue, so the credential, the adapter and the data-policy gate exist. The research for the move ([#244](https://github.com/Kevin-RB/possum-receipt/issues/244)) found that a single multimodal call straight to the contract is 30–38% cheaper than transcribing and then parsing, and that it can keep the transcript as a field of its own output rather than reading the image twice.

None of that answers which model or which pipeline shape, and the research's answer was provisional. The owner measured the alternatives on his own receipts ([#246](https://github.com/Kevin-RB/possum-receipt/issues/246)) and decided on what came back, which is a different model from the research's pick.

## Decision

**Extraction is one multimodal call to `deepseek/deepseek-v4.1-flash-1017`, straight to the extraction contract. Categorization runs on the same id.**

- **`transcript` is the first field of the model-facing schema.** The schema for the call is the contract extended for that call only: `transcript` leads, so the model writes what it read before it writes any field, and the field is stripped before `receiptToFlat` touches the receipt. There is no transcript column change. The detail page's disclosure and the record of what the image said when a call fails (ADR-0008) are filled by the same call that produces the fields.
- **Categorization keeps its shape.** One `generateText` + `Output.object` per 25-item chunk, the taxonomy written into the prompt once, the leaf-slug enum as the output constraint. Only the model changes, and it changes to the same one, so chat, extraction and categorization sit on one id, one credential and one data-policy track. `deepseek/deepseek-v4.1-flash-1017` is also the chat's entry (ADR-0017), and the dated revision is deliberate: the undated alias resolves to the 2026-09-10 weights, which is unpinned drift rather than a saving.
- **Every call sends the same request preferences.** `zdr: true`, `require_parameters: true`, `reasoning: { effort: "none" }`, `usage: { include: true }`, `temperature: 0`, `maxRetries: 1`, through `createOpenRouter({ apiKey, compatibility: "strict" })`. `strict` is what makes `usage.cost` reportable. Reasoning is the cost trap — a thousand stray reasoning tokens doubles a call that should cost a fraction of a cent — and `require_parameters` is what makes the rest safe to send, because an endpoint that cannot honour them is not routed to. The retry count is one, not the SDK's default two: this is a background run whose failure is visible on the receipt and retryable in Inngest, so a third attempt mostly buys latency.
- **The contract and its strict JSON schema are used unchanged.** DeepSeek accepted `response_format.json_schema` with `strict: true` on all 60 measured calls, optional and defaulted fields included. No `strict: false`, no schema surgery.
- **No provider or quantization pinning.** Free routing is what production does. The decision is measured, not assumed — see below.

## Evidence

Five real production receipts, three runs per pipeline shape, scored against an answer key the owner adjudicated by hand against the photographs. The first key was built mechanically from the old pipeline's rows and encoded its errors; every number below is re-scored offline against the corrected one, so the improvement is the key's rather than the scoring's. Across the shapes that matter: 60/60 exact totals, 60/60 payment method, 60/60 reconciliation, 48/48 datetimes, amount F1 0.99, name-aware F1 0.96, p50 3–5s per receipt, US$0.0004–0.0008 per receipt at this corpus size. The whole effort — every variant, every re-score — cost US$0.0409.

The harness runs the production prompts, the contract, `reconcile()` and `categorizeItems()`, and lives on the unmerged branch `prototype/extraction-eval`; it re-scores offline with no key and no network. The corpus, the key and the results are real receipts held outside the repository and are never committed — they carry a card fragment and one customer's name. No merchant, date or amount of an individual receipt appears in this repository, and none should be added.

## Known gaps

Both are recorded, not fixed here, and both are follow-ups blocked by [#250](https://github.com/Kevin-RB/possum-receipt/issues/250).

- **Fields the paper prints that the model drops** ([#258](https://github.com/Kevin-RB/possum-receipt/issues/258)). ABN 13/60 runs, GST 10/36 scored and reported at all in 10/60, store id 44/60, receipt number 45/60. The ABN appears verbatim in the model's own transcript and is then dropped from the structured fields, so this is prompt pressure rather than vision.
- **Categorization agreement** ([#257](https://github.com/Kevin-RB/possum-receipt/issues/257)): 28/46 on the owner's hand-set labels, below the 90% bar. The sample is exactly the items the owner corrected, so it is a floor on disputed items rather than an estimate of overall accuracy, and the disagreements cluster on taxonomy boundaries. The owner accepted the number with the follow-up attached rather than reopening the model choice.

## Considered options

1. **`google/gemini-3.1-flash-lite`**, the research's provisional pick. Rejected on data policy rather than accuracy: every Gemini ZDR endpoint on OpenRouter is a Vertex Safety Retention endpoint, and the owner will not send receipts through that.
2. **The two-pass OCR→parse shape, on a remote model.** Rejected on accuracy and latency at once: name-aware F1 0.917 against 0.983 for one call, with a slower p50. It is the least accurate of the measured shapes and the slowest, so the separate reading pass is deleted rather than kept "just in case".
3. **One call without the transcript field**, i.e. today's production contract unchanged. Rejected on accuracy and on ADR-0008: 0.960 against 0.983 on identical routing. The transcript costs no measurable accuracy and buys the disclosure and the failure record; its only advantage is roughly two seconds and a fraction of a cent on a call that costs a tenth of a cent either way.
4. **The `:batch` variant.** Rejected on data policy: not one of the 1,052 ZDR endpoints is a batch endpoint, so the 4× cheaper batch price is unreachable under the ZDR gate. Recorded because it will be proposed again — extraction is now offline work, and batch is exactly what offline work invites. The answer is not ADR-0017's premise (the app has no offline work; that is no longer true) but that batch and ZDR do not overlap today.
5. **Pinning routing to fp8/bf16 endpoints.** Rejected on measurement: free routing scored 0.977 name-aware F1 against 0.983 for fp8/bf16-only across 43 ZDR endpoints on 34 hosts, which is inside the noise of five receipts, and pinning narrows the endpoint pool for nothing.

The research's true-ZDR challengers, Anthropic's Haiku 5.5 and Google's Gemma 4 26B, were not run: the owner chose to test DeepSeek alone rather than spend the corpus on a wider sweep.

## Consequences

- **The split pipeline collapses into one step.** `extracting` and `parsing` become one `extracting` step. The `parsing` realtime state is deleted from `lib/inngest/channels.ts` and its consumers, with no compatibility shim, and `store-transcript` goes with it.
- **The transcript is written in `storing`, for both triggers.** There is no pass between reading and structuring to fail, so the early write it was there to protect has nothing left to protect. This also removes one of ADR-0011's two trigger-dependent branches.
- **A re-process picks one model, from the app's own catalogue.** The `{ ocr, parse }` pair becomes one `model`, validated against the catalogue in `lib/chat/catalogue.ts` rather than LM Studio's `/v1/models` (ADR-0011). The dialog's model list follows the catalogue.
- **`ORC_MODEL` and `PARSE_MODEL` retire.** They are replaced by `EXTRACT_MODEL` (defaulting to the dated DeepSeek id) and `CATEGORIZE_MODEL` (defaulting to `EXTRACT_MODEL`). A deployment that sets the old pair has them ignored, not read.
- **"LM Studio is not reachable" leaves the extraction path.** The two messages in `transcribe-receipt` that raise it are deleted with the code around them, because a remote provider either answers or fails like any other remote call. Nothing in production depends on the mini afterwards; the chat's `local` entry remains a development testing target and reports its own `modelServerUnreachable` wording.
- **Cost is read from the call that ran, not from the model's price.** `zdr` excludes DeepSeek's own first-party endpoint — the one whose price carries a time-of-day schedule — so cost must be planned and reported from `usage.cost` on the response, which is what `compatibility: "strict"` makes reportable. The model's `pricing` object is a guess about a call that may not have gone there.
- **Receipt images leave the host for the first time.** Until this decision, extraction ran end to end on the Mac mini — `glm-ocr` read the image there, `gemma-4-e4b` read the transcript there — and no receipt image or text left the machine. After it, every extraction call sends the receipt image, and every categorization call the line items' text, to a third-party provider, off the host. That is a change of data posture rather than of wiring: the shift ADR-0017 accepted for chat text, extended to images. What keeps that traffic non-retaining is narrower than the flag it carries. `zdr: true` only restricts routing to OpenRouter's ZDR list, which still admits Safety Retention endpoints unless the account or a guardrail sets the model group to **ZDR only** — a self-serve account allows them by default, and the app sends the flag and nothing else (`lib/chat/catalogue.ts`). The ground is the pool on a date: on 2026-11-19 every one of the 43 ZDR endpoints serving `deepseek/deepseek-v4.1-flash-1017`, across 34 hosts, reported `safety_retention: false`. That is an observation, not a guarantee — the pool is re-evaluated when a provider changes policy, the undated alias in this family already routes to a Vertex Safety Retention row, and ZDR's own promise is "no routine storage" of prompts or responses apart from the CSAM-reporting exception the page describes, which OpenRouter applies to ZDR traffic too. So the reader is protected by a model with no Safety Retention endpoint in its ZDR pool, or by the account sitting on ZDR only, and that has to be re-checked whenever the model changes, as ADR-0017 requires prices to be re-read at a promotion. A change to either is a change to this ADR, not to configuration.
- **Existing receipts are not re-extracted** (ADR-0003, ADR-0011). The new pipeline serves new uploads and the re-processes the owner asks for; a receipt extracted by the old pair keeps the extraction it has.
- **ADR-0008 is narrowed, not superseded.** Its "write the transcript before parsing" rule no longer applies, because there is no pass to fail between reading and structuring. The transcript survives on its own merits: it is the detail page's disclosure, and it is what the image said when a call fails before it produced any fields.
- **ADR-0011 is narrowed.** Its two-model pair becomes one model per re-process, validated against the app catalogue. Its replace semantics, its atomic claim, its failure restore and its transcript-in-`storing` rule all stand unchanged.
- **ADR-0017 is narrowed.** Its "extraction and categorization stay on LM Studio" line is superseded: they now run on the same credential and the same routing flags as chat. Its `:batch` note's premise — offline work, of which the app has none today — becomes false with this decision, while its conclusion survives on the ZDR ground above. Both halves are stated here so the note is not re-litigated from the false half.

## Related

- [#240](https://github.com/Kevin-RB/possum-receipt/issues/240) (move production off the Mac mini) — the map this belongs to.
- [#244](https://github.com/Kevin-RB/possum-receipt/issues/244) (extraction research) — the provisional pipeline and cost finding.
- [#246](https://github.com/Kevin-RB/possum-receipt/issues/246) — the decision ticket, the measured prototype and the constraints on implementation.
- [#250](https://github.com/Kevin-RB/possum-receipt/issues/250) — the implementation this ADR's status depends on.
- [#257](https://github.com/Kevin-RB/possum-receipt/issues/257) (categorization agreement) and [#258](https://github.com/Kevin-RB/possum-receipt/issues/258) (printed-but-optional fields) — the known gaps.
- ADR-0008 (persist the OCR transcript) — narrowed as above.
- ADR-0011 (re-processing replaces the stored extraction) — narrowed as above.
- ADR-0017 (app-owned provider keys and a curated catalogue) — the credential, routing flags and catalogue this reuses; its "stay on LM Studio" line is superseded.
- Branch `prototype/extraction-eval` (`266ee6a`, never merged) — the harness behind every measurement here.
