# ADR-0014: One error vocabulary, causes kept in the server log

Date: 2026-10-29 Revised: 2026-11-05

## Status

Accepted. Revised 2026-11-05: remote-provider classification, a second chat failure sentence, and log redaction at the chat boundary.

## Context

Error handling had grown one shape per boundary. Server actions returned ad-hoc strings (`"Failed to delete receipt"`, `"Validation failed"`, `"Receipt is not ready to re-process"`), but their `catch` blocks discarded the error, so the server log held no record of why anything failed. Route handlers answered `{ error: "Unauthorized" }`. The chat route returned the same generic sentence from `onError` that the client also printed, so a failed turn read "Something went wrong. Please try again. (Something went wrong. Please try again.)" while the real cause — an `AI_RetryError` wrapping an `APICallError` "Cannot connect to API: …" — was dropped on the floor. The app is local-first against one LM Studio instance, so "the provider is down" is a routine failure, not an edge case, and it was the failure the UI described worst.

The obvious alternative — a custom `Error` subclass carrying a user-facing message, caught by an error boundary — does not work in this framework. Next redacts errors thrown on the server in production: a Server Component's error reaches `error.tsx` with a generic `message` and the cause only as `error.digest`, which is a key into the server log, not text. Only client-thrown errors keep their message. That is deliberate (it keeps credentials, URLs and query fragments out of the browser) and the Next guide says so explicitly: expected errors should be **returned**, not thrown.

**Revision, 2026-11-05.** The chat moved from one local LM Studio instance to a remote provider on an app-owned key (ADR-0017), which changed what can fail and who can fix it. A rate limit, an exhausted balance, a bad key and a blocked account are all reachable now, and only the first is worth the reader retrying. Two facts from the AI SDK shaped the response: a provider failure that happens _after_ the first token arrives as `StreamProviderError` (HTTP 200 on the wire, status carried in the payload), and every provider error carries `requestBodyValues` — the whole request body, conversation and tool results included — so logging the error object puts receipt data in the server log. See issue #208.

## Decision

**One vocabulary.** `lib/errors.ts` exports `USER_ERROR`, a catalogue of codes → wording. These strings are the only text the UI may show. Adding a failure means adding a code, not inventing a sentence at the call site.

**Expected failures are returned.** A server action returns `{ error, success: false }`; a route returns `{ error }` with a status; the chat route returns catalogue text from `onError`. Nothing in this class of failure is thrown across a boundary, which is also what keeps the wording intact in production.

**Causes are logged on the server, exactly once.** `reportError(scope, error)` is the one logging convention (`[receipts.delete]`, `[chat]`). It is called by the boundary that failed, immediately before returning catalogue text. A `catch` that returns a message without calling it loses the only copy of the cause.

**Classifiers map a cause to a code, per domain.** `lib/chat/errors.ts` is the only code that knows the AI SDK's error types: it unwraps `RetryError` (default `maxRetries` is 2, so the `APICallError` is never the top-level error in what the route sees) and distinguishes an unreachable model from everything else. Boundaries call the classifier and index the catalogue; they do not inspect provider errors themselves.

**Text that crossed a boundary the app does not own is verified.** `isUserMessage` accepts only catalogue wording. The chat client uses it on `error.message`, and the upload form on a failed response body. Anything else becomes `USER_ERROR.generic`, so a JSON body, an HTML error page or a provider message cannot be displayed.

**No custom `Error` hierarchy.** It would route a category inside the process, which the boundary that catches the failure can decide on its own, and it cannot carry user-facing text to a Server Component boundary in production. The catalogue plus a per-domain classifier covers every case here without a class per failure.

**Unexpected exceptions stay exceptions.** They are bugs: they reach `app/error.tsx`, which shows a generic page, offers a retry, and logs to the browser console. The server log holds the thrown stack and `error.digest` ties the two together.

**Remote provider failures classify on status alone.** `lib/chat/errors.ts` accepts `APICallError` **and** `StreamProviderError`, unwraps `RetryError`, and maps `statusCode` to one of three chat codes. It imports no provider package and reads no provider metadata, so a second provider only needs a status map, not a new classifier.

