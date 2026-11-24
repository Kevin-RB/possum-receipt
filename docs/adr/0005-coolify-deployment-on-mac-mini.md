# ADR-0005: Public deployment on the Mac mini via Coolify (Colima), Cloudflare Tunnel, Inngest Cloud

Date: 2026-08-29

## Status

Superseded by ADR-0023 (2026-11-19). This is the historical record of the deployment it replaced: the app, database and object store now run on Vercel, Neon and Cloudflare R2. Nothing here describes the current setup.

## Context

We deploy the app publicly on a Mac mini 2024 (M4, 16GB) running macOS. Coolify runs inside a Colima Linux VM per Coolify's own macOS guide, hosts a single Docker Compose stack (Next.js, Postgres, MinIO), and the stack is exposed through one Cloudflare Tunnel with a single wildcard route `*.tribi.dev → http://localhost:80` into the Coolify Traefik proxy, which routes per-domain to the Next.js app (`receipts.tribi.dev`) and MinIO's object API (`uploads.tribi.dev`) (T15; see the update below for the pre-T15 topology). Everything else (Postgres, MinIO console, LM Studio) stays private; the Coolify admin becomes reachable at `coolbox.tribi.dev` through the same proxy in T16, behind a Cloudflare Access gate (note: `coolify.tribi.dev` is not the dashboard hostname — it answers with a Cloudflare Access login redirect rather than the dashboard; see the T16–T20 update below). Extraction runs on local models loaded in LM Studio on the macOS host, reached by containers via `host.docker.internal`; a bring-your-own-key cloud LLM is the documented fallback if memory or performance fails.

Two facts drive the choices below and are easy to misremember:

- **Coolify does not officially support macOS.** Its installer targets Linux; the documented macOS path is a Colima VM running Docker Engine, and the maintainers have said macOS/Windows support is out of scope.
- **Inngest runs on Inngest Cloud, not self-hosted.** The issue originally planned a production-mode self-hosted server (signing keys, Postgres-backed).

## Decision

- Host Coolify in a Colima VM on the macOS host anyway, because the alternative — a separate full Linux VM or re-homing the mini's OS — costs more time and memory than it saves at our scale. Docker Engine effectively means "Colima" (rejected: Docker Desktop and OrbStack, neither is Coolify's documented path).
- Use Inngest Cloud over self-hosting: our functions execute in the Next.js process either way, Cloud removes one container and one Postgres database's worth of memory on a tight 16GB budget, and it drops the self-hosted signing-key ceremony. Events carry only identifiers, never receipt bytes or transcripts. Self-hosted remains the documented fallback.
- Keep ADR-0001's presigned-upload flow: the app is served on `receipts.tribi.dev` and MinIO's object API on `uploads.tribi.dev`, so image uploads never round-trip the Next.js server. This is the industry-standard pattern for object-storage uploads. Proxy-uploading through the app was rejected because it would consume app-server bandwidth for no benefit.
- Keep backups same-box for now: nightly `pg_dump` + `mc mirror` land on a local volume on the same mini with 14-day retention. Off-site storage (Backblaze B2) or an external drive is the chosen long-term destination, deferred until the pipeline is proven. This is an explicit, reversible short-cut, not a final design.
- Store secrets only in Coolify per-resource env vars — fresh values generated at rollout, never committed, interpolated into the compose stack. The dev `.env.local` values (plaintext Postgres/MinIO/webhook credentials, `INNGEST_DEV=1`, `NODE_ENV=development`) never ship.

## Consequences

- A CORS rule on the `receipts` bucket must permit PUT from `https://receipts.tribi.dev`, or production uploads fail (they work locally before this is configured).
- Postgres, MinIO console, and LM Studio are not exposed through the tunnel — the Traefik proxy routes only hostnames configured on resources, so anything unpinned on `*.tribi.dev` is caught by the Cloudflare Access gate and answers with a login redirect, not a proxy 404 (see T16). The Coolify admin is exposed at `coolbox.tribi.dev` via the proxy once T16 sets the dashboard domain, gated by Cloudflare Access.
- Same-box backups share a failure domain with the app until off-site storage ships; that risk is accepted while the pipeline is unproven. (Superseded — the backup container was removed; see the 2026-09-08 update below.)
- Production holds no plaintext credentials on disk: secrets live only in Coolify env vars, so the `.env.local` dev values are inapplicable to the deployed stack.

