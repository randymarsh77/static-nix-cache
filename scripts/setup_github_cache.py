#!/usr/bin/env nix
#! nix --extra-experimental-features nix-command --extra-experimental-features flakes shell github:NixOS/nixpkgs/nixos-26.05#python3 github:NixOS/nixpkgs/nixos-26.05#gh github:NixOS/nixpkgs/nixos-26.05#git --command python3
"""Provision a signed GitHub Releases / Pages cache for any repository.

    ./scripts/setup_github_cache.py --repo OWNER/REPO
    nix run .#setup-github -- --repo OWNER/REPO

Requires Nix and an authenticated repository administrator. The Nix shebang
supplies Python, GitHub CLI, and Git from the stable nixos-26.05 branch. Log in
with: nix run github:NixOS/nixpkgs/nixos-26.05#gh -- auth login
Classic tokens need repo scope. Fine-grained tokens need administration,
environments, Pages, secrets, and variables write permissions, plus Actions
write for --dispatch. Organization authorization may also be required.

Creates an Actions-backed Pages site, a deployment environment, a signing-key
secret, and a public-key variable. The destination defaults to the checkout's
origin remote, never gh's potentially different upstream default repository.
The workflow remains project-specific: connect secrets.NIX_CACHE_SIGNING_KEY
to deploy's signing-key input and vars.NIX_CACHE_PUBLIC_KEY to consumers.
Use --workflow FILE to validate an existing default-branch workflow. Add
--dispatch and optional --input NAME=VALUE arguments to start that workflow.

New private keys are backed up with mode 0600 outside the checkout at
$XDG_DATA_HOME/static-nix-cache/OWNER/REPO.key (default ~/.local/share).
--key-file imports a private key or selects its backup location. Existing keys
are reused, never silently rotated. GitHub cannot return stored secrets;
interrupted key setup requires the matching backup to resume.

An existing Pages site requires --use-existing-pages to acknowledge ownership
of its content. Existing custom deployment policies and approval requirements
are retained. --tag-pattern PATTERN adds release-tag access (repeatable).
Protected-branch-only environments require --allow-release-tags to switch to
custom policies; currently protected branches remain allowed explicitly.
Organization restrictions and required deployment approvals remain enforced.
"""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
from urllib.parse import quote


class SetupError(Exception):
    pass


