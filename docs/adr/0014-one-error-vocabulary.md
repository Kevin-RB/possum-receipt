# ADR-0014: One error vocabulary, causes kept in the server log

Date: 2026-10-29 Revised: 2026-11-06

## Status

Accepted. Revised 2026-11-06: the remote-provider vocabulary — a `busy` code on a status map, no mid-stream retries. Revised 2026-11-05: the chat boundary logs a projection of the cause, not the cause itself.

## Context

Error handling had grown one shape per boundary. Server actions returned ad-hoc strings (`"Failed to delete receipt"`, `"Validation failed"`, `"Receipt is not ready to re-process"`), but their `catch` blocks discarded the error, so the server log held no record of why anything failed. Route handlers answered `{ error: "Unauthorized" }`. The chat route returned the same generic sentence from `onError` that the client also printed, so a failed turn read "Something went wrong. Please try again. (Something went wrong. Please try again.)" while the real cause — an `AI_RetryError` wrapping an `APICallError` "Cannot connect to API: …" — was dropped on the floor. The app is local-first against one LM Studio instance, so "the provider is down" is a routine failure, not an edge case, and it was the failure the UI described worst.

The obvious alternative — a custom `Error` subclass carrying a user-facing message, caught by an error boundary — does not work in this framework. Next redacts errors thrown on the server in production: a Server Component's error reaches `error.tsx` with a generic `message` and the cause only as `error.digest`, which is a key into the server log, not text. Only client-thrown errors keep their message. That is deliberate (it keeps credentials, URLs and query fragments out of the browser) and the Next guide says so explicitly: expected errors should be **returned**, not thrown.

**Revision, 2026-11-06.** The chat moved from one local LM Studio instance to a remote provider on an app-owned key (ADR-0017), which changed what can fail and who can fix it. A rate limit, an exhausted balance, a bad key and a blocked account are all reachable now, and only the first is worth the reader retrying. A provider failure that happens _after_ the first token also arrives as a different error class — `StreamProviderError`, with the HTTP status carried in the payload rather than on the wire — so the classifier had to learn a second type. See issue #208.

## Decision

**One vocabulary.** `lib/errors.ts` exports `USER_ERROR`, a catalogue of codes → wording. These strings are the only text the UI may show. Adding a failure means adding a code, not inventing a sentence at the call site.

**Expected failures are returned.** A server action returns `{ error, success: false }`; a route returns `{ error }` with a status; the chat route returns catalogue text from `onError`. Nothing in this class of failure is thrown across a boundary, which is also what keeps the wording intact in production.

**Causes are logged on the server, exactly once.** `reportError(scope, error)` is the one logging convention (`[receipts.delete]`, `[chat]`). It is called by the boundary that failed, immediately before returning catalogue text. A `catch` that returns a message without calling it loses the only copy of the cause. (Superseded for the chat boundary only — it logs a projection of the cause, not the cause; see the 2026-11-05 update below.)

**Classifiers map a cause to a code, per domain.** `lib/chat/errors.ts` is the only code that knows the AI SDK's error types: it unwraps `RetryError` (default `maxRetries` is 2, so the `APICallError` is never the top-level error in what the route sees) and distinguishes an unreachable model from everything else. Boundaries call the classifier and index the catalogue; they do not inspect provider errors themselves.

**Text that crossed a boundary the app does not own is verified.** `isUserMessage` accepts only catalogue wording. The chat client uses it on `error.message`, and the upload form on a failed response body. Anything else becomes `USER_ERROR.generic`, so a JSON body, an HTML error page or a provider message cannot be displayed.

**No custom `Error` hierarchy.** It would route a category inside the process, which the boundary that catches the failure can decide on its own, and it cannot carry user-facing text to a Server Component boundary in production. The catalogue plus a per-domain classifier covers every case here without a class per failure.

**Unexpected exceptions stay exceptions.** They are bugs: they reach `app/error.tsx`, which shows a generic page, offers a retry, and logs to the browser console. The server log holds the thrown stack and `error.digest` ties the two together.

**Remote provider failures classify on status alone.** `lib/chat/errors.ts` accepts `APICallError` **and** `StreamProviderError`, unwraps `RetryError`, and maps `statusCode` to one of three chat codes. It imports no provider package and reads no provider metadata, so a second provider only needs a status map, not a new classifier.

| Cause | Code | Reader sees |
| --- | --- | --- |
| 408 timeout, 409 conflict, 429 rate limited, and every 5xx — 500, 502 model down, 503 no endpoint meets the routing policy, 504 gateway timeout | `busy` | "The assistant is busy right now. Please try again in a moment." |
| 401 bad key, 402 out of credits or in-flight budget, 403 forbidden, 404 unknown model id, 200 carrying an error, or a provider error with no status | `modelUnavailable` | the existing "isn't responding right now" line |
| 400 malformed request, any other 4xx the map does not name, and anything that is not a provider error | `generic` | the existing generic line |

The map is exhaustive on purpose: every provider status lands in exactly one row, so an implementer has no status left to judge. The remaining 5xx and 409 sit in `busy` because the SDK already retries them twice and the reader's next action is the same as for 429; 404 is `modelUnavailable` because a retired or mistyped catalogue id is the operator's problem, like a dead key.

