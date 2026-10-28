---
sidebar_position: 5
---

# GitHub Actions

static-nix-cache provides composable actions for integrating Nix binary caching into your CI workflows. Use **setup** + **deploy** for simple builds, or add **save** when you need to defer deployment (e.g. matrix builds with a final aggregation job). Store paths are always auto-detected — no need to manually capture build output.

## Version Compatibility

All examples below use `v1`, a floating major tag tracking the supported
setup/save/deploy API. It includes `setup/action.yml`, `save/action.yml`, and
`deploy/action.yml` with the auto-detection API documented here. Keep all three
actions on the same major version, including across build and deployment jobs.
Consumers that require immutable dependencies can instead pin all three actions
to the same verified full commit SHA.

On September 26, 2026, `v1` was updated from
[`1e75e1bfbe0af3dd4165ea6c1a7f378ce580be21`](https://github.com/randymarsh77/static-nix-cache/tree/1e75e1bfbe0af3dd4165ea6c1a7f378ce580be21)
to
[`7e5e0f2e1ce2e252c5bd173122d069a139edbd51`](https://github.com/randymarsh77/static-nix-cache/tree/7e5e0f2e1ce2e252c5bd173122d069a139edbd51)
to provide this API. The previous target contained only `save`, `restore`, and
`deploy` actions, not `setup`.
At that revision, save requires explicit `paths`, and deploy requires `paths`
or `paths-file`. Deferred deployment requires a separate restore step with its
`paths-file` and `export-dir` outputs passed to deploy. Restore aggregates saved
artifacts; it is not a replacement for setup. The old actions use `opencache-*`
artifact names, while the supported API uses `static-nix-cache-*`. Existing
workflows written for that older explicit-path API must migrate when using the
updated `v1`, or pin the previous commit to retain the old behavior.

Install Nix in every job that runs save or deploy, including a separate
deployment job. Deploy also requires Node.js and npm on `PATH` (the repository
CI uses Node.js 22). GitHub-hosted Ubuntu runners provide Node.js and npm;
self-hosted runners must provision them.

## Standalone (Single Build)

Use **setup** before your build and **deploy** after. New store paths are auto-detected. Add the GitHub Pages deploy steps to publish the generated static cache site:

```yaml
jobs:
  build:
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

## Matrix Builds (deploy per-job)

Each matrix job runs **setup** + **deploy** independently — store paths and narinfo are pushed directly to the backend from every job. During static site generation, narinfo from all previous deploys (including other matrix jobs) is fetched from the release, so the generated site is always a complete manifest:

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

      - uses: randymarsh77/static-nix-cache/setup@v1

      - name: Build
        run: nix build

      - uses: randymarsh77/static-nix-cache/deploy@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Matrix Builds (deferred deploy)

For workflows that aggregate other static content or prefer a single deploy step, use **save** in each matrix job to export new store paths as workflow artifacts, then **deploy** in a final job. Deploy automatically restores saved artifacts — no explicit restore step needed:

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

      - uses: randymarsh77/static-nix-cache/setup@v1

      - name: Build
        run: nix build

      - uses: randymarsh77/static-nix-cache/save@v1
        with:
          name: ${{ matrix.os }}

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.pages.outputs.page_url }}
    steps:
      - uses: DeterminateSystems/nix-installer-action@main

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

## With magic-nix-cache

If you use [DeterminateSystems/magic-nix-cache-action](https://github.com/DeterminateSystems/magic-nix-cache-action), the deploy action auto-detects the running daemon and discovers built paths — no extra configuration needed:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: DeterminateSystems/nix-installer-action@main
      - uses: DeterminateSystems/magic-nix-cache-action@main

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
```

## Matrix with magic-nix-cache (deferred deploy)

For matrix builds using magic-nix-cache, use **save** in each job. The save action detects new paths using the daemon's startup timestamp. Deploy in a final job auto-restores the artifacts:

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
      - uses: DeterminateSystems/magic-nix-cache-action@main

      - name: Build
        run: nix build

      - uses: randymarsh77/static-nix-cache/save@v1
        with:
          name: ${{ matrix.os }}

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.pages.outputs.page_url }}
    steps:
      - uses: DeterminateSystems/nix-installer-action@main

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

