# ADR-0015: Receipts store the printed wall clock, not an instant

Date: 2026-10-30

## Status

Accepted

## Context

`receipts.transaction_datetime` was a `timestamptz`: an instant, produced by interpreting the printed wall clock as `Australia/Brisbane` when the receipt was written. Every read then re-derived the calendar day by converting that instant in _some_ timezone — Brisbane in SQL, the browser's own zone in the overview's daily chart, the receipt timezone in the edit form.

That made "what day was this receipt" a computation rather than data. The same receipt could appear on different days in different charts, and an account used from another country saw evening purchases filed under the next day: a receipt printed `7 Oct 20:30` in Bogotá was stored as `8 Oct 01:30 UTC` and read back as 8 October. Changing the app's timezone would have silently re-dated every receipt already stored.

A receipt is a piece of paper with a local date and time printed on it. There is no instant on it and no timezone.

## Decision

**Instants for system events, wall clocks for things a human wrote down.**

`transaction_datetime` is a `timestamp` without time zone, holding the printed wall clock (`2026-10-07 20:30:00`). It is read with Drizzle `mode: "string"` and parsed to `Temporal.PlainDateTime` at the seam; `mode: "date"` was rejected because pg would rebuild a `Date` in the Node process's own zone, reintroducing the conversion the column exists to avoid. `created_at`, `categorized_at` and `processing_started_at` remain `timestamptz`: they are server events and genuinely instants.

`RECEIPT_TIMEZONE` survives only to interpret a datetime string that carries a UTC designator, and to answer "what day is it now" — a question about the viewer, not about the receipt.

## Considered options

1. **One app-wide timezone.** Replace the browser-zone reads with the constant. Five lines, correct for a Brisbane user, wrong for anyone else, and history still shifts if the setting ever changes.
2. **A timezone per receipt.** A `transaction_timezone` column plus a user default, converting per row. Correct for travel, but the zone still has to be _guessed_ at extraction — nothing on the receipt states it — and every query becomes `(transaction_datetime AT TIME ZONE receipts.transaction_timezone)::date`.
3. **The printed wall clock (chosen).** The day is the date part. No zone to guess, no per-row conversion, and the migration is lossless because existing rows were all written as Brisbane.

## Consequences

- A receipt's day is stored data, so it cannot move when the viewer travels or the deployment's timezone changes.
- The zone-conversion layer is deleted: `startOfReceiptDay`/`startOfNextReceiptDay` become string bounds, `categoryDayExpression` loses its `AT TIME ZONE`, and `receiptDateToISODateString`'s zone parameter disappears.
- Date-range filtering gets simpler and cheaper: "1–15 October" is `>= '2026-10-01 00:00:00' AND < '2026-10-16 00:00:00'`.
- Display builds a `Date` at **UTC** holding the receipt's own components, and every formatter reads it with `timeZone: "UTC"`. Building it in the viewer's zone instead makes the output depend on that zone: a printed time inside a spring-forward gap (`2026-03-08 02:30` in `America/New_York`) normalises to 03:30, so the table would show an hour the receipt does not say, and the hydrated string would disagree with the server-rendered one. The `Date` itself stays because handing the `Temporal` object to `Intl` is not portable (see `lib/receipt/datetime.ts`).
- Calendar-day carriers are the other case: `receiptLocalStringToDay` and `receiptToday` still build a `Date` at the browser's local midnight, because a calendar compares its cells (receipt-local days) against that bound.
- A receipt bought in one timezone and viewed in another cannot be ordered against it by "true" time. Nothing in the app orders by true time, and the printed time is the one the owner recognises.
- The migration must be hand-edited to add `AT TIME ZONE 'Australia/Brisbane'` to the `USING` clause; drizzle-kit emits a bare `::timestamp`, which reads the instant in the session's timezone (UTC by default) and would shift every row by ten hours.

## Related

- ADR-0007 (GST-inclusive money model) — the same principle: store what the receipt states rather than a recomputation of it.
- Issue #191 — the migration and the deleted conversion layer.
