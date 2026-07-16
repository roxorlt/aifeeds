#!/usr/bin/env bash
set -euo pipefail

: "$E2E_EXPECTED_X_FIXTURE_ID"
: "$E2E_EXPECTED_BLOG_FIXTURE_ID"

printf '%s' "$E2E_EXPECTED_X_FIXTURE_ID" | grep -Eq '^x_list:perf-staging-[a-f0-9]{20}$' || {
  printf 'E2E_EXPECTED_X_FIXTURE_ID must match x_list:perf-staging-[a-f0-9]{20}\n' >&2
  exit 64
}
printf '%s' "$E2E_EXPECTED_BLOG_FIXTURE_ID" | grep -Eq '^blog:perf-staging-[a-f0-9]{20}$' || {
  printf 'E2E_EXPECTED_BLOG_FIXTURE_ID must match blog:perf-staging-[a-f0-9]{20}\n' >&2
  exit 64
}

export E2E_REMOTE=1
export E2E_BASE_URL=https://perf-staging.ai-feeds.com
exec npx playwright test e2e/perf-staging-remote.spec.ts "$@"
