---
sidebar_position: 2.5
---

# Provision a GitHub cache

Run this once as an authenticated repository administrator to configure the
GitHub Releases / Pages backend for your project:

```bash
nix run github:randymarsh77/static-nix-cache#setup-github -- --repo OWNER/REPO
```

The command provisions an Actions-backed Pages site, the `github-pages`
deployment environment and default-branch policy, a
[Nix signing key](configuration.md#signing-keys), a repository
secret named `NIX_CACHE_SIGNING_KEY`, and a repository variable named
`NIX_CACHE_PUBLIC_KEY`. It prints the cache URL and public-key settings for Nix
consumers. Provisioning settings requires the administrator's credentials;
the publishing workflow uses its normal `GITHUB_TOKEN` afterward.

`setup-github` is available from the revision introducing this command. Pin a
commit containing it when using an immutable flake reference. Its dependencies
come from the flake's locked stable `nixos-26.05` input. From a source checkout,
`./scripts/setup_github_cache.py` provides the same command with a Nix shebang
that supplies Python, GitHub CLI, and Git from the stable `nixos-26.05` branch.

## Authentication and destination

Only Nix needs to be installed. If GitHub CLI is not already authenticated:

```bash
nix run github:NixOS/nixpkgs/nixos-26.05#gh -- auth login
```

The authenticated user must administer the destination repository. Classic
tokens need `repo` scope. Fine-grained tokens need administration, environments,
Pages, secrets, and variables write permissions; dispatching a workflow also
requires Actions write permission. Organization policies may require owner
authorization. Required deployment approvals remain enforced.

Use `--repo OWNER/REPO` to select the destination explicitly. When omitted, the
command reads the current checkout's `origin` remote. This is important in forks
where GitHub CLI's default repository can point upstream.

## Connect your workflow

Use the [Quick Start workflow](getting-started.md#quick-start), which connects
the provisioned `NIX_CACHE_SIGNING_KEY` secret to the deploy action. Keep your
build command, publishing triggers, and static-site content in that workflow.
For deployment permissions and concurrency, follow the
[publishing guidance](github-actions.md#large-caches-and-github-pages).

Configure consumers using [Use the Cache](getting-started.md#use-the-cache),
substituting the URL and public key printed by setup. The public key is also
available as `vars.NIX_CACHE_PUBLIC_KEY` for your site's usage instructions.
Set `--cache-path cache` when your workflow publishes metadata under `/cache`
instead of the Pages root.

To validate and dispatch an existing workflow after provisioning:

```bash
nix run github:randymarsh77/static-nix-cache#setup-github -- \
  --repo OWNER/REPO \
  --workflow cache.yml --dispatch
```

The workflow must already be active on the default branch and support
`workflow_dispatch`. Pass project-specific inputs with repeated
`--input NAME=VALUE` arguments. Values are passed literally, including those
starting with `@`. Without `--dispatch`, setup provisions configuration only.

## Existing Pages sites and release tags

An existing Pages site requires `--use-existing-pages`: this acknowledges that
the publishing workflow will use that site and its content. Existing sites using
branch-based publishing are switched to GitHub Actions publishing.

The default setup allows the default branch. For release-triggered deployments,
add tag patterns appropriate to your project:

```bash
nix run github:randymarsh77/static-nix-cache#setup-github -- \
  --repo OWNER/REPO --tag-pattern 'v*'
```

Patterns follow GitHub deployment-policy matching; `*` does not match `/`.
Repeat `--tag-pattern` for additional tag layouts. An existing environment
restricted to protected branches needs `--allow-release-tags` to authorize
conversion to explicit branch/tag policies. Currently protected branches,
required reviewers, self-review restrictions, and wait timers are retained.
Unrecognized protection rules cause setup to stop before making changes.
Existing custom policies are extended, and unrestricted environments stay
unrestricted.

Before converting a protected-branch policy, setup saves the branch and tag
patterns in `$XDG_DATA_HOME/static-nix-cache/OWNER/REPO/ENVIRONMENT.migration.json`
(defaulting to `~/.local/share`). It URL-encodes the environment name in the
filename. If conversion stops partway through, rerun setup on the same machine
with the same data directory to restore the missing policies. Setup removes the
journal after it installs every policy. Keep the journal until recovery completes.

Use `--environment`, `--secret-name`, and `--public-key-variable` if your
workflow uses different names; keep those workflow references in sync.

## Key backups, recovery, and reruns

New private keys are backed up with mode `0600` at
`$XDG_DATA_HOME/static-nix-cache/OWNER/REPO.key`, defaulting to
`~/.local/share/static-nix-cache/OWNER/REPO.key`. Keep the backup secure and
outside your Git checkout. `--key-file PATH` selects a backup location or imports
an existing Nix private key. Existing key files must be regular, owner-only files.

Reruns preserve existing keys and resume partially completed setup. If a secret
and public-key variable are already configured, they are reused even when the
local backup is unavailable. GitHub cannot return an uploaded secret. If only
one half of the configuration exists, provide the matching backup using
`--key-file`. A mismatched public key is rejected rather than silently rotating
the cache's identity. See [key rotation](github-actions.md#large-caches-and-github-pages)
for migration requirements.

Run `nix run github:randymarsh77/static-nix-cache#setup-github -- --help` for all
options and permissions. After dispatch, monitor the workflow link printed by
the command for build and deployment results.
