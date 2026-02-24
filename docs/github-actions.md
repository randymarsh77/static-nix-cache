---
sidebar_position: 5
---

# GitHub Actions

OpenCache provides four composable actions for integrating Nix binary caching into your CI workflows. The **setup** action snapshots the Nix store before builds, enabling automatic detection of new store paths — no need to manually capture build output.

## Standalone (Single Build)

Use **setup** before your build and **deploy** after. New store paths are auto-detected:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: DeterminateSystems/nix-installer-action@main

      - uses: randymarsh77/OpenCache/setup@v1

      - name: Build
        run: nix build

      - uses: randymarsh77/OpenCache/deploy@v1
        with:
          snapshot-path: /tmp/opencache-setup/store-paths-before.txt
          backend: github-releases
          github-token: ${{ secrets.GITHUB_TOKEN }}
          static: ./site
```

## Matrix Builds (setup + save → restore → deploy)

Use **setup** + **save** in each matrix job, **restore** + **deploy** in a final job:

```yaml
jobs:
  build:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: DeterminateSystems/nix-installer-action@main

      - uses: randymarsh77/OpenCache/setup@v1

      - name: Build
        run: nix build

      - uses: randymarsh77/OpenCache/save@v1
        with:
          name: ${{ matrix.os }}

  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: randymarsh77/OpenCache/restore@v1
        id: restore

      - uses: randymarsh77/OpenCache/deploy@v1
        with:
          paths-file: ${{ steps.restore.outputs.paths-file }}
          export-dir: ${{ steps.restore.outputs.export-dir }}
          backend: github-releases
          github-token: ${{ secrets.GITHUB_TOKEN }}
          static: ./site
```

## With magic-nix-cache

If you already use [DeterminateSystems/magic-nix-cache-action](https://github.com/DeterminateSystems/magic-nix-cache-action), you can hook the deploy action into the magic-nix-cache daemon to discover built paths automatically. The default address is `127.0.0.1:37515` (the default `listen` input of magic-nix-cache-action). Combine with the **setup** action for accurate path diffing:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: DeterminateSystems/nix-installer-action@main
      - uses: DeterminateSystems/magic-nix-cache-action@main

      - uses: randymarsh77/OpenCache/setup@v1

      - name: Build
        run: nix build

      - uses: randymarsh77/OpenCache/deploy@v1
        with:
          magic-nix-cache-addr: '127.0.0.1:37515'
          snapshot-path: /tmp/opencache-setup/store-paths-before.txt
          backend: github-releases
          github-token: ${{ secrets.GITHUB_TOKEN }}
          static: ./site
```

This lets you benefit from both magic-nix-cache (fast GitHub Actions cache for CI) and OpenCache (permanent binary cache via GitHub Releases + Pages).

## Explicit Paths (Legacy)

You can still pass explicit store paths if preferred:

```yaml
      - name: Build
        run: nix build --print-out-paths | tee /tmp/store-paths.txt

      - uses: randymarsh77/OpenCache/deploy@v1
        with:
          paths-file: /tmp/store-paths.txt
```

## Action Reference

### `setup`

Snapshots the current Nix store so new paths can be auto-detected by the save or deploy actions.

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `store-dir` | no | `/nix/store` | Path to the Nix store directory |

| Output | Description |
|--------|-------------|
| `snapshot-path` | Path to the file containing the initial store snapshot |

### `save`

Exports Nix store paths (including closures) and uploads them as a workflow artifact for later retrieval. When `paths` is omitted, new paths are auto-detected using the snapshot from `setup`.

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `paths` | no | | Newline-separated Nix store paths (omit for auto-detection) |
| `name` | no | `default` | Unique artifact name suffix (e.g. `linux-x86_64`) |
| `signing-key` | no | | Nix signing key for signing exported binaries |
| `snapshot-path` | no | `/tmp/opencache-setup/store-paths-before.txt` | Path to the store snapshot (from `setup`) |
| `store-dir` | no | `/nix/store` | Path to the Nix store directory |

### `restore`

Downloads all saved artifacts matching a pattern and merges them into a single aggregated binary cache.

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `pattern` | no | `opencache-*` | Artifact name pattern to download |

| Output | Description |
|--------|-------------|
| `paths-file` | Path to file listing all aggregated store paths |
| `export-dir` | Directory containing the merged nix binary cache |

### `deploy`

Starts a temporary OpenCache server, pushes store paths to the configured backend, and optionally generates a static site.

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `paths` | ¹ | | Newline-separated store paths (standalone mode) |
| `paths-file` | ¹ | | File listing store paths (e.g. from `restore`) |
| `export-dir` | no | | Binary cache export dir (from `restore`). When set, NARs are read from this directory instead of the local nix store. |
| `snapshot-path` | ¹ | | Store snapshot from `setup` (for auto-detection) |
| `store-dir` | no | `/nix/store` | Path to the Nix store directory |
| `magic-nix-cache-addr` | ¹ | | Address of a running magic-nix-cache daemon (default for magic-nix-cache-action is `127.0.0.1:37515`). Notifies the daemon and uses snapshot-based diffing if available. |
| `backend` | no | `github-releases` | Storage backend |
| `github-token` | no | | GitHub token (required for `github-releases`) |
| `github-owner` | no | *current owner* | Repository owner |
| `github-repo` | no | *current repo* | Repository name |
| `github-release-tag` | no | `nix-cache` | Release tag for NAR storage |
| `signing-key` | no | | Nix signing key |
| `upload-secret` | no | | Bearer token for upload auth |
| `static` | no | | Output dir for static site generation |
| `port` | no | `18734` | Temporary server port |
| `compression` | no | `none` | Compression for `nix copy` |

¹ One of `paths`, `paths-file`, `snapshot-path`, or `magic-nix-cache-addr` is required.
