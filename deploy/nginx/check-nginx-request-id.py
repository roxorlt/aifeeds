#!/usr/bin/env python3
"""Check request-id propagation without echoing nginx configuration values."""

from dataclasses import dataclass
import sys
from typing import List, Optional, Sequence, Tuple


@dataclass(frozen=True)
class Token:
    value: str
    line: int
    structural: bool = False


@dataclass(frozen=True)
class Node:
    name: str
    arguments: Tuple[str, ...]
    line: int
    children: Optional[Tuple["Node", ...]] = None


class ParseFailure(Exception):
    def __init__(self, line: int) -> None:
        super().__init__("nginx parse failure")
        self.line = max(1, line)


def tokenize(source: str) -> List[Token]:
    tokens: List[Token] = []
    current: List[str] = []
    current_line = 1
    line = 1
    quote: Optional[str] = None
    quote_line = 1
    index = 0

    def start_token() -> None:
        nonlocal current_line
        if not current:
            current_line = line

    def flush() -> None:
        if current:
            tokens.append(Token("".join(current), current_line))
            current.clear()

    while index < len(source):
        char = source[index]

        if quote is not None:
            if char == quote:
                quote = None
                index += 1
                continue
            if char == "\\":
                if index + 1 >= len(source):
                    raise ParseFailure(line)
                next_char = source[index + 1]
                if next_char == "\n":
                    line += 1
                else:
                    current.append(next_char)
                index += 2
                continue
            current.append(char)
            if char == "\n":
                line += 1
            index += 1
            continue

        if char in ("'", '"'):
            start_token()
            quote = char
            quote_line = line
            index += 1
            continue

        if char == "#":
            flush()
            while index < len(source) and source[index] != "\n":
                index += 1
            continue

        if char == "\\":
            start_token()
            if index + 1 >= len(source):
                raise ParseFailure(line)
            next_char = source[index + 1]
            if next_char == "\n":
                line += 1
            else:
                current.append(next_char)
            index += 2
            continue

        if char.isspace():
            flush()
            if char == "\n":
                line += 1
            index += 1
            continue

        if char in "{};":
            flush()
            tokens.append(Token(char, line, structural=True))
            index += 1
            continue

        start_token()
        current.append(char)
        index += 1

    if quote is not None:
        raise ParseFailure(quote_line)
    flush()
    return tokens


def parse_nodes(
    tokens: Sequence[Token],
    index: int = 0,
    expect_close: bool = False,
) -> Tuple[Tuple[Node, ...], int]:
    nodes: List[Node] = []
    directive: List[Token] = []

    while index < len(tokens):
        token = tokens[index]

        if token.structural and token.value == ";":
            if not directive:
                raise ParseFailure(token.line)
            nodes.append(
                Node(
                    directive[0].value,
                    tuple(part.value for part in directive[1:]),
                    directive[0].line,
                )
            )
            directive.clear()
            index += 1
            continue

        if token.structural and token.value == "{":
            if not directive:
                raise ParseFailure(token.line)
            children, index = parse_nodes(tokens, index + 1, expect_close=True)
            nodes.append(
                Node(
                    directive[0].value,
                    tuple(part.value for part in directive[1:]),
                    directive[0].line,
                    children,
                )
            )
            directive.clear()
            continue

        if token.structural and token.value == "}":
            if directive or not expect_close:
                raise ParseFailure(token.line)
            return tuple(nodes), index + 1

        directive.append(token)
        index += 1

    if directive or expect_close:
        failure_line = directive[0].line if directive else (tokens[-1].line if tokens else 1)
        raise ParseFailure(failure_line)
    return tuple(nodes), index


@dataclass
class Counts:
    locations: int = 0
    proxy_locations: int = 0
    proxy_pass: int = 0
    request_id: int = 0


def inspect_nodes(
    nodes: Sequence[Node],
    counts: Counts,
    errors: List[Tuple[int, int, int, int]],
) -> None:
    for node in nodes:
        if node.children is None:
            continue

        if node.name.lower() == "location":
            counts.locations += 1
            direct_proxy_pass = sum(
                1
                for child in node.children
                if child.children is None and child.name.lower() == "proxy_pass"
            )
            direct_request_id = sum(
                1
                for child in node.children
                if child.children is None
                and child.name.lower() == "proxy_set_header"
                and len(child.arguments) >= 1
                and child.arguments[0].lower() == "x-request-id"
            )
            direct_valid_request_id = sum(
                1
                for child in node.children
                if child.children is None
                and child.name.lower() == "proxy_set_header"
                and len(child.arguments) == 2
                and child.arguments[0].lower() == "x-request-id"
                and child.arguments[1] == "$request_id"
            )

            if direct_proxy_pass:
                counts.proxy_locations += 1
                counts.proxy_pass += direct_proxy_pass
                counts.request_id += direct_request_id
                if direct_request_id != 1 or direct_valid_request_id != 1:
                    errors.append(
                        (
                            node.line,
                            direct_proxy_pass,
                            direct_request_id,
                            direct_valid_request_id,
                        )
                    )

        inspect_nodes(node.children, counts, errors)


def read_source(source: str) -> str:
    if source == "-":
        return sys.stdin.read()
    with open(source, "r", encoding="utf-8") as handle:
        return handle.read()


def check_source(source: str, input_number: int) -> bool:
    try:
        text = read_source(source)
    except (OSError, UnicodeError):
        print(f"ERROR input={input_number} line=0 read=1")
        return False

    try:
        tokens = tokenize(text)
        nodes, index = parse_nodes(tokens)
        if index != len(tokens):
            raise ParseFailure(tokens[index].line)
    except ParseFailure as failure:
        print(f"ERROR input={input_number} line={failure.line} parse=1")
        return False
    except Exception:
        print(f"ERROR input={input_number} line=0 internal=1")
        return False

    counts = Counts()
    errors: List[Tuple[int, int, int, int]] = []
    inspect_nodes(nodes, counts, errors)

    if counts.proxy_locations == 0:
        errors.append((0, 0, 0, 0))

    if errors:
        for line, proxy_pass, request_id, valid_request_id in errors:
            print(
                f"ERROR input={input_number} line={line} "
                f"proxy_pass={proxy_pass} request_id={request_id} "
                f"valid_request_id={valid_request_id}"
            )
        print(
            f"FAIL input={input_number} errors={len(errors)} "
            f"locations={counts.locations} proxy_locations={counts.proxy_locations} "
            f"proxy_pass={counts.proxy_pass} request_id={counts.request_id}"
        )
        return False

    print(
        f"OK input={input_number} locations={counts.locations} "
        f"proxy_locations={counts.proxy_locations} proxy_pass={counts.proxy_pass} "
        f"request_id={counts.request_id}"
    )
    return True


def main(arguments: Sequence[str]) -> int:
    sources = list(arguments) or ["-"]
    success = True
    for input_number, source in enumerate(sources, start=1):
        success = check_source(source, input_number) and success
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
