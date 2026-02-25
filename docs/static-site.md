---
sidebar_position: 3
---

# Static Site Generation

static-nix-cache can export your binary cache as a set of static files suitable for deployment to any static hosting provider (GitHub Pages, Cloudflare Pages, Netlify, etc.).

## How It Works

1. **NAR files** are stored as GitHub Release assets (free binary hosting with generous limits)
2. **narinfo + nix-cache-info** are generated as static files you deploy to any static host
3. A `_redirects` file (Cloudflare Pages compatible) redirects `/nar/*` requests to the GitHub Release assets

## Generating the Static Site

After pushing store paths to static-nix-cache with the `github-releases` backend, generate the static files:

```bash
GITHUB_OWNER=myorg \
GITHUB_REPO=myproject \
GITHUB_RELEASE_TAG=nix-cache \
OUTPUT_DIR=./site \
npm run generate-static
```

This produces:

```
site/
  nix-cache-info        # Cache metadata
  <hash>.narinfo        # One per cached store path
  _redirects            # Cloudflare Pages: redirects /nar/* → GitHub Releases
```

## Deploying

### GitHub Pages

The recommended approach is to use the [deploy GitHub Action](github-actions.md), which handles building and deploying the static site automatically.

### Cloudflare Pages

```bash
npx wrangler pages deploy ./site
```

### Other Hosts

Upload the contents of the output directory to any static hosting provider. Ensure that files are served with their exact names (no `.html` extension appended).

:::note
The `_redirects` file is specific to Cloudflare Pages. For other hosts that don't support `_redirects`, Nix clients will resolve NAR URLs from the narinfo files, which point directly to the GitHub Release asset URLs.
:::
