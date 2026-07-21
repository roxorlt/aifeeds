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
  USERDEL=${AIFEEDS_USERDEL:?}
  GETENT=${AIFEEDS_GETENT:?}
  RUNUSER=${AIFEEDS_RUNUSER:?}
  NODE=${AIFEEDS_NODE_BIN:?}
  SYSTEMCTL=${AIFEEDS_SYSTEMCTL:?}
  NGINX=${AIFEEDS_NGINX:?}
  CURL=${AIFEEDS_CURL:?}
  FLOCK=${AIFEEDS_FLOCK:?}
  PYTHON=${AIFEEDS_PYTHON_BIN:?}
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
  USERDEL=/usr/sbin/userdel
  GETENT=/usr/bin/getent
  RUNUSER=/usr/sbin/runuser
  NODE=/usr/bin/node
  SYSTEMCTL=/usr/bin/systemctl
  NGINX=/www/server/nginx/sbin/nginx
  CURL=/usr/bin/curl
  FLOCK=/usr/bin/flock
  PYTHON=/usr/bin/python3
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
LINUX_FS_HELPER=${AIFEEDS_FIXED_LINUX_FS_HELPER:-$INSTALLER_DIR/deployment-linux-fs.py}
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
if [[ ! -f "$LINUX_FS_HELPER" || -L "$LINUX_FS_HELPER" ]]; then
  echo "ERROR: fixed Linux filesystem helper is missing or unsafe" >&2
  exit 1
fi
PATH_BOUNDARY=${DEPLOY_ROOT:-/}
if ! PYTHON=$("$NODE" "$SECURITY_TOOL" resolve-executable \
  "$PATH_BOUNDARY" "$PYTHON" /usr/bin "$ROOT_UID"); then
  echo "ERROR: fixed Python interpreter chain is missing or unsafe" >&2
  exit 1
fi
if [[ "$TEST_MODE" != 1 && "$(uname -s)" != Linux ]]; then
  echo "ERROR: snapshot directory transactions require Linux" >&2
  exit 1
fi

"$NODE" "$SECURITY_TOOL" validate-chain \
  "$PATH_BOUNDARY" /run "$ROOT_UID" false
if ! "$PYTHON" "$LINUX_FS_HELPER" probe \
  "$(rooted /run)" "$ROOT_UID" "$ROOT_GID"; then
  echo "ERROR: required Linux filesystem transaction capability is unavailable" >&2
  exit 1
fi
LOCK_FILE=$("$NODE" "$SECURITY_TOOL" prepare-lock \
  "$PATH_BOUNDARY" "$ROOT_UID" "$ROOT_GID")
exec 9<>"$LOCK_FILE"
if ! "$FLOCK" -n 9; then
  echo "ERROR: another aifeeds .cc deployment is in progress" >&2
  exit 75
fi

SNAPSHOT_PARENT=$(rooted /var/lib/aifeeds-cc-deploy-snapshots)
"$NODE" "$SECURITY_TOOL" validate-chain \
  "$PATH_BOUNDARY" /var "$ROOT_UID" false
"$NODE" "$SECURITY_TOOL" validate-chain \
  "$PATH_BOUNDARY" /var/lib "$ROOT_UID" false
"$NODE" "$SECURITY_TOOL" ensure-snapshot-parent \
  "$SNAPSHOT_PARENT" "$ROOT_UID" "$ROOT_GID" >/dev/null
SNAPSHOT=$(mktemp -d "$SNAPSHOT_PARENT/aifeeds-cc-root-snapshot.XXXXXX")
IFS=$'\t' read -r snapshot_dev snapshot_ino snapshot_uid snapshot_gid snapshot_mode < <(
  "$PYTHON" "$LINUX_FS_HELPER" inspect-directory "$SNAPSHOT"
)
ROLLBACK="$SNAPSHOT/.rollback"
TIMER=aifeeds-cc-sync.timer
SERVICE=aifeeds-cc-sync.service
nginx_mutated=0
transaction_prepared=0
deployment_committed=0
release_created=0
release_stage=""
service_load_before=""
timer_load_before=""
timer_enabled_before=""
timer_active_before=inactive
service_active_before=inactive
service_quiesced=0
timer_quiesced=0
timer_disabled=0
new_service_start_attempted=0
new_timer_activation_attempted=0
recovery_in_progress=0
PREPARING_NGINX_TRANSACTION="$ROLLBACK/nginx"
opt_switched=0
env_installed=0
service_installed=0
timer_installed=0
sync_account_created=0
sync_passwd_recorded=""
state_root_created=0
state_root_dev=""
state_root_ino=""
item_root_created=0
item_root_dev=""
item_root_ino=""

cleanup_snapshot() {
  if [[ ! -e "$SNAPSHOT" && ! -L "$SNAPSHOT" ]]; then return 0; fi
  "$PYTHON" "$LINUX_FS_HELPER" remove-directory-bound \
    "$SNAPSHOT" "$snapshot_dev" "$snapshot_ino" \
    "$snapshot_uid" "$snapshot_gid" "$snapshot_mode"
}