def command(args, data=None):
    result = subprocess.run(args, input=data, text=True, capture_output=True)
    if result.returncode:
        # Never echo stdin: it may contain the private signing key.
        raise SetupError(f"{args[0]} {args[1]} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def api(path, method="GET", body=None, optional=False):
    args = ["gh", "api", path, "--method", method]
    if body is not None:
        args += ["--input", "-"]
    result = subprocess.run(
        args,
        input=json.dumps(body) if body is not None else None,
        text=True,
        capture_output=True,
    )
    if result.returncode:
        if optional and "(HTTP 404)" in result.stderr:
            return None
        raise SetupError(f"GitHub {method} {path}: {result.stderr.strip()}")
    return json.loads(result.stdout) if result.stdout.strip() else None


def paginated(path, field=None):
    items = []
    page = 1
    while True:
        data = api(f"{path}?per_page=100&page={page}")
        batch = data[field] if field else data
        items.extend(batch)
        if len(batch) < 100:
            return items
        page += 1


def public_key(secret):
    return command(
        [
            "nix",
            "--extra-experimental-features",
            "nix-command",
            "key",
            "convert-secret-to-public",
        ],
        secret,
    )


def prepare_key(repo, key_file, stored_public, has_secret):
    if has_secret and stored_public and not key_file.exists():
        print("Reusing the repository's existing signing key.")
        return None, stored_public
    if key_file.exists():
        mode = key_file.stat().st_mode
        if key_file.is_symlink() or not stat.S_ISREG(mode) or mode & 0o077:
            raise SetupError(
                f"Private key must be a regular, owner-only file: {key_file}"
            )
        secret = key_file.read_text().strip()
    elif has_secret or stored_public:
        raise SetupError(
            "Incomplete signing configuration. Supply the matching private-key "
            "backup using --key-file; existing keys will not be replaced."
        )
    else:
        secret = command(
            [
                "nix",
                "--extra-experimental-features",
                "nix-command",
                "key",
                "generate-secret",
                "--key-name",
                repo.replace("/", "-") + "-cache-1",
            ]
        )
        key_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with open(
            key_file, "x", opener=lambda path, flags: os.open(path, flags, 0o600)
        ) as file:
            file.write(secret + "\n")
        print(f"Private signing-key backup: {key_file} (keep this secure).")
    public = public_key(secret)
    if stored_public and public != stored_public:
        raise SetupError(
            "Backup key does not match the public-key variable; refusing rotation."
        )
    return secret, public


def environment_body(environment):
    """Preserve review and timer requirements when changing the branch policy."""
    body = {
        "deployment_branch_policy": {
            "protected_branches": False,
            "custom_branch_policies": True,
        }
    }
    for rule in (environment or {}).get("protection_rules", []):
        if rule["type"] == "wait_timer":
            body["wait_timer"] = rule["wait_timer"]
        elif rule["type"] == "required_reviewers":
            body["prevent_self_review"] = rule.get("prevent_self_review", False)
            body["reviewers"] = [
                {"type": item["type"], "id": item["reviewer"]["id"]}
                for item in rule["reviewers"]
            ]
        elif rule["type"] != "branch_policy":
            raise SetupError(
                "Unrecognized environment protection rule; refusing to alter it."
            )
    return body


def save_migration(path, desired):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", dir=path.parent, delete=False
        ) as file:
            temporary = Path(file.name)
            json.dump(desired, file)
            file.flush()
            os.fsync(file.fileno())
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def setup(args):
    for tool in ("gh", "nix"):
        if not shutil.which(tool):
            raise SetupError(f"Required executable not found: {tool}")
    repo = args.repo
    if not repo:
        remote = command(["git", "remote", "get-url", "origin"])
        match = re.fullmatch(
            r"(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)"
            r"([^/]+/[^/]+?)(?:\.git)?",
            remote,
        )
        if not match:
            raise SetupError(
                "Cannot determine a GitHub repository from origin; use --repo OWNER/REPO."
            )
        repo = match[1]
    if not re.fullmatch(
        r"[A-Za-z0-9_-][A-Za-z0-9_.-]*/[A-Za-z0-9_.-]+", repo
    ) or repo.split("/", 1)[1] in (".", ".."):
        raise SetupError("Repository must have the form OWNER/REPO.")
    root = f"repos/{repo}"
    metadata = api(root)
    if not metadata.get("permissions", {}).get("admin"):
        raise SetupError(f"Repository administrator access is required for {repo}.")
    branch = metadata["default_branch"]
    if args.workflow:
        workflow = api(f"{root}/actions/workflows/{quote(args.workflow, safe='')}")
        if workflow["state"] != "active":
            raise SetupError(
                "The selected workflow must be active on the default branch."
            )
        api(f"{root}/contents/{workflow['path']}?ref={quote(branch, safe='')}")
    pages = api(f"{root}/pages", optional=True)
    if pages and not args.use_existing_pages:
        raise SetupError(
            "This repository already has Pages. Use --use-existing-pages to authorize using the site."
        )
    environment_path = f"{root}/environments/{quote(args.environment, safe='')}"
    data_home = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share"))
    migration_path = (
        data_home / "static-nix-cache" / repo
        / (quote(args.environment, safe="") + ".migration.json")
    )
    migration = None
    if migration_path.exists():
        try:
            migration = json.loads(migration_path.read_text())
        except (ValueError, OSError) as error:
            raise SetupError(f"Cannot read migration journal: {migration_path}") from error
        if not isinstance(migration, list) or not all(
            isinstance(item, list) and len(item) == 2
            and isinstance(item[0], str) and item[1] in ("branch", "tag")
            for item in migration
        ):
            raise SetupError(f"Invalid migration journal: {migration_path}")
    environment = api(environment_path, optional=True)
    policy = environment.get("deployment_branch_policy") if environment else None
    protected = bool(policy and policy["protected_branches"])
    change_policy = protected and bool(args.tag_pattern or migration is not None)
    if change_policy and not args.allow_release_tags:
        raise SetupError(
            "The environment permits protected branches only. Use --allow-release-tags to authorize tag deployments."
        )
    body = environment_body(environment) if change_policy else None
    protected_branches = paginated(f"{root}/branches") if change_policy else []
    protected_branches = [
        item["name"] for item in protected_branches if item["protected"]
    ]
    if change_policy and migration is None:
        migration = [(name, "branch") for name in protected_branches]
        migration += [(name, "tag") for name in args.tag_pattern]
    if protected and not change_policy:
        branches = paginated(f"{root}/branches")
        if any(item["protected"] for item in branches) and not any(
            item["name"] == branch and item["protected"] for item in branches
        ):
            raise SetupError(
                "The environment permits protected branches, but the default branch is not protected."
            )
    policies = (
        paginated(f"{environment_path}/deployment-branch-policies", "branch_policies")
        if policy and policy["custom_branch_policies"]
        else []
    )
    variable_path = f"{root}/actions/variables/{args.public_key_variable}"
    stored = api(variable_path, optional=True)
    secrets = paginated(f"{root}/actions/secrets", "secrets")
    has_secret = any(
        item["name"].upper() == args.secret_name.upper() for item in secrets
    )
    backup = args.key_file or (
        Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share"))
        / "static-nix-cache"
        / (repo + ".key")
    )
    secret, public = prepare_key(
        repo, backup.expanduser(), stored["value"] if stored else None, has_secret
    )
    print(f"Configuring cache for {repo} (default branch: {branch}).")
    if secret and (not has_secret or not stored):
        command(["gh", "secret", "set", args.secret_name, "--repo", repo], secret)
    if not stored:
        api(
            f"{root}/actions/variables",
            "POST",
            {"name": args.public_key_variable, "value": public},
        )
    if not pages:
        pages = api(f"{root}/pages", "POST", {"build_type": "workflow"})
    elif pages["build_type"] != "workflow":
        # The update endpoint returns 204, unlike site creation (201 + JSON).
        api(f"{root}/pages", "PUT", {"build_type": "workflow"})
        pages = api(f"{root}/pages")
    # Pages can create the environment and default-branch policy itself.
    # Refresh to avoid duplicate policies and preserve API-created protections.
    if not environment:
        environment = api(environment_path, optional=True)
        policy = environment.get("deployment_branch_policy") if environment else None
        if policy and policy["protected_branches"]:
            raise SetupError(
                "Environment changed during setup; rerun to inspect its policy."
            )
        if policy and policy["custom_branch_policies"]:
            policies = paginated(
                f"{environment_path}/deployment-branch-policies", "branch_policies"
            )
    if not environment or change_policy:
        if change_policy:
            save_migration(migration_path, migration)
        api(environment_path, "PUT", body or environment_body(None))
    if (
        not environment
        or change_policy
        or (policy and policy["custom_branch_policies"])
    ):
        desired = (
            [tuple(item) for item in migration]
            if migration is not None else [(branch, "branch")]
        )
        desired += [(name, "tag") for name in args.tag_pattern]
        for name, kind in dict.fromkeys(desired):
            if not any(
                item["name"] == name and item["type"] == kind for item in policies
            ):
                api(
                    f"{environment_path}/deployment-branch-policies",
                    "POST",
                    {"name": name, "type": kind},
                )
        if migration is not None:
            migration_path.unlink(missing_ok=True)
    url = pages["html_url"].rstrip("/")
    if args.cache_path:
        url += "/" + args.cache_path.strip("/")
    print(f"Pages: {pages['html_url']}")
    print(f"Public signing key: {public}")
    print(f"extra-substituters = {url}")
    print(f"extra-trusted-public-keys = {public}")
    if args.dispatch:
        invocation = [
            "gh",
            "workflow",
            "run",
            args.workflow,
            "--repo",
            repo,
            "--ref",
            branch,
        ]
        for value in args.input:
            invocation += ["--raw-field", value]
        command(invocation)
        print(
            f"Started workflow: https://github.com/{repo}/actions/workflows/{quote(args.workflow, safe='')}"
        )
    else:
        print(
            "Setup complete. The project's publishing workflow can now use this configuration."
        )


