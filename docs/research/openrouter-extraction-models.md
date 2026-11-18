# OpenRouter models for OCR, parsing and categorization

Research for issue #244 (parent map #240: move production off the Mac mini). Written 2026-11-18.

**Question.** Which OpenRouter models should replace LM Studio for OCR, parsing and categorization, and can one multimodal call go straight from the receipt photo to `ReceiptInformationExtractionSchema` (`lib/db/contract.ts`) with structured output, so the separate OCR step goes away?

**Short answer.** Yes, a single call is viable on several models with ZDR + structured-output endpoints. On every candidate it is about 30–38% cheaper than OCR→parse, but at these prices the whole pipeline costs **well under a tenth of a cent per receipt** either way, so cost does not decide it. Accuracy and operational fit do. Recommended (provisional until the accuracy test below has run):

- **Extraction:** one call to `google/gemini-3.1-flash-lite`, with a `transcript` field added to the *model-facing* schema so the persisted transcript survives (ADR-0008). The challengers are `anthropic/claude-haiku-5.5` (true ZDR, not Safety Retention) and `google/gemma-4-26b-a4b-it` (cheapest, open weights).
- **Categorization:** the same model as extraction. It is one id, one data-policy track and one accuracy test. `deepseek/deepseek-v4.1-flash-1017` (the chat model) is the cheaper alternative if the owner prefers it.

Every price below is from OpenRouter's live API, **fetched 2026-11-18**. Prices on OpenRouter move by multiples within days (ADR-0017 records `z-ai/glm-5.3-flash` going 5× and back), so re-read them before wiring anything in.

---

## Sources

| Ref | Source | Used for |
| --- | --- | --- |
| [OR-models] | `GET https://openrouter.ai/api/v1/models` (478 models, fetched 2026-11-18) | modalities, `supported_parameters`, list prices, reasoning defaults, expiry |
| [OR-zdr] | `GET https://openrouter.ai/api/v1/endpoints/zdr` (1,173 endpoints, fetched 2026-11-18) | which endpoints are ZDR, per-endpoint price, per-endpoint `supported_parameters`, `safety_retention` |
| [OR-endpoints] | `GET https://openrouter.ai/api/v1/models/{id}/endpoints` | per-endpoint listing (no per-endpoint modality field exists) |
| [OR-routing] | https://openrouter.ai/docs/guides/routing/provider-selection.md | `require_parameters`, `zdr` semantics |
| [OR-zdr-doc] | https://openrouter.ai/docs/guides/features/zdr.md | Safety Retention definition and account setting |
| [OR-so] | https://openrouter.ai/docs/guides/features/structured-outputs.md | structured outputs are per endpoint; `strict` enforcement varies |
| [Gemini-media] | https://ai.google.dev/gemini-api/docs/media-resolution | Gemini 3/4 image token cap (1120 at `high`) |
| [Claude-vision] | https://docs.claude.com/en/docs/build-with-claude/vision | Claude 4.7+ high-res tier: 2,576 px long edge, ≤4,784 tokens |
| [OpenAI-vision] | https://platform.openai.com/docs/guides/images-vision | 32 px patch tokenization and per-model multipliers |
| [Gemma4-card] | https://huggingface.co/google/gemma-4-26B-A4B-it (README) | Gemma 4 visual token budgets 70–1120 |
| [sdk-or] | `node_modules/@openrouter/ai-sdk-provider` 3.1.0 (`dist/index.js`, `dist/index.d.ts`, README) | how structured output, images, reasoning and routing are sent |
| [sdk-ai] | `node_modules/ai` 7.0.156 | `generateText` + `Output.object` (already used) |
| repo | `lib/ai/*`, `lib/inngest/functions/transcribe-receipt.ts`, `lib/chat/catalogue.ts`, ADR-0003/0008/0011/0017 | current pipeline and constraints |

---

## 1. What the pipeline does today