Exports new Nix store paths (including closures) as a workflow artifact. Auto-detects new paths via the setup snapshot or magic-nix-cache's daemon timestamp.

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | no | `default` | Unique artifact name suffix (e.g. `linux-x86_64`) |
| `signing-key` | no | | Nix signing key for signing exported binaries |
| `snapshot-path` | no | `/tmp/static-nix-cache-setup/store-paths-before.txt` | Path to the store snapshot (from `setup`) |
| `store-dir` | no | `/nix/store` | Path to the Nix store directory |

### `deploy`

Pushes store paths to the configured backend and optionally generates a static site. Auto-detects paths via setup snapshot, saved artifacts (auto-restored), or a running magic-nix-cache daemon.

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `paths-file` | no | | File listing store paths (for advanced use) |
| `export-dir` | no | | Binary cache export dir. When set, NARs are read from this directory instead of the local nix store. |
| `snapshot-path` | no | `/tmp/static-nix-cache-setup/store-paths-before.txt` | Store snapshot from `setup` (for auto-detection) |
| `store-dir` | no | `/nix/store` | Path to the Nix store directory |
| `artifact-pattern` | no | `static-nix-cache-*` | Artifact name pattern for auto-restore |
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

Deploy auto-detects store paths in this priority order:
1. Explicit `paths-file` input
2. Saved artifacts (auto-restored from `static-nix-cache-*` pattern)
3. Setup snapshot (diffing current store against snapshot)
4. magic-nix-cache daemon at default address (`127.0.0.1:37515`)

## Large caches and GitHub Pages

On the next version containing these changes, the GitHub Releases backend rolls
uploads over at 900 assets per release. It uses the configured base tag first,
then `nix-cache-000001`, `nix-cache-000002`, etc. Both NARs and narinfo count toward
this threshold; a NAR and its metadata may be in different shards. Metadata has
an absolute download URL, so GitHub Pages needs no redirect support. The static
export reconstructs the combined index from every cache release, including
previous jobs and architectures. Existing base-tag releases are discovered too.

Use **one writer at a time per repository and tag prefix**. Set the same workflow
`concurrency.group` in every publishing workflow, `cancel-in-progress: false`,
and `strategy.max-parallel: 1` for matrix jobs that upload directly. Readers can
run in parallel. Keep PR jobs read-only; pass a signing secret and `contents:
write` only to trusted default-branch builds. Deploy the combined Pages site once
after all matrix uploads. Use `pages: write` and `id-token: write` for that job.

For direct publishing, run `setup` before the build and `deploy` afterward with:

```yaml
with:
  github-token: ${{ github.token }}
  signing-key: ${{ secrets.NIX_CACHE_SIGNING_KEY }}
  compression: xz
  upstream-caches: https://cache.nixos.org
```

The upstream option is opt-in. The server answers recursive Nix presence checks
from those trusted caches, so dependencies already available upstream are not
mirrored. Keep those upstream URLs in clients' substituters as well. Network and
API failures abort publication rather than exporting an incomplete cache index.

Direct uploads avoid staging large NAR closures in Actions artifacts. `save`
remains available when staging is appropriate, but Actions storage quotas and
billing apply independently of Release assets. When running `generate-static.js`
in a separate Pages job, set `STORAGE_BACKEND=github-releases`, `GITHUB_TOKEN`,
`GITHUB_OWNER`, `GITHUB_REPO`, and the same `GITHUB_RELEASE_TAG`.

GitHub limits each release to 1,000 assets and each asset to **less than 2 GiB**.
The deploy action now defaults to xz compression; oversized compressed files
fail with an actionable error. NAR uploads spool to temporary disk, so runners
need free disk space for active uploads, but not equivalent RAM. API requests
are indexed per process and paced (4 seconds between API calls; 7.5 seconds
between writes), with bounded retries for throttling and server errors. Initial
bulk imports can take hours. Release storage has no documented aggregate size
limit; the generated Pages site still has its own 1 GB limit and bandwidth quota.

Cache assets are immutable. Signing-key rotation requires a new tag prefix and
fresh local metadata directory so paths can be signed with the new key. Keep the
old public key trusted until all consumers have moved. Pruning only removes
orphaned NARs after loading all metadata; it is not a historical cache eviction
policy. Do not delete published cache releases manually while clients use them.

Limits: [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases),
[GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).
