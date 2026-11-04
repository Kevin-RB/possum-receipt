# ADR-0014: One error vocabulary, causes kept in the server log

Date: 2026-10-29

## Status

Accepted.

## Context

Error handling had grown one shape per boundary. Server actions returned ad-hoc strings (`"Failed to delete receipt"`, `"Validation failed"`, `"Receipt is not ready to re-process"`), but their `catch` blocks discarded the error, so the server log held no record of why anything failed. Route handlers answered `{ error: "Unauthorized" }`. The chat route returned the same generic sentence from `onError` that the client also printed, so a failed turn read "Something went wrong. Please try again. (Something went wrong. Please try again.)" while the real cause — an `AI_RetryError` wrapping an `APICallError` "Cannot connect to API: …" — was dropped on the floor. The app is local-first against one LM Studio instance, so "the provider is down" is a routine failure, not an edge case, and it was the failure the UI described worst.

The obvious alternative — a custom `Error` subclass carrying a user-facing message, caught by an error boundary — does not work in this framework. Next redacts errors thrown on the server in production: a Server Component's error reaches `error.tsx` with a generic `message` and the cause only as `error.digest`, which is a key into the server log, not text. Only client-thrown errors keep their message. That is deliberate (it keeps credentials, URLs and query fragments out of the browser) and the Next guide says so explicitly: expected errors should be **returned**, not thrown.

## Decision

**One vocabulary.** `lib/errors.ts` exports `USER_ERROR`, a catalogue of codes → wording. These strings are the only text the UI may show. Adding a failure means adding a code, not inventing a sentence at the call site.

**Expected failures are returned.** A server action returns `{ error, success: false }`; a route returns `{ error }` with a status; the chat route returns catalogue text from `onError`. Nothing in this class of failure is thrown across a boundary, which is also what keeps the wording intact in production.

**Causes are logged on the server, exactly once.** `reportError(scope, error)` is the one logging convention (`[receipts.delete]`, `[chat]`). It is called by the boundary that failed, immediately before returning catalogue text. A `catch` that returns a message without calling it loses the only copy of the cause.

**Classifiers map a cause to a code, per domain.** `lib/chat/errors.ts` is the only code that knows the AI SDK's error types: it unwraps `RetryError` (default `maxRetries` is 2, so the `APICallError` is never the top-level error in what the route sees) and distinguishes an unreachable model from everything else. Boundaries call the classifier and index the catalogue; they do not inspect provider errors themselves.

**Text that crossed a boundary the app does not own is verified.** `isUserMessage` accepts only catalogue wording. The chat client uses it on `error.message`, and the upload form on a failed response body. Anything else becomes `USER_ERROR.generic`, so a JSON body, an HTML error page or a provider message cannot be displayed.

**No custom `Error` hierarchy.** It would route a category inside the process, which the boundary that catches the failure can decide on its own, and it cannot carry user-facing text to a Server Component boundary in production. The catalogue plus a per-domain classifier covers every case here without a class per failure.

**Unexpected exceptions stay exceptions.** They are bugs: they reach `app/error.tsx`, which shows a generic page, offers a retry, and logs to the browser console. The server log holds the thrown stack and `error.digest` ties the two together.

## Consequences

- Wording changes are one line in one file, and every screen shows it.
- Every user-visible failure is a catalogue string or the generic one; provider URLs, status lines, model ids and stack traces cannot reach the browser through the app's own boundaries.
- Causes live only in the server log. A client-side render failure still reaches only the browser console and the `digest` — there is no error-reporting endpoint, and building one is telemetry work, not error handling.
- The root layout has no `global-error.tsx`, so a failure in `app/layout.tsx` itself falls through to the framework's page. The layout is static (fonts, theme provider, toaster), so the gap is real but narrow.
- Server action and route response shapes are unchanged, so callers and existing tests keep working.
- The catalogue is flat, not namespaced, because with one product area and under twenty codes a tree would be structure without a second consumer. If it grows past that, the split is by domain (`USER_ERROR.receipts.*`), not by layer.
- A `catch` can still forget to call `reportError`; nothing enforces it. Reviewing a `catch` for that call is the guard, in the same spirit as the `never` branch in `agent-steps.tsx`.
