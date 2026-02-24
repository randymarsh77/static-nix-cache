---
sidebar_position: 4
---

# Storage Backends

OpenCache supports three storage backends for NAR files.

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

## Local Filesystem

The `local` backend stores NAR and narinfo files on the local filesystem.

```bash
STORAGE_BACKEND=local \
LOCAL_STORAGE_PATH=./cache \
npm start
```

## S3-Compatible

The `s3` backend works with AWS S3, Cloudflare R2, Backblaze B2, MinIO, and any S3-compatible object store.

```bash
STORAGE_BACKEND=s3 \
S3_BUCKET=my-nix-cache \
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
S3_ACCESS_KEY_ID=<key-id> \
S3_SECRET_ACCESS_KEY=<secret> \
npm start
```
