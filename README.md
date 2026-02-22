# OpenCache
Nix binary cache

A self-hosted [Nix binary cache](https://nixos.wiki/wiki/Binary_Cache) server built with Node.js.
Store and serve Nix store paths (NARs + narinfo files) using either local disk or any
S3-compatible object store (AWS S3, Cloudflare R2, Backblaze B2, MinIO, …).

## Features

* Full Nix binary cache HTTP API (`/nix-cache-info`, `/:hash.narinfo`, `/nar/:filename`)
* Local filesystem storage **and** S3-compatible storage backends
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
| `STORAGE_BACKEND` | `local` | `local` or `s3` |
| `LOCAL_STORAGE_PATH` | `./cache` | Root directory for local storage |
| `S3_BUCKET` | *(required for s3)* | S3 bucket name |
| `S3_REGION` | `auto` | S3 region |
| `S3_ENDPOINT` | *(AWS default)* | Custom endpoint URL (e.g. Cloudflare R2) |
| `S3_ACCESS_KEY_ID` | | S3 access key ID |
| `S3_SECRET_ACCESS_KEY` | | S3 secret access key |
| `S3_FORCE_PATH_STYLE` | `false` | Use path-style S3 URLs |
| `SIGNING_KEY` | *(disabled)* | Signing key `<keyname>:<base64-ed25519-private>` |
| `UPLOAD_SECRET` | *(open)* | Bearer token required for PUT requests |

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
