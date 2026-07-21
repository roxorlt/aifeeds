#!/usr/bin/env python3
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("systemctl-not-found-compat.py")
TARGET_ARGS = ["is-enabled", "aifeeds-performance-logrotate.timer"]


def load_module():
    if not SCRIPT.is_file():
        raise AssertionError(f"compatibility wrapper is missing: {SCRIPT}")
    spec = importlib.util.spec_from_file_location("systemctl_not_found_compat", SCRIPT)
    if spec is None or spec.loader is None:
        raise AssertionError(f"cannot load compatibility wrapper: {SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SystemctlNotFoundCompatTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_module() if SCRIPT.is_file() else None

    def require_module(self):
        self.assertIsNotNone(
            self.module,
            f"compatibility wrapper is missing: {SCRIPT}",
        )
        return self.module

    def test_wrapper_exists(self):
        self.assertTrue(SCRIPT.is_file(), f"compatibility wrapper is missing: {SCRIPT}")

    def run_target(self, exit_code, stdout=b"", stderr=b""):
        module = self.require_module()
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory) / "systemctl-real"
            fake.write_text(
                "#!/bin/sh\n"
                "printf '%s' \"$FAKE_STDOUT\"\n"
                "printf '%s' \"$FAKE_STDERR\" >&2\n"
                "exit \"$FAKE_RC\"\n",
                encoding="utf-8",
            )
            fake.chmod(0o700)
            output = io.BytesIO()
            error = io.BytesIO()
            environment = os.environ.copy()
            environment.update(
                FAKE_RC=str(exit_code),
                FAKE_STDOUT=stdout.decode("ascii"),
                FAKE_STDERR=stderr.decode("ascii"),
            )
            return_code = module.main(
                TARGET_ARGS,
                real_systemctl=str(fake),
                stdout=output,
                stderr=error,
                environment=environment,
            )
            return return_code, output.getvalue(), error.getvalue()

    def test_maps_exact_not_found_result_from_four_to_one(self):
        result = self.run_target(4, stdout=b"not-found\n")
        self.assertEqual(result, (1, b"not-found\n", b""))

    def test_preserves_nonmatching_stdout(self):
        result = self.run_target(4, stdout=b"failed\n")
        self.assertEqual(result, (4, b"failed\n", b""))

    def test_preserves_not_found_when_stderr_is_not_empty(self):
        result = self.run_target(4, stdout=b"not-found\n", stderr=b"warning\n")
        self.assertEqual(result, (4, b"not-found\n", b"warning\n"))

    def test_preserves_existing_disabled_result(self):
        result = self.run_target(1, stdout=b"disabled\n")
        self.assertEqual(result, (1, b"disabled\n", b""))

    def test_execs_every_other_command_without_capture_or_translation(self):
        module = self.require_module()
        captured = []

        def record_exec(path, argv, environment):
            captured.append((path, argv, environment))
            raise RuntimeError("exec intercepted")

        environment = {"PATH": "/hostile/path", "MARKER": "kept"}
        with self.assertRaisesRegex(RuntimeError, "exec intercepted"):
            module.main(
                ["is-enabled", "--quiet", "aifeeds-performance-logrotate.timer"],
                real_systemctl="/usr/bin/systemctl",
                environment=environment,
                execve=record_exec,
            )
        self.assertEqual(
            captured,
            [
                (
                    "/usr/bin/systemctl",
                    [
                        "/usr/bin/systemctl",
                        "is-enabled",
                        "--quiet",
                        "aifeeds-performance-logrotate.timer",
                    ],
                    environment,
                )
            ],
        )

    def test_production_real_systemctl_path_is_absolute_and_fixed(self):
        module = self.require_module()
        self.assertEqual(module.REAL_SYSTEMCTL, "/usr/bin/systemctl")


if __name__ == "__main__":
    unittest.main()