| Cause | Code | Reader sees |
| --- | --- | --- |
| 408 timeout, 429 rate limited, 502 model down, 503 no endpoint meets the routing policy | `busy` | "The assistant is busy right now. Please try again in a moment." |
| 401 bad key, 402 out of credits or in-flight budget, 403 forbidden, 200 carrying an error, or any provider error with no status | `modelUnavailable` | the existing "isn't responding right now" line |
| 400 malformed request, and anything that is not a provider error | `generic` | the existing generic line |

**Only a failure the reader can act on gets its own sentence.** `busy` exists because waiting is an instruction. A bad key or an empty balance is an operator failure delivered to whoever is looking at the screen, so it keeps the line an outage already uses; the distinction lives in the log, where the operator can act on it. Telling an invited reader that the owner's credits ran out would expose the system and help nobody.

**The reader never learns which 402 it was.** Out-of-credits and in-flight-budget both arrive as 402 and both map to `modelUnavailable`; splitting them would mean reading OpenRouter's `metadata.limit_source` at the boundary. That field goes into the log instead, which is the only place the difference changes what someone does.

**Provider failures are never retried mid-stream.** `maxRetries` keeps its default of 2 and applies before the stream starts, honouring `Retry-After` (0–60s). `streamRetries` stays off: a retried step appends to prose the reader has already seen, because streamed text cannot be retracted. A 402 is not retried by the SDK and is not retried by us; the reader's resubmit is the retry.

**Chat causes are summarised, not logged whole.** The chat boundary logs `{ scope, provider, model, status, code, type, attempts, providerName, limitSource, message }` with the message trimmed, and never the error object. `attempts` is the retry wrapper's attempt count, and `providerName` / `limitSource` come from the provider metadata only when present. `requestBodyValues` holds the conversation and `responseBody` can quote flagged input; neither belongs in a log line that is shipped to a log collector. Other boundaries may keep logging the raw error until they carry the same payload.

The summary is the audit trail: status and code say _what kind_ of failure, `type` and `providerName` say _which upstream endpoint_ produced it, `limitSource` separates an exhausted balance from an in-flight one, and `attempts` says whether the SDK's own retries ran out. That is enough to answer "why did this request not go through" from the Coolify log without a second, unredacted copy of the conversation sitting next to it.

## Consequences

- Wording changes are one line in one file, and every screen shows it.
- Every user-visible failure is a catalogue string or the generic one; provider URLs, status lines, model ids and stack traces cannot reach the browser through the app's own boundaries.
- Causes live only in the server log. A client-side render failure still reaches only the browser console and the `digest` — there is no error-reporting endpoint, and building one is telemetry work, not error handling.
- The root layout has no `global-error.tsx`, so a failure in `app/layout.tsx` itself falls through to the framework's page. The layout is static (fonts, theme provider, toaster), so the gap is real but narrow.
- Server action and route response shapes are unchanged, so callers and existing tests keep working.
- The catalogue is flat, not namespaced, because with one product area and under twenty codes a tree would be structure without a second consumer. If it grows past that, the split is by domain (`USER_ERROR.receipts.*`), not by layer.
- A `catch` can still forget to call `reportError`; nothing enforces it. Reviewing a `catch` for that call is the guard, in the same spirit as the `never` branch in `agent-steps.tsx`.
- The chat's failure taxonomy is invisible from the browser: three sentences, one of which is new, and every cause that distinguishes them stays in the server log.
- `busy` and `modelUnavailable` are one status map apart, so adding a provider does not add a classifier. Adding a _reader-actionable_ failure that the map cannot express is what forces a new code.
- Log redaction is a chat-boundary rule, not a global one. A boundary that starts carrying conversation content in its errors needs the same summary before it can be logged, and nothing enforces that either.
- A provider error delivered inside a two-hundred response is a failure, not a success. The chat only streams, so it cannot hit OpenRouter's non-streaming form of that, but any future non-streaming call must not read the status alone.
