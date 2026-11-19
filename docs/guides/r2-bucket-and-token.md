# Create the R2 bucket and API token

Production receipt images are moving off the Mac mini's self-hosted RustFS bucket and into Cloudflare R2 ([issue #240](https://github.com/Kevin-RB/possum-receipt/issues/240)). This guide creates the bucket, mints the single token that both the app and the restore use, and records where the credentials live. It is a dashboard job of about ten minutes; nothing here touches code.

The bucket is private and holds every rescued production receipt image: 75 objects under `users/<ownerId>/<uuid>.jpg`, about 16.1 MB. R2 is reached over the plain S3 API, which `lib/storage/client.ts` already speaks — `@aws-sdk/client-s3`, `forcePathStyle: true`, `region: "us-east-1"` — so the app does not need to know it is talking to R2 rather than RustFS.

## 1. Create the bucket

In the Cloudflare dashboard open **R2 object storage → Overview → Create bucket**, and set the three fields below before pressing **Create bucket**.

1. **Bucket name: `receipts`.** The rescued RustFS bucket was called `receipts`, and the app defaults `BUCKET` to `process.env.STORAGE_BUCKET ?? "receipts"`. Every stored `object_key` already begins `users/<ownerId>/`, so keeping the name means the restore is a straight object copy with no key rewriting and no database change.
2. **Location hint: Oceania (`oc`).** This is the closest hint to Sydney. It can only be set when the bucket is created and cannot be changed afterwards, so it has to be right now; the hint decides where the objects are stored, not who can reach them.
3. **Public access: off.** Do not enable the `r2.dev` development URL and do not attach a custom domain. Either one would serve every receipt image to anyone holding the link, which is the opposite of what this bucket is for.

## 2. Create the API token

Go to **R2 object storage → Overview → Account Details → Manage (API Tokens) → Create Account API token**, and set:

- **Permissions:** **Object Read & Write**.
- **Specify bucket:** **`receipts`** — this bucket only, not all buckets. This is what keeps the token away from `receipts-backups` when it exists, and from every other bucket in the account.
- **TTL:** leave the default unless you intend to rotate the token. If you do set an expiry, diarise it: when the token expires, uploads and image reads stop with it.

Nothing beyond object access is needed. R2's event notifications require the Workers Paid plan, and this design deliberately does not use them: the app learns that an upload finished from one authenticated call the browser makes after its successful `PUT`, verified server-side, with a page-load reconciliation as the safety net (ADR-0020). So there is no Queue to administer and no reason to grant more than `Object Read & Write` on `receipts`.

Managing bucket configuration later is a separate permission, not this token's. Bucket locks and lifecycle rules on the backups bucket ([#253](https://github.com/Kevin-RB/possum-receipt/issues/253)) need a token with **R2 Storage Write** configuration permission, which can be that bucket's own token, created with it. Leave this one object-only rather than growing permissions it does not use.

Press **Create Account API token**, then copy both values, because they are all you get:

- **Access Key ID**
- **Secret Access Key** — shown once, at creation, and never again. If it is lost, delete the token and create a new one; there is no way to read it back.

The same screen shows the **Account ID**, which the endpoint needs: `https://<account-id>.r2.cloudflarestorage.com`.

One token serves both the app (uploads, downloads, deletes) and this restore. There is no second credential to create.

Cloudflare's reference for the token screen and its permissions is <https://developers.cloudflare.com/r2/api/tokens/>.

## 3. Store the credentials

The credentials live outside the repo, in one file only your user can read:

```sh
mkdir -p ~/receipt-rescue
$EDITOR ~/receipt-rescue/r2-receipts.env
chmod 600 ~/receipt-rescue/r2-receipts.env
```

The file is `KEY=VALUE`, with no `export` and no quoting:

```sh
STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
STORAGE_PUBLIC_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
STORAGE_ACCESS_KEY=<Access Key ID>
STORAGE_SECRET_KEY=<Secret Access Key>
STORAGE_BUCKET=receipts
```

The names are the app's own, so these five lines can later be pasted into Vercel as they stand.

`STORAGE_ENDPOINT` and `STORAGE_PUBLIC_ENDPOINT` are deliberately identical. A pre-signed URL is signed for one host, and R2 only signs the `.r2.cloudflarestorage.com` endpoint; putting a custom domain in front would produce URLs the browser cannot use.

Keep a copy in a password manager. The secret is unrecoverable from the dashboard, and re-minting it means updating both the deployment and this file. Do not put the file in the repo, in a ticket, or in shell history — the `0600` mode is what keeps it to your account, and the editor above avoids the history.

## 4. Verify

Load the file and map its names onto the ones the AWS CLI reads. Every command below then carries `--endpoint-url "$R2_ENDPOINT"` and `--region us-east-1`, because R2 accepts only `us-east-1` and needs path-style addressing.

```sh
set -a
. ~/receipt-rescue/r2-receipts.env
set +a

export AWS_ACCESS_KEY_ID="$STORAGE_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$STORAGE_SECRET_KEY"
export R2_ENDPOINT="$STORAGE_ENDPOINT"

# AWS CLI v2 adds CRC32 checksums by default; these objects were written without
# them, so ask for checksums only where the request requires one.
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
```

