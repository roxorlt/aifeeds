#!/usr/bin/env bash
# Root-only remote half of deploy-to-cc.sh. The test-only root/tool overrides
# are never forwarded by the production sudo env -i invocation.

set -euo pipefail
set +x
umask 027

TEST_MODE=${AIFEEDS_DEPLOY_TEST_MODE:-0}
if [[ "$TEST_MODE" == "1" ]]; then
  DEPLOY_ROOT=${AIFEEDS_DEPLOY_ROOT:?test root is required}
  [[ "$DEPLOY_ROOT" == /* && "$DEPLOY_ROOT" != "/" ]] || {
    echo "ERROR: unsafe test root" >&2
    exit 2
  }
  INSTALL=${AIFEEDS_INSTALL:?}
  CHOWN=${AIFEEDS_CHOWN:?}
  USERADD=${AIFEEDS_USERADD:?}
  GETENT=${AIFEEDS_GETENT:?}
  RUNUSER=${AIFEEDS_RUNUSER:?}
  NODE=${AIFEEDS_NODE_BIN:?}
  SYSTEMCTL=${AIFEEDS_SYSTEMCTL:?}
  NGINX=${AIFEEDS_NGINX:?}
  CURL=${AIFEEDS_CURL:?}
else
  if ((EUID != 0)); then
    echo "ERROR: install-remote.sh must run as root" >&2
    exit 2
  fi
  DEPLOY_ROOT=""
  INSTALL=/usr/bin/install
  CHOWN=/usr/bin/chown
  USERADD=/usr/sbin/useradd
  GETENT=/usr/bin/getent
  RUNUSER=/usr/sbin/runuser
  NODE=/usr/bin/node
  SYSTEMCTL=/usr/bin/systemctl
  NGINX=/www/server/nginx/sbin/nginx
  CURL=/usr/bin/curl
fi

rooted() {
  printf '%s%s\n' "$DEPLOY_ROOT" "$1"
}

if (($# != 2)); then
  echo "ERROR: expected staging directory and API origin" >&2
  exit 2
fi
STAGING=$1
BASE_URL=$2
EXPECTED_STAGE_PREFIX=$(rooted /tmp/aifeeds-cc-sync.)
if [[ ! "$STAGING" =~ ^${EXPECTED_STAGE_PREFIX//./\.}[A-Za-z0-9]+$ ]]; then
  echo "ERROR: unsafe remote staging directory" >&2
  exit 2
fi
if [[ ! -d "$STAGING" || -L "$STAGING" ]]; then
  echo "ERROR: remote staging directory is missing or unsafe" >&2
  exit 1
fi
if [[ "$BASE_URL" != "https://api.ai-feeds.com" \
  && "$BASE_URL" != "https://staging-api.ai-feeds.com" ]]; then
  echo "ERROR: unsupported sync API origin" >&2
  exit 2
fi

OPT=$(rooted /opt/aifeeds-cc-sync)
ETC_DIR=$(rooted /etc/aifeeds)
ENV_FILE="$ETC_DIR/cc-sync.env"
UNIT_DIR=$(rooted /etc/systemd/system)
STATE_DIR=$(rooted /var/lib/aifeeds-cc-sync)
SITE_ROOT=$(rooted /www/wwwroot/ai-feeds.cc)
ITEM_ROOT="$SITE_ROOT/i"
VHOST_DIR=$(rooted /www/server/panel/vhost/nginx)
VHOST="$VHOST_DIR/html_ai-feeds.cc.conf"
SNIPPET="$VHOST_DIR/aifeeds-cc-content-mirror.conf"
ROLLBACK="$STAGING/rollback"
TIMER=aifeeds-cc-sync.timer
SERVICE=aifeeds-cc-sync.service
nginx_mutated=0
snippet_existed=0

rollback_nginx() {
  set +e
  if ((nginx_mutated == 0)); then return; fi
  "$INSTALL" -o root -g root -m 0644 "$ROLLBACK/vhost.conf" "$VHOST"
  if ((snippet_existed == 1)); then
    "$INSTALL" -o root -g root -m 0644 "$ROLLBACK/snippet.conf" "$SNIPPET"
  else
    rm -f -- "$SNIPPET"
  fi
  "$NGINX" -t >/dev/null 2>&1
  "$NGINX" -s reload >/dev/null 2>&1
}

on_exit() {
  local status=$?
  trap - EXIT
  set +e
  if ((status != 0)); then
    "$SYSTEMCTL" disable --now "$TIMER" >/dev/null 2>&1
    rollback_nginx
  fi
  rm -rf -- "$STAGING"
  exit "$status"
}
trap on_exit EXIT

required_stage_files=(
  auth.mjs client.mjs config.mjs fs-safe.mjs nginx-vhost-editor.mjs
  package.json publish-indexes.mjs state.mjs static-urls.json sync.mjs
  aifeeds-cc-sync.service aifeeds-cc-sync.timer
  nginx-content-mirror.conf deploy-to-cc.sh install-remote.sh cc-sync.env
)
for relative in "${required_stage_files[@]}"; do
  if [[ ! -f "$STAGING/$relative" || -L "$STAGING/$relative" ]]; then
    echo "ERROR: unsafe or missing staged file: $relative" >&2
    exit 1
  fi
done

env_secret=""
env_base_url=""
env_site_root=""
env_state_dir=""
env_concurrency=""
env_page_limit=""
env_timeout=""
seen_secret=0
seen_base_url=0
seen_site_root=0
seen_state_dir=0
seen_concurrency=0
seen_page_limit=0
seen_timeout=0
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" == *$'\r'* || "$line" != *=* ]]; then
    echo "ERROR: malformed staged environment file" >&2
    exit 1
  fi
  key=${line%%=*}
  value=${line#*=}
  case "$key" in
    CC_SYNC_SECRET)
      ((seen_secret == 0)) || { echo "ERROR: duplicate staged environment key" >&2; exit 1; }
      seen_secret=1; env_secret=$value ;;
    CC_SYNC_BASE_URL)
      ((seen_base_url == 0)) || { echo "ERROR: duplicate staged environment key" >&2; exit 1; }
      seen_base_url=1; env_base_url=$value ;;
    CC_SITE_ROOT)
      ((seen_site_root == 0)) || { echo "ERROR: duplicate staged environment key" >&2; exit 1; }
      seen_site_root=1; env_site_root=$value ;;
    CC_SYNC_STATE_DIR)
      ((seen_state_dir == 0)) || { echo "ERROR: duplicate staged environment key" >&2; exit 1; }
      seen_state_dir=1; env_state_dir=$value ;;
    CC_SYNC_CONCURRENCY)
      ((seen_concurrency == 0)) || { echo "ERROR: duplicate staged environment key" >&2; exit 1; }
      seen_concurrency=1; env_concurrency=$value ;;
    CC_SYNC_PAGE_LIMIT)
      ((seen_page_limit == 0)) || { echo "ERROR: duplicate staged environment key" >&2; exit 1; }
      seen_page_limit=1; env_page_limit=$value ;;
    CC_SYNC_REQUEST_TIMEOUT_MS)
      ((seen_timeout == 0)) || { echo "ERROR: duplicate staged environment key" >&2; exit 1; }
      seen_timeout=1; env_timeout=$value ;;
    *)
      echo "ERROR: unknown staged environment key" >&2
      exit 1 ;;
  esac
done < "$STAGING/cc-sync.env"
if ((
  seen_secret + seen_base_url + seen_site_root + seen_state_dir
  + seen_concurrency + seen_page_limit + seen_timeout != 7
)); then
  echo "ERROR: incomplete staged environment file" >&2
  exit 1
fi
if [[ ! "$env_secret" =~ ^[0-9A-Fa-f]{64,128}$ ]]; then
  echo "ERROR: invalid staged sync secret" >&2
  exit 1
fi
if [[ "$env_base_url" != "$BASE_URL" \
  || "$env_site_root" != "/www/wwwroot/ai-feeds.cc" \
  || "$env_state_dir" != "/var/lib/aifeeds-cc-sync" \
  || "$env_concurrency" != "8" \
  || "$env_page_limit" != "200" \
  || "$env_timeout" != "15000" ]]; then
  echo "ERROR: staged environment does not match the deployment contract" >&2
  exit 1
fi
unset env_secret env_base_url env_site_root env_state_dir
unset env_concurrency env_page_limit env_timeout value line

if [[ ! -d "$SITE_ROOT" || -L "$SITE_ROOT" ]]; then
  echo "ERROR: ai-feeds.cc site root is missing or unsafe" >&2
  exit 1
fi
if [[ ! -f "$VHOST" || -L "$VHOST" ]]; then
  echo "ERROR: ai-feeds.cc Nginx vhost is missing or unsafe" >&2
  exit 1
fi
if ! "$GETENT" passwd www >/dev/null; then
  echo "ERROR: required www account does not exist" >&2
  exit 1
fi
if ! "$GETENT" passwd aifeeds-sync >/dev/null; then
  "$USERADD" -r -g www -d /nonexistent -s /sbin/nologin aifeeds-sync
fi

"$SYSTEMCTL" disable --now "$TIMER" >/dev/null 2>&1 || true
"$SYSTEMCTL" stop "$SERVICE" >/dev/null 2>&1 || true

"$INSTALL" -d -o root -g root -m 0755 "$OPT" "$OPT/test"
"$INSTALL" -d -o root -g root -m 0755 "$ETC_DIR" "$UNIT_DIR"
"$INSTALL" -d -o aifeeds-sync -g www -m 0750 "$STATE_DIR" "$ITEM_ROOT"

if find -P "$ITEM_ROOT" -type l -print -quit | grep -q .; then
  echo "ERROR: item root contains a symlink" >&2
  exit 1
fi
"$CHOWN" -R aifeeds-sync:www "$ITEM_ROOT"
find -P "$ITEM_ROOT" -type d -exec chmod 0750 {} +
find -P "$ITEM_ROOT" -type f -exec chmod 0640 {} +

code_files=(
  auth.mjs client.mjs config.mjs fs-safe.mjs nginx-vhost-editor.mjs
  package.json publish-indexes.mjs state.mjs static-urls.json sync.mjs
)
for relative in "${code_files[@]}"; do
  "$INSTALL" -o root -g root -m 0644 "$STAGING/$relative" "$OPT/$relative"
done
test_files=("$STAGING"/test/*.test.mjs)
if [[ ! -f "${test_files[0]}" ]]; then
  echo "ERROR: staged test suite is empty" >&2
  exit 1
fi
installed_tests=()
for source in "${test_files[@]}"; do
  if [[ -L "$source" || ! -f "$source" ]]; then
    echo "ERROR: unsafe staged test file" >&2
    exit 1
  fi
  destination="$OPT/test/${source##*/}"
  "$INSTALL" -o root -g root -m 0644 "$source" "$destination"
  installed_tests+=("$destination")
done
for relative in deploy-to-cc.sh install-remote.sh; do
  "$INSTALL" -o root -g root -m 0755 "$STAGING/$relative" "$OPT/$relative"
done
"$INSTALL" -o root -g root -m 0644 "$STAGING/nginx-content-mirror.conf" \
  "$OPT/nginx-content-mirror.conf"
"$INSTALL" -o root -g root -m 0644 "$STAGING/aifeeds-cc-sync.service" \
  "$UNIT_DIR/$SERVICE"
"$INSTALL" -o root -g root -m 0644 "$STAGING/aifeeds-cc-sync.timer" \
  "$UNIT_DIR/$TIMER"
"$INSTALL" -o root -g root -m 0600 "$STAGING/cc-sync.env" "$ENV_FILE"

"$SYSTEMCTL" daemon-reload
node_major=$("$NODE" -p 'Number(process.versions.node.split(".")[0])')
if [[ ! "$node_major" =~ ^[0-9]+$ ]] || ((node_major < 18)); then
  echo "ERROR: Node 18 or newer is required" >&2
  exit 1
fi
"$RUNUSER" -u aifeeds-sync -- "$NODE" --test "${installed_tests[@]}"
"$SYSTEMCTL" start "$SERVICE"

nginx_dump=$("$NGINX" -T 2>&1) || {
  echo "ERROR: unable to inspect the active Nginx configuration" >&2
  exit 1
}
nginx_users=$(
  printf '%s\n' "$nginx_dump" \
    | awk '$1 == "user" { value=$2; sub(/;.*/, "", value); print value }' \
    | sort -u
)
unset nginx_dump
if [[ "$nginx_users" != "www" ]]; then
  echo "ERROR: expected the active Nginx worker user to be exactly www" >&2
  exit 1
fi
NGINX_USER=$nginx_users
"$GETENT" passwd "$NGINX_USER" >/dev/null

CURRENT="$STATE_DIR/public/current"
"$RUNUSER" -u "$NGINX_USER" -- test -x "$STATE_DIR"
"$RUNUSER" -u "$NGINX_USER" -- test -x "$CURRENT"
"$RUNUSER" -u "$NGINX_USER" -- test -r "$CURRENT/sitemap.xml"
"$RUNUSER" -u "$NGINX_USER" -- test -r "$CURRENT/sitemaps/archive.xml"

generation=""
sitemap=""
SITEMAP_REF_RE='https://ai-feeds\.cc/sitemaps/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/(archive\.xml|((news|x|gh|ph|hf-paper)-[1-9][0-9]*\.xml))'
while IFS= read -r sitemap_line; do
  if [[ "$sitemap_line" =~ $SITEMAP_REF_RE ]]; then
    generation=${BASH_REMATCH[1]}
    sitemap=${BASH_REMATCH[2]}
    break
  fi
done < "$CURRENT/sitemap.xml"
if [[ -z "$generation" || -z "$sitemap" ]]; then
  echo "ERROR: current sitemap has no safe generation-specific child" >&2
  exit 1
fi
"$RUNUSER" -u "$NGINX_USER" -- test -r \
  "$STATE_DIR/public/generations/$generation/sitemaps/$sitemap"

"$INSTALL" -d -o root -g root -m 0700 "$ROLLBACK"
"$INSTALL" -o root -g root -m 0600 "$VHOST" "$ROLLBACK/vhost.conf"
if [[ -e "$SNIPPET" ]]; then
  if [[ ! -f "$SNIPPET" || -L "$SNIPPET" ]]; then
    echo "ERROR: existing content mirror snippet is unsafe" >&2
    exit 1
  fi
  snippet_existed=1
  "$INSTALL" -o root -g root -m 0600 "$SNIPPET" "$ROLLBACK/snippet.conf"
fi
"$NODE" "$OPT/nginx-vhost-editor.mjs" "$VHOST" "$STAGING/vhost.candidate"
nginx_mutated=1
"$INSTALL" -o root -g root -m 0644 "$OPT/nginx-content-mirror.conf" "$SNIPPET"
"$INSTALL" -o root -g root -m 0644 "$STAGING/vhost.candidate" "$VHOST"
"$NGINX" -t
"$NGINX" -s reload
"$CURL" --fail --silent --show-error --max-time 10 --output /dev/null \
  https://ai-feeds.cc/sitemap.xml
"$CURL" --fail --silent --show-error --max-time 10 --output /dev/null \
  https://ai-feeds.cc/ai-news/

"$SYSTEMCTL" enable --now "$TIMER"
echo "✓ remote .cc sync deployment completed."
