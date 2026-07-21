#!/usr/bin/env python3

from pathlib import Path
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from unittest import mock


CHECKER = Path(__file__).with_name("check-nginx-request-id.py")
SPEC = importlib.util.spec_from_file_location("aifeeds_checker", CHECKER)
assert SPEC and SPEC.loader
CHECKER_MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CHECKER_MODULE
SPEC.loader.exec_module(CHECKER_MODULE)


def run_checker(config: str, *arguments: str) -> subprocess.CompletedProcess[str]:
    command = [sys.executable, str(CHECKER), *arguments, "-"]
    return subprocess.run(command, input=config, capture_output=True, text=True, check=False)


VALID_CONFIG = textwrap.dedent(
    """\
    server {
        location /one {
            proxy_pass https://private-upstream-one.example;
            proxy_set_header X-Origin-Secret never-print-this-value;
            proxy_set_header X-Request-Id $request_id;
        }
        location ~ "^/quoted/[{}#]+$" {
            proxy_pass https://private-upstream-two.example;
            proxy_set_header X-Request-Id $request_id;
        }
    }
    """
)


FD_AWARE_APPEND_STATUS = textwrap.dedent(
    """\
    state_value = sys.argv[sys.argv.index('-s') + 1]
    if state_value.startswith('fd:'):
        descriptor = int(state_value.split(':', 1)[1])
        old = os.pread(descriptor, os.fstat(descriptor).st_size, 0)
        os.ftruncate(descriptor, 0)
        os.pwrite(descriptor, old + b'generation\\n', 0)
        os.fsync(descriptor)
    else:
        state = pathlib.Path(state_value)
        old = state.read_text() if state.exists() else ''
        state.write_text(old + 'generation\\n')
    """
)


def make_rotation_state_directory(path: Path) -> None:
    path.mkdir(mode=0o750)
    path.chmod(0o750)


class TestFixturePermissions(unittest.TestCase):
    def test_rotation_state_directory_mode_is_umask_independent(self) -> None:
        previous_umask = os.umask(0o077)
        try:
            with tempfile.TemporaryDirectory() as temporary:
                state_dir = Path(temporary) / "state"
                make_rotation_state_directory(state_dir)
                self.assertEqual(state_dir.stat().st_mode & 0o777, 0o750)
        finally:
            os.umask(previous_umask)


class CheckerCliTests(unittest.TestCase):
    def test_accepts_stdin_and_reports_counts_without_config_values(self) -> None:
        result = run_checker(VALID_CONFIG)

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertRegex(
            result.stdout,
            r"^OK input=1 locations=2 proxy_locations=2 proxy_pass=2 request_id=2\n$",
        )
        self.assertNotIn("private-upstream", result.stdout + result.stderr)
        self.assertNotIn("never-print-this-value", result.stdout + result.stderr)

    def test_accepts_file_input_without_echoing_its_path_or_contents(self) -> None:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as handle:
            handle.write(VALID_CONFIG)
            path = Path(handle.name)

        try:
            result = subprocess.run(
                [sys.executable, str(CHECKER), str(path)],
                capture_output=True,
                text=True,
                check=False,
            )
        finally:
            path.unlink(missing_ok=True)

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("OK input=1", result.stdout)
        self.assertNotIn(str(path), result.stdout + result.stderr)
        self.assertNotIn("private-upstream", result.stdout + result.stderr)

    def test_catches_missing_and_duplicate_headers_when_global_totals_match(self) -> None:
        config = textwrap.dedent(
            """\
            server {
                location /missing {
                    proxy_pass https://do-not-print-missing.example;
                }
                location /duplicate {
                    proxy_pass https://do-not-print-duplicate.example;
                    proxy_set_header X-Request-Id $request_id;
                    proxy_set_header X-Request-Id $request_id;
                }
            }
            """
        )

        result = run_checker(config)

        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("ERROR input=1 line=2 proxy_pass=1 request_id=0", result.stdout)
        self.assertIn("ERROR input=1 line=5 proxy_pass=1 request_id=2", result.stdout)
        self.assertIn("FAIL input=1 errors=2", result.stdout)
        self.assertNotIn("do-not-print", result.stdout + result.stderr)

    def test_requires_request_id_at_the_same_location_level(self) -> None:
        config = textwrap.dedent(
            """\
            server {
                location /nested {
                    proxy_pass https://do-not-print-nested.example;
                    if ($arg_debug) {
                        proxy_set_header X-Request-Id $request_id;
                    }
                }
            }
            """
        )

        result = run_checker(config)

        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("ERROR input=1 line=2 proxy_pass=1 request_id=0", result.stdout)
        self.assertNotIn("do-not-print", result.stdout + result.stderr)

    def test_rejects_an_extra_request_id_header_with_the_wrong_value(self) -> None:
        config = textwrap.dedent(
            """\
            server {
                location /conflicting {
                    proxy_pass https://do-not-print-conflicting.example;
                    proxy_set_header X-Request-Id $request_id;
                    proxy_set_header x-request-id do-not-print-wrong-value;
                }
            }
            """
        )

        result = run_checker(config)

        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(
            "ERROR input=1 line=2 proxy_pass=1 request_id=2 valid_request_id=1",
            result.stdout,
        )
        self.assertNotIn("do-not-print", result.stdout + result.stderr)

    def test_parse_errors_do_not_echo_secret_bearing_directives(self) -> None:
        result = run_checker(
            "location /broken { proxy_set_header X-Origin-Secret never-print-parse-error;"
        )

        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertRegex(result.stdout, r"^ERROR input=1 line=1 parse=1\n$")
        self.assertNotIn("never-print-parse-error", result.stdout + result.stderr)

    def test_exact_proxy_count_is_a_fail_closed_deployment_contract(self) -> None:
        passing = run_checker(VALID_CONFIG, "--expect-proxy-count", "2")
        failing = run_checker(VALID_CONFIG, "--expect-proxy-count", "7")

        self.assertEqual(passing.returncode, 0, passing.stdout + passing.stderr)
        self.assertEqual(failing.returncode, 1, failing.stdout + failing.stderr)
        self.assertIn("expected_proxy_count=7 actual_proxy_count=2", failing.stdout)
        self.assertNotIn("private-upstream", failing.stdout + failing.stderr)

    def test_rejects_lower_level_access_logs(self) -> None:
        config = VALID_CONFIG.replace(
            "server {",
            "server {\n    access_log /do-not-print/private.log combined;",
            1,
        )

        result = run_checker(config, "--expect-proxy-count", "2")

        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("forbidden_access_log=1", result.stdout)
        self.assertNotIn("do-not-print", result.stdout + result.stderr)

    def test_allows_only_explicitly_reviewed_include_paths(self) -> None:
        include = "    include /etc/letsencrypt/options-ssl-nginx.conf;\n"
        config = VALID_CONFIG.replace("server {\n", f"server {{\n{include}", 1)

        passing = run_checker(
            config,
            "--expect-proxy-count",
            "2",
            "--allow-include",
            "/etc/letsencrypt/options-ssl-nginx.conf",
        )
        failing = run_checker(config, "--expect-proxy-count", "2")

        self.assertEqual(passing.returncode, 0, passing.stdout + passing.stderr)
        self.assertEqual(failing.returncode, 1, failing.stdout + failing.stderr)
        self.assertIn("unexpected_include=1", failing.stdout)
        self.assertNotIn("letsencrypt", failing.stdout + failing.stderr)

    def test_root_context_cannot_bypass_access_log_or_include_policy(self) -> None:
        access_log = "access_log /do-not-print/root.log combined;\n" + VALID_CONFIG
        include = "include /do-not-print/root.conf;\n" + VALID_CONFIG

        access_result = run_checker(access_log, "--expect-proxy-count", "2")
        include_result = run_checker(include, "--expect-proxy-count", "2")

        self.assertEqual(access_result.returncode, 1, access_result.stdout + access_result.stderr)
        self.assertEqual(include_result.returncode, 1, include_result.stdout + include_result.stderr)
        self.assertIn("forbidden_access_log=1", access_result.stdout)
        self.assertIn("unexpected_include=1", include_result.stdout)
        self.assertNotIn("do-not-print", access_result.stdout + access_result.stderr)
        self.assertNotIn("do-not-print", include_result.stdout + include_result.stderr)

    def test_unknown_rotation_subcommand_is_usage_error(self) -> None:
        result = subprocess.run(
            [sys.executable, str(CHECKER), "rotation-unknown"],
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 64, result.stdout + result.stderr)
        self.assertEqual(result.stdout, "ERROR arguments=1\n")

    def test_rotation_wrapper_cli_requires_and_forwards_logrotate_identity(self) -> None:
        operation_id = "20260713010101-01234567"
        authority_path = CHECKER_MODULE.ROTATION_ANCHOR_DIRECTORY / (
            f"rotation-anchor-{operation_id}.json"
        )
        digest = "a" * 64
        arguments = [
            "rotation-wrapper",
            operation_id,
            str(authority_path),
            "11", "12", digest,
            "21", "22", digest,
            "31", "32", digest,
            "41", "42", digest,
        ]
        snapshot = {"generation": 1}

        with mock.patch.object(CHECKER_MODULE.os, "geteuid", return_value=0), \
                mock.patch.object(
                    CHECKER_MODULE, "run_rotation_wrapper", return_value=snapshot
                ) as wrapper:
            result = CHECKER_MODULE.main(arguments)

        self.assertEqual(result, 0)
        call = wrapper.call_args
        self.assertEqual(call.kwargs["logrotate"], CHECKER_MODULE.LOGROTATE)
        self.assertEqual(
            call.kwargs["logrotate_expected"],
            {
                "path": str(CHECKER_MODULE.LOGROTATE),
                "dev": 41,
                "ino": 42,
                "sha256": digest,
            },
        )
        self.assertEqual(call.kwargs["config_expected"]["dev"], 31)

    def test_rotation_cli_rejects_old_or_extra_argument_counts_without_typeerror(self) -> None:
        operation_id = "20260713010101-01234567"
        authority_path = CHECKER_MODULE.ROTATION_ANCHOR_DIRECTORY / (
            f"rotation-anchor-{operation_id}.json"
        )
        digest = "b" * 64
        for command in ("rotation-wrapper", "rotation-recover", "rotation-verify"):
            valid = [
                command,
                operation_id,
                str(authority_path),
                "11", "12", digest,
                "21", "22", digest,
                "31", "32", digest,
                "41", "42", digest,
            ]
            for invalid in (valid[:-3], valid + ["unexpected"]):
                with self.subTest(command=command, count=len(invalid)):
                    with mock.patch.object(
                        CHECKER_MODULE, "verify_authorized_rotation_provenance"
                    ) as verifier, mock.patch.object(
                        CHECKER_MODULE, "run_rotation_wrapper"
                    ) as wrapper, mock.patch.object(
                        CHECKER_MODULE, "recover_rotation_wrapper"
                    ) as recoverer:
                        result = CHECKER_MODULE.main(invalid)
                    self.assertEqual(result, 64)
                    verifier.assert_not_called()
                    wrapper.assert_not_called()
                    recoverer.assert_not_called()

    def test_rotation_recover_and_verify_cli_forward_logrotate_identity(self) -> None:
        operation_id = "20260713010101-01234567"
        authority_path = CHECKER_MODULE.ROTATION_ANCHOR_DIRECTORY / (
            f"rotation-anchor-{operation_id}.json"
        )
        digest = "f" * 64
        base = [
            operation_id, str(authority_path),
            "11", "12", digest,
            "21", "22", digest,
            "31", "32", digest,
            "41", "42", digest,
        ]
        cases = (
            ("rotation-recover", "recover_rotation_wrapper", "logrotate"),
            ("rotation-verify", "verify_authorized_rotation_provenance", "logrotate_path"),
        )

        for command, target, path_keyword in cases:
            with self.subTest(command=command), \
                    mock.patch.object(CHECKER_MODULE.os, "geteuid", return_value=0), \
                    mock.patch.object(
                        CHECKER_MODULE, target, return_value={"generation": 7}
                    ) as runner:
                result = CHECKER_MODULE.main([command, *base])
            self.assertEqual(result, 0)
            self.assertEqual(runner.call_args.kwargs[path_keyword], CHECKER_MODULE.LOGROTATE)
            self.assertEqual(runner.call_args.kwargs["logrotate_expected"]["dev"], 41)

    def test_rotation_cli_malformed_logrotate_identity_fails_closed(self) -> None:
        operation_id = "20260713010101-01234567"
        authority_path = CHECKER_MODULE.ROTATION_ANCHOR_DIRECTORY / (
            f"rotation-anchor-{operation_id}.json"
        )
        digest = "c" * 64
        arguments = [
            "rotation-verify",
            operation_id,
            str(authority_path),
            "11", "12", digest,
            "21", "22", digest,
            "31", "32", digest,
            "not-an-int", "42", digest,
        ]

        with mock.patch.object(CHECKER_MODULE.os, "geteuid", return_value=0), \
                mock.patch.object(
                    CHECKER_MODULE, "verify_authorized_rotation_provenance"
                ) as verifier:
            result = CHECKER_MODULE.main(arguments)

        self.assertEqual(result, 1)
        verifier.assert_not_called()

    def test_rotation_cli_rejects_noncanonical_positive_integer_identities(self) -> None:
        operation_id = "20260713010101-01234567"
        authority_path = CHECKER_MODULE.ROTATION_ANCHOR_DIRECTORY / (
            f"rotation-anchor-{operation_id}.json"
        )
        digest = "e" * 64
        base = [
            "rotation-verify", operation_id, str(authority_path),
            "11", "12", digest,
            "21", "22", digest,
            "31", "32", digest,
            "41", "42", digest,
        ]

        for malformed in ("01", "+1", " 1", "1 "):
            with self.subTest(malformed=malformed), \
                    mock.patch.object(CHECKER_MODULE.os, "geteuid", return_value=0), \
                    mock.patch.object(
                        CHECKER_MODULE, "verify_authorized_rotation_provenance"
                    ) as verifier:
                arguments = list(base)
                arguments[12] = malformed
                result = CHECKER_MODULE.main(arguments)
                self.assertEqual(result, 1)
                verifier.assert_not_called()

    def test_rotation_cli_does_not_leak_typeerror_details(self) -> None:
        operation_id = "20260713010101-01234567"
        authority_path = CHECKER_MODULE.ROTATION_ANCHOR_DIRECTORY / (
            f"rotation-anchor-{operation_id}.json"
        )
        digest = "d" * 64
        arguments = [
            "rotation-verify", operation_id, str(authority_path),
            "11", "12", digest,
            "21", "22", digest,
            "31", "32", digest,
            "41", "42", digest,
        ]
        stdout = io.StringIO()
        stderr = io.StringIO()

        with mock.patch.object(CHECKER_MODULE.os, "geteuid", return_value=0), \
                mock.patch.object(
                    CHECKER_MODULE,
                    "verify_authorized_rotation_provenance",
                    side_effect=TypeError("do-not-leak-typeerror-detail"),
                ), redirect_stdout(stdout), redirect_stderr(stderr):
            result = CHECKER_MODULE.main(arguments)

        self.assertEqual(result, 1)
        self.assertEqual(stdout.getvalue(), "ERROR rotation_provenance=1\n")
        self.assertEqual(stderr.getvalue(), "")
        self.assertNotIn("do-not-leak", stdout.getvalue() + stderr.getvalue())