cleanup_created_roots() {
  local failed=0
  if ((item_root_created == 1)); then
    if "$NODE" "$SECURITY_TOOL" remove-created-root \
      "$ITEM_ROOT" "$item_root_dev" "$item_root_ino" \
      "$SYNC_UID" "$WWW_GID" items; then
      item_root_created=0
    else
      failed=1
    fi
  fi
  if ((state_root_created == 1)); then
    if "$NODE" "$SECURITY_TOOL" remove-created-root \
      "$STATE_DIR" "$state_root_dev" "$state_root_ino" \
      "$SYNC_UID" "$WWW_GID" state; then
      state_root_created=0
    else
      failed=1
    fi
  fi
  return "$failed"
}

cleanup_created_account() {
  if ((sync_account_created == 0)); then return 0; fi
  if ((state_root_created == 1 || item_root_created == 1)); then
    echo "ERROR: rollback conflict: created sync account still owns managed roots" >&2
    return 1
  fi
  local current_passwd
  if ! current_passwd=$("$GETENT" passwd aifeeds-sync); then
    echo "ERROR: rollback conflict: unable to verify created sync account" >&2
    return 1
  fi
  if [[ "$current_passwd" != "$sync_passwd_recorded" ]]; then
    echo "ERROR: rollback conflict: created sync account changed" >&2
    return 1
  fi
  "$USERDEL" aifeeds-sync
  if "$GETENT" passwd aifeeds-sync >/dev/null 2>&1; then
    echo "ERROR: unable to remove created sync account" >&2
    return 1
  fi
  sync_account_created=0
}

record_recovery_step() {
  "$NODE" "$FILE_TOOL" recovery-step \
    "$GLOBAL_PREPARING" "$GLOBAL_COMMITTED" "$GLOBAL_JOURNAL_DIR" \
    "$RELEASES" "$ROOT_UID" "$ROOT_GID" \
    "$OPT" "$UNIT_DIR/$SERVICE" "$UNIT_DIR/$TIMER" "$ENV_FILE" \
    "$1" "$2"
}

begin_recovery_step() {
  local result
  result=$(record_recovery_step "$1" attempted) || return $?
  case "$result" in
    attempted) return 0 ;;
    completed) return 2 ;;
    *) echo "ERROR: invalid recovery step result for $1" >&2; return 1 ;;
  esac
}

complete_recovery_step() {
  local result
  result=$(record_recovery_step "$1" completed) || return $?
  [[ "$result" == completed ]]
}

begin_or_skip_recovery_step() {
  begin_recovery_step "$1"
  local status=$?
  if ((status == 2)); then return 3; fi
  if ((status != 0)); then return "$status"; fi
  return 0
}

stop_candidate_timer() {
  local step=candidate_timer_stop
  local command_status=0
  if begin_or_skip_recovery_step "$step"; then
    :
  else
    local status=$?
    if ((status == 3)); then return 0; fi
    return "$status"
  fi
  capture_systemctl is-active "$TIMER"
  case "$SYSTEMCTL_STATUS:$SYSTEMCTL_OUTPUT" in
    3:inactive) ;;
    0:active)
      "$SYSTEMCTL" stop "$TIMER" >/dev/null 2>&1 || command_status=$?
      capture_systemctl is-active "$TIMER"
      [[ "$SYSTEMCTL_STATUS:$SYSTEMCTL_OUTPUT" == 3:inactive ]] || return 1
      ;;
    *) return 1 ;;
  esac
  complete_recovery_step "$step" || return $?
  return "$command_status"
}

disable_candidate_timer() {
  local step=candidate_timer_disable
  local command_status=0
  if begin_or_skip_recovery_step "$step"; then
    :
  else
    local status=$?
    if ((status == 3)); then return 0; fi
    return "$status"
  fi
  capture_systemctl is-enabled "$TIMER"
  case "$SYSTEMCTL_STATUS:$SYSTEMCTL_OUTPUT" in
    1:disabled|4:not-found) ;;
    0:enabled)
      "$SYSTEMCTL" disable "$TIMER" >/dev/null 2>&1 || command_status=$?
      capture_systemctl is-enabled "$TIMER"
      [[ "$SYSTEMCTL_STATUS:$SYSTEMCTL_OUTPUT" == 1:disabled \
        || "$SYSTEMCTL_STATUS:$SYSTEMCTL_OUTPUT" == 4:not-found ]] || return 1
      ;;
    *) return 1 ;;
  esac
  complete_recovery_step "$step" || return $?
  return "$command_status"
}