**Only a failure the reader can act on gets its own sentence.** `busy` exists because waiting is an instruction. A bad key or an empty balance is an operator failure delivered to whoever is looking at the screen, so it keeps the line an outage already uses; the distinction lives in the log, where the operator can act on it. Telling an invited reader that the owner's credits ran out would expose the system and help nobody.

**The reader never learns which 402 it was, and neither does the log.** Out-of-credits and in-flight-budget both arrive as 402 and both map to `modelUnavailable`; splitting them would mean reading OpenRouter's `metadata.limit_source` at the boundary. The projection drops the provider's message, so it records the status and the model, and the balance itself is read from the provider dashboard.

**Provider failures are never retried mid-stream.** `maxRetries` keeps its default of 2 and applies before the stream starts, honouring `Retry-After` (0–60s). `streamRetries` stays off: a retried step appends to prose the reader has already seen, because streamed text cannot be retracted. A 402 is not retried by the SDK and is not retried by us; the reader's resubmit is the retry.

**The log records this classifier's answer, not a second vocabulary.** The chat boundary already logs `chatFailureLog`'s projection — code, model, error name, endpoint origin, status, retryability (2026-11-05 update below). The status map only changes what `code` says: a 429 is recorded as `busy` rather than `modelUnavailable`, and the status, endpoint and retryability beside it are what let an operator tell a rate limit from an exhausted balance or a dead key. `limitSource` never reaches the projection, because the reader code no longer depends on it; the provider's own message and the request body stay out for the reasons that update gives.

## Consequences

- Wording changes are one line in one file, and every screen shows it.
- Every user-visible failure is a catalogue string or the generic one; provider URLs, status lines, model ids and stack traces cannot reach the browser through the app's own boundaries.
- Causes live only in the server log. A client-side render failure still reaches only the browser console and the `digest` — there is no error-reporting endpoint, and building one is telemetry work, not error handling. (Superseded for the chat boundary only — what that log holds is a projection; see the 2026-11-05 update below.)
- The root layout has no `global-error.tsx`, so a failure in `app/layout.tsx` itself falls through to the framework's page. The layout is static (fonts, theme provider, toaster), so the gap is real but narrow.
- Server action and route response shapes are unchanged, so callers and existing tests keep working.
- The catalogue is flat, not namespaced, because with one product area and under twenty codes a tree would be structure without a second consumer. If it grows past that, the split is by domain (`USER_ERROR.receipts.*`), not by layer.
- A `catch` can still forget to call `reportError`; nothing enforces it. Reviewing a `catch` for that call is the guard, in the same spirit as the `never` branch in `agent-steps.tsx`.
- (2026-11-06) The chat's failure taxonomy is invisible from the browser: one new sentence, and every cause that distinguishes the codes stays in the server log.
- (2026-11-06) `busy` and `modelUnavailable` are one status map apart, so adding a provider does not add a classifier. Adding a _reader-actionable_ failure the map cannot express is what forces a new code.
- (2026-11-06) A provider error delivered inside a two-hundred response is a failure, not a success. The chat only streams, so it cannot hit OpenRouter's non-streaming form of that, but any future non-streaming call must not read the status alone.

## Update (2026-11-05): the chat boundary logs a projection, not the cause

"Causes are logged on the server" above does not hold at the chat boundary, and the title's "causes kept in the server log" now describes every other boundary.

`reportError("chat", error)` is `console.error("[chat]", error)`, and an `APICallError` carries two things that must not outlive the request: `requestBodyValues` — the messages sent to the model, which here are the reader's questions and the receipt text they quote — and a `url` whose query string can hold a provider key. `console.error` prints both.

`chatFailureLog(error, resolved.id)` in `lib/chat/errors.ts` builds what is recorded instead: the classified code, the model, the error name, the provider's endpoint **origin** (no path, no query string), the status code, and whether a retry could help. The error's own message is dropped with it, because a provider often echoes the request inside it.

`onError` also receives failures that are not provider failures — the AI SDK routes a tool's own error through it — so the rule cannot be "drop every message": a storage error's message is the diagnosis. The projection therefore keeps the message for errors the AI SDK did not raise, and drops it for the ones it did. `TypeValidationError` renders the value that failed into its message (`Type validation failed: Value: {"query":"yogurt"}`), which for a tool is its input — the model's arguments, which routinely quote the reader.

A chat tool's failure is usually a database one, and there the message is the query as much as the diagnosis. Drizzle wraps every failed query in a `DrizzleQueryError` whose message is `Failed query: <sql>\nparams: <bound values>`, and a search binds the reader's own words:

```text
Failed query: select * from "receipt_items" where "name" ilike $1
params: %yogurt%
```

So a query failure is projected to its **statement** — the SQL, with the placeholders still in it — plus the driver's five-character SQLSTATE (`42P01` undefined table, `57014` statement cancelled, `23505` duplicate key). What ran and why are both in the log; neither quotes a value. The bound values are the one thing this boundary must not keep, because they are the reader's text in a different costume.

Every other boundary still logs the raw cause. Those boundaries handle errors the app itself raised, and nothing of the reader's rides on one.