### Read one key back

List one key, then read it, which proves S3 access works end to end:

```sh
KEY=$(aws s3api list-objects-v2 \
  --bucket receipts \
  --endpoint-url "$R2_ENDPOINT" --region us-east-1 \
  --query 'Contents[0].Key' --output text)
echo "$KEY"

aws s3api head-object \
  --bucket receipts --key "$KEY" \
  --endpoint-url "$R2_ENDPOINT" --region us-east-1

aws s3api get-object \
  --bucket receipts --key "$KEY" /tmp/r2-read-check.jpg \
  --endpoint-url "$R2_ENDPOINT" --region us-east-1

file /tmp/r2-read-check.jpg
```

Done when the key looks like `users/<ownerId>/<uuid>.jpg`, `head-object` prints metadata including `ContentType` and `ContentLength`, and the downloaded file is the same size and opens as an image.

### Confirm the object count and total size

```sh
aws s3api list-objects-v2 \
  --bucket receipts \
  --endpoint-url "$R2_ENDPOINT" --region us-east-1 \
  --query 'length(Contents)' --output text

aws s3api list-objects-v2 \
  --bucket receipts \
  --endpoint-url "$R2_ENDPOINT" --region us-east-1 \
  --query 'sum(Contents[].Size)' --output text
```

Done when the answers are `75` and `16871113`. `ListObjectsV2` returns up to 1000 keys per page and the bucket has 75, so one call is the whole bucket.

### Confirm the bucket is not public

The check is the dashboard, not the S3 endpoint: **R2 object storage → receipts → Settings → Public access** must list no `r2.dev` URL and no custom domain. If an `r2.dev` URL is there, public access is on and has to be turned off — that host serves every receipt image to anyone holding the link.

A curl at the private endpoint proves nothing about this. A request to `https://<account>.r2.cloudflarestorage.com/<bucket>/<key>` answers `403` whether or not a public URL exists, because public access is served from a separate `r2.dev` host or custom domain, never from the S3 API host:

```sh
curl -s -o /dev/null -w '%{http_code}\n' "$R2_ENDPOINT/receipts/$KEY"
```

That `403` proves only that unsigned S3 requests are refused, which is a different property.

If public access is on, `https://pub-<HASH>.r2.dev/$KEY` answers `200`, and every receipt image is readable by anyone with the link.

### Confirm the token is scoped to `receipts`

These three must fail. Read the error code, not the exit status, since the CLI exits non-zero either way:

```sh
aws s3api list-buckets \
  --endpoint-url "$R2_ENDPOINT" --region us-east-1

aws s3api head-object \
  --bucket receipts-backups --key any \
  --endpoint-url "$R2_ENDPOINT" --region us-east-1

aws s3api get-bucket-location \
  --bucket receipts \
  --endpoint-url "$R2_ENDPOINT" --region us-east-1
```

Done when each answers `AccessDenied`. `Object Read & Write` is an object permission, not an account one, so the token cannot enumerate buckets. It names `receipts`, so any other bucket is out of scope — `receipts-backups` does not exist yet, so today this may answer `NoSuchBucket` instead, which is also a refusal; re-run it once the backups bucket exists to see `AccessDenied`. And bucket location is a bucket-level permission, so it is denied even on `receipts` itself.

Now prove the token can do what it must, with a scratch object at the bucket root:

```sh
printf 'r2 token check\n' > /tmp/r2-token-check.txt

aws s3api put-object \
  --bucket receipts --key token-check.txt --body /tmp/r2-token-check.txt \
  --endpoint-url "$R2_ENDPOINT" --region us-east-1

aws s3api get-object \
  --bucket receipts --key token-check.txt /tmp/r2-token-check.out \
  --endpoint-url "$R2_ENDPOINT" --region us-east-1

diff /tmp/r2-token-check.txt /tmp/r2-token-check.out && echo same

aws s3api delete-object \
  --bucket receipts --key token-check.txt \
  --endpoint-url "$R2_ENDPOINT" --region us-east-1

rm /tmp/r2-token-check.txt /tmp/r2-token-check.out
```

Done when `put-object` prints an `ETag`, `get-object` writes the file, `diff` is silent and prints `same`, and `delete-object` returns `204` with no output. Run the count command again and it is back to 75.

## Not in this guide

Each of these is a later ticket, and the bucket and token above do not depend on any of them.

- **CORS for browser uploads.** The app's presigned PUT and browser image reads need CORS rules on the bucket; that is configured separately.
- **Upload-finished events through a Queue.** R2 has no bucket-notification webhook, so the signal that promotes a receipt from `uploading` to `pending` (ADR-0001) becomes a Queue and its consumer.
- **The `receipts-backups` bucket and its lock.** Backups get their own bucket, created later, with retention configured then.

## Related

- Issue #240 (hosting and storage)
- ADR-0001 (upload via presigned URL and bucket notification)
- ADR-0006 (the RustFS migration whose bucket names and key layout this carries over)