stop_candidate_service() {
  local step=candidate_service_stop
  local command_status=0
  if begin_or_skip_recovery_step "$step"; then
    :
  else
    local status=$?
    if ((status == 3)); then return 0; fi
    return "$status"
  fi
  capture_systemctl is-active "$SERVICE"
  case "$SYSTEMCTL_STATUS:$SYSTEMCTL_OUTPUT" in
    3:inactive) ;;
    0:active|0:activating)
      "$SYSTEMCTL" stop "$SERVICE" >/dev/null 2>&1 || command_status=$?
      capture_systemctl is-active "$SERVICE"
      [[ "$SYSTEMCTL_STATUS:$SYSTEMCTL_OUTPUT" == 3:inactive ]] || return 1
      ;;
    *) return 1 ;;
  esac
  complete_recovery_step "$step" || return $?
  return "$command_status"
}

stop_candidate_units() {
  stop_candidate_timer || return $?
  disable_candidate_timer || return $?
  stop_candidate_service || return $?
}

rollback_nginx() {
  local step=nginx_rollback
  if begin_or_skip_recovery_step "$step"; then
    :
  else
    local status=$?
    if ((status == 3)); then return 0; fi
    return "$status"
  fi
  if [[ -e "$PREPARING_NGINX_TRANSACTION" \
    || -L "$PREPARING_NGINX_TRANSACTION" ]]; then
    if [[ ! -d "$PREPARING_NGINX_TRANSACTION" \
      || -L "$PREPARING_NGINX_TRANSACTION" ]]; then
      echo "ERROR: recovered Nginx transaction is unsafe" >&2
      return 1
    fi
    "$NODE" "$NGINX_TRANSACTION_TOOL" rollback \
      "$PREPARING_NGINX_TRANSACTION" || return $?
    "$NGINX" -t || return $?
    "$NGINX" -s reload || return $?
  fi
  complete_recovery_step "$step"
}

rollback_preparing_paths() {
  local step=paths_rollback
  if begin_or_skip_recovery_step "$step"; then
    :
  else
    local status=$?
    if ((status == 3)); then return 0; fi
    return "$status"
  fi
  "$NODE" "$FILE_TOOL" rollback-preparing \
    "$GLOBAL_PREPARING" "$GLOBAL_COMMITTED" "$GLOBAL_JOURNAL_DIR" \
    "$RELEASES" "$ROOT_UID" "$ROOT_GID" \
    "$OPT" "$UNIT_DIR/$SERVICE" "$UNIT_DIR/$TIMER" "$ENV_FILE" \
    >/dev/null || return $?
  complete_recovery_step "$step"
}

reload_recovered_units() {
  local step=daemon_reload
  if begin_or_skip_recovery_step "$step"; then
    :
  else
    local status=$?
    if ((status == 3)); then return 0; fi
    return "$status"
  fi
  "$SYSTEMCTL" daemon-reload >/dev/null 2>&1 || return $?
  complete_recovery_step "$step"
}

restore_original_service_state() {
  local step=restore_service
  if begin_or_skip_recovery_step "$step"; then
    :
  else
    local status=$?
    if ((status == 3)); then return 0; fi
    return "$status"
  fi
  capture_systemctl is-active "$SERVICE"
  case "$service_active_before:$SYSTEMCTL_STATUS:$SYSTEMCTL_OUTPUT" in
    active:0:active|active:0:activating|activating:0:active|activating:0:activating)
      ;;
    active:3:inactive|activating:3:inactive)
      "$SYSTEMCTL" start "$SERVICE" >/dev/null 2>&1 || return 1
      capture_systemctl is-active "$SERVICE"
      [[ "$SYSTEMCTL_STATUS:$SYSTEMCTL_OUTPUT" == 0:active \
        || "$SYSTEMCTL_STATUS:$SYSTEMCTL_OUTPUT" == 0:activating ]] || return 1 ;;
    inactive:3:inactive)
      ;;
    inactive:0:active|inactive:0:activating)
      "$SYSTEMCTL" stop "$SERVICE" >/dev/null 2>&1 || return 1
      capture_systemctl is-active "$SERVICE"
      [[ "$SYSTEMCTL_STATUS:$SYSTEMCTL_OUTPUT" == 3:inactive ]] || return 1 ;;
    *)
      return 1 ;;
  esac
  complete_recovery_step "$step"
}

restore_original_timer_enablement() {
  local step=restore_timer_enablement
  if begin_or_skip_recovery_step "$step"; then
    :
  else
    local status=$?
    if ((status == 3)); then return 0; fi
    return "$status"
  fi
  capture_systemctl is-enabled "$TIMER"
  case "$timer_enabled_before:$SYSTEMCTL_STATUS:$SYSTEMCTL_OUTPUT" in
    enabled:0:enabled)
      ;;
    enabled:1:disabled)
      "$SYSTEMCTL" enable "$TIMER" >/dev/null 2>&1 || return 1
      capture_systemctl is-enabled "$TIMER"
      [[ "$SYSTEMCTL_STATUS:$SYSTEMCTL_OUTPUT" == 0:enabled ]] || return 1 ;;
    disabled:1:disabled|not-found:4:not-found)
      ;;
    disabled:0:enabled)
      "$SYSTEMCTL" disable "$TIMER" >/dev/null 2>&1 || return 1
      capture_systemctl is-enabled "$TIMER"
      [[ "$SYSTEMCTL_STATUS:$SYSTEMCTL_OUTPUT" == 1:disabled ]] || return 1 ;;
    *)
      return 1 ;;
  esac
  complete_recovery_step "$step"
}

