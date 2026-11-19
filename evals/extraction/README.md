# Extraction eval harness

Measures how well a model reads a receipt photograph into the production
extraction contract (`lib/db/contract.ts`). Two entry points:

| script | what it does | network |
| --- | --- | --- |
| `run.ts` | calls a model over the corpus and scores every run | yes — OpenRouter |
| `rescore.ts` | re-scores the recorded runs against a different answer key | **none** |

Both write their results **outside the repository**. The corpus is real owner
receipts (merchant, store, a partial card number on some), so the images and
every artefact derived from them stay in a directory the repo never sees — only
code is committed.

## The matrix: `run.ts`

```sh
pnpm eval:extraction --corpus <dir> --out <dir>
```

`--corpus` holds `corpus.json`, `golden.draft.json`, `categories.json`,
`categorization.golden.json` and `images/`. `--out` receives `runs.json`,
`summary.md` and `disputes.json`. Both are required and any other flag is
refused before a model is constructed: a mistyped flag would otherwise start a
paid run. `pnpm eval:extraction` supplies `--env-file-if-exists=.env.local`, so
`OPENROUTER_API_KEY` and the model settings come from there.

Variants, all on `deepseek/deepseek-v4.1-flash-1017`:

- **A** — one multimodal call, with a leading `transcript` field in the schema;
  run twice, on free routing and on fp8/bf16-restricted routing.
- **B** — the same call and prompt against the production contract.
- **C** — the production two-step: transcribe, then parse.
- **D** — `categorizeItems` over the owner-labelled line items.

Every HTTP call is metered through a language-model middleware (host, cost,
tokens, latency) so a failed attempt is still counted and still costed. A spend
guard stops before a call could take the session past US$1. It also runs a
smoke test first and refuses the matrix if the model cannot be reached.

`output: runs.json` is keyed by variant, then receipt id (`categorization` for
D), and keeps each extraction, its transcript, the parsed scores and the calls.
It is rewritten after every run, so a crash keeps what was already paid for.

## The re-score: `rescore.ts`

Answers "what would these runs have scored against a different key?" without
spending anything.

```sh
pnpm exec tsx ./evals/extraction/rescore.ts \
  --runs <dir>/runs.json \
  --golden <key.json> \
  --out <dir> \
  [--label <name>] [--categorization <file>] [--compare <summary.json>]
```

- `--runs` is a `runs.json` from `run.ts`.
- `--golden` is the key to score it against: either a bare array (what
  `golden.draft.json` is) or `{ "receipts": [...] }`. Unknown keys are dropped,
  so an adjudication export can carry a `notes` block without a conversion.
- `--out` receives `summary.md`, `summary.json` and `disputes.json`.
- `--label` names the key in the reports; it defaults to the key's filename.
- `--categorization` is `categorization.golden.json`. Variant D's key has
  nothing to do with the extraction key, so it is only re-derived from the
  recorded slugs when this is given; otherwise D reports the values
  `runs.json` already holds.
- `--compare` takes another re-score's `summary.json` and writes `DELTA.md`
  beside the rest: the key's changes, each metric's movement, the per-receipt
  F1, and what neither key can make the model match.

**No model, no network, no credential.** The script reads two JSON files and
writes three (four with `--compare`); nothing in its import graph opens a
socket. There is no `--env-file` in the invocation and none is needed.

### How it scores

It calls the matrix's own functions — `scoreExtraction` for A/B/C,
`scoreCategorization` for D — so a number can only move because the key moved.
Two policies are added on top, because the key can now say things the draft
could not:

- **A date-only `transactionDatetime`** (`YYYY-MM-DD`) never enters
  `datetime exact`. Those runs score on date equality in **`date exact`**, and a
  prediction carrying any clock time on that day passes. The key does not
  invent a midnight reading the paper never printed.
- **`gst` exactness is scored only over receipts whose golden `gst` is
  non-null**, because "the paper prints no GST" cannot be a wrong answer. The
  denominator is reported. A separate **`GST reported`** table counts, per
  receipt, how often a run returned a GST at all — the count the field table
  cannot show, since a wrong GST and no GST both fail it.

A failed run counts as zero in every pass rate and as zero in the mean F1, the
same as the matrix.

### Metrics in `summary.md` / `summary.json`

| metric | definition |
| --- | --- |
| `mean F1` | the matrix metric: line items matched when the amount is within a cent **and** the names are ≥ 0.75 similar |
| `amount precision / recall / F1` | the same multiset matching with names ignored: identical `kind` and the same magnitude within a cent. The money-accuracy metric |
| `name exact` | matched pairs whose names are identical after `normaliseName`, out of the pairs that matched |
| `schema valid`, `total exact`, `payment exact`, `reconcile` | unchanged from the matrix |
| `datetime exact` | same minute as the key, for receipts whose key prints a time |
| `date exact` | the golden day, for date-only receipts |
| `merchantName` | case- and whitespace-insensitive |
| `merchantAbn` | digits only, so `90 196 565 019` equals `90196565019` |
| `merchantStoreId`, `receiptNumber`, `subtotal` | exact after trimming, empty read as null |
| `gst` | exact to the cent, over the non-null golden values only |

`summary.md` also lists the remaining losses per receipt and variant — the
golden lines no predicted line matched, beside the predicted lines left over —
twice: once with the matrix's name-aware matching, which separates a formatting
difference from a wrong line, and once on amount and `kind` alone, which
separates a money error from a naming one.

`disputes.json` has the same shape as the matrix's: per receipt, every scalar
field the models disagreed with the key on, grouped by observed value with
counts, plus the golden lines left unmatched. `proposed` is always null — the
harness lists disagreements, it does not rule on them. It is stamped with the
re-score's own timestamp, so it is not byte-identical to the matrix's file even
when the numbers are.

### Proving the re-score is the same scorer

Run it against the key the matrix used and the variant table must reproduce the
committed `summary.md` exactly, with `0` records differing from `runs.json`:

```sh
pnpm exec tsx ./evals/extraction/rescore.ts \
  --runs <dir>/results/runs.json \
  --golden <dir>/golden.draft.json \
  --out <dir>/results/rescored-draft
```

The last line of the run prints how many records now carry a different metric
set than `runs.json` records; against that key it is zero. If it is not, the
scoring code changed, and the question is what changed rather than how to adjust
the key.
