#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CAPTURE="$ROOT/scripts/release/media-contract-evidence.sh"
RAW="$(mktemp -d "${TMPDIR:-/tmp}/aifeeds-media-contract-test.XXXXXX")"
trap 'rm -rf "$RAW"' EXIT HUP INT TERM

head -c 1024 /dev/zero > "$RAW/body.bin"
cat > "$RAW/pass.headers" <<'EOF'
HTTP/2 206
Content-Type: video/mp4
Content-Length: 1024
Content-Range: bytes 0-1023/4096
Accept-Ranges: bytes
Cache-Control: no-store
X-Worker-Version: 11111111-2222-4333-8444-555555555555
EOF

"$CAPTURE" 206 "$RAW/body.bin" "$RAW/pass.headers" \
  11111111-2222-4333-8444-555555555555 3 > "$RAW/pass.json"
jq -e '.status == "pass" and .attempt == 3 and .bytes == 1024 and
  .headers.accept_ranges == "bytes" and
  .headers.worker_version == .expected_worker_version' "$RAW/pass.json" >/dev/null

grep -vi '^Accept-Ranges:' "$RAW/pass.headers" > "$RAW/missing-range.headers"
"$CAPTURE" 206 "$RAW/body.bin" "$RAW/missing-range.headers" \
  11111111-2222-4333-8444-555555555555 4 > "$RAW/missing-range.json"
jq -e '.status == "fail" and .headers.accept_ranges == "" and .checks.accept_ranges == false' \
  "$RAW/missing-range.json" >/dev/null

"$CAPTURE" 206 "$RAW/body.bin" "$RAW/pass.headers" \
  aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee 5 > "$RAW/wrong-version.json"
jq -e '.status == "fail" and .checks.worker_version == false' "$RAW/wrong-version.json" >/dev/null

printf 'media_contract_evidence=pass\n'
