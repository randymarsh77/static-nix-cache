---
sidebar_position: 2
---

# Configuration

OpenCache is configured entirely through environment variables.

## Environment Variables

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

## Signing Keys

Signing narinfo files lets Nix verify that cached store paths haven't been tampered with. Generate a key pair with:

```bash
nix-store --generate-binary-cache-key my-cache-1 private.pem public.pem
```

Pass the private key to OpenCache via the `SIGNING_KEY` environment variable:

```bash
SIGNING_KEY="$(cat private.pem)" npm start
```

Distribute the **public** key (`public.pem`) to machines that consume the cache — add it to `trusted-public-keys` in their Nix configuration.
