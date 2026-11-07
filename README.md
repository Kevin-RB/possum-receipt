# possum

A local-first web app that turns photos of paper receipts into structured, persisted data.

You upload a receipt photo; a durable background workflow reads the text off it, parses that into a fixed contract, and stores the result next to the image. The same data powers a chat assistant that answers questions about your own spending, a receipts table, and spending charts.

Everything runs on your own hardware: the models are local, the database is Postgres, and the images live in an S3-compatible bucket on your machine.

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
| Database | Postgres 18 via Drizzle ORM |
| Object storage | RustFS (S3-compatible), `aws-sdk` v3 client, presigned URLs |
| Background work | Inngest durable functions + Inngest Realtime |
| Models | LM Studio, OpenAI-compatible endpoint, via the AI SDK |
| Auth | Better Auth (email + password, invite-code gated) |
| Tests | Vitest |

## Architecture

### The pieces

There are five moving parts. Only one of them is part of this repository.

```
                       ┌──────────────────────────────┐
   Browser  ──────────▶ │  Next.js app (this repo)     │
     ▲                  │  pages · API routes ·        │
     │                  │  server actions · Inngest    │
     │                  │  functions · AI SDK calls    │
     │                  └──────┬────────────┬──────────┘
     │                         │            │
     │  presigned PUT          │ SQL        │ OpenAI-compatible
     │  (direct, no creds)     │            │ HTTP
     │                         ▼            ▼
     │                  ┌────────────┐  ┌──────────────────┐
     └───────────────── │  RustFS    │  │  LM Studio       │
      images + SSE      │  objects   │  │  OCR + LLM       │
                        └─────┬──────┘  └──────────────────┘
                              │  bucket notification
                              │  POST /api/storage-events
                              ▼
                        ┌────────────┐
                        │  Inngest   │──── execute ────▶ back into the app
                        └────────────┘                  (functions run in-process)
                              ▲
                              │ send events
                        ┌─────┴──────┐
                        │  Postgres  │
                        └────────────┘
```

- **Next.js app** — UI, HTTP API, server actions, the Inngest function definitions, and every call to Postgres, RustFS, and LM Studio. In development it runs on the host; in production it is a standalone non-root Node server. It is the only component in the repo.
- **Browser** — never sees a storage credential. It asks the app for a presigned URL and PUTs the image itself, then subscribes to a realtime channel for progress.
- **RustFS** — S3-compatible object storage for receipt images. Notifies the app over HTTP when an object lands.
- **Inngest** — the durable execution layer. Holds event history, drives retries, and fans out to the function definitions hosted in the app. In development it runs as a container; in production it is Inngest Cloud.
- **LM Studio** — local OpenAI-compatible model server. Two jobs: OCR (vision) and text work (parsing, categorization, chat).
- **Postgres** — the single source of truth. Holds receipts, line items, the category taxonomy, and auth tables.

### How services talk to each other

| From | To | Mechanism | Notes |
| --- | --- | --- | --- |
| Browser | App | HTTPS: page loads, `POST /api/upload`, `POST /api/chat`, server actions | Session cookie; `proxy.ts` does an optimistic cookie check, real checks happen in layouts and per route |
| Browser | RustFS | HTTPS `PUT` to a presigned URL | Direct, credential-free, one object key, 5-minute expiry |
| Browser | Inngest | SSE subscription over a realtime channel | One channel per owner (`user:<id>`); token minted by a server action from the session |
| App | Postgres | `pg` over TCP | Drizzle; every query is owner-scoped |
| App | RustFS | S3 API (`GetObject`, `PutObject`, `DeleteObject`, presign) | App authenticates as a least-privilege IAM user, not root |
| App | LM Studio | OpenAI-compatible HTTP (`/v1/chat/completions`) | AI SDK with `structuredOutputs`; model ids come from `GET /v1/models` |
| App | Inngest | `inngest.send(...)` | Events are the only coupling between producers and workers |
| Inngest | App | HTTP to `/api/inngest` | In dev the dev server polls the app's function definitions; in prod, Cloud invokes them |
| RustFS | App | `POST /api/storage-events` | Bucket notification, authenticated with `Authorization: Bearer $STORAGE_WEBHOOK_SECRET` |
| RustFS-init | RustFS | Admin API, one-shot | Creates the bucket, the notification rule, the IAM user, and its policy |

