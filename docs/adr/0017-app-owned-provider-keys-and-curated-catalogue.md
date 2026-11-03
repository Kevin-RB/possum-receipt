# ADR-0017: App-owned provider keys and a curated model catalogue

Date: 2026-11-04

## Status

Accepted

## Context

The chat runs on a local LM Studio model, which is slow and weak at tool calling. Production needs a better model, and the app has to offer more than one: a reader should be able to pick a model, and the owner should be able to add a provider without touching the chat route.

BYOK was considered and dropped. It buys users their own provider key, but it also buys key transport, key storage, per-user isolation, a connect/test/forget flow, and disclosure copy — a large surface for an invite-gated app where the owner is willing to pay. The scope is chat only, so no background job needs a user key either.

The paid-key constraint is not optional. Gemini's free tier uses prompts to improve Google's products and says not to submit personal information; receipt text is personal information. OpenRouter's free models are 50 requests/day **per account**, not per key, so a shared app key would exhaust them. Either way the app-owned key is a paid key.

The AI SDK already provides the adapter. `@ai-sdk/google` and `@openrouter/ai-sdk-provider` both implement `ProviderV4` and expose `languageModel(id)`; LM Studio is already a `createOpenAICompatible` provider. `createProviderRegistry` resolves `provider:model` strings to a `LanguageModel`, which is exactly the seam `ToolLoopAgent` needs.

## Decision

**The app owns one credential per provider, and the catalogue is the only source of model choices.**

- **Keys come from the deployment environment.** `GOOGLE_GENERATIVE_AI_API_KEY` and `OPENROUTER_API_KEY` are read on the server. A provider whose key is absent is not registered, and its models do not appear in the picker. No key is collected from a browser, sent in a request, stored in Postgres, or written to a log.
- **The client sends only `{ provider, model }`.** Both are validated against the catalogue before any provider is constructed. A client-supplied base URL is refused: it is an SSRF path into the compose network.
- **The registry is a module-level singleton.** With one app key per provider there is no per-user credential to isolate, so building it once at module load is safe and simpler than per-request construction. `createChatAgent` takes the resolved `LanguageModel` instead of reading `CHAT_MODEL`.
- **Providers are native where one exists.** Google uses `@ai-sdk/google`; OpenRouter uses `@openrouter/ai-sdk-provider`, whose typed `provider.zdr` and `provider.require_parameters` avoid the generic compatible provider's `providerOptions` passthrough. LM Studio keeps `@ai-sdk/openai-compatible`.
- **Every catalogue entry must support tool calling.** `tools` is the one required capability; a model without it would answer without querying the receipts, which is the worst failure this chat can have. `vision` and `structuredOutput` are not needed here.
- **OpenRouter requests set `require_parameters: true` and `zdr: true`.** Without `require_parameters`, OpenRouter can route to an endpoint that does not support tools and silently ignore them. ZDR is a preference, not a hard promise: it is enforced per endpoint where offered, but Gemini paid has no ZDR commitment (no training, DPA).
- **A failed credential is an operator problem, not a reader problem.** A 401 or 402 is logged and collapsed to the existing "assistant unavailable" wording; the reader cannot fix the key. A 429 is shared by every reader and reads as "busy, try again".

## Considered options

1. **BYOK, ephemeral or persisted.** Rejected. It adds a credential transport, a storage or encryption decision, a per-user isolation requirement, and a connect flow, for a feature the owner does not need yet.
2. **A single app-wide model, no picker.** Simplest, but it loses the ability to trade cost against quality, and it makes adding a provider a code change rather than a catalogue entry.
3. **A registry built per request.** Unnecessary once keys are app-owned; it exists only to isolate per-user credentials. Keep the seam (`selection → LanguageModel`) so a future BYOK effort can add a credential argument without changing the picker or the catalogue.
4. **The generic OpenAI-compatible provider for OpenRouter.** Works for tools and streaming, but needs an undocumented `providerOptions` passthrough for routing flags. The native provider makes `zdr` and `require_parameters` typed.

## Consequences

- The owner pays for every reader. The invite gate and a curated, cheap default are the first cost controls; a per-user or monthly ceiling remains a policy question.
- All readers' receipt text goes to the provider the owner configures. The owner owns that data-policy choice for every user; there is no per-user provider selection.
- A bad or rate-limited app key affects everyone. The error vocabulary separates what the reader can act on from what only the operator can.
- Adding a provider is a catalogue entry plus an env key; the route, the picker and the agent do not change.
- The model picker is UI-only: it selects a catalogue entry and never touches a credential.
- The app-owned key must be a paid key. The free tiers either train on prompts (Gemini) or cap at 50 requests/day per account (OpenRouter).

## Related

- ADR-0014 (one error vocabulary) — 401/402 become operator alerts; 429 stays reader-facing.
- ADR-0011 (re-processing chooses models per run) — unchanged; extraction stays on LM Studio.
- Issue #212 — the decision ticket.
- Issue #204 (OpenRouter research), issue #211 (Gemini research).
