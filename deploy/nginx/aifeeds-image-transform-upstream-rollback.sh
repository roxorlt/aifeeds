#!/usr/bin/env bash
set -Eeuo pipefail

readonly SITE_CONFIG="/etc/nginx/sites-available/aifeeds.conf"
readonly PERF_CONFIG="/etc/nginx/conf.d/aifeeds-perf.conf"
readonly CACHE_ROOT="/var/cache/nginx/aifeeds"

backup_dir="${1:-}"
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "must run as root" >&2
  exit 77
fi
case "$backup_dir" in
  /root/aifeeds-image-transform-upstream-*) ;;
  *)
    echo "usage: $0 /root/aifeeds-image-transform-upstream-<UTC timestamp>" >&2
    exit 64
    ;;
esac
[[ "$(stat -c '%U' "$backup_dir")" == "root" ]]
[[ -f "$backup_dir/aifeeds.conf" ]]
[[ -f "$backup_dir/aifeeds-perf.conf" ]]
[[ -f "$backup_dir/manifest.sha256" ]]
[[ -f "$backup_dir/activated.sha256" ]]
(
  cd "$backup_dir"
  sha256sum -c manifest.sha256
)
# Refuse to erase any configuration change made after this exact apply.
sha256sum -c "$backup_dir/activated.sha256"
grep -Fq 'location /img' "$SITE_CONFIG"
grep -Fq 'proxy_pass https://image-api.ai-feeds.com;' "$SITE_CONFIG"
grep -Fq 'proxy_ssl_name image-api.ai-feeds.com;' "$SITE_CONFIG"

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

rescue_dir="$(mktemp -d /root/aifeeds-image-transform-upstream-rollback-rescue-XXXXXX)"
chmod 700 "$rescue_dir"
install -m 600 "$SITE_CONFIG" "$rescue_dir/aifeeds.conf"
install -m 600 "$PERF_CONFIG" "$rescue_dir/aifeeds-perf.conf"

changed=0
restore_on_error() {
  local exit_status=$?
  trap - ERR
  if ((changed)); then
    install -m 600 "$rescue_dir/aifeeds.conf" "$SITE_CONFIG"
    install -m 600 "$rescue_dir/aifeeds-perf.conf" "$PERF_CONFIG"
    if nginx -t && systemctl reload nginx; then
      echo "rollback_failed: restored pre-rollback configs after status $exit_status" >&2
    else
      echo "rollback_failed: pre-rollback config restore or reload also failed" >&2
    fi
  else
    echo "rollback_failed: no production config was overwritten" >&2
  fi
  exit "$exit_status"
}
trap restore_on_error ERR

changed=1
install -m 600 "$backup_dir/aifeeds.conf" "$SITE_CONFIG"
install -m 600 "$backup_dir/aifeeds-perf.conf" "$PERF_CONFIG"
nginx -t
purge_image_cache
systemctl reload nginx
changed=0
trap - ERR

printf 'rollback=complete\n'
printf 'rescue_dir=%s\n' "$rescue_dir"
