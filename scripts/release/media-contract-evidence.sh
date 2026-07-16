#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 5 ]; then exit 64; fi

http_status=$1
body_path=$2
headers_path=$3
expected_worker_version=$4
attempt=$5

printf '%s' "$http_status" | grep -Eq '^[0-9]{3}$' || exit 64
printf '%s' "$expected_worker_version" \
  | grep -Eq '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' \
  || exit 64
printf '%s' "$attempt" | grep -Eq '^[1-9][0-9]*$' || exit 64
test -f "$body_path" && test ! -L "$body_path" || exit 64
test -f "$headers_path" && test ! -L "$headers_path" || exit 64

header_value() {
  awk -F':' -v wanted="$1" '
    tolower($1) == tolower(wanted) {
      sub(/^[^:]*:[[:space:]]*/, "", $0)
      sub(/\r$/, "", $0)
      print
      exit
    }
  ' "$headers_path"
}

bytes="$(wc -c < "$body_path" | tr -d ' ')"
content_length="$(header_value content-length)"
content_range="$(header_value content-range)"
accept_ranges="$(header_value accept-ranges)"
content_type="$(header_value content-type)"
cache_control="$(header_value cache-control)"
worker_version="$(header_value x-worker-version)"

status_ok=false
bytes_ok=false
content_length_ok=false
content_range_ok=false
accept_ranges_ok=false
content_type_ok=false
cache_control_ok=false
worker_version_ok=false

[ "$http_status" = 206 ] && status_ok=true
[ "$bytes" = 1024 ] && bytes_ok=true
[ "$content_length" = 1024 ] && content_length_ok=true
printf '%s' "$content_range" | grep -Eq '^bytes 0-1023/[1-9][0-9]*$' && content_range_ok=true
[ "$(printf '%s' "$accept_ranges" | tr '[:upper:]' '[:lower:]')" = bytes ] && accept_ranges_ok=true
[ "$(printf '%s' "$content_type" | tr '[:upper:]' '[:lower:]')" = video/mp4 ] && content_type_ok=true
[ "$(printf '%s' "$cache_control" | tr '[:upper:]' '[:lower:]')" = no-store ] && cache_control_ok=true
[ "$worker_version" = "$expected_worker_version" ] && worker_version_ok=true

contract_status=fail
if [ "$status_ok" = true ] && [ "$bytes_ok" = true ] &&
  [ "$content_length_ok" = true ] && [ "$content_range_ok" = true ] &&
  [ "$accept_ranges_ok" = true ] && [ "$content_type_ok" = true ] &&
  [ "$cache_control_ok" = true ] && [ "$worker_version_ok" = true ]; then
  contract_status=pass
fi

jq -ncS \
  --arg status "$contract_status" --arg checked_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg http_status "$http_status" --arg expected "$expected_worker_version" \
  --arg content_length "$content_length" --arg content_range "$content_range" \
  --arg accept_ranges "$accept_ranges" --arg content_type "$content_type" \
  --arg cache_control "$cache_control" --arg worker_version "$worker_version" \
  --argjson attempt "$attempt" --argjson bytes "$bytes" \
  --argjson status_ok "$status_ok" --argjson bytes_ok "$bytes_ok" \
  --argjson content_length_ok "$content_length_ok" --argjson content_range_ok "$content_range_ok" \
  --argjson accept_ranges_ok "$accept_ranges_ok" --argjson content_type_ok "$content_type_ok" \
  --argjson cache_control_ok "$cache_control_ok" --argjson worker_version_ok "$worker_version_ok" '
  {schema:1,status:$status,checked_at:$checked_at,attempt:$attempt,
    http_status:$http_status,bytes:$bytes,expected_worker_version:$expected,
    headers:{content_length:$content_length,content_range:$content_range,
      accept_ranges:$accept_ranges,content_type:$content_type,
      cache_control:$cache_control,worker_version:$worker_version},
    checks:{http_status:$status_ok,bytes:$bytes_ok,content_length:$content_length_ok,
      content_range:$content_range_ok,accept_ranges:$accept_ranges_ok,
      content_type:$content_type_ok,cache_control:$cache_control_ok,
      worker_version:$worker_version_ok}}'
