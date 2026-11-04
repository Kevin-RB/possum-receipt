<!-- intent-skills:start -->

## Skill Loading

Before editing files for a substantial task:

- Run `pnpm dlx @tanstack/intent@latest list` from the workspace root to see available local skills.
- If a listed skill matches the task, run `pnpm dlx @tanstack/intent@latest load <package>#<skill>` before changing files.
- Use the loaded `SKILL.md` guidance while making the change.
- Monorepos: when working across packages, run the skill check from the workspace root and prefer the local skill for the package being changed.
- Multiple matches: prefer the most specific local skill for the package or concern you are changing; load additional skills only when the task spans multiple packages or concerns.

<!-- intent-skills:end -->

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Agent skills

Use the repo-specific skill docs for workflows:

- `docs/agents/issue-tracker.md` — GitHub Issues via `gh`.
- `docs/agents/triage-labels.md` — canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`).
- `docs/agents/domain.md` — how to consume `CONTEXT.md` and `docs/adr/`.

When a plan, spec, or conversation becomes issues, load the **`to-tickets`** skill. It owns the ticket shape and requires each blocking edge to be a native issue dependency — a `## Blocked by` line in the body is not enough, and must not be added when the native edge exists.

This is a **single-context** repo: read `CONTEXT.md` at the root and `docs/adr/` for decisions. (The multi-context example in `docs/agents/domain.md` is a template; this repo has no `apps/` or `packages/` hierarchy.)

### MCP servers

MCP servers live in the **global** config, `~/.config/opencode/opencode.jsonc`, not in this repo's `opencode.json`. Configs merge rather than replace, so a global entry still resolves inside a project. They are machine-level by nature: `chrome-devtools` and `paper` both point at a localhost port, and `coolify` at a private LAN address — none of which resolve for anyone who clones this repo, which is why they are not committed.

One consequence worth knowing: a config file cannot carry a secret, so `coolify` reads its credential from the environment.

- `COOLIFY_API_KEY` — **required.** Export it in whichever shell launches OpenCode (`export COOLIFY_API_KEY=...`, or the equivalent in your shell profile). Without it the server still reports as connected, but every tool call fails on auth, because there is nothing to send in the `Authorization` header.

Confirm the set with `opencode mcp list`.

---

## Design principles

- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.

---

## Developer commands

Use `pnpm` (package manager is pinned to `pnpm@12.15.0` in `packageManager`).

- `pnpm install` — install dependencies.
- `pnpm dev` — Next.js dev server, bound to `0.0.0.0`.
- `pnpm build` — production build.
- `pnpm start` — production start, bound to `0.0.0.0`.
- `pnpm typecheck` — `tsc --noEmit`.
- `pnpm test` — run the full Vitest suite.
- `pnpm lint` — `ultracite check`.
- `pnpm fix` — `ultracite fix` (auto-fixes most issues).
- `pnpm db:generate` / `pnpm db:migrate` / `pnpm db:push` / `pnpm db:studio` / `pnpm db:seed` — Drizzle operations.
- `pnpm db:fixture [--email <address>] [--apply] [--force]` — provision a deterministic, sign-in-able test account with a curated receipt corpus (dry run unless `--apply`; `--email` defaults to the agent test account; requires `NODE_ENV=development` or `test`, which `.env.local` supplies). See ADR-0013.
- `pnpm categorize:backfill` — queue categorization for done receipts that have no `categorized_at` stamp (idempotent; sends `receipt/extracted` to Inngest).
- `pnpm eval:chat` — real-model chat evals: eleven scenarios x 3 runs against the fixture account, printing a pass-rate table and writing `evals/results/latest.json` (gitignored). Needs Postgres and LM Studio; never run in CI. See Testing.

Before committing, run the checks in this order:

1. `pnpm fix` (or `pnpm lint` if you want to see issues first)
2. `pnpm typecheck`
3. `pnpm test`

The pre-commit hook runs `pnpm test` and then `pnpm dlx ultracite fix` and re-stages any files it changed.

## GitHub operations

Always use the `gh` CLI for GitHub operations (`gh pr`, `gh issue`, `gh repo`, `gh release`, `gh auth`, etc.). Do not use raw `git push --force`, manual browser-based PR creation, or other approaches — use `gh`. Refer to `docs/agents/issue-tracker.md` for issue/PR conventions.

---

## Local development

The app is a single Next.js 16 App Router app. Backend services run in Docker; the Next.js app runs on the host.

1. Start **LM Studio** on the host and load an OpenAI-compatible model at `http://localhost:1234/v1`.
2. Start backing services: `docker compose up`.
   - Postgres: `localhost:5432` (database `receipts`).
   - RustFS: API `localhost:9000`, console `localhost:9001` (`/rustfs/console`).
   - Inngest dev server: `localhost:8288`.
3. In another shell, run `pnpm dev`. The app is at `http://localhost:3000`.

`docker compose up` only starts services; it does **not** start the Next.js app. The RustFS webhook and Inngest dev server point to `host.docker.internal:3000/api/...`, so the host app must be reachable at `localhost:3000`.

Local env defaults are in `.env.local` (which is gitignored). Key variables:

