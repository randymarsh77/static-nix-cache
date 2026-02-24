---
sidebar_position: 1
---

# Getting Started

OpenCache is a self-hosted [Nix binary cache](https://nixos.wiki/wiki/Binary_Cache) that stores NAR files as GitHub Release assets and serves narinfo metadata via static hosting — giving you a fully functional binary cache at zero cost.

## Quick Start

The fastest way to set up a cache for your project is with the **deploy** GitHub Action:

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
    steps:
      - uses: actions/checkout@v4
      - uses: DeterminateSystems/nix-installer-action@main

      - name: Build
        run: nix build --print-out-paths | tee /tmp/store-paths.txt

      - uses: randymarsh77/OpenCache/deploy@v1
        with:
          paths-file: /tmp/store-paths.txt
          github-token: ${{ secrets.GITHUB_TOKEN }}
          static: ./site
```

This will:
1. Build your flake outputs
2. Upload NAR files to a GitHub Release
3. Generate a static site with narinfo files
4. Deploy to GitHub Pages (or any static host)

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