Two boundaries are worth calling out, because they are the reason the pipeline is shaped the way it is:

**Object storage is the authority on "the upload finished."** The app never confirms its own presigned URL; a receipt sitting in `uploading` means "the browser may or may not have PUT yet." RustFS says so by calling the webhook, and that call is what starts extraction.

**Workers live in the app, but the app is not the only thing that talks to them.** The functions are registered at `/api/inngest`, and anything that can name an event — a route, a server action, or a one-off script — can queue work. That is what lets a backfill run from a separate container without the app being restarted or aware of it.

### The receipt pipeline, end to end

1. **Compress.** The browser downscales the chosen photo to a 2000px longest edge and re-encodes it as JPEG (`lib/images/compress-receipt-image.ts`). EXIF orientation is baked in, so phone photos do not land sideways.
2. **Request an upload slot.** `POST /api/upload` validates the declared content type and size, inserts a receipt row with `status = 'uploading'` and an object key namespaced `users/<userId>/<uuid>.<ext>`, and returns a presigned PUT URL.
3. **Upload.** The browser PUTs the bytes straight to RustFS. Storage credentials never leave the server.
4. **Notification.** RustFS POSTs a bucket event to `/api/storage-events`, authenticated by the shared secret. The handler promotes the row `uploading → pending` and sends `receipt/uploaded` with a deterministic event id, so redelivery is deduped by Inngest rather than starting a second run. A non-2xx makes RustFS retry, and the retry re-enqueues instead of losing the extraction.
5. **Extract.** `transcribe-receipt` claims the row (`pending → processing`), downloads the image, and OCRs it with the vision model. The transcript is written as soon as it exists — if parsing then fails, it is the only evidence of what the image said. Next the transcript is parsed into the fixed extraction contract (`lib/db/contract.ts`) and validated against it, and in a final step the flat receipt fields, the line items, and the integrity warning are written and the row marked `done`. The warning is raised when the line items do not reconcile against the stated total.
6. **Categorize.** Extraction emits `receipt/extracted`; `categorize-receipt` loads the line items and the seeded leaf taxonomy, asks the model for one category per item, writes the assignments, and stamps `categorized_at`. Because the taxonomy is a derived layer, a re-run reapplies it to every item whose `category_source` is `ai`; an item the owner categorised by hand is `user` and is skipped, because that is a decision rather than a draft (see [ADR-0010](docs/adr/0010-user-set-categories-are-decisions.md)).
7. **Notify the UI.** Throughout, the function publishes `extracting` / `parsing` / `storing` / `done` / `failed` on the owner's realtime channel, carrying the receipt id so the table can route each message to its row.

Each step is memoized by Inngest, so a crash or retry resumes rather than restarts.

### Processing status lifecycle

```
uploading ──▶ pending ──▶ processing ──▶ done
                                 │
                                 └──▶ error
```

`uploading` means the row exists and a presigned URL was issued; the browser may not have uploaded yet. `pending` means object storage confirmed the write. `processing` is the claim that a run owns the row — the guard against two concurrent runs. `done` and `error` are terminal.

A failed upload is not the same as a failed extraction: a receipt can be re-signed (`POST /api/upload/[receiptId]/retry`) for as long as it sits in `uploading`.

### Realtime

Each owner has a channel `user:<ownerId>` (ADR-0012). Workers publish on it via `step.realtime.publish`, carrying `{ receiptId, state }` so one message addresses one row; the receipts page opens a single `useRealtime` subscription (`components/receipts/receipts-realtime.tsx`) with a token minted by `fetchReceiptsSubscriptionToken`, which derives the channel from the session rather than from any id the caller supplies. The table and the upload toast read that one stream, so they agree by construction, and a page with fifty queued receipts still holds one connection.

### Chat

