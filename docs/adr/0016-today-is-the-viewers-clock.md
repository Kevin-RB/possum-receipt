# ADR-0016: "Today" is the viewer's clock, not the account's

Date: 2026-11-01

## Status

Accepted

## Context

Three places asked "what day is it now" — the chat's system prompt, the overview's trailing window, and the edit form's calendar ceiling — and all three answered `Australia/Brisbane`, hardcoded. Separately, the two overview charts called `Temporal.Now.plainDateISO()` with no zone: correct in the browser, but the server rendered them too, in the server process's own zone. So the same page had two different answers, and a viewer in Colombia was told tomorrow's date for most of the day: "how much did I spend today?" answered $0, and the overview's rightmost bar sat on a day that had not started.

After ADR-0015 a receipt's day is stored data and never depends on any of this. This is the other half: the day the _reader_ is on.

## Decision

**"Now" is a property of the viewer's clock. The account's zone is a stored fallback, not the source of truth.**

`lib/time.ts` resolves one chain. **Every surface asks the same sources in the same order**, which is what keeps the assistant and the charts from disagreeing about the day:

1. **the `cf-timezone` request header** — Cloudflare adds it to the request itself, so the very first render after someone travels is already right. `lib/viewer.ts` reads it, and `proxy.ts` also copies it into the **`tz` cookie**;
2. **the `tz` cookie** — one request behind, for a request that arrives without the header (LAN access, anything not proxied by Cloudflare, local development);
3. **the chat request body's `timezone`** — the browser's own zone, which only a chat turn carries. It is third, not first: the assistant walks the page chain before falling back to evidence only it has;
4. **`user.timezone`** — captured at sign-up from the same browser;
5. **`DEFAULT_TIMEZONE`** — `Australia/Brisbane`, for work with no viewer behind it.

Every candidate is taken as `unknown` and validated by `Temporal.Now.plainDateISO(candidate)`; a value that names nothing is dropped rather than thrown — an empty `cf-timezone`, which Cloudflare sends when it cannot place the IP, included. The chain must survive a bad candidate and move on.

`resolveToday` is resolved **once per page** and passed down as a `YYYY-MM-DD` prop. A client component is server-rendered as well, so a component that reads its own clock disagrees with the HTML React hydrates — and the server's zone is not the viewer's. This is why the charts, the date filter and the edit form's ceiling take `today` as a prop.

## Considered options

1. **One configurable app-wide zone.** An env var or a settings page. Closer, but still wrong for the two cases that matter: travelling, and a viewer whose browser is not in the account's zone.
2. **The account's zone alone.** Correct at home, wrong when travelling, and it makes "today" a thing to edit rather than a thing to observe.
3. **The viewer's zone, with the account as fallback (chosen).** The header, the cookie and the body follow the reader; the account covers a request with no viewer. No setting to keep in sync.

## Consequences

- The `tz` cookie is **transport, not a preference**: never editable in the UI, and rewritten from the edge header on every page response, including the bounce to sign-in. The header is asked first because the cookie is always one request behind — it is written on the _response_, so the request that creates it still renders from the fallbacks. A chat turn also writes it, but only when nothing on the wire supplied a zone: the browser is then the only source that knows, and the pin carries its answer to the pages. A header on the next request wins, so a device's pin never outlives the edge's return. In development the cookie therefore appears while `DEV_TIMEZONE` is set or after a message, and persists like any other state.
- **The page half depends on a Cloudflare Managed Transform.** `cf-timezone` is not a standard header: it only exists when the zone's **Add visitor location headers** transform is on (**Rules → Settings → Managed Transforms**). Off by default, per zone, and nothing in the repo can assert it. If it is off, nothing errors: pages fall to `user.timezone` and then Brisbane, and the app is wrong about a traveller until a chat turn tells it otherwise — the chat resolves from its body, the one piece of evidence only it carries, and **pins that zone into the `tz` cookie**. The next page request then reads the cookie, and every surface is on the browser's day again. So the surfaces agree whenever the edge reports a zone, which is the enabled configuration, and they converge within one message when it does not: `/` is the chat, so a session cannot get far without producing that evidence. Enabled for `tribi.dev` (prod and staging); verified after a zone change with `curl -s -o /dev/null -D - https://receipts.tribi.dev/sign-in | grep -i '^set-cookie: tz='`. The transform also sends nine other location headers to the origin.
- The header is **IP-derived**, so it is where the request came from, not necessarily where the reader's clock is: a VPN, or a laptop left on home time, makes every surface agree on the wrong place rather than disagreeing. That is the deliberate trade: one answer everywhere beats an accurate one on each surface. "Today" for a number on a screen is cosmetic, not a report.
- **Local development has no Cloudflare**, so `proxy.ts` stands in for the edge: with `DEV_TIMEZONE` set it forwards that zone as the `cf-timezone` request header, and every surface then runs exactly as it does in a deployment. It is gated on `NODE_ENV === "development"` — `pnpm start` and every deployed build ignore it, because a deployment is built with `NODE_ENV=production` and a client cannot set an environment variable — and on the value naming a real zone, so a typo is ignored rather than written into a cookie. The client-controlled input is the `cf-timezone` header itself, which any client may send; it is validated downstream and only ever moves that client's own "today", the same trust level as the chat body. Exercised in `proxy.test.ts`.
- `buildInstructions` is pure — it takes the date and the zone label — so a test can pin the date instead of describing whatever day the suite runs on.
- The charts' windows and the SQL window behind them come from the same resolved day. A query window and a chart window that disagreed would leave the rightmost bar without its data.
- `user.timezone` is nullable: Better Auth writes it, and a row created before the column existed has no zone. `resolveTimezone` treats both the same.
- No client component calls `Temporal.Now`. The remaining calls are in `lib/time.ts` itself (the resolution) and in the fixture script, which builds `created_at` instants.
- `RECEIPT_TIMEZONE` is now defined as `DEFAULT_TIMEZONE`: one literal, two names, because the home zone serves both "which zone did this value's printer mean" and "what zone is today's fallback". `browserTimezone()` names the `Intl` expression the two browser call sites share.
- `proxy.ts` imports `lib/time.ts` for the cookie name and `isTimezone`, which pulls the Temporal polyfill into the middleware bundle. Accepted; the alternative is a second zone-name check. Client bundles are a different matter and were fixed: `browserTimezone` lives in its own import-free module (`lib/browser-timezone.ts`) so sign-up and chat do not ship the polyfill to read one `Intl` property.

## Related

- ADR-0015 (receipts store the printed wall clock) — a receipt's day is stored data and does not depend on the viewer.
- Issue #192 — the implementation.
