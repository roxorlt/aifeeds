#!/usr/bin/env bash
set -Eeuo pipefail

readonly SITE_CONFIG="/etc/nginx/sites-available/aifeeds.conf"
readonly PERF_CONFIG="/etc/nginx/conf.d/aifeeds-perf.conf"
readonly CACHE_ROOT="/var/cache/nginx/aifeeds"
readonly EXPECTED_SITE_SHA="9303f443c9530a06ae2339c735151206a2011d65e03fdfebcf96c123a5c8dfb3"
readonly EXPECTED_PERF_SHA="55630f8c73aa8ee9cce056daa064788d57cbc54be48a354b3f163f6441ba6837"
readonly OLD_UPSTREAM="xlist-api.ltsms86.workers.dev"
readonly NEW_UPSTREAM="image-api.ai-feeds.com"
readonly PROBE_SOURCE="https://wimg.huodongxing.com/logo/202607/2868612745300/956032034027878_v2.jpg@!wmlogo"

mode="${1:---check}"
if [[ "$mode" != "--check" && "$mode" != "--apply" ]]; then
  echo "usage: $0 [--check|--apply]" >&2
  exit 64
fi
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "must run as root" >&2
  exit 77
fi

sha_file() {
  sha256sum "$1" | awk '{print $1}'
}

image_location() {
  python3 - "$SITE_CONFIG" <<'PY'
import pathlib
import sys

text = pathlib.Path(sys.argv[1]).read_text()
marker = "    location /img {"
start = text.find(marker)
if start < 0 or text.find(marker, start + 1) >= 0:
    raise SystemExit("expected exactly one /img location")
depth = 0
end = None
for index in range(start, len(text)):
    if text[index] == "{":
        depth += 1
    elif text[index] == "}":
        depth -= 1
        if depth == 0:
            end = index + 1
            break
if end is None:
    raise SystemExit("unterminated /img location")
print(text[start:end])
PY
}

