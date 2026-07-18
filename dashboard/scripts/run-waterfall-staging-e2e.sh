#!/usr/bin/env bash
set -euo pipefail

: "${E2E_OUTPUT_DIR:?E2E_OUTPUT_DIR must point to the active private waterfall staging evidence directory}"

export E2E_REMOTE=1
export WATERFALL_STAGING_REMOTE=1
export E2E_BASE_URL=https://staging.ai-feeds.com
export PLAYWRIGHT_NO_COPY_PROMPT=1
exec npx playwright test e2e/waterfall-staging-remote.spec.ts "$@"