- `lib/ai/transcribe-receipt-image.ts` makes two calls to LM Studio. The OCR call (`glm-ocr`) takes the image as a `file` part with `TRANSCRIPTION_PROMPT` and returns free text. The parse call (`google/gemma-4-e4b`) takes `PARSE_PROMPT` (4,525 chars, ≈1,150 tokens) plus the transcript, with `Output.object({ schema: ReceiptInformationExtractionSchema })` and `temperature: 0`.
- `transcribe-receipt.ts` runs these as separate Inngest steps (`extracting`, `parsing`). On a first extraction it writes the transcript *between* them (ADR-0008); on a re-process it writes it inside `storing` (ADR-0011). Each step publishes a realtime state (`lib/inngest/channels.ts`: `extracting | parsing | storing | done | failed`).
- `lib/ai/categorize.ts` makes one `generateText` + `Output.object` call per 25-item chunk. The taxonomy (44 seeded categories, `drizzle/20260925043050_spicy_centennial`) goes into the prompt once, and the output is constrained by a Zod enum of leaf slugs.
- Images are compressed in the browser to JPEG q0.8 with the long edge ≤ 2,000 px (`lib/images/compress-receipt-image.ts`). A typical phone receipt is therefore about 900×2000.
- The chat already uses `@openrouter/ai-sdk-provider` with `compatibility: "strict"` and `provider: { require_parameters: true, zdr: true }` (`lib/chat/catalogue.ts`). ADR-0017 currently says "extraction and categorization stay on LM Studio", and that line has to be revised.

## 2. Hard constraints on a candidate

1. **Image input.** A model-level fact: `architecture.input_modalities` contains `image` [OR-models]. OpenRouter publishes **no per-endpoint modality field** [OR-endpoints], so a model listed as vision is assumed to accept images on every endpoint. Treat that as unverified for models served by many third-party hosts (see DeepSeek below).
2. **Structured output on a ZDR endpoint.** Both are per endpoint [OR-so]. `zdr: true` restricts routing to the ZDR list [OR-routing], and `require_parameters: true` drops endpoints that do not support every parameter sent [OR-routing]. The intersection was computed from [OR-zdr]'s per-endpoint `supported_parameters` (`structured_outputs`).
3. **Safety Retention counts as ZDR-eligible by default.** With `zdr: true`, Safety Retention endpoints (retained only for abuse prevention, never trained on) stay eligible unless the account's privacy setting for that model group is "ZDR only". Self-serve accounts allow it by default [OR-zdr-doc]. **Every Gemini ZDR endpoint is Safety Retention** (`safety_retention: true` in [OR-zdr]). ADR-0017 already accepted that for chat ("its ZDR-eligible Gemini endpoints are Google's own Safety Retention endpoints"). Claude Haiku 5.5, GPT-6 Luna, Gemma 4 and DeepSeek endpoints are all `safety_retention: false`.
4. **`require_parameters` interacts with what the code sends.** This was found in the data and it matters:
   - **`temperature`.** Both functions send `temperature: 0`. The ZDR endpoints for `anthropic/claude-haiku-5.5`, `openai/gpt-6-luna`, `google/gemini-3.5-flash-lite` and `google/gemini-3.8-flash` do **not** list `temperature` [OR-zdr]. With `require_parameters: true`, those models would have *no eligible endpoint* and every request would fail. `gemini-3.1-flash-lite`, the Gemma 4 models, Qwen3-VL, Nemotron VL, Mistral Small and DeepSeek do list it. Either drop `temperature` per model or use a model that supports it.
   - **`reasoning`.** Several candidates reason by default and bill the reasoning as output tokens: `deepseek-v4.1-flash-1017` (enabled by default, effort `high`), `gpt-6-luna` (enabled by default, `medium`), `gemini-3.1-flash-lite` (enabled by default, `minimal`) [OR-models]. Extraction and categorization do not need it, so send `reasoning: { effort: "none" }` (typed in [sdk-or] `OpenRouterProviderOptions`). Under `require_parameters`, that also requires the endpoint to list `reasoning`, so check it with the chosen model.