require_exact_baseline() {
  local site_sha perf_sha location
  site_sha="$(sha_file "$SITE_CONFIG")"
  perf_sha="$(sha_file "$PERF_CONFIG")"
  [[ "$site_sha" == "$EXPECTED_SITE_SHA" ]] || {
    echo "site config checksum drift: $site_sha" >&2
    exit 65
  }
  [[ "$perf_sha" == "$EXPECTED_PERF_SHA" ]] || {
    echo "perf config checksum drift: $perf_sha" >&2
    exit 65
  }
  location="$(image_location)"
  [[ "$(grep -Fc "proxy_pass https://$OLD_UPSTREAM;" <<<"$location")" -eq 1 ]]
  [[ "$(grep -Fc "proxy_set_header Host $OLD_UPSTREAM;" <<<"$location")" -eq 1 ]]
  [[ "$(grep -Fc "proxy_ssl_name $OLD_UPSTREAM;" <<<"$location")" -eq 1 ]]
  if grep -Fq "$NEW_UPSTREAM" <<<"$location"; then
    echo "new image upstream already exists" >&2
    exit 65
  fi
}

probe_transform_origin() {
  local origin_secret header_file body_file content_length
  header_file="$(mktemp)"
  body_file="$(mktemp)"
  origin_secret="$(python3 - "$SITE_CONFIG" <<'PY'
import pathlib
import re
import sys

text = pathlib.Path(sys.argv[1]).read_text()
marker = "    location /img {"
start = text.index(marker)
end = text.index("\n    }", start)
location = text[start:end]
match = re.search(r"proxy_set_header\s+X-Origin-Secret\s+([^;]+);", location)
if not match:
    raise SystemExit("missing X-Origin-Secret in /img location")
value = match.group(1).strip()
if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
    value = value[1:-1]
print(value)
PY
)"
  cleanup_probe() {
    rm -f "$header_file" "$body_file"
  }
  [[ "$origin_secret" =~ ^[A-Za-z0-9._~-]{20,256}$ ]] || {
    cleanup_probe
    echo "invalid relay origin secret" >&2
    exit 65
  }
  # Read the sensitive header from curl config on stdin so the secret never
  # appears in the process command line or a world-readable temporary file.
  if ! printf 'header = "X-Origin-Secret: %s"\n' "$origin_secret" | \
    curl --config - -fsS --max-time 20 --get "https://$NEW_UPSTREAM/img" \
    --data-urlencode "url=$PROBE_SOURCE" \
    --data "w=400" \
    --data "q=82" \
    -H "Accept: image/avif,image/webp,*/*;q=0.8" \
    -H "User-Agent: Mozilla/5.0 (compatible; aifeeds-image-transform-preflight/1.0)" \
    -D "$header_file" \
    -o "$body_file"; then
    cleanup_probe
    echo "image transform preflight request failed" >&2
    exit 69
  fi
  grep -Eiq '^Content-Type:[[:space:]]*image/avif([[:space:]]|;|$)' "$header_file" || {
    cleanup_probe
    echo "image transform preflight did not return AVIF" >&2
    exit 69
  }
  content_length="$(wc -c < "$body_file" | tr -d ' ')"
  [[ "$content_length" -gt 0 && "$content_length" -lt 30000 ]] || {
    cleanup_probe
    echo "image transform preflight body size out of bounds: $content_length" >&2
    exit 69
  }
  cleanup_probe
  printf 'transform_preflight=ready content_type=image/avif bytes=%s\n' "$content_length"
}

purge_image_cache() {
  local image_cache_files=()
  while IFS= read -r -d '' file; do
    image_cache_files+=("$file")
  done < <(grep -R -l -Z -a '/img?' "$CACHE_ROOT" 2>/dev/null || true)
  if ((${#image_cache_files[@]} > 0)); then
    rm -f -- "${image_cache_files[@]}"
  fi
  printf 'purged_img_cache_files=%s\n' "${#image_cache_files[@]}"
}

require_exact_baseline
nginx -t
probe_transform_origin
printf 'preflight=ready\n'
if [[ "$mode" == "--check" ]]; then
  exit 0
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="/root/aifeeds-image-transform-upstream-${timestamp}"
install -d -m 700 "$backup_dir"
install -m 600 "$SITE_CONFIG" "$backup_dir/aifeeds.conf"
install -m 600 "$PERF_CONFIG" "$backup_dir/aifeeds-perf.conf"
(
  cd "$backup_dir"
  sha256sum aifeeds.conf aifeeds-perf.conf > manifest.sha256
  chmod 600 manifest.sha256
)

candidate="$(mktemp)"
cleanup() {
  rm -f "$candidate"
}
trap cleanup EXIT

python3 - "$SITE_CONFIG" "$candidate" "$OLD_UPSTREAM" "$NEW_UPSTREAM" <<'PY'
import pathlib
import sys

source, destination, old, new = sys.argv[1:]
text = pathlib.Path(source).read_text()
marker = "    location /img {"
start = text.find(marker)
if start < 0 or text.find(marker, start + 1) >= 0:
    raise SystemExit("expected exactly one /img location")
depth = 0
end = None
for index in range(start, len(text)):
    if text[index] == "{":
        depth += 1
    elif text[index] == "}":
        depth -= 1
        if depth == 0:
            end = index + 1
            break
if end is None:
    raise SystemExit("unterminated /img location")
location = text[start:end]
expected = [
    f"proxy_pass https://{old};",
    f"proxy_set_header Host {old};",
    f"proxy_ssl_name {old};",
]
for line in expected:
    if location.count(line) != 1:
        raise SystemExit(f"expected exactly one line in /img location: {line}")
    location = location.replace(line, line.replace(old, new), 1)
pathlib.Path(destination).write_text(text[:start] + location + text[end:])
PY

changed=0
restore_on_error() {
  local exit_status=$?
  if ((changed)); then
    install -m 600 "$backup_dir/aifeeds.conf" "$SITE_CONFIG"
    install -m 600 "$backup_dir/aifeeds-perf.conf" "$PERF_CONFIG"
    if nginx -t; then
      systemctl reload nginx || true
    fi
  fi
  exit "$exit_status"
}
trap restore_on_error ERR

changed=1
install -m 644 "$candidate" "$SITE_CONFIG"
location="$(image_location)"
[[ "$(grep -Fc "proxy_pass https://$NEW_UPSTREAM;" <<<"$location")" -eq 1 ]]
[[ "$(grep -Fc "proxy_set_header Host $NEW_UPSTREAM;" <<<"$location")" -eq 1 ]]
[[ "$(grep -Fc "proxy_ssl_name $NEW_UPSTREAM;" <<<"$location")" -eq 1 ]]
if grep -Fq "$OLD_UPSTREAM" <<<"$location"; then
  echo "legacy image upstream remains in /img location" >&2
  exit 65
fi
nginx -t
{
  printf '%s  %s\n' "$(sha_file "$SITE_CONFIG")" "$SITE_CONFIG"
  printf '%s  %s\n' "$(sha_file "$PERF_CONFIG")" "$PERF_CONFIG"
} > "$backup_dir/activated.sha256"
chmod 600 "$backup_dir/activated.sha256"
purge_image_cache
systemctl reload nginx
changed=0
trap - ERR

printf 'apply=complete\n'
printf 'backup_dir=%s\n' "$backup_dir"
printf 'site_sha=%s\n' "$(sha_file "$SITE_CONFIG")"
printf 'perf_sha=%s\n' "$(sha_file "$PERF_CONFIG")"
