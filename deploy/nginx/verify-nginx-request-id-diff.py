#!/usr/bin/env python3
"""Verify that an nginx site changed only by approved request-id header lines."""

from pathlib import Path
import re
import sys


HEADER_LINE = re.compile(
    r"(?m)^[ \t]*proxy_set_header[ \t]+X-Request-Id[ \t]+\$request_id;[ \t]*\r?\n"
)


def main(arguments: list[str]) -> int:
    if len(arguments) != 3:
        print("ERROR arguments=1")
        return 2

    try:
        expected = int(arguments[2])
        if expected < 1:
            raise ValueError("invalid expected count")
        before = Path(arguments[0]).read_text(encoding="utf-8")
        after = Path(arguments[1]).read_text(encoding="utf-8")
    except (OSError, UnicodeError, ValueError):
        print("ERROR input=1")
        return 2

    stripped, inserted = HEADER_LINE.subn("", after)
    unchanged = stripped == before
    if inserted == expected and unchanged:
        print(f"OK inserted={inserted} unchanged_remainder=1")
        return 0

    print(f"FAIL inserted={inserted} unchanged_remainder={int(unchanged)}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