restore_original_timer_activity() {
  local step=restore_timer_activity
  if begin_or_skip_recovery_step "$step"; then
    :
  else
    local status=$?
    if ((status == 3)); then return 0; fi
    return "$status"
  fi
  capture_systemctl is-active "$TIMER"
  case "$timer_active_before:$SYSTEMCTL_STATUS:$SYSTEMCTL_OUTPUT" in
    active:0:active)
      ;;
    active:3:inactive)
      "$SYSTEMCTL" start "$TIMER" >/dev/null 2>&1 || return 1
      capture_systemctl is-active "$TIMER"
      [[ "$SYSTEMCTL_STATUS:$SYSTEMCTL_OUTPUT" == 0:active ]] || return 1 ;;
    inactive:3:inactive)
      ;;
    inactive:0:active)
      "$SYSTEMCTL" stop "$TIMER" >/dev/null 2>&1 || return 1
      capture_systemctl is-active "$TIMER"
      [[ "$SYSTEMCTL_STATUS:$SYSTEMCTL_OUTPUT" == 3:inactive ]] || return 1 ;;
    *)
      return 1 ;;
  esac
  complete_recovery_step "$step"
}

recover_preparing_install() {
  recovery_in_progress=1
  stop_candidate_units || return $?
  rollback_nginx || return $?
  rollback_preparing_paths || return $?
  reload_recovered_units || return $?
  restore_original_service_state || return $?
  restore_original_timer_enablement || return $?
  restore_original_timer_activity || return $?
  "$NODE" "$FILE_TOOL" complete-preparing \
    "$GLOBAL_PREPARING" "$GLOBAL_COMMITTED" "$GLOBAL_JOURNAL_DIR" \
    "$RELEASES" "$ROOT_UID" "$ROOT_GID" \
    "$OPT" "$UNIT_DIR/$SERVICE" "$UNIT_DIR/$TIMER" "$ENV_FILE" >/dev/null \
    || return $?
  recovery_in_progress=0
}

rollback_install() {
  local failed=0
  recover_preparing_install || failed=1
  cleanup_created_roots || failed=1
  service_quiesced=0
  timer_disabled=0
  timer_quiesced=0
  if ((release_created == 1)); then
    rm -rf -- "$RELEASE" || failed=1
  fi
  if [[ -n "$release_stage" && -d "$RELEASES" ]]; then
    "$NODE" "$SECURITY_TOOL" cleanup-release-artifacts \
      "$RELEASES" "$ROOT_UID" "$ROOT_GID" || failed=1
  fi
  return "$failed"
}