- `DATABASE_URL`, `STORAGE_ENDPOINT`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_WEBHOOK_SECRET`
- `INNGEST_DEV=1`, `INNGEST_BASE_URL=http://localhost:8288`
- `LM_STUDIO_URL`, `ORC_MODEL`, `PARSE_MODEL`, `CATEGORIZE_MODEL`, `CHAT_MODEL`
- `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `INVITE_CODE` (required to register)
- `DEV_TIMEZONE` (optional) — the zone local development pretends the viewer is in, standing in for the `cf-timezone` header Cloudflare would add. Read by `lib/viewer.ts`, honoured only when `NODE_ENV === "development"` and only when it names a real zone, so `pnpm start` and every deployed build ignore it. See ADR-0016.

## Production deployment (Coolify / `docker-compose.coolify.yml`)

The production stack (ADR-0005, ADR-0006) lives in `docker-compose.coolify.yml` and deploys as one Coolify **Compose** resource on the Colima VM. To validate locally on a Docker-capable host:

```
docker compose -f docker-compose.coolify.yml config
```

Key properties:

- **Secrets only in Coolify env vars** — credentials are generated by Coolify magic variables (`SERVICE_USER_RUSTFS`, `SERVICE_PASSWORD_64_POSTGRES` / `RUSTFS` / `RUSTFSWEBHOOK` / `STORAGE` / `BETTERAUTH`) and the repo holds no credentials. The app authenticates as the least-privilege IAM user `receipts-app` (created by `rustfs-init`, scoped to `Get/Put/DeleteObject` on the bucket); the root credentials are used only by `rustfs-init` and the console, never by the running app, because root bypasses IAM evaluation. Required non-credential vars: `POSTGRES_USER`, `POSTGRES_DB`, `STORAGE_BUCKET`, `STORAGE_PUBLIC_ENDPOINT`, `STORAGE_CORS_ORIGIN` (the app's browser origin, e.g. `https://receipts.tribi.dev`), `STORAGE_CONSOLE_HOST` (the tailnet host you open the console at, e.g. `apple-admins-mac-mini`; the console origin is derived from it plus `STORAGE_CONSOLE_HOST_PORT`), `BETTER_AUTH_URL`, `INVITE_CODE`, `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`. Optional: `LM_STUDIO_URL`, `ORC_MODEL`, `PARSE_MODEL`, `CATEGORIZE_MODEL`, `CHAT_MODEL`, plus per-environment admin host-port overrides `POSTGRES_HOST_PORT` (default `55432`), `STORAGE_CONSOLE_HOST_PORT` (default `59001`), and `STORAGE_API_HOST_PORT` (default `59000`) — prod and staging share one Docker host, so staging must override these to avoid host-port collisions. The S3/admin API is published on the host **only** so the RustFS console can reach it (the console is a browser app that calls the API on the server listener directly; unlike MinIO's console it does not proxy server-side). The app and rustfs-init still use the compose network, and presigned traffic still goes via Traefik.
- **Console** (ADR-0006): open `http://<mini-host>:${STORAGE_CONSOLE_HOST_PORT}` and, on first use, set the RustFS server address in the console's **Server Configuration** to `http://<mini-host>:${STORAGE_API_HOST_PORT}` (saved per browser; there is no env var for it). The console origin is derived (`http://${STORAGE_CONSOLE_HOST}:${STORAGE_CONSOLE_HOST_PORT}`) and allowlisted in `RUSTFS_CORS_ALLOWED_ORIGINS`, or the browser blocks the console's API calls; the console listener's own CORS is pinned to the same origin (instead of its default `*`).
- **Images build from the repo Dockerfile** with three targets: `runner` (the app, standalone non-root Next.js server), `migrator`, and `toolbox`. `migrator` and `toolbox` are the same contents (the `tooling` stage: `node_modules` + `lib/` + `scripts/`); `migrator` sets `ENTRYPOINT`, `toolbox` sets `CMD` (so `docker compose run --rm toolbox pnpm …` can override it). The one-shot `migrate` service runs `pnpm db:migrate`; the app starts only after it completes successfully.
- **On-demand jobs run in the `toolbox` container**, which exists only to be exec'd into — it sleeps and does no work of its own. Run them from Coolify, never from a laptop: **Terminal** on the `toolbox` container for an ad-hoc command, or a **Scheduled Task** (container `toolbox`, schedule **disabled**, triggered via _Execute Now_) when you want the output captured and kept in history. There is no port and nothing to expose.
  - Currently one job: the categorization backfill, `pnpm tsx ./scripts/backfill-categorization.ts`. Use that command **verbatim** — not `pnpm categorize:backfill`, which passes `--env-file-if-exists=.env.local`, and an env file in a deployed environment could point `INNGEST_BASE_URL` at a local dev server, making every event vanish while the script still reports success.
  - Why a long-lived container rather than a one-shot service behind a compose profile: Coolify's deploy runs plain `docker compose build --pull` then `up -d`, with the repo cloned to an ephemeral `/artifacts/<deployment_uuid>`. After the deploy, `/data/coolify/applications/<uuid>/` holds only Coolify's generated `.env` and compose file — not the source tree — so a one-shot service cannot be built or run from there by hand, and a profiled service is skipped by the deploy-time `build` too, leaving no image at all. A container that stays up sidesteps all of it: the image is built every deploy and the container is restarted by one.
  - The `toolbox` receives `DATABASE_URL` and `INNGEST_EVENT_KEY` from the same Coolify resource, so a prod event key cannot be aimed at the staging database. It does no categorization itself — it selects unstamped receipt ids and sends `receipt/extracted`, and the work lands in the `app` container's Inngest worker — which is why no LM Studio, storage, or signing key is passed to it.
  - Backfills are idempotent (only `status = 'done' AND categorized_at IS NULL` is selected), so re-running picks up whatever is left. Running it twice in quick succession re-queues receipts still in flight; the function just re-categorizes and re-stamps them.