`/` is the front door and streams from `POST /api/chat`. The route authenticates, validates the client-supplied messages with `validateUIMessages`, strips every tool result except `ask_user` (a crafted request must not be able to talk the model into reporting figures no tool produced), builds a per-request `ToolLoopAgent`, and streams back.

The agent has six tools: five owner-scoped read-only queries over the database (`list_receipts`, `receipt_detail`, `search_line_items`, `spend_by_category`, `spend_by_merchant`) plus `ask_user`, a clarifying question the UI answers. `buildChatTools(ownerId)` closes the owner over server-side, so no tool takes an owner argument and the model can never supply one. Chat history is client-side only; a reload loses the thread.

## Running it locally

Prerequisites: Docker, Node 26, `pnpm`, and LM Studio with a model loaded.

1. Start LM Studio and load an OpenAI-compatible model at `http://localhost:1234/v1`.
   ```bash
   lms daemon up
   lms load glm-ocr
   lms load google/gemma-4-e4b --context-length 8192
   lms server start --port 1234
   ```
   Use the exact ids from `GET /v1/models` — quant suffixes are stripped (`glm-ocr`, not `glm-ocr@q8_0`).

2. Start the backing services.
   ```bash
   docker compose up
   ```
   That brings up Postgres (`localhost:5432`), RustFS (API `localhost:9000`, console `localhost:9001`), `rustfs-init`, and the Inngest dev server (`localhost:8288`). It does **not** start the app.

