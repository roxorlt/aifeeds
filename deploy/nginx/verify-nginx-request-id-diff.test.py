#!/usr/bin/env python3

from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest


VERIFIER = Path(__file__).with_name("verify-nginx-request-id-diff.py")


def run_verifier(before: str, after: str, expected: int = 2) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        before_path = root / "before.conf"
        after_path = root / "after.conf"
        before_path.write_text(before, encoding="utf-8")
        after_path.write_text(after, encoding="utf-8")
        return subprocess.run(
            [sys.executable, str(VERIFIER), str(before_path), str(after_path), str(expected)],
            capture_output=True,
            text=True,
            check=False,
        )


BASELINE = textwrap.dedent(
    """\
    server {
        location /one {
            proxy_set_header Host one.example;
            proxy_pass https://private-one.example;
        }
        location /two {
            proxy_pass https://private-two.example;
        }
    }
    """
)


EXPECTED = BASELINE.replace(
    "        proxy_pass https://private-one.example;",
    "        proxy_set_header X-Request-Id $request_id;\n"
    "        proxy_pass https://private-one.example;",
).replace(
    "        proxy_pass https://private-two.example;",
    "        proxy_set_header X-Request-Id $request_id;\n"
    "        proxy_pass https://private-two.example;",
)


class SemanticDiffVerifierTests(unittest.TestCase):
    def test_accepts_only_the_expected_request_id_lines(self) -> None:
        result = run_verifier(BASELINE, EXPECTED)

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout, "OK inserted=2 unchanged_remainder=1\n")
        self.assertNotIn("private-one", result.stdout + result.stderr)

    def test_rejects_any_other_site_change(self) -> None:
        changed = EXPECTED.replace("Host one.example", "Host changed.example")
        result = run_verifier(BASELINE, changed)

        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertEqual(result.stdout, "FAIL inserted=2 unchanged_remainder=0\n")
        self.assertNotIn("changed.example", result.stdout + result.stderr)

    def test_rejects_wrong_header_count_or_value(self) -> None:
        missing = EXPECTED.replace(
            "        proxy_set_header X-Request-Id $request_id;\n",
            "",
            1,
        )
        wrong = EXPECTED.replace("$request_id", "unsafe-value", 1)

        self.assertEqual(run_verifier(BASELINE, missing).returncode, 1)
        self.assertEqual(run_verifier(BASELINE, wrong).returncode, 1)


if __name__ == "__main__":
    unittest.main()
