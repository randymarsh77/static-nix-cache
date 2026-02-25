# static-nix-cache

**Deploy a Nix binary cache for your project. For free.**

static-nix-cache stores [Nix](https://nixos.org/) build artifacts (NARs) as GitHub Release assets and serves cache metadata via static hosting — giving you a fully functional [binary cache](https://nixos.wiki/wiki/Binary_Cache) at zero cost.

## How It Works

1. **Build** your project with Nix in CI
2. **Upload** NAR files to a GitHub Release (free binary storage)
3. **Deploy** narinfo metadata as a static site to GitHub Pages

Your team gets fast, cached builds — no servers or cloud storage bills required.

## Quick Start

Add a workflow to your repository:

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

No need to capture store paths manually — the **setup** action snapshots the Nix store before your build, and the **deploy** action auto-detects new paths by diffing the store.

Then point Nix at your cache:

```nix
# flake.nix
{
  nixConfig.extra-substituters = [ "https://<owner>.github.io/<repo>/cache" ];
}
```

## Documentation

Full documentation is available at **[randymarsh77.github.io/static-nix-cache](https://randymarsh77.github.io/static-nix-cache/)**.

- [Getting Started](https://randymarsh77.github.io/static-nix-cache/docs/getting-started)
- [Configuration](https://randymarsh77.github.io/static-nix-cache/docs/configuration)
- [Static Site Generation](https://randymarsh77.github.io/static-nix-cache/docs/static-site)
- [Storage Backends](https://randymarsh77.github.io/static-nix-cache/docs/storage-backends)
- [GitHub Actions](https://randymarsh77.github.io/static-nix-cache/docs/github-actions)
- [Running the Server](https://randymarsh77.github.io/static-nix-cache/docs/server)

## License

[ISC](LICENSE)