class RotationProvenanceTests(unittest.TestCase):
    operation_id = "20260712010101-deadbeef"

    def _authority_fixture(
        self,
        root: Path,
        state_dir: Path,
        config: Path,
        provenance: dict,
        logrotate: Path,
    ) -> dict:
        checker = root / "checker.py"
        checker.write_text("#!/usr/bin/env python3\n", encoding="utf-8")
        checker.chmod(0o755)
        config.chmod(0o644)
        checker_identity = CHECKER_MODULE._stable_regular_identity(checker)
        config_identity = CHECKER_MODULE._stable_regular_identity(config)
        logrotate_identity = CHECKER_MODULE._stable_regular_identity(logrotate)
        authority = {
            "schema": 2,
            "operation_id": self.operation_id,
            "directory": CHECKER_MODULE._stable_directory_identity(state_dir),
            "provenance": provenance,
            "checker": checker_identity,
            "config": config_identity,
            "logrotate": logrotate_identity,
        }
        authority_path = root / f"rotation-anchor-{self.operation_id}.json"
        authority_path.write_bytes(CHECKER_MODULE._canonical_json(authority) + b"\n")
        authority_path.chmod(0o600)
        anchor_identity = CHECKER_MODULE._stable_regular_identity(authority_path)

        def subset(identity: dict) -> dict:
            return {key: identity[key] for key in ("path", "sha256", "dev", "ino")}

        return {
            "authority_path": authority_path,
            "anchor_expected": subset(anchor_identity),
            "checker_path": checker,
            "checker_expected": subset(checker_identity),
            "config_expected": subset(config_identity),
            "logrotate_expected": subset(logrotate_identity),
        }

    def test_wrapper_advances_a_verifiable_chain_and_rejects_same_byte_status_takeover(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            make_rotation_state_directory(state_dir)
            config = root / "rotate.conf"
            config.write_text("fixture\n", encoding="utf-8")
            fake_logrotate = root / "fake-logrotate.py"
            fake_logrotate.write_text(
                "#!/usr/bin/env python3\n"
                "import os, pathlib, sys\n"
                + FD_AWARE_APPEND_STATUS,
                encoding="utf-8",
            )
            fake_logrotate.chmod(0o755)

            anchor = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            authority = self._authority_fixture(root, state_dir, config, anchor, fake_logrotate)
            first = CHECKER_MODULE.run_rotation_wrapper(
                state_dir=state_dir,
                operation_id=self.operation_id,
                config=config,
                logrotate=fake_logrotate,
                lock_path=root / "rotation.lock",
                **authority,
            )
            second = CHECKER_MODULE.run_rotation_wrapper(
                state_dir=state_dir,
                operation_id=self.operation_id,
                config=config,
                logrotate=fake_logrotate,
                lock_path=root / "rotation.lock",
                **authority,
            )

            self.assertEqual(first["generation"], 1)
            self.assertEqual(second["generation"], 2)
            self.assertEqual(second["ledger"]["dev"], anchor["dev"])
            self.assertEqual(second["ledger"]["ino"], anchor["ino"])
            status = state_dir / "status"
            original = status.read_bytes()
            replacement = state_dir / "replacement"
            replacement.write_bytes(original)
            replacement.chmod(0o600)
            os.replace(replacement, status)

            with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                CHECKER_MODULE.verify_rotation_provenance(
                    state_dir, self.operation_id, anchor
                )

    def test_ledger_same_byte_replacement_is_not_adopted(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_dir = Path(temporary) / "state"
            make_rotation_state_directory(state_dir)
            anchor = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            ledger = state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME
            replacement = state_dir / "replacement-ledger"
            replacement.write_bytes(ledger.read_bytes())
            replacement.chmod(0o600)
            os.replace(replacement, ledger)

            with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                CHECKER_MODULE.verify_rotation_provenance(
                    state_dir, self.operation_id, anchor
                )

    def test_direct_verify_final_barrier_rechecks_status_presence_and_identity(self) -> None:
        for status_mode in ("absent", "present"):
            with self.subTest(status=status_mode), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                state_dir = root / "state"
                make_rotation_state_directory(state_dir)
                anchor = CHECKER_MODULE.initialize_rotation_provenance(
                    state_dir, self.operation_id, state_dir
                )
                if status_mode == "present":
                    config, fake_logrotate = self._rotation_fixture(root)
                    authority = self._authority_fixture(
                        root, state_dir, config, anchor, fake_logrotate
                    )
                    CHECKER_MODULE.run_rotation_wrapper(
                        state_dir=state_dir,
                        operation_id=self.operation_id,
                        config=config,
                        logrotate=fake_logrotate,
                        lock_path=root / "rotation.lock",
                        **authority,
                    )
                status = state_dir / CHECKER_MODULE.ROTATION_STATUS_NAME
                real_require = CHECKER_MODULE._require_canonical_fd
                state_checks = 0

                def inject_before_final_namespace_check(*arguments: object, **keywords: object) -> dict:
                    nonlocal state_checks
                    name = arguments[1]
                    if name == state_dir.name:
                        state_checks += 1
                        if state_checks == 2:
                            replacement = state_dir / "replacement-status"
                            replacement.write_bytes(
                                status.read_bytes() if status.exists() else b"unexpected\n"
                            )
                            replacement.chmod(0o600)
                            os.replace(replacement, status)
                    return real_require(*arguments, **keywords)

                CHECKER_MODULE._require_canonical_fd = inject_before_final_namespace_check
                try:
                    with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                        CHECKER_MODULE.verify_rotation_provenance(
                            state_dir, self.operation_id, anchor
                        )
                finally:
                    CHECKER_MODULE._require_canonical_fd = real_require

    def test_partial_tail_is_repaired_only_by_the_locked_wrapper(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            make_rotation_state_directory(state_dir)
            anchor = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            ledger = state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME
            with ledger.open("ab") as handle:
                handle.write(b'{"phase":"capt')
                handle.flush()
                os.fsync(handle.fileno())
            with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                CHECKER_MODULE.verify_rotation_provenance(
                    state_dir, self.operation_id, anchor
                )

            config, fake_logrotate = self._rotation_fixture(root)
            authority = self._authority_fixture(root, state_dir, config, anchor, fake_logrotate)
            snapshot = CHECKER_MODULE.run_rotation_wrapper(
                state_dir=state_dir,
                operation_id=self.operation_id,
                config=config,
                logrotate=fake_logrotate,
                lock_path=root / "rotation.lock",
                **authority,
            )

            self.assertEqual(snapshot["generation"], 1)
            repaired = ledger.read_bytes()
            self.assertTrue(repaired.endswith(b"\n"))
            records = [json.loads(line) for line in repaired.splitlines()]
            self.assertEqual(
                [record["phase"] for record in records],
                ["committed", "prepared", "captured", "committed"],
            )

    def test_external_authority_is_checked_before_ledger_tail_repair(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            make_rotation_state_directory(state_dir)
            anchor = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            config, fake_logrotate = self._rotation_fixture(root)
            authority = self._authority_fixture(root, state_dir, config, anchor, fake_logrotate)
            ledger = state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME
            with ledger.open("ab") as handle:
                handle.write(b'{"phase":"capt')
                handle.flush()
                os.fsync(handle.fileno())
            poisoned_payload = ledger.read_bytes()

            authority_path = authority["authority_path"]
            replacement = root / "replacement-authority"
            replacement.write_bytes(authority_path.read_bytes())
            replacement.chmod(0o600)
            os.replace(replacement, authority_path)

            with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                CHECKER_MODULE.run_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    **authority,
                )
            self.assertEqual(ledger.read_bytes(), poisoned_payload)

    def test_external_authority_rejects_coherent_inode_takeovers(self) -> None:
        for target in ("ledger", "checker", "config", "anchor"):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                state_dir = root / "state"
                make_rotation_state_directory(state_dir)
                provenance = CHECKER_MODULE.initialize_rotation_provenance(
                    state_dir, self.operation_id, state_dir
                )
                config, fake_logrotate = self._rotation_fixture(root)
                authority = self._authority_fixture(
                    root, state_dir, config, provenance, fake_logrotate
                )
                paths = {
                    "ledger": state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME,
                    "checker": authority["checker_path"],
                    "config": config,
                    "anchor": authority["authority_path"],
                }
                victim = paths[target]
                replacement = victim.with_name(f"replacement-{target}")
                replacement.write_bytes(victim.read_bytes())
                replacement.chmod(victim.stat().st_mode & 0o777)
                os.replace(replacement, victim)

                with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                    CHECKER_MODULE.run_rotation_wrapper(
                        state_dir=state_dir,
                        operation_id=self.operation_id,
                        config=config,
                        logrotate=fake_logrotate,
                        lock_path=root / "rotation.lock",
                        **authority,
                    )
                self.assertEqual(
                    len((state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME).read_bytes().splitlines()),
                    1,
                )

    def test_recovery_cleans_or_finishes_without_starting_a_new_generation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            make_rotation_state_directory(state_dir)
            provenance = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            config, fake_logrotate = self._rotation_fixture(root)
            authority = self._authority_fixture(
                root, state_dir, config, provenance, fake_logrotate
            )
            first = CHECKER_MODULE.run_rotation_wrapper(
                state_dir=state_dir,
                operation_id=self.operation_id,
                config=config,
                logrotate=fake_logrotate,
                lock_path=root / "rotation.lock",
                **authority,
            )
            recovered = CHECKER_MODULE.recover_rotation_wrapper(
                state_dir=state_dir,
                operation_id=self.operation_id,
                config=config,
                logrotate=fake_logrotate,
                lock_path=root / "rotation.lock",
                **authority,
            )
            repeated = CHECKER_MODULE.recover_rotation_wrapper(
                state_dir=state_dir,
                operation_id=self.operation_id,
                config=config,
                logrotate=fake_logrotate,
                lock_path=root / "rotation.lock",
                **authority,
            )

            self.assertEqual(first["generation"], 1)
            self.assertEqual(recovered["generation"], 1)
            self.assertEqual(repeated["tail_record_sha256"], first["tail_record_sha256"])

    def test_prepared_recovery_rejects_old_status_drift_before_running_child(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            make_rotation_state_directory(state_dir)
            provenance = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            config = root / "rotate.conf"
            config.write_text("fixture\n", encoding="utf-8")
            calls = root / "rotation-calls"
            fake_logrotate = root / "counting-logrotate.py"
            fake_logrotate.write_text(
                "#!/usr/bin/env python3\n"
                "import os, pathlib, sys\n"
                f"with pathlib.Path({str(calls)!r}).open('a') as handle:\n"
                "    handle.write('called\\n'); handle.flush(); os.fsync(handle.fileno())\n"
                + FD_AWARE_APPEND_STATUS,
                encoding="utf-8",
            )
            fake_logrotate.chmod(0o755)
            authority = self._authority_fixture(
                root, state_dir, config, provenance, fake_logrotate
            )
            CHECKER_MODULE.run_rotation_wrapper(
                state_dir=state_dir,
                operation_id=self.operation_id,
                config=config,
                logrotate=fake_logrotate,
                lock_path=root / "rotation.lock",
                **authority,
            )
            with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                CHECKER_MODULE.run_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    fault_after_phase="prepared",
                    **authority,
                )
            calls_before = calls.read_text().splitlines()
            status = state_dir / CHECKER_MODULE.ROTATION_STATUS_NAME
            replacement = state_dir / "replacement-old-status"
            replacement.write_bytes(status.read_bytes())
            replacement.chmod(0o600)
            os.replace(replacement, status)

            with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                CHECKER_MODULE.recover_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    **authority,
                )
            self.assertEqual(calls.read_text().splitlines(), calls_before)
            records = [
                json.loads(line)
                for line in (state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME).read_bytes().splitlines()
            ]
            self.assertEqual(records[-1]["phase"], "prepared")

    def test_prepared_none_status_remains_absent_through_child_barriers(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            make_rotation_state_directory(state_dir)
            provenance = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            config = root / "rotate.conf"
            config.write_text("fixture\n", encoding="utf-8")
            calls = root / "rotation-calls"
            fake_logrotate = root / "counting-logrotate.py"
            fake_logrotate.write_text(
                "#!/usr/bin/env python3\n"
                "import os, pathlib, sys\n"
                f"with pathlib.Path({str(calls)!r}).open('a') as handle:\n"
                "    handle.write('called\\n'); handle.flush(); os.fsync(handle.fileno())\n"
                + FD_AWARE_APPEND_STATUS,
                encoding="utf-8",
            )
            fake_logrotate.chmod(0o755)
            authority = self._authority_fixture(
                root, state_dir, config, provenance, fake_logrotate
            )
            with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                CHECKER_MODULE.run_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    fault_after_phase="prepared",
                    **authority,
                )
            injected = False

            def create_live_status(label: str) -> None:
                nonlocal injected
                if label == "B4-child-pre" and not injected:
                    injected = True
                    status = state_dir / CHECKER_MODULE.ROTATION_STATUS_NAME
                    status.write_bytes(b"unexpected\n")
                    status.chmod(0o600)

            with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                CHECKER_MODULE.recover_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    barrier_hook=create_live_status,
                    **authority,
                )
            self.assertTrue(injected)
            self.assertFalse(calls.exists())
            records = [
                json.loads(line)
                for line in (state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME).read_bytes().splitlines()
            ]
            self.assertEqual(records[-1]["phase"], "prepared")

    def test_c2_candidate_absence_is_proven_before_committed_append(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            make_rotation_state_directory(state_dir)
            provenance = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            config, fake_logrotate = self._rotation_fixture(root)
            authority = self._authority_fixture(
                root, state_dir, config, provenance, fake_logrotate
            )
            CHECKER_MODULE.run_rotation_wrapper(
                state_dir=state_dir,
                operation_id=self.operation_id,
                config=config,
                logrotate=fake_logrotate,
                lock_path=root / "rotation.lock",
                **authority,
            )
            injected = False

            def recreate_candidate(label: str) -> None:
                nonlocal injected
                if label != "B8-committed-append-pre" or injected:
                    return
                injected = True
                workspace = state_dir / "generation-00000000000000000002"
                candidate = workspace / CHECKER_MODULE.ROTATION_STATUS_NAME
                candidate.write_bytes(
                    (state_dir / CHECKER_MODULE.ROTATION_STATUS_NAME).read_bytes()
                )
                candidate.chmod(0o600)

            with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                CHECKER_MODULE.run_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    barrier_hook=recreate_candidate,
                    **authority,
                )
            self.assertTrue(injected)
            records = [
                json.loads(line)
                for line in (state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME).read_bytes().splitlines()
            ]
            self.assertEqual(records[-1]["phase"], "captured")

    def test_legacy_rotation_lock_metadata_is_not_an_authority_or_lock_domain(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            make_rotation_state_directory(state_dir)
            provenance = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            config, fake_logrotate = self._rotation_fixture(root)
            authority = self._authority_fixture(
                root, state_dir, config, provenance, fake_logrotate
            )
            lock = root / "rotation.lock"
            lock.write_text("", encoding="utf-8")
            lock.chmod(0o644)
            ledger = state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME
            snapshot = CHECKER_MODULE.run_rotation_wrapper(
                state_dir=state_dir,
                operation_id=self.operation_id,
                config=config,
                logrotate=fake_logrotate,
                lock_path=lock,
                **authority,
            )
            self.assertEqual(snapshot["generation"], 1)
            self.assertEqual(lock.stat().st_mode & 0o777, 0o644)
            self.assertGreater(len(ledger.read_bytes().splitlines()), 1)

    def test_ledger_fd_lock_survives_replaced_legacy_lock_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            make_rotation_state_directory(state_dir)
            provenance = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            config = root / "rotate.conf"
            config.write_text("fixture\n", encoding="utf-8")
            calls = root / "calls"
            gate = root / "gate"
            fake_logrotate = root / "blocking-logrotate.py"
            fake_logrotate.write_text(
                "#!/usr/bin/env python3\n"
                "import os, pathlib, sys, time\n"
                f"calls = pathlib.Path({str(calls)!r})\n"
                f"gate = pathlib.Path({str(gate)!r})\n"
                "with calls.open('a', encoding='utf-8') as handle:\n"
                "    handle.write('called\\n'); handle.flush(); os.fsync(handle.fileno())\n"
                "while not gate.exists(): time.sleep(0.01)\n"
                + FD_AWARE_APPEND_STATUS,
                encoding="utf-8",
            )
            fake_logrotate.chmod(0o755)
            authority = self._authority_fixture(
                root, state_dir, config, provenance, fake_logrotate
            )
            lock = root / "rotation.lock"
            outcomes: list[object] = []

            def rotate() -> None:
                try:
                    outcomes.append(
                        CHECKER_MODULE.run_rotation_wrapper(
                            state_dir=state_dir,
                            operation_id=self.operation_id,
                            config=config,
                            logrotate=fake_logrotate,
                            lock_path=lock,
                            **authority,
                        )
                    )
                except BaseException as error:  # pragma: no cover - diagnostic capture
                    outcomes.append(error)

            first = threading.Thread(target=rotate, daemon=True)
            first.start()
            deadline = time.monotonic() + 5
            while (not calls.exists() or len(calls.read_text().splitlines()) < 1) \
                    and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(calls.exists(), "first rotation never reached logrotate")

            replacement = root / "replacement-lock"
            replacement.write_text("", encoding="utf-8")
            replacement.chmod(0o600)
            os.replace(replacement, lock)
            second = threading.Thread(target=rotate, daemon=True)
            second.start()
            time.sleep(0.35)
            calls_before_release = calls.read_text().splitlines()
            gate.touch()
            first.join(5)
            second.join(5)

            self.assertEqual(calls_before_release, ["called"])
            self.assertFalse(first.is_alive())
            self.assertFalse(second.is_alive())
            self.assertEqual(
                sorted(
                    outcome["generation"]
                    for outcome in outcomes
                    if isinstance(outcome, dict)
                ),
                [1, 2],
                outcomes,
            )

    def test_external_config_and_logrotate_takeover_at_child_barrier_fail_closed(self) -> None:
        for target in ("config", "logrotate"):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                state_dir = root / "state"
                make_rotation_state_directory(state_dir)
                provenance = CHECKER_MODULE.initialize_rotation_provenance(
                    state_dir, self.operation_id, state_dir
                )
                config, fake_logrotate = self._rotation_fixture(root)
                marker = root / "poison-executed"
                authority = self._authority_fixture(
                    root, state_dir, config, provenance, fake_logrotate
                )
                injected = False

                def poison(label: str) -> None:
                    nonlocal injected
                    if label != "B4-child-pre" or injected:
                        return
                    injected = True
                    victim = config if target == "config" else fake_logrotate
                    replacement = root / f"replacement-{target}"
                    if target == "config":
                        replacement.write_bytes(victim.read_bytes())
                        replacement.chmod(0o644)
                    else:
                        replacement.write_text(
                            "#!/usr/bin/env python3\n"
                            "import pathlib\n"
                            f"pathlib.Path({str(marker)!r}).write_text('poison')\n",
                            encoding="utf-8",
                        )
                        replacement.chmod(0o755)
                    os.replace(replacement, victim)

                with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                    CHECKER_MODULE.run_rotation_wrapper(
                        state_dir=state_dir,
                        operation_id=self.operation_id,
                        config=config,
                        logrotate=fake_logrotate,
                        lock_path=root / "rotation.lock",
                        barrier_hook=poison,
                        **authority,
                    )
                self.assertTrue(injected)
                self.assertFalse(marker.exists())
                self.assertFalse((state_dir / CHECKER_MODULE.ROTATION_STATUS_NAME).exists())

    def test_anchor_same_inode_metadata_drift_at_barrier_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            make_rotation_state_directory(state_dir)
            provenance = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            config, fake_logrotate = self._rotation_fixture(root)
            authority = self._authority_fixture(
                root, state_dir, config, provenance, fake_logrotate
            )
            anchor_path = authority["authority_path"]
            injected = False

            def weaken_anchor_mode(label: str) -> None:
                nonlocal injected
                if label == "B4-child-post" and not injected:
                    injected = True
                    anchor_path.chmod(0o644)

            with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                CHECKER_MODULE.run_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    barrier_hook=weaken_anchor_mode,
                    **authority,
                )
            self.assertTrue(injected)
            self.assertEqual(anchor_path.stat().st_mode & 0o777, 0o644)
            self.assertFalse((state_dir / CHECKER_MODULE.ROTATION_STATUS_NAME).exists())

    def test_child_consumes_held_config_and_logrotate_fds_after_spawn_window_takeover(self) -> None:
        for target in ("config", "logrotate"):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                state_dir = root / "state"
                make_rotation_state_directory(state_dir)
                provenance = CHECKER_MODULE.initialize_rotation_provenance(
                    state_dir, self.operation_id, state_dir
                )
                config = root / "rotate.conf"
                config.write_text("trusted-config\n", encoding="utf-8")
                observed = root / "observed-config"
                poison_marker = root / "poison-logrotate-executed"
                fake_logrotate = root / "fd-logrotate.py"
                fake_logrotate.write_text(
                    "#!/usr/bin/env python3\n"
                    "import os, pathlib, sys\n"
                    f"pathlib.Path({str(observed)!r}).write_text(pathlib.Path(sys.argv[-1]).read_text())\n"
                    + FD_AWARE_APPEND_STATUS,
                    encoding="utf-8",
                )
                fake_logrotate.chmod(0o755)
                authority = self._authority_fixture(
                    root, state_dir, config, provenance, fake_logrotate
                )

                def replace_after_final_child_barrier() -> None:
                    if target == "config":
                        replacement = root / "replacement-config"
                        replacement.write_text("POISON-CONFIG\n", encoding="utf-8")
                        replacement.chmod(0o644)
                        os.replace(replacement, config)
                    else:
                        replacement = root / "replacement-logrotate"
                        replacement.write_text(
                            "#!/usr/bin/env python3\n"
                            "import pathlib\n"
                            f"pathlib.Path({str(poison_marker)!r}).write_text('poison')\n",
                            encoding="utf-8",
                        )
                        replacement.chmod(0o755)
                        os.replace(replacement, fake_logrotate)

                with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                    CHECKER_MODULE.run_rotation_wrapper(
                        state_dir=state_dir,
                        operation_id=self.operation_id,
                        config=config,
                        logrotate=fake_logrotate,
                        lock_path=root / "rotation.lock",
                        child_spawn_hook=replace_after_final_child_barrier,
                        **authority,
                    )
                self.assertEqual(observed.read_text(), "trusted-config\n")
                self.assertFalse(poison_marker.exists())
                self.assertFalse((state_dir / CHECKER_MODULE.ROTATION_STATUS_NAME).exists())

    def test_ledger_takeover_after_child_exit_cannot_commit_to_detached_fd(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            make_rotation_state_directory(state_dir)
            provenance = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            config, fake_logrotate = self._rotation_fixture(root)
            authority = self._authority_fixture(
                root, state_dir, config, provenance, fake_logrotate
            )
            ledger = state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME
            injected = False

            def replace_ledger(label: str) -> None:
                nonlocal injected
                if label != "B4-child-post" or injected:
                    return
                injected = True
                replacement = state_dir / "replacement-ledger"
                replacement.write_bytes(ledger.read_bytes())
                replacement.chmod(0o600)
                os.replace(replacement, ledger)

            with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                CHECKER_MODULE.run_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    barrier_hook=replace_ledger,
                    **authority,
                )
            self.assertTrue(injected)
            self.assertFalse((state_dir / CHECKER_MODULE.ROTATION_STATUS_NAME).exists())
            records = [json.loads(line) for line in ledger.read_bytes().splitlines()]
            self.assertEqual(records[-1]["phase"], "prepared")

    def test_same_inode_same_size_ledger_overwrite_is_detected_at_barrier(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            make_rotation_state_directory(state_dir)
            provenance = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            config, fake_logrotate = self._rotation_fixture(root)
            authority = self._authority_fixture(
                root, state_dir, config, provenance, fake_logrotate
            )
            ledger = state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME
            before_inode = ledger.stat().st_ino
            injected = False

            def overwrite_ledger_in_place(label: str) -> None:
                nonlocal injected
                if label != "B4-child-post" or injected:
                    return
                injected = True
                payload = ledger.read_bytes()
                poisoned = payload.replace(b"deadbeef", b"feedbeef", 1)
                self.assertEqual(len(poisoned), len(payload))
                descriptor = os.open(ledger, os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0))
                try:
                    os.pwrite(descriptor, poisoned, 0)
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)

            with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                CHECKER_MODULE.run_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    barrier_hook=overwrite_ledger_in_place,
                    **authority,
                )
            self.assertTrue(injected)
            self.assertEqual(ledger.stat().st_ino, before_inode)
            self.assertFalse((state_dir / CHECKER_MODULE.ROTATION_STATUS_NAME).exists())

    def test_ledger_prefix_overwrite_inside_append_is_never_adopted(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            make_rotation_state_directory(state_dir)
            provenance = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            config, fake_logrotate = self._rotation_fixture(root)
            authority = self._authority_fixture(
                root, state_dir, config, provenance, fake_logrotate
            )
            ledger = state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME
            ledger_inode = ledger.stat().st_ino
            real_write_all = CHECKER_MODULE._write_all
            injected = False

            def overwrite_prefix_then_write(descriptor: int, payload: bytes) -> None:
                nonlocal injected
                value = os.fstat(descriptor)
                if value.st_ino == ledger_inode and not injected:
                    injected = True
                    prefix = CHECKER_MODULE._pread_all(descriptor)
                    poisoned = prefix.replace(b"deadbeef", b"feedbeef", 1)
                    self.assertEqual(len(poisoned), len(prefix))
                    os.pwrite(descriptor, poisoned, 0)
                    os.fsync(descriptor)
                real_write_all(descriptor, payload)

            CHECKER_MODULE._write_all = overwrite_prefix_then_write
            try:
                with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                    CHECKER_MODULE.run_rotation_wrapper(
                        state_dir=state_dir,
                        operation_id=self.operation_id,
                        config=config,
                        logrotate=fake_logrotate,
                        lock_path=root / "rotation.lock",
                        **authority,
                    )
            finally:
                CHECKER_MODULE._write_all = real_write_all
            self.assertTrue(injected)
            self.assertFalse((state_dir / CHECKER_MODULE.ROTATION_STATUS_NAME).exists())

    def test_exact_rename_rejects_same_byte_source_inode_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.write_text("same bytes\n", encoding="utf-8")
            source.chmod(0o600)
            expected = CHECKER_MODULE._stable_regular_identity(source)
            held = os.open(source, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            parent = os.open(root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                replacement = root / "replacement"
                replacement.write_bytes(source.read_bytes())
                replacement.chmod(0o600)
                os.replace(replacement, source)
                with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                    CHECKER_MODULE._rename_exact_no_replace(
                        parent,
                        "source",
                        held,
                        expected,
                        parent,
                        "destination",
                    )
                self.assertTrue(source.exists())
                self.assertFalse((root / "destination").exists())
            finally:
                os.close(parent)
                os.close(held)

    def test_exact_rename_restores_same_inode_content_mutation_after_precheck(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            source.write_bytes(b"TRUSTED\n")
            source.chmod(0o600)
            expected = CHECKER_MODULE._stable_regular_identity(source)
            held = os.open(source, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
            parent = os.open(root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))

            def mutate_held_source() -> None:
                os.pwrite(held, b"POISON!\n", 0)
                os.fsync(held)

            try:
                with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                    CHECKER_MODULE._rename_exact_no_replace(
                        parent,
                        "source",
                        held,
                        expected,
                        parent,
                        "destination",
                        mutate_held_source,
                    )
                self.assertTrue(source.exists())
                self.assertEqual(source.read_bytes(), b"POISON!\n")
                self.assertFalse((root / "destination").exists())
            finally:
                os.close(parent)
                os.close(held)

    def test_exact_rename_final_namespace_check_rejects_post_move_takeover(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source"
            destination = root / "destination"
            source.write_bytes(b"TRUSTED\n")
            source.chmod(0o600)
            expected = CHECKER_MODULE._stable_regular_identity(source)
            held = os.open(source, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            parent = os.open(root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            real_identity = CHECKER_MODULE._fd_regular_identity
            injected = False

            def replace_destination_during_post_move_identity(
                descriptor: int, canonical_path: Path
            ) -> dict:
                nonlocal injected
                if descriptor == held and not source.exists() and destination.exists() \
                        and not injected:
                    injected = True
                    replacement = root / "replacement-destination"
                    replacement.write_bytes(b"POISON!\n")
                    replacement.chmod(0o600)
                    os.replace(replacement, destination)
                return real_identity(descriptor, canonical_path)

            CHECKER_MODULE._fd_regular_identity = replace_destination_during_post_move_identity
            try:
                with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                    CHECKER_MODULE._rename_exact_no_replace(
                        parent,
                        "source",
                        held,
                        expected,
                        parent,
                        "destination",
                    )
            finally:
                CHECKER_MODULE._fd_regular_identity = real_identity
                os.close(parent)
                os.close(held)
            self.assertTrue(injected)
            self.assertFalse(destination.exists())
            self.assertTrue(source.exists())
            self.assertEqual(source.read_bytes(), b"POISON!\n")

    def test_canonical_fd_final_stat_rechecks_full_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "target"
            target.write_bytes(b"trusted\n")
            target.chmod(0o600)
            expected = CHECKER_MODULE._stable_regular_identity(target)
            descriptor = os.open(target, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            parent = os.open(root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            real_identity = CHECKER_MODULE._fd_regular_identity
            injected = False

            def chmod_after_identity(held: int, canonical_path: Path) -> dict:
                nonlocal injected
                identity = real_identity(held, canonical_path)
                if held == descriptor and not injected:
                    injected = True
                    target.chmod(0o644)
                return identity

            CHECKER_MODULE._fd_regular_identity = chmod_after_identity
            try:
                with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                    CHECKER_MODULE._require_canonical_fd(
                        parent,
                        target.name,
                        descriptor,
                        expected,
                        target,
                    )
            finally:
                CHECKER_MODULE._fd_regular_identity = real_identity
                os.close(parent)
                os.close(descriptor)
            self.assertTrue(injected)

    def test_state_directory_takeover_after_child_exit_is_never_adopted(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            make_rotation_state_directory(state_dir)
            provenance = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            config, fake_logrotate = self._rotation_fixture(root)
            authority = self._authority_fixture(
                root, state_dir, config, provenance, fake_logrotate
            )
            detached = root / "detached-state"
            injected = False

            def replace_state_directory(label: str) -> None:
                nonlocal injected
                if label != "B4-child-post" or injected:
                    return
                injected = True
                os.rename(state_dir, detached)
                make_rotation_state_directory(state_dir)
                replacement_ledger = state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME
                replacement_ledger.write_bytes(
                    (detached / CHECKER_MODULE.ROTATION_LEDGER_NAME).read_bytes()
                )
                replacement_ledger.chmod(0o600)

            with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                CHECKER_MODULE.run_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    barrier_hook=replace_state_directory,
                    **authority,
                )
            self.assertTrue(injected)
            self.assertFalse((state_dir / CHECKER_MODULE.ROTATION_STATUS_NAME).exists())
            self.assertTrue(any(path.name.startswith("generation-") for path in detached.iterdir()))
            canonical_records = [
                json.loads(line)
                for line in (state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME).read_bytes().splitlines()
            ]
            self.assertEqual(canonical_records[-1]["phase"], "prepared")

    def test_status_validate_copy_race_copies_only_the_held_status_fd(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            make_rotation_state_directory(state_dir)
            provenance = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            config, fake_logrotate = self._rotation_fixture(root)
            authority = self._authority_fixture(
                root, state_dir, config, provenance, fake_logrotate
            )
            CHECKER_MODULE.run_rotation_wrapper(
                state_dir=state_dir,
                operation_id=self.operation_id,
                config=config,
                logrotate=fake_logrotate,
                lock_path=root / "rotation.lock",
                **authority,
            )
            status = state_dir / CHECKER_MODULE.ROTATION_STATUS_NAME
            trusted = status.read_bytes()
            injected = False

            def replace_after_status_revalidation() -> None:
                nonlocal injected
                injected = True
                replacement = state_dir / "replacement-status"
                replacement.write_bytes(b"POISON\n")
                replacement.chmod(0o600)
                os.replace(replacement, status)

            with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                CHECKER_MODULE.run_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    candidate_copy_hook=replace_after_status_revalidation,
                    **authority,
                )
            self.assertTrue(injected)
            candidate = state_dir / "generation-00000000000000000002" / "status"
            self.assertEqual(candidate.read_bytes(), trusted)
            self.assertNotEqual(candidate.read_bytes(), status.read_bytes())
            records = [
                json.loads(line)
                for line in (state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME).read_bytes().splitlines()
            ]
            self.assertEqual(records[-1]["phase"], "committed")

    def test_status_copy_rejects_same_inode_content_aba(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            make_rotation_state_directory(state_dir)
            provenance = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            config = root / "rotate.conf"
            config.write_text("fixture\n", encoding="utf-8")
            fake_logrotate = root / "large-status-logrotate.py"
            fake_logrotate.write_text(
                "#!/usr/bin/env python3\n"
                "import os, pathlib, sys\n"
                "payload = b'A' * (2 * 1024 * 1024)\n"
                "state_value = sys.argv[sys.argv.index('-s') + 1]\n"
                "if state_value.startswith('fd:'):\n"
                "    descriptor = int(state_value.split(':', 1)[1])\n"
                "    os.ftruncate(descriptor, 0); os.pwrite(descriptor, payload, 0); os.fsync(descriptor)\n"
                "else:\n"
                "    pathlib.Path(state_value).write_bytes(payload)\n",
                encoding="utf-8",
            )
            fake_logrotate.chmod(0o755)
            authority = self._authority_fixture(
                root, state_dir, config, provenance, fake_logrotate
            )
            first = CHECKER_MODULE.run_rotation_wrapper(
                state_dir=state_dir,
                operation_id=self.operation_id,
                config=config,
                logrotate=fake_logrotate,
                lock_path=root / "rotation.lock",
                **authority,
            )
            status = state_dir / CHECKER_MODULE.ROTATION_STATUS_NAME
            self.assertEqual(status.stat().st_size, 2 * 1024 * 1024)
            status_inode = status.stat().st_ino
            attacker = os.open(status, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
            real_pread = CHECKER_MODULE.os.pread
            armed = False
            first_chunk_seen = False
            restored = False

            def arm_copy_race() -> None:
                nonlocal armed
                armed = True

            def aba_pread(descriptor: int, size: int, offset: int) -> bytes:
                nonlocal first_chunk_seen, restored
                chunk = real_pread(descriptor, size, offset)
                if armed and os.fstat(descriptor).st_ino == status_inode:
                    if offset == 0 and not first_chunk_seen:
                        first_chunk_seen = True
                        os.pwrite(attacker, b"B" * (1024 * 1024), 1024 * 1024)
                        os.fsync(attacker)
                    elif offset == 1024 * 1024 and first_chunk_seen and not restored:
                        restored = True
                        os.pwrite(attacker, b"A" * (1024 * 1024), 1024 * 1024)
                        os.fsync(attacker)
                return chunk

            CHECKER_MODULE.os.pread = aba_pread
            try:
                with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                    CHECKER_MODULE.run_rotation_wrapper(
                        state_dir=state_dir,
                        operation_id=self.operation_id,
                        config=config,
                        logrotate=fake_logrotate,
                        lock_path=root / "rotation.lock",
                        candidate_copy_hook=arm_copy_race,
                        **authority,
                    )
            finally:
                CHECKER_MODULE.os.pread = real_pread
                os.close(attacker)
            self.assertTrue(first_chunk_seen)
            self.assertTrue(restored)
            self.assertEqual(status.read_bytes(), b"A" * (2 * 1024 * 1024))
            records = [
                json.loads(line)
                for line in (state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME).read_bytes().splitlines()
            ]
            self.assertEqual(records[-1]["phase"], "committed")
            self.assertEqual(records[-1]["generation"], first["generation"])

    def test_candidate_same_byte_takeover_inside_exact_cas_never_commits(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            make_rotation_state_directory(state_dir)
            provenance = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            config, fake_logrotate = self._rotation_fixture(root)
            authority = self._authority_fixture(
                root, state_dir, config, provenance, fake_logrotate
            )
            candidate_path: Path | None = None

            def replace_candidate_after_precheck() -> None:
                nonlocal candidate_path
                candidate_path = state_dir / "generation-00000000000000000001" / "status"
                replacement = candidate_path.with_name("replacement-candidate")
                replacement.write_bytes(candidate_path.read_bytes())
                replacement.chmod(0o600)
                os.replace(replacement, candidate_path)

            with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                CHECKER_MODULE.run_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    candidate_cas_hook=replace_candidate_after_precheck,
                    **authority,
                )
            self.assertIsNotNone(candidate_path)
            self.assertFalse((state_dir / CHECKER_MODULE.ROTATION_STATUS_NAME).exists())
            records = [
                json.loads(line)
                for line in (state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME).read_bytes().splitlines()
            ]
            self.assertEqual(records[-1]["phase"], "captured")

    def test_old_status_same_byte_takeover_inside_exact_cas_never_commits(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            make_rotation_state_directory(state_dir)
            provenance = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            config, fake_logrotate = self._rotation_fixture(root)
            authority = self._authority_fixture(
                root, state_dir, config, provenance, fake_logrotate
            )
            first = CHECKER_MODULE.run_rotation_wrapper(
                state_dir=state_dir,
                operation_id=self.operation_id,
                config=config,
                logrotate=fake_logrotate,
                lock_path=root / "rotation.lock",
                **authority,
            )
            old_identity = first["status"]
            status = state_dir / CHECKER_MODULE.ROTATION_STATUS_NAME

            def replace_old_status_after_precheck() -> None:
                replacement = state_dir / "replacement-old-status"
                replacement.write_bytes(status.read_bytes())
                replacement.chmod(0o600)
                os.replace(replacement, status)

            with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                CHECKER_MODULE.run_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    old_status_cas_hook=replace_old_status_after_precheck,
                    **authority,
                )
            self.assertTrue(status.exists())
            self.assertNotEqual(status.stat().st_ino, old_identity["ino"])
            records = [
                json.loads(line)
                for line in (state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME).read_bytes().splitlines()
            ]
            self.assertEqual(records[-1]["phase"], "captured")

    def test_rotation_barriers_and_directory_fsyncs_follow_durable_order(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            make_rotation_state_directory(state_dir)
            provenance = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            config, fake_logrotate = self._rotation_fixture(root)
            authority = self._authority_fixture(
                root, state_dir, config, provenance, fake_logrotate
            )
            CHECKER_MODULE.run_rotation_wrapper(
                state_dir=state_dir,
                operation_id=self.operation_id,
                config=config,
                logrotate=fake_logrotate,
                lock_path=root / "rotation.lock",
                **authority,
            )
            trace: list[str] = []
            fsync_events: list[tuple[str, str]] = []
            current_barrier = "open"
            real_fsync = CHECKER_MODULE.os.fsync

            def record_barrier(label: str) -> None:
                nonlocal current_barrier
                current_barrier = label

            def record_fsync(descriptor: int) -> None:
                kind = "dir" if os.path.isdir(f"/dev/fd/{descriptor}") else "file"
                fsync_events.append((current_barrier, kind))
                real_fsync(descriptor)

            CHECKER_MODULE.os.fsync = record_fsync
            try:
                CHECKER_MODULE.run_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    barrier_hook=record_barrier,
                    barrier_trace=trace,
                    **authority,
                )
            finally:
                CHECKER_MODULE.os.fsync = real_fsync
            required = [
                "B0-lock",
                "B2-workspace-create-pre", "B2-workspace-create-post",
                "B3-candidate-copy-pre", "B3-prepared-append-pre", "B3-prepared-append-post",
                "B4-child-pre", "B4-child-post",
                "B5-captured-append-pre", "B5-captured-append-post",
                "B6-old-status-cas-pre", "B6-old-status-cas-post",
                "B7-candidate-cas-pre", "B7-candidate-cas-post",
                "B8-committed-append-pre", "B8-committed-append-post",
                "B9-previous-rename-pre", "B9-previous-rename-post",
                "B9-previous-unlink-pre", "B9-previous-unlink-post",
                "B9-workspace-rename-pre", "B9-workspace-rename-post",
                "B9-workspace-rmdir-pre", "B9-workspace-rmdir-post",
                "B10-snapshot",
            ]
            positions = [trace.index(label) for label in required]
            self.assertEqual(positions, sorted(positions), trace)
            self.assertIn(("B2-workspace-create-pre", "dir"), fsync_events)
            self.assertIn(("B3-candidate-copy-pre", "file"), fsync_events)
            self.assertIn(("B3-candidate-copy-pre", "dir"), fsync_events)
            self.assertIn(("B6-old-status-cas-pre", "dir"), fsync_events)
            self.assertIn(("B7-candidate-cas-pre", "dir"), fsync_events)
            self.assertIn(("B8-committed-append-pre", "file"), fsync_events)

    def test_recreated_workspace_tombstone_after_rmdir_blocks_success(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            make_rotation_state_directory(state_dir)
            provenance = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            config, fake_logrotate = self._rotation_fixture(root)
            authority = self._authority_fixture(
                root, state_dir, config, provenance, fake_logrotate
            )
            injected_path: Path | None = None

            def recreate_tombstone(label: str) -> None:
                nonlocal injected_path
                if label != "B9-workspace-rmdir-post" or injected_path is not None:
                    return
                records = [
                    json.loads(line)
                    for line in (state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME).read_bytes().splitlines()
                ]
                workspace = records[-1]["workspace"]
                workspace_name = Path(workspace["path"]).name
                injected_path = state_dir / (
                    f".cleanup-{workspace_name}-{workspace['dev']}-{workspace['ino']}"
                )
                injected_path.mkdir(mode=0o700)

            with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                CHECKER_MODULE.run_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    barrier_hook=recreate_tombstone,
                    **authority,
                )
            self.assertIsNotNone(injected_path)
            self.assertTrue(injected_path.is_dir())

    def test_recreated_previous_source_after_rename_is_rejected_before_tombstone_unlink(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            make_rotation_state_directory(state_dir)
            provenance = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            config, fake_logrotate = self._rotation_fixture(root)
            authority = self._authority_fixture(
                root, state_dir, config, provenance, fake_logrotate
            )
            CHECKER_MODULE.run_rotation_wrapper(
                state_dir=state_dir,
                operation_id=self.operation_id,
                config=config,
                logrotate=fake_logrotate,
                lock_path=root / "rotation.lock",
                **authority,
            )
            trace: list[str] = []
            source: Path | None = None
            tombstone: Path | None = None

            def recreate_previous_source(label: str) -> None:
                nonlocal source, tombstone
                if label != "B9-previous-rename-post" or source is not None:
                    return
                records = [
                    json.loads(line)
                    for line in (state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME).read_bytes().splitlines()
                ]
                tail = records[-1]
                workspace = Path(tail["workspace"]["path"])
                old_status = tail["old_status"]
                source = workspace / "previous-status"
                tombstone = workspace / (
                    f".cleanup-previous-{old_status['dev']}-{old_status['ino']}"
                )
                source.write_bytes(tombstone.read_bytes())
                source.chmod(0o600)

            with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                CHECKER_MODULE.run_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    barrier_hook=recreate_previous_source,
                    barrier_trace=trace,
                    **authority,
                )

            self.assertIsNotNone(source)
            self.assertIsNotNone(tombstone)
            self.assertTrue(source.is_file())
            self.assertTrue(tombstone.is_file())
            self.assertNotIn("B9-previous-unlink-pre", trace)

    def test_recreated_workspace_source_after_rename_is_rejected_before_tombstone_rmdir(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            make_rotation_state_directory(state_dir)
            provenance = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            config, fake_logrotate = self._rotation_fixture(root)
            authority = self._authority_fixture(
                root, state_dir, config, provenance, fake_logrotate
            )
            trace: list[str] = []
            source: Path | None = None
            tombstone: Path | None = None

            def recreate_workspace_source(label: str) -> None:
                nonlocal source, tombstone
                if label != "B9-workspace-rename-post" or source is not None:
                    return
                records = [
                    json.loads(line)
                    for line in (state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME).read_bytes().splitlines()
                ]
                workspace = records[-1]["workspace"]
                source = Path(workspace["path"])
                tombstone = state_dir / (
                    f".cleanup-{source.name}-{workspace['dev']}-{workspace['ino']}"
                )
                source.mkdir(mode=0o700)

            with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                CHECKER_MODULE.run_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    barrier_hook=recreate_workspace_source,
                    barrier_trace=trace,
                    **authority,
                )

            self.assertIsNotNone(source)
            self.assertIsNotNone(tombstone)
            self.assertTrue(source.is_dir())
            self.assertTrue(tombstone.is_dir())
            self.assertNotIn("B9-workspace-rmdir-pre", trace)

    def test_existing_previous_tombstone_reentry_binds_source_absence_before_unlink(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            make_rotation_state_directory(state_dir)
            provenance = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            config, fake_logrotate = self._rotation_fixture(root)
            authority = self._authority_fixture(
                root, state_dir, config, provenance, fake_logrotate
            )
            CHECKER_MODULE.run_rotation_wrapper(
                state_dir=state_dir,
                operation_id=self.operation_id,
                config=config,
                logrotate=fake_logrotate,
                lock_path=root / "rotation.lock",
                **authority,
            )
            with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                CHECKER_MODULE.run_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    fault_after_phase="after-previous-tombstone",
                    **authority,
                )
            tail = json.loads(
                (state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME).read_bytes().splitlines()[-1]
            )
            workspace = Path(tail["workspace"]["path"])
            old_status = tail["old_status"]
            source = workspace / "previous-status"
            tombstone = workspace / (
                f".cleanup-previous-{old_status['dev']}-{old_status['ino']}"
            )
            trace: list[str] = []

            def recreate_source_before_unlink(label: str) -> None:
                if label == "B9-previous-unlink-pre" and not source.exists():
                    source.write_bytes(tombstone.read_bytes())
                    source.chmod(0o600)

            with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                CHECKER_MODULE.recover_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    barrier_hook=recreate_source_before_unlink,
                    barrier_trace=trace,
                    **authority,
                )
            self.assertTrue(source.is_file())
            self.assertTrue(tombstone.is_file())
            self.assertNotIn("B9-previous-unlink-post", trace)

    def test_existing_workspace_tombstone_reentry_binds_source_absence_before_rmdir(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            make_rotation_state_directory(state_dir)
            provenance = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            config, fake_logrotate = self._rotation_fixture(root)
            authority = self._authority_fixture(
                root, state_dir, config, provenance, fake_logrotate
            )
            with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                CHECKER_MODULE.run_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    fault_after_phase="after-workspace-tombstone",
                    **authority,
                )
            tail = json.loads(
                (state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME).read_bytes().splitlines()[-1]
            )
            workspace = tail["workspace"]
            source = Path(workspace["path"])
            tombstone = state_dir / (
                f".cleanup-{source.name}-{workspace['dev']}-{workspace['ino']}"
            )
            trace: list[str] = []

            def recreate_source_before_rmdir(label: str) -> None:
                if label == "B9-workspace-rmdir-pre" and not source.exists():
                    source.mkdir(mode=0o700)

            with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                CHECKER_MODULE.recover_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    barrier_hook=recreate_source_before_rmdir,
                    barrier_trace=trace,
                    **authority,
                )
            self.assertTrue(source.is_dir())
            self.assertTrue(tombstone.is_dir())
            self.assertNotIn("B9-workspace-rmdir-post", trace)

    def test_b10_rechecks_exact_status_absence_and_identity(self) -> None:
        for status_mode in ("absent", "present"):
            with self.subTest(status=status_mode), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                state_dir = root / "state"
                make_rotation_state_directory(state_dir)
                provenance = CHECKER_MODULE.initialize_rotation_provenance(
                    state_dir, self.operation_id, state_dir
                )
                config, fake_logrotate = self._rotation_fixture(root)
                authority = self._authority_fixture(
                    root, state_dir, config, provenance, fake_logrotate
                )
                if status_mode == "present":
                    CHECKER_MODULE.run_rotation_wrapper(
                        state_dir=state_dir,
                        operation_id=self.operation_id,
                        config=config,
                        logrotate=fake_logrotate,
                        lock_path=root / "rotation.lock",
                        **authority,
                    )
                status = state_dir / CHECKER_MODULE.ROTATION_STATUS_NAME
                injected = False

                def mutate_status_at_b10(label: str) -> None:
                    nonlocal injected
                    if label != "B10-snapshot" or injected:
                        return
                    injected = True
                    replacement = state_dir / "replacement-b10-status"
                    replacement.write_bytes(
                        status.read_bytes() if status.exists() else b"unexpected\n"
                    )
                    replacement.chmod(0o600)
                    os.replace(replacement, status)

                with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                    CHECKER_MODULE.recover_rotation_wrapper(
                        state_dir=state_dir,
                        operation_id=self.operation_id,
                        config=config,
                        logrotate=fake_logrotate,
                        lock_path=root / "rotation.lock",
                        barrier_hook=mutate_status_at_b10,
                        **authority,
                    )
                self.assertTrue(injected)

    def test_snapshot_final_acceptance_rechecks_status_after_ledger_read(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            make_rotation_state_directory(state_dir)
            provenance = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            config, fake_logrotate = self._rotation_fixture(root)
            authority = self._authority_fixture(
                root, state_dir, config, provenance, fake_logrotate
            )
            CHECKER_MODULE.run_rotation_wrapper(
                state_dir=state_dir,
                operation_id=self.operation_id,
                config=config,
                logrotate=fake_logrotate,
                lock_path=root / "rotation.lock",
                **authority,
            )
            ledger = state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME
            ledger_inode = ledger.stat().st_ino
            status = state_dir / CHECKER_MODULE.ROTATION_STATUS_NAME
            real_pread_all = CHECKER_MODULE._pread_all
            armed = False
            ledger_reads = 0
            injected = False

            def arm_after_b10(label: str) -> None:
                nonlocal armed
                if label == "B10-snapshot":
                    armed = True

            def replace_status_during_result_ledger_read(descriptor: int) -> bytes:
                nonlocal ledger_reads, injected
                if armed and os.fstat(descriptor).st_ino == ledger_inode:
                    ledger_reads += 1
                    if ledger_reads == 2 and not injected:
                        injected = True
                        replacement = state_dir / "replacement-final-status"
                        replacement.write_bytes(status.read_bytes())
                        replacement.chmod(0o600)
                        os.replace(replacement, status)
                return real_pread_all(descriptor)

            CHECKER_MODULE._pread_all = replace_status_during_result_ledger_read
            try:
                with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                    CHECKER_MODULE.recover_rotation_wrapper(
                        state_dir=state_dir,
                        operation_id=self.operation_id,
                        config=config,
                        logrotate=fake_logrotate,
                        lock_path=root / "rotation.lock",
                        barrier_hook=arm_after_b10,
                        **authority,
                    )
            finally:
                CHECKER_MODULE._pread_all = real_pread_all
            self.assertTrue(injected)

    def test_every_persisted_rotation_barrier_is_reentrant(self) -> None:
        barriers = (
            "prepared",
            "captured",
            "after-old-move",
            "after-new-move",
            "committed-before-cleanup",
            "after-previous-tombstone",
            "after-workspace-tombstone",
        )
        for barrier in barriers:
            with self.subTest(barrier=barrier), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                state_dir = root / "state"
                make_rotation_state_directory(state_dir)
                anchor = CHECKER_MODULE.initialize_rotation_provenance(
                    state_dir, self.operation_id, state_dir
                )
                config, fake_logrotate = self._rotation_fixture(root)
                authority = self._authority_fixture(
                    root, state_dir, config, anchor, fake_logrotate
                )
                # Cleanup barriers and the old-status move require an existing status inode.
                if barrier in {
                    "after-old-move",
                    "after-new-move",
                    "after-previous-tombstone",
                    "after-workspace-tombstone",
                }:
                    CHECKER_MODULE.run_rotation_wrapper(
                        state_dir=state_dir,
                        operation_id=self.operation_id,
                        config=config,
                        logrotate=fake_logrotate,
                        lock_path=root / "rotation.lock",
                        **authority,
                    )
                with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                    CHECKER_MODULE.run_rotation_wrapper(
                        state_dir=state_dir,
                        operation_id=self.operation_id,
                        config=config,
                        logrotate=fake_logrotate,
                        lock_path=root / "rotation.lock",
                        fault_after_phase=barrier,
                        **authority,
                    )
                recovered = CHECKER_MODULE.run_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    **authority,
                )
                verified = CHECKER_MODULE.verify_rotation_provenance(
                    state_dir, self.operation_id, anchor
                )
                self.assertEqual(recovered["tail_record_sha256"], verified["tail_record_sha256"])
                self.assertFalse(any(path.name.startswith("generation-") for path in state_dir.iterdir()))
                self.assertFalse(any(path.name.startswith(".cleanup-") for path in state_dir.iterdir()))

    def test_unpersisted_b2_b3_workspace_windows_remain_committed_and_fail_closed(self) -> None:
        for barrier in ("B2-workspace-create-post", "B3-prepared-append-pre"):
            with self.subTest(barrier=barrier), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                state_dir = root / "state"
                make_rotation_state_directory(state_dir)
                provenance = CHECKER_MODULE.initialize_rotation_provenance(
                    state_dir, self.operation_id, state_dir
                )
                config = root / "rotate.conf"
                config.write_text("fixture\n", encoding="utf-8")
                calls = root / "rotation-calls"
                fake_logrotate = root / "counting-logrotate.py"
                fake_logrotate.write_text(
                    "#!/usr/bin/env python3\n"
                    "import os, pathlib, sys\n"
                    f"with pathlib.Path({str(calls)!r}).open('a') as handle:\n"
                    "    handle.write('called\\n'); handle.flush(); os.fsync(handle.fileno())\n"
                    + FD_AWARE_APPEND_STATUS,
                    encoding="utf-8",
                )
                fake_logrotate.chmod(0o755)
                authority = self._authority_fixture(
                    root, state_dir, config, provenance, fake_logrotate
                )

                def stop_at_barrier(label: str) -> None:
                    if label == barrier:
                        raise CHECKER_MODULE.RotationProvenanceError("barrier stop")

                with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                    CHECKER_MODULE.run_rotation_wrapper(
                        state_dir=state_dir,
                        operation_id=self.operation_id,
                        config=config,
                        logrotate=fake_logrotate,
                        lock_path=root / "rotation.lock",
                        barrier_hook=stop_at_barrier,
                        **authority,
                    )
                self.assertFalse(calls.exists())
                for runner in (
                    CHECKER_MODULE.run_rotation_wrapper,
                    CHECKER_MODULE.recover_rotation_wrapper,
                ):
                    with self.assertRaisesRegex(
                        CHECKER_MODULE.RotationProvenanceError,
                        "ambiguous state directory residue",
                    ):
                        runner(
                            state_dir=state_dir,
                            operation_id=self.operation_id,
                            config=config,
                            logrotate=fake_logrotate,
                            lock_path=root / "rotation.lock",
                            **authority,
                        )
                self.assertFalse(calls.exists())
                records = [
                    json.loads(line)
                    for line in (state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME).read_bytes().splitlines()
                ]
                self.assertEqual(records[-1]["phase"], "committed")

    def test_each_durable_phase_rejects_unknown_state_directory_entries_before_work(self) -> None:
        for phase, fault in (("prepared", "prepared"), ("captured", "captured")):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                state_dir = root / "state"
                make_rotation_state_directory(state_dir)
                provenance = CHECKER_MODULE.initialize_rotation_provenance(
                    state_dir, self.operation_id, state_dir
                )
                config = root / "rotate.conf"
                config.write_text("fixture\n", encoding="utf-8")
                calls = root / "rotation-calls"
                fake_logrotate = root / "counting-logrotate.py"
                fake_logrotate.write_text(
                    "#!/usr/bin/env python3\n"
                    "import os, pathlib, sys\n"
                    f"with pathlib.Path({str(calls)!r}).open('a') as handle:\n"
                    "    handle.write('called\\n'); handle.flush(); os.fsync(handle.fileno())\n"
                    + FD_AWARE_APPEND_STATUS,
                    encoding="utf-8",
                )
                fake_logrotate.chmod(0o755)
                authority = self._authority_fixture(
                    root, state_dir, config, provenance, fake_logrotate
                )
                with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                    CHECKER_MODULE.run_rotation_wrapper(
                        state_dir=state_dir,
                        operation_id=self.operation_id,
                        config=config,
                        logrotate=fake_logrotate,
                        lock_path=root / "rotation.lock",
                        fault_after_phase=fault,
                        **authority,
                    )
                calls_before = calls.read_text().splitlines() if calls.exists() else []
                unexpected = state_dir / "foreign-residue"
                unexpected.mkdir()

                with self.assertRaisesRegex(
                    CHECKER_MODULE.RotationProvenanceError,
                    "ambiguous state directory residue",
                ):
                    CHECKER_MODULE.recover_rotation_wrapper(
                        state_dir=state_dir,
                        operation_id=self.operation_id,
                        config=config,
                        logrotate=fake_logrotate,
                        lock_path=root / "rotation.lock",
                        **authority,
                    )

                self.assertTrue(unexpected.is_dir())
                self.assertEqual(
                    calls.read_text().splitlines() if calls.exists() else [],
                    calls_before,
                )
                records = [
                    json.loads(line)
                    for line in (state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME).read_bytes().splitlines()
                ]
                self.assertEqual(records[-1]["phase"], phase)

    def test_committed_cleanup_rejects_recorded_workspace_renamed_outside_allowlist(self) -> None:
        for runner in (
            CHECKER_MODULE.run_rotation_wrapper,
            CHECKER_MODULE.recover_rotation_wrapper,
        ):
            with self.subTest(runner=runner.__name__), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                state_dir = root / "state"
                make_rotation_state_directory(state_dir)
                provenance = CHECKER_MODULE.initialize_rotation_provenance(
                    state_dir, self.operation_id, state_dir
                )
                config, fake_logrotate = self._rotation_fixture(root)
                authority = self._authority_fixture(
                    root, state_dir, config, provenance, fake_logrotate
                )
                with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                    CHECKER_MODULE.run_rotation_wrapper(
                        state_dir=state_dir,
                        operation_id=self.operation_id,
                        config=config,
                        logrotate=fake_logrotate,
                        lock_path=root / "rotation.lock",
                        fault_after_phase="committed-before-cleanup",
                        **authority,
                    )
                records = [
                    json.loads(line)
                    for line in (state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME).read_bytes().splitlines()
                ]
                tail = records[-1]
                self.assertEqual(tail["phase"], "committed")
                workspace = Path(tail["workspace"]["path"])
                renamed = state_dir / "renamed-workspace-residue"
                os.rename(workspace, renamed)

                with self.assertRaisesRegex(
                    CHECKER_MODULE.RotationProvenanceError,
                    "ambiguous state directory residue",
                ):
                    CHECKER_MODULE.verify_rotation_provenance(
                        state_dir, self.operation_id, provenance
                    )
                with self.assertRaisesRegex(
                    CHECKER_MODULE.RotationProvenanceError,
                    "ambiguous state directory residue",
                ):
                    runner(
                        state_dir=state_dir,
                        operation_id=self.operation_id,
                        config=config,
                        logrotate=fake_logrotate,
                        lock_path=root / "rotation.lock",
                        **authority,
                    )

                self.assertTrue(renamed.is_dir())
                self.assertFalse(workspace.exists())
                final_records = [
                    json.loads(line)
                    for line in (state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME).read_bytes().splitlines()
                ]
                self.assertEqual(final_records[-1]["record_sha256"], tail["record_sha256"])

    def test_unpersisted_b4_b5_output_windows_remain_prepared_and_never_rerun_child(self) -> None:
        for barrier in ("B4-child-post", "B5-captured-append-pre"):
            with self.subTest(barrier=barrier), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                state_dir = root / "state"
                make_rotation_state_directory(state_dir)
                provenance = CHECKER_MODULE.initialize_rotation_provenance(
                    state_dir, self.operation_id, state_dir
                )
                config = root / "rotate.conf"
                config.write_text("fixture\n", encoding="utf-8")
                calls = root / "rotation-calls"
                fake_logrotate = root / "counting-logrotate.py"
                fake_logrotate.write_text(
                    "#!/usr/bin/env python3\n"
                    "import os, pathlib, sys\n"
                    f"with pathlib.Path({str(calls)!r}).open('a') as handle:\n"
                    "    handle.write('called\\n'); handle.flush(); os.fsync(handle.fileno())\n"
                    + FD_AWARE_APPEND_STATUS,
                    encoding="utf-8",
                )
                fake_logrotate.chmod(0o755)
                authority = self._authority_fixture(
                    root, state_dir, config, provenance, fake_logrotate
                )

                def stop_at_barrier(label: str) -> None:
                    if label == barrier:
                        raise CHECKER_MODULE.RotationProvenanceError("barrier stop")

                with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                    CHECKER_MODULE.run_rotation_wrapper(
                        state_dir=state_dir,
                        operation_id=self.operation_id,
                        config=config,
                        logrotate=fake_logrotate,
                        lock_path=root / "rotation.lock",
                        barrier_hook=stop_at_barrier,
                        **authority,
                    )
                calls_before = calls.read_text().splitlines()
                self.assertEqual(calls_before, ["called"])
                for runner in (
                    CHECKER_MODULE.run_rotation_wrapper,
                    CHECKER_MODULE.recover_rotation_wrapper,
                ):
                    with self.assertRaisesRegex(
                        CHECKER_MODULE.RotationProvenanceError,
                        "ambiguous prepared output",
                    ):
                        runner(
                            state_dir=state_dir,
                            operation_id=self.operation_id,
                            config=config,
                            logrotate=fake_logrotate,
                            lock_path=root / "rotation.lock",
                            **authority,
                        )
                self.assertEqual(calls.read_text().splitlines(), calls_before)
                records = [
                    json.loads(line)
                    for line in (state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME).read_bytes().splitlines()
                ]
                self.assertEqual(records[-1]["phase"], "prepared")

    def test_recover_only_accepts_exact_c0_c1_c2_without_rerunning_child(self) -> None:
        for state_name, fault in (
            ("C0", "captured"),
            ("C1", "after-old-move"),
            ("C2", "after-new-move"),
        ):
            with self.subTest(state=state_name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                state_dir = root / "state"
                make_rotation_state_directory(state_dir)
                provenance = CHECKER_MODULE.initialize_rotation_provenance(
                    state_dir, self.operation_id, state_dir
                )
                config = root / "rotate.conf"
                config.write_text("fixture\n", encoding="utf-8")
                calls = root / "rotation-calls"
                fake_logrotate = root / "counting-logrotate.py"
                fake_logrotate.write_text(
                    "#!/usr/bin/env python3\n"
                    "import os, pathlib, sys\n"
                    f"with pathlib.Path({str(calls)!r}).open('a') as handle:\n"
                    "    handle.write('called\\n'); handle.flush(); os.fsync(handle.fileno())\n"
                    + FD_AWARE_APPEND_STATUS,
                    encoding="utf-8",
                )
                fake_logrotate.chmod(0o755)
                authority = self._authority_fixture(
                    root, state_dir, config, provenance, fake_logrotate
                )
                CHECKER_MODULE.run_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    **authority,
                )
                with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                    CHECKER_MODULE.run_rotation_wrapper(
                        state_dir=state_dir,
                        operation_id=self.operation_id,
                        config=config,
                        logrotate=fake_logrotate,
                        lock_path=root / "rotation.lock",
                        fault_after_phase=fault,
                        **authority,
                    )
                calls_before = calls.read_text().splitlines()
                recovered = CHECKER_MODULE.recover_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    **authority,
                )
                repeated = CHECKER_MODULE.recover_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    **authority,
                )
                self.assertEqual(calls.read_text().splitlines(), calls_before)
                self.assertEqual(recovered["generation"], 2)
                self.assertEqual(
                    repeated["tail_record_sha256"], recovered["tail_record_sha256"]
                )

    def test_recover_only_rejects_all_captured_inode_ambiguities_without_child(self) -> None:
        cases = (
            ("C0", "captured", "status"),
            ("C0", "captured", "candidate"),
            ("C0", "captured", "previous_add"),
            ("C1", "after-old-move", "previous"),
            ("C1", "after-old-move", "candidate"),
            ("C1", "after-old-move", "status_add"),
            ("C2", "after-new-move", "status"),
            ("C2", "after-new-move", "previous"),
            ("C2", "after-new-move", "candidate_add"),
        )
        for state_name, fault, mutation in cases:
            with self.subTest(state=state_name, mutation=mutation), \
                    tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                state_dir = root / "state"
                make_rotation_state_directory(state_dir)
                provenance = CHECKER_MODULE.initialize_rotation_provenance(
                    state_dir, self.operation_id, state_dir
                )
                config = root / "rotate.conf"
                config.write_text("fixture\n", encoding="utf-8")
                calls = root / "rotation-calls"
                fake_logrotate = root / "counting-logrotate.py"
                fake_logrotate.write_text(
                    "#!/usr/bin/env python3\n"
                    "import os, pathlib, sys\n"
                    f"with pathlib.Path({str(calls)!r}).open('a') as handle:\n"
                    "    handle.write('called\\n'); handle.flush(); os.fsync(handle.fileno())\n"
                    + FD_AWARE_APPEND_STATUS,
                    encoding="utf-8",
                )
                fake_logrotate.chmod(0o755)
                authority = self._authority_fixture(
                    root, state_dir, config, provenance, fake_logrotate
                )
                CHECKER_MODULE.run_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    **authority,
                )
                with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                    CHECKER_MODULE.run_rotation_wrapper(
                        state_dir=state_dir,
                        operation_id=self.operation_id,
                        config=config,
                        logrotate=fake_logrotate,
                        lock_path=root / "rotation.lock",
                        fault_after_phase=fault,
                        **authority,
                    )
                workspace = state_dir / "generation-00000000000000000002"
                paths = {
                    "status": state_dir / "status",
                    "candidate": workspace / "status",
                    "previous": workspace / "previous-status",
                }
                if mutation.endswith("_add"):
                    if mutation == "previous_add":
                        victim = paths["previous"]
                        source = paths["status"]
                    elif mutation == "status_add":
                        victim = paths["status"]
                        source = paths["previous"]
                    else:
                        victim = paths["candidate"]
                        source = paths["status"]
                    victim.write_bytes(source.read_bytes())
                    victim.chmod(0o600)
                else:
                    victim = paths[mutation]
                    replacement = victim.with_name(f"replacement-{mutation}")
                    replacement.write_bytes(victim.read_bytes())
                    replacement.chmod(0o600)
                    os.replace(replacement, victim)
                calls_before = calls.read_text().splitlines()
                with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                    CHECKER_MODULE.recover_rotation_wrapper(
                        state_dir=state_dir,
                        operation_id=self.operation_id,
                        config=config,
                        logrotate=fake_logrotate,
                        lock_path=root / "rotation.lock",
                        **authority,
                    )
                self.assertEqual(calls.read_text().splitlines(), calls_before)
                records = [
                    json.loads(line)
                    for line in (state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME).read_bytes().splitlines()
                ]
                self.assertEqual(records[-1]["phase"], "captured")

    def test_record_schema_rejects_extra_or_missing_authority(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_dir = Path(temporary) / "state"
            make_rotation_state_directory(state_dir)
            anchor = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            ledger = state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME
            records = [json.loads(line) for line in ledger.read_bytes().splitlines()]
            descriptor = os.open(ledger, os.O_WRONLY | os.O_APPEND)
            try:
                CHECKER_MODULE._append_record(
                    descriptor,
                    {
                        "schema": 1,
                        "operation_id": self.operation_id,
                        "generation": 1,
                        "phase": "prepared",
                        "previous_record_sha256": records[-1]["record_sha256"],
                        "unexpected_authority": {"adopt": True},
                    },
                )
            finally:
                os.close(descriptor)

            with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                CHECKER_MODULE.verify_rotation_provenance(state_dir, self.operation_id, anchor)

    def test_non_object_genesis_json_fails_closed_as_provenance_error(self) -> None:
        for poisoned in (None, [], "scalar", 7):
            with self.subTest(value=poisoned), tempfile.TemporaryDirectory() as temporary:
                state_dir = Path(temporary) / "state"
                make_rotation_state_directory(state_dir)
                anchor = CHECKER_MODULE.initialize_rotation_provenance(
                    state_dir, self.operation_id, state_dir
                )
                ledger = state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME
                ledger.write_bytes(CHECKER_MODULE._canonical_json(poisoned) + b"\n")

                with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                    CHECKER_MODULE.verify_rotation_provenance(
                        state_dir, self.operation_id, anchor
                    )

    def test_genesis_ledger_append_retries_partial_writes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_dir = Path(temporary) / "state"
            make_rotation_state_directory(state_dir)
            real_write = CHECKER_MODULE.os.write

            def partial_write(descriptor: int, payload: bytes | memoryview) -> int:
                view = memoryview(payload)
                return real_write(descriptor, view[: max(1, len(view) // 2)])

            CHECKER_MODULE.os.write = partial_write
            try:
                anchor = CHECKER_MODULE.initialize_rotation_provenance(
                    state_dir, self.operation_id, state_dir
                )
            finally:
                CHECKER_MODULE.os.write = real_write
            snapshot = CHECKER_MODULE.verify_rotation_provenance(
                state_dir, self.operation_id, anchor
            )
            self.assertEqual(snapshot["generation"], 0)

    def test_record_schema_rejects_boolean_values_masquerading_as_integers(self) -> None:
        mutations = (
            ("schema", True),
            ("generation", False),
            ("directory.uid", False),
            ("directory.dev", True),
            ("ledger.ino", True),
        )
        for field, poisoned in mutations:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as temporary:
                state_dir = Path(temporary) / "state"
                make_rotation_state_directory(state_dir)
                anchor = CHECKER_MODULE.initialize_rotation_provenance(
                    state_dir, self.operation_id, state_dir
                )
                ledger = state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME
                record = json.loads(ledger.read_text(encoding="utf-8"))
                target = record
                parts = field.split(".")
                for part in parts[:-1]:
                    target = target[part]
                target[parts[-1]] = poisoned
                record = CHECKER_MODULE._record_with_hash(record)

                with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                    CHECKER_MODULE._validate_records(
                        state_dir, self.operation_id, os.lstat(ledger), [record]
                    )

    def test_prepared_schema_binds_candidate_initial_bytes_to_old_status(self) -> None:
        for old_status_present in (False, True):
            for field in ("sha256", "size"):
                with self.subTest(old=old_status_present, field=field), \
                        tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    state_dir = root / "state"
                    make_rotation_state_directory(state_dir)
                    provenance = CHECKER_MODULE.initialize_rotation_provenance(
                        state_dir, self.operation_id, state_dir
                    )
                    config, fake_logrotate = self._rotation_fixture(root)
                    authority = self._authority_fixture(
                        root, state_dir, config, provenance, fake_logrotate
                    )
                    if old_status_present:
                        CHECKER_MODULE.run_rotation_wrapper(
                            state_dir=state_dir,
                            operation_id=self.operation_id,
                            config=config,
                            logrotate=fake_logrotate,
                            lock_path=root / "rotation.lock",
                            **authority,
                        )
                    with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                        CHECKER_MODULE.run_rotation_wrapper(
                            state_dir=state_dir,
                            operation_id=self.operation_id,
                            config=config,
                            logrotate=fake_logrotate,
                            lock_path=root / "rotation.lock",
                            fault_after_phase="prepared",
                            **authority,
                        )
                    ledger = state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME
                    records = [json.loads(line) for line in ledger.read_bytes().splitlines()]
                    candidate = records[-1]["candidate_initial"]
                    if field == "sha256":
                        candidate[field] = (
                            "0" * 64 if candidate[field] != "0" * 64 else "1" * 64
                        )
                    else:
                        candidate[field] += 1
                    records[-1] = CHECKER_MODULE._record_with_hash(records[-1])
                    with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                        CHECKER_MODULE._validate_records(
                            state_dir,
                            self.operation_id,
                            os.lstat(ledger),
                            records,
                        )

    def test_authority_directory_and_provenance_reject_non_integer_numbers(self) -> None:
        mutations = (
            ("directory.uid", lambda authority: float(authority["directory"]["uid"])),
            ("directory.dev", lambda authority: float(authority["directory"]["dev"])),
            ("provenance.gid", lambda authority: float(authority["provenance"]["gid"])),
            ("provenance.ino", lambda authority: float(authority["provenance"]["ino"])),
        )
        for field, poisoned_value in mutations:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                state_dir = root / "state"
                make_rotation_state_directory(state_dir)
                provenance = CHECKER_MODULE.initialize_rotation_provenance(
                    state_dir, self.operation_id, state_dir
                )
                config, fake_logrotate = self._rotation_fixture(root)
                arguments = self._authority_fixture(
                    root, state_dir, config, provenance, fake_logrotate
                )
                authority_path = arguments["authority_path"]
                authority = json.loads(authority_path.read_bytes())
                target = authority
                parts = field.split(".")
                for part in parts[:-1]:
                    target = target[part]
                target[parts[-1]] = poisoned_value(authority)
                authority_path.write_bytes(
                    CHECKER_MODULE._canonical_json(authority) + b"\n"
                )
                authority_path.chmod(0o600)
                anchor_identity = CHECKER_MODULE._stable_regular_identity(authority_path)
                arguments["anchor_expected"] = {
                    key: anchor_identity[key]
                    for key in ("path", "sha256", "dev", "ino")
                }

                with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                    CHECKER_MODULE.run_rotation_wrapper(
                        state_dir=state_dir,
                        operation_id=self.operation_id,
                        config=config,
                        logrotate=fake_logrotate,
                        lock_path=root / "rotation.lock",
                        **arguments,
                    )

    def test_failed_or_killed_logrotate_output_is_never_adopted(self) -> None:
        for exit_mode in ("nonzero", "sigkill"):
            with self.subTest(exit_mode=exit_mode), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                state_dir = root / "state"
                make_rotation_state_directory(state_dir)
                anchor = CHECKER_MODULE.initialize_rotation_provenance(
                    state_dir, self.operation_id, state_dir
                )
                config = root / "rotate.conf"
                config.write_text("fixture\n", encoding="utf-8")
                fake_logrotate = root / "poison-logrotate.py"
                ending = "raise SystemExit(9)" if exit_mode == "nonzero" else "os.kill(os.getpid(), 9)"
                fake_logrotate.write_text(
                    "#!/usr/bin/env python3\n"
                    "import os, pathlib, sys\n"
                    "state_value = sys.argv[sys.argv.index('-s') + 1]\n"
                    "if state_value.startswith('fd:'):\n"
                    "    descriptor = int(state_value.split(':', 1)[1])\n"
                    "    os.ftruncate(descriptor, 0); os.pwrite(descriptor, b'POISON\\n', 0); os.fsync(descriptor)\n"
                    "else:\n"
                    "    pathlib.Path(state_value).write_text('POISON\\n')\n"
                    f"{ending}\n",
                    encoding="utf-8",
                )
                fake_logrotate.chmod(0o755)
                authority = self._authority_fixture(
                    root, state_dir, config, anchor, fake_logrotate
                )
                for _ in range(2):
                    with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                        CHECKER_MODULE.run_rotation_wrapper(
                            state_dir=state_dir,
                            operation_id=self.operation_id,
                            config=config,
                            logrotate=fake_logrotate,
                            lock_path=root / "rotation.lock",
                            **authority,
                        )
                self.assertFalse((state_dir / CHECKER_MODULE.ROTATION_STATUS_NAME).exists())
                records = [
                    json.loads(line)
                    for line in (state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME).read_bytes().splitlines()
                ]
                self.assertEqual(records[-1]["phase"], "prepared")

    def test_successful_logrotate_parent_cannot_leave_a_writing_child(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            state_dir = root / "state"
            make_rotation_state_directory(state_dir)
            provenance = CHECKER_MODULE.initialize_rotation_provenance(
                state_dir, self.operation_id, state_dir
            )
            config = root / "rotate.conf"
            config.write_text("fixture\n", encoding="utf-8")
            fake_logrotate = root / "child-logrotate.py"
            fake_logrotate.write_text(
                "#!/usr/bin/env python3\n"
                "import pathlib, subprocess, sys\n"
                "state_value = sys.argv[sys.argv.index('-s') + 1]\n"
                "child = \"import time; time.sleep(2)\" if state_value.startswith('fd:') else \"import pathlib,time; p=pathlib.Path(\" + repr(state_value) + \" ); f=p.open('ab', buffering=0); time.sleep(2); f.write(b'LATE\\\\n'); f.close()\"\n"
                "subprocess.Popen([sys.executable, '-c', child])\n",
                encoding="utf-8",
            )
            fake_logrotate.chmod(0o755)
            authority = self._authority_fixture(
                root, state_dir, config, provenance, fake_logrotate
            )

            with self.assertRaises(CHECKER_MODULE.RotationProvenanceError):
                CHECKER_MODULE.run_rotation_wrapper(
                    state_dir=state_dir,
                    operation_id=self.operation_id,
                    config=config,
                    logrotate=fake_logrotate,
                    lock_path=root / "rotation.lock",
                    **authority,
                )
            records = [
                json.loads(line)
                for line in (state_dir / CHECKER_MODULE.ROTATION_LEDGER_NAME).read_bytes().splitlines()
            ]
            self.assertEqual(records[-1]["phase"], "prepared")

    @staticmethod
    def _rotation_fixture(root: Path) -> tuple[Path, Path]:
        config = root / "rotate.conf"
        config.write_text("fixture\n", encoding="utf-8")
        fake_logrotate = root / "fake-logrotate.py"
        fake_logrotate.write_text(
            "#!/usr/bin/env python3\n"
            "import os, pathlib, sys\n"
            + FD_AWARE_APPEND_STATUS,
            encoding="utf-8",
        )
        fake_logrotate.chmod(0o755)
        return config, fake_logrotate


if __name__ == "__main__":
    unittest.main()
