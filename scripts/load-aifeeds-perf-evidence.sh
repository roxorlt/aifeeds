#!/bin/sh

# Source from a fail-fast gate after REPO_ROOT is set. This helper never prints
# the evidence path and rejects symlinks, foreign ownership, and loose modes.
set +x
: "${REPO_ROOT:?REPO_ROOT is required}"

EVIDENCE_POINTER=/private/tmp/aifeeds-perf-staging-evidence-path
test -f "$EVIDENCE_POINTER"
test ! -L "$EVIDENCE_POINTER"
test "$(stat -f '%u' "$EVIDENCE_POINTER")" = "$(id -u)"
test "$(stat -f '%Lp' "$EVIDENCE_POINTER")" = 600
test "$(wc -l < "$EVIDENCE_POINTER" | tr -d ' ')" = 1
IFS= read -r EVIDENCE < "$EVIDENCE_POINTER"
case "$EVIDENCE" in /private/tmp/aifeeds-perf-staging-*) ;; *) return 1 ;; esac

test -d "$EVIDENCE"
test ! -L "$EVIDENCE"
test "$(stat -f '%u' "$EVIDENCE")" = "$(id -u)"
test "$(stat -f '%Lp' "$EVIDENCE")" = 700
test -f "$EVIDENCE/commit.txt"
export EVIDENCE