on_exit() {
  local status=$?
  local preserve_snapshot=0
  trap - EXIT
  set +e
  if ((status != 0 && transaction_prepared == 1 \
    && deployment_committed == 0 && recovery_in_progress == 0)); then
    if ! rollback_install; then
      echo "ERROR: deployment rollback was incomplete" >&2
      status=70
      preserve_snapshot=1
    fi
  elif ((status != 0 && transaction_prepared == 1 \
    && deployment_committed == 0 && recovery_in_progress == 1)); then
    preserve_snapshot=1
  fi
  if ((status != 0 && deployment_committed == 0)); then
    if ! cleanup_created_roots || ! cleanup_created_account; then
      echo "ERROR: deployment side-effect cleanup was incomplete" >&2
      status=70
    fi
  fi
  if ((preserve_snapshot == 1)); then
    echo "WARNING: preserving rollback snapshot for preparing recovery: $SNAPSHOT" >&2
    rm -rf -- "$STAGING"
  else
    if ! cleanup_snapshot; then
      echo "ERROR: root snapshot cleanup was incomplete" >&2
      status=70
    fi
    rm -rf -- "$STAGING"
  fi
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
IFS=$'\t' read -r snapshot_dev snapshot_ino snapshot_uid snapshot_gid snapshot_mode < <(
  "$PYTHON" "$LINUX_FS_HELPER" inspect-directory "$SNAPSHOT"
)

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
GLOBAL_PREPARING="$RELEASES/.deployment-preparing.json"
GLOBAL_COMMITTED="$RELEASES/.deployment-committed.json"
GLOBAL_JOURNAL_DIR="$RELEASES/.deployment-journal"
ETC_DIR=$(rooted /etc/aifeeds)
ENV_FILE="$ETC_DIR/cc-sync.env"
UNIT_DIR=$(rooted /etc/systemd/system)
STATE_DIR=$(rooted /var/lib/aifeeds-cc-sync)
SITE_ROOT=$(rooted /www/wwwroot/ai-feeds.cc)
ITEM_ROOT="$SITE_ROOT/i"
VHOST_DIR=$(rooted /www/server/panel/vhost/nginx)
VHOST="$VHOST_DIR/html_ai-feeds.cc.conf"
SNIPPET="$VHOST_DIR/aifeeds-cc-content-mirror.conf"

SYSTEMCTL_OUTPUT=""
SYSTEMCTL_STATUS=0
capture_systemctl() {
  local restore_errexit=0
  if [[ $- == *e* ]]; then restore_errexit=1; fi
  set +e
  SYSTEMCTL_OUTPUT=$("$SYSTEMCTL" "$@" 2>/dev/null)
  SYSTEMCTL_STATUS=$?
  if ((restore_errexit == 1)); then set -e; fi
  return 0
}

abort_unmodified_preparation() {
  if ((transaction_prepared != 1 || nginx_mutated != 0 \
    || release_created != 0 || opt_switched != 0 || env_installed != 0 \
    || service_installed != 0 || timer_installed != 0 \
    || service_quiesced != 0 || timer_quiesced != 0 || timer_disabled != 0 \
    || new_service_start_attempted != 0 || new_timer_activation_attempted != 0)); then
    return 1
  fi
  capture_systemctl is-active "$SERVICE"
  case "$service_active_before:$SYSTEMCTL_STATUS:$SYSTEMCTL_OUTPUT" in
    active:0:active|activating:0:activating|inactive:3:inactive) ;;
    *) return 1 ;;
  esac
  capture_systemctl is-active "$TIMER"
  case "$timer_active_before:$SYSTEMCTL_STATUS:$SYSTEMCTL_OUTPUT" in
    active:0:active|inactive:3:inactive) ;;
    *) return 1 ;;
  esac
  capture_systemctl is-enabled "$TIMER"
  case "$timer_enabled_before:$SYSTEMCTL_STATUS:$SYSTEMCTL_OUTPUT" in
    enabled:0:enabled|disabled:1:disabled|not-found:4:not-found) ;;
    *) return 1 ;;
  esac
  "$NODE" "$FILE_TOOL" abort-unmodified-preparing \
    "$GLOBAL_PREPARING" "$GLOBAL_COMMITTED" "$GLOBAL_JOURNAL_DIR" \
    "$RELEASES" "$ROOT_UID" "$ROOT_GID" \
    "$OPT" "$UNIT_DIR/$SERVICE" "$UNIT_DIR/$TIMER" "$ENV_FILE" \
    >/dev/null || return $?
  transaction_prepared=0
}

if [[ -L "$OPT" ]]; then
  "$NODE" "$SECURITY_TOOL" validate-live-release \
    "$OPT" "$RELEASES" "$ROOT_UID" "$ROOT_GID" >/dev/null
elif [[ -e "$OPT" ]]; then
  echo "ERROR: existing live code path is not a managed symlink" >&2
  exit 1
fi

capture_systemctl show --property=LoadState --value "$SERVICE"
if ((SYSTEMCTL_STATUS != 0)); then
  echo "ERROR: unable to query systemd service load state" >&2
  exit 1
fi
service_load_before=$SYSTEMCTL_OUTPUT
case "$service_load_before" in
  loaded|not-found) ;;
  *) echo "ERROR: unsupported systemd state for $SERVICE: $service_load_before" >&2; exit 1 ;;
esac

capture_systemctl show --property=LoadState --value "$TIMER"
if ((SYSTEMCTL_STATUS != 0)); then
  echo "ERROR: unable to query systemd timer load state" >&2
  exit 1
fi
timer_load_before=$SYSTEMCTL_OUTPUT
case "$timer_load_before" in
  loaded|not-found) ;;
  *) echo "ERROR: unsupported systemd state for $TIMER: $timer_load_before" >&2; exit 1 ;;
esac

capture_systemctl is-active "$SERVICE"
case "$SYSTEMCTL_STATUS:$SYSTEMCTL_OUTPUT" in
  0:active) service_active_before=active ;;
  0:activating) service_active_before=activating ;;
  3:inactive) service_active_before=inactive ;;
  *)
    echo "ERROR: unsupported systemd state for $SERVICE: $SYSTEMCTL_OUTPUT" >&2
    exit 1 ;;
esac
if [[ "$service_load_before" == not-found \
  && "$service_active_before" != inactive ]]; then
  echo "ERROR: unsupported systemd state for absent $SERVICE" >&2
  exit 1
fi

capture_systemctl is-active "$TIMER"
case "$SYSTEMCTL_STATUS:$SYSTEMCTL_OUTPUT" in
  0:active) timer_active_before=active ;;
  3:inactive) timer_active_before=inactive ;;
  *)
    echo "ERROR: unsupported systemd state for $TIMER: $SYSTEMCTL_OUTPUT" >&2
    exit 1 ;;
esac
if [[ "$timer_load_before" == not-found && "$timer_active_before" != inactive ]]; then
  echo "ERROR: unsupported systemd state for absent $TIMER" >&2
  exit 1
