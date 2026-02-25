---
sidebar_position: 1
---

# Getting Started

static-nix-cache is a self-hosted [Nix binary cache](https://nixos.wiki/wiki/Binary_Cache) that stores NAR files as GitHub Release assets and serves narinfo metadata via static hosting — giving you a fully functional binary cache at zero cost.

## Quick Start

The fastest way to set up a cache for your project is with the **setup** + **deploy** GitHub Actions:

```yaml
# .github/workflows/cache.yml
name: Deploy Cache

on:
  push:
    branches: [main]

permissions:
  contents: write
  pages: write
  id-token: write

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.pages.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: DeterminateSystems/nix-installer-action@main

      - uses: randymarsh77/static-nix-cache/setup@v1

      - name: Build
        run: nix build

      - uses: randymarsh77/static-nix-cache/deploy@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          static: ./site

      - uses: actions/upload-pages-artifact@v3
        with:
          path: ./site

      - uses: actions/deploy-pages@v4
        id: pages
```

This will:
1. Snapshot the existing Nix store
2. Build your flake outputs
3. Auto-detect new store paths (no need to capture output)
4. Upload NAR files to a GitHub Release
5. Generate a static site with narinfo files
6. Deploy the static site to GitHub Pages

## Use the Cache

Point Nix at your new cache by adding it as a substituter:

```nix
# flake.nix
{
  nixConfig = {
    extra-substituters = [ "https://<owner>.github.io/<repo>/cache" ];
    extra-trusted-public-keys = [ "my-cache-1:<base64-public-key>" ];
  };
  # ...
}
```

Or in `nix.conf`:

```ini
substituters = https://cache.nixos.org https://<owner>.github.io/<repo>/cache
trusted-public-keys = cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY= my-cache-1:<base64-public-key>
```
