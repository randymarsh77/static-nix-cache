---
sidebar_position: 4
---

# Storage Backends

static-nix-cache supports four storage backends for NAR files.

## GitHub Releases (Recommended)

The `github-releases` backend stores NAR files as assets on a GitHub Release. This is the recommended backend for static-site deployments — it provides free, reliable binary hosting.

```bash
STORAGE_BACKEND=github-releases \
GITHUB_TOKEN=ghp_... \
GITHUB_OWNER=myorg \
GITHUB_REPO=myproject \
GITHUB_RELEASE_TAG=nix-cache \
npm start
```

### Incremental additions & pruning

New store paths are added incrementally — each `nix copy` uploads new assets alongside existing ones on the same release (identified by `GITHUB_RELEASE_TAG`).

Over time, old assets that are no longer referenced by any narinfo file may accumulate. The `pruneAssets()` method compares release assets against local narinfo files and deletes unreferenced ones.

A configurable **retention period** (`GITHUB_PRUNE_RETENTION_DAYS`) prevents recently-uploaded assets from being removed before their narinfo has been propagated. Set it to `0` (the default) to delete orphans immediately.

```js
const storage = createStorage(config);
await storage.pruneAssets({ retentionDays: 7 });
```

## Cloudflare R2 (private)

The `r2` backend stores the cache in a Cloudflare R2 bucket, in the layout Nix's
own `s3://` store reads:

```
nix-cache-info
<hash>.narinfo
nar/<filename>
```

The bucket stays private. Machines read it with an R2 API token, so this is the
backend for caches of private repositories, whose GitHub release assets Nix
cannot download.

```bash
STORAGE_BACKEND=r2 \
R2_ACCOUNT_ID=<account-id> \
R2_BUCKET=my-nix-cache \
R2_ACCESS_KEY_ID=<key-id> \
R2_SECRET_ACCESS_KEY=<secret> \
npm start
```

### Creating the bucket and tokens

1. In the Cloudflare dashboard, create an R2 bucket (for example
   `my-nix-cache`). Leave public access and custom domains off.
2. Create two R2 API tokens scoped to that bucket:
   - **CI** with *Object Read & Write*, for the deploy action.
   - **Readers** with *Object Read only*, for the machines that substitute from
     the cache.
3. Note the account ID; the S3 endpoint is
   `https://<account-id>.r2.cloudflarestorage.com`.

The first upload writes `nix-cache-info`, so read-only tokens never need to
create it.

### Reading the cache

Add the bucket as a substituter on each machine, with the cache's public key:

```nix
nix.settings = {
  substituters = [
    "s3://my-nix-cache?endpoint=<account-id>.r2.cloudflarestorage.com&region=auto&profile=nix-cache"
  ];
  trusted-public-keys = [ "my-cache-1:..." ];
};
```

The Nix daemon does the downloading, so the read-only token goes in **root's**
AWS credentials file (`/var/root/.aws/credentials` on macOS,
`/root/.aws/credentials` on Linux), under the profile named in the URL:

```ini
[nix-cache]
aws_access_key_id = <read-only key id>
aws_secret_access_key = <read-only secret>
```

Keep that file readable only by root (`chmod 600`).

## Local Filesystem

The `local` backend stores NAR and narinfo files on the local filesystem.

```bash
STORAGE_BACKEND=local \
LOCAL_STORAGE_PATH=./cache \
npm start
```

## S3-Compatible

The `s3` backend works with AWS S3, Cloudflare R2, Backblaze B2, MinIO, and any S3-compatible object store.

By default it keeps narinfo under `narinfo/`, for buckets read through the
static-nix-cache server. Set `S3_LAYOUT=nix` to use the layout Nix's own `s3://`
store reads, as the `r2` backend does.

```bash
STORAGE_BACKEND=s3 \
S3_BUCKET=my-nix-cache \
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
S3_ACCESS_KEY_ID=<key-id> \
S3_SECRET_ACCESS_KEY=<secret> \
npm start
```