3. Create `.env.local` (gitignored) — see [Configuration](#configuration).

4. Apply migrations and run the app.
   ```bash
   pnpm install
   pnpm db:migrate
   pnpm dev
   ```

The app is at `http://localhost:3000`, bound to `0.0.0.0` so the containers can reach it. RustFS's webhook and the Inngest dev server both point at `host.docker.internal:3000`, so the app must be up before an upload can complete.

Seeded demo data is available, but deliberately in a separate database:

```bash
docker exec receipt-app-postgres-1 createdb -U postgres receipts_seed
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/receipts_seed pnpm db:migrate
pnpm db:seed
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/receipts_seed pnpm dev
```

## Configuration

Most values fall back to a working local default. The rows marked `—` have none and must be set in `.env.local` before the matching subsystem works.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/receipts` | Postgres connection |
| `BETTER_AUTH_URL` | — | Public app origin (required in production) |
| `BETTER_AUTH_SECRET` | — | Auth signing secret (required in production) |
| `INVITE_CODE` | — | Shared code required to register. Unset means registration is closed |
| `STORAGE_ENDPOINT` | `localhost:9000` | RustFS, reached from the app |
| `STORAGE_PUBLIC_ENDPOINT` | `STORAGE_ENDPOINT` | RustFS as the browser sees it (presigned URLs are signed against this host) |
| `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` | `rustfsadmin` (does **not** match local compose — see below) | The app's IAM identity — least privilege, not root |
| `STORAGE_BUCKET` | `receipts` | Bucket holding receipt images |
| `STORAGE_WEBHOOK_SECRET` | — | Bearer token RustFS sends on bucket notifications |
| `LM_STUDIO_URL` | `http://localhost:1234/v1` | Local model server |
| `ORC_MODEL` | `glm-ocr` | Vision model for transcription |
| `PARSE_MODEL` | `google/gemma-4-e4b` | Model that turns a transcript into the contract |
| `CATEGORIZE_MODEL` | `PARSE_MODEL` | Model for categorization |
| `OPENROUTER_API_KEY` | — | App-owned credential for remote chat models. Unset means chat runs on the local model only |
| `INNGEST_DEV` | — | Set to `1` to talk to the local dev server instead of Inngest Cloud. Required locally, or the SDK assumes Cloud and wants an event key |
| `INNGEST_BASE_URL` | — | The local Inngest dev server, `http://localhost:8288`. Paired with `INNGEST_DEV=1` |
| `SEED_DATABASE_URL` | `…/receipts_seed` | Target for `pnpm db:seed` |

### Storage credentials must match the stack

The code default of `rustfsadmin` is a leftover placeholder, not a working local identity — nothing in `docker-compose.yml` creates that user, so storage calls fail against the stack above with an auth error. `rustfs-init` creates the app's least-privilege identity, and your `.env.local` must name it:

```bash
STORAGE_ACCESS_KEY=receipts-app
STORAGE_SECRET_KEY=receipts-app-dev-secret
```

Those are the values `docker-compose.yml` provisions locally. Root credentials (`receipt-app` / `possum123`) work too, since root bypasses IAM, but they are for `rustfs-init` and the console — never for the app.

## Commands

```bash
pnpm dev          # dev server on 0.0.0.0:3000
pnpm build        # production build
pnpm test         # Vitest
pnpm typecheck    # tsc --noEmit
pnpm lint         # ultracite check
pnpm fix          # ultracite fix — auto-fixes most issues

pnpm db:generate  # generate a migration from the Drizzle schema
pnpm db:migrate   # apply migrations
pnpm db:push      # push the schema without a migration
pnpm db:studio    # Drizzle Studio
pnpm db:seed      # reset + seed the dedicated seed database

pnpm categorize:backfill   # queue categorization for receipts with no stamp
```

Before committing: `pnpm fix` → `pnpm typecheck` → `pnpm test`. The pre-commit hook runs the tests and re-stages anything the formatter changed.

## Project layout

```
app/
  (auth)/              sign-in, sign-up
  (app)/               chat (/), /receipts, /receipts/[id], /overview
  api/
    upload/            create a row + presign, and retry a stuck upload
    storage-events/    RustFS bucket notification
    receipts/[id]/image/  serve the image (presigned GET)
    chat/              agent stream
    inngest/           function registry for the dev server
    auth/[...all]/     Better Auth
components/            chat UI (with one renderer per tool part), receipts table, charts
hooks/                 small client hooks (viewport breakpoint, mounted flag)
lib/
  ai/                  provider, models, transcribe, categorize
  chat/                agent, tools, queries, output schemas, trust boundary
  db/                  Drizzle client, schema, queries, contract, seed, fixtures
  images/              browser-side compression
  inngest/             client, channels, functions
  receipt/             integrity, line-item money, datetime
  storage/             S3 client, content types, event schema
docs/adr/              architecture decision records
scripts/               backfill, fixtures, deploy wait, LM Studio check, production boot
```

`lib/db/schema/` is the source of truth for domain types; derive new ones with Drizzle's Zod helpers rather than re-declaring fields.

## Deployment

Production is a single Coolify **Compose** resource defined in `docker-compose.coolify.yml`, running on a Mac mini behind a Cloudflare tunnel.

- **Images** build from the repo `Dockerfile` with three targets: `runner` (the app), `migrator` (one-shot `pnpm db:migrate` at deploy), and `toolbox` (a long-lived idle container that exists only to be exec'd into for on-demand jobs).
- **Migrations never run at app startup.** The `migrate` service completes successfully before the app starts, so the server never runs ahead of the schema.
- **Secrets are Coolify magic variables**, generated per environment. The repo holds no credentials. The app authenticates to storage as a least-privilege IAM user created by `rustfs-init`; root credentials are used only by init and the console.
- **The Cloudflare tunnel is the only public ingress.** Postgres and RustFS publish host ports for LAN/tailnet admin access only.
- **Deploys** are a PR → merge to `main` → the Coolify GitHub App auto-deploys. Rollback is one click in Coolify.

Backups are configured per environment in the Coolify UI: a volume backup of `postgres-data` plus a `pg_dump` scheduled task whose command ends in `pg_restore -l`, so the task's exit status is a real validation. Both are same-host — they protect against a bad deploy, not against losing the machine. Off-box storage is the planned destination and is not yet configured. `rustfs-data` is not backed up.

## Further reading

- `CONTEXT.md` — the domain language. Read this before naming anything.
- `AGENTS.md` — repo conventions, deployment detail, and gotchas.
- `docs/adr/` — why the architecture is shaped this way, especially:
  - `0001` upload via presigned URL
  - `0002` server actions for user mutations
  - `0005` Coolify deployment
  - `0006` migrate object storage to RustFS
  - `0008` persist the OCR transcript
  - `0009` categories are derived and re-runnable