- **Data**: `postgres-data`, `backups-data`, `rustfs-data`, and `rustfs-logs` named volumes. No publicly-exposed host ports — the app publishes none at all, and postgres/rustfs publish admin ports (the `55432`/`59000`/`59001` family, per-environment overrides above) on the mini's interfaces for LAN/tailnet use only. The Cloudflare tunnel is the only public ingress: one wildcard route `*.tribi.dev → http://localhost:80` hits the Coolify Traefik proxy (T15), which routes by domain to the app/rustfs services. `coolbox.tribi.dev` (Coolify admin) and the other non-app hostnames sit behind a Cloudflare Access gate (T16).
- **Edge hardening (follow-up, not yet applied):** add a Cloudflare WAF custom rule on the storage hostnames (`uploads.tribi.dev`, `uploads-staging.tribi.dev`) allowing only `/receipts/*` — path-based, so not spoofable (an `Origin`-based rule would be). This blocks the admin API (`/rustfs/admin/*`) and internode RPC (`/rustfs/rpc/*`, `/rustfs/peer/*`) from the public host; unsigned requests are already 403, so it only removes surface. Note: the storage hostnames must still bypass Cloudflare **Access** (presigned PUTs are unauthenticated by signature, not by login).
- **Viewer timezone prerequisite (enabled, and not optional):** the page-side answer to "what day is it" comes from `cf-timezone`, which Cloudflare only sends when the zone's **Add visitor location headers** Managed Transform is on (**Rules → Settings → Managed Transforms**). It is off by default and per zone — enabled for `tribi.dev`, which covers prod and staging. If it is ever turned off, nothing errors: every surface falls back to the account's zone and then Brisbane, together — the app is simply wrong about a traveller. `lib/viewer.ts` warns once per process (`[viewer-timezone]`) when a production request arrives without the header, so the absence shows up in the app log instead of nowhere: check for that line after any zone or hostname change. The transform also adds nine other location headers (`cf-ipcity`, `cf-ipcountry`, `cf-region`, lat/long, postal code, …) to every origin request. Local development has no Cloudflare, so `lib/viewer.ts` stands in for the edge: `DEV_TIMEZONE=America/Bogota pnpm dev` answers with that zone when the header is absent, and every surface then resolves as it does in a deployment — charts, filters, edit form and chat. Without it, every surface falls back to the account's zone and then Brisbane.
- **Backups**: two independent mechanisms, both configured per-environment in the Coolify UI. **Both are same-host** — they protect against a bad deploy or a deleted volume, not against losing the mini. Off-box storage (external S3/B2) is the planned destination and is deliberately deferred; see ADR-0005.
  1. **Volume backup** — Coolify's storage backup on `postgres-data`, landing in `/data/coolify/backups/volumes/…` as a `tar.gz` of the whole data directory. Complete (all databases, roles, extensions) and restores by untarring over a fresh volume on the same `postgres:18-alpine` image, so it is **not portable across major versions**. Configure it _without_ "stop the container": stopping would make the archive consistent, but it costs service interruption, so the archive is a live-database copy. That is acceptable only because mechanism 2 exists — see the note below.
  2. **`pg_dump`** — a Coolify **Scheduled Task** whose container is `postgres` and whose command is:
     ```sh
     D=$POSTGRES_DB;T=$(date +%F-%H%M);pg_dump -U$POSTGRES_USER -Fc -f /backups/$D-$T.dump $D;pg_dumpall -U$POSTGRES_USER -g -f /backups/$D-$T.sql;find /backups -type f -mtime +14 -delete;pg_restore -l /backups/$D-$T.dump>/dev/null&&echo dump-ok
     ```
     `backups-data` is mounted at `/backups` in the `postgres` service for this.
     - **The order is load-bearing, and the last command must be the validation.** Coolify marks an execution failed only when the command exits non-zero, and a `;`-separated shell returns the status of its _final_ command. Ending on `find` (which exits 0 even when it cannot read the directory) makes every failure look green in the task list — a silent regression that makes the task's own status worthless. Ending on `pg_restore -l … && echo dump-ok` means the exit code _is_ the health check: bad archive → non-zero → Coolify shows **failed**. Both signals now agree, so either the task list or the message is enough.
     - `pg_restore -l` reads the archive's table of contents without needing a database and exits non-zero on a bad or truncated file, so it catches what a file listing cannot: a corrupt archive, or the zero-byte file a failed `pg_dump` leaves behind.
     - **The command is squeezed to fit Coolify's `scheduled_tasks.command` column, which is `varchar(255)`.** A longer, readable version fails the save outright with `SQLSTATE[22001]: value too long for type character varying(255)`. This one is 240. What buys the room: `D=`/`T=` for the repeated `$POSTGRES_DB`, `pg_dumpall -g` for `--globals-only`, `pg_restore -l` for `--list`, unquoted expansions (no generated value contains whitespace), and a `find` with no `-name` filter, which is safe because `backups-data` holds nothing but these artefacts. Do not "tidy" it back into something longer, and do not reorder it.
     - `pg_dumpall -g` is what makes a logical restore possible — without roles, a restore yields a database with no owner. Its exit status is _not_ the command's, so a roles-only failure would still show green; the dump is the artefact that matters and the one that is validated.
     - The prune is `;`-chained, so retention still runs when a dump fails and the volume cannot grow without bound.
  - **Why both, and not just the volume backup.** They fail differently. `pg_dump` takes an MVCC snapshot, so it is transactionally consistent against a _running_ database — that is its entire design. A `tar` of PGDATA from a live database does not have that property: different files are read at different moments, producing a combination that never existed. Postgres tolerating an abrupt kill is not the same thing (WAL replay works because a crashed cluster is still a consistent _prefix_ of history, which a torn copy is not), so a live tar can be unrestorable in a way a crash would not have been. Keeping the volume backup for completeness and `pg_dump` for guaranteed consistency means one of the two is usually fine even when the other is not.
  - **How far verification goes.** A `dump-ok` in the execution message — or, equivalently, a **failed** status in the task list — proves tonight's archive is structurally valid: a real `pg_dump` custom archive with a readable table of contents, not truncated, not corrupt, not a zero-byte file from a failed dump. It does **not** prove a restore works. Restoring the volume tarball has been confirmed on staging; an actual `pg_restore` has not, and is the one remaining untested claim. Doing it once into a scratch database is cheap insurance.
  - **Not covered**: `rustfs-data`, which holds the receipt images. A database-only restore yields receipts whose images are gone. Back that volume up too, or accept that restores are database-only.
  - **Note**: Coolify has no native scheduled _database_ backup for Git-based Compose apps. The feature was proposed upstream ([#9019](https://github.com/coollabsio/coolify/pull/9019), [#9721](https://github.com/coollabsio/coolify/pull/9721)) but never merged, and `ServiceDatabase` has no `application_id` column, so a Compose **Application** cannot register one. `list_database_backups` returns "Database not found" for both resources. Don't go looking in the UI for it.
- **Migrations**: never at app startup. Warm `DATABASE_URL` against a throwaway DB and run `pnpm db:generate` locally; apply with the `migrate` service at deploy.
- **Inngest sync on deploy** (`.github/workflows/sync-inngest.yml`): Inngest only learns about a function after an app **sync**, and Coolify is not one of Inngest's hosting integrations, so without this a merge leaves Inngest serving the _previous_ manifest until someone resyncs by hand. On `push` to `main`/`staging` the workflow waits for the Coolify deployment of that exact commit to finish — ordering is load-bearing, since an early sync registers the old definitions — then calls the documented `POST https://api.inngest.com/v2/apps/receipt-analyser/syncs`. The app is not involved beyond serving `/api/inngest`; nothing about the deploy is added to the app. The branch selects a GitHub **environment** (`main` → `production`, `staging` → `staging`) whose variables carry the target (`COOLIFY_APP_UUID`, `APP_URL`) and whose secret `INNGEST_API_KEY` is an environment-scoped Inngest API key (write permission; one per environment, so a sync cannot touch the other environment). Repo-level secrets it needs: `COOLIFY_API_KEY` (a **read-only** token — the sync never deploys), `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` (a Cloudflare Access service token, because the Coolify API is behind Access). See ADR-0005.

**Redeploys** (T18 merge-gate CD): open a PR → branch protection requires the CI `quality` job (typecheck/lint/test) plus pullfrog review → merge to `main` → the Coolify GitHub App auto-deploys. No deploy workflow or webhook secret (both retired). Rollback is one click in Coolify. The `sync-inngest` workflow then resyncs Inngest Cloud once the deployment of that commit is live (see above).

**Promoting `staging` to `main`.** Feature work merges into `staging`; a `staging → main` PR is the only path to production, so it carries two duties the feature PRs cannot:

- **Carry the `Closes #N` lines into the promotion PR.** GitHub only auto-closes on a merge into the **default** branch, so a `Closes #177` written on a PR targeting `staging` is ignored: the work ships and the issue silently stays open, which is exactly how #177 outlived its fix. Before opening the promotion, skim what is going in and copy any closing lines into its body:

  ```sh
  gh pr list --state merged --base staging --limit 20
  ```

  Read the body of a PR you are unsure about with `gh pr view <N> --json body -q .body`. An issue that slips through unclosed is closed by hand with a note pointing at the promotion — the merge is a record, not a guarantee.

- **Confirm the deploy landed, not just the merge.** Coolify builds `main`, `migrate` applies any new migration, then `sync-inngest` resyncs once that exact commit is live. A promotion is finished when prod runs the commit, not when the PR is merged.

---

## App architecture

- **UI**: Next.js App Router, React 19, Tailwind CSS v4, shadcn/ui `base-nova` style.
- **Upload flow**: `POST /api/upload` creates a receipt row with `status = uploading` and returns a presigned storage URL. The browser uploads directly to RustFS. RustFS sends a bucket-notification `POST /api/storage-events`, which promotes the row to `status = pending` and sends `receipt/uploaded` to Inngest.
- **Extraction workflow**: `lib/inngest/functions/transcribe-receipt.ts` runs in the Inngest dev server:
  1. Mark `processing`.
  2. Download the image from RustFS.
  3. OCR with a vision model (`ORC_MODEL`).
  4. Parse the transcript into structured JSON (`PARSE_MODEL`, structured output).
  5. Store the result in Postgres and publish realtime state on the owner's channel (`user:<ownerId>`), carrying the receipt id.
- **Categorization workflow**: once the receipt is stored, `transcribe-receipt` emits `receipt/extracted`; `lib/inngest/functions/categorize-receipt.ts` then assigns every line item a leaf category from the seeded taxonomy (`lib/ai/categorize.ts`, `CATEGORIZE_MODEL`) and stamps `receipts.categorized_at`, leaving `status` untouched. It **skips items whose `category_source` is `user`** — a category the owner set on the receipt detail page is a decision, so a re-run must not re-classify it. Categories are a derived, re-runnable layer (ADR-0009); `pnpm categorize:backfill` re-queues receipts that have no stamp.
- **Chat**: the chat is the front door — `/` (`app/(app)/page.tsx`) renders a `useChat` client (`components/chat/chat.tsx`) that streams from `POST /api/chat`. There is no `/chat` route. The route authenticates, validates the client-supplied messages with `validateUIMessages`, builds a per-request `ToolLoopAgent` (`lib/chat/agent.ts`, `CHAT_MODEL`), and streams the response. The taxonomy and today's date are in the system prompt — with the weekday, which the local model gets wrong when it has to derive it from an ISO date (and copies out of the prompt's own format example). Chat history is client-side only — there is no `conversations`/`messages` persistence yet, so a reload loses the thread. `/receipts` holds the receipts table and the upload flow.
  - **Tools**: one file per tool in `lib/chat/tools/`, the filename being the model-facing name. Five owner-scoped read-only queries over `lib/chat/queries.ts` (`list_receipts`, `receipt_detail`, `search_line_items`, `spend_by_category`, `spend_by_merchant`) plus `ask_user`, a UI-answered clarifying-question tool. `buildChatTools(ownerId)` closes the owner over server-side, so no tool takes an owner argument and the model can never supply one. `lib/chat/output-schemas.ts` holds the output contracts, which the AI SDK validates the client's copy against. All chat types live in `lib/chat/tools/index.ts` next to the tool set they are inferred from, and they use the AI SDK's own inference (`InferUITools`, `ToolUIPart`, `UIMessage`) rather than re-deriving them. A per-tool part alias is `ToolUIPart<InferUITools<Pick<ChatTools, "name">>>` — keying by the tool set means a typo fails at the alias, not later as `never`.
  - **Tool parts**: `components/chat/agent-steps.tsx` switches on `part.type` and narrows to each tool's own part type, so no cast is needed to reach a renderer's typed `input`/`output`. The `default` branch hands the unhandled part to a `never` parameter, so a tool added to `buildChatTools` without a case is a build error — a plain `default: return null` was tried first and rejected, because it compiled fine and rendered nothing. Renderers live in `components/chat/agent-steps.tsx` and show the actual data (compact tables, linking through to `/receipts/[id]`) rather than only a status label.
  - **Client-supplied tool results are untrusted** (`lib/chat/trust.ts`). Only `ask_user` output may come from the browser; every other `output-available` tool part in an incoming request is replaced with an error, so a crafted request cannot talk the model into reporting figures no tool produced. Dates in tool results are receipt-local `YYYY-MM-DD` strings, never `Date` — they cross the wire as JSON. Each date also carries a full `dateLabel` (for example "Tuesday, 18 August 2026") so the model quotes a readable date instead of the ISO form.
  - **Errors** (`lib/chat/errors.ts`). The route's `onError` logs the cause with `reportError("chat", error)` and returns `USER_ERROR[chatErrorCode(error)]`, so a provider failure reads "The assistant's model isn't responding right now". `maxRetries` (2 by default) wraps the last failure in a `RetryError`, so the classifier unwraps `lastError` to reach the `APICallError`. The client shows `chatErrorText`, which passes only catalogue wording (plus `unauthorized` for a 401) and collapses the rest. See Error handling.
  - **Prompt** (`lib/chat/agent.ts`): directs the model to `ask_user` when a request is missing something a tool call needs — the time period above all, or which of several things the user means — and never to ask when the request already carries its period. Tiers matter: eager questions cost a round trip, so phrasing-only ambiguity resolves by taking the likely reading instead. Keep the tiers in the prompt if you touch it; an earlier version banned `ask_user` outright and the model assumed a period instead of asking.
- **Overview** (`/overview`, issue #194): every chart datum is clickable and opens a drill-down listing the rows it was summed from. `lib/overview.ts` owns the whole contract: a bounded corpus (`listOverviewReceipts` — done receipts in `overviewScope(today).window`, the widest range any chart offers, with line items and their categories, one query), the ranges (`rangeWindow`/`spendingByRange`; `12-months` buckets by calendar month, the rest by day), per-chart aggregation (`dailySpending`, `monthlySpending`, `categorySpending`, `merchantSpending`, `integritySummary`, whose card has no period selector and so names the span it covers) and one exhaustive `resolveBucket(bucket, countedReceipts)` whose `never` default makes a new chart without a resolver case a build error. Charts aggregate the corpus in the browser and resolve against `scopeReceipts(...)` of the same array, so "the panel sums to the bar" holds by construction; `test/overview.test.ts` walks every datum of every chart across every range and asserts it. `scopeReceipts` keeps only receipts a chart can count — a total and a spending day — so a panel lists exactly what its bar summed. Day, month, merchant and integrity buckets list receipts; the category bucket lists `product` line items only, grouped under their receipt (the bar sums those, not discounts or surcharges). The merchant pie draws `TOP_MERCHANTS` + "Other", and `topMerchantNames` decides both the slices and the complement. `components/overview/use-chart-drilldown.ts` holds the shared period/selection state, `components/overview/use-chart-tap.ts` turns the whole plot into the tap/scrub target, and `components/overview/drilldown-panel.tsx` renders every panel.
- **Realtime**: one channel per owner (`user:<ownerId>`, ADR-0012). `lib/inngest/channels.ts` defines it; `lib/inngest/actions.ts` mints the token from the session, never from a caller-supplied id. The receipts page opens a single subscription (`components/receipts/receipts-realtime.tsx`) and routes each message to its row by `receiptId`.
- **"Today"** (ADR-0016): resolved from the viewer's zone — the `cf-timezone` request header Cloudflare adds, then `user.timezone` (captured at sign-up from the browser), then `DEFAULT_TIMEZONE`. Every surface walks that one chain in that one order, and the chat has no candidate of its own, so the assistant and the charts cannot disagree about the day. `lib/time.ts` holds `resolveToday`/`resolveTimezone` (pure); `lib/viewer.ts` reads the header (plus the `DEV_TIMEZONE` stand-in) and is server-only. Resolve it **once per page** in the server component and pass it down as a `YYYY-MM-DD` string prop; no client component calls `Temporal.Now`, because a client component is server-rendered too and the two clocks disagree for any viewer outside the server's zone. A receipt's own day is unaffected — that is stored data (ADR-0015).
- **Processing status lifecycle**: `uploading` → `pending` → `processing` → `done`/`error`. See `CONTEXT.md` for domain terms.

---

## Code style

- Formatting and linting are handled by **Ultracite** (Oxlint + Oxfmt). Do not run Prettier on the source.
- `components/ui/**` and `README.md` are ignored by `oxfmt.config.ts` and `oxlint.config.ts` because `components/ui` is shadcn-generated. Do not manually lint or reformat those files.
- TypeScript is strict; `tsconfig.json` includes `ESNext.Temporal`. The app uses the native `Temporal` global.

## Error handling

ADR-0014. One vocabulary, one log, and expected failures returned rather than thrown.

- `lib/errors.ts` owns `USER_ERROR` — codes mapped to the only wording the UI may show — plus `reportError(scope, error)` and `isUserMessage(text)`. Add a code instead of writing a sentence at a call site; a new failure is a catalogue entry, not a new shape.
- **Expected failures are returned.** A server action returns `{ error, success: false }`, a route returns `{ error }` with a status, the chat route returns catalogue text from `onError`. Do not throw them: Next redacts an error thrown on the server in production (`error.message` becomes a generic string, the cause survives only as `error.digest`), so a message on a thrown `Error` cannot reach the UI from a server boundary.
- **Log the cause at the boundary that failed**, with `reportError("receipts.delete", error)` immediately before returning the message. A `catch` that returns without logging throws away the only copy of the cause.
- **Classify per domain, not at the boundary.** `lib/chat/errors.ts` is the only place that knows AI SDK error types and maps them to a code. Boundaries index the catalogue; they never inspect provider errors themselves.
- **Verify text that crossed a boundary the app does not own** — a chat error chunk, a failed fetch body — with `isUserMessage` before showing it, falling back to `USER_ERROR.generic`. That is what keeps a JSON body, an HTML error page or a provider message off the screen.
- **Uncaught exceptions stay exceptions.** They are bugs: `app/error.tsx` shows a generic page with a retry and logs to the browser console; the server log holds the stack, and `error.digest` joins the two. There is no `global-error.tsx`, so a failure inside `app/layout.tsx` itself falls through to the framework's page.
- No custom `Error` hierarchy: a subclass routes a category inside the process, which the catching boundary can already decide, and it cannot carry wording to a Server Component boundary in production.

## UI and styling

- Use existing **shadcn/ui** primitives from `components/ui/` before building a custom component. The project already has button, card, dialog, input, label, table, toast, etc.
- Add new shadcn components via the shadcn CLI; generated files land in `components/ui/` and are ignored by the linter/formatter.
- The project is on shadcn's **Base UI** base (`components.json` style `base-nova`, which the CLI resolves to `base: "base"`), not Radix. Generated primitives import from `@base-ui/react`, and there are no `@radix-ui/*` dependencies. Do not switch bases, or mix Radix primitives in, without an explicit decision.
- Use the theme tokens in `app/globals.css` (Tailwind CSS v4, CSS variables, `base-nova` style). Do not introduce one-off color/spacing values or duplicate the theme elsewhere.

## Types

- The database schema in `lib/db/schema/` is the single source of truth for domain types.
- Derive new types from the Drizzle tables and their Zod schemas (e.g., `createSelectSchema`, `createInsertSchema`, `.pick()`, `.extend()`). Re-export from `lib/db/` when the type is needed in multiple places.
- Avoid duplicating field definitions in hand-written interfaces.

---

## Database

- Drizzle ORM (`1.0.0-rc.4`) with `pg` and Postgres.
- Schemas: `lib/db/schema/receipt.ts`, `lib/db/schema/receipt-item.ts`, `lib/db/schema/category.ts`. Relations: `lib/db/relations.ts`. Line items carry a nullable `category_id` (leaf category) and a `category_source` (`ai` | `user`); receipts carry `categorized_at`.
- Migrations live in `drizzle/` and are generated with `pnpm db:generate`.
- For local dev you can either run `pnpm db:migrate` after generating or use `pnpm db:push`.
- `pnpm db:seed` writes demo data through the `drizzle-seed` library (reset + seed) to a dedicated `receipts_seed` database — never the app's `receipts` database. Point it elsewhere with `SEED_DATABASE_URL`. One-time setup per dev machine: create the database and migrate it, then run the app against it to view the data:

  ```
  docker exec receipt-app-postgres-1 createdb -U postgres receipts_seed
  DATABASE_URL=postgresql://postgres:postgres@localhost:5432/receipts_seed pnpm db:migrate
  pnpm db:seed
  DATABASE_URL=postgresql://postgres:postgres@localhost:5432/receipts_seed pnpm dev
  ```

- `pnpm db:fixture` is the **test fixture** path, distinct from demo data (ADR-0013). It writes to the app database named by `DATABASE_URL` — never `receipts_seed` — and is a dry run unless `--apply` is passed. It targets the agent test account by default (`trace-test@example.com`); `--email` selects another, and the owner's account needs `--force` too. It creates the Better Auth `credential` account the seed omits, so the printed credentials sign in at `/sign-in`; the corpus is 36 receipts over the trailing twelve months with coherent line-item arithmetic, categories drawn from the taxonomy the migrations seed, and one receipt carrying an integrity warning. Deterministic ids make a re-run a no-op. It refuses an account that already has receipts of its own unless `--force`, never touches another owner's rows, and refuses to run unless `NODE_ENV` is `development` or `test` (production is the named case; an unset value in a deployed container is refused for the same reason). Fixture receipts have no `object_key`, so the detail page shows "No image available" — that is deliberate, so the command needs Postgres only. Remember that `.env.local` supplies `DATABASE_URL`, so the command targets whatever database the app is pointed at.

---

## Testing

- Vitest with `globals: true`. The `@/` alias is mapped in `vitest.config.ts`.
- Run the whole suite: `pnpm test`.
- Run a focused file: `pnpm vitest run <path>` or `pnpm vitest <path>`.
- Current tests are mostly unit tests with mocked DB / AI / storage; they do not require Postgres, RustFS, or LM Studio.
- **Real-model chat evals.** `pnpm eval:chat` drives `createChatAgent` directly against the fixture account, three runs per scenario, and reports a pass rate plus the expected vs actual tool calls and arguments. It needs Postgres (the fixture owner) and LM Studio, so it is **not** part of `pnpm test` or CI. Run `pnpm db:fixture --apply` first; the runner refuses an account that does not exist. Results land in the gitignored `evals/results/latest.json` for before/after diffs. Scenario definitions and the assertion helpers (`expectTools`, `expectClarification`, …) live in `evals/chat/`.
- **Fixture integration test (optional).** The DB-writing half of `pnpm db:fixture` (`lib/db/fixture-provision.ts`) has a Postgres-backed test, skipped unless you point it at a scratch database:

  ```sh
  docker exec receipt-app-postgres-1 createdb -U postgres receipts_fixture_test
  FIXTURE_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/receipts_fixture_test pnpm vitest run lib/db/fixture-provision.integration.test.ts
  ```

  It migrates then truncates that database, so the name must contain `test` or `fixture` — pointing it anywhere else fails loudly. `pnpm test` skips it, so the suite and CI stay Postgres-free.

- **Storage smoke check (post-deploy).** After any change to storage, the webhook, or the upload flow, upload a file in the app and confirm the receipt moves `uploading → pending` and a run appears in Inngest. A webhook that silently drops events (e.g. an object-key mismatch) produces no error and no run — this is the check that catches it.

### Agent / browser testing

Any end-to-end or UI check uses the fixture account. Do not make one by hand.

- **Account:** `trace-test@example.com`, password `fixture-pass-1234` (`FIXTURE_PASSWORD` in `lib/db/fixture.ts`).
- **Ensure it exists before signing in.** The command is idempotent and a no-op when the fixture is already there:

  ```sh
  pnpm db:fixture --apply
  ```

  `--email` defaults to that account, so this command cannot accidentally provision a different one. Sign in at `/sign-in`, or drive the browser with the same credentials. `--apply` also verifies that account's stored password against the fixture password and resets it only if it has drifted, so these credentials always work; when it already matches, nothing is written.

- **Do not** sign up through the UI, copy receipts between accounts, or insert rows by hand. If the fixture is missing or stale, re-run the command.
- **The owner's account** (`kr38996@gmail.com`) is not part of agent testing. Adding fixture rows to it is an explicit owner decision and needs `--email kr38996@gmail.com --force`.

---

## AI / local models

- The AI provider is in `lib/ai/provider.ts` and uses `@ai-sdk/openai-compatible` pointing at LM Studio.
- Default models are `glm-ocr` (OCR) and `google/gemma-4-e4b` (parsing and categorization), configurable via `ORC_MODEL`, `PARSE_MODEL`, and `CATEGORIZE_MODEL` (defaults to `PARSE_MODEL`); use exactly the id LM Studio serves (from `GET /v1/models`) — it strips quant suffixes (e.g. `glm-ocr`, not `glm-ocr@q8_0`).
- Categorization (`lib/ai/categorize.ts`) is one `generateText` + `Output.object` call per chunk: the taxonomy is written into the prompt **once**, and the model returns an array of `{ index, category }` constrained by a Zod enum of leaf slugs. Do **not** reimplement it with `experimental_evaluate`: that API repeats each question's criteria per question, so the taxonomy is duplicated once per item and blows the local model's context window (it also wedges the LM Studio engine on overflow). This function is the seam that swaps for TypeSafe Jev later.
- The chat agent (`lib/chat/agent.ts`) is a `ToolLoopAgent` over the five read-only tools; its model is `CHAT_MODEL` (defaults to `PARSE_MODEL`). It must support tool calling — `gemma-4-e4b` does, but weakly, so the system prompt is deliberately strict (today's date, tiered ask_user rules) and `CHAT_MODEL` is the knob to swap in a stronger model.
- Production runs LM Studio headless on the Mac mini host (`llmster`), bound to loopback only: no API auth (nothing is LAN-exposed), reached by containers via `LM_STUDIO_URL=http://host.docker.internal:1234/v1`. It does **not** auto-start on reboot — after a mini reboot run: `lms daemon up && lms load glm-ocr && lms load google/gemma-4-e4b --context-length 8192 && lms server start --port 1234` (models pinned, no idle TTL).
- The extraction contract is `lib/db/contract.ts` (`ReceiptInformationExtractionSchema`).

---

## Gotchas

- pnpm is pinned to `pnpm@12.15.0` via `packageManager` in `package.json`; keep the `Dockerfile`, CI (`ci.yml` and `sync-inngest.yml`), and this field in sync.
- The pre-commit hook will auto-format and re-stage files. If it fails, inspect the hook output rather than manually re-running `git add`.
- The dev server binds to `0.0.0.0` so the Docker-hosted services can reach it via `host.docker.internal`.
- RustFS webhook auth must match `STORAGE_WEBHOOK_SECRET` (the bucket notification uses `Authorization: Bearer <secret>`).
- RustFS's `RUSTFS_NOTIFY_WEBHOOK_QUEUE_DIR_PRIMARY` must live outside `/data`; every top-level directory under the data volume is served as a bucket, so a queue dir there appears as a phantom bucket.
- The RustFS data volume must be chowned to uid `10001` (`chown -R 10001:10001`); the single-node on-disk format is compatible with MinIO, so a MinIO volume can be re-used directly after the chown (see ADR-0006).
- Reusing a MinIO data volume drags MinIO's bucket-notification rules across (`arn:minio:…`); those targets don't exist in RustFS, and an unresolvable rule silently breaks event delivery for the whole bucket. `rustfs-init` removes the known MinIO webhook ARN before registering the RustFS rule.
- In `docker-compose.coolify.yml`, the per-environment host-port variables (`POSTGRES_HOST_PORT`, `STORAGE_CONSOLE_HOST_PORT`, `STORAGE_API_HOST_PORT`) are declared in each service's `environment:` block **as well as** in `ports:`. Coolify only discovers variables that appear under `environment:`, so a variable used solely in `ports:` is never created and the mapping silently falls back to its `:-` default — which collides when prod and staging share the Docker host.
- `lib/db/schema/auth.ts` must match what `npx auth generate` emits for the installed `better-auth`: the library compares the Drizzle schema against what it writes at startup and throws `Drizzle schema mismatch` (a `NOT NULL` column it never writes fails every insert). Better Auth 1.7.0–1.7.2 added a required `account.issuer` and a `(issuer, accountId)` unique index; 1.7.3 removed the requirement and no longer writes the column, so both were dropped in `drizzle/20261030073009_volatile_true_believers`. Do not re-add them, and follow the [1.7 upgrade guide](https://www.better-auth.com/docs/guides/1-7-upgrade-guide) if a future upgrade renames or adds an account column.
- `zod` is at v4. Some files import from `"zod"` and some from `"zod/v4"`; both resolve to v4. Prefer `"zod"` unless the file already uses `"zod/v4"`.
- `Temporal.PlainYearMonth#toLocaleString` throws `RangeError: Mismatched calendars` in a browser with native Temporal (it has no day to resolve the locale's calendar against), which takes the whole React tree down when a chart renders it. Format a `PlainDate` — `lib/overview-chart.ts` parses `YYYY-MM` as the first of the month for exactly this reason.
- The overview's charts select from the **chart**, not from the bar: a day on the 30-day chart is about 7px wide on a phone, so `Bar.onClick` was a coin flip and a tap between bars did nothing. `components/overview/use-chart-tap.ts` reads `activeTooltipIndex` from the chart's `onClick` (resolved from the click's own coordinates) and, for a horizontal drag, from `onTouchEnd` — recharts updates the active band on `touchmove`, so the tooltip doubles as a scrub preview — while a vertical drag is left to the page. If you ever add a `Bar.onClick` back, note that recharts filters zero-length bars out of the rendered slice, so its `index` counts bars drawn, not entries in `data`; use `originalDataIndex` instead.
