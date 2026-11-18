# Hosting options after the Mac mini

Research for issue #243 (parent map #240). Every price was read on **2026-11-18** unless another date is given. All prices exclude tax: add 10% GST for Australian billing, and VAT where it applies. Prices change. Re-read the cited page before you commit.

## The workload being priced

| Item | Assumption used in every estimate |
| --- | --- |
| Users | A handful |
| Receipts | Tens a month (~50), a few MB each → ~150 MB of new images a month. Existing corpus assumed < 2 GB. The rescue's object count will settle this. |
| Postgres | < 1 GB on disk, near-idle |
| Egress | A few GB a month at most |
| Models | All on OpenRouter after the move. No GPU, and no model traffic on the host. |
| Inngest | Inngest Cloud, unchanged. The **Free** plan covers 50k executions, 500k events and 50 realtime connections a month ([inngest.com/pricing](https://www.inngest.com/pricing)), so it costs $0 under every option below. |

At this size, **always-on RAM is the cost driver** on every usage-billed platform, while storage and egress are rounding errors. A flat-priced VPS costs the same whether you use it or not.

Currency: AUD figures are converted at ~0.674 USD per AUD, the rate implied by [accsly.io's BinaryLane listing](https://accsly.io/en/vps/hosting/binarylane-com) (A$19.60 ≈ US$13.22). Treat the conversions as approximate.

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
| **Cloudflare (Workers + R2 + Queues + Hyperdrive) + Neon** | $5 minimum + usage | **≈ US$5** | $5 | Workers run at the Brisbane edge; DB in Sydney | edge ~local; DB ~12 ms | **Large**: new runtime, new upload hook |
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

## 3. Cloudflare (Workers + R2 + Queues + Hyperdrive), with an external Postgres

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

### Feasibility: this is the largest change

| Area | Assessment |
| --- | --- |
| Runtime | The app moves to Workers through `@opennextjs/cloudflare`. It supports Next 16 and the Node.js runtime, but **Node middleware (i.e. `proxy.ts`) has only "experimental support since 1.20.3"** ([OpenNext Cloudflare](https://opennext.js.org/cloudflare)). `proxy.ts` carries the session gate and the per-request CSP nonce (ADR-0019), so this is the riskiest single item. |
| Upload webhook | **Replaced.** R2 event notifications deliver to a **Queue**, not to a URL ([event notifications](https://developers.cloudflare.com/r2/buckets/event-notifications/)). A consumer Worker, or an HTTP pull consumer, must then do what `/api/storage-events` does today. The signal survives (`object-create` covers PutObject and CompleteMultipartUpload); the transport and the parser change. |
| Presigned URLs | **Only on `<account>.r2.cloudflarestorage.com`. They "cannot be used with custom domains"** ([presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)). `uploads.tribi.dev` retires, CORS moves to the R2 bucket, and the CSP `connect-src` gains the R2 origin (ADR-0019). The pinned AWS SDK presigner works against R2 as an S3 endpoint. |
| Postgres 18 | Through Neon (supports 14–18). Drizzle + `pg` runs through Hyperdrive. |
| Inngest | The serve endpoint runs on Workers. CPU limit: 5 min per invocation (default 30 s). Each Inngest step is a separate invocation, so this fits, but the OCR/parse steps' CPU use must be checked. Wall-clock waiting on OpenRouter is not CPU. |
| Streaming chat | Workers stream; wall time isn't billed, CPU is. |
| `cf-timezone` | The app reads a header. On Workers, `request.cf.timezone` also exists. **Verify** that the Managed Transform header still reaches the Worker. |
| Native `Temporal` | Verify the workerd runtime provides it. |
| Ops | No servers. Deploy with Workers Builds or `wrangler` in GitHub Actions. `sync-inngest.yml` loses its Coolify wait, since a Workers deploy is synchronous. |

**Alternative: Cloudflare Containers** run the existing Docker image. Charges accrue only while the container runs: a `basic` (1/4 vCPU, 1 GiB) instance always on ≈ 705 GiB-h over the included 25 → **≈ $6/month memory**, plus active CPU and $0.05/GB Oceania egress ([Containers pricing](https://developers.cloudflare.com/containers/pricing/)). Containers have **no persistent disk**, so Postgres still lives elsewhere, and the R2 and webhook changes above still apply. Less runtime change than OpenNext, same storage change.

**Backups:** Neon's own (below), plus `pg_dump` from GitHub Actions to R2. Images are already in R2, so add a second bucket or B2 for an independent copy.

---

## 4. Supabase (managed Postgres + Storage; app hosted elsewhere)

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

## 5. Neon (Postgres only)

Pricing: [neon.com/pricing](https://neon.com/pricing).

| Fact | Detail |
| --- | --- |
| Free | **$0**. 100 CU-hours per project per month, 1 GB storage, scales to zero after 5 minutes idle, sizes up to 2 CU. |
| Launch | Usage-based, no stated minimum: **$0.106/CU-hour, $0.35/GB-month**, snapshots $0.09/GB-month, 500 GB egress included. |
| Postgres version | **18 supported** (supports 14–18; [version policy](https://neon.com/docs/postgresql/postgres-version-policy), updated 2026-11-13). |
| Region | Sydney (`aws-ap-southeast-2`) ([regions](https://neon.com/docs/introduction/regions)). |

**Worked month:** the app is idle most of the day, so at the 0.25 CU minimum it runs maybe 20–60 h → 5–15 CU-h. **That fits Free.** On Launch it would be ~$1–7.

**Trap:** cold start ("a few hundred milliseconds") on the first query after idle. Neon pairs well with Cloudflare or Fly. On a VPS it is pointless, because Postgres runs locally for free.

---

## 6. Fly.io

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

## 7. Render

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

## 8. Plain AWS (beyond Lightsail)

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
3. **Cheapest viable → Railway Hobby (≈ US$7–10, Singapore)** if keeping the bill at the floor matters more than latency. It needs RustFS as a service, or the webhook replaced (ADR-0001). Cloudflare + Neon is cheaper on paper (**≈ $5**) and fastest at the edge. However, it has the largest rewrite, and two pieces are unproven for this app: `proxy.ts` on OpenNext, and presigned URLs off the custom domain.

**Overall:** BinaryLane Brisbane + Coolify + `cloudflared`, with off-box `pg_dump` and `rclone` to R2 (free tier), wins two of the three axes. It costs about US$5–10/month more than the cheapest option, in exchange for the lowest latency and no architecture change.

Facts to re-check on decision day: BinaryLane's 4 GB price and Brisbane availability; Railway's per-second rates; Supabase's Postgres 18 status; OpenNext's `proxy.ts` support level.
