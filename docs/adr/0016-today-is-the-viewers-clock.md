# ADR-0016: "Today" is the viewer's clock, not the account's

Date: 2026-11-01

## Status

Accepted

## Context

Three places asked "what day is it now" — the chat's system prompt, the overview's trailing window, and the edit form's calendar ceiling — and all three answered `Australia/Brisbane`, hardcoded. Separately, the two overview charts called `Temporal.Now.plainDateISO()` with no zone: correct in the browser, but the server rendered them too, in the server process's own zone. So the same page had two different answers, and a viewer in Colombia was told tomorrow's date for most of the day: "how much did I spend today?" answered $0, and the overview's rightmost bar sat on a day that had not started.

After ADR-0015 a receipt's day is stored data and never depends on any of this. This is the other half: the day the _reader_ is on.

## Decision

**"Now" is a property of the viewer's clock. The account's zone is a stored fallback, not the source of truth.**

`lib/time.ts` resolves one chain, in priority order:

1. **the viewer's zone** — the `tz` cookie on page requests (written by `proxy.ts` from Cloudflare's `cf-timezone` header), and the `timezone` field of the chat request body, which the browser fills from `Intl.DateTimeFormat().resolvedOptions().timeZone`;
2. **`user.timezone`** — captured at sign-up from the same browser;
3. **`DEFAULT_TIMEZONE`** — `Australia/Brisbane`, for work with no viewer behind it.

Every candidate is taken as `unknown` and validated by `Temporal.Now.plainDateISO(candidate)`; a value that names nothing is dropped rather than thrown. Candidates arrive from a cookie and a request body, so the chain must survive a bad one and move on.

`resolveToday` is resolved **once per page** and passed down as a `YYYY-MM-DD` prop. A client component is server-rendered as well, so a component that reads its own clock disagrees with the HTML React hydrates — and the server's zone is not the viewer's. This is why the charts, the date filter and the edit form's ceiling take `today` as a prop.

## Considered options

1. **One configurable app-wide zone.** An env var or a settings page. Closer, but still wrong for the two cases that matter: travelling, and a viewer whose browser is not in the account's zone.
2. **The account's zone alone.** Correct at home, wrong when travelling, and it makes "today" a thing to edit rather than a thing to observe.
3. **The viewer's zone, with the account as fallback (chosen).** The cookie and the body follow the reader; the account covers a request with no viewer. No setting to keep in sync.

## Consequences

- The `tz` cookie is **transport, not a preference**: rewritten from the edge header on every page response, including the bounce to sign-in, and never editable in the UI. It is absent in local development, where nothing sets `cf-timezone`.
- `buildInstructions` is pure — it takes the date and the zone label — so a test can pin the date instead of describing whatever day the suite runs on.
- The charts' windows and the SQL window behind them come from the same resolved day. A query window and a chart window that disagreed would leave the rightmost bar without its data.
- `user.timezone` is nullable: Better Auth writes it, and a row created before the column existed has no zone. `resolveTimezone` treats both the same.
- No client component calls `Temporal.Now`. The remaining calls are in `lib/time.ts` itself (the resolution) and in the fixture script, which builds `created_at` instants.
- `proxy.ts` imports `lib/time.ts` for the cookie name, which pulls the Temporal polyfill into the middleware bundle. Accepted for one source of truth; nothing else in `proxy.ts` needs a zone.

## Related

- ADR-0015 (receipts store the printed wall clock) — a receipt's day is stored data and does not depend on the viewer.
- Issue #192 — the implementation.
