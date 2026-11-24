# possum

A web app that turns photos of paper receipts into structured, queryable data.

You upload a receipt photo; one multimodal model call reads it straight into a fixed extraction contract, a durable workflow stores the result next to the image, and every line item is categorized from a seeded taxonomy. The same data powers a chat assistant that answers questions about your own spending, a receipts table, and spending charts.

Production is a serverless Next.js deployment — Vercel Hobby for the app, Neon for Postgres, Cloudflare R2 for the images, Inngest Cloud for the workflow, and OpenRouter for every model call. Local development runs the app on the host with Postgres, RustFS and the Inngest dev server in Docker, and can add LM Studio as a second chat model.

## Contents

- [Stack](#stack)
- [Architecture](#architecture)
  - [The pieces](#the-pieces)
  - [How services talk to each other](#how-services-talk-to-each-other)
  - [The receipt pipeline, end to end](#the-receipt-pipeline-end-to-end)
  - [Processing status lifecycle](#processing-status-lifecycle)
  - [Realtime](#realtime)
  - [Chat](#chat)
- [Running it locally](#running-it-locally)
- [Configuration](#configuration)
- [Commands](#commands)
- [Project layout](#project-layout)
- [Deployment](#deployment)
- [Further reading](#further-reading)

## Stack

| Concern | Choice |
| --- | --- |
| App | Next.js 16 (App Router), React 19, Tailwind v4, shadcn/ui |
| Language | TypeScript (strict), native `Temporal` |
| Database | Postgres 18 via Drizzle ORM — Neon in production, a container locally |
| Object storage | S3-compatible: Cloudflare R2 in production, RustFS locally; `aws-sdk` v3, presigned URLs |
| Background work | Inngest durable functions + Inngest Realtime — Cloud in production, a dev server locally |
| Models | OpenRouter (`deepseek/deepseek-v4.1-flash-1017`) for extraction, categorization and chat; LM Studio optionally for chat in local development |
| Auth | Better Auth (email + password, invite-code gated) |
| Tests | Vitest |
| Hosting | Vercel Hobby, functions pinned to `syd1` |

## Architecture

### The pieces

The repo is the node in the middle; everything else is a service it talks to.

```
Browser
  │  HTTPS: pages, /api/upload, /api/storage-events, /api/chat, server actions
  │  presigned PUT: the image, straight to the bucket
  │  SSE: Inngest Realtime, one channel per owner
  ▼
Next.js app  (Vercel functions in production, the host in development)
  ├─▶ Postgres        · Neon in production, a container locally
  ├─▶ Object storage  · R2 in production, RustFS locally
  ├─▶ OpenRouter      · extraction, categorization and chat
  └─▶ Inngest         · Cloud in production, a dev server locally
        └─▶ invokes /api/inngest, which runs the functions inside the app
              ▲
              └─ RustFS bucket notification (local development only)
                 → POST /api/storage-events
```

- **Next.js app** — UI, HTTP API, server actions, the Inngest function definitions, and every call to Postgres, object storage, OpenRouter and Inngest. It is the only component in the repo, and in production it is a set of Vercel functions rather than a long-lived server.
- **Browser** — never sees a storage credential. It asks the app for a presigned URL, PUTs the image itself, confirms the upload with one authenticated call naming the receipt, then subscribes to a realtime channel for progress.
- **Postgres** — the single source of truth: receipts, line items, the category taxonomy, and auth tables.
- **Object storage** — receipt images behind an S3 API. The app uses it through the same client in both environments; only the endpoint and credentials differ. R2 is private: images are read through the app, never from a public URL.
- **OpenRouter** — the model provider. One credential covers extraction, categorization and chat, and every request is routed with `zdr` and `require_parameters` set.
- **Inngest** — the durable execution layer. Holds event history, drives retries, and invokes the function definitions the app serves at `/api/inngest`.
- **LM Studio** — optional, local development only. It holds the second entry in the chat model picker; nothing in production depends on it, and extraction cannot use it.

### How services talk to each other

| From | To | Mechanism | Notes |
| --- | --- | --- | --- |
| Browser | App | HTTPS: page loads, `POST /api/upload`, `POST /api/storage-events`, `POST /api/chat`, server actions | Session cookie; `proxy.ts` does an optimistic cookie check, real checks happen in layouts and per route |
| Browser | Object storage | HTTPS `PUT` to a presigned URL | Direct, credential-free, one object key, 5-minute expiry. CORS on the bucket allows the app origin |
| Browser | Inngest | SSE subscription over a realtime channel | One channel per owner (`user:<id>`); token minted by a server action from the session |
| App | Postgres | `pg` over TCP | Drizzle; every query is owner-scoped. One pool per function instance, attached to the instance lifecycle on Vercel |
| App | Object storage | S3 API (`GetObject`, `PutObject`, `DeleteObject`, `HeadObject`, presign) | Same client, different endpoint per environment |
| App | OpenRouter | HTTPS, AI SDK | Extraction is one multimodal call; categorization is one structured call per chunk; chat is a tool loop |
| App | Inngest | `inngest.send(...)` | Events are the only coupling between producers and workers |
| Inngest | App | HTTP to `/api/inngest` | In development the dev server polls the app's function definitions; in production Cloud invokes them, synced by the Vercel integration |
| Browser | App | `POST /api/storage-events` with `{ receiptId }` | The upload confirmation, sent after the `PUT`: session-authenticated, owner-scoped, and verified with a `HeadObject` before the receipt is promoted (ADR-0021) |
| RustFS | App | `POST /api/storage-events` | Bucket notification, authenticated with `Authorization: Bearer $STORAGE_WEBHOOK_SECRET`. Local development only; the route fails closed when that secret is unset |

Two boundaries are worth calling out, because they are the reason the pipeline is shaped the way it is:

**The server is the authority on "the upload finished."** A receipt sitting in `uploading` means "the browser may or may not have PUT yet." After a successful `PUT` the browser makes one authenticated call naming the receipt, and the server checks the object with a `HeadObject` before it promotes the row and starts extraction — so `pending` is a fact about the bucket, not a claim by a client. A call that never arrives is settled when `/receipts` loads, which runs the same check on a later visit. In local development RustFS's webhook is the route's second caller, and it is trusted without a `HEAD` because the storage layer is vouching for its own object (ADR-0021).

**Workers live in the app, but the app is not the only thing that talks to them.** The functions are registered at `/api/inngest`, and anything that can name an event — a route, a server action, or a one-off script — can queue work. That is what lets the categorization backfill run from a laptop or a CI job without the app being restarted or aware of it.

### The receipt pipeline, end to end

1. **Compress.** The browser downscales the chosen photo to a 2000px longest edge and re-encodes it as JPEG (`lib/images/compress-receipt-image.ts`). EXIF orientation is baked in, so phone photos do not land sideways.
2. **Request an upload slot.** `POST /api/upload` validates the declared content type and size, inserts a receipt row with `status = 'uploading'` and an object key namespaced `users/<userId>/<uuid>.<ext>`, and returns a presigned PUT URL (`PRESIGNED_URL_EXPIRY_SECONDS`, 5 minutes).
3. **Upload.** The browser PUTs the bytes straight to the bucket. Storage credentials never leave the server.
4. **Confirm.** After the `PUT`, the browser makes one authenticated `POST /api/storage-events` naming the receipt id — never an object key, which is server-owned data. The route loads the receipt for the session's owner, checks the stored key with a `HeadObject` (a few attempts inside the one request), and only if the object is there promotes the row `uploading → pending` and sends `receipt/uploaded` with a deterministic event id, so a repeat is deduped by Inngest rather than starting a second run. An absent object answers 409 and leaves the row `uploading`. Local development adds RustFS's bucket notification as a second caller of the same route: it presents `Authorization: Bearer $STORAGE_WEBHOOK_SECRET` and an object key instead of a session and a receipt id, and the two paths cannot reach each other. A confirmation that was lost is settled on the next visit to `/receipts`: a row still `uploading` past the settle window (`UPLOAD_SETTLE_SECONDS`, the presign window plus a grace for a slow `PUT`) gets one `HEAD` — present, it is promoted and extraction starts; absent, it becomes `error`. A stale `pending` row is re-sent on the same visit, so a promotion whose enqueue failed still starts its run.
5. **Extract.** `transcribe-receipt` claims the row (`pending → processing`), downloads the image from storage, and makes **one** multimodal call to OpenRouter (`lib/ai/extract-receipt.ts`) straight to the fixed extraction contract (`lib/db/contract.ts`). The schema sent to the model is the contract plus a `transcript` field declared **first**, so the model writes what it read before it writes any field; the transcript is stripped before the flat receipt fields, the line items and the integrity warning are written, and the row is marked `done`. The warning is raised when the line items do not reconcile against the stated total. A response that fails the schema keeps its raw text as the transcript of a first extraction — that is the only record of what the image said — and fails the run.
6. **Categorize.** Extraction emits `receipt/extracted`; `categorize-receipt` loads the line items and the seeded leaf taxonomy, asks the model for one category per item, writes the assignments, and stamps `categorized_at`. Because the taxonomy is a derived layer, a re-run reapplies it to every item whose `category_source` is `ai`; an item the owner categorised by hand is `user` and is skipped, because that is a decision rather than a draft (see [ADR-0010](docs/adr/0010-user-set-categories-are-decisions.md)).
7. **Notify the UI.** Throughout, the function publishes `extracting` / `storing` / `done` / `failed` on the owner's realtime channel, carrying the receipt id so the table can route each message to its row. There is no separate parsing state: reading and structuring are one call.

Each step is memoized by Inngest, so a crash or retry resumes rather than restarts.

### Processing status lifecycle

```
uploading ──▶ pending ──▶ processing ──▶ done
                                 │
                                 └──▶ error
```

`uploading` means the row exists and a presigned URL was issued; the browser may not have uploaded yet. `pending` means the server verified the object is in storage. `processing` is the claim that a run owns the row — the guard against two concurrent runs. `done` and `error` are terminal.

A failed upload is not the same as a failed extraction: a row that reconciliation finds objectless becomes `error`, and the owner deletes it from the row menu and uploads the photo again — there is no retry route (ADR-0021).

### Realtime

Each owner has a channel `user:<ownerId>` (ADR-0012). Workers publish on it via `step.realtime.publish`, carrying `{ receiptId, state }` so one message addresses one row; the receipts page opens a single `useRealtime` subscription (`components/receipts/receipts-realtime.tsx`) with a token minted by `fetchReceiptsSubscriptionToken`, which derives the channel from the session rather than from any id the caller supplies. The table and the upload toast read that one stream, so they agree by construction, and a page with fifty queued receipts still holds one connection.

### Chat

`/` is the front door and streams from `POST /api/chat`. The route authenticates, validates the client-supplied messages with `validateUIMessages`, strips every tool result except `ask_user` (a crafted request must not be able to talk the model into reporting figures no tool produced), resolves the requested model through the app-owned catalogue, builds a per-request `ToolLoopAgent`, and streams back.

The agent has six tools: five owner-scoped read-only queries over the database (`list_receipts`, `receipt_detail`, `search_line_items`, `spend_by_category`, `spend_by_merchant`) plus `ask_user`, a clarifying question the UI answers. `buildChatTools(ownerId, today)` closes the owner over server-side, so no tool takes an owner argument and the model can never supply one. Chat history is client-side only; a reload loses the thread.

The model picker in the composer footer lists what `lib/chat/catalogue.ts` offers — in a deployment, one OpenRouter model; in local development, that model plus LM Studio's `local` entry if a key is set, or `local` alone if it is not. The route refuses any model outside the catalogue before a provider is constructed.

## Running it locally

Prerequisites: Docker, Node 26, `pnpm`, and an `OPENROUTER_API_KEY` — extraction has no local fallback, so a receipt cannot be read without one.

1. Start the backing services.
   ```bash
   docker compose up
   ```
   That brings up Postgres (`localhost:5432`), RustFS (API `localhost:9000`, console `localhost:9001`), `rustfs-init`, and the Inngest dev server (`localhost:8288`). It does **not** start the app.

2. Create `.env.local` (gitignored) — see [Configuration](#configuration). At minimum: `OPENROUTER_API_KEY`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `INVITE_CODE`, `INNGEST_DEV=1`, `INNGEST_BASE_URL=http://localhost:8288`, and the storage credentials the compose stack creates.

3. Apply migrations and run the app.
   ```bash
   pnpm install
   pnpm db:migrate
   pnpm dev
   ```

The app is at `http://localhost:3000`, bound to `0.0.0.0` so the containers can reach it. RustFS's webhook and the Inngest dev server both point at `host.docker.internal:3000`, so the app must be up before an upload can complete.

Optionally, for the chat picker's `local` entry, run LM Studio with an OpenAI-compatible model at `http://localhost:1234/v1`:

```bash
lms daemon up
lms load google/gemma-4-e4b --context-length 8192
lms server start --port 1234
```

Nothing in the receipt pipeline uses it: extraction and categorization always call OpenRouter, and the `local` entry cannot read an image.

Seeded demo data is available, but deliberately in a separate database:

```bash
docker exec receipt-app-postgres-1 createdb -U postgres receipts_seed
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/receipts_seed pnpm db:migrate
pnpm db:seed
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/receipts_seed pnpm dev
```

For a deterministic, sign-in-able account with a curated receipt corpus, use `pnpm db:fixture --apply` instead (ADR-0013). It writes to the database `DATABASE_URL` names, prints its credentials, and is a dry run without `--apply`.

## Configuration

Most values fall back to a working local default. The rows marked `—` have none and must be set in `.env.local` before the matching subsystem works.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/receipts` | Postgres connection — Neon's **pooled** string in production |
| `BETTER_AUTH_URL` | — | Public app origin |
| `BETTER_AUTH_SECRET` | — | Auth signing secret |
| `INVITE_CODE` | — | Shared code required to register. Unset means registration is closed |
| `STORAGE_ENDPOINT` | `localhost:9000` | Storage as the app reaches it |
| `STORAGE_PUBLIC_ENDPOINT` | `STORAGE_ENDPOINT` | Storage as the browser sees it (presigned URLs are signed for this host). R2's S3 endpoint in production, because R2 does not sign custom domains |
| `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` | `rustfsadmin` (does **not** match local compose — see below) | The storage credentials |
| `STORAGE_BUCKET` | `receipts` | Bucket holding receipt images |
| `STORAGE_WEBHOOK_SECRET` | — | Bearer token RustFS sends on its bucket notifications. Local development only: unset, the webhook path refuses every Bearer call. Production does not set it, because the upload confirmation there is the browser's session-authenticated call |
| `OPENROUTER_API_KEY` | — | App-owned credential for chat, extraction and categorization. Extraction has no fallback without it |
| `EXTRACT_MODEL` | `deepseek/deepseek-v4.1-flash-1017` | Model that reads the image and returns the extraction contract |
| `CATEGORIZE_MODEL` | `EXTRACT_MODEL` | Model for categorization |
| `LM_STUDIO_URL` | `http://localhost:1234/v1` | Local model server — chat's `local` entry only; extraction does not use it |
| `INNGEST_DEV` | — | Set to `1` to talk to the local dev server instead of Inngest Cloud. Required locally, or the SDK assumes Cloud and wants an event key |
| `INNGEST_BASE_URL` | — | The local Inngest dev server, `http://localhost:8288`. Paired with `INNGEST_DEV=1` |
| `SEED_DATABASE_URL` | `…/receipts_seed` | Target for `pnpm db:seed` |
| `DEV_TIMEZONE` | — | Optional, development only: the zone to pretend the viewer is in, standing in for the header Vercel would add (ADR-0016) |

Production adds `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` (written by the Inngest Vercel integration), `INNGEST_SERVE_ORIGIN`, and `ENABLE_EXPERIMENTAL_COREPACK=1`. See [Deployment](#deployment).

### Local storage credentials must match the stack

The code default of `rustfsadmin` is a leftover placeholder, not a working local identity — nothing in `docker-compose.yml` creates that user, so storage calls fail against the stack above with an auth error. `rustfs-init` creates the app's least-privilege identity, and your `.env.local` must name it:

```bash
STORAGE_ACCESS_KEY=receipts-app
STORAGE_SECRET_KEY=receipts-app-dev-secret
```

Those are the values `docker-compose.yml` provisions locally. Root credentials (`receipt-app` / `possum123`) work too, since root bypasses IAM, but they are for `rustfs-init` and the console — never for the app. Production uses R2's object-scoped token instead, scoped to the `receipts` bucket.

## Commands

```bash
pnpm dev          # dev server on 0.0.0.0:3000
pnpm build        # production build (applies migrations on Vercel production only)
pnpm test         # Vitest
pnpm typecheck    # tsc --noEmit
pnpm lint         # ultracite check
pnpm fix          # ultracite fix — auto-fixes most issues

pnpm db:generate  # generate a migration from the Drizzle schema
pnpm db:migrate   # apply migrations
pnpm db:push      # push the schema without a migration
pnpm db:studio    # Drizzle Studio
pnpm db:seed      # reset + seed the dedicated seed database with demo data
pnpm db:fixture   # provision the test fixture account (dry run unless --apply)

pnpm categorize:backfill   # queue categorization for receipts with no stamp
pnpm eval:chat             # real-model chat evals (needs Postgres and a model)
```

Before committing: `pnpm fix` → `pnpm typecheck` → `pnpm test`. The pre-commit hook runs the tests and re-stages anything the formatter changed.

## Project layout

```
app/
  (auth)/              sign-in, sign-up
  (app)/               chat (/), /receipts, /receipts/[id], /overview
  api/
    upload/            create a row + presign
    storage-events/    confirm an upload (browser) or receive the RustFS webhook
    receipts/[id]/image/  stream the image from storage
    chat/              agent stream
    inngest/           function registry for Inngest
    auth/[...all]/     Better Auth
components/            chat UI (with one renderer per tool part), receipts table, charts
hooks/                 small client hooks (viewport breakpoint, mounted flag)
lib/
  ai/                  provider, models, extract-receipt, categorize, usage
  chat/                agent, tools, queries, output schemas, trust boundary, catalogue
  db/                  Drizzle client, schema, queries, contract, seed, fixtures
  images/              browser-side compression
  inngest/             client, channels, functions
  receipt/             integrity, line-item money, datetime
  security/            CSP
  storage/             S3 client, content types, upload signal, storage-event adapter
docs/adr/              architecture decision records
docs/guides/           deployment-adjacent setup guides
scripts/               backfill, fixtures, production migrations
evals/                 real-model chat evals
```

`lib/db/schema/` is the source of truth for domain types; derive new ones with Drizzle's Zod helpers rather than re-declaring fields.

## Deployment

Production is a **Vercel Hobby** project deploying `main`, with functions pinned to `syd1` by `vercel.json`. Postgres is **Neon** in Sydney, images are in a private **Cloudflare R2** bucket, the workflow runs on **Inngest Cloud**, and every model call goes to **OpenRouter**. The site is `receipts.tribi.dev`. [ADR-0023](docs/adr/0023-production-on-vercel-hobby.md) records the decision; the move itself was [the Wayfinder map](https://github.com/Kevin-RB/possum-receipt/issues/240).

- **DNS stays direct.** `receipts.tribi.dev` is a DNS-only CNAME, not a Cloudflare-proxied record. Two headers depend on it: `x-vercel-ip-timezone` resolves "today" (ADR-0016), and `x-forwarded-for` — which Vercel overwrites and refuses to forward from outside — is the client IP the sign-up rate limit trusts.
- **Migrations run in the build, before the new code serves.** `pnpm build` starts with `tsx scripts/migrate-production.ts`, gated on `VERCEL_ENV === "production"`. A failed migration fails the deploy and the previous deployment keeps answering; a preview or a local build skips the step entirely, so it can never migrate the database it points at. Migrations never run at app startup — serverless instances start many times per deployment, concurrently.
- **Environment variables live in the Vercel project's Production scope** and must be available to the **Build** step as well as at runtime, because `proxy.ts` is compiled for the edge and inlines `STORAGE_PUBLIC_ENDPOINT`. The full list is in `AGENTS.md`; `OPENROUTER_API_KEY` is the one required secret the app owns, and `STORAGE_WEBHOOK_SECRET` is deliberately absent.
- **Deploys** are a PR → merge to `main` → Vercel deploys that commit. Feature work lands on `staging` first, and a `staging → main` promotion is the only path to production. Rollback is **Instant Rollback** in Vercel, one click — which does not roll the database back, so it only works while the older code still fits the current schema.
- **No Docker image is built.** Local development uses `docker compose` for the backing services only; the app itself is Vercel's Next.js build in production and `pnpm dev` locally.
- **Backups are not configured yet.** A nightly `pg_dump` to a separate, locked R2 bucket — with one restore performed — is [#253](https://github.com/Kevin-RB/possum-receipt/issues/253). Until it lands, production has no automatic backup.

## Further reading

- `CONTEXT.md` — the domain language. Read this before naming anything.
- `AGENTS.md` — repo conventions, deployment detail, and gotchas.
- `docs/adr/` — why the architecture is shaped this way, especially:
  - `0001` upload via presigned URL
  - `0002` server actions for user mutations
  - `0008` persist the extraction transcript
  - `0009` categories are derived and re-runnable
  - `0012` one realtime channel per owner
  - `0016` "today" is the viewer's clock
  - `0017` app-owned provider keys and a curated model catalogue
  - `0019` security headers and a report-only CSP
  - `0020` app-owned storage events, one adapter per provider
  - `0021` upload-finished is verified, not notified
  - `0022` extraction is one OpenRouter call
  - `0023` production on Vercel Hobby, with Neon and R2
  - `0005` and `0006` — the Coolify and RustFS deployments this replaced; historical
