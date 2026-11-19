# ADR-0006: Migrate object storage from MinIO to RustFS

Date: 2026-09-15

Issue: #100

## Status

Accepted. The event schema is superseded by ADR-0020 (2026-11-19).

## Context

Upstream MinIO abandoned Docker Hub (`minio/minio` no longer pulls) and moved to source-only releases in October 2025, which left both the production and staging stacks undeployable until the interim Chainguard switch (PR #97). That stopgap — `cgr.dev/chainguard/minio`, digest-pinned — works, but carries quirks: a non-root volume migration, no shell in the image for debugging, a weak `minio --version` healthcheck, and `mc` GOGET build incompatibilities (`mc cors set` fails with a decoding `EOF`). The object store is load-bearing: it holds receipt images and its bucket-notification webhook is the authoritative "upload finished" signal that promotes a receipt from `uploading` to `pending` (ADR-0001).

SeaweedFS and Garage were ruled out because neither offers S3 bucket notifications, and managed R2/B2 would be a separate trust-model decision.

RustFS is a MinIO-compatible object store (S3 API, bucket notifications, bundled console, ARM images, an active compatibility gate) and is the only remaining candidate that preserves the bucket-notification signal.

## Decision

- **Migrate to RustFS**, pinned by image digest. The build proven in the spike is `rustfs/rustfs@sha256:97171b3d72cd47dc81000f92ea84de25608bfc35a94c965501afaeb5d99f6035` (`1.0.0-rc.6`, revision `5cd58319`, built 2026-09-11). Pin the digest and record the exact build at every cutover.
- **Single-node only.** Distributed mode is still under test upstream; one mini, one node. This is a deliberate limitation, not an oversight.
- **Move by volume copy, not by object copy.** The spike proved the single-node on-disk format is interchangeable in both directions between MinIO and RustFS (see Evidence), so no object-level migration is needed. Coolify names compose volumes `<resource-uuid>_<volume>`, and this change also _renames_ the volume, so cutover is: snapshot the old volume, copy its contents into a new `<resource-uuid>_rustfs-data` volume, `chown -R 10001:10001`, then start RustFS on it.
- **Rename the storage layer to be vendor-neutral.** `lib/minio/` → `lib/storage/`, the `MINIO_*` env vars → `STORAGE_*`, the webhook route `/api/minio-events` → `/api/storage-events`, and the DB column `minio_object_key` → `object_key`. Misleading names are a maintenance cost once MinIO is gone.
- **Rewrite the event parser** for RustFS's envelope and replace the MinIO fixture with a captured RustFS payload (contract tests included). The current strict MinIO schema rejects RustFS events. (Superseded by ADR-0020: the parser is now the RustFS adapter behind an app-owned storage event; see the 2026-11-19 update below.)
- **Run the app as a least-privilege IAM identity, not root.** RustFS's root account bypasses IAM policy evaluation, so the app authenticates as an IAM user (`receipts-app`) scoped to `s3:GetObject`/`s3:PutObject`/`s3:DeleteObject` on the bucket only — the exact actions it uses (presigned PUT, image reads, receipt deletion). The init job creates the policy, user, and binding idempotently; root credentials are used only by the init job and the console. This bounds a compromised app or a code bug to the receipts bucket rather than full storage admin.
- **Namespace object keys by owner** (`users/<userId>/<uuid>.<ext>`). The bucket stays single and shared — one notification rule, one policy — and the app enforces ownership on every read; the prefix adds defence in depth, makes ownership obvious at the storage layer, and turns per-user export/erasure/lifecycle into a prefix operation. Pre-existing unprefixed keys remain valid.

## Evidence (spike, issue #100)

Run in a scratch compose outside the repo. All proofs green on `1.0.0-rc.6`:

1. **Presigned PUT, exact SDK profile.** The repo's pinned `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (`3.1103.0`) emits a presigned URL carrying `x-amz-checksum-crc32` and `x-amz-sdk-checksum-algorithm=CRC32`. A browser-style PUT (plain body, `Content-Type` only, no trailers) returns 200. RustFS tolerates the stale empty-CRC32 query value exactly as MinIO does; no frontend change is needed.
2. **Webhook to a container-internal address.** RustFS `HEAD`s the endpoint origin root, then delivers `POST` with `Authorization: Bearer …` (same contract as `STORAGE_WEBHOOK_SECRET`).
3. **Bucket CORS via the S3 API**, verified by a real preflight: listed origin → 200 with `/` `Access-Control-Allow-Origin`; unlisted origin → 403.
4. **Console + `rc` CLI**: console at `/rustfs/console`; `rc 0.1.35` handles alias/bucket/object/event/cors.
5. **On-disk compatibility (added during the spike).** MinIO-written volume read by RustFS (exact bytes), and a RustFS-written object read back by MinIO. Both directions list and serve correctly after a `chown` to the target uid.

## Consequences

- **Payload differences drive the parser rewrite.** RustFS's `requestParameters` is the raw request-header map (no `region`, no `sourceIPAddress`) and `responseElements` lacks MinIO's `x-minio-*` keys, so the current strict schema rejects it. The fields the server uses — `Records[].s3.object.key` and `eventName` — are present and stable, so the schema becomes `z.looseObject` and requires only what the consumer reads. RustFS also percent-encodes the key (slashes become `%2F`), so the schema decodes it with `decodeURIComponent` before use; without that, keys under the `users/<userId>/` prefix never match the stored row and no extraction is triggered. (Superseded by ADR-0020: both rules now live in the RustFS adapter; see the 2026-11-19 update below.)
- **Notification config differs.** The ARN becomes `arn:rustfs:sqs:us-east-1:primary:webhook`; `RUSTFS_NOTIFY_ENABLE=true` is required in addition to the per-target `_PRIMARY` variables; and the webhook target's queue directory must live **outside** the data volume, or it shows up as a phantom bucket. The init job registers `--event put` (which expands to `s3:ObjectCreated:*`, covering single PUT and multipart completion); delete events are dropped because the app never consumes them. `rc bucket event add` replaces the rule for its ARN, so it runs unconditionally every deploy rather than being guarded.
- **Reusing a MinIO data volume carries stale notification rules.** The copied volume's bucket metadata stores MinIO's own notification config, whose `arn:minio:…` target does not exist in RustFS. An unresolvable rule silently breaks dispatch for the entire bucket — observed at the production cutover: the rule was registered and the target reachable, yet zero events were delivered and nothing queued. `rustfs-init` now removes the known MinIO webhook ARN before adding the RustFS rule; a fresh volume (as on staging) never has this.
- **CORS is server-level and comma-separated** (`RUSTFS_CORS_ALLOWED_ORIGINS`), replacing MinIO's single `MINIO_API_CORS_ALLOW_ORIGIN`. Two origins are allowed: the app's browser origin (`STORAGE_CORS_ORIGIN`, required) and the console's — derived from `STORAGE_CONSOLE_HOST` + `STORAGE_CONSOLE_HOST_PORT` so the port is defined only once — with a missing app origin failing `docker compose config` instead of silently breaking uploads. The console listener's own CORS (`RUSTFS_CONSOLE_CORS_ALLOWED_ORIGINS`, default `*`) is pinned to the same derived origin; direct console access is same-origin and unaffected, so this only removes a blanket cross-origin allowance.
- **The console needs the API browser-reachable.** MinIO's console proxied to its backend server-side; the RustFS console is a browser app that calls `${serverHost}/rustfs/admin/v3` directly, defaulting to `http://localhost:9000`. So (a) the S3/admin API is published on a private LAN/tailnet host port (`STORAGE_API_HOST_PORT`) purely for the console — reversing the earlier "no consumer for a host-mapped API port" decision (PR #98), which this now supersedes; (b) the console origin must be allowlisted in `RUSTFS_CORS_ALLOWED_ORIGINS` or the browser blocks login; and (c) the server address is set once per browser in the console's **Server Configuration** page (no env var exists for it).
- **The public hostname reaches more than the data plane.** `uploads.tribi.dev → rustfs:9000`, and that listener also serves the admin API (`/rustfs/admin/v3/*`) and internode RPC (`/rustfs/rpc/`, `/rustfs/peer/`). Unsigned requests get 403, but the surface should be closed at the edge — a Cloudflare WAF rule on the hostname denying those prefixes, leaving presigned `/receipts/*` traffic untouched. Traefik/Coolify cannot path-filter. (MinIO had the same exposure, so this is not a regression.)
- **No encryption at rest yet.** RustFS supports KMS (`RUSTFS_KMS_*`); enabling it is a separate decision. TLS in transit is already covered (Cloudflare Full Strict + tunnel).
- **Healthcheck improves.** The image ships `sh` + `curl`, so liveness/readiness are real HTTP probes instead of a `--version` alive check. The compose healthcheck uses `/health/ready`, which answers 503 until storage, IAM, and lock are ready — the same signal `rustfs-init` gates on.
- **Young project.** It is a `1.0.0-rc` build. Pin by digest, keep the pre-cutover volume snapshot, and treat upstream format compatibility as unguaranteed — re-verify at cutover.

## Rollback

This change is deliberately **forward-only**: reverting the application to a pre-RustFS revision is not supported, and the schema rename is never undone automatically.

Why there is no pre-RustFS rollback:

- MinIO is abandoned — that is the whole reason for migrating. Reinstating it is not a fallback we want to keep alive.
- The pre-RustFS application is coupled to MinIO _and_ to the old column name. Restoring it would mean reverting `minio_object_key` and redeploying a stack we deliberately retired: carrying a down-migration for dead code, forever.
- The only thing genuinely worth protecting is the object data, and it is protected: the on-disk formats are compatible (spike-verified), the volume is snapshotted before cutover, and RustFS itself is redeployable. Losing the ability to run MinIO again is the point, not a risk.

What we actually do:

1. **Before cutover:** snapshot the production object volume as a data artifact. Coolify prefixes compose volume names with the resource UUID (this host: prod `dyuvbqcsygohuquqenb7il3d_minio-data`, staging `lzmamoc1rgdnsoznzmty5drc_minio-data`), so derive the real name first — `docker inspect <minio-container> --format '{{range .Mounts}}{{.Name}} -> {{.Destination}}{{"\n"}}{{end}}'` or `docker volume ls | grep minio-data` — then `docker run --rm -v <volume>:/data -v "$PWD":/backup alpine tar czf /backup/minio-data-pre-rustfs.tgz -C /data .`.
2. **If RustFS misbehaves:** fix forward. Redeploy RustFS, or roll back to a previous _RustFS_ deployment — the volume is compatible, so object data survives either way.
3. **Staging first:** staging runs the migration before production; promotion is a `staging → main` merge with the same snapshot taken beforehand.

If a pre-RustFS revision ever had to run again (not planned), an operator must restore the old column name by hand first — `ALTER TABLE receipts RENAME COLUMN object_key TO minio_object_key;` — because Drizzle's migrations are forward-only and will not do it.

## Update (2026-11-19): the event schema becomes one adapter among several

The parser rewrite above produced a schema shaped by RustFS's envelope, which made RustFS's format the app's format. The app now defines its own storage event — an object finished uploading, named by its object key — and each provider has an adapter that produces one (ADR-0020). The RustFS adapter keeps both rules recorded here: loose objects, and a percent-decoded key.

Only the event schema changes. RustFS still serves local development, and it still serves production until the move off the Mac mini (issue #240) lands; retiring it there is that deployment's decision, recorded in its own ADR (#251) when it lands, not by this update.

## Related

- Issue #100 (evaluate and migrate object storage)
- ADR-0001 (upload via presigned URL and bucket notification)
- ADR-0005 (Coolify deployment on the Mac mini)
- ADR-0020 (the app owns its storage-event format) — supersedes the event schema above
- PR #97 (Chainguard MinIO stopgap)