def parser():
    result = argparse.ArgumentParser(
        prog="static-nix-cache-setup-github",
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    result.add_argument(
        "--repo", help="Destination OWNER/REPO (default: checkout's origin remote)"
    )
    result.add_argument(
        "--key-file",
        type=Path,
        help="Private-key backup to create or import (mode 0600)",
    )
    result.add_argument(
        "--environment",
        default="github-pages",
        help="Deployment environment (default: github-pages)",
    )
    result.add_argument(
        "--secret-name",
        default="NIX_CACHE_SIGNING_KEY",
        help="Repository signing-secret name",
    )
    result.add_argument(
        "--public-key-variable",
        default="NIX_CACHE_PUBLIC_KEY",
        help="Repository public-key variable name",
    )
    result.add_argument(
        "--cache-path",
        default="",
        help="Cache subdirectory on Pages (for example cache)",
    )
    result.add_argument(
        "--use-existing-pages",
        action="store_true",
        help="Authorize using the existing Pages site for the cache",
    )
    result.add_argument(
        "--tag-pattern",
        action="append",
        default=[],
        help="Allow a release-tag pattern (repeatable; for example v*)",
    )
    result.add_argument(
        "--allow-release-tags",
        action="store_true",
        help="Authorize converting protected-branch-only policy to branch/tag patterns",
    )
    result.add_argument(
        "--workflow",
        help="Existing workflow filename to validate (for example cache.yml)",
    )
    result.add_argument(
        "--dispatch", action="store_true", help="Dispatch --workflow after provisioning"
    )
    result.add_argument(
        "--input",
        action="append",
        default=[],
        metavar="NAME=VALUE",
        help="Raw workflow input for --dispatch (repeatable)",
    )
    return result


def main():
    arguments = parser()
    args = arguments.parse_args()
    if args.dispatch and not args.workflow:
        arguments.error("--dispatch requires --workflow")
    if args.input and not args.dispatch:
        arguments.error("--input requires --dispatch")
    for value in args.input:
        if "=" not in value or not value.split("=", 1)[0]:
            arguments.error("--input must have the form NAME=VALUE")
    for name in (args.secret_name, args.public_key_variable):
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name) or name.upper().startswith(
            "GITHUB_"
        ):
            arguments.error(
                "Secret/variable names must be identifiers without the GITHUB_ prefix"
            )
    if not args.environment:
        arguments.error("--environment must not be empty")
    try:
        setup(args)
    except (SetupError, OSError) as error:
        arguments.exit(1, f"Setup failed: {error}\n")


if __name__ == "__main__":
    main()