fi

capture_systemctl is-enabled "$TIMER"
case "$SYSTEMCTL_STATUS:$SYSTEMCTL_OUTPUT" in
  0:enabled) timer_enabled_before=enabled ;;
  1:disabled) timer_enabled_before=disabled ;;
  4:not-found) timer_enabled_before=not-found ;;
  *)
    echo "ERROR: unsupported systemd state for $TIMER: $SYSTEMCTL_OUTPUT" >&2
    exit 1 ;;
esac
if [[ "$timer_load_before:$timer_enabled_before" != loaded:enabled \
  && "$timer_load_before:$timer_enabled_before" != loaded:disabled \
  && "$timer_load_before:$timer_enabled_before" != not-found:not-found ]]; then
  echo "ERROR: unsupported systemd state combination for $TIMER" >&2
  exit 1
fi

ROOT_OWNERS="$ROOT_UID"
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
# Account creation is a deliberately narrow, non-transactional bootstrap side
# effect. All root-owned path chains are validated before reaching this point.
if ! sync_passwd=$("$GETENT" passwd aifeeds-sync); then
  "$USERADD" -r -g www -d /nonexistent -s /sbin/nologin aifeeds-sync
  sync_account_created=1
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
sync_passwd_recorded=$sync_passwd

WEB_OWNERS="$ROOT_UID,$WWW_UID"
WRITABLE_OWNERS="$ROOT_UID,$WWW_UID,$SYNC_UID"
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

global_recovery=$("$NODE" "$FILE_TOOL" recover-global \
  "$GLOBAL_PREPARING" "$GLOBAL_COMMITTED" "$GLOBAL_JOURNAL_DIR" \
  "$RELEASES" "$ROOT_UID" "$ROOT_GID" \
  "$OPT" "$UNIT_DIR/$SERVICE" "$UNIT_DIR/$TIMER" "$ENV_FILE")
recovery_phase=""
recovery_manifest=""
recovery_nginx=""
recovery_service_active=""
recovery_timer_active=""
recovery_timer_enabled=""
IFS=$'\t' read -r \
  recovery_phase recovery_manifest recovery_nginx recovery_service_active \
  recovery_timer_active recovery_timer_enabled <<< "$global_recovery"
case "$recovery_phase" in
  none|committed) ;;
  preparing)
    [[ "$recovery_manifest" =~ ^[0-9a-f]{64}$ ]] || {
      echo "ERROR: invalid recovered preparing manifest" >&2
      exit 1
    }
    service_active_before=$recovery_service_active
    timer_active_before=$recovery_timer_active
    timer_enabled_before=$recovery_timer_enabled
    PREPARING_NGINX_TRANSACTION=$recovery_nginx
    recover_preparing_install
    ;;
  *)
    echo "ERROR: invalid global deployment recovery phase" >&2
    exit 1 ;;
esac
unset global_recovery recovery_phase recovery_manifest recovery_nginx
unset recovery_service_active recovery_timer_active recovery_timer_enabled

if [[ -L "$OPT" ]]; then
  "$NODE" "$SECURITY_TOOL" validate-live-release \
    "$OPT" "$RELEASES" "$ROOT_UID" "$ROOT_GID" >/dev/null
elif [[ -e "$OPT" ]]; then
  echo "ERROR: existing live code path is not a managed symlink" >&2
  exit 1
fi

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
"$INSTALL" -d -o root -g root -m 0755 "$RELEASES" "$ETC_DIR" "$UNIT_DIR"
"$NODE" "$SECURITY_TOOL" cleanup-release-artifacts \
  "$RELEASES" "$ROOT_UID" "$ROOT_GID"
for backup in \
  "$ENV_FILE:env" \
  "$UNIT_DIR/$SERVICE:service" \
  "$UNIT_DIR/$TIMER:timer"; do
  destination=${backup%%:*}
  backup_name=${backup#*:}
  "$NODE" "$FILE_TOOL" capture "$destination" "$ROLLBACK" "$backup_name"
done
"$NODE" "$FILE_TOOL" prepare-global \
  "$GLOBAL_PREPARING" "$GLOBAL_COMMITTED" "$GLOBAL_JOURNAL_DIR" \
  "$RELEASES" "$RELEASE" "$EXPECTED_MANIFEST_DIGEST" "$ROLLBACK/nginx" \
  "$ROOT_UID" "$ROOT_GID" \
  "$OPT" "$UNIT_DIR/$SERVICE" "$UNIT_DIR/$TIMER" "$ENV_FILE" \
  "$service_active_before" "$timer_active_before" "$timer_enabled_before"
transaction_prepared=1

if [[ "$service_active_before" == active \
  || "$service_active_before" == activating ]]; then
  set +e
  "$SYSTEMCTL" stop "$SERVICE" >/dev/null 2>&1
  service_stop_status=$?
  set -e
  capture_systemctl is-active "$SERVICE"
  case "$SYSTEMCTL_STATUS:$SYSTEMCTL_OUTPUT" in
    3:inactive) service_quiesced=1 ;;
    0:active|0:activating) service_quiesced=0 ;;
    *)
      echo "ERROR: unsupported post-stop systemd state for $SERVICE: $SYSTEMCTL_OUTPUT" >&2
      exit 1 ;;
  esac
  if ((service_stop_status != 0)); then
    echo "ERROR: systemctl stop failed for $SERVICE" >&2
    abort_unmodified_preparation || true
    exit "$service_stop_status"
  fi
  if ((service_quiesced != 1)); then
    echo "ERROR: unable to stop $SERVICE cleanly" >&2
    exit 1
  fi
