# ADR-0016: "Today" is the viewer's clock, not the account's

Date: 2026-11-01

## Status

Accepted

## Context

Three places asked "what day is it now" — the chat's system prompt, the overview's trailing window, and the edit form's calendar ceiling — and all three answered `Australia/Brisbane`, hardcoded. Separately, the two overview charts called `Temporal.Now.plainDateISO()` with no zone: correct in the browser, but the server rendered them too, in the server process's own zone. So the same page had two different answers, and a viewer in Colombia was told tomorrow's date for most of the day: "how much did I spend today?" answered $0, and the overview's rightmost bar sat on a day that had not started.

After ADR-0015 a receipt's day is stored data and never depends on any of this. This is the other half: the day the _reader_ is on.

## Decision

**"Now" is a property of the viewer's clock. The account's zone is a stored fallback, not the source of truth.**

`lib/time.ts` resolves one chain, and **every surface asks the same sources in the same order**:

1. **the `cf-timezone` request header** — Cloudflare adds it to every request to the origin, so the first render after someone travels is already right. It is read straight from the request by `lib/viewer.ts`; nothing copies it anywhere.
2. **`user.timezone`** — captured at sign-up from the browser's own `Intl.DateTimeFormat().resolvedOptions().timeZone`.
3. **`DEFAULT_TIMEZONE`** — `Australia/Brisbane`, for work with no viewer behind it.

Every candidate is taken as `unknown` and validated by `Temporal.Now.plainDateISO(candidate)`; a value that names nothing is dropped rather than thrown — an empty `cf-timezone`, which Cloudflare sends when it cannot place the IP, included.

There is deliberately **no chat-only candidate**. An earlier version took the browser's zone from a `tz` cookie and from the chat request body as well; both were removed once the header turned out to be on every request. Each was a second source for one surface, which is exactly how two surfaces end up answering "which day is it" differently — and a second source needs a writer, a precedence rule, and a pin, which is more machinery than the problem deserves.

`resolveToday` is resolved **once per page** and passed down as a `YYYY-MM-DD` prop. A client component is server-rendered as well, so a component that reads its own clock disagrees with the HTML React hydrates — and the server's zone is not the viewer's. This is why the charts, the date filter and the edit form's ceiling take `today` as a prop.

## Considered options

1. **One configurable app-wide zone.** An env var or a settings page. Closer, but still wrong for the two cases that matter: travelling, and a viewer whose browser is not in the account's zone.
2. **The account's zone alone.** Correct at home, wrong when travelling, and it makes "today" a thing to edit rather than a thing to observe.
3. **The viewer's zone, with the account as fallback (chosen).** The header follows the reader; the account covers a request with no viewer. No setting to keep in sync.

## Consequences

- Nothing writes a cookie for this. The header is on the request, so a middleware that copied it into one would only be a second copy to keep in step — and `proxy.ts` is back to the single job it had before: the optimistic session gate.
- **The page half depends on a Cloudflare Managed Transform.** `cf-timezone` is not a standard header: it only exists when the zone's **Add visitor location headers** transform is on (**Rules → Settings → Managed Transforms**). Off by default, per zone, and nothing in the repo can assert it. If it is off, nothing errors: every surface falls back to `user.timezone` and then Brisbane, together, so the app stays self-consistent — it is simply wrong about a traveller. The absence is worth one line in the log rather than none, so `lib/viewer.ts` warns once per process when a production request arrives without the header: from then on, "today" is the reader's home day. Enabled for `tribi.dev` (prod and staging); after a zone change, look for the `[viewer-timezone]` line in the app log — its absence means the header is arriving. The transform also sends nine other location headers to the origin.
- The header is **IP-derived**, so it is where the request came from, not necessarily where the reader's clock is: a VPN, or a laptop left on home time, makes every surface agree on the wrong place rather than disagreeing. That is the deliberate trade: one answer everywhere beats an accurate one on each surface. "Today" for a number on a screen is cosmetic, not a report.
- `user.timezone` is written once, at sign-up, and never updated. An account created before the column is `NULL` and reads as "no zone"; the header covers it on every request, so it is only stranded when the transform is off.
- **Local development has no Cloudflare**, so `lib/viewer.ts` stands in for the edge: with `DEV_TIMEZONE` set it answers with that zone when the header is absent, and every surface then resolves as it does in a deployment. It is gated on `NODE_ENV === "development"` — `pnpm start` and every deployed build ignore it, because a deployment is built with `NODE_ENV=production` and a client cannot set an environment variable — and on the value naming a real zone. The client-controlled input is the `cf-timezone` header itself, which any client may send; it is validated downstream and only ever moves that client's own "today". Exercised in `lib/viewer.test.ts`.
- `buildInstructions` is pure — it takes the date and the zone label — so a test can pin the date instead of describing whatever day the suite runs on.
- The charts' windows and the SQL window behind them come from the same resolved day. A query window and a chart window that disagreed would leave the rightmost bar without its data.
- No client component calls `Temporal.Now`. The remaining calls are in `lib/time.ts` itself (the resolution) and in the fixture script, which builds `created_at` instants.
- `RECEIPT_TIMEZONE` is now defined as `DEFAULT_TIMEZONE`: one literal, two names, because the home zone serves both "which zone did this value's printer mean" and "what zone is today's fallback". `browserTimezone()` names the `Intl` expression the sign-up form uses.
- `proxy.ts` no longer imports `lib/time.ts`, so the middleware bundle no longer carries the Temporal polyfill. `browserTimezone` lives in its own import-free module (`lib/browser-timezone.ts`), so the sign-up client does not ship the polyfill to read one `Intl` property either.

## Related

- ADR-0015 (receipts store the printed wall clock) — a receipt's day is stored data and does not depend on the viewer.
- Issue #192 — the implementation.
