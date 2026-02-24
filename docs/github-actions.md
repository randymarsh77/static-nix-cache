---
sidebar_position: 5
---

# GitHub Actions

OpenCache provides three composable actions for integrating Nix binary caching into your CI workflows. They can be used standalone (single build) or together to aggregate store paths across a matrix of builds before deploying.

## Standalone (Single Build)

When you don't need to aggregate across matrix jobs, use the **deploy** action directly:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: DeterminateSystems/nix-installer-action@main

      - name: Build
        run: nix build --print-out-paths | tee /tmp/store-paths.txt

      - uses: randymarsh77/OpenCache/deploy@v1
        with:
          paths-file: /tmp/store-paths.txt
          backend: github-releases
          github-token: ${{ secrets.GITHUB_TOKEN }}
          static: ./site
```

## Matrix Builds (save → restore → deploy)

Use **save** in each matrix job, **restore** + **deploy** in a final job:

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

      - name: Build
        run: nix build --print-out-paths | tee /tmp/store-paths.txt

      - uses: randymarsh77/OpenCache/save@v1
        with:
          paths: |
            $(cat /tmp/store-paths.txt)
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

## Action Reference

### `save`

Exports Nix store paths (including closures) and uploads them as a workflow artifact for later retrieval.

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `paths` | **yes** | | Newline-separated Nix store paths |
| `name` | no | `default` | Unique artifact name suffix (e.g. `linux-x86_64`) |

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

¹ One of `paths` or `paths-file` is required.
