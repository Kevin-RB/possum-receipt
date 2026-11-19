# ADR-0023: Production on Vercel Hobby, with Neon and R2

Date: 2026-11-19

## Status

Accepted 2026-11-19. The code change is [#251](https://github.com/Kevin-RB/possum-receipt/issues/251); the hosting decision is [#240's comment](https://github.com/Kevin-RB/possum-receipt/issues/240#issuecomment-6978734679) and the DNS consequences are [the comment after it](https://github.com/Kevin-RB/possum-receipt/issues/240#issuecomment-6999055451). This ADR replaces ADR-0005 for serving and ADR-0006 for production storage; both stay as the record of the deployment that is being retired, and RustFS stays as local development's object store.

## Context

Production ran on a Mac mini 2024: Coolify in a Colima VM, a Compose stack holding Next.js, Postgres and RustFS, one Cloudflare Tunnel as the only public ingress (ADR-0005, ADR-0006). The mini is being handed back, so everything that ran on it had to move: the app, the database, the images, the extraction models, the backups.

The plan had always been to keep Next.js' own build rather than adapt it to another runtime. That is the constraint that shapes the rest: Cloudflare Workers would mean vinext (a reimplementation of Next) or OpenNext (Next's build wrapped for a different runtime), and either way the thing being deployed is no longer the thing the repo builds. Vercel runs `next build` itself, so nothing about the framework changes.

