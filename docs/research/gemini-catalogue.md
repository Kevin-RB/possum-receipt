# Gemini — tool-calling models, free tier, native SDK

**Checked 2026-11-03.** Every claim below is from a primary source fetched that day; URLs in
[Sources](#sources). Model ids and quotas move, so re-check before relying on this.

Scope: what the Gemini Developer API offers this chat *today* — tool calling and streaming, no
vision, no structured output. Cost matters, because the app currently runs a local model for free.

## Verdict

- The free tier is real and includes strong tool-calling models (`gemini-3.8-flash`,
  `gemini-3.6-flash`, `gemini-3.5-flash-lite`), but **free-tier prompts train Google's products**
  and are read by human reviewers. For receipt images and merchant/spend data that is a hard no.
- Paid tier is the honest comparison, and it is cheap at this app's volume: `gemini-3.5-flash-lite`
  is $0.30 / $2.50 per 1M input/output tokens; `gemini-3.8-flash` is $0.75 / $3.75.
- `@ai-sdk/google@4.0.111` is the matching provider for `ai@7`, exposes `languageModel(id)`, and
  drops straight into `createProviderRegistry`.
- Google's default API surface is now the **Interactions API** (`POST /v1beta/interactions`);
  `generateContent` is explicitly "legacy" but still fully supported. The AI SDK exposes both as
  separate factories.

## Shortlist

All of these report function calling and structured outputs as supported on their model pages, and
all are listed with tool usage in the AI SDK capability table.

| Model id | Context (in / out) | Tools | Tier | Notes |
|---|---|---|---|---|
| `gemini-3.8-flash` | 1,048,576 / 65,536 | yes | **free + paid** | Best default. "Most intelligent Flash model". Free tier $0; paid $0.75 / $3.75 per 1M (through 2026-12-31, then $1.50 / $7.50). Thinking: low/medium/high (`minimal` errors). |
| `gemini-3.6-flash` | 1,048,576 / 65,536 | yes | **free + paid** | Previous-gen Flash. Same price as 3.8 Flash. Free tier does **not** include search grounding. |
| `gemini-3.5-flash-lite` | 1,048,576 / 65,536 | yes | **free + paid** | Cheapest sensible paid option: $0.30 / $2.50. Also the automatic landing spot for `gemini-2.5-flash` from 2026-12-01. |
| `gemini-3.1-flash-lite` | 65,536 / 4,096 | yes | **free + paid** | Cheapest ($0.25 / $1.50) but small context and 4K output — tight for a multi-tool chat turn. |
| `gemini-3-flash-preview` | 1,048,576 / 65,536 | yes | **free + paid** | Labelled "legacy Flash"; preview, so more restrictive limits and shorter deprecation notice. |
| `gemini-4-argon` | 1M / 65K (1M with long decode) | yes | **paid only** | Flagship reasoning. "Not available on the Free tier." $2 / $10 through 2026-11-30, then $4 / $20. Overkill for this chat. |
| `gemini-3.1-pro-preview` | — | yes | **paid only** | $2 / $12 (≤200K prompt). No free tier. |

Deliberately excluded: image/TTS/Live/embedding models (no tool calling, or wrong modality).
`gemini-2.5-flash` and `gemini-2.5-pro` are deprecated and, from **2026-12-01**, all API requests
are rerouted to `gemini-3.5-flash-lite` and `gemini-3.8-flash` respectively — do not target them.

## Free-tier limits (RPM / RPD / TPM)

**Google no longer publishes per-model free-tier numbers in the docs.** The rate-limits page states
the three dimensions (RPM, input TPM, RPD), that limits are **per project, not per API key**, and
that RPD resets at midnight Pacific — then sends you to AI Studio for the actual values:

> "Rate limits depend on a variety of factors (such as your usage tier) and can be viewed in Google
> AI Studio. As your tier and account status change over time, your rate limits will automatically
> update."
>
> — <https://ai.google.dev/gemini-api/docs/rate-limits>

So the only authoritative numbers for a given project are at
<https://aistudio.google.com/rate-limit>. What *is* published:

| Limit | Free | Tier 1 | Tier 2 | Tier 3 |
|---|---|---|---|---|
| Spend rate limit (per rolling 10 min) | N/A | $10 | $200 | $200 |
| Grounding with Google Search (Gemini 3+) | not available on Flash free tier | 1,500 RPD default cap | same | same |

Notes that do not depend on the missing table:

- Free tier has "limited access to certain models" — `gemini-4-argon` and `gemini-3.1-pro-preview`
  are paid-only.
- Preview/experimental models have more restrictive limits than stable ones.
- Built-in tools carry their own limits (e.g. search grounding: 1,500 RPD/project on the Developer
  API across all paid tiers).
- A 429 is `RESOURCE_EXHAUSTED`; spend-based limits only apply above Free.

**Practical read:** the missing table is the answer — treat free-tier throughput as unknown until
measured in AI Studio for the project in question. Do not design around a remembered "15 RPM".

## Data use: free vs paid

This is the decisive section for a receipts app.

| | Free tier ("Unpaid Services") | Paid tier ("Paid Services") |
|---|---|---|
| Used to improve Google products | **Yes** | **No** |
| Human review of prompts/responses | **Yes**, reviewers may read, annotate, process | No |
| Governing data terms | Gemini API Additional Terms, "Unpaid Services" | DPA for products where Google is a data processor |
| Retention | Not bounded by the training exemption; do not submit sensitive data | Logged for a limited period solely for Prohibited Use Policy enforcement and legal/regulatory disclosure |

Verbatim, free tier:

> "Google uses the content you submit to the Services and any generated responses to provide,
> improve, and develop Google products and services and machine learning technologies… human
> reviewers may read, annotate, and process your API input and output… **Do not submit sensitive,
> confidential, or personal information to the Unpaid Services.**"
>
> — <https://ai.google.dev/gemini-api/docs/terms#data-use-unpaid>

Paid tier:

> "Google doesn't use your prompts … or responses to improve our products, and will process your
> prompts and responses in accordance with the Data Processing Addendum… Google logs prompts and
> responses for a limited period of time, solely for detecting and preventing violations of the
> Prohibited Use Policy."
>
> — <https://ai.google.dev/gemini-api/docs/terms#data-use-paid>

Two further constraints that matter for a deployed app:

1. **EEA / Switzerland / UK:** "You may use only Paid Services when making API Clients available to
   users in the European Economic Area, Switzerland, or the United Kingdom." Free tier is not
   permitted there, full stop. For those regions the free-tier terms are replaced by the paid data
   terms even for AI Studio usage.
2. **Logging is on by default** for Interactions API calls, and for `generateContent` calls in
   projects created on or after 2026-10-26. Those logs are private to the project, retained 55 days
   by default (configurable 7/14/28/55), and are **not** used for product improvement unless you
   explicitly contribute a dataset — at which point the Unpaid Services terms apply to it.
   <https://ai.google.dev/gemini-api/docs/logs-policy>

## Native SDK: `@ai-sdk/google`

Current package, from the npm registry on 2026-11-03: **`@ai-sdk/google@4.0.111`** (`latest` tag).
Engines `node >= 22`; depends on `@ai-sdk/provider@4.0.35` and `@ai-sdk/provider-utils@5.0.74`;
peer `zod ^3.25.76 || ^4.1.8`. This repo runs `ai@7.0.156` (which depends on
`@ai-sdk/provider@4.0.34`), Node 26, and `zod ^4.6.7` — same provider major, so it matches.

<https://registry.npmjs.org/@ai-sdk/google>

```ts
import { createGoogle } from "@ai-sdk/google";

const google = createGoogle({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY, // default env var; sent as x-goog-api-key
  // baseURL defaults to https://generativelanguage.googleapis.com/v1beta
});

const model = google("gemini-3.8-flash");
```

- **`createGoogleGenerativeAI` still exists** — not as a separate function, but as an alias:
  `export { createGoogle as createGoogleGenerativeAI }` in `dist/index.d.ts`. Use `createGoogle`;
  the alias is the older name.
- `GoogleProvider extends ProviderV4`, is callable as `google(id)`, and has
  **`languageModel(modelId)`** plus `chat()`, `embedding()`, `image()`, `video()`,
  `experimental_batch()`, and `interactions()`.
- **Registry-compatible:** `createProviderRegistry(providers: Record<string, ProviderV4 | ProviderV3>)`.
  `GoogleProvider` is a `ProviderV4`, so `createProviderRegistry({ google })` works with no adapter,
  and `registry.languageModel("google:gemini-3.8-flash")` resolves. The provider's display name
  defaults to `google.generative-ai`; the registry key is whatever you name it in the record.
- **Two endpoints, two factories.** `google(id)` targets `:generateContent` /
  `:streamGenerateContent`. `google.interactions(id)` targets the new `POST /v1beta/interactions`.
  The docs are explicit: "Pick one per model instance — they target different request bodies and SSE
  event vocabularies." Do not assume a model instance can switch.
- Google's own docs now describe `generateContent` as legacy: "The Interactions API has become our
  default interface as of June 2026… While it remains supported, the `generateContent` API is now
  considered legacy." Either path works today; the AI SDK abstracts both.

## Tool calls and structured output vs the OpenAI-compatible path

Short answer: for this chat's needs (tool calling + streaming) the two are equivalent **in what they
can express**, but the native path is the one that gets Gemini-specific behaviour and the
OpenAI-compatible layer is a translation shim that silently drops what it does not understand.

| | Native (`@ai-sdk/google`) | OpenAI-compatible (`/v1beta/openai/`) |
|---|---|---|
| Tool calling | Yes. Gemini's own function-calling: parallel and compositional calls, tool result returned as a `function_result` step | Yes, `tools` + `tool_choice` supported |
| Streaming | Yes, both endpoints | Yes |
| Structured output | Yes — `response_format` with JSON Schema; AI SDK sends the schema and defaults `structuredOutputs: true` | Yes, `response_format` / `zodResponseFormat` |
| Thought signatures (Gemini 3+) | Handled by the provider | Supported, per the compatibility page |
| Gemini-only knobs (thinking level, cached content, safety settings) | Typed `providerOptions.google` | Must go through `extra_body` |
| Unsupported params | Type error | **Silently ignored** — "Any other parameters not listed here … will be silently ignored by the compatibility layer" |
| New features | Land here first (Interactions API, long decode, provider tools) | Beta; "Support … is still in beta while we extend feature support" |

Things worth knowing before wiring it up:

- **Structured output + tools together is a preview and Gemini 3 only.** Not a problem here — the
  chat needs tools, not `Output.object`.
- **Tool schemas are a JSON Schema subset.** Deeply nested or very large schemas can be rejected
  with a bare `Request contains an invalid argument`. The AI SDK's escape hatch is
  `providerOptions.google.structuredOutputs: false`, which stops sending the schema. Irrelevant for
  the five flat read-only chat tools.
- **Tool streaming is listed as supported** for every shortlisted model in the AI SDK capability
  table, which is what the existing `agent-steps.tsx` renderers depend on.
- **Prompt caching** (implicit) needs 4,096-token prefixes on Gemini 3 — the system prompt plus
  taxonomy is well under that, so expect no cache benefit.
- **Thinking tokens are billed as output.** If a model is switched to a thinking level, cost moves
  even when the visible answer is short.

## ZDR / paid-tier data processing

There is **no "zero data retention" commitment** in the Gemini API Additional Terms. What the paid
tier actually gives you:

- No training on prompts or responses, under the DPA.
- Prompt/response logs retained for a limited period **solely** for abuse/PUP enforcement and
  required legal or regulatory disclosure; may be stored transiently or cached in any country where
  Google or its agents maintain facilities.
- `store: false` on the Interactions API gives stateless requests (the AI SDK calls this the Zero
  Data Retention mode: continuation state travels encrypted inside the token rather than
  server-side). That is a request-level control, not a contractual retention guarantee.
- **Grounding with Google Search is a special case**: prompts, context and output are stored for
  **30 days** for producing grounded results and for debugging/testing, even on paid quota. If
  receipts ever get search grounding, that term applies.
- Logs (the developer-facing, project-private kind) are separate from abuse-monitoring retention and
  default to 55 days.

If a contractual ZDR is ever required, that is a Vertex AI / enterprise-agreement conversation, not
a Gemini Developer API toggle.

## What this means for this chat

1. **Free tier is out** on data grounds, not throughput: receipt images, merchant names and spend
   history are exactly the "personal/confidential" content the Unpaid terms forbid, and reviewers
   may read it. The EEA/CH/UK restriction compounds it.
2. **Paid tier at this volume is pennies.** A tool-heavy chat turn is maybe 3–8K input and a few
   hundred output tokens. At `gemini-3.5-flash-lite` ($0.30 / $2.50 per 1M) that is a fraction of a
   cent per turn; at `gemini-3.8-flash` still under a cent.
3. **Start on `gemini-3.8-flash`**, fall back to `gemini-3.5-flash-lite` if cost or latency matters.
   Avoid preview ids for a production path; `gemini-4-argon` buys nothing this chat needs.
4. **Use `@ai-sdk/google` native, not the OpenAI-compatible endpoint.** Same `ai@7` tool loop either
   way, but native keeps thought signatures, typed provider options, and does not silently discard
   parameters.
5. **Provider shim is small**: one `createGoogle({ apiKey })`, one `google("gemini-3.8-flash")`, and
   the `ToolLoopAgent` and tool set are unchanged — `buildChatTools(ownerId)` and the output schemas
   are provider-agnostic.
6. **Open question for the map, not this ticket:** whether the chat should keep LM Studio as the
   default and treat Gemini as an opt-in provider, or move to Gemini and drop the local path. That
   decision needs the cost/latency numbers from a real eval run, not more docs.

## Sources

Checked 2026-11-03.

- Models catalogue — <https://ai.google.dev/gemini-api/docs/models>
- `gemini-3.8-flash` model card (context, capabilities badges) — <https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash>
- Pricing, incl. free-tier column and per-model "used to improve our products" —
  <https://ai.google.dev/gemini-api/docs/pricing>
- Rate limits (tiers, spend limits, per-project semantics) — <https://ai.google.dev/gemini-api/docs/rate-limits>
- Live per-project quotas — <https://aistudio.google.com/rate-limit>
- Function calling — <https://ai.google.dev/gemini-api/docs/function-calling>
- Structured outputs — <https://ai.google.dev/gemini-api/docs/structured-output>
- Gemini API Additional Terms (free vs paid data use, EEA/CH/UK, grounding retention) —
  <https://ai.google.dev/gemini-api/docs/terms>
- Data logging and sharing — <https://ai.google.dev/gemini-api/docs/logs-policy>
- OpenAI compatibility layer — <https://ai.google.dev/gemini-api/docs/openai>
- AI SDK Google provider (setup, factories, capability table, Interactions API) —
  <https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai>
- npm package metadata, `@ai-sdk/google@4.0.111` — <https://registry.npmjs.org/@ai-sdk/google>
- Package surface (`languageModel`, `createGoogle as createGoogleGenerativeAI`, `interactions`) —
  inspected from the published `google-4.0.111.tgz` `dist/index.d.ts`
- Registry contract — `createProviderRegistry<PROVIDERS extends Record<string, ProviderV4 | ProviderV3>>`
  in the installed `ai@7.0.156` `dist/index.d.ts`