fi
if [[ "$timer_active_before" == active ]]; then
  set +e
  "$SYSTEMCTL" stop "$TIMER" >/dev/null 2>&1
  timer_stop_status=$?
  set -e
  capture_systemctl is-active "$TIMER"
  case "$SYSTEMCTL_STATUS:$SYSTEMCTL_OUTPUT" in
    3:inactive) timer_quiesced=1 ;;
    0:active) timer_quiesced=0 ;;
    *)
      echo "ERROR: unsupported post-stop systemd state for $TIMER: $SYSTEMCTL_OUTPUT" >&2
      exit 1 ;;
  esac
  if ((timer_stop_status != 0)); then
    echo "ERROR: systemctl stop failed for $TIMER" >&2
    exit "$timer_stop_status"
  fi
  if ((timer_quiesced != 1)); then
    echo "ERROR: unable to stop $TIMER cleanly" >&2
    exit 1
  fi
fi
if [[ "$timer_enabled_before" == enabled ]]; then
  set +e
  "$SYSTEMCTL" disable "$TIMER" >/dev/null 2>&1
  timer_disable_status=$?
  set -e
  capture_systemctl is-enabled "$TIMER"
  case "$SYSTEMCTL_STATUS:$SYSTEMCTL_OUTPUT" in
    1:disabled) timer_disabled=1 ;;
    0:enabled) timer_disabled=0 ;;
    *)
      echo "ERROR: unsupported post-disable systemd state for $TIMER: $SYSTEMCTL_OUTPUT" >&2
      exit 1 ;;
  esac
  if ((timer_disable_status != 0)); then
    echo "ERROR: systemctl disable failed for $TIMER" >&2
    exit "$timer_disable_status"
  fi
  if ((timer_disabled != 1)); then
    echo "ERROR: unable to disable $TIMER cleanly" >&2
    exit 1
  fi
fi

if [[ -L "$OPT" ]]; then
  "$NODE" "$SECURITY_TOOL" validate-live-release \
    "$OPT" "$RELEASES" "$ROOT_UID" "$ROOT_GID" >/dev/null
elif [[ -e "$OPT" ]]; then
  echo "ERROR: existing live code path is not a managed symlink" >&2
  exit 1
fi
release_stage=$("$NODE" "$SECURITY_TOOL" create-release-stage \
  "$RELEASES" "$EXPECTED_MANIFEST_DIGEST" "$ROOT_UID" "$ROOT_GID")
cp -a "$SNAPSHOT/cc-site" "$release_stage/cc-site"
cp -a "$SNAPSHOT/MANIFEST.sha256" "$release_stage/MANIFEST.sha256"
"$CHOWN" -R root:root "$release_stage"
find -P "$release_stage" -type d -exec chmod 0755 {} +
find -P "$release_stage" -type f -exec chmod 0644 {} +
chmod 0755 \
  "$release_stage/cc-site/deploy.sh" \
  "$release_stage/cc-site/sync/deploy-to-cc.sh" \
  "$release_stage/cc-site/sync/install-remote.sh"
"$NODE" "$SECURITY_TOOL" verify-release \
  "$release_stage" "$SNAPSHOT" "$EXPECTED_MANIFEST_DIGEST" \
  "$ROOT_UID" "$ROOT_GID" >/dev/null
release_action=$("$NODE" "$SECURITY_TOOL" publish-release \
  "$release_stage" "$RELEASE" "$OPT" "$SNAPSHOT" \
  "$EXPECTED_MANIFEST_DIGEST" "$ROOT_UID" "$ROOT_GID")
release_stage=""
case "$release_action" in
  created|replaced) release_created=1 ;;
  reused) ;;
  *) echo "ERROR: invalid release publication result" >&2; exit 1 ;;
esac

IFS=$'\t' read -r state_root_created state_root_dev state_root_ino < <(
  "$NODE" "$SECURITY_TOOL" ensure-managed-root \
    "$STATE_DIR" "$SYNC_UID" "$WWW_GID" state
)
IFS=$'\t' read -r item_root_created item_root_dev item_root_ino < <(
  "$NODE" "$SECURITY_TOOL" ensure-managed-root \
    "$ITEM_ROOT" "$SYNC_UID" "$WWW_GID" items
)

