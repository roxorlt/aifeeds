#!/usr/bin/env python3

from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest


INSERTER = Path(__file__).with_name("insert-nginx-request-id.py")


def run_inserter(config: str, expected: int) -> tuple[subprocess.CompletedProcess[str], str]:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as handle:
        handle.write(config)
        path = Path(handle.name)
    try:
        result = subprocess.run(
            [sys.executable, str(INSERTER), str(path), str(expected)],
            capture_output=True,
            text=True,
            check=False,
        )
        output = path.read_text(encoding="utf-8")
        return result, output
    finally:
        path.unlink(missing_ok=True)


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


class RequestIdInserterTests(unittest.TestCase):
    def test_inserts_one_header_before_each_proxy_pass(self) -> None:
        result, output = run_inserter(BASELINE, 2)

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout, "OK inserted=2\n")
        self.assertEqual(output.count("proxy_set_header X-Request-Id $request_id;"), 2)
        self.assertNotIn("private-one", result.stdout + result.stderr)

    def test_rejects_existing_request_id_without_writing(self) -> None:
        existing = BASELINE.replace(
            "        proxy_pass https://private-one.example;",
            "        proxy_set_header X-Request-Id $request_id;\n"
            "        proxy_pass https://private-one.example;",
        )
        result, output = run_inserter(existing, 2)

        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertEqual(result.stdout, "ERROR existing_request_id=1\n")
        self.assertEqual(output, existing)

    def test_rejects_proxy_count_drift_without_writing(self) -> None:
        result, output = run_inserter(BASELINE, 7)

        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertEqual(result.stdout, "ERROR proxy_pass=2 expected=7\n")
        self.assertEqual(output, BASELINE)


if __name__ == "__main__":
    unittest.main()