5. **Strict JSON schema.** The OpenRouter provider sends `response_format: { type: "json_schema", json_schema: { strict: true, … } }` unless `structuredOutputs.strict` is set to `false` [sdk-or, `dist/index.js` ~L4300]. The contract has optional fields (`merchant.abn`, `totals.subtotal`, …), `.default()`s, and a non-strict top-level `z.object`. OpenAI-style strict mode requires every property to be in `required` and `additionalProperties: false` on every object, so **Azure-served OpenAI models (`gpt-6-luna`, `gpt-4.1-nano`) are likely to reject the contract schema as-is**. Gemini and Anthropic translate the schema into their own format [OR-so]. This is not verified by a call (no paid calls were made); it is the first thing the accuracy test would surface.

## 3. Candidates (vision + structured output + ZDR endpoint)

The full list of non-`:free`, non-router models with image input and `structured_outputs` is 294 entries [OR-models]. Filtered to cheap, GA (non-preview, no `expiration_date`), synchronous (`:batch` cannot serve an Inngest step that waits on the answer; see ADR-0017's batch note), and with at least one ZDR endpoint supporting structured output:

| Model (canonical slug) | Cheapest ZDR+SO endpoint | $/1M in / out (2026-11-18) | ZDR eps | `temperature` on ZDR eps | Reasoning default | Safety Retention | Image tokens, 900×2000 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `google/gemini-3.1-flash-lite` (`-20260507`, GA) | `google-vertex/global` | 0.25 / 1.50 | 5 (flex 0.125/0.75, 83% uptime) | yes | on, `minimal` | **yes** | ≤1,120 at `high` [Gemini-media] |
| `anthropic/claude-haiku-5.5` (`-20261007`) | `google-vertex/global` | 0.10 / 0.50 | 6 (Bedrock ones are `response_format` only) | **no** | not marked default-enabled (default effort `medium` if enabled) | no | ≈2,400 (pixels/750, high-res tier) [Claude-vision] |
| `openai/gpt-6-luna` (`-20260922`) | `azure` | 0.10 / 0.50 | 3 | **no** | on, `medium` | no | ≈2,200 *(estimate: 32 px patches × 1.2; luna's multiplier is not in the table)* [OpenAI-vision] |
| `google/gemma-4-26b-a4b-it` (`-20260403`) | `deepinfra/fp8` | 0.07 / 0.34 | many (bf16 at coreweave/primeintellect 0.10/0.30) | yes | off | no | ≤1,120 (host picks budget 70–1120) [Gemma4-card] |
| `google/gemma-4-31b-it` | `coreweave/fp4` | 0.10 / 0.34 | 15 | yes | off | no | ≤1,120 [Gemma4-card] |
| `qwen/qwen3-vl-30b-a3b-instruct` | `deepinfra/fp8` | 0.15 / 0.60 | 3 | yes | n/a | no | ≈1,800 *(estimate)* |
| `nvidia/nemotron-3.5-super-vl` | `crusoe/bf16` | 0.10 / 0.40 | 9 | yes | off | no | unknown, ≈1,800 assumed |
| `mistralai/mistral-small-2603` | `mistral/zdr` | 0.15 / 0.60 | 3 | yes | off | no | unknown, ≈1,800 assumed |
| `deepseek/deepseek-v4.1-flash-1017` | `wafer/us` (mxfp4) | 0.036 / 0.50 | ~50 | yes | on, `high` | no | unknown, ≈1,800 assumed |

Models that were excluded, and why:

- `google/gemini-2.5-flash-lite` and `google/gemini-2.5-flash`: **no ZDR endpoint** [OR-zdr].
- `qwen/qwen3.5-flash-02-23`, `qwen/qwen3.8-flash` and `nex-agi/nex-n2.5-mini`: no ZDR endpoint.
- `openai/gpt-5-nano` and `openai/gpt-5-mini`: `expiration_date` 2026-12-11.
- `google/gemini-3.5-flash-lite` (0.30/2.50) and `gemini-3.8-flash` (0.75/3.75): pricier, and their ZDR endpoints lack `temperature`.
- `moondream/*` (the only OCR-branded models): no structured outputs.
- Dedicated OCR models such as `glm-ocr` are not on OpenRouter [OR-models].

**DeepSeek V4.1 Flash 1017.** It is listed as `text+image->text` [OR-models], but it is served by ~50 third-party hosts, mostly quantized (fp4/mxfp4/fp8), and OpenRouter does not say which of them accept images. Its list price has also moved since the chat catalogue's 2026-11-08 snapshot: the cheapest ZDR input is now $0.036, against $0.006 in `lib/chat/catalogue.ts`. That is worth re-checking for chat as well. It is a reasonable *categorization* candidate. It is a risky extraction candidate until the accuracy test proves image routing.

## 4. Cost per receipt: two-step vs single call

The token model is an assumption, stated so it can be replaced with measured numbers from the accuracy test (OpenRouter returns `providerMetadata.openrouter.usage.cost` per call [sdk-or README]):

- OCR call: 60 prompt tokens + image tokens in; 500-token transcript out.
- Parse call: `PARSE_PROMPT` 1,150 + JSON schema 350 + transcript 500 in; 650 out (≈12 items).
- Single call: `PARSE_PROMPT` 1,150 + schema 350 + image in; 650 out.
- Same model for both steps of the two-step, cheapest ZDR+SO endpoint, reasoning off.

| Model | Two-step, $/1000 receipts | Single call, $/1000 | Saving |
| --- | --- | --- | --- |
| `google/gemini-3.1-flash-lite` | 2.52 | 1.63 | 35% |
| `anthropic/claude-haiku-5.5` | 1.02 | 0.72 | 30% |
| `openai/gpt-6-luna` | 1.00 | 0.70 | 31% |
| `google/gemma-4-26b-a4b-it` | 0.61 | 0.40 | 34% |
| `google/gemma-4-31b-it` | 0.71 | 0.48 | 32% |
| `qwen/qwen3-vl-30b-a3b-instruct` | 1.27 | 0.89 | 30% |
| `nvidia/nemotron-3.5-super-vl` | 0.85 | 0.59 | 30% |
| `mistralai/mistral-small-2603` | 1.27 | 0.89 | 30% |
| `deepseek/deepseek-v4.1-flash-1017` | 0.72 | 0.45 | 38% |

What follows from the table:

- **The most expensive candidate costs a quarter of a cent per receipt.** At a few hundred receipts a month, the gap between the best and worst choice is cents per month. Cost is a tiebreaker, not a criterion.
- **Reasoning is the cost trap.** 1,000 accidental reasoning tokens add $0.34–$1.50 per 1000 receipts, as much as the call itself. Set `effort: "none"`.
- The `transcript`-in-schema variant (§5) adds ≈500 output tokens to the single call: +$0.75/1000 on Gemini 3.1 Flash Lite, +$0.25/1000 on Haiku 5.5, +$0.17/1000 on Gemma 4 26B. That is still below the two-step on every model.
- `pricing.image` on Gemini (`0.00000025`) is negligible whichever way it is read.

**Categorization.** About 800 tokens in (the 44-category taxonomy, instructions, ~12 item names) and 200 out per receipt:

| Model | $/1000 receipts |
| --- | --- |
| `deepseek-v4.1-flash-1017` | 0.13 |
| `gemma-4-26b-a4b-it` | 0.12 |
| `claude-haiku-5.5` | 0.18 |
| `gemini-3.1-flash-lite` | 0.50 |

The Zod `enum` of slugs maps to a JSON-schema `enum`, which every structured-output provider supports. The "taxonomy once, not per item" rule in `lib/ai/categorize.ts` (AGENTS.md) still holds and is unaffected by the provider.

## 5. The persisted transcript (ADR-0008)

ADR-0008 keeps the OCR text so that a parse failure can be diagnosed from the app, and so the detail page can show what was read. A single call has no pass-1 output. The options:

| Option | Transcript on success | Transcript on failure | Extra cost | ADR impact |
| --- | --- | --- | --- | --- |
| A. Keep two-step (OCR call → parse call) | yes | yes (written early) | +30–38% (fractions of a cent) | none |
| B. Single call, drop the transcript | no (`transcript` column stays `NULL`) | no | none | ADR-0008 superseded; the detail-page disclosure loses its reader |
| **C. Single call, `transcript` as the first field of the model-facing schema** | yes | partial: `NoObjectGeneratedError.text` holds the raw response when JSON validation fails | ≈ +500 output tokens | ADR-0008 amended: the transcript is a field of the extraction, written in `storing` |

**Recommendation: C.** Extend the contract only on the model-facing side, `ReceiptInformationExtractionSchema.extend({ transcript: z.string() })` with `transcript` declared first, and strip it before `receiptToFlat` so the contract and the stored receipt fields are unchanged. Writing the verbatim text first may also help the model read before it structures, but that is a hypothesis for the accuracy test, not a finding. Under C:

- The "write the transcript before parsing" branch in `transcribe-receipt.ts` has nothing to write early. The first extraction and the re-process converge on writing it in `storing`, which removes one of the two trigger-dependent branches ADR-0011 lists.
- A failed run leaves no transcript unless the step stores `error.text` from a `NoObjectGeneratedError`. That is optional; with no separate parse pass, the failure is no longer "OCR right, parser wrong", so the diagnostic value is lower than in ADR-0008's original framing.
- Existing transcripts are untouched. Receipts are not re-extracted on the move (#240, ADR-0011).

## 6. Code seam

All files below are in the repo; nothing here has been changed.

- **`lib/ai/provider.ts`.** Today it holds LM Studio only. Add an OpenRouter registration for background work that mirrors `lib/chat/catalogue.ts`: `createOpenRouter({ apiKey, compatibility: "strict" })`, then `.chat(id, { provider: { zdr: true, require_parameters: true }, reasoning: { effort: "none" } })`. `strict` matters because only in strict mode does the adapter request usage (catalogue comment), and usage is what the accuracy test reads. The ids come from env (`EXTRACT_MODEL`, `CATEGORIZE_MODEL`), so the `ORC_MODEL`/`PARSE_MODEL` pair becomes one id. Whether `local` stays registered in development without a key (the catalogue's `offersLocal` rule) is a decision for the wiring ticket; this note does not make it.
- **`lib/ai/transcribe-receipt-image.ts`.** `transcribeReceiptImage` + `parseReceiptText` become one `extractReceipt(base64, mediaType, model)`. It sends a `file` part (the provider converts it to `image_url` with a data URL [sdk-or ~L3740]), a prompt that is `PARSE_PROMPT` reworded from "Given the raw OCR transcription" to "Given this receipt image", and `Output.object` over the extended schema. Drop `temperature: 0` unless the chosen model's ZDR endpoints list it (§2.4). If an OpenAI model is ever chosen, set `structuredOutputs: { strict: false }` or make the schema strict-compatible (§2.5).
- **`lib/inngest/functions/transcribe-receipt.ts`.** The `extracting` and `parsing` steps collapse into one. `store-transcript` goes. The `LM Studio is not reachable` messages and `isUnreachableError` (`lib/ai/errors.ts`) stop applying. The retry rule (`APICallError.isRetryable` → rethrow) already fits OpenRouter's 408/429/5xx. Concurrency (2 per user, 2 per account) was sized for one GPU and can be raised once the call is remote.
- **Realtime states.** `parsing` disappears from `lib/inngest/channels.ts` and its consumers (`components/receipts/receipt-status.tsx`, `receipt-toast-notifier.tsx`, `refresh-policy.ts`), or it stays as a label with nothing publishing it. Removing it is the AGENTS.md "no compatibility layers" answer.
- **Re-process picker (ADR-0011).** `extractionModelsSchema { ocr, parse }` (`lib/ai/models.ts`), `listAvailableModels()` (LM Studio `GET /v1/models`), `lib/inngest/events.ts`, `app/(app)/receipts/{schema,actions}.ts` and `components/receipts/reprocess-dialog.tsx` all assume an LM Studio pair. With OpenRouter, the honest list is a small curated catalogue, like chat's (ADR-0017), not the 478-model API. The pair becomes one `model`. That is an ADR-0011 amendment.
- **`lib/ai/categorize.ts`.** Only the default `model` argument (`lmstudio.chatModel(CATEGORIZE_MODEL)`) and the `temperature: 0` caveat change. The function is otherwise provider-agnostic.
- **ADRs to revise.** ADR-0017 ("extraction and categorization stay on LM Studio", and its batch note says the app has no offline work). ADR-0008 (option C). ADR-0011 (one model per re-process, and validation against a curated list instead of LM Studio's).

## 7. Proposed accuracy test (not run)

No paid calls were made and no real receipt was used. This is the test to run once the owner supplies images.

1. **Corpus.** 8–12 real receipts the owner picks, never committed: varied merchants, at least one long receipt (>25 lines), one with a discount and a card surcharge, one faded or creased thermal print, and one photo taken at an angle. Run each through the existing browser compression (≤2,000 px, JPEG q0.8) so the inputs match production.
2. **Golden.** For each receipt, the owner records merchant name, transaction datetime, total, GST, payment method, item count and every `lineTotal`. The current local pipeline's output, corrected by hand, is a fast starting point.
3. **Matrix.**
   - Single call (option C) on `gemini-3.1-flash-lite`, `claude-haiku-5.5` (without `temperature`) and `gemma-4-26b-a4b-it`.
   - Plus two-step on the winner, to check that the single call is not less accurate.
   - Plus categorization of the golden items on the extraction winner and `deepseek-v4.1-flash-1017`.
   - Three runs each, with `zdr: true`, `require_parameters: true` and `reasoning.effort: "none"`.
4. **Measure.**
   - Schema-valid rate.
   - Exact match on total, datetime and payment method.
   - Line-item F1, matching on `lineTotal` with a name similarity threshold.
   - The `reconcile()` integrity pass rate (`lib/receipt/integrity.ts`): the same check production uses.
   - Categorization agreement with the owner's labels.
   - Measured `usage.cost`, input and output tokens, latency, and `providerMetadata.openrouter` provider name, which shows which endpoint actually served it.
5. **Cost of the test.** At the per-call prices above, the whole matrix (≈12 receipts × 5 configurations × 3 runs ≈ 180 calls) is well under US$1.
6. **Where it lives.** A throwaway script beside `evals/chat/` with results in a gitignored file, mirroring `pnpm eval:chat`. It would not run in CI.

## 8. Recommendation (prices 2026-11-18)

| Role | Model | ZDR endpoint, $/1M in/out | ≈ $/1000 receipts |
| --- | --- | --- | --- |
| Extraction (single call, option C) | `google/gemini-3.1-flash-lite` | `google-vertex/global`, 0.25 / 1.50 (Safety Retention) | ≈ 2.4 incl. transcript field |
| Categorization | `google/gemini-3.1-flash-lite` | same | ≈ 0.5 |
| Challenger if Safety Retention is unacceptable or Gemini loses on accuracy | `anthropic/claude-haiku-5.5` (no `temperature`) | `google-vertex/global`, 0.10 / 0.50 (true ZDR) | ≈ 1.0 + 0.2 |
| Cheapest credible | `google/gemma-4-26b-a4b-it` | `deepinfra/fp8`, 0.07 / 0.34 | ≈ 0.6 + 0.1 |

Why Gemini 3.1 Flash Lite leads:

- It is GA and pinned to a dated canonical slug with no expiry.
- Google positions it for high-volume document work, and its image cost is bounded at 1,120 tokens [Gemini-media].
- Its ZDR endpoints support both `structured_outputs` and `temperature`, so the existing call shape routes unchanged under `require_parameters`.
- Its data-policy track (Vertex Safety Retention) is one ADR-0017 has already accepted.

Its weaknesses: it is the priciest of the shortlist, still about $0.003 per receipt all-in, and it is not strict ZDR. If the owner sets OpenRouter's Google privacy group to "ZDR only", it becomes unroutable and Haiku 5.5 takes its place.

**Pipeline.** Use one multimodal structured-output call per receipt with a transcript field, then the existing categorization call. Keep the two-step only if the accuracy test shows the single call losing on line items. Treat this as a recommendation pending §7; the wiring ticket under #240 should not fix the model ids before that test has run.
