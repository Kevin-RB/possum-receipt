# Hosting options after the Mac mini

Research for issue #243 (parent map #240). Every price was read on **2026-11-18** unless another date is given. All prices exclude tax: add 10% GST for Australian billing, and VAT where it applies. Prices change. Re-read the cited page before you commit.

## The workload being priced

| Item | Assumption used in every estimate |
| --- | --- |
| Users | A handful |
| Receipts | Tens a month (~50). **Measured from the #241 rescue (2026-11-18):** prod holds 75 objects totalling **16.1 MB**, with a median of 177 KB, a mean of 220 KB and a maximum of 3.4 MB. At ~50 a month that adds ~11 MB a month, so the corpus stays under 200 MB for more than a year. Every storage free tier below covers it. |
| Postgres (measured) | 74 receipts and 445 line items. The `pg_dump` is 67 KB; the data directory is 63.5 MB. |
| Postgres | < 1 GB on disk, near-idle |
| Egress | A few GB a month at most |
| Models | All on OpenRouter after the move. No GPU, and no model traffic on the host. |
| Inngest | Inngest Cloud, unchanged. The **Free** plan covers 50k executions, 500k events and 50 realtime connections a month ([inngest.com/pricing](https://www.inngest.com/pricing)), so it costs $0 under every option below. |

At this size, **always-on RAM is the cost driver** on every usage-billed platform, while storage and egress are rounding errors. A flat-priced VPS costs the same whether you use it or not.

Currency: AUD figures are converted at ~0.674 USD per AUD, the rate implied by [accsly.io's BinaryLane listing](https://accsly.io/en/vps/hosting/binarylane-com) (A$19.60 ≈ US$13.22). Treat the conversions as approximate.

---

## How Next.js gets deployed

Next.js names four ways to deploy ([Deploying](https://nextjs.org/docs/app/getting-started/deploying), updated 2026-08-06). A **Node.js server** (`next build` + `next start`) and a **Docker container** both "support all Next.js features". A **static export** has "limited" support. **Adapters** vary. *Verified* adapters "are open source, run the full Next.js compatibility test suite, and are hosted under the Next.js GitHub organization"; today those are **Vercel and Bun**. Cloudflare and Netlify "are working on verified adapters". Until then they sit under **Other platforms**, whose integrations "are not built on the public Adapter API and are not verified by the Next.js team, so feature support and compatibility may vary".

| Option in this document | Deployment mode | Builds with Next's own `next build`? |
| --- | --- | --- |
| VPS + Coolify (section 1) | Docker (the `runner` target is a standalone Node server) | Yes |
| Railway (section 2) | Node.js server or Docker | Yes |
| Cloudflare (section 3) | Other platform: **vinext** (a reimplementation of the Next.js API on Vite) by default, or the OpenNext integration | **vinext: no.** OpenNext: yes, it adapts the build output |
| Vercel (section 4) | Verified adapter | Yes |
| Supabase / Neon (sections 5, 6) | Not app hosts: database (and storage) only | n/a |
| Fly.io, Render (sections 7, 8) | Docker | Yes |
| AWS ECS / Lightsail (sections 1, 9) | Docker | Yes |

Bun is on the verified list as a **runtime**, not as a host, so it is not an option here. Something still has to run the Bun process.

**Static export is ruled out.** It "does not support Next.js features that require a server", and this app depends on them: server actions (ADR-0002), route handlers (`/api/chat`, `/api/upload`, `/api/storage-events`, `/api/inngest`), `proxy.ts`, and per-request auth and nonces (ADR-0019).

---

## Summary table

| Option | Pricing model | Est. monthly bill at this usage | Idle month | Region nearest Brisbane | RTT from Brisbane | Change to the system |
| --- | --- | --- | --- | --- | --- | --- |
| **BinaryLane 4 GB + Coolify** | Flat, billed hourly | **A$19.60** (+ backups ≈ A$3) ≈ **US$15** | Same | **Brisbane** (NextDC B2) | same city, low single-digit ms (not measured) | **Minimal**: same compose file |
| Vultr 4 GB + Coolify | Flat, hourly, capped at 672 h | US$20 (+20% for backups) | Same | Sydney / Melbourne | ~12 ms (Sydney) | Minimal |
| DigitalOcean 4 GB + Coolify | Flat, per-second | US$24 (+20–30% for backups) | Same | Sydney | ~12 ms | Minimal |
| Akamai/Linode 4 GB + Coolify | Flat, hourly | US$24 | Same | Sydney / Melbourne | ~12 ms | Minimal |
| AWS Lightsail 4 GB + Coolify | Flat bundle | US$24 (Sydney gets half the transfer) | Same | Sydney | ~12 ms | Minimal |
| Hetzner CPX22 + Coolify | Flat, hourly cap | €26.99 ≈ US$31.59 (incl. IPv4) | Same | Singapore | ~104 ms (183 ms in one recent window) | Minimal |
| **Railway Hobby** | $5 minimum, usage-based | **≈ US$7–10** | ≈ $5–8 (RAM still billed) | Singapore | ~104 ms | Moderate: no bucket events |
| **Cloudflare (Workers via vinext + R2 + Queues + Hyperdrive) + Neon** | $5 minimum + usage | **≈ US$5** | $5 | Workers run at the Brisbane edge; DB in Sydney | edge ~local; DB ~12 ms | **Largest**: a different framework implementation (vinext, beta), new runtime, new upload hook |
| **Vercel Hobby + Neon Free + Tigris** | Free, hard caps, no overage | **US$0** | $0 | Sydney (`syd1`) | ~12 ms | Moderate: new upload hook, timezone header, Inngest sync. Hobby is "personal or non-commercial" only |
| Vercel Pro + Neon Free + Tigris | $20/month platform fee, which includes $20 of usage credit | **US$20** | $20 | Sydney (`syd1`) | ~12 ms | Same as Hobby |
| Fly.io (syd) + Tigris | Pure usage, no free tier (bills under $5 are waived) | ≈ US$13–14 (self-run PG) / ≈ $47 (Managed PG) | Same unless machines auto-stop | Sydney | ~12 ms | Moderate |
| Supabase Pro (DB + Storage) + app host | $25 flat + usage | US$25 + app host ≈ **$35–50** | $25 + host | Sydney | ~12 ms | Moderate–large; **Postgres 17** |
| Neon (DB only) | Free tier, or usage | $0 (Free) – ~$7 (Launch) + app host | $0 | Sydney | ~12 ms | DB only |
| Render | $0 workspace + per-instance | ≈ US$26–44 + object store | Same | Singapore | ~104 ms | Moderate; no object storage |
| AWS ECS/RDS/S3 | Usage, many line items | ≈ US$50–70 | ≈ same | Sydney | ~12 ms | Large; App Runner is closed |

The rest of this document justifies each row.

---

## Latency to Brisbane

Cloudflare stays in front under every option, so the browser's TLS ends at Cloudflare's Brisbane edge. **What the origin's location changes is the edge→origin round trip on each dynamic request**: every page navigation, since every route is dynamic (ADR-0019), plus server actions and the upload/webhook hops.

| Path | Measured RTT | Source |
| --- | --- | --- |
| Brisbane ↔ Sydney | **11.7–11.9 ms** | WonderNetwork, [Brisbane/Sydney](https://wondernetwork.com/pings/Brisbane/Sydney) hourly series (Feb 2026); [Sydney page](https://wondernetwork.com/pings/Sydney) lists 11.92 ms, last checked 2026-11-15 |
| Brisbane ↔ Singapore | **103.7 ms** | WonderNetwork [Singapore page](https://wondernetwork.com/pings/Singapore), last checked 2026-11-17 |
| Brisbane ↔ Singapore (other window) | 183 ms median, 20 Oct–3 Nov 2026 | Secondary compilation of WonderNetwork data ([space-node.net](https://space-node.net/blog/best-minecraft-server-hosting-australia-2026)). This shows the route can change, nearly doubling the RTT |
| Brisbane ↔ Brisbane DC | Not measured. Same metro, so expect low single-digit ms | — |

What this means in practice:

- **Chat latency barely depends on the host.** The model call goes to OpenRouter and its upstream providers, and the time to first token is dominated by them. Origin placement shifts it by one RTT at most.
- **Page loads do depend on it.** In Singapore, every navigation pays ~100–180 ms before rendering starts. In Sydney it pays ~12 ms. In Brisbane, close to nothing.
- **App↔DB co-location matters more than user↔app.** A render issues several sequential queries, so a split where the app and the database sit in different regions multiplies the RTT. Every option below keeps them in the same region, except the Cloudflare one, where the edge Worker talks to a Sydney database through Hyperdrive's pooled connections.
- The sentence at the top of this section assumes Cloudflare is in front. **Vercel is the exception**: Vercel advises against putting another proxy in front of it (section 4), so under Vercel the browser would talk to Vercel's network directly.

---

## 1. VPS + Coolify (reuse `docker-compose.coolify.yml`)

### What survives unchanged

Nearly everything. That includes the compose file, RustFS and its bucket-notification webhook (ADR-0001, ADR-0006), the presigned PUT on `uploads.tribi.dev`, the IAM-scoped `receipts-app` user, `postgres:18-alpine`, the `migrate`/`toolbox` pattern, the `pg_dump` scheduled task, and Inngest's public `/api/inngest`. Long-lived streaming is a non-issue because it is a plain Node process.

To keep the Cloudflare path, run `cloudflared` on the VPS with the same wildcard route `*.tribi.dev → http://localhost:80` (ADR-0005, T15). The VPS then needs no inbound ports at all. `cf-timezone` (ADR-0016) and the CSP origins (ADR-0019) are unaffected because the hostnames do not change.

### What changes

- The mini-specific parts go away: LM Studio, `host.docker.internal`, and Colima. Coolify runs natively on Linux, which is its supported path. The mini never was.
- **Sizing:** Coolify alone needs **2 CPU, 2 GB RAM, 10 GB disk** ([coolify.io/docs](https://coolify.io/docs/get-started/installation)). Add the app, Postgres, RustFS and Traefik, and **4 GB is the realistic floor**. The tighter constraint is the `next build`, which Coolify runs on the server during every deploy. On a 4 GB box, add swap, or build the image in GitHub Actions and have Coolify pull it. This sizing is an estimate, not a measurement.
- `sync-inngest.yml` keeps working as written, since it polls Coolify. Only `COOLIFY_APP_UUID` and the API host change.

### Ops burden

You patch the OS (`unattended-upgrades`) and keep Coolify and the images updated. Deploys are unchanged: the Coolify GitHub App auto-deploys on merge to `main`.

### Backups

Provider-side disk backups (below) protect against a broken box. The off-box copy is the open item #240 asks for:

- **Postgres:** keep the `pg_dump` task. Add an upload step (e.g. `rclone` or `aws s3 cp`) to Cloudflare R2 or Backblaze B2.
- **Images:** run `rclone sync` from RustFS to the same remote. This closes the known `rustfs-data` gap in ADR-0005.
- **Off-box cost at this size:** R2's free tier is **10 GB-month, 1M Class A and 10M Class B operations, and free egress** ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)), so likely **$0**. B2 charges **$6.95/TB per 30 days** ([B2 pricing](https://www.backblaze.com/cloud-storage/pricing)), so ~$0.01 for a couple of GB.

### Providers

All five are **flat-priced**. You pay the same in an idle month as in a busy one. Egress overage never applies at this usage.

**BinaryLane (Australian; has a Brisbane DC).** [binarylane.com.au/vps-hosting](https://www.binarylane.com.au/vps-hosting), read 2026-11-18; the same figures were reported on 2026-11-07 and 2026-11-10.

| Fact | Detail |
| --- | --- |
| Price | Standard 2 vCPU / 4 GB / 60 GB NVMe / 3,000 GB transfer: **A$19.60/mo ex GST**. The 2 GB plan is A$9.80, too small for Coolify plus the stack. |
| Billing | Hourly in arrears, AUD. One IPv4 included. |
| Add-ons | Backups **A$0.05 per GB per backup**; extra transfer A$0.01/GB. |
| Locations | NextDC B2 Brisbane, plus Sydney, Melbourne, Perth, Adelaide and Singapore ([support article](https://support.binarylane.com.au/support/solutions/articles/1000015169-where-are-binarylane-servers-located-)). |
| Trap | Plan availability per location "changes during the day", per that article. If Brisbane is full, deploy elsewhere and migrate later. |
| Other notes | No object storage, which isn't needed because RustFS stays. A smaller company than the others here. |
| **Worked month** | A$19.60, plus ~7 daily backups of ~10 GB used ≈ A$3.50, so **≈ A$23 ex GST (A$25.40 inc GST) ≈ US$15–17** |

**Vultr.** [vultr.com/pricing](https://www.vultr.com/pricing/), via search snapshot; also reported 2026-11-10 and 2026-11-17.

| Fact | Detail |
| --- | --- |
| Price | Regular Performance 2 vCPU / 4 GB / 80 GB / 3 TB: **US$20/mo**. |
| Billing | Hourly, capped at 672 h/month. Stopped instances are still billed. |
| Add-ons | Automatic backups **+20%**; overage $0.01/GB. |
| Locations | Sydney and Melbourne. Vultr says some locations are priced differently and shows the real price only in its control panel, so check Sydney there. One tracker recorded $20.00 for `vc2-2c-4gb` in Sydney on 2026-11-17 ([cloud-prices](https://cloud-prices.undefined83.org/offers/vultr/vc2-2c-4gb/syd)). |
| **Worked month** | **US$24 with backups** |

**DigitalOcean.** [digitalocean.com/pricing/droplets](https://www.digitalocean.com/pricing/droplets)

| Fact | Detail |
| --- | --- |
| Price | Basic 2 vCPU / 4 GiB / 80 GiB / 4,000 GiB: **US$24/mo**. |
| Billing | Per-second since 2026-01-01. |
| Add-ons | Backups are 20% (weekly) or 30% (daily) of the Droplet price, or usage-based from $0.01/GiB. |
| Location | Sydney (SYD1). |
| **Worked month** | **≈ US$29–31** |

**Akamai / Linode.** [akamai.com/cloud/pricing/cpu](https://www.akamai.com/cloud/pricing/cpu)

| Fact | Detail |
| --- | --- |
| Price | Linode 4 GB (2 vCPU, 80 GB, 4 TB): **US$24/mo**. |
| Add-ons | Overage $0.005/GB. |
| Locations | Sydney and Melbourne. Akamai's price list varies only Jakarta and São Paulo. |
| **Worked month** | **≈ US$24** plus backups |

**AWS Lightsail.** [aws.amazon.com/lightsail/pricing](https://aws.amazon.com/lightsail/pricing/)

| Fact | Detail |
| --- | --- |
| Price | 4 GB / 2 vCPU / 80 GB: **US$24/mo**, IPv4 and static IP included. |
| Trap | In Sydney the transfer allowance is halved, to 2 TB. That is irrelevant at this size, but it exists. Also, both inbound and outbound traffic count toward the allowance. |
| **Worked month** | **US$24** plus snapshots |

**Hetzner (nearest region: Singapore).** [hetzner.com/cloud/regular-performance](https://www.hetzner.com/cloud/regular-performance)

| Fact | Detail |
| --- | --- |
| Price (SIN1, incl. IPv4) | CPX12 1 vCPU / 2 GB: €15.99. **CPX22 2 vCPU / 4 GB / 80 GB: €26.99** (~US$31.59 on a USD account, per [lacquerbay, 2026-11-02](https://lacquerbay.com/hetzner-singapore-vps-price/)). The same CPX22 is €16.99–19.99 in the EU. |
| Traps | Singapore includes only **0.5–1 TB** of traffic (20 TB in the EU), and extra traffic costs **€7.40/TB** (€1 in the EU). |
| Price history | Singapore prices rose 51–90% in 2026 ([ployz.dev](https://ployz.dev/blog/hetzner-pricing), checked against Hetzner's price-adjustment page on 2026-10-08). |
| Add-ons | Backups from 20% of the server price. |
| Availability | Several Create links on the plan page read "currently unavailable" on 2026-11-18. That is a capacity signal, so check before relying on it. |
| **Verdict** | **Hetzner is no longer the cheap option for this owner.** It costs more than a Sydney VPS, and its RTT is ~9× that of Sydney. |

---

## 2. Railway (usage-based PaaS)

Pricing: [railway.com/pricing](https://railway.com/pricing).

### How the bill works

| Fact | Detail |
| --- | --- |
| Plan | **Hobby: $5/month minimum, which includes $5 of usage.** If usage goes over $5, you pay the whole usage, not the excess on top of $5. |
| Usage rates | Memory $0.00000386/GB-s (≈ **$10/GB-month**); CPU $0.00000772/vCPU-s (≈ $20/vCPU-month); volumes ≈ $0.16/GB-month; service egress **$0.05/GB**; buckets **$0.015/GB-month with free operations and free bucket egress**. |
| Hobby limits | Up to 5 GB of volume storage, 7-day logs, 2 custom domains. |
| Free plan | Not usable here: 0.5 GB RAM per service, and no custom domains after the trial. |

### Worked month

| Service | Assumption | Cost |
| --- | --- | --- |
| Next.js app | ~0.4 GB average RAM | ≈ $4.00 |
| Postgres | ~0.15 GB RAM | ≈ $1.50 |
| CPU | Near-idle | ≈ $0.50 |
| Volumes and bucket | 1–2 GB | ≈ $0.20 |
| RustFS as a service (optional, see below) | ~0.15 GB RAM | ≈ +$1.50 |
| **Total** | | **≈ US$6–8 → bill ≈ US$6–8** (never below $5) |

An idle month still costs ~$5–8, because the containers stay resident. Railway's "serverless" sleep can cut this, but it adds cold starts to Inngest calls and the first page view.

### Latency

The nearest region is **Singapore** (`asia-southeast1-eqsg3a`). There is no Australian region ([regions doc](https://docs.railway.com/reference/deployment-regions)).

### Feasibility

| Area | Assessment |
| --- | --- |
| Postgres 18 | Fine. Railway Postgres is a container on a volume, so the image can be pinned to 18. |
| Postgres backups | Railway volume backups: daily kept 6 days, weekly kept 27, monthly kept 89 ([volume backups](https://docs.railway.com/volumes/backups)). |
| Inngest | Fine: a public HTTP service. |
| Streaming chat | Fine: a long-lived container. |
| Cloudflare | Works with a proxied custom domain, so `cf-timezone` arrives. |
| **Upload webhook** | **Railway Buckets have no bucket notifications.** Their docs list supported operations and the not-yet-supported ones, and events appear in neither ([storage buckets](https://docs.railway.com/storage-buckets)). Two ways out: (a) run **RustFS as a Railway service on a volume**, which keeps ADR-0001/0006 intact but costs RAM and counts toward the 5 GB volume cap alongside Postgres; or (b) use a Railway Bucket and replace the webhook with "browser reports upload done → server `HEAD`s the object → promote to `pending`". Option (b) is a real ADR-0001 change. |
| Presigned URLs | Supported on Railway Buckets, but on Railway's endpoint (e.g. `t3.storageapi.dev`), not `uploads.tribi.dev`, so the CSP `connect-src`/`img-src` and CORS change (ADR-0019). |
| Deploys and Inngest sync | GitHub autodeploy. `sync-inngest.yml` must poll Railway's API instead of Coolify's. |

### Ops

None at the OS level.

### Off-box backups

`pg_dump` from a Railway cron service, or from GitHub Actions, to R2.

---

## 3. Cloudflare (Workers via vinext or OpenNext + R2 + Queues + Hyperdrive), with an external Postgres

### How the bill works

| Product | Price | Source |
| --- | --- | --- |
| Workers Paid | **$5/month minimum per account**. Includes 10M requests, 30M CPU-ms, Hyperdrive, KV and Durable Objects usage. No egress charges. | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| R2 Standard | $0.015/GB-month; Class A $4.50/M; Class B $0.36/M; **egress free**. Free tier 10 GB-month + 1M Class A + 10M Class B. | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Queues | 1M operations/month included on Workers Paid, then $0.40/M. | [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/) |
| Hyperdrive | No extra charge on Workers Paid. | [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/) |
| Cloudflare Postgres | **None**. D1 is SQLite. A Postgres is needed elsewhere: Neon (below) in Sydney fits. | — |

**Worked month:** $5 + R2 (free tier) + Queues (included) + Neon Free ($0) = **≈ US$5**. An idle month costs the same $5.

### Latency

Workers run at the edge nearest the user, which for Brisbane is Brisbane. Queries go to a Sydney Neon through Hyperdrive's pooled connections, ~12 ms each. R2 accepts an **`oc` (Oceania)** location hint ([data location](https://developers.cloudflare.com/r2/reference/data-location/)). Hints are best-effort.

### Two ways to run Next.js on Workers, and which one Cloudflare now recommends

Cloudflare's Next.js guide (updated 2026-11-05) now says: "Cloudflare recommends [vinext](https://vinext.dev/) as the default way to run Next.js applications on Cloudflare Workers". It keeps OpenNext for "an existing OpenNext application that cannot yet migrate to vinext because of a compatibility gap" ([Cloudflare: Next.js](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/)). The two paths are built differently, and that difference is the main risk for this app:

|  | **vinext** (Cloudflare's default) | **OpenNext** (`@opennextjs/cloudflare`, now the fallback) |
| --- | --- | --- |
| What it is | "a Vite plugin that reimplements the Next.js API surface" ([Cloudflare](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/)). Its README says it "reimplements the Next.js API surface on Vite rather than consuming `next build` output" and "The core is written from scratch" ([README](https://github.com/cloudflare/vinext/blob/main/README.md)). | It "adapts the _output_ of a standard `next build`" and so "inherits broad API coverage and has been well-tested for much longer" (the vinext README's own comparison). |
| Maturity | Cloudflare: "vinext is in beta". README: "Under active development … not yet a drop-in replacement for every application or production workload", and on production use, "You can, with caution". It does not aim for "bug-for-bug parity with undocumented behavior". npm `latest` is 1.4.6, published 2026-11-16 (registry, read 2026-11-18). | `latest` 1.20.17 (2026-11-12). It supports every minor and patch release of Next 16 ([OpenNext Cloudflare](https://opennext.js.org/cloudflare)). |
| `proxy.ts` | Listed as supported: "`middleware.ts` and `proxy.ts` (Next.js 16)" (README feature table). | Still **"experimental support since @opennextjs/cloudflare 1.20.3"** ([OpenNext Cloudflare](https://opennext.js.org/cloudflare), re-read 2026-11-18). |
| Verified by Next.js? | No. Cloudflare is under "Other platforms", with a verified adapter on the Adapter API still in progress ([Next.js: Deploying](https://nextjs.org/docs/app/getting-started/deploying)). | No, for the same reason. |
| Upgrades | They follow vinext's own releases. Next.js upgrades only arrive once vinext has reimplemented them, and the README says "Experimental or unstable Next.js features are lower priority". | They follow Next.js closely, because OpenNext adapts the real build. |

The vinext README itself says: "If you need a mature, well-tested way to run Next.js outside Vercel, OpenNext is the safer choice."

**vinext compatibility dashboard** ([vinext.dev/compatibility](https://vinext.dev/compatibility)). The latest run was 2026-11-18 02:15 UTC, against Next.js **v16.2.6** (this app is on **16.3.0**). That run reports a 99.7% supported pass rate, a 96.2% overall pass rate, and 93.9% coverage of the supported surface, across 799 test files. Of those files, 721 pass outright. Every middleware and proxy file that matters here passes, including `proxy-runtime-nodejs`, `middleware-request-header-overrides` (9/9), `middleware-general/node-runtime` (68/68) and `app-action-node-middleware` (70/78, with 8 skipped). The files that do not pass and are relevant to this app:

- `app-dir/next-dynamic-csp-nonce`: **1 of 2 tests fail**, flagged "Vite-equivalent required". This is the nonce path for `next/dynamic`. **This app does not import `next/dynamic`** (checked with grep on 2026-11-18), but it is the only App Router nonce test in the run, and it does not pass cleanly.
- `streaming-ssr`: 4 of 5 pass.
- Partial Prerendering, Cache Components and the segment cache account for most of the "Deferred" files. The app does not use them.

### Feasibility for this app under vinext

| Area | Assessment |
| --- | --- |
| `proxy.ts`: session gate, then the nonce on the **forwarded request** headers | Request-header overrides and Node-runtime middleware pass upstream's tests. **The part that matters is not proven:** Next reads the nonce from the request's `Content-Security-Policy-Report-Only` header and stamps its own inline scripts with it (ADR-0019), and vinext reimplements that stamping. Test it by hand. Every script tag on `/`, `/receipts` and `/overview` must carry the nonce, plus the `next-themes` script, which gets it through `x-nonce`. |
| `next/headers` `headers()` in the root layout | Supported: "Async `headers()`, `cookies()`, `draftMode()`" (README). |
| Route handlers with streaming (`/api/chat`, `streamText`) | Route handlers and streaming SSR are supported (Cloudflare's feature table). Workers bill CPU, not wall time ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)). |
| Server actions (ADR-0002) | Supported. The action test files pass. |
| `next-themes` | A client library. It should be unaffected beyond the nonce item above. Not tested. |
| Inngest `serve` from `inngest/next` | A route handler, so it should work. Not tested on vinext. CPU limit: 5 min per invocation (default 30 s). Each step is its own invocation. |
| `pg` + drizzle through Hyperdrive | Cloudflare calls `pg` "the recommended driver" for Hyperdrive ([node-postgres with Hyperdrive](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/node-postgres/)). The connection string comes from a binding (`env` from `cloudflare:workers`), not `DATABASE_URL`, so `lib/db` changes. `nodejs_compat` is on by default for compatibility dates from 2026-08-04 ([compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)). |
| AWS SDK presigner | Works against R2: Cloudflare's own example uses `getSignedUrl` from `@aws-sdk/s3-request-presigner` ([R2 + aws-sdk-js-v3](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/)). The presigned URL only works on the `r2.cloudflarestorage.com` host (below). |
| Native `Temporal` on workerd | Available **behind the `temporal` compatibility flag, and by default from compatibility date 2026-12-01** ([compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/); [changelog 2026-11-02](https://developers.cloudflare.com/workers/platform/changelog/)). It is not a blocker either way, because `lib/time.ts` imports `temporal-polyfill/global`. |
| `cf-timezone` | The **Add visitor location headers** transform adds it "to the request sent to the origin server" ([Managed Transforms](https://developers.cloudflare.com/rules/transform/managed-transforms/reference/)). This document has not confirmed that a Worker sees it. If it doesn't, `request.cf.timezone` carries the same value ([Request](https://developers.cloudflare.com/workers/runtime-apis/request/)), but `lib/viewer.ts` reads `headers()`, so reading it means a vinext-specific code path. **Verify.** |
| Upload webhook | **Replaced.** R2 event notifications go to a **Queue**, not a URL ([event notifications](https://developers.cloudflare.com/r2/buckets/event-notifications/)). A consumer Worker (or an HTTP pull consumer) must then do what `/api/storage-events` does. The signal survives (`object-create` covers PutObject and CompleteMultipartUpload); the transport and the parser change. |
| Presigned URLs | **Only on `<ACCOUNT_ID>.r2.cloudflarestorage.com`. They "cannot be used with custom domains"** ([presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), re-read 2026-11-18). `uploads.tribi.dev` retires, CORS moves to the R2 bucket, and the CSP `connect-src` gains the R2 origin (ADR-0019). |
| Postgres 18 | Through Neon, which supports 14–18. |
| Toolchain | The build moves from `next build` to Vite. `next dev` keeps working alongside it (`vinext init` is "non-destructive"), but production runs a different implementation from the one on the developer's machine. The README lists "Turbopack/webpack configuration" and "`next/jest`" as unsupported. Neither is used here: the app uses Vitest. |
| Ops | No servers. Deploy with `npx @vinext/cloudflare deploy` or Workers Builds. `sync-inngest.yml` loses its Coolify wait, because a Workers deploy is synchronous. |

**Bottom line for Cloudflare.** vinext removes the specific blocker this document used to name (`proxy.ts` is no longer "experimental"). In exchange, it replaces Next's own server with a from-scratch reimplementation in beta. That is a different and broader risk: any divergence from Next 16.3 would show up in production first, and only for this app. OpenNext is still the conservative Workers path, and its `proxy.ts` support is still experimental. Neither path is a verified adapter.

**Alternative: Cloudflare Containers** run the existing Docker image, so the app keeps real `next start`. Charges accrue only while the container runs. A `basic` instance (1/4 vCPU, 1 GiB) left on all month uses ≈ 705 GiB-h, beyond the 25 included, for **≈ $6/month of memory**, plus active CPU and $0.05/GB Oceania egress ([Containers pricing](https://developers.cloudflare.com/containers/pricing/)). Containers have **no persistent disk**, so Postgres still lives elsewhere, and the R2 and webhook changes above still apply. It is the least framework risk on Cloudflare, with the same storage change.

**Cost re-check (2026-11-18).** Unchanged. Workers Paid is still a "$5 USD per month" minimum with "no additional charges for data transfer", 10M requests and 30M CPU-ms included ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)). Neither vinext nor OpenNext is billed separately.

**Backups:** Neon's own (section 6), plus `pg_dump` from GitHub Actions to R2. Images already live in R2, so add a second bucket or B2 for an independent copy.

---

## 4. Vercel

Prices: [vercel.com/pricing](https://vercel.com/pricing) and [Sydney (syd1) regional pricing](https://vercel.com/docs/pricing/regional-pricing/syd1). All are in USD, excluding GST. Vercel is a **verified adapter** (see the primer), so the app keeps Next's own build.

### How the bill works

| Fact | Detail |
| --- | --- |
| **Hobby** | **$0.** Monthly allowances: 4 h Active CPU, 360 GB-h Provisioned Memory, 1M function invocations, 1M CDN requests, 100 GB Fast Data Transfer, 10 GB Fast Origin Transfer. **Blob: 1 GB storage, 10K simple and 2K advanced operations, 10 GB transfer** ([Hobby plan](https://vercel.com/docs/plans/hobby); [pricing](https://vercel.com/pricing)). There is no overage. "If you exceed your usage limits on the Hobby plan, you will have to wait until 30 days have passed before you can use the feature again." Spend Management is "N/A". |
| **Hobby terms** | "You shall only use the Services under a Hobby plan for your personal or non-commercial use … We may shut down and terminate projects or deployments using the Hobby plan without notice for any reason or no reason" ([Terms of Service §4](https://vercel.com/legal/terms), last updated 2026-10-19). The fair-use page lists "Functions that query DBs or APIs" as fair use. Its "never fair use" list is proxies/VPNs, hot-link media hosting, scrapers, crypto mining, and unauthorised load or penetration testing ([fair use](https://vercel.com/docs/limits/fair-use-guidelines)). |
| **Pro** | **$20/month** platform fee. That includes 1 deploying seat and **$20 of usage credit**, which applies "from the first unit you use" and "expires at the end of the month". Extra deploying seats are $20/month each; viewer seats are free ([Pro plan](https://vercel.com/docs/plans/pro-plan)). |
| Pro usage rates in `syd1` | Fluid Active CPU **$0.18/h**; Provisioned Memory **$0.0149/GB-h**; invocations $0.60/M; Fast Data Transfer $0.16/GB; Fast Origin Transfer $0.29/GB; Blob storage **$0.025/GB-month**, simple ops $0.44/M, advanced ops $5.50/M, Blob transfer $0.053/GB ([syd1 pricing](https://vercel.com/docs/pricing/regional-pricing/syd1)). |
| How functions bill (Fluid compute) | "Vercel bills Active CPU only while your code is actually running. If the request is waiting on I/O, CPU billing pauses but memory billing continues." Once all requests finish, "no CPU or memory charges apply until the next invocation" ([Fluid compute pricing](https://vercel.com/docs/functions/usage-and-pricing)). Default size: 2 GB / 1 vCPU, which Hobby cannot change ([memory](https://vercel.com/docs/functions/configuring-functions/memory)). |
| Spend controls (Pro) | New Pro teams get a default notification budget of $200. A budget does not stop usage by itself: you must turn on **Pause production deployments**. Checks run "every few minutes", so a pause can lag ([spend management](https://vercel.com/docs/spend-management); [pricing FAQ](https://vercel.com/pricing)). |

**Traps**

- **Memory is billed while waiting.** Every OCR or parse step that waits on OpenRouter, and every chat stream, holds 2 GB of provisioned memory for its whole wall time. That is the main meter here. At this volume it stays tiny (worked month below), but it is why the bill tracks wall time, not CPU.
- **Hobby Blob is 1 GB.** The measured corpus is 16.1 MB and grows ~11 MB a month (see the workload table), so it **fits Hobby Blob for years**. Hitting the cap would pause the feature for up to 30 days, so check usage once a year.
- **4.5 MB function body limit.** "The maximum payload size for the request body or the response body of a Vercel Function is **4.5 MB**", except for streamed responses ([limitations](https://vercel.com/docs/functions/limitations)). The receipt page serves its image "from an authenticated route" (`app/(app)/receipts/[id]/page.tsx`), so that route must **stream** the object, not buffer it, or a large photo fails with a 413. Uploads are unaffected, because the browser sends them straight to storage (ADR-0001).
- **Image optimisation is not a cost.** The one `next/image` that shows a receipt is `unoptimized`.
- **ISR doesn't apply.** Every route is dynamic (ADR-0019), so ISR reads and writes stay at zero.
- **Bandwidth stays far below every allowance.** One discrepancy: the Pro plan page says Flat Rate CDN includes "1 million CDN requests and 1 TB", while the pricing page says "10M / month included". Neither number matters at this size.
- **Logs:** Hobby keeps runtime logs for **1 hour**; Pro keeps them for 1 day ([Hobby plan](https://vercel.com/docs/plans/hobby)). ADR-0014's "the server log holds the stack" becomes a one-hour window on Hobby, unless logs are drained elsewhere. Drains are Pro-only.
- **Staging:** custom environments are "Not available" on Hobby and 1 on Pro ([pricing](https://vercel.com/pricing)). On Hobby, `staging` would be a branch **preview** deployment, which Standard Protection puts behind Vercel Authentication. Inngest then needs "Protection Bypass for Automation", which "is available on all plans" ([bypass](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation); [Inngest on Vercel](https://www.inngest.com/docs/deploy/vercel)).

### Worked month

These are assumptions, not measurements: ~3,000 page and action requests at ~0.3 s; 50 receipts × ~4 Inngest steps, with the OCR and parse steps waiting ~30 s each on OpenRouter; ~200 chat turns at ~20 s; all at the 2 GB default.

| Meter | Estimate | Pro cost in `syd1` |
| --- | --- | --- |
| Provisioned memory | ≈ 0.5 (pages) + 2–3 (Inngest) + 2.2 (chat) ≈ **5–6 GB-h**, or 3 GB-h if requests share an instance | ≈ $0.09 |
| Active CPU | < 0.5 h | < $0.09 |
| Invocations | < 10K | ≈ $0.01 |
| Images on Vercel Blob | 16 MB plus small operations | Hobby: inside the allowance. Pro: < $0.01 |
| Neon Free (Postgres, section 6) | Fits 100 CU-h | $0 |
| **Total** | Hobby: well under every allowance. Pro: ≈ $0.25 of usage, inside the $20 credit | **Hobby $0 · Pro $20** |

An idle month costs the same: Hobby $0, Pro $20. On Pro the usage would need to pass $20 before the bill moved, which is ~80× the estimate.

### Latency

Functions can be pinned to **Sydney, `syd1`** (AWS `ap-southeast-2`), one of 19 compute regions ([regions](https://vercel.com/docs/regions)). New projects default to `iad1` (Washington, D.C.), so **the region must be set** in project settings or with `"regions": ["syd1"]` in `vercel.json`. Hobby allows a single region ([function regions](https://vercel.com/docs/functions/configuring-functions/region)). From Brisbane that is the Brisbane↔Sydney **~12 ms** measured above. Neon in `aws-ap-southeast-2` sits in the same AWS region. Vercel's network terminates TCP at the nearest of 126 PoPs, but "The Vercel region the request is routed to handles TLS encryption and decryption" ([regions](https://vercel.com/docs/regions)), so the handshake pays the Sydney RTT too. This document has not checked whether there is a Brisbane PoP.

`proxy.ts` behaves differently: Vercel runs it as Routing Middleware, which is deployed "to all regions by default, regardless of your region settings. On the Hobby plan, Routing Middleware runs in fewer regions" ([function regions](https://vercel.com/docs/functions/configuring-functions/region)). It runs near the user, then forwards to `syd1`.

### Feasibility

| Area | Assessment |
| --- | --- |
| `proxy.ts` (session gate + nonce CSP) | Supported, on the Node.js runtime. Next 16: "Proxy defaults to using the Node.js runtime. The `runtime` config option is not available in Proxy files" ([Next.js: proxy](https://nextjs.org/docs/app/api-reference/file-conventions/proxy)). Vercel bills it as a Fluid function ("Vercel Functions running Fluid compute, including Routing Middleware", [pricing](https://vercel.com/pricing)). The 50 ms CPU guideline applies only to middleware "with the `edge` runtime configured" ([fair use](https://vercel.com/docs/limits/fair-use-guidelines)), which this app does not use. |
| Streaming chat (`streamText`) | Fine. Maximum duration under Fluid compute: **Hobby 300 s** (default and maximum); **Pro 300 s by default, up to 800 s**, and 1,800 s in beta ([duration](https://vercel.com/docs/functions/configuring-functions/duration)). The limit "includes … streamed responses" ([limitations](https://vercel.com/docs/functions/limitations)). `/api/chat` already sets `maxDuration = 60`. |
| Inngest serve endpoint | Same duration limits. Inngest recommends setting `maxDuration` on `/api/inngest`, and, with v4 checkpointing (the default), setting checkpointing's `maxRuntime` "20-40% below your maxDuration" ([Inngest on Vercel](https://www.inngest.com/docs/deploy/vercel)). Each step is its own request, so 300 s is ample for an OCR call. |
| **Inngest sync** | **The official integration replaces `.github/workflows/sync-inngest.yml`.** It sets `INNGEST_SIGNING_KEY` and `INNGEST_EVENT_KEY` and "Automatically syncs your app to Inngest every time you deploy". Set `INNGEST_SERVE_ORIGIN=https://receipts.tribi.dev` so production syncs the custom domain, not the per-deploy `*.vercel.app` URL ([Inngest on Vercel](https://www.inngest.com/docs/deploy/vercel)). The staging environment needs a Vercel custom environment (Pro) or a protected preview with a bypass (above). |
| Postgres | "Vercel Postgres is no longer available". Postgres now comes from Marketplace partners: "Neon, Prisma Postgres, Supabase, and AWS Aurora Postgres" ([Postgres on Vercel](https://vercel.com/docs/postgres)). **Neon** is the fit: Postgres **18**, Sydney, Free plan (section 6), and billing can go through Vercel ([Neon on the Marketplace](https://vercel.com/marketplace/neon)). Supabase is on Postgres 17 (section 5). |
| Pooling with drizzle + `pg` | Use Neon's pooled connection string, and call `attachDatabasePool(pool)` from `@vercel/functions` right after creating the `pg` `Pool`. It "ensures that idle pool clients are properly released before functions suspend" and supports `pg` ([`@vercel/functions`](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package)). That is a one-line change in `lib/db`. Neon's scale-to-zero cold start (section 6) adds to the first request after an idle spell. |
| **Object storage: Vercel Blob** | Stores live in one chosen region, can be private, and hold files up to 5 TB ([Vercel Blob](https://vercel.com/docs/vercel-blob)). Browser-direct uploads come in two flavours: `handleUpload` (a token exchange) and `handleUploadPresigned` (presigned `PUT` URLs, "Maximum 7 days", with content-type and size limits enforced "at the CDN") ([client uploads](https://vercel.com/docs/vercel-blob/client-upload); [signed URLs](https://vercel.com/docs/vercel-blob/vercel-signed-urls)). Client uploads incur no data-transfer charge. The upload host is Vercel's, `<store>.private.blob.vercel-storage.com`, so CSP `connect-src` and `img-src` change. Private blobs **can be served from a custom domain**, but only through your own Functions ([private storage](https://vercel.com/docs/vercel-blob/private-storage)). Nothing documents a custom domain for the upload `PUT` itself. Not S3-compatible as far as these docs show, so `@aws-sdk/s3-request-presigner` gives way to `@vercel/blob`. |
| **Upload event (ADR-0001)** | **Yes, there is one: `onUploadCompleted`.** It "is called by Vercel API when a client upload completes". The callback is signed, and verified with `BLOB_WEBHOOK_PUBLIC_KEY` on the presigned path. Vercel Blob "retries up to 5 times on a 429, 500, 502, 503, or 504" and "does not retry … on a 400" ([client uploads](https://vercel.com/docs/vercel-blob/client-upload); [signed URLs](https://vercel.com/docs/vercel-blob/vercel-signed-urls)). It would replace `/api/storage-events`: the same job (find the receipt by key, promote `uploading → pending`, send `receipt/uploaded`), triggered by Vercel instead of a bucket notification, with a signature instead of a Bearer token, and `tokenPayload` to carry the receipt id. **Two costs.** First, `/api/upload` becomes a `@vercel/blob/client` handler instead of the AWS presigner. Second, local development loses the loop: "the `onUploadCompleted` callback will not work as Vercel Blob cannot contact your localhost", so it needs a tunnel (`VERCEL_BLOB_CALLBACK_URL`), or `docker compose` keeps RustFS and production differs from dev. |
| Object storage: keep an external S3 | **Tigris** keeps the current contract closest: a webhook with `Authorization: Bearer <token>`, and a 5 GB free tier (section 7). Only the event envelope parser changes, as it did for RustFS (ADR-0006). **R2** works for storage, but its events go to a Queue (section 3), which needs a Cloudflare Worker. Either way, presigned URLs are on the vendor's host, not `uploads.tribi.dev`, so CSP and CORS change. With the measured 16 MB corpus, Blob fits Hobby's 1 GB, so external storage is a choice here rather than a requirement. |
| **`cf-timezone` (ADR-0016)** | **Vercel advises against Cloudflare in front.** "**We do not recommend** placing a reverse proxy server in front of your Vercel project". The reasons: firewall visibility, client IPs, and "Two independently managed caches" ([reverse proxy](https://vercel.com/docs/security/reverse-proxy); [KB](https://vercel.com/kb/guide/can-i-use-a-proxy-on-top-of-my-vercel-deployment)). It is _supported_: Cloudflare is a "Verified Proxy Lite" provider on all plans, using `CF-Connecting-IP`, and the SSL/TLS mode must be **Full (strict)**. Behind Cloudflare, `cf-timezone` would keep arriving, because Cloudflare adds it on the way to any origin. But Vercel's own geolocation would describe Cloudflare, not the reader, because preserving geolocation is "Verified Proxy Advanced", Enterprise only. **The recommended setup is DNS-only**, and then the header to read is **`x-vercel-ip-timezone`**: "The name of the time zone for the location of the requester's public IP address in ICANN Time Zone Database name format such as `America/Chicago`" ([request headers](https://vercel.com/docs/headers/request-headers)). The same IANA format means `lib/viewer.ts` changes one header name, and `[viewer-timezone]`'s warning and the Managed Transform prerequisite in AGENTS.md go away. Going DNS-only also drops Cloudflare's edge features for `receipts.tribi.dev`. |
| Native `Temporal` | **Available.** Node.js **26.x is Vercel's default**, with 24.x also offered ([Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)). Node 26 shipped "the Temporal API enabled by default" ([Node.js 26.0.0](https://nodejs.org/en/blog/release/v26.0.0)). That matches the `node:26-slim` image used today, and `lib/time.ts` loads `temporal-polyfill/global` regardless. |
| Security headers (ADR-0019) | Unchanged: `next.config.ts` headers and the `proxy.ts` CSP are Next features. The storage origin in `lib/security/csp.ts` changes with the storage choice. |
| Deploys | Git push deploys and Instant Rollback on all plans. The Coolify GitHub App and the `migrate` service go away: run `pnpm db:migrate` from CI (or a build step) against Neon before the deployment is promoted. |

### Ops

None at the OS level. You own Neon (managed) and the external bucket, if one is used. Hobby has no spend control because it has hard caps: an over-use pauses the feature, it does not bill.

### Backups

Neon's own restore history (the window depends on the Neon plan, which this document did not check), plus `pg_dump` from a GitHub Actions schedule to R2 or B2 (free tier, as in section 1). For images, use `rclone` from Tigris or R2 to a second provider. If the images are on Blob, there is no S3 API to sync from, so copy them with the `@vercel/blob` SDK (`list` + `get`) in the same scheduled job. That copy is not tested here.

### Hobby eligibility verdict

On the wording, this app fits Hobby. It is a personal receipt tracker with a handful of invited users, no revenue, and no business behind it: "personal or non-commercial use". The current Terms do not define "commercial", and this document did not find a definition elsewhere in Vercel's docs. That makes this **a reading, not a ruling**. Two things would change the answer: any revenue, or using it for someone's business. The other risk is not eligibility but discretion: Hobby projects can be shut down "without notice for any reason or no reason". For the only copy of the users' receipts, that argues for Pro ($20), or at least for the off-box backups above.

---

## 5. Supabase (managed Postgres + Storage; app hosted elsewhere)

Pricing: [supabase.com/pricing](https://supabase.com/pricing).

### How the bill works

| Plan | Detail |
| --- | --- |
| Free | **Projects pause after 1 week of inactivity**; limit of 2 active projects; 500 MB DB; 1 GB storage. **Not viable for prod.** |
| Pro | **$25/month**, which includes one Micro compute (1 GB, covered by the $10 compute credit), 8 GB disk, 100 GB file storage, 250 GB egress, and daily backups kept 7 days. A spend cap is on by default. |

**Worked month:** $25, plus an app host (a $20–24 Sydney VPS, or Railway ~$7) = **≈ US$32–50**. An idle month costs $25 plus the host.

### Latency

Sydney (`ap-southeast-2`) ([regions](https://supabase.com/docs/guides/platform/regions)).

### Feasibility

| Area | Assessment |
| --- | --- |
| **Postgres version** | **Supabase is on Postgres 15/17.** Its 2026-10-30 changelog still names 15.x and 17.x images ([changelog](https://supabase.com/changelog)). Postgres 18 was promised for ~Q1 2026 and has not shipped. Restoring a PG18 `pg_dump` into 17 usually works for plain schemas, but it is a downgrade and needs testing. |
| Upload webhook | Has an equivalent: Supabase Database Webhooks (triggers via `pg_net`) on `storage.objects` inserts can POST to `/api/storage-events` ([database webhooks](https://supabase.com/docs/guides/database/webhooks)). The payload differs, so the parser changes. |
| Upload URLs | Use Supabase's signed upload URLs or its S3 endpoint. The origin and CSP change. |
| Overall | Pays $25 for a platform (Auth, Realtime, PostgREST) the app doesn't use, because Better Auth and Inngest Realtime already cover them. |

---

## 6. Neon (Postgres only)

Pricing: [neon.com/pricing](https://neon.com/pricing).

| Fact | Detail |
| --- | --- |
| Free | **$0**. 100 CU-hours per project per month, 1 GB storage, scales to zero after 5 minutes idle, sizes up to 2 CU. |
| Launch | Usage-based, no stated minimum: **$0.106/CU-hour, $0.35/GB-month**, snapshots $0.09/GB-month, 500 GB egress included. |
| Postgres version | **18 supported** (supports 14–18; [version policy](https://neon.com/docs/postgresql/postgres-version-policy), updated 2026-11-13). |
| Region | Sydney (`aws-ap-southeast-2`) ([regions](https://neon.com/docs/introduction/regions)). |

**Worked month:** the app is idle most of the day, so at the 0.25 CU minimum it runs maybe 20–60 h → 5–15 CU-h. **That fits Free.** On Launch it would be ~$1–7.

**Trap:** cold start ("a few hundred milliseconds") on the first query after idle. Neon pairs well with Cloudflare, Vercel or Fly. On a VPS it is pointless, because Postgres runs locally for free.

---

## 7. Fly.io

Pricing: [fly.io/pricing](https://fly.io/pricing) and [docs](https://fly.io/docs/about/pricing/). The memory price rose to $6/GB on 2026-10-01.

### How the bill works

| Fact | Detail |
| --- | --- |
| Model | Pure usage. **No free tier**, but a personal org's bill under $5 is waived. Machines bill per second while running; stopped machines pay $0.15/GB of rootfs. |
| Sydney multiplier | **1.269×** the Ashburn price. |
| Sydney compute | shared-cpu-1x 1 GB ≈ **$8.50**; 512 MB ≈ **$4.68**. |
| Other rates | Volumes $0.15/GB; Oceania egress $0.04/GB. |
| Managed Postgres | Basic 1 GB **$38/month** + $0.28/GB storage, and **only Postgres 16 or 17** ([MPG](https://fly.io/docs/mpg/)). It is available in `syd`. |
| Tigris object storage | $0.02/GB-month with a 5 GB free tier ([pricing](https://www.tigrisdata.com/pricing/)). |

### Worked month

| Setup | Cost |
| --- | --- |
| App 1 GB ($8.50) + self-run `postgres:18` Machine 512 MB on a 1 GB volume ($4.83) + Tigris (free tier) | **≈ US$13–14** |
| The same with Managed Postgres | **≈ US$47** |

The app can auto-stop when idle, which lowers the bill but adds cold starts.

### Latency

`syd` region: ~12 ms.

### Feasibility

| Area | Assessment |
| --- | --- |
| Upload webhook | **Tigris has object notifications by webhook, with `Authorization: Bearer <token>`** ([object notifications](https://www.tigrisdata.com/docs/buckets/object-notifications/)). That is the same contract as `STORAGE_WEBHOOK_SECRET`; only the event envelope differs, so the parser changes, as it did for RustFS (ADR-0006). |
| Presigned URLs | Tigris supports them on its own endpoint, so CSP/CORS change. Alternatively, RustFS runs on a Fly Machine with a volume, unchanged. |
| Inngest, streaming | Fine: long-lived VMs. |
| Postgres | Self-run means you own Postgres ops (volume snapshots are automatic; restore is yours). |
| Deploys and Inngest sync | `flyctl deploy` from GitHub Actions; `sync-inngest.yml` runs after it in the same workflow. |

---

## 8. Render

Pricing: [render.com/pricing](https://render.com/pricing).

| Fact | Detail |
| --- | --- |
| Model | Hobby workspace $0 + per-instance prices. |
| Web service | 512 MB **$7** (tight for Next); 2 GB **$25**. |
| Postgres | 256 MB $6; 1 GB **$19**; storage $0.30/GB. |
| Object storage | **None**, so add R2 or B2. |
| Regions | Oregon, Ohio, Virginia, Frankfurt, **Singapore** ([regions](https://render.com/docs/regions)). There is no Australian region, and a service can't change region after creation. |

**Worked month:** $7–25 + $19 ≈ **US$26–44**, plus an object store. It costs more than a Sydney VPS, sits farther away, and still needs the storage-webhook change. **Not competitive.**

---

## 9. Plain AWS (beyond Lightsail)

| Fact | Detail |
| --- | --- |
| App Runner | **Closed to new customers since 2026-04-30.** AWS points to ECS Express Mode instead ([App Runner page](https://aws.amazon.com/apprunner/)). |
| RDS for PostgreSQL | **18 is available** (since 2025-11-14; [release calendar](https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-release-calendar.html)). `db.t4g.micro` in Sydney is **$0.025/h ≈ $18.25/month** before storage (third-party price-list mirrors, updated 2026-11-16). |
| Upload webhook | S3 event notifications go to SNS, SQS, Lambda or EventBridge, so the webhook needs a Lambda or an EventBridge API destination in between. |

**Worked month:** a Fargate task (~$10–15) + an ALB (~$20) + RDS (~$18) + gp3 storage (~$2.5) + public IPv4 ($3.60 each) + S3 (cents) = **≈ US$50–70**. Many line items, and **the worst value at this size**. Lightsail (section 1) is the sensible AWS choice.

---

## Not evaluated

Oracle Cloud's Always Free tier (Sydney/Melbourne) could be $0, but its capacity and reclaim behaviour weren't researched. Treat it as unverified.

---

## Ranked recommendation

1. **Least change → any VPS + Coolify.** Best of them: **BinaryLane Brisbane, 4 GB, ≈ A$23/month ex GST with backups (≈ US$15–17).** The compose file, RustFS webhook, presigned URLs, PG18 and tunnel survive as they are. Fallbacks at ~US$20–24: Vultr Sydney (backups +20%), Linode, Lightsail, DigitalOcean. What it depends on:
   - BinaryLane's A$19.60 4 GB price (read 2026-11-18).
   - Brisbane plan availability, which varies through the day.
   - The 4 GB sizing estimate, which needs swap or CI-built images for `next build`.
2. **Best latency → BinaryLane Brisbane** (same metro as the owner). Every Sydney host is ~12 ms behind it. Hetzner, Railway and Render (Singapore) are ~104 ms or more, and one recent window measured 183 ms. Depends on WonderNetwork's RTTs, Brisbane↔Sydney 11.9 ms (2026-11-15) and Brisbane↔Singapore 103.7 ms (2026-11-17).
3. **Cheapest viable → Vercel Hobby + Neon Free + Tigris (US$0, Sydney, ~12 ms).** This replaces Railway (≈ US$7–10, Singapore, ~104 ms) as the floor: it is cheaper, nearer, and keeps Next's own build, because Vercel is a verified adapter. What it costs:
   - the upload hook changes (a Tigris webhook parser, or Blob's `onUploadCompleted` on Pro);
   - `lib/viewer.ts` reads `x-vercel-ip-timezone`, with Cloudflare taken out of the path for the app host;
   - `sync-inngest.yml` gives way to the Inngest integration;
   - logs are kept for one hour;
   - and the plan rests on Vercel's "personal or non-commercial use" wording and its right to shut Hobby projects down "for any reason or no reason". It depends on the Hobby terms (read 2026-11-18). The measured 16 MB corpus fits Hobby Blob's 1 GB, so Blob is usable on Hobby too.
4. **Least ops at a VPS price → Vercel Pro (US$20 flat, Sydney).** The same changes as Hobby, without the terms question. Usage here is ~1% of the included $20 credit, so the bill is flat in practice. It costs a little more than BinaryLane, sits ~12 ms farther away, and leaves no server to patch.
5. **Cloudflare + Neon (≈ US$5)** is still the cheapest paid option and the fastest at the edge, but it remains the largest change. Cloudflare's default path is now **vinext**, a from-scratch reimplementation of Next.js in beta. It clears the old "`proxy.ts` is experimental" blocker, but swaps it for "production runs a different framework implementation than `next dev`", and its only App Router nonce test does not fully pass. OpenNext still has `proxy.ts` as experimental. Presigned URLs still cannot use a custom domain. Cloudflare Containers (≈ $6 + $5) avoid the framework risk but keep the storage change.

**Overall:** unchanged. BinaryLane Brisbane + Coolify + `cloudflared`, with off-box `pg_dump` and `rclone` to R2 (free tier), wins two of the three axes. It costs about US$15–17/month more than the cheapest option (Vercel Hobby), in exchange for the lowest latency and no architecture change. If running a server is the thing to avoid, **Vercel Pro is the runner-up**, ahead of Railway and Cloudflare. It keeps Next's own build, runs in Sydney, and has a predictable $20 bill. The work it needs is bounded: storage events, one header, and the Inngest sync.

Facts to re-check on decision day:

- BinaryLane's 4 GB price and Brisbane availability.
- Railway's per-second rates.
- Supabase's Postgres 18 status.
- OpenNext's `proxy.ts` support level.
- vinext's beta status and its compatibility run (pass rate, the Next.js version it tests against, and `next-dynamic-csp-nonce`). Then run `npx vinext check` on this repo.
- Whether workerd's `temporal` flag is on by default (scheduled for compatibility date 2026-12-01).
- Vercel's Hobby terms (§4 of the Terms of Service), Hobby's Blob and compute allowances, and the `syd1` Pro rates.
- Whether Vercel Blob's `onUploadCompleted` contract and retry policy are unchanged.
- That `x-vercel-ip-timezone` is still documented.