## Update (T15, 2026-09-02): single wildcard tunnel route to Traefik

The tunnel originally had per-hostname routes straight to compose service names (`receipts.tribi.dev → app:3000`, `uploads.tribi.dev → minio:9000`). T15 collapsed these to one operative wildcard route — `*.tribi.dev → http://localhost:80` (Coolify "Access All Resources via Cloudflare Tunnel" guide) — so **all** `*.tribi.dev` traffic lands on the Coolify Traefik proxy and per-domain routing happens through Traefik labels configured in Coolify, not through per-hostname tunnel rules. The `receipts`/`uploads` per-hostname entries remain in the tunnel but all forward to the same proxy service (kept by choice; the wildcard is what routes new domains). Cloudflare zone TLS is **Full (Strict)** with **Always Use HTTPS**; the tunnel leg is encrypted by cloudflared regardless, so the proxy sees plain HTTP on port 80 and Traefik/Cloudflare terminate TLS the way the Coolify guides describe. New apps and domains need zero tunnel changes, and the Coolify admin becomes reachable for T16/T18 at `coolbox.tribi.dev` (behind a Cloudflare Access gate). Origin certificates and a `https://localhost:443` route (Coolify's Full TLS HTTPS variant) remain the documented path if an app ever needs origin-side HTTPS for JWT or callback URLs.

## Update (2026-09-08): remove the same-box backup container

The `backup` container (T12) was removed from the compose stack. It crash-looped from the moment the extended stack first ran: `backup.sh`'s shell arithmetic parses zero-padded clock values (`09`, `05`) as octal, which BusyBox `sh` under `set -eu` treats as a fatal error, so the container exited instantly on every boot and Docker's `unless-stopped` restarted it forever. Because Coolify aggregates the maximum Docker `RestartCount` across every container bearing the app's `coolify.applicationId` label, the backup's restarts appeared as restarts of the whole application, tripping `max_restart_count` and triggering `StopApplication` — which stopped the entire stack. The decision lines above about same-box backups ("Keep backups same-box for now") and their accepted risk are **superseded**.

Backups are being reworked as a separate task (cron-based, likely off-box); until then **no automatic backups run in production**.

## Update (2026-10-02): backups restored, two mechanisms

The "no automatic backups run in production" gap left by the 2026-09-08 removal above is closed. Backups are now configured per-environment and run from the Coolify UI, so — unlike the container that caused the original incident — nothing in the compose stack can crash-loop and trip Coolify's aggregate restart limit.

**1. Volume backup.** Coolify's storage backup on `postgres-data`, written to `/data/coolify/backups/volumes/…` as a `tar.gz` of the data directory. Restores by untarring over a fresh volume on the same `postgres:18-alpine` image; not portable across major versions. Configured **without** "stop the container" — stopping makes the archive consistent but costs service interruption, so the archive is a live-database copy.

**2. `pg_dump`.** A Coolify Scheduled Task on the `postgres` container, writing to a new `backups-data` volume mounted at `/backups`, with a 14-day prune and `pg_dumpall -g` alongside so a logical restore has its roles. The exact command is in AGENTS.md — it is held to 240 characters because Coolify's `scheduled_tasks.command` column is `varchar(255)`, so it is written in compressed shorthand rather than the readable form.

Each run ends with `pg_restore -l … && echo dump-ok`, which validates the archive just written. That ordering is deliberate and must not change: Coolify only marks an execution failed when the command exits non-zero, and a `;`-separated shell returns the status of its last command. Ending on the `find` prune — which exits 0 even when it cannot read the directory — left every failure reporting green, so the task's own status could not be trusted and the output message was the only usable signal. Ending on the validation makes the exit code the health check, so the task list and the message now agree. The prune stays `;`-chained so retention still runs when a dump fails.

`pg_restore -l` reads the table of contents without a database and fails on a bad or truncated archive, including the zero-byte file a failed `pg_dump` leaves behind. An actual `pg_restore` into a database has still not been performed.

Both are **same-host**, which is the same trade-off the original design accepted and that ADR-0005 line 30 already flagged as an accepted risk: they cover a bad deploy, a deleted volume, or a mistake, not losing the mini. Off-box storage remains the planned destination and is deliberately deferred until this pipeline is trusted.

The two mechanisms are kept despite overlapping, because they fail differently. `pg_dump` takes an MVCC snapshot and is therefore consistent against a running database. A `tar` of PGDATA from a live database is not: files are read at different moments, so the archive is a combination that never existed. This is _not_ the same as surviving an abrupt kill — WAL replay can rescue a crash because a crashed cluster is still a consistent prefix of history, which a torn copy is not — so declining "stop the container" is only safe while a snapshot-consistent second artifact exists.

Coolify's own scheduled _database_ backup is not an option for this stack and should not be revisited: the feature was proposed upstream (coollabsio/coolify#9019, #9721) but never merged, and `ServiceDatabase` has no `application_id` column, so a Git-based Compose Application cannot register a database resource. Only the storage/volume backup path applies.

Known gap: `rustfs-data` (receipt images) is not covered by either mechanism, so a database-only restore leaves receipts whose images are missing.

## Update (T16–T20, 2026-09): dashboard domain, git-backed deploy, merge-gate CD, headless LM Studio

- **T16 — dashboard domain (issue #71).** The Coolify instance (dashboard) domain is `http://coolbox.tribi.dev`, served through the same tunnel → Traefik path and fronted by a Cloudflare Access application whose policy is tied to the owner's account — only the owner reaches the Coolify login page. The ticket originally named `coolify.tribi.dev`; that hostname (like `minio.` and `console.tribi.dev`) still resolves through the wildcard but answers with a Cloudflare Access login redirect — not the dashboard and not a proxy 404, so the earlier "proxy 404" expectation is superseded. Routing the dashboard through the proxy is also what makes the GitHub App webhook URLs (`/webhooks/source/github/…`) publicly reachable for T18.
- **T17 — git-backed deploy (issue #72).** The production stack runs as a Coolify Docker Compose build-pack resource pointing at the public repo (`docker-compose.coolify.yml`, branch `main`). The first deploy exposed three latent bugs, all fixed on `main`: Node 26 dropped Corepack, so the Dockerfile installs pnpm directly; runner scripts were committed mode 0644, so the Dockerfile now `chmod +x`s them; Traefik's per-resource "Redirect HTTP to HTTPS" caused an infinite loop (the tunnel delivers plain HTTP on :80), so it stays off and Cloudflare terminates TLS plus edge http→https.
- **T18 — merge-gate CD (issue #73).** The GitHub App is installed with auto-deploy on `main`; branch protection requires the CI `quality` job (Typecheck, lint, test) plus the pullfrog review before merge. The old `.github/workflows/deploy.yml` webhook job and the `COOLIFY_DEPLOY_WEBHOOK` secret are removed — no double-deploys. Commit statuses appear on PRs; rollback is one click in Coolify.
- **T20 — headless LM Studio (issue #80).** LM Studio runs headless on the macOS host (`llmster`), bound to loopback only with no API auth (nothing is LAN-exposed); containers reach it at `LM_STUDIO_URL=http://host.docker.internal:1234/v1`. Models are pinned (`glm-ocr`, `google/gemma-4-e4b` with 8k context on parse) with no idle TTL. It does not auto-start on reboot — after a mini reboot run `lms daemon up`, load both models, and `lms server start --port 1234` (see AGENTS.md for the exact command).

## Update (2026-09-17): object storage moved to RustFS

The object store is now **RustFS**, not MinIO — see ADR-0006. The MinIO-specific topology described above is historical and must not be followed as current setup: the S3 API on `uploads.tribi.dev` is served by RustFS; the console is the RustFS console on `${STORAGE_CONSOLE_HOST_PORT}`, which needs a private API host port and a one-time Server Configuration entry (unlike MinIO's server-side-proxying console); CORS is server-level (`RUSTFS_CORS_ALLOWED_ORIGINS`) rather than a per-bucket MinIO rule; and the credential fence is the RustFS root keys plus the least-privilege `receipts-app` IAM user, not MinIO root. ADR-0006 is authoritative for storage.

## Update (2026-10-09): sync Inngest on deploy (issue #142)

Inngest records an app's functions only when it is **synced**, and Coolify is not one of Inngest's hosting integrations — only Vercel and Netlify resync automatically — so a deploy that added or changed a function left Inngest serving the previous manifest until someone resynced from the dashboard. Adding `categorize-receipt` failed exactly this way: the deploy was healthy, the backfill printed `Queued categorization for 4 receipt(s).`, and nothing ran. The events were accepted, but no registered function consumed `receipt/extracted`, so they were dropped silently.

**Decision.** A new `.github/workflows/sync-inngest.yml` runs on `push` to `main`/`staging`. It waits for the Coolify deployment of that exact commit to finish, then calls Inngest's documented sync endpoint (`POST /v2/apps/receipt-analyser/syncs`). Ordering is the crux — Inngest's own docs warn that an early sync registers the old configuration — so the wait is a first-class step, not a fixed delay.

The sync is a **pull**: Inngest fetches the manifest from the live app, so it registers whatever is actually running. That is also why a rollback or manual redeploy — which changes the live manifest with no push — can be resynced by re-running the workflow from the branch (`workflow_dispatch`). Two guards keep it honest: the wait uses two budgets — a short window for Coolify to _start_ a deployment (a missing one is a misconfiguration, not a slow build) and a long one for it to finish — and the sync request is retried for a couple of minutes, because "deployment finished" can precede the app accepting requests (its boot script waits on LM Studio) and a first attempt against a starting container would otherwise fail.

**Why poll Coolify rather than the app.** The deploy system is the authoritative owner of "the deployment finished", and polling it keeps CI/CD concerns out of the app: no `/api/version` endpoint and no `SOURCE_COMMIT` wiring are added just for the pipeline. The cost is reaching the Coolify API from a GitHub runner, which the Access gate below turns into a deliberate, read-only integration.

**Why not Coolify's post-deployment command.** It runs at the right moment, but in Coolify 4.4.2 `post_deployment()` calls `completeDeployment()` _before_ it and wraps `run_post_deployment_command()` in a `try/catch` that only logs a warning, so a failed sync leaves the deployment green — the same "reported success while nothing happened" class this fixes.

**Why not the serve-endpoint `PUT`.** A bare `PUT /api/inngest` does self-register (the SDK posts to `/fn/register` with the signing key) and needs no API key, so it remains a valid fallback. It was not chosen because the documented contract is the REST sync endpoint, which uses the API key the docs designate for CI and which verifies that Inngest can reach the app (a pull, not a push).

**Security.** The Coolify token is **read-only** (`read` is enough to list deployments; `deploy`, `write`, and `root` are unnecessary), so even a leak cannot change or deploy anything. It sits behind Cloudflare Access, so reaching the API also requires the Access service token — two independent gates, though both credentials live in the same secret store. The per-environment target (Coolify app UUID, public URL) lives in a GitHub **environment** selected by branch — `main` → `production`, `staging` → `staging` — so no environment-specific values sit in the workflow. The Inngest API key is an **environment secret** holding a key scoped to that environment (write permission; syncing registers functions), so a staging sync cannot reach production; the Coolify and Cloudflare credentials stay repo-level. The environments also give each deploy a record in the repo's deployment history.

## Related

- Issue #54 (public deployment)
- Issues #70–#73 (T15–T18: wildcard tunnel, dashboard domain, git-backed deploy, merge-gate CD)
- Issue #80 (T20: headless LM Studio)
- Issue #142 (sync Inngest on deploy)
- ADR-0001 (upload via presigned URL and bucket notification)