LIVE_TARGET="aifeeds-cc-sync-releases/$EXPECTED_MANIFEST_DIGEST/cc-site/sync"
opt_switched=1
"$NODE" "$FILE_TOOL" install-symlink-transaction \
  "$OPT" "$LIVE_TARGET" opt "$EXPECTED_MANIFEST_DIGEST" \
  "$GLOBAL_PREPARING" "$GLOBAL_JOURNAL_DIR" "$ROOT_UID" "$ROOT_GID"
service_installed=1
"$NODE" "$FILE_TOOL" install-transaction \
  "$RELEASE/cc-site/sync/aifeeds-cc-sync.service" "$UNIT_DIR/$SERVICE" \
  0644 "$ROOT_UID" "$ROOT_GID" "$ROLLBACK" service \
  "$EXPECTED_MANIFEST_DIGEST" "$GLOBAL_PREPARING" "$GLOBAL_JOURNAL_DIR"
timer_installed=1
"$NODE" "$FILE_TOOL" install-transaction \
  "$RELEASE/cc-site/sync/aifeeds-cc-sync.timer" "$UNIT_DIR/$TIMER" \
  0644 "$ROOT_UID" "$ROOT_GID" "$ROLLBACK" timer \
  "$EXPECTED_MANIFEST_DIGEST" "$GLOBAL_PREPARING" "$GLOBAL_JOURNAL_DIR"
env_installed=1
"$NODE" "$FILE_TOOL" install-transaction "$ENV_SOURCE" "$ENV_FILE" \
  0600 "$ROOT_UID" "$ROOT_GID" "$ROLLBACK" env \
  "$EXPECTED_MANIFEST_DIGEST" "$GLOBAL_PREPARING" "$GLOBAL_JOURNAL_DIR"

"$SYSTEMCTL" daemon-reload
new_service_start_attempted=1
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

new_timer_activation_attempted=1
"$SYSTEMCTL" enable --now "$TIMER"
set +e
"$NODE" "$FILE_TOOL" commit-global \
  "$GLOBAL_PREPARING" "$GLOBAL_COMMITTED" "$GLOBAL_JOURNAL_DIR" \
  "$RELEASES" "$RELEASE" "$EXPECTED_MANIFEST_DIGEST" \
  "$ROOT_UID" "$ROOT_GID" \
  "$OPT" "$UNIT_DIR/$SERVICE" "$UNIT_DIR/$TIMER" "$ENV_FILE"
global_commit_status=$?
set -e
if ((global_commit_status != 0)); then
  set +e
  committed_recovery=$("$NODE" "$FILE_TOOL" recover-global \
    "$GLOBAL_PREPARING" "$GLOBAL_COMMITTED" "$GLOBAL_JOURNAL_DIR" \
    "$RELEASES" "$ROOT_UID" "$ROOT_GID" \
    "$OPT" "$UNIT_DIR/$SERVICE" "$UNIT_DIR/$TIMER" "$ENV_FILE")
  committed_recovery_status=$?
  set -e
  if ((committed_recovery_status == 0)) \
    && [[ "$committed_recovery" == committed ]]; then
    deployment_committed=1
  else
    echo "ERROR: failed global commit did not validate as committed" >&2
    exit "$global_commit_status"
  fi
else
  deployment_committed=1
fi
nginx_mutated=0
for installed in \
  "$OPT:opt" \
  "$UNIT_DIR/$SERVICE:service" \
  "$UNIT_DIR/$TIMER:timer" \
  "$ENV_FILE:env"; do
  installed_destination=${installed%%:*}
  installed_name=${installed#*:}
  if ! "$NODE" "$FILE_TOOL" finalize-path \
    "$installed_destination" "$installed_name" "$EXPECTED_MANIFEST_DIGEST"; then
    echo "WARNING: committed deployment finalization failed for $installed_name; retrying next deployment" >&2
  fi
done
global_clear_result=""
if ! global_clear_result=$("$NODE" "$FILE_TOOL" clear-global \
  "$GLOBAL_COMMITTED" "$GLOBAL_JOURNAL_DIR" "$RELEASES" \
  "$ROOT_UID" "$ROOT_GID" \
  "$OPT" "$UNIT_DIR/$SERVICE" "$UNIT_DIR/$TIMER" "$ENV_FILE"); then
  echo "WARNING: committed deployment journal cleanup failed; retrying next deployment" >&2
elif [[ "$global_clear_result" == pending ]]; then
  echo "WARNING: committed deployment receipts remain; retrying next deployment" >&2
elif [[ "$global_clear_result" != cleared ]]; then
  echo "WARNING: committed deployment journal returned an unexpected cleanup state" >&2
fi
if ! "$NODE" "$SECURITY_TOOL" gc-releases \
  "$RELEASES" "$OPT" 3 "$ROOT_UID" "$ROOT_GID"; then
  echo "WARNING: release garbage collection was skipped after deployment" >&2
fi
echo "✓ remote .cc sync deployment completed."
