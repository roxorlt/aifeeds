#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
fixture_dir=$(mktemp -d "${TMPDIR:-/tmp}/gitleaks-exact-allowlist.XXXXXX")
trap 'rm -rf "$fixture_dir"' EXIT

fixture_values=(
  'anthropic-c2pa-provenance-2026-08-11'
  'regulator-safety-pilot-2026-08-11'
)

for value in "${fixture_values[@]}"; do
  printf 'api_key = "%s"\n' "$value" > "$fixture_dir/exact.txt"
  gitleaks detect --no-git --source "$fixture_dir/exact.txt" \
    --config "$repo_root/.gitleaks.toml" --no-banner --redact >/dev/null

  printf 'api_key = "x%sy"\n' "$value" > "$fixture_dir/longer.txt"
  report="$fixture_dir/longer-report.json"
  if gitleaks detect --no-git --source "$fixture_dir/longer.txt" \
    --config "$repo_root/.gitleaks.toml" --no-banner --redact \
    --report-format json --report-path "$report" >/dev/null 2>&1; then
    echo "gitleaks incorrectly allowed a longer value containing fixture: $value" >&2
    exit 1
  fi
  if ! grep -q '"RuleID": "generic-api-key"' "$report"; then
    echo "gitleaks failed without reporting the expected generic-api-key finding: $value" >&2
    exit 1
  fi
  echo "containing value detected: x${value}y"
done

echo 'exact fixture values allowed; containing values detected'
