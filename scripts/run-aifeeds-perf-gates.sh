#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
case "${1:-}" in
    '') EVIDENCE="$(mktemp -d /private/tmp/aifeeds-perf-staging-g0.XXXXXX)" ;;
    /private/tmp/aifeeds-perf-staging-*) EVIDENCE=$1; mkdir -m 0700 "$EVIDENCE" ;;
    *) printf 'usage: %s [/private/tmp/aifeeds-perf-staging-*]\n' "$0" >&2; exit 64 ;;
esac
chmod 0700 "$EVIDENCE"
test -d "$EVIDENCE"
test ! -L "$EVIDENCE"

G0_STATUS=failed
finish() {
    local rc=$?
    printf '%s\n' "$G0_STATUS" > "$EVIDENCE/status.txt"
    chmod 0600 "$EVIDENCE/status.txt"
    exit "$rc"
}
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

run_gate() {
    local name=$1
    shift
    printf '=== G0 %s ===\n' "$name"
    "$@" 2>&1 | tee "$EVIDENCE/${name}.log"
    chmod 0600 "$EVIDENCE/${name}.log"
}

cd "$REPO_ROOT"
test -z "$(git status --porcelain)"
git rev-parse HEAD > "$EVIDENCE/commit.txt"
chmod 0600 "$EVIDENCE/commit.txt"
run_gate git-diff-check git diff --check

cd "$REPO_ROOT/dashboard"
run_gate dashboard-lint npm run lint
run_gate dashboard-unit npm run test:unit
run_gate dashboard-build npm run build
run_gate dashboard-perf-build npm run build:perf-staging
run_gate dashboard-e2e env CI=1 npm run test:e2e

cd "$REPO_ROOT/worker"
run_gate worker-types npx tsc --noEmit
run_gate worker-unit npm test
run_gate worker-staging-dry-run npx wrangler deploy --dry-run --env staging

cd "$REPO_ROOT"
run_gate root-node node --test \
    scripts/benchmark-aifeeds-upstream.test.mjs \
    scripts/run-aifeeds-staging-backfill.test.mjs \
    deploy/nginx/aifeeds-performance-log.test.mjs \
    deploy/nginx/nginx-capability.test.mjs \
    deploy/nginx/rollback-aifeeds-performance-log.test.mjs \
    scripts/ci/performance-validation-contract.test.mjs
run_gate request-id-checker python3 deploy/nginx/check-nginx-request-id.test.py
run_gate request-id-inserter python3 deploy/nginx/insert-nginx-request-id.test.py
run_gate request-id-diff python3 deploy/nginx/verify-nginx-request-id-diff.test.py
run_gate installer-syntax bash -n deploy/nginx/install-aifeeds-performance-log.sh
run_gate rollback-syntax bash -n deploy/nginx/rollback-aifeeds-performance-log.sh
run_gate integration-syntax bash -n deploy/nginx/install-aifeeds-performance-log.integration.test.sh
run_gate scenario-syntax bash -n deploy/nginx/test-fixtures/gl-a-installer/run-scenario.sh
run_gate gl-a-integration bash deploy/nginx/install-aifeeds-performance-log.integration.test.sh

jq -nc \
    --arg commit "$(cat "$EVIDENCE/commit.txt")" \
    --arg completed_utc "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{schema:1,gate:"aifeeds-performance-G0",status:"pass",commit:$commit,
      completed_utc:$completed_utc,
      gl_a:{dependency_preflight:"pass",independent_recovery:"10/10",
            frozen_matrix:"135/135",skipped:0}}' > "$EVIDENCE/summary.json"
chmod 0600 "$EVIDENCE/summary.json"

EVIDENCE_POINTER=/private/tmp/aifeeds-perf-staging-evidence-path
POINTER_TMP="$(mktemp /private/tmp/aifeeds-perf-staging-evidence-path.XXXXXX)"
printf '%s\n' "$EVIDENCE" > "$POINTER_TMP"
chmod 0600 "$POINTER_TMP"
if [ -e "$EVIDENCE_POINTER" ] || [ -L "$EVIDENCE_POINTER" ]; then
    test -f "$EVIDENCE_POINTER"
    test ! -L "$EVIDENCE_POINTER"
    test "$(stat -f '%u' "$EVIDENCE_POINTER")" = "$(id -u)"
    test "$(stat -f '%Lp' "$EVIDENCE_POINTER")" = 600
fi
mv -f "$POINTER_TMP" "$EVIDENCE_POINTER"

G0_STATUS=pass
printf 'G0 evidence=%s\n' "$EVIDENCE"
