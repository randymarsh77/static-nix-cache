"""Run with python3 -m unittest discover -s tests -p 'test_*.py'."""

import contextlib
import importlib.util
import io
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "setup_github_cache",
    Path(__file__).resolve().parents[1] / "scripts/setup_github_cache.py",
)
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)
REAL_API = setup.api


class FakeGitHub:
    def __init__(self):
        self.pages = None
        self.environment = None
        self.public = None
        self.secret_names = set()
        self.admin = True
        self.auto_environment = False
        self.workflow_state = "active"
        self.policies = []
        self.writes = []
        self.reads = []
        self.commands = []
        self.branches = [
            {"name": "main", "protected": True},
            {"name": "topic", "protected": False},
        ]

    def command(self, args, data=None):
        self.commands.append(args)
        if args[:3] == ["git", "remote", "get-url"]:
            return "git@github.com:example-owner/example-project.git"
        if "generate-secret" in args:
            return "test-secret"
        if "convert-secret-to-public" in args:
            return "test-public"
        if args[:3] == ["gh", "secret", "set"]:
            self.secret_names.add(args[3])
        return ""

    def api(self, path, method="GET", body=None, optional=False):
        path, _, _ = path.partition("?")
        prefix = "repos/example-owner/example-project"
        if not path.startswith(prefix):
            raise AssertionError(f"Unexpected destination: {path}")
        route = path[len(prefix) :]
        if method != "GET":
            self.writes.append((route, method, body))
            if route == "/actions/variables":
                self.public = body["value"]
            elif route == "/pages":
                self.pages = {
                    "html_url": "https://example-owner.github.io/example-project/",
                    **body,
                }
                if self.auto_environment:
                    self.environment = {
                        "deployment_branch_policy": {
                            "protected_branches": False,
                            "custom_branch_policies": True,
                        },
                        "protection_rules": [],
                    }
                    self.policies.append({"name": "main", "type": "branch"})
            elif route.endswith("/deployment-branch-policies"):
                self.policies.append(body)
            elif route.startswith("/environments/"):
                self.environment = {"protection_rules": [], **body}
            else:
                raise AssertionError(f"Unexpected write: {path}")
            if route == "/pages":
                return self.pages if method == "POST" else None
            return body
        self.reads.append(route)
        if not route:
            return {"permissions": {"admin": self.admin}, "default_branch": "main"}
        if route.startswith("/actions/workflows/"):
            return {
                "state": self.workflow_state,
                "path": ".github/workflows/publish.yml",
            }
        if route.startswith("/contents/"):
            return {}
        if route == "/pages":
            return self.pages
        if route.endswith("/deployment-branch-policies"):
            return {"branch_policies": self.policies}
        if route.startswith("/environments/"):
            return self.environment
        if route.startswith("/actions/variables/"):
            return {"value": self.public} if self.public else None
        if route == "/actions/secrets":
            return {"secrets": [{"name": name} for name in self.secret_names]}
        if route == "/branches":
            return self.branches
        raise AssertionError(f"Unexpected read: {path}")


class SetupTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.key = Path(temp.name) / "backup.key"
        self.data_home = Path(temp.name) / "data"
        environment = patch.dict(setup.os.environ, {"XDG_DATA_HOME": str(self.data_home)})
        environment.start()
        self.addCleanup(environment.stop)
        self.github = FakeGitHub()
        self.args = setup.parser().parse_args(["--key-file", str(self.key)])
        for target, replacement in (
            ("api", self.github.api),
            ("command", self.github.command),
            ("shutil.which", lambda name: name),
        ):
            patcher = (
                patch.object(setup, target, replacement)
                if "." not in target
                else patch.object(setup.shutil, "which", replacement)
            )
            patcher.start()
            self.addCleanup(patcher.stop)
        self.output = io.StringIO()
        redirect = contextlib.redirect_stdout(self.output)
        redirect.__enter__()
        self.addCleanup(redirect.__exit__, None, None, None)

    def test_fresh_setup_uses_origin_and_backs_up_key(self):
        setup.setup(self.args)
        self.assertEqual(self.key.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.key.read_text(), "test-secret\n")
        self.assertIn("NIX_CACHE_SIGNING_KEY", self.github.secret_names)
        self.assertEqual(self.github.public, "test-public")
        self.assertEqual(self.github.pages["build_type"], "workflow")
        self.assertIn({"name": "main", "type": "branch"}, self.github.policies)
        self.assertNotIn("test-secret", self.output.getvalue())
        self.assertFalse(any("workflow" in args for args in self.github.commands))
        self.assertFalse(any("workflows" in route for route in self.github.reads))

    def test_rerun_preserves_keys_and_policies(self):
        setup.setup(self.args)
        self.github.commands.clear()
        self.github.writes.clear()
        self.args.use_existing_pages = True
        setup.setup(self.args)
        self.assertFalse(self.github.writes)
        self.assertFalse(
            any("generate-secret" in args for args in self.github.commands)
        )
        self.assertFalse(any("secret" in args for args in self.github.commands))

    def test_non_github_origin_is_rejected_before_api_calls(self):
        with patch.object(
            setup, "command", return_value="https://notgithub.com/owner/repo.git"
        ):
            with self.assertRaisesRegex(setup.SetupError, "Cannot determine"):
                setup.setup(self.args)
        self.assertFalse(self.github.reads)
        self.assertFalse(self.github.writes)

    def test_explicit_repository_does_not_consult_git_or_gh_default(self):
        self.args.repo = "example-owner/example-project"
        setup.setup(self.args)
        self.assertFalse(any(args[0] == "git" for args in self.github.commands))

    def test_pages_created_environment_is_preserved(self):
        self.github.auto_environment = True
        setup.setup(self.args)
        self.assertEqual(
            self.github.policies.count({"name": "main", "type": "branch"}), 1
        )
        self.assertFalse(
            any(
                path == "/environments/github-pages"
                for path, _, _ in self.github.writes
            )
        )

    def test_existing_keys_without_backup_are_reused(self):
        self.github.secret_names.add("NIX_CACHE_SIGNING_KEY")
        self.github.public = "test-public"
        setup.setup(self.args)
        self.assertFalse(self.key.exists())
        self.assertFalse(any(args[0] == "nix" for args in self.github.commands))

    def test_partial_keys_require_backup(self):
        self.github.secret_names.add("NIX_CACHE_SIGNING_KEY")
        with self.assertRaisesRegex(setup.SetupError, "Incomplete signing"):
            setup.setup(self.args)
        self.assertFalse(self.github.writes)

    def test_mixed_case_secret_name_reuses_existing_credentials(self):
        self.args.secret_name = "Project_Signing_Key"
        self.github.secret_names.add("PROJECT_SIGNING_KEY")
        self.github.public = "test-public"
        setup.setup(self.args)
        self.assertFalse(self.key.exists())
        self.assertFalse(any(args[0] == "nix" for args in self.github.commands))
        self.assertFalse(any("secret" in args for args in self.github.commands))

    def test_lowercase_partial_secret_requires_backup(self):
        self.args.secret_name = "project_signing_key"
        self.github.secret_names.add("PROJECT_SIGNING_KEY")
        with self.assertRaisesRegex(setup.SetupError, "Incomplete signing"):
            setup.setup(self.args)
        self.assertFalse(self.key.exists())
        self.assertFalse(self.github.writes)

    def test_partial_key_configuration_is_recovered_from_backup(self):
        self.key.write_text("test-secret\n")
        self.key.chmod(0o600)
        self.github.secret_names.add("NIX_CACHE_SIGNING_KEY")
        setup.setup(self.args)
        self.assertEqual(self.github.public, "test-public")
        self.assertFalse(
            any("generate-secret" in args for args in self.github.commands)
        )

    def test_mismatched_backup_fails_before_writes(self):
        self.key.write_text("test-secret\n")
        self.key.chmod(0o600)
        self.github.public = "different-public-key"
        with self.assertRaisesRegex(setup.SetupError, "refusing rotation"):
            setup.setup(self.args)
        self.assertFalse(self.github.writes)

    def test_insecure_key_file_is_rejected(self):
        self.key.write_text("test-secret\n")
        self.key.chmod(0o644)
        with self.assertRaisesRegex(setup.SetupError, "owner-only"):
            setup.setup(self.args)
        self.assertFalse(self.github.writes)

    def test_admin_required_before_writes(self):
        self.github.admin = False
        with self.assertRaisesRegex(setup.SetupError, "administrator"):
            setup.setup(self.args)
        self.assertFalse(self.github.writes)

    def test_existing_pages_requires_explicit_authorization(self):
        self.github.pages = {"build_type": "legacy"}
        with self.assertRaisesRegex(setup.SetupError, "--use-existing-pages"):
            setup.setup(self.args)
        self.assertFalse(self.github.writes)

    def test_existing_legacy_pages_is_migrated_when_authorized(self):
        self.github.pages = {"build_type": "legacy"}
        self.args.use_existing_pages = True
        setup.setup(self.args)
        self.assertIn(("/pages", "PUT", {"build_type": "workflow"}), self.github.writes)

    def test_protected_environment_preserves_reviews_and_branches(self):
        self.args.allow_release_tags = True
        self.args.tag_pattern = ["v*"]
        self.github.environment = {
            "deployment_branch_policy": {
                "protected_branches": True,
                "custom_branch_policies": False,
            },
            "protection_rules": [
                {"type": "wait_timer", "wait_timer": 15},
                {
                    "type": "required_reviewers",
                    "prevent_self_review": True,
                    "reviewers": [{"type": "Team", "reviewer": {"id": 42}}],
                },
            ],
        }
        setup.setup(self.args)
        body = next(
            body
            for path, _, body in self.github.writes
            if path == "/environments/github-pages"
        )
        self.assertEqual(body["wait_timer"], 15)
        self.assertTrue(body["prevent_self_review"])
        self.assertEqual(body["reviewers"], [{"type": "Team", "id": 42}])
        self.assertIn({"name": "main", "type": "branch"}, self.github.policies)
        self.assertIn({"name": "v*", "type": "tag"}, self.github.policies)
        self.assertNotIn({"name": "topic", "type": "branch"}, self.github.policies)

    def test_protected_environment_requires_authorization_for_tags(self):
        self.args.tag_pattern = ["v*"]
        self.github.environment = {
            "deployment_branch_policy": {
                "protected_branches": True,
                "custom_branch_policies": False,
            }
        }
        with self.assertRaisesRegex(setup.SetupError, "--allow-release-tags"):
            setup.setup(self.args)
        self.assertFalse(self.github.writes)

    def test_interrupted_conversion_replays_original_policies(self):
        self.args.allow_release_tags = True
        self.args.tag_pattern = ["v*"]
        self.github.branches = [
            {"name": "main", "protected": False},
            {"name": "release/1", "protected": True},
            {"name": "release/2", "protected": True},
        ]
        self.github.environment = {
            "deployment_branch_policy": {
                "protected_branches": True,
                "custom_branch_policies": False,
            }
        }
        original_api = self.github.api

        def fail_second_policy(path, method="GET", body=None, optional=False):
            if method == "POST" and body == {"name": "release/2", "type": "branch"}:
                raise setup.SetupError("Interrupted policy creation")
            return original_api(path, method, body, optional)

        with patch.object(setup, "api", fail_second_policy):
            with self.assertRaisesRegex(setup.SetupError, "Interrupted"):
                setup.setup(self.args)
        journal = (
            self.data_home / "static-nix-cache/example-owner/example-project"
            / "github-pages.migration.json"
        )
        self.assertTrue(journal.exists())
        self.assertEqual(journal.stat().st_mode & 0o777, 0o600)
        self.github.branches = [{"name": "main", "protected": False}]
        self.args.use_existing_pages = True
        self.args.tag_pattern = []
        setup.setup(self.args)
        self.assertEqual(self.github.policies, [
            {"name": "release/1", "type": "branch"},
            {"name": "release/2", "type": "branch"},
            {"name": "v*", "type": "tag"},
        ])
        self.assertFalse(journal.exists())

    def test_invalid_migration_journal_fails_before_writes(self):
        journal = (
            self.data_home / "static-nix-cache/example-owner/example-project"
            / "github-pages.migration.json"
        )
        journal.parent.mkdir(parents=True)
        for content in ("{", '[ ["main", "invalid"] ]'):
            with self.subTest(content=content):
                journal.write_text(content)
                with self.assertRaisesRegex(setup.SetupError, "migration journal"):
                    setup.setup(self.args)
                self.assertFalse(self.github.writes)

    def test_journal_write_failure_prevents_policy_conversion(self):
        self.args.allow_release_tags = True
        self.args.tag_pattern = ["v*"]
        self.github.environment = {
            "deployment_branch_policy": {
                "protected_branches": True,
                "custom_branch_policies": False,
            }
        }
        with patch.object(setup, "save_migration", side_effect=OSError("Disk full")):
            with self.assertRaisesRegex(OSError, "Disk full"):
                setup.setup(self.args)
        self.assertTrue(self.github.environment["deployment_branch_policy"]["protected_branches"])
        self.assertFalse(any(
            path.startswith("/environments/") for path, _, _ in self.github.writes
        ))

    def test_conversion_does_not_allow_unprotected_default_branch(self):
        self.args.allow_release_tags = True
        self.args.tag_pattern = ["v*"]
        self.github.branches = [
            {"name": "main", "protected": False},
            {"name": "release/1", "protected": True},
        ]
        self.github.environment = {
            "deployment_branch_policy": {
                "protected_branches": True,
                "custom_branch_policies": False,
            }
        }
        setup.setup(self.args)
        self.assertEqual(self.github.policies, [
            {"name": "release/1", "type": "branch"},
            {"name": "v*", "type": "tag"},
        ])

    def test_protected_policy_without_protected_branches_needs_no_conversion(self):
        self.github.branches = [{"name": "main", "protected": False}]
        self.github.environment = {
            "deployment_branch_policy": {
                "protected_branches": True,
                "custom_branch_policies": False,
            }
        }
        setup.setup(self.args)
        self.assertFalse(
            any(path.startswith("/environments/") for path, _, _ in self.github.writes)
        )

    def test_protected_policy_rejects_unprotected_default_when_another_is_protected(self):
        self.github.branches = [
            {"name": "main", "protected": False},
            {"name": "release/1", "protected": True},
        ]
        self.github.environment = {
            "deployment_branch_policy": {
                "protected_branches": True,
                "custom_branch_policies": False,
            }
        }
        with self.assertRaisesRegex(setup.SetupError, "default branch is not protected"):
            setup.setup(self.args)
        self.assertFalse(self.github.writes)

    def test_protected_environment_without_tags_needs_no_conversion(self):
        self.github.environment = {
            "deployment_branch_policy": {
                "protected_branches": True,
                "custom_branch_policies": False,
            }
        }
        setup.setup(self.args)
        self.assertFalse(
            any(path.startswith("/environments/") for path, _, _ in self.github.writes)
        )

    def test_unknown_protection_is_not_overwritten(self):
        self.args.allow_release_tags = True
        self.args.tag_pattern = ["v*"]
        self.github.environment = {
            "deployment_branch_policy": {
                "protected_branches": True,
                "custom_branch_policies": False,
            },
            "protection_rules": [{"type": "custom-rule"}],
        }
        with self.assertRaisesRegex(setup.SetupError, "Unrecognized"):
            setup.setup(self.args)
        self.assertFalse(self.github.writes)

    def test_custom_names_and_cache_path(self):
        self.args.secret_name = "PROJECT_SIGNING_KEY"
        self.args.public_key_variable = "PROJECT_PUBLIC_KEY"
        self.args.environment = "cache-production"
        self.args.cache_path = "cache"
        setup.setup(self.args)
        self.assertIn("PROJECT_SIGNING_KEY", self.github.secret_names)
        self.assertTrue(
            any(
                path == "/environments/cache-production"
                for path, _, _ in self.github.writes
            )
        )
        variable = next(
            body for path, _, body in self.github.writes if path == "/actions/variables"
        )
        self.assertEqual(variable["name"], "PROJECT_PUBLIC_KEY")
        self.assertIn(
            "extra-substituters = https://example-owner.github.io/example-project/cache",
            self.output.getvalue(),
        )

    def test_optional_workflow_dispatch_passes_raw_inputs(self):
        self.args.workflow = "publish.yml"
        self.args.dispatch = True
        self.args.input = ["release_tag=v0.10.0", "description=@literal-file-name"]
        setup.setup(self.args)
        self.assertIn("/contents/.github/workflows/publish.yml", self.github.reads)
        self.assertEqual(
            self.github.commands[-1],
            [
                "gh",
                "workflow",
                "run",
                "publish.yml",
                "--repo",
                "example-owner/example-project",
                "--ref",
                "main",
                "--raw-field",
                "release_tag=v0.10.0",
                "--raw-field",
                "description=@literal-file-name",
            ],
        )

    def test_disabled_workflow_fails_before_writes(self):
        self.args.workflow = "publish.yml"
        self.github.workflow_state = "disabled_manually"
        with self.assertRaisesRegex(setup.SetupError, "active"):
            setup.setup(self.args)
        self.assertFalse(self.github.writes)

    def test_api_does_not_hide_permission_errors(self):
        with patch(
            "subprocess.run",
            return_value=subprocess.CompletedProcess([], 1, "", "HTTP 403"),
        ):
            with self.assertRaises(setup.SetupError):
                REAL_API("repos/example-owner/example-project/pages", optional=True)

    def test_pagination(self):
        with patch.object(
            setup,
            "api",
            side_effect=[{"secrets": list(range(100))}, {"secrets": [100]}],
        ):
            self.assertEqual(
                setup.paginated(
                    "repos/example-owner/example-project/actions/secrets", "secrets"
                ),
                list(range(101)),
            )

    def test_invalid_cli_arguments_fail_before_api_calls(self):
        for arguments in (
            ["--dispatch"],
            ["--input", "release=v1"],
            ["--workflow", "cache.yml", "--dispatch", "--input", "missing-equals"],
            ["--secret-name", "GITHUB_RESERVED"],
            ["--public-key-variable", "invalid/name"],
            ["--environment", ""],
        ):
            with self.subTest(arguments=arguments):
                with patch.object(sys, "argv", ["setup_github_cache.py", *arguments]):
                    with contextlib.redirect_stderr(io.StringIO()):
                        with self.assertRaises(SystemExit) as error:
                            setup.main()
                self.assertEqual(error.exception.code, 2)
        self.assertFalse(self.github.reads)
        self.assertFalse(self.github.writes)


@unittest.skipUnless(shutil.which("nix"), "Native key test requires Nix")
class NativeKeyTests(unittest.TestCase):
    def test_legacy_binary_cache_keys_are_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory) / "private.key"
            public = Path(directory) / "public.key"
            subprocess.run(
                [
                    "nix-store",
                    "--generate-binary-cache-key",
                    "test-cache-1",
                    str(private),
                    str(public),
                ],
                check=True,
            )
            self.assertEqual(
                setup.public_key(private.read_text()), public.read_text().strip()
            )

    def test_generate_backup_and_reuse_real_nix_key(self):
        with tempfile.TemporaryDirectory() as directory:
            key = Path(directory) / "cache.key"
            with contextlib.redirect_stdout(io.StringIO()):
                secret, public = setup.prepare_key(
                    "example-owner/example-project", key, None, False
                )
                again, reused = setup.prepare_key(
                    "example-owner/example-project", key, public, True
                )
            self.assertEqual(again, secret)
            self.assertEqual(reused, public)
            self.assertEqual(key.stat().st_mode & 0o777, 0o600)
            self.assertTrue(public.startswith("example-owner-example-project-cache-1:"))


if __name__ == "__main__":
    unittest.main()
