#!/usr/bin/env bash
set -Eeuo pipefail

readonly SITE_CONFIG="/etc/nginx/sites-available/aifeeds.conf"
readonly PERF_CONFIG="/etc/nginx/conf.d/aifeeds-perf.conf"
readonly CACHE_ROOT="/var/cache/nginx/aifeeds"
readonly EXPECTED_SITE_SHA="0446c7076e8ca1dfdf1e591e74dd6a559a9599791fd2659589edba80f36c2214"
readonly EXPECTED_PERF_SHA="cd78847ba901509575e9c0df8c5674fe1b86723906da7216f2a486a1b0a74795"
readonly OLD_CACHE_KEY='        proxy_cache_key "$scheme$request_method$host$request_uri";'
readonly NEW_CACHE_KEY='        proxy_cache_key "$scheme$request_method$host$request_uri|fmt=$aifeeds_image_format";'
readonly OLD_NO_CACHE='        proxy_no_cache       $img_skip_cache;'
readonly NEW_NO_CACHE='        proxy_no_cache       $img_skip_cache $aifeeds_image_format_skip_cache;'
readonly OLD_CACHE_BYPASS='        proxy_cache_bypass   $img_skip_cache;'
readonly NEW_CACHE_BYPASS='        proxy_cache_bypass   $img_skip_cache $aifeeds_image_format_skip_cache;'

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

require_exact_baseline() {
  local site_sha perf_sha
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
  [[ "$(grep -Fxc "$OLD_CACHE_KEY" "$SITE_CONFIG")" -eq 1 ]] || {
    echo "expected one legacy /img cache key" >&2
    exit 65
  }
  [[ "$(grep -Fxc "$OLD_NO_CACHE" "$SITE_CONFIG")" -eq 1 ]] || {
    echo "expected one legacy /img proxy_no_cache line" >&2
    exit 65
  }
  [[ "$(grep -Fxc "$OLD_CACHE_BYPASS" "$SITE_CONFIG")" -eq 1 ]] || {
    echo "expected one legacy /img proxy_cache_bypass line" >&2
    exit 65
  }
  if grep -Fq 'map $http_accept $aifeeds_image_format' "$PERF_CONFIG"; then
    echo "image format map already exists" >&2
    exit 65
  fi
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
printf 'preflight=ready\n'
if [[ "$mode" == "--check" ]]; then
  exit 0
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="/root/aifeeds-image-format-cache-${timestamp}"
install -d -m 700 "$backup_dir"
install -m 600 "$SITE_CONFIG" "$backup_dir/aifeeds.conf"
install -m 600 "$PERF_CONFIG" "$backup_dir/aifeeds-perf.conf"
(
  cd "$backup_dir"
  sha256sum aifeeds.conf aifeeds-perf.conf > manifest.sha256
  chmod 600 manifest.sha256
)

map_file="$(mktemp)"
cleanup() {
  rm -f "$map_file"
}
trap cleanup EXIT

changed=0
restore_on_error() {
  local status=$?
  if ((changed)); then
    install -m 600 "$backup_dir/aifeeds.conf" "$SITE_CONFIG"
    install -m 600 "$backup_dir/aifeeds-perf.conf" "$PERF_CONFIG"
    if nginx -t; then
      systemctl reload nginx || true
    fi
  fi
  exit "$status"
}
trap restore_on_error ERR

cat > "$map_file" <<'MAP'

# 2026-07-19: normalize browser Accept into three bounded image cache variants.
# Vary: Accept alone does not vary nginx proxy_cache keys.
map $http_accept $aifeeds_image_format {
    "~*image/avif"  avif;
    "~*image/webp"  webp;
    default         original;
}

# Worker honors explicit q weights. Do not let uncommon weighted requests write
# a differently negotiated body into the three normal-browser cache buckets.
map $http_accept $aifeeds_image_format_skip_cache {
    "~*image/(avif|webp)[^,]*;[[:space:]]*q[[:space:]]*="  1;
    default                                                   "";
}
MAP

changed=1
sed -i "/^proxy_cache_path \\/var\\/cache\\/nginx\\/aifeeds .*;$/r $map_file" "$PERF_CONFIG"
sed -i 's#        proxy_cache_key "$scheme$request_method$host$request_uri";#        proxy_cache_key "$scheme$request_method$host$request_uri|fmt=$aifeeds_image_format";#' "$SITE_CONFIG"
sed -i 's#        proxy_no_cache       $img_skip_cache;#        proxy_no_cache       $img_skip_cache $aifeeds_image_format_skip_cache;#' "$SITE_CONFIG"
sed -i 's#        proxy_cache_bypass   $img_skip_cache;#        proxy_cache_bypass   $img_skip_cache $aifeeds_image_format_skip_cache;#' "$SITE_CONFIG"

[[ "$(grep -Fxc 'map $http_accept $aifeeds_image_format {' "$PERF_CONFIG")" -eq 1 ]]
[[ "$(grep -Fxc 'map $http_accept $aifeeds_image_format_skip_cache {' "$PERF_CONFIG")" -eq 1 ]]
[[ "$(grep -Fxc "$NEW_CACHE_KEY" "$SITE_CONFIG")" -eq 1 ]]
[[ "$(grep -Fxc "$NEW_NO_CACHE" "$SITE_CONFIG")" -eq 1 ]]
[[ "$(grep -Fxc "$NEW_CACHE_BYPASS" "$SITE_CONFIG")" -eq 1 ]]
nginx -t
purge_image_cache
systemctl reload nginx
changed=0
trap - ERR

printf 'apply=complete\n'
printf 'backup_dir=%s\n' "$backup_dir"
printf 'site_sha=%s\n' "$(sha_file "$SITE_CONFIG")"
printf 'perf_sha=%s\n' "$(sha_file "$PERF_CONFIG")"