The rescue (#248, #249) already restored the data elsewhere: 74 receipts and their items into **Neon**, the images into **Cloudflare R2**. The corpus is 16 MB of images and a 67 KB `pg_dump` — the free tiers of both services cover it for years.

## Decision

**Vercel Hobby serves the app, on Next's own build, with functions pinned to `syd1`; Neon holds Postgres and R2 holds the images.** `receipts.tribi.dev` is a **DNS-only** record pointing at Vercel.

- **DNS-only, not proxied.** Vercel supports Cloudflare in front ("Verified Proxy Lite") but does not recommend it (two caches, firewall visibility, and geolocation that describes Cloudflare's edge rather than the reader). The direct path is not a preference here, it is a dependency: `x-vercel-ip-timezone` is what resolves "today" (ADR-0016), and it only describes the reader when nothing proxies the request. Two more consequences, both in code:
  - **`x-forwarded-for` replaces `cf-connecting-ip`.** Vercel overwrites `x-forwarded-for` with the requester's real address and refuses to forward an external one, so it is the only client IP a client cannot choose. `cf-connecting-ip` was trustworthy only because Cloudflare wrote it; without the proxy a caller sends whatever it likes, which would hand the `/sign-up/email` rate limit — the brake on invite-code guessing — a fresh bucket per request. `lib/auth.ts` reads `x-forwarded-for`; `lib/auth/auth.test.ts` asserts it.
  - **The Cloudflare IP geolocation headers stay.** Vercel sends its own set (`x-vercel-ip-city`, `-country`, `-latitude`, …), so the location data the app used to get from the proxy's Managed Transform is still available — just under different names.
- **One header changes, nothing else in the chain does.** `lib/viewer.ts` reads `x-vercel-ip-timezone`, then `user.timezone`, then `DEFAULT_TIMEZONE`. `DEV_TIMEZONE` stands in locally, gated on `NODE_ENV === "development"` as before. The warning when the header is absent stays and now names its cause: the DNS record being proxied again, or the app no longer being on Vercel. There is no Managed Transform to enable any more, and AGENTS.md's "Viewer timezone prerequisite" section is gone with it.
- **Neon's pooled connection string, with the pool attached to the function lifecycle.** `lib/db/index.ts` calls `attachDatabasePool` from `@vercel/functions` immediately after creating the `pg` pool, so idle clients are released before the instance suspends instead of being counted against Neon's connection budget by every warm instance. It is a no-op off Vercel.
- **The authenticated image route streams.** Vercel caps a buffered response body at 4.5 MB; a streamed one is exempt. A phone photo of a receipt can be larger than that, and the route exists to serve exactly those, so `app/api/receipts/[id]/image` hands `transformToWebStream()` back rather than `transformToByteArray()`.
- **Migrations run at the start of the Vercel build, and only there.** `pnpm build` runs `tsx scripts/migrate-production.ts` before `next build`. Vercel has no release phase, so the build is the only point that is both after the commit exists and before the deployment serves it: a failed migration fails the build, and the previous deployment keeps answering. The gate is `VERCEL_ENV === "production"`, which is what makes a preview harmless — a preview build skips the step entirely, so it cannot migrate the database it points at even when that database is production's. A local `pnpm build` has no `VERCEL_ENV` and skips too. Migrating at app startup was rejected outright: a serverless instance starts many times per deployment, concurrently, and each start would race the others.
- **The official Inngest Vercel integration replaces the sync workflow.** It writes `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` and syncs the app on every deploy, which is the one thing `.github/workflows/sync-inngest.yml` existed to fake from the outside — and its Coolify deploy wait could not succeed against Vercel anyway. `INNGEST_SERVE_ORIGIN=https://receipts.tribi.dev` pins the origin that gets synced, or Inngest would register the per-deployment `*.vercel.app` URL. `app/api/inngest/route.ts` sets `maxDuration = 300`, Hobby's ceiling, so a step is not cut short by a default that moves.
- **Security headers and the report-only CSP keep their shape** (ADR-0019). The static set still comes from `next.config.ts`, the policy is still built per request in `lib/security/csp.ts` and set by `proxy.ts`. The only change is the value of the storage origin: R2's S3 endpoint (`https://<account-id>.r2.cloudflarestorage.com`) instead of the Traefik-fronted `uploads.tribi.dev`. It must be that host and not a custom domain, because a presigned URL is signed for the host it names. It is also why the variable has to be present at **build** time as well as runtime: `proxy.ts` is compiled for the edge, so the endpoint is inlined then, and a value missing from the build silently drops the origin from the policy while everything else keeps working.

## Considered options

1. **Stay on the mini with Coolify.** Rejected by the hosting decision. It is a single machine at home with no redundancy, and the reason to move is that the machine is going away.
2. **Cloudflare Workers.** Rejected: vinext or OpenNext means deploying a different implementation of the framework than the one the repo builds and tests, and this app leans on route handlers, middleware and streaming chat.
3. **Vercel Pro.** Not needed yet. Hobby's function limits (300s, 2 GB) cover the app, the chat and the Inngest steps; Pro becomes a billing change if log retention or the terms become a problem.
4. **A proxy in front of Vercel** (Cloudflare's orange cloud, for WAF and caching). Rejected: it moves the geolocation the app reads onto Cloudflare, reintroduces the spoofable-IP problem, and Vercel advises against it. Vercel's own DDoS protection and firewall cover an invite-gated app.
5. **A separate staging host.** Hobby has no custom environments; staging is a protected preview deployment (a later ticket), which needs no DNS.
6. **Migrations from GitHub Actions before the deploy.** Rejected: it races the Git-triggered build — Vercel does not wait for an external workflow — so the only way to order them is to stop deploying from Git, which the ticket requires. The build step is ordered by construction.

## Consequences

- **A rollback does not roll the database back.** Instant Rollback restores a previous deployment, but the build that produced it is not re-run, so the schema stays where the last migration left it. A rollback is therefore only safe while the older code still fits the newer schema.
- **A preview cannot migrate, so a preview with a migration runs old code against the new schema** — or rather, new code against the old schema. Previews are for looking at, not for testing migrations; staging-on-preview is limited in the same way until a separate branch database exists.
- **`DATABASE_URL` must be available to the Build step** in the Production scope, not only at runtime, or the migration step fails the deploy. The same is true of `STORAGE_PUBLIC_ENDPOINT` and `BETTER_AUTH_URL` for the CSP and auth to be built correctly.
- **`x-forwarded-for` trust is Vercel's, and it is load-bearing.** Any future proxy in front of the app (a CDN, a corporate gateway) reintroduces a header a client can set, and the rate limit with it.
- **The app's public surface loses Cloudflare's WAF, bot protection, caching and analytics.** Accepted: those were protecting a home box reached through a tunnel, and Vercel's edge provides the first two.
- **Hobby's 4.5 MB body limit still applies to requests**, so an upload cannot round-trip the app — it does not, and will not: uploads are presigned straight to R2 (ADR-0001, #252).
- **The in-memory Better Auth rate limit is weaker on serverless.** Each instance keeps its own counter, so the effective limit is per instance rather than per IP. Moving it to the database was declined with the Workers Paid plan; it is a known limitation, not a regression introduced here (the Coolify deployment had one long-lived process, so its counter was global).
- **Hobby keeps function logs for one hour.** Diagnosis after the fact needs Inngest's run history or Neon's query log; if that becomes painful, Pro is the remedy.
- **`output: "standalone"` is Docker-only, gated on `VERCEL`.** It cannot simply stay on: on Next 16.3 the standalone finalizer reads `.next/next-server.js.nft.json`, which the deployment adapter Vercel injects stops Next from writing, so every Vercel build of the app would fail in `onBuildComplete` with ENOENT ([vercel/next.js#96646](https://github.com/vercel/next.js/issues/96646); the fix is on canary only and was not backported to 16.3.x). Vercel does not use standalone output anyway. The conditional disappears with the Docker targets (#254).
- **The Coolify compose file, the Dockerfile targets and the mini's documentation are #254's to delete.** This ADR covers serving; it does not claim the old files are already gone.
- **Uploads are not part of this change.** R2 presigned PUTs, the browser's upload-finished call and the bucket's CORS are #252. Until they land, production can read the restored corpus but not accept a new receipt.

## Related

- Issue [#240](https://github.com/Kevin-RB/possum-receipt/issues/240) — the hosting map, and its two decision comments.
- ADR-0005 (Coolify deployment) — the deployment this replaces; historical.
- ADR-0006 (RustFS) — superseded for production storage; local development keeps it.
- ADR-0016 ("today" is the viewer's clock) — the header changed, the chain did not.
- ADR-0019 (security headers and report-only CSP) — unchanged in shape; its storage origin is R2's now.
- ADR-0021 (upload-finished is verified) — the R2 upload path this deployment is read-only without.
- [#251](https://github.com/Kevin-RB/possum-receipt/issues/251) — the implementation; [#252](https://github.com/Kevin-RB/possum-receipt/issues/252) uploads; [#253](https://github.com/Kevin-RB/possum-receipt/issues/253) backups; [#254](https://github.com/Kevin-RB/possum-receipt/issues/254) the Coolify cleanup.
