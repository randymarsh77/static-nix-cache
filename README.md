# OpenCache
Nix binary cache

A self-hosted [Nix binary cache](https://nixos.wiki/wiki/Binary_Cache) server built with Node.js.
Store and serve Nix store paths (NARs + narinfo files) using either local disk, any
S3-compatible object store (AWS S3, Cloudflare R2, Backblaze B2, MinIO, …), or GitHub Releases.

## Features

* Full Nix binary cache HTTP API (`/nix-cache-info`, `/:hash.narinfo`, `/nar/:filename`)
* Local filesystem, S3-compatible, and **GitHub Releases** storage backends
* **Static site generation** – export your cache as static files deployable to Cloudflare Pages, GitHub Pages, etc.
* Optional narinfo signing with an ed25519 key pair
* Optional upload authentication via a shared bearer token
* Configured entirely through environment variables – easy to deploy on any platform

## Quick start

```bash
npm install
npm start          # listens on port 8080 by default
```

Point Nix at the cache by adding it as a substituter:

```nix
# /etc/nix/nix.conf
substituters = https://cache.nixos.org http://localhost:8080
trusted-public-keys = cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY= my-cache-1:<base64-public-key>
```

Push a store path to the cache with `nix copy`:

```bash
nix copy --to 'http://localhost:8080?compression=none' /nix/store/<hash>-<name>
```

## Configuration

All options are set via environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP port to listen on |
| `STORE_DIR` | `/nix/store` | Nix store directory |
| `CACHE_PRIORITY` | `30` | Cache priority (lower = higher priority) |
| `STORAGE_BACKEND` | `local` | `local`, `s3`, or `github-releases` |
| `LOCAL_STORAGE_PATH` | `./cache` | Root directory for local storage |
| `S3_BUCKET` | *(required for s3)* | S3 bucket name |
| `S3_REGION` | `auto` | S3 region |
| `S3_ENDPOINT` | *(AWS default)* | Custom endpoint URL (e.g. Cloudflare R2) |
| `S3_ACCESS_KEY_ID` | | S3 access key ID |
| `S3_SECRET_ACCESS_KEY` | | S3 secret access key |
| `S3_FORCE_PATH_STYLE` | `false` | Use path-style S3 URLs |
| `SIGNING_KEY` | *(disabled)* | Signing key `<keyname>:<base64-ed25519-private>` |
| `UPLOAD_SECRET` | *(open)* | Bearer token required for PUT requests |
| `GITHUB_TOKEN` | | GitHub personal access token (for `github-releases` backend) |
| `GITHUB_OWNER` | | GitHub repository owner |
| `GITHUB_REPO` | | GitHub repository name |
| `GITHUB_RELEASE_TAG` | `nix-cache` | Tag name for the GitHub Release holding NAR files |
| `GITHUB_PRUNE_RETENTION_DAYS` | `0` | Days to keep orphaned release assets before pruning (0 = immediate) |

### Generating a signing key pair

```bash
nix-store --generate-binary-cache-key my-cache-1 private.pem public.pem
# Or using openssl + nix key format conversion tooling
```

### Cloudflare R2 example

```bash
STORAGE_BACKEND=s3 \
S3_BUCKET=my-nix-cache \
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
S3_ACCESS_KEY_ID=<key-id> \
S3_SECRET_ACCESS_KEY=<secret> \
UPLOAD_SECRET=mysecret \
SIGNING_KEY='my-cache-1:<base64-private>' \
npm start
```

## Running tests

```bash
npm test
```

## GitHub Releases + Static Site

For projects that want to serve a Nix binary cache cheaply using static hosting
(Cloudflare Pages, GitHub Pages, etc.) with NAR binaries stored on GitHub Releases:

### How it works

1. **NAR files** are uploaded as GitHub Release assets (free binary hosting)
2. **narinfo + nix-cache-info** are generated as static files you deploy to any static host
3. A `_redirects` file (Cloudflare Pages compatible) redirects `/nar/*` requests to GitHub Releases

### Workflow

**Step 1 – Push store paths to OpenCache using the `github-releases` backend:**

```bash
STORAGE_BACKEND=github-releases \
GITHUB_TOKEN=ghp_... \
GITHUB_OWNER=myorg \
GITHUB_REPO=myproject \
GITHUB_RELEASE_TAG=nix-cache \
SIGNING_KEY='my-cache-1:<base64-private>' \
npm start
```

Then push paths with `nix copy`:

```bash
nix copy --to 'http://localhost:8080?compression=none' /nix/store/<hash>-<name>
```

**Step 2 – Generate the static site:**

```bash
GITHUB_OWNER=myorg \
GITHUB_REPO=myproject \
GITHUB_RELEASE_TAG=nix-cache \
OUTPUT_DIR=./site \
npm run generate-static
```

This produces a directory with:

```
site/
  nix-cache-info        # Cache metadata
  <hash>.narinfo        # One per cached store path
  _redirects            # Cloudflare Pages: redirects /nar/* → GitHub Releases
```

**Step 3 – Deploy the static site:**

```bash
# Cloudflare Pages
npx wrangler pages deploy ./site

# Or commit to a GitHub Pages branch, Netlify, etc.
```

**Step 4 – Point Nix at your cache:**

```nix
# /etc/nix/nix.conf (or flake.nix extraOptions)
substituters = https://cache.nixos.org https://my-cache.example.com
trusted-public-keys = cache.nixos.org-1:... my-cache-1:<base64-public>
```

### Incremental additions & pruning

The `github-releases` backend stores NAR files as assets on a **single** GitHub
Release (identified by `GITHUB_RELEASE_TAG`).  New store paths are added
incrementally – each `nix copy` simply uploads new assets alongside existing
ones.

Over time, old assets that are no longer referenced by any narinfo file may
accumulate.  The `pruneAssets()` method (exposed on the storage backend)
compares the release assets against the local narinfo files and deletes any
asset that is not referenced.

A configurable **retention period** (`GITHUB_PRUNE_RETENTION_DAYS`) prevents
recently-uploaded assets from being removed before their narinfo has been
propagated.  Set it to `0` (the default) to delete orphans immediately, or to a
positive number to keep them for that many days.

You can invoke pruning programmatically:

```js
const storage = createStorage(config);
await storage.pruneAssets({ retentionDays: 7 });
```
