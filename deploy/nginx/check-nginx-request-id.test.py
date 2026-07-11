#!/usr/bin/env python3

from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest


CHECKER = Path(__file__).with_name("check-nginx-request-id.py")


def run_checker(config: str, *arguments: str) -> subprocess.CompletedProcess[str]:
    command = [sys.executable, str(CHECKER), *(arguments or ("-",))]
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
            result = run_checker("", str(path))
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


if __name__ == "__main__":
    unittest.main()
