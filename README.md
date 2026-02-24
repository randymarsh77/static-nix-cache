# OpenCache

**Deploy a Nix binary cache for your project. For free.**

OpenCache stores [Nix](https://nixos.org/) build artifacts (NARs) as GitHub Release assets and serves cache metadata via static hosting — giving you a fully functional [binary cache](https://nixos.wiki/wiki/Binary_Cache) at zero cost.

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

Then point Nix at your cache:

```nix
# flake.nix
{
  nixConfig.extra-substituters = [ "https://<owner>.github.io/<repo>/cache" ];
}
```

## Documentation

Full documentation is available at **[randymarsh77.github.io/OpenCache](https://randymarsh77.github.io/OpenCache/)**.

- [Getting Started](https://randymarsh77.github.io/OpenCache/docs/getting-started)
- [Configuration](https://randymarsh77.github.io/OpenCache/docs/configuration)
- [Static Site Generation](https://randymarsh77.github.io/OpenCache/docs/static-site)
- [Storage Backends](https://randymarsh77.github.io/OpenCache/docs/storage-backends)
- [GitHub Actions](https://randymarsh77.github.io/OpenCache/docs/github-actions)
- [Running the Server](https://randymarsh77.github.io/OpenCache/docs/server)

## License

[ISC](LICENSE)
