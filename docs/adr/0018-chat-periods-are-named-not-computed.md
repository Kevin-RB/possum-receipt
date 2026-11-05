# ADR-0018: Chat periods are named, not computed

Date: 2026-11-05

## Status

Accepted

## Context

Every date-filtered chat tool took `from`/`to`, so the model turned "how much did I spend last month" into a pair of calendar dates. That is arithmetic inside a language model, and it did not survive contact with a local one: asked for "this week", it returned an arbitrary two-day window, and the total behind it was wrong without looking wrong.

The second problem was whose "today" the dates were computed against. `from`/`to` are absolute once produced, so if the model derived them from anything other than the day the prompt stated, the assistant answered about a different window than the charts showed — the failure ADR-0016 exists to prevent.

Classification is the part the model is reliable at: "last month" is a _kind_ of period, and picking one from a short list is what a small model does well. Mapping a name to two dates is deterministic app logic.

## Decision

**A chat tool is asked for a period by name; the server turns the name into dates.**

- **`range` is a closed enum.** `today`, `yesterday`, `this_week`, `last_week`, `this_month`, `last_month`, `this_year`, `last_year`, `all_time`. Anything else is not a request the app understands.
- **The bounds are resolved against the request's own `today`.** `resolveRange`/`resolvePeriod` (`lib/chat/range.ts`) are pure, take `today` as an argument, and return inclusive `YYYY-MM-DD` bounds. The route resolves `today` once through the ADR-0016 chain and passes it to both the prompt and `buildChatTools(ownerId, today)`, so the day the model is told and the day the dates are computed from cannot differ.
- **Weeks start Monday, and every `this_*` range ends today.** `this_month` is the first of the month through today, not through the last day of the month: a receipt cannot be dated in the future, and a window that includes one reads as a bug.
- **A named range wins over `from`/`to`.** `from`/`to` remain for dates the user named themselves ("between 3 and 9 March"), which is an explicit interval rather than a classification. Both present is not an error — the name is the reading the user's words support more directly.
- **No period at all means all time.** This is the loosening to understand before changing anything: `spend_by_category` and `spend_by_merchant` no longer reject a call without dates, because "all time" has to be expressible. The old schema made omission structurally impossible; now the guard is the prompt ("a spend total is worth nothing without a period") plus the `category breakdown, no period` eval, which asserts the model asks.
- **`last_year` exists.** Without it "last year" fell through to `this_year` — a silent wrong answer, not a refusal.
- **Take the nearest range rather than asking for one** when a period has no exact name ("the last two weeks"). This is a prompt rule, not a server one: the tools accept a name and nothing else, so the model picks the closest name it has been offered. Asking is the more correct behaviour in principle, and measurements say it is the worse product — prompt variants that made the model ask scored 29/33 and 30/33 against a 31/33 baseline on the same suite, while taking the reading scores 34/36 on the suite as it now stands. A stronger default model (issue #202) is the real fix for the residual case.

## Rejected

- **`from`/`to` only, with the model computing dates.** Measured wrong answers; also any window the model produced could disagree with the viewer's day.
- **Client-computed dates.** A browser clock is not the chain the charts walk, and a client component is server-rendered too — the same class of bug ADR-0016 removed.
- **A free-text period parsed by the server.** It moves the classification problem from the model to a hand-written parser, and it makes the tool schema unbounded: the model could ask for anything, and a typo would silently become some range.
- **Both `range` and `from`/`to`, with the server erroring when both arrive.** Two correct behaviours are not worth a failure mode for the model to trip over.

## Consequences

- The model classifies; the app does arithmetic. A date bug in a chat answer is now a bug in one pure function with unit tests, not a sampling problem.
- `lib/chat/range.test.ts` pins each name's bounds against fixed `today` values, including a leap day and a month boundary.
- Omitting the period is legal and means all time, so an unresolvable "how much did I spend on groceries?" returns a real total. The prompt and one eval carry that guard rather than the schema.
- A period nobody named — "the last two weeks" — is answered with the nearest range, because the prompt tells the model to prefer a reading over a question. The answer can be slightly off; asking measured worse.
- Adding a period is an enum member, a `resolveRange` case (the exhaustive switch makes a missing one a build error) and a line in the prompt's list of names — the model can only choose a period it has been offered.

## Related

- ADR-0016 ("today" is the viewer's clock) — the `today` these bounds resolve against.
- ADR-0015 (receipts store the printed wall clock) — why a receipt's own day is stored data and never derived here.
- Issue #201 — the decision ticket; PR #216 — the implementation.
