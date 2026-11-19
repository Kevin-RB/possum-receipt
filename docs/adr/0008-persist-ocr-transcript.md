# ADR-0008: Persist the OCR transcript for inspection

Date: 2026-09-22

## Status

Accepted. Narrowed by ADR-0022 (2026-11-19), landing with [#250](https://github.com/Kevin-RB/possum-receipt/issues/250): extraction becomes one call with no parsing pass, so the early-write rule below has nothing left to precede. The transcript itself and its disclosure stand.

## Context

Extraction is two passes: OCR turns the receipt image into a plain-text transcript, then parsing turns that transcript into the structured receipt contract. Only the final structured output was stored, so a wrong field could not be traced to the pass that produced it — a misread digit and a parser mistake were indistinguishable after the fact. There was also no way to measure extraction quality across models or prompt changes.

This touches the boundary set by ADR-0003 (no provenance, no re-extraction). That ADR is about tracking per-item origin and re-running extraction; neither is proposed here.

## Decision

Store the OCR transcript on the receipt row as a nullable `transcript` column. It is written immediately after the OCR step and before parsing, so a receipt that later fails to parse still keeps the text OCR produced. (Narrowed by ADR-0022, landing with #250: one multimodal call reads the image and writes the transcript with the fields, so there is no parsing pass to write before and the transcript is written in `storing`. A first extraction whose response does not satisfy the schema keeps the response's raw text there instead — see the 2026-11-20 update; the transcript and its disclosure are unchanged.) The transcript is shown in a collapsed disclosure on the receipt detail page.

The transcript is an observability artifact for pass 1 only:

- It is never used to re-derive or overwrite stored extraction, and manual edits neither read nor write it.
- It is not per-item provenance; it does not distinguish AI-extracted from human-edited rows.
- It does not enable re-extraction. ADR-0003 still stands.

The offline evaluation harness (issue #131) used the same transcript to classify each mismatch as an OCR error or a parse error: if the golden's expected printed text is absent from the transcript, OCR never captured it; if present, the parser had what it needed and got it wrong. Fixture images and goldens are real receipts and stay out of version control. (Superseded — the harness was later removed; see Update below.)

## Consequences

- The receipt row carries the receipt's full text, including anything personal it prints (addresses, ABNs, partial card numbers). It lives in the same database as the rest of the extraction and is subject to the same access rules.
- A failed parse leaves a transcript behind, which is the point: it makes parse failures diagnosable. (Narrowed by ADR-0022, landing with #250: there is no parse pass to fail on its own, so the diagnosis is the failed call. A first extraction whose response does not satisfy the schema still leaves text behind — the response itself, kept by #250 — while a failed re-process writes nothing, because the row's transcript describes the extraction stored on it.)
- No provenance is added, and unit price is still never derived or persisted.

## Related

- ADR-0003 (no re-extraction or provenance) — still stands.
- ADR-0007 (GST-inclusive money model) — the money model these receipts follow.
- Issue #131, placeholder #127 — where this and the harness were specified.

## Update (2026-09-23)

The evaluation harness this decision was written alongside has since been removed: the model question it existed to answer is settled (`glm-ocr` plus `gemma-4-e4b`), and every alternative was unusable. The OCR-vs-parse classification described above went with it.

The transcript itself is retained on its own merits, which is why this ADR stands. It is what lets a failed parse be diagnosed from the app without a harness at all, and the disclosure on the receipt detail page is its reader. (Narrowed by ADR-0022, landing with #250: there is no parse pass to fail on its own; see the 2026-11-20 update for what a failed extraction leaves behind.)

## Update (2026-11-20)

Landed in [#250](https://github.com/Kevin-RB/possum-receipt/issues/250) (#262). The ADR-0022 narrowing above says a receipt whose extraction fails keeps no text, which was written before #250 decided the opposite: a call whose response does not satisfy the schema stores the SDK's `NoObjectGeneratedError.text`, truncated to 20,000 characters, as the receipt's `transcript` before the run fails. That is what keeps this ADR's failed-run diagnosis after the collapse to one call: a person can still read what the model saw, next to the fields it produced.

The rule is scoped to a **first** extraction. A re-process that fails writes neither fields nor transcript, because the row already holds an extraction and the transcript that describes it (ADR-0011); overwriting that text with a failed attempt's would make the row describe data it does not hold.

The rest of this ADR stands unchanged: the transcript is an observability artifact, it is never re-read to derive fields, and the detail page's disclosure is its reader.
