#!/usr/bin/env python3
"""Insert one request-id header before each line-oriented proxy_pass, fail closed."""

from pathlib import Path
import re
import sys


EXISTING_HEADER = re.compile(r"(?im)^\s*proxy_set_header\s+x-request-id\b")
PROXY_PASS = re.compile(r"(?m)^(?P<indent>[ \t]*)proxy_pass\s+")
HEADER = "proxy_set_header X-Request-Id $request_id;"


def main(arguments: list[str]) -> int:
    if len(arguments) != 2:
        print("ERROR arguments=1")
        return 2

    try:
        expected = int(arguments[1])
        if expected < 1:
            raise ValueError("invalid expected count")
        path = Path(arguments[0])
        source = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError, ValueError):
        print("ERROR input=1")
        return 2

    if EXISTING_HEADER.search(source):
        print("ERROR existing_request_id=1")
        return 1

    matches = list(PROXY_PASS.finditer(source))
    if len(matches) != expected:
        print(f"ERROR proxy_pass={len(matches)} expected={expected}")
        return 1

    transformed, inserted = PROXY_PASS.subn(
        lambda match: f"{match.group('indent')}{HEADER}\n{match.group(0)}",
        source,
    )
    if inserted != expected or transformed == source:
        print(f"ERROR inserted={inserted}")
        return 1

    path.write_text(transformed, encoding="utf-8")
    print(f"OK inserted={inserted}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
