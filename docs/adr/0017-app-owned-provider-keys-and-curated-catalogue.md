# ADR-0017: App-owned provider keys and a curated model catalogue

Date: 2026-11-04 Revised: 2026-11-08

## Status

Accepted. Revised 2026-11-05: the catalogue is OpenRouter-only; the native Google provider was dropped. Revised 2026-11-08: one remote entry, and a dated revision is accepted where the undated alias lags it.

## Context

The chat runs on a local LM Studio model, which is slow and weak at tool calling. Production needs a better model, and the app has to offer more than one: a reader should be able to pick a model, and the owner should be able to add a model without touching the chat route.

BYOK was considered and dropped. It buys users their own provider key, but it also buys key transport, key storage, per-user isolation, a connect/test/forget flow, and disclosure copy — a large surface for an invite-gated app where the owner is willing to pay. The scope is chat only, so no background job needs a user key either.

The paid-key constraint is not optional. Gemini's free tier uses prompts to improve Google's products and says not to submit personal information; receipt text is personal information. OpenRouter's free models are 50 requests/day **per account**, not per key, so a shared app key would exhaust them. Either way the app-owned key is a paid key.

The AI SDK already provides the adapter. `@openrouter/ai-sdk-provider` implements `ProviderV4` and exposes `languageModel(id)`; LM Studio is already a `createOpenAICompatible` provider. `createProviderRegistry` resolves `provider:model` strings to a `LanguageModel`, which is exactly the seam `ToolLoopAgent` needs.

