#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
POLICY="$ROOT/scripts/release/pages-rollback-policy.sh"

assert_action() {
  local expected=$1
  shift
  local actual
  actual="$("$POLICY" "$@")"
  if [ "$actual" != "$expected" ]; then
    printf 'expected %s, got %s for args: %s\n' "$expected" "$actual" "$*" >&2
    exit 1
  fi
}

# A live baseline is observed before any mutation on reruns; never POST just
# because the historical candidate deployment remains in the inventory.
assert_action observe false true 0 5

# The only state that authorizes a Pages rollback POST is a non-baseline live
# asset before this invocation has received a successful POST response.
assert_action post_once false false 0 5

# Once a POST succeeds, edge propagation is read-only polling. A stale edge
# must not trigger a duplicate POST (the G8 v9 failure mode).
assert_action wait true false 0 5

assert_action observe true true 3 5
assert_action complete true true 4 5
assert_action complete false true 4 5

if "$POLICY" maybe true 0 5 >/dev/null 2>&1; then
  printf 'invalid boolean unexpectedly accepted\n' >&2
  exit 1
fi

printf 'pages_rollback_policy=pass\n'
