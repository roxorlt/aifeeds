#!/usr/bin/env bash
# Root-only transactional installer. deploy-to-cc.sh fixes this script and its
# verifier in a root-owned bootstrap directory before invoking it.

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
  FLOCK=${AIFEEDS_FLOCK:?}
  ROOT_UID=${AIFEEDS_ROOT_UID:?}
  ROOT_GID=${AIFEEDS_ROOT_GID:?}
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
  FLOCK=/usr/bin/flock
  ROOT_UID=0
  ROOT_GID=0
fi

rooted() {
  printf '%s%s\n' "$DEPLOY_ROOT" "$1"
}

if (($# != 3)); then
  echo "ERROR: expected staging directory, production API origin, and manifest digest" >&2
  exit 2
fi
STAGING=$1
BASE_URL=$2
EXPECTED_MANIFEST_DIGEST=$3
EXPECTED_STAGE_PREFIX=$(rooted /tmp/aifeeds-cc-sync.)
if [[ ! "$STAGING" =~ ^${EXPECTED_STAGE_PREFIX//./\.}[A-Za-z0-9]+$ ]]; then
  echo "ERROR: unsafe remote staging directory" >&2
  exit 2
fi
if [[ ! -d "$STAGING" || -L "$STAGING" ]]; then
  echo "ERROR: remote staging directory is missing or unsafe" >&2
  exit 1
fi
if [[ "$BASE_URL" != "https://api.ai-feeds.com" ]]; then
  echo "ERROR: unsupported sync API origin" >&2
  exit 2
fi
if [[ ! "$EXPECTED_MANIFEST_DIGEST" =~ ^[0-9a-f]{64}$ ]]; then
  echo "ERROR: invalid expected manifest digest" >&2
  exit 2
fi

INSTALLER_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SECURITY_TOOL=${AIFEEDS_FIXED_SECURITY_TOOL:-$INSTALLER_DIR/deployment-security.mjs}
FILE_TOOL=${AIFEEDS_FIXED_FILE_TOOL:-$INSTALLER_DIR/deployment-file-transaction.mjs}
NGINX_TRANSACTION_TOOL=${AIFEEDS_FIXED_NGINX_TOOL:-$INSTALLER_DIR/nginx-config-transaction.mjs}
if [[ ! -f "$SECURITY_TOOL" || -L "$SECURITY_TOOL" ]]; then
  echo "ERROR: fixed deployment verifier is missing or unsafe" >&2
  exit 1
fi
if [[ ! -f "$FILE_TOOL" || -L "$FILE_TOOL" ]]; then
  echo "ERROR: fixed deployment file transaction helper is missing or unsafe" >&2
  exit 1
fi
if [[ ! -f "$NGINX_TRANSACTION_TOOL" || -L "$NGINX_TRANSACTION_TOOL" ]]; then
  echo "ERROR: fixed Nginx transaction helper is missing or unsafe" >&2
  exit 1
fi

LOCK_DIR=$(rooted /var/lock)
LOCK_FILE="$LOCK_DIR/aifeeds-cc-sync-deploy.lock"
"$INSTALL" -d -o root -g root -m 0755 "$LOCK_DIR"
exec 9>"$LOCK_FILE"
if ! "$FLOCK" -n 9; then
  echo "ERROR: another aifeeds .cc deployment is in progress" >&2
  exit 75
fi

SNAPSHOT_PARENT=$(rooted /var/tmp)
"$INSTALL" -d -o root -g root -m 0755 "$SNAPSHOT_PARENT"
SNAPSHOT=$(mktemp -d "$SNAPSHOT_PARENT/aifeeds-cc-root-snapshot.XXXXXX")
ROLLBACK="$SNAPSHOT/.rollback"
TIMER=aifeeds-cc-sync.timer
SERVICE=aifeeds-cc-sync.service
nginx_mutated=0
transaction_prepared=0
deployment_committed=0
release_created=0
old_opt_kind=absent
old_opt_target=""
timer_enabled_before=disabled
timer_active_before=inactive
service_active_before=inactive

rollback_nginx() {
  local failed=0
  if ((nginx_mutated == 0)); then return 0; fi
  "$NODE" "$NGINX_TRANSACTION_TOOL" rollback "$ROLLBACK/nginx" || failed=1
  "$NGINX" -t || failed=1
  "$NGINX" -s reload || failed=1
  return "$failed"
}

restore_backed_file() {
  local destination=$1
  local backup_name=$2
  "$NODE" "$FILE_TOOL" restore "$destination" "$ROLLBACK" "$backup_name"
}

restore_unit_states() {
  local failed=0
  "$SYSTEMCTL" stop "$SERVICE" >/dev/null 2>&1 || failed=1
  "$SYSTEMCTL" stop "$TIMER" >/dev/null 2>&1 || failed=1
  if [[ "$service_active_before" == active ]]; then
    "$SYSTEMCTL" start "$SERVICE" >/dev/null 2>&1 || failed=1
  fi
  if [[ "$timer_enabled_before" == enabled ]]; then
    "$SYSTEMCTL" enable "$TIMER" >/dev/null 2>&1 || failed=1
  else
    "$SYSTEMCTL" disable "$TIMER" >/dev/null 2>&1 || failed=1
  fi
  if [[ "$timer_active_before" == active ]]; then
    "$SYSTEMCTL" start "$TIMER" >/dev/null 2>&1 || failed=1
  else
    "$SYSTEMCTL" stop "$TIMER" >/dev/null 2>&1 || failed=1
  fi
  return "$failed"
}

rollback_install() {
  local failed=0
  rollback_nginx || failed=1
  "$SYSTEMCTL" disable --now "$TIMER" >/dev/null 2>&1 || failed=1
  "$SYSTEMCTL" stop "$SERVICE" >/dev/null 2>&1 || failed=1
  if [[ "$old_opt_kind" == symlink ]]; then
    "$NODE" "$SECURITY_TOOL" switch-symlink "$OPT" "$old_opt_target" \
      >/dev/null 2>&1 || failed=1
  else
    rm -f -- "$OPT" || failed=1
  fi
  restore_backed_file "$ENV_FILE" env || failed=1
  restore_backed_file "$UNIT_DIR/$SERVICE" service || failed=1
  restore_backed_file "$UNIT_DIR/$TIMER" timer || failed=1
  "$SYSTEMCTL" daemon-reload >/dev/null 2>&1 || failed=1
  restore_unit_states || failed=1
  if ((release_created == 1)); then
    rm -rf -- "$RELEASE" || failed=1
  fi
  return "$failed"
}

on_exit() {
  local status=$?
  trap - EXIT
  set +e
  if ((status != 0 && transaction_prepared == 1 && deployment_committed == 0)); then
    if ! rollback_install; then
      echo "ERROR: deployment rollback was incomplete" >&2
      status=70
    fi
  fi
  rm -rf -- "$SNAPSHOT" "$STAGING"
  exit "$status"
}
trap on_exit EXIT

cp -a "$STAGING/." "$SNAPSHOT/"
"$NODE" "$SECURITY_TOOL" verify-payload \
  "$SNAPSHOT" "$EXPECTED_MANIFEST_DIGEST"
"$CHOWN" -R root:root "$SNAPSHOT"
find -P "$SNAPSHOT" -type d -exec chmod 0755 {} +
find -P "$SNAPSHOT" -type f -exec chmod 0644 {} +
chmod 0600 "$SNAPSHOT/deploy/cc-sync.env" "$SNAPSHOT/MANIFEST.sha256"
"$NODE" "$SECURITY_TOOL" verify-payload \
  "$SNAPSHOT" "$EXPECTED_MANIFEST_DIGEST"

ENV_SOURCE="$SNAPSHOT/deploy/cc-sync.env"
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
    *) echo "ERROR: unknown staged environment key" >&2; exit 1 ;;
  esac
done < "$ENV_SOURCE"
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

RELEASES=$(rooted /opt/aifeeds-cc-sync-releases)
OPT=$(rooted /opt/aifeeds-cc-sync)
RELEASE="$RELEASES/$EXPECTED_MANIFEST_DIGEST"
ETC_DIR=$(rooted /etc/aifeeds)
ENV_FILE="$ETC_DIR/cc-sync.env"
UNIT_DIR=$(rooted /etc/systemd/system)
STATE_DIR=$(rooted /var/lib/aifeeds-cc-sync)
SITE_ROOT=$(rooted /www/wwwroot/ai-feeds.cc)
ITEM_ROOT="$SITE_ROOT/i"
VHOST_DIR=$(rooted /www/server/panel/vhost/nginx)
VHOST="$VHOST_DIR/html_ai-feeds.cc.conf"
SNIPPET="$VHOST_DIR/aifeeds-cc-content-mirror.conf"
PATH_BOUNDARY=${DEPLOY_ROOT:-/}

www_passwd=$("$GETENT" passwd www) || {
  echo "ERROR: required www account does not exist" >&2
  exit 1
}
www_group=$("$GETENT" group www) || {
  echo "ERROR: required www group does not exist" >&2
  exit 1
}
IFS=: read -r www_name _ WWW_UID www_primary_gid _ _ _ <<< "$www_passwd"
IFS=: read -r www_group_name _ WWW_GID _ <<< "$www_group"
if [[ "$www_name" != www || "$www_group_name" != www \
  || ! "$WWW_UID" =~ ^[0-9]+$ || ! "$WWW_GID" =~ ^[0-9]+$ \
  || "$www_primary_gid" != "$WWW_GID" ]]; then
  echo "ERROR: invalid www account identity" >&2
  exit 1
fi
if ! sync_passwd=$("$GETENT" passwd aifeeds-sync); then
  "$USERADD" -r -g www -d /nonexistent -s /sbin/nologin aifeeds-sync
  sync_passwd=$("$GETENT" passwd aifeeds-sync) || {
    echo "ERROR: unable to create aifeeds-sync account" >&2
    exit 1
  }
fi
IFS=: read -r sync_name _ SYNC_UID SYNC_GID _ SYNC_HOME SYNC_SHELL \
  <<< "$sync_passwd"
if [[ "$sync_name" != aifeeds-sync \
  || ! "$SYNC_UID" =~ ^[0-9]+$ || "$SYNC_UID" == 0 || "$SYNC_UID" -ge 1000 \
  || "$SYNC_GID" != "$WWW_GID" \
  || "$SYNC_HOME" != /nonexistent \
  || ("$SYNC_SHELL" != /sbin/nologin && "$SYNC_SHELL" != /usr/sbin/nologin) ]]; then
  echo "ERROR: aifeeds-sync account does not match the locked system identity" >&2
  exit 1
fi

ROOT_OWNERS="$ROOT_UID"
WEB_OWNERS="$ROOT_UID,$WWW_UID"
WRITABLE_OWNERS="$ROOT_UID,$WWW_UID,$SYNC_UID"
for chain in \
  "/opt:$ROOT_OWNERS:true" \
  "/opt/aifeeds-cc-sync-releases:$ROOT_OWNERS:true" \
  "/etc:$ROOT_OWNERS:true" \
  "/etc/aifeeds:$ROOT_OWNERS:true" \
  "/etc/systemd/system:$ROOT_OWNERS:true" \
  "/var/lib:$ROOT_OWNERS:true"; do
  logical=${chain%%:*}
  remainder=${chain#*:}
  owners=${remainder%%:*}
  allow_missing=${remainder#*:}
  "$NODE" "$SECURITY_TOOL" validate-chain \
    "$PATH_BOUNDARY" "$logical" "$owners" "$allow_missing"
done
for chain in \
  "/var/lib/aifeeds-cc-sync:$WRITABLE_OWNERS:true" \
  "/www:$WEB_OWNERS:false" \
  "/www/wwwroot:$WEB_OWNERS:false" \
  "/www/wwwroot/ai-feeds.cc:$WEB_OWNERS:false" \
  "/www/wwwroot/ai-feeds.cc/i:$WRITABLE_OWNERS:true" \
  "/www/server/panel/vhost/nginx:$WEB_OWNERS:false"; do
  logical=${chain%%:*}
  remainder=${chain#*:}
  owners=${remainder%%:*}
  allow_missing=${remainder#*:}
  "$NODE" "$SECURITY_TOOL" validate-chain \
    "$PATH_BOUNDARY" "$logical" "$owners" "$allow_missing"
done

node_major=$("$NODE" -p 'Number(process.versions.node.split(".")[0])')
if [[ ! "$node_major" =~ ^[0-9]+$ ]] || ((node_major < 18)); then
  echo "ERROR: Node 18 or newer is required" >&2
  exit 1
fi
payload_tests=("$SNAPSHOT"/cc-site/sync/test/*.test.mjs)
if [[ ! -f "${payload_tests[0]}" ]]; then
  echo "ERROR: verified payload test suite is empty" >&2
  exit 1
fi
"$RUNUSER" -u aifeeds-sync -- env AIFEEDS_REMOTE_PAYLOAD_TEST=1 \
  "$NODE" --test "${payload_tests[@]}"

if [[ ! -d "$SITE_ROOT" || -L "$SITE_ROOT" ]]; then
  echo "ERROR: ai-feeds.cc site root is missing or unsafe" >&2
  exit 1
fi
if [[ ! -f "$VHOST" || -L "$VHOST" ]]; then
  echo "ERROR: ai-feeds.cc Nginx vhost is missing or unsafe" >&2
  exit 1
fi
"$INSTALL" -d -o root -g root -m 0700 "$ROLLBACK"
if [[ -L "$OPT" ]]; then
  old_opt_kind=symlink
  old_opt_target=$(readlink "$OPT")
elif [[ -e "$OPT" ]]; then
  echo "ERROR: existing live code path is not a managed symlink" >&2
  exit 1
fi
for state_query in \
  "timer_enabled_before:is-enabled:$TIMER" \
  "timer_active_before:is-active:$TIMER" \
  "service_active_before:is-active:$SERVICE"; do
  variable=${state_query%%:*}
  remainder=${state_query#*:}
  verb=${remainder%%:*}
  unit=${remainder#*:}
  state_value=$("$SYSTEMCTL" "$verb" "$unit" 2>/dev/null || true)
  case "$variable:$state_value" in
    timer_enabled_before:enabled) timer_enabled_before=enabled ;;
    timer_active_before:active) timer_active_before=active ;;
    service_active_before:active) service_active_before=active ;;
  esac
done
for backup in \
  "$ENV_FILE:env" \
  "$UNIT_DIR/$SERVICE:service" \
  "$UNIT_DIR/$TIMER:timer"; do
  destination=${backup%%:*}
  backup_name=${backup#*:}
  "$NODE" "$FILE_TOOL" capture "$destination" "$ROLLBACK" "$backup_name"
done
transaction_prepared=1

"$SYSTEMCTL" disable --now "$TIMER" >/dev/null 2>&1 || true
"$SYSTEMCTL" stop "$SERVICE" >/dev/null 2>&1 || true

"$INSTALL" -d -o root -g root -m 0755 "$RELEASES"
if [[ -e "$RELEASE" ]]; then
  echo "ERROR: immutable release already exists" >&2
  exit 1
fi
"$INSTALL" -d -o root -g root -m 0755 "$RELEASE"
release_created=1
cp -a "$SNAPSHOT/cc-site" "$RELEASE/cc-site"
"$CHOWN" -R root:root "$RELEASE"
find -P "$RELEASE" -type d -exec chmod 0755 {} +
find -P "$RELEASE" -type f -exec chmod 0644 {} +
chmod 0755 \
  "$RELEASE/cc-site/deploy.sh" \
  "$RELEASE/cc-site/sync/deploy-to-cc.sh" \
  "$RELEASE/cc-site/sync/install-remote.sh"

"$INSTALL" -d -o root -g root -m 0755 "$ETC_DIR" "$UNIT_DIR"
"$INSTALL" -d -o aifeeds-sync -g www -m 0750 "$STATE_DIR" "$ITEM_ROOT"
"$NODE" "$SECURITY_TOOL" validate-item-tree "$ITEM_ROOT"
"$CHOWN" -R aifeeds-sync:www "$ITEM_ROOT"
find -P "$ITEM_ROOT" -type d -exec chmod 0750 {} +
find -P "$ITEM_ROOT" -type f -exec chmod 0640 {} +

LIVE_TARGET="aifeeds-cc-sync-releases/$EXPECTED_MANIFEST_DIGEST/cc-site/sync"
"$NODE" "$SECURITY_TOOL" switch-symlink "$OPT" "$LIVE_TARGET"
"$NODE" "$FILE_TOOL" install \
  "$RELEASE/cc-site/sync/aifeeds-cc-sync.service" "$UNIT_DIR/$SERVICE" \
  0644 "$ROOT_UID" "$ROOT_GID"
"$NODE" "$FILE_TOOL" install \
  "$RELEASE/cc-site/sync/aifeeds-cc-sync.timer" "$UNIT_DIR/$TIMER" \
  0644 "$ROOT_UID" "$ROOT_GID"
"$NODE" "$FILE_TOOL" install "$ENV_SOURCE" "$ENV_FILE" \
  0600 "$ROOT_UID" "$ROOT_GID"

"$SYSTEMCTL" daemon-reload
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
"$RUNUSER" -u "$NGINX_USER" -- test -r "$CURRENT/ai-news/index.html"

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

"$NODE" "$NGINX_TRANSACTION_TOOL" prepare \
  "$VHOST" "$SNIPPET" "$OPT/nginx-content-mirror.conf" \
  "$ROLLBACK/nginx" "$ROOT_UID" "$ROOT_GID"
nginx_mutated=1
"$NODE" "$NGINX_TRANSACTION_TOOL" commit "$ROLLBACK/nginx"
"$NGINX" -t
"$NGINX" -s reload

SMOKE_DIR="$ROLLBACK/smoke"
"$INSTALL" -d -o root -g root -m 0700 "$SMOKE_DIR"
smoke_exact() {
  local label=$1
  local url=$2
  local expected=$3
  local output=$4
  local status
  if ! status=$(
    "$CURL" --silent --show-error --max-time 10 \
      --resolve ai-feeds.cc:443:127.0.0.1 \
      --output "$output" --write-out '%{http_code}' "$url"
  ); then
    echo "ERROR: local HTTPS smoke probe failed for $label" >&2
    return 1
  fi
  if [[ "$status" != 200 ]]; then
    echo "ERROR: local HTTPS smoke probe returned HTTP $status for $label" >&2
    return 1
  fi
  if ! cmp -s -- "$output" "$expected"; then
    echo "ERROR: local HTTPS smoke probe returned unexpected bytes for $label" >&2
    return 1
  fi
}

smoke_exact root-sitemap \
  https://ai-feeds.cc/sitemap.xml \
  "$CURRENT/sitemap.xml" "$SMOKE_DIR/root-sitemap.xml"
smoke_exact generation-sitemap \
  "https://ai-feeds.cc/sitemaps/$generation/$sitemap" \
  "$STATE_DIR/public/generations/$generation/sitemaps/$sitemap" \
  "$SMOKE_DIR/generation-sitemap.xml"
smoke_exact ai-news \
  https://ai-feeds.cc/ai-news/ \
  "$CURRENT/ai-news/index.html" "$SMOKE_DIR/ai-news.html"

"$SYSTEMCTL" enable --now "$TIMER"
nginx_mutated=0
deployment_committed=1
if ! "$NODE" "$SECURITY_TOOL" gc-releases "$RELEASES" "$OPT" 3 "$ROOT_UID"; then
  echo "WARNING: release garbage collection was skipped after deployment" >&2
fi
echo "✓ remote .cc sync deployment completed."
