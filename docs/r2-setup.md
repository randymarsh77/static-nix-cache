---
sidebar_position: 2.6
---

# Provision a private R2 cache

A GitHub Releases cache can't be read when the repository is private: release
downloads need authentication that Nix can't send. For a private repository, keep
the cache in a private Cloudflare R2 bucket instead
([the `r2` backend](storage-backends.md#cloudflare-r2-private)). Run this once
to provision it:

```bash
CLOUDFLARE_API_TOKEN=... \
nix run github:randymarsh77/static-nix-cache#setup-r2 -- \
  --repo OWNER/REPO --account-id ACCOUNT_ID
```

The command does four things:

- Creates the bucket, named `<repo>-nix-cache` unless you pass `--bucket`.
- Creates two tokens that can only reach that bucket:
  - **CI** (read and write), stored as the repository secrets
    `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`.
  - **Reader** (read only), for the machines that use the cache.
- Sets the repository variables `R2_ACCOUNT_ID` and `R2_BUCKET`, plus
  `R2_ENDPOINT` for a bucket in a jurisdiction.
- Sets up the same signing secret and public-key variable as
  [`setup-github`](repository-setup.md). If the repository already has them,
  they are reused.

From a source checkout, `node scripts/setup-r2-cache.js` is the same command.

## Cloudflare token

The command needs a Cloudflare API token to create the bucket and the two
tokens. Create it once in the dashboard (**Manage Account > Account API Tokens**)
with these permissions:

- **Account > Account API Tokens > Edit**
- **Account > Workers R2 Storage > Edit**

Pass it in `CLOUDFLARE_API_TOKEN`, or keep it in 1Password and pass a reference
with `--api-token-ref op://Vault/Item/credential`. The command uses this token
only while it runs and never stores it.

## 1Password

With `--op-vault VAULT` (this needs the [1Password CLI](https://developer.1password.com/docs/cli/),
`op`, signed in), the command saves the following to that vault:

- **`static-nix-cache OWNER/REPO R2 reader`**: an API Credential item. Its
  `username` and `credential` fields are the access key ID and secret. It also
  holds the endpoint, bucket and profile.
- **`static-nix-cache OWNER/REPO signing key`**: the private signing key and its
  public key, when the command created or imported the key.

Without `--op-vault`, the reader credentials go to an owner-only file,
`~/.local/share/static-nix-cache/OWNER/REPO.r2-reader`, in AWS credentials
format. The signing key is backed up next to it either way, as
[`setup-github`](repository-setup.md#key-backups-recovery-and-reruns) does.

## Connect your workflow

```yaml
- uses: randymarsh77/static-nix-cache/deploy@v1
  with:
    backend: r2
    r2-account-id: ${{ vars.R2_ACCOUNT_ID }}
    r2-bucket: ${{ vars.R2_BUCKET }}
    r2-access-key-id: ${{ secrets.R2_ACCESS_KEY_ID }}
    r2-secret-access-key: ${{ secrets.R2_SECRET_ACCESS_KEY }}
    signing-key: ${{ secrets.NIX_CACHE_SIGNING_KEY }}
```

For a bucket in a jurisdiction, also pass `r2-endpoint: ${{ vars.R2_ENDPOINT }}`.

## Connect your machines

The command prints the substituter and public key:

```nix
nix.settings = {
  extra-substituters = [
    "s3://<bucket>?endpoint=<account-id>.r2.cloudflarestorage.com&region=auto&profile=nix-cache"
  ];
  extra-trusted-public-keys = [ "<public key>" ];
};
```

The Nix daemon reads the bucket using the reader credentials. Put them in
root's AWS credentials file, under the profile named in the URL, with mode `0600`:

- `/var/root/.aws/credentials` on macOS
- `/root/.aws/credentials` on Linux

```ini
[nix-cache]
aws_access_key_id = <reader access key id>
aws_secret_access_key = <reader secret>
```

## Reruns and rotation

Running the command again changes nothing: it reuses the bucket, the tokens and
the signing key. Tokens are matched by name (`static-nix-cache OWNER/REPO ci`
and `... reader`). Neither Cloudflare nor GitHub can return a token's secret, so
the command refuses to continue when a token exists without its stored
credentials, or the other way round. Pass a flag to replace that token:

- `--replace-ci-token` deletes the CI token, creates a new one and updates the
  repository secrets.
- `--replace-reader-token` deletes the reader token, creates a new one, and
  replaces the reader file or archives and recreates the 1Password item. Update
  root's credentials file on each machine afterward.

The same flags rotate a token on purpose. If a token's credentials can't be
stored, the command deletes the new token again, so a failed run leaves no
unused token behind.

The command also refuses to continue when `R2_ACCOUNT_ID`, `R2_BUCKET` or
`R2_ENDPOINT` already name a different cache. Pass the values the repository was
provisioned with, or delete those variables to provision a new cache.