**Revision, 2026-11-05.** The first version offered two remote providers, Google natively and OpenRouter. The launch-catalogue decision (issue #209) collapsed it to one. Two providers meant two credentials to provision and rotate, two bills and two data-policy tracks, for no cost benefit: OpenRouter serves the same Gemini ids at parity with the Developer API list, or 10% above it for `gemini-3.8-flash`, and its ZDR-eligible Gemini endpoints are Google's own Safety Retention endpoints, so routing Gemini through OpenRouter strengthens nothing either. One remote provider also makes the ZDR gate universal, since `zdr: true` is sent unconditionally: every remote entry must have an endpoint that supports both ZDR and tools, or its requests fail rather than degrade.

## Decision

**The app owns one credential, and the catalogue is the only source of model choices.**

- **Keys come from the deployment environment.** `OPENROUTER_API_KEY` is read on the server; LM Studio takes a base URL, not a key. A provider whose key is absent is not registered, and its models do not appear in the picker. No key is collected from a browser, sent in a request, stored in Postgres, or written to a log.
- **The client sends only `{ provider, model }`.** Both are validated against the catalogue before any provider is constructed. A client-supplied base URL is refused: it is an SSRF path into the compose network.
- **The registry is a module-level singleton.** With one app credential there is no per-user credential to isolate, so building it once at module load is safe and simpler than per-request construction. It holds whichever of `openrouter` and `local` the environment registers — exactly one, per the absence rule below. `createChatAgent` takes the resolved `LanguageModel` instead of reading `CHAT_MODEL`.
- **One remote provider, with its own adapter.** OpenRouter uses `@openrouter/ai-sdk-provider`, whose typed `provider.zdr` and `provider.require_parameters` avoid the generic compatible provider's `providerOptions` passthrough. LM Studio keeps `@ai-sdk/openai-compatible`.
- **Every catalogue entry must support tool calling.** `tools` is the one required capability; a model without it would answer without querying the receipts, which is the worst failure this chat can have. `vision` and `structuredOutput` are not needed here, and there is no per-entry provider options payload: the launch catalogue sends provider defaults (no thinking level, no reasoning exclusion) and gains that field only if a model demands it.
- **The capability contract has two gates and three recorded facts.** `tools`, and — for every remote entry — at least one endpoint supporting both ZDR and tools, because the routing flag below is unconditional. Context window, maximum output and pricing are recorded, not gated: the curated list is already small. Pricing is a dated snapshot for cost review, never shown in the picker.
- **Curation keeps the list cheap and reliable.** Ids are stable and undated — no previews, no `:free`, no routers, no dated revisions — and every entry scores at least 70% on OpenRouter's τ²-Bench Airline, the only public comparative signal for tool driving. The floor is a curation note, not a field the app reads.
- **A dated revision is the exception, and only when the undated alias lags it** (2026-11-08). `deepseek/deepseek-v4.1-flash` is pinned to the 2026-09-10 revision at $0.051/$0.567 per 1M tokens; `deepseek/deepseek-v4.1-flash-1017` is the same family's 2026-10-17 revision at $0.006/$0.500, 8.5× cheaper on input. An alias that tracks the current revision is still preferred, because a dated id can be retired where the alias cannot; when one does not, the dated id is accepted for a family already on the list, and the ids are re-read with the prices at every promotion (#227) so a retirement is caught before a reader meets it.
- **A `:batch` variant is never a chat entry** (checked 2026-11-08). `deepseek/deepseek-v4.1-flash-1017:batch` is the same weights at $0.011/$0.200 per 1M — 40% cheaper per question at our token mix, because output is the expensive side — but OpenRouter's batch API is a job: you submit, poll or take a webhook, and read results, inside a 24-hour window. `stream: true` is rejected outright, `provider.zdr` and the other sync preferences are not part of it, the variant has one endpoint rather than the fifty-one the sync model has, and none of the batch endpoints appear in the ZDR list. The chat agent streams through a tool loop, so a batch model cannot serve it; batch is for offline work, of which the app has none today — extraction and categorization stay on LM Studio.
- **The default is the cheapest entry that resolves.** The catalogue is ordered by price ascending, and the default is its first entry whose provider is configured. A deployment without an OpenRouter key falls to `local`; reordering the list is how the default moves.
- **A provider with no key is absent, not disabled.** The picker shows only what a reader can pick. `local` is registered and listed only when no remote key resolves, which also makes an empty catalogue unreachable. A selection that no longer resolves — a retired id, a removed key, a stale client — is refused before any provider call and answered with the existing "That model is not available" wording.
- **The picker is a flat list when one group resolves.** One dropdown grouped by provider, the group header appearing only when two or more groups are present, so a one-provider deployment has no redundant heading. The selection is per conversation and client-side only: switching mid-thread is allowed and the whole history goes to the new model, nothing is persisted, and every page load starts on the default.
- **OpenRouter requests set `require_parameters: true` and `zdr: true`.** Without `require_parameters`, OpenRouter can route to an endpoint that does not support tools and silently ignore them. ZDR is a preference, not a hard promise: it is enforced per endpoint, and several providers are absent from that list entirely.
- **A failed credential is an operator problem, not a reader problem.** A 401 or 402 is logged and collapsed to the existing "assistant unavailable" wording; the reader cannot fix the key. A 429 is shared by every reader and reads as "busy, try again".

## Considered options

1. **BYOK, ephemeral or persisted.** Rejected. It adds a credential transport, a storage or encryption decision, a per-user isolation requirement, and a connect flow, for a feature the owner does not need yet.
2. **A single app-wide model, no picker.** Simplest, but it loses the ability to trade cost against quality, and it makes adding a provider a code change rather than a catalogue entry.
3. **A registry built per request.** Unnecessary once keys are app-owned; it exists only to isolate per-user credentials. Keep the seam (`selection → LanguageModel`) so a future BYOK effort can add a credential argument without changing the picker or the catalogue.
4. **The generic OpenAI-compatible provider for OpenRouter.** Works for tools and streaming, but needs an undocumented `providerOptions` passthrough for routing flags. The native provider makes `zdr` and `require_parameters` typed.
5. **Two remote providers, Google native plus OpenRouter.** The first version of this decision. Rejected on 2026-11-05: a second credential to provision and rotate, a second bill, and a second data-policy track, for no price benefit. OpenRouter carries the same Google ids at parity with the Developer API list (10% above it for `gemini-3.8-flash`), and its ZDR-eligible Gemini endpoints are Google's own Safety Retention endpoints, so the extra route does not strengthen Gemini's retention posture either.

## Consequences

- The owner pays for every reader. At the 2026-11-08 default a model call costs about 0.03¢ (8k input, 600 output tokens) and 0.11¢ on the dearest entry; a question takes two or three calls. The invite gate and this curated list are the cost controls; a per-user or monthly ceiling remains a policy question.
- All readers' receipt text goes to one company, under the policy the owner accepts. There is no per-user provider selection and no second route around it.
- One credential is also one point of failure: a bad or rate-limited key affects everyone, and there is no second provider to fall back to. Redundancy inside OpenRouter is per model — the default has 44 ZDR-eligible tool-capable endpoints — not a second integration. The error vocabulary separates what the reader can act on from what only the operator can.
- Adding a _model_ is a catalogue entry; adding a _provider_ is a package, a registry key and an environment variable. The catalogue makes the first free and the second a code change.
- The model picker is UI-only: it selects a catalogue entry and never touches a credential.
- The app-owned key must be a paid key. The free models are a 50-requests-per-day allowance per account, shared by every reader.
- Ids and prices are a snapshot and must be re-read before the catalogue is written into code, then again before each promotion. Movement is real in both directions: `z-ai/glm-5.3-flash` went from $0.029/$0.092 to $0.15/$0.50 per 1M tokens in two days, and by 2026-11-08 had fallen to $0.0335/$0.083.
- The 2026-11-08 default is cheaper but chattier: on an empty product search it may run a synonym search before answering. That is a cost, and `pnpm eval:chat` reports it as an extra step rather than folding it into the pass rate — a score that fell while every answer stayed right would be measuring the wrong thing. What the suite fails it on is real: a lookup with the wrong range, and an amount no tool returned (both observed while re-pricing, and both already answerable from the rendered table if they had not been stated).
- **One remote model as of 2026-11-08**, plus `local` as the no-key fallback: `deepseek/deepseek-v4.1-flash-1017`. The price tail went first — `qwen/qwen3.8-27b` and `google/gemini-3.5-flash-lite` at $1.875 and $2.50 per 1M output — and the smaller open-weight models that survived it (`z-ai/glm-5.3-flash`, `openai/gpt-oss-20b`, `qwen/qwen3.6-35b-a3b`) were tried against `pnpm eval:chat` and lost on the failures a reader would notice: the wrong breakdown level, a tool name the app does not have, and asking for a period the reader had already given. A menu of near-equivalents is not worth a per-answer quality lottery, so the owner chose one model.

## Related

- ADR-0014 (one error vocabulary) — 401/402 become operator alerts; 429 stays reader-facing.
- ADR-0011 (re-processing chooses models per run) — unchanged; extraction stays on LM Studio.
- Issue #202 — the wayfinder map; issue #209 — the launch catalogue and capability contract.
- Issue #203 (the picker prototype) and issue #208 (error vocabulary for remote providers).
- Issue #212 — the resolver and credential path; issue #204 (OpenRouter research), issue #211 (Gemini research).
