#!/usr/bin/env bash
set -euo pipefail
umask 077

SITE=/etc/nginx/sites-available/aifeeds.conf
ENABLED_SITE=/etc/nginx/sites-enabled/aifeeds.conf
FORMAT=/etc/nginx/conf.d/aifeeds-performance-log.conf
ROTATE=/etc/aifeeds-performance-logrotate.conf
ROTATION_LOGROTATE=/usr/sbin/logrotate
LOG=/var/log/nginx/aifeeds-performance.jsonl
CHECKER=/usr/local/sbin/aifeeds-check-nginx-request-id
DIFF_CHECKER=/usr/local/sbin/aifeeds-verify-nginx-request-id-diff
INSERTER=/usr/local/sbin/aifeeds-insert-nginx-request-id
SERVICE_PATH=/etc/systemd/system/aifeeds-performance-logrotate.service
TIMER_PATH=/etc/systemd/system/aifeeds-performance-logrotate.timer
TIMER_UNIT=aifeeds-performance-logrotate.timer
ROTATE_SERVICE=aifeeds-performance-logrotate.service
ROTATE_STATE_DIR=/var/lib/aifeeds-performance-logrotate
ROTATE_STATE=/var/lib/aifeeds-performance-logrotate/status
ROTATE_PROVENANCE=/var/lib/aifeeds-performance-logrotate/rotation-provenance.jsonl
ROTATION_LOCK=/run/aifeeds-performance-log-rotation.lock
EXPECTED_PROXY_COUNT=7
ALLOWED_INCLUDE=/etc/letsencrypt/options-ssl-nginx.conf
LOCK=/run/aifeeds-performance-log.lock
BACKUP_DIR=/var/backups/aifeeds-performance-log

test "$(id -u)" = 0
exec 9>"$LOCK"
if ! flock -n 9; then
    printf 'ERROR deployment_lock=busy\n'
    exit 75
fi

test "$#" = 3
STAGING=$1
OPERATION_ID=$2
G0_COMMIT=$3
case "$STAGING" in
    /run/aifeeds-performance-log.*) ;;
    *) printf 'ERROR staging_path=1\n'; exit 2 ;;
esac
printf '%s' "$OPERATION_ID" | grep -Eq '^[0-9]{14}-[a-f0-9]{8}$'
printf '%s' "$G0_COMMIT" | grep -Eq '^[a-f0-9]{40}$'
JOURNAL_OPERATION_ID=$OPERATION_ID
test -d "$STAGING"
test ! -L "$STAGING"
test "$(stat -c '%u' "$STAGING")" = 0
test "$(stat -c '%a' "$STAGING")" = 700

STAMP="${OPERATION_ID%%-*}"
BACKUP_ID="$OPERATION_ID"
BACKUP="${BACKUP_DIR}/aifeeds.conf.bak-perf-${BACKUP_ID}"
JOURNAL="${BACKUP_DIR}/transaction-${BACKUP_ID}.json"
JOURNAL_TMP="${JOURNAL}.tmp"
JOURNAL_PREVIOUS_UPDATE="${JOURNAL}.previous-update-gl-a-${OPERATION_ID}"
AUDIT_DIR="${BACKUP_DIR}/audit-${BACKUP_ID}"
ROTATION_ANCHOR="${BACKUP_DIR}/rotation-anchor-${OPERATION_ID}.json"
ARCHIVE_MANIFEST="${AUDIT_DIR}/archive-manifest.json"
ARCHIVE_MANIFEST_TMP="${ARCHIVE_MANIFEST}.tmp"
ARCHIVE_MANIFEST_PREVIOUS="${ARCHIVE_MANIFEST}.previous-gl-a-${OPERATION_ID}"
LOG_QUARANTINE_SUFFIX="quarantine-gl-a-${OPERATION_ID}"
ARCHIVE_OPERATION_ID="$OPERATION_ID"
LOG_QUIESCENCE_TIMEOUT_SECONDS=60
if [ -n "${GL_A_TEST_LOG_QUIESCENCE_TIMEOUT_SECONDS:-}" ]; then
    test -d /workspace/deploy/nginx/test-fixtures/gl-a-installer
    printf '%s' "$GL_A_TEST_LOG_QUIESCENCE_TIMEOUT_SECONDS" | grep -Eq '^[1-9][0-9]*$'
    LOG_QUIESCENCE_TIMEOUT_SECONDS="$GL_A_TEST_LOG_QUIESCENCE_TIMEOUT_SECONDS"
fi
CANDIDATE="${SITE}.candidate-gl-a-${OPERATION_ID}"
SITE_BUILD_CANDIDATE="${STAGING}/.aifeeds.conf.build-gl-a-${OPERATION_ID}"
FORMAT_CANDIDATE="${FORMAT}.candidate-gl-a-${OPERATION_ID}"
ROTATE_CANDIDATE="${ROTATE}.candidate-gl-a-${OPERATION_ID}"
LOG_CANDIDATE="${LOG%/*}/.${LOG##*/}.candidate-gl-a-${OPERATION_ID}"
CHECKER_CANDIDATE="${CHECKER}.candidate-gl-a-${OPERATION_ID}"
DIFF_CHECKER_CANDIDATE="${DIFF_CHECKER}.candidate-gl-a-${OPERATION_ID}"
INSERTER_CANDIDATE="${INSERTER}.candidate-gl-a-${OPERATION_ID}"
SERVICE_CANDIDATE="${SERVICE_PATH}.candidate-gl-a-${OPERATION_ID}"
TIMER_CANDIDATE="${TIMER_PATH}.candidate-gl-a-${OPERATION_ID}"
ROTATE_STATE_DIR_CANDIDATE="${ROTATE_STATE_DIR}.candidate-gl-a-${OPERATION_ID}"
ROLLBACK_CANDIDATE="${SITE}.rollback-gl-a-${OPERATION_ID}"
SUMMARY_TMP="$STAGING/gl-a-summary.json.tmp"
SUMMARY="$STAGING/gl-a-summary.json"
DRY_ROTATE_STATE="$STAGING/logrotate-dry-run.state"
FORCE_ROTATE_STATE="$STAGING/logrotate-force.state"
FIND_LOGS_INVENTORY="$STAGING/.find-logs.inventory"
FIND_ROTATION_INVENTORY="$STAGING/.find-rotation.inventory"
FIND_AUDIT_INVENTORY="$STAGING/.find-audit.inventory"
FIND_AUDIT_TERMINAL_INVENTORY="$STAGING/.find-audit-terminal.inventory"
FIND_ARCHIVE_INVENTORY="$STAGING/.find-archive.inventory"
FIND_SYMLINK_INVENTORY="$STAGING/.find-symlink.inventory"
FIND_TERMINAL_AUDIT_INVENTORY="$STAGING/.find-terminal-audit.inventory"
FIND_JOURNAL_INVENTORY="$STAGING/.find-journal.inventory"
FIND_QUARANTINE_INVENTORY="$STAGING/.find-quarantine.inventory"
FIND_MANIFEST_ENTRIES_INVENTORY="$STAGING/.find-manifest-entries.inventory"
FIND_MANIFEST_TERMINAL_INVENTORY="$STAGING/.find-manifest-terminal.inventory"
MUTATED=0
SUCCESS=0
JOURNAL_CREATED=0
LAST_JOURNAL_PHASE=none
INSTALLER_CANDIDATE_DEV=''
INSTALLER_CANDIDATE_INO=''
ROLLBACK_CANDIDATE_DEV=''
ROLLBACK_CANDIDATE_INO=''
RUNTIME_ARTIFACTS_JSON='[]'
RUNTIME_ARTIFACTS_SEALED=false
ROTATION_STATE_IDENTITY_JSON='null'
ROTATION_STATE_SNAPSHOT_JSON='null'
ROTATION_ANCHOR_IDENTITY_JSON='null'
SITE_BACKUP_IDENTITY_JSON='null'

curl_status() {
    local url=$1
    shift
    curl -fsS --connect-timeout 5 --max-time 15 "$@" -o /dev/null -w '%{http_code}' "$url"
}

prepare_private_inventory_file() {
    local inventory=$1
    case "$inventory" in "$STAGING"/.find-*.inventory) ;; *) return 1 ;; esac
    test ! -L "$inventory" || return 1
    if [ -e "$inventory" ]; then
        test -f "$inventory" || return 1
        test "$(stat -c '%U %G %a' "$inventory")" = 'root root 600' || return 1
        rm -f "$inventory" || return 1
    fi
    install -o root -g root -m 0600 /dev/null "$inventory" || return 1
}

write_find_inventory() {
    local inventory=$1
    shift
    prepare_private_inventory_file "$inventory" || return 1
    if ! find "$@" -print0 > "$inventory"; then
        rm -f "$inventory"
        return 1
    fi
}

strict_grep_count() {
    local pattern=$1
    local path=$2
    local count
    local rc
    if count="$(grep -Eic "$pattern" "$path")"; then rc=0; else rc=$?; fi
    case "$rc" in
        0|1) ;;
        *) return 1 ;;
    esac
    printf '%s' "$count" | grep -Eq '^[0-9]+$' || return 1
    printf '%s\n' "$count"
}

unit_is_inactive() {
    local unit=$1
    local state
    local rc
    if state="$(systemctl is-active "$unit" 2>/dev/null)"; then rc=0; else rc=$?; fi
    case "$rc:$state" in
        3:inactive|4:inactive) ;;
        *) return 1 ;;
    esac
}

timer_is_disabled() {
    local state
    local rc
    if state="$(systemctl is-enabled "$TIMER_UNIT" 2>/dev/null)"; then rc=0; else rc=$?; fi
    case "$rc:$state" in
        1:disabled|1:not-found|4:not-found) ;;
        *) return 1 ;;
    esac
}

no_performance_logs_present() {
    write_find_inventory "$FIND_LOGS_INVENTORY" /var/log/nginx -maxdepth 1 \
        -name 'aifeeds-performance.jsonl*' || return 1
    test ! -s "$FIND_LOGS_INVENTORY" || return 1
    rm -f "$FIND_LOGS_INVENTORY"
}

probe_absent_from_audit() {
    local root=$1
    local probe=$2
    local rc
    if [ ! -e "$root" ] && [ ! -L "$root" ]; then return 0; fi
    test -d "$root" || return 1
    test ! -L "$root" || return 1
    if grep -R -a -F -q -- "$probe" "$root"; then
        return 1
    else
        rc=$?
    fi
    test "$rc" -eq 1
}

assert_enabled_site_target() {
    test -L "$ENABLED_SITE"
    test "$(readlink -f "$ENABLED_SITE")" = "$SITE"
}

runtime_artifact_entry_for_path() {
    local path=$1
    jq -cer --arg path "$path" '
        [.[] | select(.final == $path or .candidate == $path)]
        | if length == 1 then .[0] else error("runtime artifact identity unavailable") end
    ' <<< "$RUNTIME_ARTIFACTS_JSON"
}

record_runtime_artifact_identity() {
    local name=$1 final=$2 candidate=$3 expected_sha256=$4
    local uid=$5 gid=$6 mode=$7 dev=$8 ino=$9
    printf '%s:%s' "$dev" "$ino" | grep -Eq '^[0-9]+:[0-9]+$' || return 1
    case "$name:$final:$candidate:$expected_sha256:$uid:$gid:$mode" in
        "format:$FORMAT:$FORMAT_CANDIDATE:$FORMAT_SHA256:0:0:644"|\
        "log:$LOG:$LOG_CANDIDATE:$EMPTY_SHA256:$(id -u www-data):$(getent group adm | cut -d: -f3):640"|\
        "checker:$CHECKER:$CHECKER_CANDIDATE:$CHECKER_SHA256:0:0:755"|\
        "diff_checker:$DIFF_CHECKER:$DIFF_CHECKER_CANDIDATE:$DIFF_CHECKER_SHA256:0:0:755"|\
        "inserter:$INSERTER:$INSERTER_CANDIDATE:$INSERTER_SHA256:0:0:755"|\
        "rotate:$ROTATE:$ROTATE_CANDIDATE:$ROTATE_SHA256:0:0:644"|\
        "service:$SERVICE_PATH:$SERVICE_CANDIDATE:$SERVICE_SHA256:0:0:644"|\
        "timer:$TIMER_PATH:$TIMER_CANDIDATE:$TIMER_SHA256:0:0:644") ;;
        *) return 1 ;;
    esac
    jq -e --arg name "$name" 'all(.[]; .name != $name)' \
        <<< "$RUNTIME_ARTIFACTS_JSON" >/dev/null || return 1
    RUNTIME_ARTIFACTS_JSON="$(jq -cS --arg name "$name" --arg final "$final" \
        --arg candidate "$candidate" --arg sha256 "$expected_sha256" \
        --argjson uid "$uid" --argjson gid "$gid" --arg mode "$mode" \
        --argjson dev "$dev" --argjson ino "$ino" \
        '. + [{name:$name,final:$final,candidate:$candidate,sha256:$sha256,
               uid:$uid,gid:$gid,mode:$mode,dev:$dev,ino:$ino}]' \
        <<< "$RUNTIME_ARTIFACTS_JSON")" || return 1
}

runtime_artifact_inventory_is_complete() {
    jq -e '
        length == 8 and
        ([.[].name] | sort) == ["checker","diff_checker","format","inserter",
                                "log","rotate","service","timer"] and
        ([.[].name] | length == (unique | length)) and
        ([.[].final] | length == (unique | length)) and
        ([.[].candidate] | length == (unique | length)) and
        all(.[];
          (keys | sort) == ["candidate","dev","final","gid","ino","mode","name","sha256","uid"] and
          (.sha256 | test("^[a-f0-9]{64}$")) and
          (.mode | test("^[0-7]{3,4}$")) and
          (.uid | type == "number") and (.gid | type == "number") and
          (.dev | type == "number" and . > 0 and . == floor) and
          (.ino | type == "number" and . > 0 and . == floor))
    ' <<< "$RUNTIME_ARTIFACTS_JSON" >/dev/null
}

prepare_rotation_state_directory() {
    local identity dev ino provenance
    test ! -e "$ROTATE_STATE_DIR" && test ! -L "$ROTATE_STATE_DIR" || return 1
    test ! -e "$ROTATE_STATE_DIR_CANDIDATE" && test ! -L "$ROTATE_STATE_DIR_CANDIDATE" || return 1
    identity="$(python3 - "$ROTATE_STATE_DIR_CANDIDATE" <<'PY'
import os
import stat
import sys

candidate = sys.argv[1]
os.mkdir(candidate, 0o700)
descriptor = os.open(candidate, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    os.fchown(descriptor, 0, 0)
    os.fchmod(descriptor, 0o750)
    os.fsync(descriptor)
    value = os.fstat(descriptor)
    current = os.lstat(candidate)
    if not stat.S_ISDIR(value.st_mode) or not stat.S_ISDIR(current.st_mode):
        raise RuntimeError("rotation state candidate is not a directory")
    if (value.st_dev, value.st_ino) != (current.st_dev, current.st_ino):
        raise RuntimeError("rotation state candidate pathname changed")
    if (value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode)) != (0, 0, 0o750):
        raise RuntimeError("rotation state candidate metadata changed")
    expected_dev, expected_ino = value.st_dev, value.st_ino
finally:
    os.close(descriptor)
parent = os.open(os.path.dirname(candidate), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    os.fsync(parent)
finally:
    os.close(parent)
print(f"{expected_dev}:{expected_ino}")
PY
)" || return 1
    dev=${identity%%:*}
    ino=${identity##*:}
    printf '%s:%s' "$dev" "$ino" | grep -Eq '^[0-9]+:[0-9]+$' || return 1
    provenance="$(python3 "$STAGING/check-nginx-request-id.py" rotation-initialize \
        "$OPERATION_ID" "$ROTATE_STATE_DIR_CANDIDATE")" || return 1
    jq -e --arg path "$ROTATE_PROVENANCE" '
        .path == $path and .uid == 0 and .gid == 0 and .mode == "600" and
        (.dev | type == "number" and . > 0) and (.ino | type == "number" and . > 0) and
        (.genesis_record_sha256 | test("^[a-f0-9]{64}$"))' <<< "$provenance" >/dev/null \
        || return 1
    ROTATION_STATE_IDENTITY_JSON="$(jq -nc --arg path "$ROTATE_STATE_DIR" \
        --arg candidate "$ROTATE_STATE_DIR_CANDIDATE" --argjson dev "$dev" \
        --argjson ino "$ino" --argjson provenance "$provenance" \
        '{directory:{path:$path,candidate:$candidate,uid:0,gid:0,mode:"750",dev:$dev,ino:$ino},
          provenance:$provenance,files:[]}')" \
        || return 1
    write_journal "$LAST_JOURNAL_PHASE" || return 1
    rotation_state_candidate_is_owned_or_absent
}

allocate_rotation_anchor() {
    local allocation dev ino
    test "$ROTATION_ANCHOR_IDENTITY_JSON" = null || return 1
    test ! -e "$ROTATION_ANCHOR" && test ! -L "$ROTATION_ANCHOR" || return 1
    allocation="$(python3 - "$ROTATION_ANCHOR" <<'PY'
import os
import stat
import sys

path = sys.argv[1]
descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
try:
    os.fchown(descriptor, 0, 0)
    os.fchmod(descriptor, 0o600)
    os.fsync(descriptor)
    value = os.fstat(descriptor)
    current = os.lstat(path)
    if not stat.S_ISREG(value.st_mode) or not stat.S_ISREG(current.st_mode):
        raise RuntimeError("rotation anchor allocation is not regular")
    if (value.st_dev, value.st_ino) != (current.st_dev, current.st_ino):
        raise RuntimeError("rotation anchor allocation pathname changed")
    if (value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode), value.st_size) != (0, 0, 0o600, 0):
        raise RuntimeError("rotation anchor allocation metadata changed")
    expected_dev, expected_ino = value.st_dev, value.st_ino
finally:
    os.close(descriptor)
parent = os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    os.fsync(parent)
finally:
    os.close(parent)
print(f"{expected_dev}:{expected_ino}")
PY
)" || return 1
    dev=${allocation%%:*}
    ino=${allocation##*:}
    printf '%s:%s' "$dev" "$ino" | grep -Eq '^[0-9]+:[0-9]+$' || return 1
    ROTATION_ANCHOR_IDENTITY_JSON="$(jq -ncS --arg path "$ROTATION_ANCHOR" \
        --arg sha256 "$EMPTY_SHA256" --argjson dev "$dev" --argjson ino "$ino" \
        '{state:"allocated",path:$path,sha256:$sha256,size:0,uid:0,gid:0,
          mode:"600",dev:$dev,ino:$ino}')" || return 1
    write_journal "$LAST_JOURNAL_PHASE" || return 1
    path_matches_exact_identity "$ROTATION_ANCHOR" "$EMPTY_SHA256" 0 0 600 "$dev" "$ino"
}

prepare_rotation_authority_and_service() {
    local checker_entry config_entry checker_identity config_identity logrotate_identity directory provenance
    local authority authority_sha256 authority_size anchor_dev anchor_ino sealed_identity
    checker_entry="$(runtime_artifact_entry_for_path "$CHECKER_CANDIDATE")" || return 1
    config_entry="$(runtime_artifact_entry_for_path "$ROTATE_CANDIDATE")" || return 1
    checker_identity="$(capture_regular_file_identity_stable "$CHECKER_CANDIDATE")" || return 1
    config_identity="$(capture_regular_file_identity_stable "$ROTATE_CANDIDATE")" || return 1
    logrotate_identity="$(capture_regular_file_identity_stable "$ROTATION_LOGROTATE")" || return 1
    jq -ne --argjson expected "$checker_entry" --argjson observed "$checker_identity" '
        $observed.sha256 == $expected.sha256 and
        $observed.uid == $expected.uid and $observed.gid == $expected.gid and
        $observed.mode == $expected.mode and $observed.dev == $expected.dev and
        $observed.ino == $expected.ino' >/dev/null || return 1
    jq -ne --argjson expected "$config_entry" --argjson observed "$config_identity" '
        $observed.sha256 == $expected.sha256 and
        $observed.uid == $expected.uid and $observed.gid == $expected.gid and
        $observed.mode == $expected.mode and $observed.dev == $expected.dev and
        $observed.ino == $expected.ino' >/dev/null || return 1
    checker_identity="$(jq -cS --arg path "$CHECKER" '.path=$path' <<< "$checker_identity")" \
        || return 1
    config_identity="$(jq -cS --arg path "$ROTATE" '.path=$path' <<< "$config_identity")" \
        || return 1
    jq -e --arg path "$ROTATION_LOGROTATE" '
        (keys | sort) == ["dev","gid","ino","mode","path","sha256","size","uid"] and
        .path == $path and .uid == 0 and .gid == 0 and .mode == "755" and
        (.sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
        (.size | type == "number" and . > 0 and . == floor) and
        (.dev | type == "number" and . > 0 and . == floor) and
        (.ino | type == "number" and . > 0 and . == floor)' \
        <<< "$logrotate_identity" >/dev/null || return 1
    directory="$(jq -cS '.directory | del(.candidate)' <<< "$ROTATION_STATE_IDENTITY_JSON")" \
        || return 1
    provenance="$(jq -cS '.provenance' <<< "$ROTATION_STATE_IDENTITY_JSON")" || return 1
    authority="$(jq -ncS --arg operation_id "$OPERATION_ID" --argjson directory "$directory" \
        --argjson provenance "$provenance" --argjson checker "$checker_identity" \
        --argjson config "$config_identity" --argjson logrotate "$logrotate_identity" \
        '{schema:2,operation_id:$operation_id,directory:$directory,provenance:$provenance,
          checker:$checker,config:$config,logrotate:$logrotate}')" || return 1
    authority_sha256="$(printf '%s\n' "$authority" | sha256sum | awk '{print $1}')" || return 1
    authority_size="$(printf '%s\n' "$authority" | wc -c | tr -d ' ')" || return 1
    printf '%s:%s' "$authority_sha256" "$authority_size" \
        | grep -Eq '^[a-f0-9]{64}:[1-9][0-9]*$' || return 1
    anchor_dev="$(jq -er '.dev' <<< "$ROTATION_ANCHOR_IDENTITY_JSON")" || return 1
    anchor_ino="$(jq -er '.ino' <<< "$ROTATION_ANCHOR_IDENTITY_JSON")" || return 1
    test "$(jq -er '.state' <<< "$ROTATION_ANCHOR_IDENTITY_JSON")" = allocated || return 1
    ROTATION_ANCHOR_IDENTITY_JSON="$(jq -cS --arg sha256 "$authority_sha256" \
        --argjson size "$authority_size" '.state="prepared" | .sha256=$sha256 | .size=$size' \
        <<< "$ROTATION_ANCHOR_IDENTITY_JSON")" || return 1
    write_journal "$LAST_JOURNAL_PHASE" || return 1
    python3 - "$ROTATION_ANCHOR" "$anchor_dev" "$anchor_ino" "$authority_sha256" \
        "$authority_size" "$authority" <<'PY'
import hashlib
import os
import stat
import sys

path, expected_dev, expected_ino, expected_sha256, expected_size, authority = sys.argv[1:]
expected_dev, expected_ino, expected_size = int(expected_dev), int(expected_ino), int(expected_size)
payload = authority.encode("utf-8") + b"\n"
if len(payload) != expected_size or hashlib.sha256(payload).hexdigest() != expected_sha256:
    raise RuntimeError("rotation authority target drift")
descriptor = os.open(path, os.O_WRONLY | os.O_NOFOLLOW)
try:
    before = os.fstat(descriptor)
    current = os.lstat(path)
    if (before.st_dev, before.st_ino) != (expected_dev, expected_ino):
        raise RuntimeError("rotation anchor descriptor drift")
    if (current.st_dev, current.st_ino) != (expected_dev, expected_ino):
        raise RuntimeError("rotation anchor pathname drift")
    if (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode), before.st_size) != (0, 0, 0o600, 0):
        raise RuntimeError("rotation anchor allocation drift")
    view = memoryview(payload)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise RuntimeError("short rotation anchor write")
        view = view[written:]
    os.fsync(descriptor)
    after = os.fstat(descriptor)
    current = os.lstat(path)
    if (after.st_dev, after.st_ino, after.st_size) != (expected_dev, expected_ino, expected_size):
        raise RuntimeError("rotation anchor seal drift")
    if (current.st_dev, current.st_ino, current.st_size) != (expected_dev, expected_ino, expected_size):
        raise RuntimeError("rotation anchor sealed pathname drift")
finally:
    os.close(descriptor)
parent = os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    os.fsync(parent)
finally:
    os.close(parent)
PY
    sealed_identity="$(capture_regular_file_identity_stable "$ROTATION_ANCHOR")" || return 1
    jq -e --arg path "$ROTATION_ANCHOR" --arg sha256 "$authority_sha256" \
        --argjson size "$authority_size" \
        --argjson dev "$anchor_dev" --argjson ino "$anchor_ino" '
        .path == $path and .sha256 == $sha256 and .size == $size and
        .uid == 0 and .gid == 0 and .mode == "600" and .dev == $dev and .ino == $ino' \
        <<< "$sealed_identity" >/dev/null || return 1
    ROTATION_ANCHOR_IDENTITY_JSON="$(jq -cS '.state="sealed"' \
        <<< "$ROTATION_ANCHOR_IDENTITY_JSON")" || return 1
    write_journal "$LAST_JOURNAL_PHASE" || return 1

    test ! -e "$SERVICE_CANDIDATE" && test ! -L "$SERVICE_CANDIDATE" || return 1
    test ! -e "$SERVICE_PATH" && test ! -L "$SERVICE_PATH" || return 1
    python3 - "$STAGING/aifeeds-performance-logrotate.service" "$SERVICE_CANDIDATE" \
        "$OPERATION_ID" "$ROTATION_ANCHOR" "$anchor_dev" "$anchor_ino" "$authority_sha256" \
        "$(jq -er '.dev' <<< "$checker_identity")" "$(jq -er '.ino' <<< "$checker_identity")" \
        "$(jq -er '.sha256' <<< "$checker_identity")" \
        "$(jq -er '.dev' <<< "$config_identity")" "$(jq -er '.ino' <<< "$config_identity")" \
        "$(jq -er '.sha256' <<< "$config_identity")" \
        "$(jq -er '.dev' <<< "$logrotate_identity")" "$(jq -er '.ino' <<< "$logrotate_identity")" \
        "$(jq -er '.sha256' <<< "$logrotate_identity")" <<'PY'
import os
import sys

(source, destination, operation_id, anchor_path, anchor_dev, anchor_ino, anchor_sha,
 checker_dev, checker_ino, checker_sha, config_dev, config_ino, config_sha,
 logrotate_dev, logrotate_ino, logrotate_sha) = sys.argv[1:]
with open(source, "r", encoding="utf-8") as handle:
    rendered = handle.read()
replacements = {
    "@OPERATION_ID@": operation_id,
    "@ROTATION_ANCHOR_PATH@": anchor_path,
    "@ROTATION_ANCHOR_DEV@": anchor_dev,
    "@ROTATION_ANCHOR_INO@": anchor_ino,
    "@ROTATION_ANCHOR_SHA256@": anchor_sha,
    "@CHECKER_DEV@": checker_dev,
    "@CHECKER_INO@": checker_ino,
    "@CHECKER_SHA256@": checker_sha,
    "@ROTATE_CONFIG_DEV@": config_dev,
    "@ROTATE_CONFIG_INO@": config_ino,
    "@ROTATE_CONFIG_SHA256@": config_sha,
    "@LOGROTATE_DEV@": logrotate_dev,
    "@LOGROTATE_INO@": logrotate_ino,
    "@LOGROTATE_SHA256@": logrotate_sha,
}
for token, value in replacements.items():
    expected_count = 2 if token == "@ROTATION_ANCHOR_PATH@" else 1
    if rendered.count(token) != expected_count:
        raise RuntimeError(f"service placeholder count drift: {token}")
    rendered = rendered.replace(token, value)
if "@" in rendered:
    raise RuntimeError("unresolved service placeholder")
descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
try:
    payload = rendered.encode("utf-8")
    view = memoryview(payload)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise RuntimeError("short service render write")
        view = view[written:]
    os.fchown(descriptor, 0, 0)
    os.fchmod(descriptor, 0o644)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
parent = os.open(os.path.dirname(destination), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    os.fsync(parent)
finally:
    os.close(parent)
PY
    SERVICE_SHA256="$(sha256sum "$SERVICE_CANDIDATE" | awk '{print $1}')" || return 1
    ARTIFACTS_SHA256_JSON="$(jq -cS --arg service "$SERVICE_SHA256" '.service=$service' \
        <<< "$ARTIFACTS_SHA256_JSON")" || return 1
    local service_identity service_dev service_ino
    service_identity="$(capture_regular_file_identity_stable "$SERVICE_CANDIDATE")" || return 1
    service_dev="$(jq -er '.dev' <<< "$service_identity")" || return 1
    service_ino="$(jq -er '.ino' <<< "$service_identity")" || return 1
    path_matches_exact_identity "$SERVICE_CANDIDATE" "$SERVICE_SHA256" 0 0 644 \
        "$service_dev" "$service_ino" || return 1
    record_runtime_artifact_identity service "$SERVICE_PATH" "$SERVICE_CANDIDATE" \
        "$SERVICE_SHA256" 0 0 644 "$service_dev" "$service_ino" || return 1
    write_journal "$LAST_JOURNAL_PHASE" || return 1
    sync -f "$SERVICE_CANDIDATE" || return 1
    path_matches_exact_identity "$SERVICE_CANDIDATE" "$SERVICE_SHA256" 0 0 644 \
        "$service_dev" "$service_ino"
}

directory_matches_exact_identity() {
    local path=$1 uid=$2 gid=$3 mode=$4 expected_dev=$5 expected_ino=$6
    python3 - "$path" "$uid" "$gid" "$mode" "$expected_dev" "$expected_ino" <<'PY'
import os
import stat
import sys

path, uid, gid, mode, expected_dev, expected_ino = sys.argv[1:]
uid, gid, mode = int(uid), int(gid), int(mode, 8)
expected_dev, expected_ino = int(expected_dev), int(expected_ino)
descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    value = os.fstat(descriptor)
    current = os.lstat(path)
    if not stat.S_ISDIR(value.st_mode) or not stat.S_ISDIR(current.st_mode):
        raise RuntimeError("expected directory")
    if (value.st_dev, value.st_ino) != (expected_dev, expected_ino):
        raise RuntimeError("directory descriptor identity changed")
    if (current.st_dev, current.st_ino) != (expected_dev, expected_ino):
        raise RuntimeError("directory pathname identity changed")
    if (value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode)) != (uid, gid, mode):
        raise RuntimeError("directory metadata changed")
finally:
    os.close(descriptor)
PY
}

capture_regular_file_identity_stable() {
    local path=$1
    python3 - "$path" <<'PY'
import hashlib
import json
import os
import stat
import sys

path = sys.argv[1]
descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
try:
    before = os.fstat(descriptor)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        raise RuntimeError("rotation state is not regular")
    with os.fdopen(os.dup(descriptor), "rb", buffering=0) as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    after = os.fstat(descriptor)
    current = os.lstat(path)
    before_identity = (
        before.st_dev, before.st_ino, before.st_uid, before.st_gid,
        stat.S_IMODE(before.st_mode), before.st_size, before.st_mtime_ns, before.st_nlink,
    )
    after_identity = (
        after.st_dev, after.st_ino, after.st_uid, after.st_gid,
        stat.S_IMODE(after.st_mode), after.st_size, after.st_mtime_ns, after.st_nlink,
    )
    if before_identity != after_identity:
        raise RuntimeError("rotation state changed while hashing")
    if not stat.S_ISREG(after.st_mode) or after.st_nlink != 1:
        raise RuntimeError("rotation state is not a private regular file")
    if (current.st_dev, current.st_ino) != (after.st_dev, after.st_ino):
        raise RuntimeError("rotation state pathname changed")
    if (current.st_uid, current.st_gid, stat.S_IMODE(current.st_mode), current.st_size,
            current.st_mtime_ns, current.st_nlink) != (
        after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode), after.st_size,
        after.st_mtime_ns, after.st_nlink,
    ):
        raise RuntimeError("rotation state pathname metadata changed")
    if (after.st_uid, after.st_gid) != (0, 0):
        raise RuntimeError("rotation state owner changed")
    result = {
        "path": path,
        "sha256": digest,
        "uid": after.st_uid,
        "gid": after.st_gid,
        "mode": format(stat.S_IMODE(after.st_mode), "o"),
        "size": after.st_size,
        "dev": after.st_dev,
        "ino": after.st_ino,
    }
finally:
    os.close(descriptor)
print(json.dumps(result, separators=(",", ":"), sort_keys=True))
PY
}

create_site_backup_inode_no_replace() {
    python3 - "$BACKUP" <<'PY'
import os
import stat
import sys

path = sys.argv[1]
descriptor = os.open(
    path,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
    0o600,
)
try:
    os.fchown(descriptor, 0, 0)
    os.fchmod(descriptor, 0o600)
    os.fsync(descriptor)
    value = os.fstat(descriptor)
    current = os.lstat(path)
    if not stat.S_ISREG(value.st_mode) or not stat.S_ISREG(current.st_mode):
        raise RuntimeError("backup allocation is not regular")
    if (value.st_dev, value.st_ino) != (current.st_dev, current.st_ino):
        raise RuntimeError("backup allocation pathname changed")
    if (value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode), value.st_size) != (0, 0, 0o600, 0):
        raise RuntimeError("backup allocation metadata changed")
    expected_dev, expected_ino = value.st_dev, value.st_ino
finally:
    os.close(descriptor)
parent = os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    os.fsync(parent)
finally:
    os.close(parent)
print(f"{expected_dev}:{expected_ino}")
PY
}

populate_site_backup() {
    local expected_backup_dev=$1 expected_backup_ino=$2
    python3 - "$SITE" "$BACKUP" "$SITE_BACKUP_SHA256" \
        "$SITE_UID" "$SITE_GID" "$SITE_MODE" "$SITE_BASE_DEV" "$SITE_BASE_INO" \
        "$expected_backup_dev" "$expected_backup_ino" <<'PY'
import hashlib
import os
import stat
import sys

(
    source,
    backup,
    expected_sha256,
    uid,
    gid,
    mode,
    expected_source_dev,
    expected_source_ino,
    expected_backup_dev,
    expected_backup_ino,
) = sys.argv[1:]
uid, gid, mode = int(uid), int(gid), int(mode, 8)
expected_source_dev, expected_source_ino = int(expected_source_dev), int(expected_source_ino)
expected_backup_dev, expected_backup_ino = int(expected_backup_dev), int(expected_backup_ino)
source_descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
try:
    backup_descriptor = os.open(backup, os.O_WRONLY | os.O_NOFOLLOW)
    try:
        source_before = os.fstat(source_descriptor)
        backup_before = os.fstat(backup_descriptor)
        if not stat.S_ISREG(source_before.st_mode) or not stat.S_ISREG(backup_before.st_mode):
            raise RuntimeError("backup copy endpoint is not regular")
        if (source_before.st_dev, source_before.st_ino) != (expected_source_dev, expected_source_ino):
            raise RuntimeError("backup source identity changed")
        if (source_before.st_uid, source_before.st_gid, stat.S_IMODE(source_before.st_mode)) != (uid, gid, mode):
            raise RuntimeError("backup source metadata changed")
        if (backup_before.st_dev, backup_before.st_ino) != (expected_backup_dev, expected_backup_ino):
            raise RuntimeError("backup destination identity changed")
        if (backup_before.st_uid, backup_before.st_gid, stat.S_IMODE(backup_before.st_mode), backup_before.st_size) != (0, 0, 0o600, 0):
            raise RuntimeError("backup destination was not a fresh allocation")
        source_path = os.lstat(source)
        backup_path = os.lstat(backup)
        if (source_path.st_dev, source_path.st_ino) != (expected_source_dev, expected_source_ino):
            raise RuntimeError("backup source pathname changed")
        if (backup_path.st_dev, backup_path.st_ino) != (expected_backup_dev, expected_backup_ino):
            raise RuntimeError("backup destination pathname changed")
        digest = hashlib.sha256()
        while True:
            chunk = os.read(source_descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                view = view[os.write(backup_descriptor, view):]
        if digest.hexdigest() != expected_sha256:
            raise RuntimeError("backup source hash changed")
        os.fchown(backup_descriptor, uid, gid)
        os.fchmod(backup_descriptor, mode)
        os.fsync(backup_descriptor)
        source_after = os.fstat(source_descriptor)
        backup_after = os.fstat(backup_descriptor)
        source_stable_before = (
            source_before.st_dev, source_before.st_ino, source_before.st_uid,
            source_before.st_gid, stat.S_IMODE(source_before.st_mode),
            source_before.st_size, source_before.st_mtime_ns,
        )
        source_stable_after = (
            source_after.st_dev, source_after.st_ino, source_after.st_uid,
            source_after.st_gid, stat.S_IMODE(source_after.st_mode),
            source_after.st_size, source_after.st_mtime_ns,
        )
        if source_stable_before != source_stable_after:
            raise RuntimeError("backup source changed during copy")
        if (backup_after.st_dev, backup_after.st_ino) != (expected_backup_dev, expected_backup_ino):
            raise RuntimeError("backup destination changed during copy")
        if (backup_after.st_uid, backup_after.st_gid, stat.S_IMODE(backup_after.st_mode)) != (uid, gid, mode):
            raise RuntimeError("backup destination metadata changed")
        source_path = os.lstat(source)
        backup_path = os.lstat(backup)
        if (source_path.st_dev, source_path.st_ino) != (expected_source_dev, expected_source_ino):
            raise RuntimeError("backup source pathname changed after copy")
        if (backup_path.st_dev, backup_path.st_ino) != (expected_backup_dev, expected_backup_ino):
            raise RuntimeError("backup destination pathname changed after copy")
    finally:
        os.close(backup_descriptor)
finally:
    os.close(source_descriptor)
parent = os.open(os.path.dirname(backup), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    os.fsync(parent)
finally:
    os.close(parent)
PY
}

publish_rotation_state_directory() {
    local dev ino
    dev="$(jq -er '.directory.dev' <<< "$ROTATION_STATE_IDENTITY_JSON")" || return 1
    ino="$(jq -er '.directory.ino' <<< "$ROTATION_STATE_IDENTITY_JSON")" || return 1
    test "$(jq -er '.directory.path' <<< "$ROTATION_STATE_IDENTITY_JSON")" = "$ROTATE_STATE_DIR" || return 1
    test "$(jq -er '.directory.candidate' <<< "$ROTATION_STATE_IDENTITY_JSON")" = \
        "$ROTATE_STATE_DIR_CANDIDATE" || return 1
    test "$(stat -c '%u %g %a %d %i' "$ROTATE_STATE_DIR_CANDIDATE")" = \
        "0 0 750 $dev $ino" || return 1
    rotation_state_candidate_is_owned_or_absent || return 1
    rename_no_replace "$ROTATE_STATE_DIR_CANDIDATE" "$ROTATE_STATE_DIR" || return 1
    test "$(stat -c '%u %g %a %d %i' "$ROTATE_STATE_DIR")" = "0 0 750 $dev $ino" \
        || return 1
    rotation_state_is_owned
}

extract_logrotate_identity_from_sealed_anchor() {
    local operation_id=$1 anchor_identity=$2
    python3 - "$operation_id" "$anchor_identity" <<'PY'
import hashlib
import json
import os
import re
import stat
import sys

operation_id, identity_source = sys.argv[1:]

def reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise RuntimeError("duplicate canonical key")
        result[key] = value
    return result

def canonical(value):
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")

identity = json.loads(identity_source, object_pairs_hook=reject_duplicate_keys)
if canonical(identity).decode("utf-8") != identity_source:
    raise RuntimeError("anchor identity is not canonical")
if set(identity) != {"dev", "gid", "ino", "mode", "path", "sha256", "size", "state", "uid"}:
    raise RuntimeError("anchor identity keys drift")
if identity["state"] != "sealed" or identity["path"] != (
    f"/var/backups/aifeeds-performance-log/rotation-anchor-{operation_id}.json"
):
    raise RuntimeError("anchor identity path drift")
for key in ("dev", "ino", "size"):
    if isinstance(identity[key], bool) or not isinstance(identity[key], int) or identity[key] <= 0:
        raise RuntimeError(f"anchor identity {key} drift")
for key in ("uid", "gid"):
    if isinstance(identity[key], bool) or not isinstance(identity[key], int) or identity[key] != 0:
        raise RuntimeError(f"anchor identity {key} drift")
if identity["mode"] != "600":
    raise RuntimeError("anchor identity metadata drift")
if not isinstance(identity["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", identity["sha256"]):
    raise RuntimeError("anchor identity hash drift")

path = identity["path"]
descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
try:
    before = os.fstat(descriptor)
    current = os.lstat(path)
    before_identity = (
        before.st_dev, before.st_ino, before.st_uid, before.st_gid,
        stat.S_IMODE(before.st_mode), before.st_size, before.st_mtime_ns,
    )
    expected_identity = (
        identity["dev"], identity["ino"], 0, 0, 0o600, identity["size"]
    )
    if not stat.S_ISREG(before.st_mode) or before_identity[:6] != expected_identity:
        raise RuntimeError("anchor descriptor identity drift")
    if (
        current.st_dev, current.st_ino, current.st_uid, current.st_gid,
        stat.S_IMODE(current.st_mode), current.st_size,
    ) != expected_identity:
        raise RuntimeError("anchor pathname identity drift")
    payload = b""
    while len(payload) < identity["size"]:
        chunk = os.pread(descriptor, identity["size"] - len(payload), len(payload))
        if not chunk:
            raise RuntimeError("short anchor read")
        payload += chunk
    after = os.fstat(descriptor)
    final = os.lstat(path)
    after_identity = (
        after.st_dev, after.st_ino, after.st_uid, after.st_gid,
        stat.S_IMODE(after.st_mode), after.st_size, after.st_mtime_ns,
    )
    if after_identity != before_identity:
        raise RuntimeError("anchor changed while reading")
    if (
        final.st_dev, final.st_ino, final.st_uid, final.st_gid,
        stat.S_IMODE(final.st_mode), final.st_size,
    ) != expected_identity:
        raise RuntimeError("anchor final pathname drift")
finally:
    os.close(descriptor)

if hashlib.sha256(payload).hexdigest() != identity["sha256"]:
    raise RuntimeError("anchor content hash drift")
if not payload.endswith(b"\n"):
    raise RuntimeError("anchor newline drift")
authority = json.loads(payload[:-1].decode("utf-8"), object_pairs_hook=reject_duplicate_keys)
if canonical(authority) + b"\n" != payload:
    raise RuntimeError("authority is not canonical")
if set(authority) != {
    "schema", "operation_id", "directory", "provenance", "checker", "config", "logrotate"
}:
    raise RuntimeError("authority keys drift")
if isinstance(authority["schema"], bool) or not isinstance(authority["schema"], int) \
        or authority["schema"] != 2:
    raise RuntimeError("authority schema drift")
if authority["operation_id"] != operation_id:
    raise RuntimeError("authority operation drift")
logrotate = authority["logrotate"]
if not isinstance(logrotate, dict) or set(logrotate) != {
    "dev", "gid", "ino", "mode", "path", "sha256", "size", "uid"
}:
    raise RuntimeError("logrotate authority keys drift")
if logrotate["path"] != "/usr/sbin/logrotate":
    raise RuntimeError("logrotate authority path drift")
for key in ("uid", "gid"):
    if isinstance(logrotate[key], bool) or not isinstance(logrotate[key], int) or logrotate[key] != 0:
        raise RuntimeError(f"logrotate authority {key} drift")
if logrotate["mode"] != "755":
    raise RuntimeError("logrotate authority metadata drift")
for key in ("dev", "ino", "size"):
    if isinstance(logrotate[key], bool) or not isinstance(logrotate[key], int) or logrotate[key] <= 0:
        raise RuntimeError(f"logrotate authority {key} drift")
if not isinstance(logrotate["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", logrotate["sha256"]):
    raise RuntimeError("logrotate authority hash drift")
print(canonical(logrotate).decode("utf-8"))
PY
}

run_rotation_authorized_command() {
    local command=$1 operation_id=$2 anchor_identity=$3 runtime_artifacts=$4
    local checker_entry config_entry logrotate_entry anchor_path
    case "$command" in rotation-wrapper|rotation-recover|rotation-verify) ;; *) return 1 ;; esac
    test "$(jq -er '.state' <<< "$anchor_identity")" = sealed || return 1
    anchor_path="$(jq -er '.path' <<< "$anchor_identity")" || return 1
    test "$anchor_path" = "${BACKUP_DIR}/rotation-anchor-${operation_id}.json" || return 1
    checker_entry="$(jq -cer --arg path "$CHECKER" \
        '[.[] | select(.final == $path)] | if length == 1 then .[0] else error("checker identity") end' \
        <<< "$runtime_artifacts")" || return 1
    config_entry="$(jq -cer --arg path "$ROTATE" \
        '[.[] | select(.final == $path)] | if length == 1 then .[0] else error("config identity") end' \
        <<< "$runtime_artifacts")" || return 1
    logrotate_entry="$(extract_logrotate_identity_from_sealed_anchor \
        "$operation_id" "$anchor_identity")" || return 1
    "$CHECKER" "$command" "$operation_id" "$anchor_path" \
        "$(jq -er '.dev' <<< "$anchor_identity")" \
        "$(jq -er '.ino' <<< "$anchor_identity")" \
        "$(jq -er '.sha256' <<< "$anchor_identity")" \
        "$(jq -er '.dev' <<< "$checker_entry")" \
        "$(jq -er '.ino' <<< "$checker_entry")" \
        "$(jq -er '.sha256' <<< "$checker_entry")" \
        "$(jq -er '.dev' <<< "$config_entry")" \
        "$(jq -er '.ino' <<< "$config_entry")" \
        "$(jq -er '.sha256' <<< "$config_entry")" \
        "$(jq -er '.dev' <<< "$logrotate_entry")" \
        "$(jq -er '.ino' <<< "$logrotate_entry")" \
        "$(jq -er '.sha256' <<< "$logrotate_entry")"
}

persist_rotation_state_identity() {
    local dir_dev dir_ino provenance snapshot
    test -d "$ROTATE_STATE_DIR" && test ! -L "$ROTATE_STATE_DIR" || return 1
    dir_dev="$(jq -er '.directory.dev' <<< "$ROTATION_STATE_IDENTITY_JSON")" || return 1
    dir_ino="$(jq -er '.directory.ino' <<< "$ROTATION_STATE_IDENTITY_JSON")" || return 1
    directory_matches_exact_identity "$ROTATE_STATE_DIR" 0 0 750 "$dir_dev" "$dir_ino" \
        || return 1
    provenance="$(jq -cer '.provenance' <<< "$ROTATION_STATE_IDENTITY_JSON")" || return 1
    snapshot="$(run_rotation_authorized_command rotation-verify "$OPERATION_ID" \
        "$ROTATION_ANCHOR_IDENTITY_JSON" "$RUNTIME_ARTIFACTS_JSON")" || return 1
    jq -e --arg path "$ROTATE_PROVENANCE" --argjson dev "$(jq -er '.dev' <<< "$provenance")" \
        --argjson ino "$(jq -er '.ino' <<< "$provenance")" '
        .ledger.path == $path and .ledger.dev == $dev and .ledger.ino == $ino and
        (.ledger.sha256 | test("^[a-f0-9]{64}$")) and
        (.ledger.size | type == "number" and . > 0) and
        (.tail_record_sha256 | test("^[a-f0-9]{64}$")) and
        (.generation | type == "number" and . >= 0) and
        (.status == null or
          (.status.path == "/var/lib/aifeeds-performance-logrotate/status" and
           (.status.sha256 | test("^[a-f0-9]{64}$")) and
           (.status.dev | type == "number" and . > 0) and
           (.status.ino | type == "number" and . > 0)))' <<< "$snapshot" >/dev/null \
        || return 1
    ROTATION_STATE_SNAPSHOT_JSON="$(jq -cS . <<< "$snapshot")" || return 1
    write_journal "$LAST_JOURNAL_PHASE" || return 1
    rotation_state_is_owned
}

artifact_expected_or_absent() {
    local path=$1
    local expected_sha256=$2
    local expected_metadata=$3
    local entry expected_dev expected_ino
    test ! -L "$path" || return 1
    if [ -e "$path" ]; then
        test -f "$path" || return 1
        entry="$(runtime_artifact_entry_for_path "$path")" || return 1
        test "$(jq -er '.sha256' <<< "$entry")" = "$expected_sha256" || return 1
        test "$(jq -r '[.uid,.gid,.mode] | map(tostring) | join(" ")' <<< "$entry")" = \
            "$expected_metadata" || return 1
        expected_dev="$(jq -er '.dev' <<< "$entry")" || return 1
        expected_ino="$(jq -er '.ino' <<< "$entry")" || return 1
        path_matches_exact_identity "$path" "$expected_sha256" \
            "${expected_metadata%% *}" "$(awk '{print $2}' <<< "$expected_metadata")" \
            "${expected_metadata##* }" "$expected_dev" "$expected_ino" || return 1
    fi
}

transaction_temp_is_owned_or_absent() {
    local path=$1
    local final_metadata=$2
    local metadata expected_sha256 entry expected_dev expected_ino numeric_metadata
    test ! -L "$path" || return 1
    if [ -e "$path" ]; then
        test -f "$path" || return 1
        metadata="$(stat -c '%U %G %a' "$path")" || return 1
        case "$metadata" in
            'root root 600') return 1 ;;
            "$final_metadata")
                entry="$(runtime_artifact_entry_for_path "$path")" || return 1
                expected_sha256="$(transaction_temp_expected_sha256 "$path")" || return 1
                test "$(jq -er '.sha256' <<< "$entry")" = "$expected_sha256" || return 1
                numeric_metadata="$(jq -r '[.uid,.gid,.mode] | map(tostring) | join(" ")' <<< "$entry")" || return 1
                expected_dev="$(jq -er '.dev' <<< "$entry")" || return 1
                expected_ino="$(jq -er '.ino' <<< "$entry")" || return 1
                path_matches_exact_identity "$path" "$expected_sha256" \
                    "$(jq -er '.uid' <<< "$entry")" "$(jq -er '.gid' <<< "$entry")" \
                    "$(jq -er '.mode' <<< "$entry")" "$expected_dev" "$expected_ino" || return 1
                ;;
            *) return 1 ;;
        esac
    fi
}

transaction_temp_expected_sha256() {
    local path=$1
    case "$path" in
        "$FORMAT_CANDIDATE") printf '%s\n' "$FORMAT_SHA256" ;;
        "$ROTATE_CANDIDATE") printf '%s\n' "$ROTATE_SHA256" ;;
        "$LOG_CANDIDATE") sha256sum /dev/null | awk '{print $1}' ;;
        "$CHECKER_CANDIDATE") printf '%s\n' "$CHECKER_SHA256" ;;
        "$DIFF_CHECKER_CANDIDATE") printf '%s\n' "$DIFF_CHECKER_SHA256" ;;
        "$INSERTER_CANDIDATE") printf '%s\n' "$INSERTER_SHA256" ;;
        "$SERVICE_CANDIDATE") printf '%s\n' "$SERVICE_SHA256" ;;
        "$TIMER_CANDIDATE") printf '%s\n' "$TIMER_SHA256" ;;
        *) return 1 ;;
    esac
}

formal_site_matches_state() {
    local path=$1 state=$2 expected_sha256 expected_dev expected_ino
    case "$state" in
        base)
            expected_sha256=$SITE_BASE_SHA256
            expected_dev=${ROLLBACK_CANDIDATE_DEV:-$SITE_BASE_DEV}
            expected_ino=${ROLLBACK_CANDIDATE_INO:-$SITE_BASE_INO}
            ;;
        installed)
            test "$EXPECTED_INSTALLED_SITE_SHA256" != absent || return 1
            test -n "$INSTALLER_CANDIDATE_DEV" && test -n "$INSTALLER_CANDIDATE_INO" \
                || return 1
            expected_sha256=$EXPECTED_INSTALLED_SITE_SHA256
            expected_dev=$INSTALLER_CANDIDATE_DEV
            expected_ino=$INSTALLER_CANDIDATE_INO
            ;;
        *) return 1 ;;
    esac
    path_matches_exact_identity "$path" "$expected_sha256" "$SITE_UID" "$SITE_GID" \
        "$SITE_MODE" "$expected_dev" "$expected_ino"
}

site_candidate_is_owned_or_absent() {
    test ! -L "$CANDIDATE" || return 1
    if [ -e "$CANDIDATE" ]; then
        formal_site_matches_state "$CANDIDATE" installed || return 1
    fi
}

restore_candidate_is_owned_or_absent() {
    local path=$1 expected_dev expected_ino
    test ! -L "$path" || return 1
    if [ -e "$path" ]; then
        test -f "$path" || return 1
        expected_dev=${ROLLBACK_CANDIDATE_DEV:-$SITE_BASE_DEV}
        expected_ino=${ROLLBACK_CANDIDATE_INO:-$SITE_BASE_INO}
        path_matches_exact_identity "$path" "$SITE_BASE_SHA256" "$SITE_UID" "$SITE_GID" \
            "$SITE_MODE" "$expected_dev" "$expected_ino" || return 1
    fi
}

rollback_artifacts_are_owned() {
    artifact_expected_or_absent "$FORMAT" "$FORMAT_SHA256" '0 0 644' || return 1
    artifact_expected_or_absent "$ROTATE" "$ROTATE_SHA256" '0 0 644' || return 1
    artifact_expected_or_absent "$CHECKER" "$CHECKER_SHA256" '0 0 755' || return 1
    artifact_expected_or_absent "$DIFF_CHECKER" "$DIFF_CHECKER_SHA256" '0 0 755' || return 1
    artifact_expected_or_absent "$INSERTER" "$INSERTER_SHA256" '0 0 755' || return 1
    artifact_expected_or_absent "$SERVICE_PATH" "$SERVICE_SHA256" '0 0 644' || return 1
    artifact_expected_or_absent "$TIMER_PATH" "$TIMER_SHA256" '0 0 644' || return 1
    site_candidate_is_owned_or_absent || return 1
    restore_candidate_is_owned_or_absent "$ROLLBACK_CANDIDATE" || return 1
    transaction_temp_is_owned_or_absent "$FORMAT_CANDIDATE" 'root root 644' || return 1
    transaction_temp_is_owned_or_absent "$ROTATE_CANDIDATE" 'root root 644' || return 1
    transaction_temp_is_owned_or_absent "$LOG_CANDIDATE" 'www-data adm 640' || return 1
    transaction_temp_is_owned_or_absent "$CHECKER_CANDIDATE" 'root root 755' || return 1
    transaction_temp_is_owned_or_absent "$DIFF_CHECKER_CANDIDATE" 'root root 755' || return 1
    transaction_temp_is_owned_or_absent "$INSERTER_CANDIDATE" 'root root 755' || return 1
    transaction_temp_is_owned_or_absent "$SERVICE_CANDIDATE" 'root root 644' || return 1
    transaction_temp_is_owned_or_absent "$TIMER_CANDIDATE" 'root root 644' || return 1
    rotation_state_candidate_is_owned_or_absent || return 1
}

remove_transaction_temp() {
    local path=$1
    local final_metadata=$2
    local entry
    transaction_temp_is_owned_or_absent "$path" "$final_metadata" || return 1
    if [ -e "$path" ]; then
        entry="$(runtime_artifact_entry_for_path "$path")" || return 1
        private_cleanup_tombstone "$path" "$(jq -er '.sha256' <<< "$entry")" \
            "$(jq -er '.uid' <<< "$entry")" "$(jq -er '.gid' <<< "$entry")" \
            "$(jq -er '.mode' <<< "$entry")" "$(jq -er '.dev' <<< "$entry")" \
            "$(jq -er '.ino' <<< "$entry")" 0 || return 1
    fi
    test ! -e "$path" && test ! -L "$path"
}

remove_all_transaction_temps() {
    remove_transaction_temp "$FORMAT_CANDIDATE" 'root root 644' || return 1
    remove_transaction_temp "$ROTATE_CANDIDATE" 'root root 644' || return 1
    remove_transaction_temp "$LOG_CANDIDATE" 'www-data adm 640' || return 1
    remove_transaction_temp "$CHECKER_CANDIDATE" 'root root 755' || return 1
    remove_transaction_temp "$DIFF_CHECKER_CANDIDATE" 'root root 755' || return 1
    remove_transaction_temp "$INSERTER_CANDIDATE" 'root root 755' || return 1
    remove_transaction_temp "$SERVICE_CANDIDATE" 'root root 644' || return 1
    remove_transaction_temp "$TIMER_CANDIDATE" 'root root 644' || return 1
}

create_owned_candidate_no_replace() {
    local source=$1
    local candidate=$2
    local expected_sha256=$3
    local owner=$4
    local group=$5
    local mode=$6
    python3 - "$source" "$candidate" "$expected_sha256" "$owner" "$group" "$mode" <<'PY'
import grp
import hashlib
import os
import pwd
import stat
import sys

source, candidate, expected_sha256, owner, group, mode = sys.argv[1:]
uid = pwd.getpwnam(owner).pw_uid
gid = grp.getgrnam(group).gr_gid
mode = int(mode, 8)
source_descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
try:
    source_value = os.fstat(source_descriptor)
    if source != "/dev/null" and not stat.S_ISREG(source_value.st_mode):
        raise RuntimeError("owned artifact source is not regular")
    if source == "/dev/null" and not stat.S_ISCHR(source_value.st_mode):
        raise RuntimeError("empty owned artifact source is not a character device")
    candidate_descriptor = os.open(
        candidate,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
    )
    try:
        digest = hashlib.sha256()
        while True:
            chunk = os.read(source_descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                view = view[os.write(candidate_descriptor, view):]
        if digest.hexdigest() != expected_sha256:
            raise RuntimeError("owned artifact source hash changed")
        os.fchown(candidate_descriptor, uid, gid)
        os.fchmod(candidate_descriptor, mode)
        os.fsync(candidate_descriptor)
        candidate_value = os.fstat(candidate_descriptor)
        expected_dev, expected_ino = candidate_value.st_dev, candidate_value.st_ino
        if (candidate_value.st_uid, candidate_value.st_gid, stat.S_IMODE(candidate_value.st_mode)) != (
            uid,
            gid,
            mode,
        ):
            raise RuntimeError("owned artifact candidate metadata changed")
    finally:
        os.close(candidate_descriptor)
finally:
    os.close(source_descriptor)
parent_descriptor = os.open(os.path.dirname(candidate), os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(parent_descriptor)
finally:
    os.close(parent_descriptor)
print(f"{expected_dev}:{expected_ino}")
PY
}

prepare_atomic_owned() {
    local name=$1
    local source=$2
    local destination=$3
    local candidate=$4
    local expected_sha256=$5
    local owner=$6
    local group=$7
    local mode=$8
    if [ "$source" = /dev/null ]; then
        test -c "$source"
    else
        test -f "$source"
        test ! -L "$source"
    fi
    local candidate_identity
    local candidate_dev
    local candidate_ino
    test ! -e "$destination"
    test ! -L "$destination"
    test ! -e "$candidate"
    test ! -L "$candidate"
    test "$(stat -c '%d' "${destination%/*}")" = "$(stat -c '%d' "${candidate%/*}")"
    candidate_identity="$(create_owned_candidate_no_replace "$source" "$candidate" \
        "$expected_sha256" "$owner" "$group" "$mode")"
    printf '%s' "$candidate_identity" | grep -Eq '^[0-9]+:[0-9]+$'
    candidate_dev=${candidate_identity%%:*}
    candidate_ino=${candidate_identity##*:}
    record_runtime_artifact_identity "$name" "$destination" "$candidate" \
        "$expected_sha256" "$(id -u "$owner")" \
        "$(getent group "$group" | cut -d: -f3)" "$mode" \
        "$candidate_dev" "$candidate_ino"
    write_journal "$LAST_JOURNAL_PHASE"
    sync -f "$candidate"
    path_matches_exact_identity "$candidate" "$expected_sha256" \
        "$(id -u "$owner")" "$(getent group "$group" | cut -d: -f3)" "$mode" \
        "$candidate_dev" "$candidate_ino"
}

publish_atomic_owned() {
    local name=$1
    local destination=$2
    local candidate=$3
    local entry expected_sha256 uid gid mode candidate_dev candidate_ino
    test "$RUNTIME_ARTIFACTS_SEALED" = true || return 1
    runtime_artifact_inventory_is_complete || return 1
    entry="$(jq -cer --arg name "$name" \
        '[.[] | select(.name == $name)] | if length == 1 then .[0] else error("missing runtime artifact") end' \
        <<< "$RUNTIME_ARTIFACTS_JSON")" || return 1
    test "$(jq -er '.final' <<< "$entry")" = "$destination" || return 1
    test "$(jq -er '.candidate' <<< "$entry")" = "$candidate" || return 1
    expected_sha256="$(jq -er '.sha256' <<< "$entry")" || return 1
    uid="$(jq -er '.uid' <<< "$entry")" || return 1
    gid="$(jq -er '.gid' <<< "$entry")" || return 1
    mode="$(jq -er '.mode' <<< "$entry")" || return 1
    candidate_dev="$(jq -er '.dev' <<< "$entry")" || return 1
    candidate_ino="$(jq -er '.ino' <<< "$entry")" || return 1
    test ! -e "$destination"
    test ! -L "$destination"
    path_matches_exact_identity "$candidate" "$expected_sha256" \
        "$uid" "$gid" "$mode" "$candidate_dev" "$candidate_ino"
    rename_no_replace "$candidate" "$destination"
    sync -f "$destination"
    path_matches_exact_identity "$destination" "$expected_sha256" \
        "$uid" "$gid" "$mode" "$candidate_dev" "$candidate_ino"
}

rename_no_replace() {
    local source=$1
    local destination=$2
    python3 - "$source" "$destination" <<'PY'
import ctypes
import errno
import os
import sys

source, destination = sys.argv[1:]
libc = ctypes.CDLL(None, use_errno=True)
renameat2 = getattr(libc, "renameat2", None)
if renameat2 is None:
    print("renameat2 unavailable", file=sys.stderr)
    raise SystemExit(95)
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
AT_FDCWD = -100
RENAME_NOREPLACE = 1
result = renameat2(
    AT_FDCWD,
    os.fsencode(source),
    AT_FDCWD,
    os.fsencode(destination),
    RENAME_NOREPLACE,
)
if result != 0:
    error = ctypes.get_errno()
    print(f"renameat2 RENAME_NOREPLACE failed: {errno.errorcode.get(error, error)}", file=sys.stderr)
    raise SystemExit(error if error < 126 else 94)
for parent in {os.path.dirname(source), os.path.dirname(destination)}:
    descriptor = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
PY
}


remove_exact_empty_private_cleanup_directory() {
    local path=$1 expected_dev=$2 expected_ino=$3
    python3 - "$path" "$expected_dev" "$expected_ino" <<'PY'
import os
import stat
import sys

path, expected_dev, expected_ino = sys.argv[1:]
expected_dev, expected_ino = int(expected_dev), int(expected_ino)
parent_path, name = os.path.split(path)
parent = os.open(parent_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
try:
    before = os.fstat(descriptor)
    namespace = os.stat(name, dir_fd=parent, follow_symlinks=False)
    stable = lambda value: (
        value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
        value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode), value.st_nlink,
    )
    if not stat.S_ISDIR(before.st_mode) or before.st_nlink != 2 \
            or (before.st_dev, before.st_ino) != (expected_dev, expected_ino) \
            or (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) != (0, 0, 0o700) \
            or stable(before) != stable(namespace) or os.listdir(descriptor):
        raise RuntimeError("private cleanup directory identity/emptiness drift")
    held_before_rmdir = os.fstat(descriptor)
    if stable(held_before_rmdir) != stable(before):
        raise RuntimeError("private cleanup directory changed before rmdir")
    os.rmdir(name, dir_fd=parent)
    try:
        os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        raise RuntimeError("private cleanup directory namespace survived rmdir")
    after = os.fstat(descriptor)
    held_identity = lambda value: (
        value.st_dev, value.st_ino, value.st_mtime_ns,
        value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode),
    )
    if held_identity(after) != held_identity(before) \
            or after.st_size not in (before.st_size, 0) or after.st_nlink != 0:
        raise RuntimeError("private cleanup held directory drift after rmdir")
    os.fsync(parent)
finally:
    os.close(descriptor)
    os.close(parent)
PY
}


private_cleanup_tombstone() {
    local path=$1 expected_sha256=$2 uid=$3 gid=$4 mode=$5
    local expected_dev=$6 expected_ino=$7 quiescence_timeout=${8:-0}
    local parent path_tag cleanup_prefix cleanup_dir tombstone cleanup_dev cleanup_ino
    parent=${path%/*}
    path_tag="$(printf '%s' "$path" | sha256sum | awk '{print substr($1,1,16)}')" || return 1
    cleanup_prefix=".cleanup-gl-a-${ARCHIVE_OPERATION_ID}-${path_tag}-"
    cleanup_dir="${parent}/${cleanup_prefix}${expected_dev}-${expected_ino}"
    tombstone="${cleanup_dir}/payload"
    printf '%s:%s' "$expected_dev" "$expected_ino" | grep -Eq '^[0-9]+:[0-9]+$' || return 1
    case "$cleanup_dir" in
        "${parent}/${cleanup_prefix}"*) ;;
        *) return 1 ;;
    esac
    test ! -L "$cleanup_dir" || return 1
    if [ ! -e "$cleanup_dir" ]; then
        mkdir -m 0700 "$cleanup_dir" || return 1
    fi
    test -d "$cleanup_dir" || return 1
    test ! -L "$cleanup_dir" || return 1
    test "$(stat -c '%u %g %a' "$cleanup_dir")" = '0 0 700' || return 1
    test "$(stat -c '%d' "$cleanup_dir")" = "$(stat -c '%d' "$parent")" || return 1
    cleanup_dev="$(stat -c '%d' "$cleanup_dir")" || return 1
    cleanup_ino="$(stat -c '%i' "$cleanup_dir")" || return 1
    test ! -L "$tombstone" || return 1
    if [ -e "$path" ] || [ -L "$path" ]; then
        test ! -e "$tombstone" || return 1
        test ! -L "$tombstone" || return 1
        path_matches_exact_identity "$path" "$expected_sha256" "$uid" "$gid" "$mode" \
            "$expected_dev" "$expected_ino" || return 1
        rename_no_replace "$path" "$tombstone" || return 1
    elif [ ! -e "$tombstone" ] && [ ! -L "$tombstone" ]; then
        remove_exact_empty_private_cleanup_directory \
            "$cleanup_dir" "$cleanup_dev" "$cleanup_ino" || return 1
        return 0
    fi
    test "$(stat -c '%d %i' "$cleanup_dir")" = "$cleanup_dev $cleanup_ino" || return 1
    sync -f "$tombstone" || return 1
    if ! path_matches_exact_identity "$tombstone" "$expected_sha256" "$uid" "$gid" "$mode" \
        "$expected_dev" "$expected_ino"; then
        if [ ! -e "$path" ] && [ ! -L "$path" ]; then
            rename_no_replace "$tombstone" "$path" || return 1
            remove_exact_empty_private_cleanup_directory \
                "$cleanup_dir" "$cleanup_dev" "$cleanup_ino" || return 1
        fi
        return 1
    fi
    if [ "$quiescence_timeout" != 0 ]; then
        wait_for_writable_inode_quiescent "$tombstone" "$expected_dev" "$expected_ino" \
            "$quiescence_timeout" || return 1
    fi
    path_matches_exact_identity "$tombstone" "$expected_sha256" "$uid" "$gid" "$mode" \
        "$expected_dev" "$expected_ino" || return 1
    python3 - "$tombstone" "$expected_sha256" "$uid" "$gid" "$mode" \
        "$expected_dev" "$expected_ino" <<'PY'
import hashlib
import os
import stat
import sys

tombstone, expected_sha256, uid, gid, mode, expected_dev, expected_ino = sys.argv[1:]
uid, gid, mode = int(uid), int(gid), int(mode, 8)
expected_dev, expected_ino = int(expected_dev), int(expected_ino)
parent_path, name = os.path.split(tombstone)
parent = os.open(parent_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
try:
    before = os.fstat(descriptor)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        raise RuntimeError("private cleanup tombstone is not regular")
    if (before.st_dev, before.st_ino) != (expected_dev, expected_ino):
        raise RuntimeError("private cleanup tombstone identity changed")
    if (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) != (uid, gid, mode):
        raise RuntimeError("private cleanup tombstone metadata changed")
    chunks = []
    while True:
        chunk = os.read(descriptor, 1024 * 1024)
        if not chunk:
            break
        chunks.append(chunk)
    after_read = os.fstat(descriptor)
    namespace = os.stat(name, dir_fd=parent, follow_symlinks=False)
    stable = lambda value: (
        value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
        value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode), value.st_nlink,
    )
    if not (stable(before) == stable(after_read) == stable(namespace)):
        raise RuntimeError("private cleanup tombstone changed while held")
    raw = b"".join(chunks)
    if len(raw) != before.st_size:
        raise RuntimeError("private cleanup tombstone short read")
    digest = hashlib.sha256(raw).hexdigest()
    if digest != expected_sha256:
        raise RuntimeError("private cleanup tombstone hash changed")
    held_before_unlink = os.fstat(descriptor)
    if stable(held_before_unlink) != stable(before):
        raise RuntimeError("private cleanup tombstone changed before unlink")
    os.unlink(name, dir_fd=parent)
    try:
        os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        raise RuntimeError("private cleanup tombstone namespace survived unlink")
    after_unlink = os.fstat(descriptor)
    if stable(after_unlink) != stable(before)[:-1] + (0,):
        raise RuntimeError("private cleanup held tombstone drift after unlink")
    os.fsync(parent)
finally:
    os.close(descriptor)
    os.close(parent)
PY
    remove_exact_empty_private_cleanup_directory \
        "$cleanup_dir" "$cleanup_dev" "$cleanup_ino" || return 1
    test ! -e "$cleanup_dir" || return 1
    test ! -L "$cleanup_dir" || return 1
}

recover_private_cleanup_tombstone() {
    local path=$1 expected_sha256=$2 uid=$3 gid=$4 mode=$5
    local quiescence_timeout=${6:-0} expected_dev=${7:-} expected_ino=${8:-}
    local allow_derived_identity=${9:-0}
    local parent path_tag prefix cleanup_dir suffix discovered_dev discovered_ino
    parent=${path%/*}
    path_tag="$(printf '%s' "$path" | sha256sum | awk '{print substr($1,1,16)}')" || return 1
    prefix=".cleanup-gl-a-${ARCHIVE_OPERATION_ID}-${path_tag}-"
    cleanup_dir="$(python3 - "$parent" "$prefix" <<'PY'
import os
import stat
import sys

parent, prefix = sys.argv[1:]
matches = []
with os.scandir(parent) as entries:
    for entry in entries:
        if not entry.name.startswith(prefix):
            continue
        value = entry.stat(follow_symlinks=False)
        if not stat.S_ISDIR(value.st_mode):
            raise SystemExit("cleanup recovery path is not a directory")
        if (value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode)) != (0, 0, 0o700):
            raise SystemExit("cleanup recovery directory metadata changed")
        matches.append(entry.path)
if len(matches) > 1:
    raise SystemExit("multiple cleanup recovery directories")
if matches:
    print(matches[0])
PY
)" || return 1
    if [ -z "$cleanup_dir" ]; then return 0; fi
    suffix=${cleanup_dir##*/$prefix}
    printf '%s' "$suffix" | grep -Eq '^[0-9]+-[0-9]+$' || return 1
    discovered_dev=${suffix%%-*}
    discovered_ino=${suffix##*-}
    if [ -n "$expected_dev" ] || [ -n "$expected_ino" ]; then
        test -n "$expected_dev" && test -n "$expected_ino" || return 1
        test "$discovered_dev:$discovered_ino" = "$expected_dev:$expected_ino" || return 1
    else
        test "$allow_derived_identity" = 1 || return 1
        expected_dev=$discovered_dev
        expected_ino=$discovered_ino
    fi
    private_cleanup_tombstone "$path" "$expected_sha256" "$uid" "$gid" "$mode" \
        "$expected_dev" "$expected_ino" "$quiescence_timeout"
}

private_cleanup_tombstone_state() {
    local path=$1 parent path_tag prefix
    parent=${path%/*}
    path_tag="$(printf '%s' "$path" | sha256sum | awk '{print substr($1,1,16)}')" || return 1
    prefix=".cleanup-gl-a-${ARCHIVE_OPERATION_ID}-${path_tag}-"
    python3 - "$parent" "$prefix" <<'PY'
import os
import re
import stat
import sys

parent, prefix = sys.argv[1:]
matches = []
with os.scandir(parent) as entries:
    for entry in entries:
        if not entry.name.startswith(prefix):
            continue
        suffix = entry.name[len(prefix):]
        if re.fullmatch(r"[0-9]+-[0-9]+", suffix) is None:
            raise SystemExit("invalid cleanup recovery directory name")
        value = entry.stat(follow_symlinks=False)
        if not stat.S_ISDIR(value.st_mode):
            raise SystemExit("cleanup recovery path is not a directory")
        if (value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode)) != (0, 0, 0o700):
            raise SystemExit("cleanup recovery directory metadata changed")
        matches.append(entry.path)
if len(matches) > 1:
    raise SystemExit("multiple cleanup recovery directories")
print("present" if matches else "absent")
PY
}

remove_exact_manifest_file() {
    local path=$1 expected_sha256=$2 expected_dev=$3 expected_ino=$4
    private_cleanup_tombstone "$path" "$expected_sha256" 0 0 600 \
        "$expected_dev" "$expected_ino" 0
}
private_cleanup_directory_tombstone() {
    local path=$1 uid=$2 gid=$3 mode=$4 expected_dev=$5 expected_ino=$6
    local parent path_tag prefix cleanup_root payload cleanup_dev cleanup_ino
    parent=${path%/*}
    path_tag="$(printf '%s' "$path" | sha256sum | awk '{print substr($1,1,16)}')" || return 1
    prefix=".cleanup-gl-a-${ARCHIVE_OPERATION_ID}-${path_tag}-directory-"
    cleanup_root="${parent}/${prefix}${expected_dev}-${expected_ino}"
    payload="${cleanup_root}/payload"
    printf '%s:%s' "$expected_dev" "$expected_ino" | grep -Eq '^[0-9]+:[0-9]+$' || return 1
    test ! -L "$path" && test ! -L "$cleanup_root" && test ! -L "$payload" || return 1
    if [ -e "$path" ]; then
        test ! -e "$cleanup_root" || return 1
        directory_matches_exact_empty "$path" "$uid" "$gid" "$mode" "$expected_dev" "$expected_ino" || return 1
        mkdir -m 0700 "$cleanup_root" || return 1
        test "$(stat -c '%u %g %a' "$cleanup_root")" = '0 0 700' || return 1
        cleanup_dev="$(stat -c '%d' "$cleanup_root")" || return 1
        cleanup_ino="$(stat -c '%i' "$cleanup_root")" || return 1
        rename_no_replace "$path" "$payload" || return 1
        test "$(stat -c '%d %i' "$cleanup_root")" = "$cleanup_dev $cleanup_ino" || return 1
    elif [ ! -e "$cleanup_root" ]; then
        return 0
    fi
    test ! -e "$path" && test ! -L "$path" || return 1
    test -d "$cleanup_root" && test ! -L "$cleanup_root" || return 1
    test "$(stat -c '%u %g %a' "$cleanup_root")" = '0 0 700' || return 1
    sync -f "$payload" || return 1
    directory_matches_exact_empty "$payload" "$uid" "$gid" "$mode" \
        "$expected_dev" "$expected_ino" || return 1
    rmdir "$payload" || return 1
    rmdir "$cleanup_root" || return 1
    test ! -e "$cleanup_root" && test ! -L "$cleanup_root"
}

directory_matches_exact_empty() {
    local path=$1 uid=$2 gid=$3 mode=$4 expected_dev=$5 expected_ino=$6
    python3 - "$path" "$uid" "$gid" "$mode" "$expected_dev" "$expected_ino" <<'PY'
import os
import stat
import sys

path, uid, gid, mode, expected_dev, expected_ino = sys.argv[1:]
value = os.lstat(path)
if not stat.S_ISDIR(value.st_mode):
    raise SystemExit(1)
if (value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode), value.st_dev, value.st_ino) != (
    int(uid), int(gid), int(mode, 8), int(expected_dev), int(expected_ino)
):
    raise SystemExit(1)
with os.scandir(path) as entries:
    if next(entries, None) is not None:
        raise SystemExit(1)
PY
}
recover_private_cleanup_directory_tombstone() {
    local path=$1 uid=$2 gid=$3 mode=$4 expected_dev=$5 expected_ino=$6
    local parent path_tag prefix cleanup_root payload
    parent=${path%/*}
    path_tag="$(printf '%s' "$path" | sha256sum | awk '{print substr($1,1,16)}')" || return 1
    prefix=".cleanup-gl-a-${ARCHIVE_OPERATION_ID}-${path_tag}-directory-"
    cleanup_root="${parent}/${prefix}${expected_dev}-${expected_ino}"
    payload="${cleanup_root}/payload"
    test ! -L "$cleanup_root" && test ! -L "$payload" || return 1
    if [ ! -e "$cleanup_root" ]; then return 0; fi
    test ! -e "$path" && test ! -L "$path" || return 1
    test -d "$payload" || return 1
    private_cleanup_directory_tombstone "$path" "$uid" "$gid" "$mode" "$expected_dev" "$expected_ino"
}
recover_rotation_state_cleanup_tombstones() {
    local dir_dev dir_ino entry provenance ledger_sha
    if [ "$ROTATION_STATE_IDENTITY_JSON" = null ]; then return 0; fi
    dir_dev="$(jq -er '.directory.dev' <<< "$ROTATION_STATE_IDENTITY_JSON")" || return 1
    dir_ino="$(jq -er '.directory.ino' <<< "$ROTATION_STATE_IDENTITY_JSON")" || return 1
    if [ -d "$ROTATE_STATE_DIR" ] && [ ! -L "$ROTATE_STATE_DIR" ] \
        && [ "$ROTATION_STATE_SNAPSHOT_JSON" != null ]; then
        entry="$(jq -c '.status' <<< "$ROTATION_STATE_SNAPSHOT_JSON")" || return 1
        if [ "$entry" != null ]; then
            recover_private_cleanup_tombstone "$ROTATE_STATE" "$(jq -er '.sha256' <<< "$entry")" \
                "$(jq -er '.uid' <<< "$entry")" "$(jq -er '.gid' <<< "$entry")" \
                "$(jq -er '.mode' <<< "$entry")" 0 "$(jq -er '.dev' <<< "$entry")" \
                "$(jq -er '.ino' <<< "$entry")" 0 || return 1
        fi
        provenance="$(jq -cer '.provenance' <<< "$ROTATION_STATE_IDENTITY_JSON")" || return 1
        ledger_sha="$(jq -er '.ledger.sha256' <<< "$ROTATION_STATE_SNAPSHOT_JSON")" || return 1
        recover_private_cleanup_tombstone "$ROTATE_PROVENANCE" "$ledger_sha" \
            "$(jq -er '.uid' <<< "$provenance")" "$(jq -er '.gid' <<< "$provenance")" \
            "$(jq -er '.mode' <<< "$provenance")" 0 "$(jq -er '.dev' <<< "$provenance")" \
            "$(jq -er '.ino' <<< "$provenance")" 0 || return 1
    fi
    recover_private_cleanup_directory_tombstone "$ROTATE_STATE_DIR_CANDIDATE" 0 0 750 "$dir_dev" "$dir_ino" \
        || return 1
    recover_private_cleanup_directory_tombstone "$ROTATE_STATE_DIR" 0 0 750 "$dir_dev" "$dir_ino"
}

remove_rotation_state() {
    local dir_dev dir_ino entry provenance ledger_identity snapshot
    if [ "$ROTATION_STATE_IDENTITY_JSON" = null ]; then
        test ! -e "$ROTATE_STATE_DIR" && test ! -L "$ROTATE_STATE_DIR"
        test ! -e "$ROTATE_STATE_DIR_CANDIDATE" && test ! -L "$ROTATE_STATE_DIR_CANDIDATE"
        return
    fi
    dir_dev="$(jq -er '.directory.dev' <<< "$ROTATION_STATE_IDENTITY_JSON")" || return 1
    dir_ino="$(jq -er '.directory.ino' <<< "$ROTATION_STATE_IDENTITY_JSON")" || return 1
    test ! -e "${ROTATE_STATE}.tmp" && test ! -L "${ROTATE_STATE}.tmp" || return 1
    if [ -e "$ROTATE_STATE_DIR_CANDIDATE" ] || [ -L "$ROTATE_STATE_DIR_CANDIDATE" ]; then
        test ! -e "$ROTATE_STATE_DIR" && test ! -L "$ROTATE_STATE_DIR" || return 1
        rotation_state_candidate_is_owned_or_absent || return 1
        provenance="$(jq -cer '.provenance' <<< "$ROTATION_STATE_IDENTITY_JSON")" || return 1
        ledger_identity="$(capture_regular_file_identity_stable \
            "${ROTATE_STATE_DIR_CANDIDATE}/${ROTATE_PROVENANCE##*/}")" || return 1
        test "$(jq -er '.dev' <<< "$ledger_identity")" = "$(jq -er '.dev' <<< "$provenance")" \
            || return 1
        test "$(jq -er '.ino' <<< "$ledger_identity")" = "$(jq -er '.ino' <<< "$provenance")" \
            || return 1
        private_cleanup_tombstone "${ROTATE_STATE_DIR_CANDIDATE}/${ROTATE_PROVENANCE##*/}" \
            "$(jq -er '.sha256' <<< "$ledger_identity")" "$(jq -er '.uid' <<< "$provenance")" \
            "$(jq -er '.gid' <<< "$provenance")" "$(jq -er '.mode' <<< "$provenance")" \
            "$(jq -er '.dev' <<< "$provenance")" "$(jq -er '.ino' <<< "$provenance")" 0 \
            || return 1
        private_cleanup_directory_tombstone "$ROTATE_STATE_DIR_CANDIDATE" 0 0 750 \
            "$dir_dev" "$dir_ino" || return 1
    elif [ -e "$ROTATE_STATE_DIR" ] || [ -L "$ROTATE_STATE_DIR" ]; then
        rotation_state_is_owned || return 1
        test "$ROTATION_STATE_SNAPSHOT_JSON" != null || return 1
        provenance="$(jq -cer '.provenance' <<< "$ROTATION_STATE_IDENTITY_JSON")" || return 1
        snapshot="$(run_rotation_authorized_command rotation-verify "$OPERATION_ID" \
            "$ROTATION_ANCHOR_IDENTITY_JSON" "$RUNTIME_ARTIFACTS_JSON")" || return 1
        test "$(jq -cS . <<< "$snapshot")" = "$ROTATION_STATE_SNAPSHOT_JSON" || return 1
        entry="$(jq -c '.status' <<< "$ROTATION_STATE_SNAPSHOT_JSON")" || return 1
        if [ "$entry" != null ]; then
            private_cleanup_tombstone "$ROTATE_STATE" "$(jq -er '.sha256' <<< "$entry")" \
                "$(jq -er '.uid' <<< "$entry")" "$(jq -er '.gid' <<< "$entry")" \
                "$(jq -er '.mode' <<< "$entry")" "$(jq -er '.dev' <<< "$entry")" \
                "$(jq -er '.ino' <<< "$entry")" 0 || return 1
        fi
        private_cleanup_tombstone "$ROTATE_PROVENANCE" \
            "$(jq -er '.ledger.sha256' <<< "$ROTATION_STATE_SNAPSHOT_JSON")" \
            "$(jq -er '.uid' <<< "$provenance")" "$(jq -er '.gid' <<< "$provenance")" \
            "$(jq -er '.mode' <<< "$provenance")" "$(jq -er '.dev' <<< "$provenance")" \
            "$(jq -er '.ino' <<< "$provenance")" 0 || return 1
        private_cleanup_directory_tombstone "$ROTATE_STATE_DIR" 0 0 750 "$dir_dev" "$dir_ino" \
            || return 1
    fi
    test ! -e "$ROTATE_STATE_DIR" && test ! -L "$ROTATE_STATE_DIR"
    test ! -e "$ROTATE_STATE_DIR_CANDIDATE" && test ! -L "$ROTATE_STATE_DIR_CANDIDATE"
}

copy_file_no_replace() {
    local source=$1
    local destination=$2
    local expected_sha256=$3
    local uid=$4
    local gid=$5
    local mode=$6
    local expected_source_dev=$7
    local expected_source_ino=$8
    python3 - "$source" "$destination" "$expected_sha256" "$uid" "$gid" "$mode" \
        "$expected_source_dev" "$expected_source_ino" <<'PY'
import hashlib
import os
import stat
import sys

source, destination, expected_sha256, uid, gid, mode, expected_source_dev, expected_source_ino = sys.argv[1:]
uid, gid, mode = int(uid), int(gid), int(mode, 8)
expected_source_dev, expected_source_ino = int(expected_source_dev), int(expected_source_ino)
source_descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
try:
    source_before = os.fstat(source_descriptor)
    source_path = os.lstat(source)
    if not stat.S_ISREG(source_before.st_mode) or not stat.S_ISREG(source_path.st_mode):
        raise SystemExit("copy source is not regular")
    if (source_before.st_dev, source_before.st_ino) != (expected_source_dev, expected_source_ino):
        raise SystemExit("copy source descriptor identity changed")
    if (source_path.st_dev, source_path.st_ino) != (expected_source_dev, expected_source_ino):
        raise SystemExit("copy source pathname identity changed")
    destination_descriptor = os.open(
        destination,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
    )
    try:
        digest = hashlib.sha256()
        while True:
            chunk = os.read(source_descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                view = view[os.write(destination_descriptor, view):]
        os.fsync(destination_descriptor)
        os.fchown(destination_descriptor, uid, gid)
        os.fchmod(destination_descriptor, mode)
        os.fsync(destination_descriptor)
        source_after = os.fstat(source_descriptor)
        destination_after = os.fstat(destination_descriptor)
        source_path = os.lstat(source)
        destination_path = os.lstat(destination)
        source_stable_before = (
            source_before.st_dev, source_before.st_ino, source_before.st_uid,
            source_before.st_gid, stat.S_IMODE(source_before.st_mode),
            source_before.st_size, source_before.st_mtime_ns,
        )
        source_stable_after = (
            source_after.st_dev, source_after.st_ino, source_after.st_uid,
            source_after.st_gid, stat.S_IMODE(source_after.st_mode),
            source_after.st_size, source_after.st_mtime_ns,
        )
        if source_stable_before != source_stable_after:
            raise SystemExit("copy source changed while reading")
        if (source_path.st_dev, source_path.st_ino) != (expected_source_dev, expected_source_ino):
            raise SystemExit("copy source pathname changed after read")
        if digest.hexdigest() != expected_sha256:
            raise SystemExit("copy source hash mismatch")
        if (destination_path.st_dev, destination_path.st_ino) != (
            destination_after.st_dev, destination_after.st_ino,
        ):
            raise SystemExit("copy destination pathname changed")
        if (destination_after.st_uid, destination_after.st_gid, stat.S_IMODE(destination_after.st_mode)) != (
            uid, gid, mode,
        ):
            raise SystemExit("copy destination metadata changed")
        destination_dev, destination_ino = destination_after.st_dev, destination_after.st_ino
    finally:
        os.close(destination_descriptor)
finally:
    os.close(source_descriptor)
parent_descriptor = os.open(os.path.dirname(destination), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    os.fsync(parent_descriptor)
finally:
    os.close(parent_descriptor)
print(f"{destination_dev}:{destination_ino}")
PY
}

wait_for_writable_inode_quiescent() {
    local path=$1
    local expected_dev=$2
    local expected_ino=$3
    local timeout_seconds=${4:-5}
    python3 - "$path" "$expected_dev" "$expected_ino" "$timeout_seconds" <<'PY'
import errno
import os
import stat
import sys
import time

path, expected_dev, expected_ino, timeout_seconds = sys.argv[1:]
expected_dev, expected_ino = int(expected_dev), int(expected_ino)
deadline = time.monotonic() + float(timeout_seconds)
previous_identity = None
stable_rounds = 0

def current_identity():
    value = os.lstat(path)
    if not stat.S_ISREG(value.st_mode):
        raise RuntimeError("quiescence target is not regular")
    if (value.st_dev, value.st_ino) != (expected_dev, expected_ino):
        raise RuntimeError("quiescence target identity changed")
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns

def writable_fd_count():
    writers = 0
    # /proc fdinfo flags are octal; O_ACCMODE distinguishes read-only from writable FDs.
    with os.scandir("/proc") as processes:
        for process in processes:
            if not process.name.isdigit():
                continue
            fd_directory = f"/proc/{process.name}/fd"
            try:
                descriptors = os.scandir(fd_directory)
            except FileNotFoundError:
                continue
            except PermissionError as error:
                raise RuntimeError(f"cannot scan {fd_directory}") from error
            with descriptors:
                for descriptor in descriptors:
                    fd_path = descriptor.path
                    try:
                        value = os.stat(fd_path)
                    except FileNotFoundError:
                        continue
                    except PermissionError as error:
                        raise RuntimeError(f"cannot stat {fd_path}") from error
                    if (value.st_dev, value.st_ino) != (expected_dev, expected_ino):
                        continue
                    fdinfo = f"/proc/{process.name}/fdinfo/{descriptor.name}"
                    try:
                        with open(fdinfo, encoding="ascii") as details:
                            flags_line = next(
                                (line for line in details if line.startswith("flags:")),
                                None,
                            )
                    except FileNotFoundError:
                        continue
                    except PermissionError as error:
                        raise RuntimeError(f"cannot read {fdinfo}") from error
                    if flags_line is None:
                        raise RuntimeError(f"missing flags in {fdinfo}")
                    flags = int(flags_line.split()[1], 8)
                    if flags & os.O_ACCMODE in (os.O_WRONLY, os.O_RDWR):
                        writers += 1
    return writers

while True:
    identity = current_identity()
    if writable_fd_count() == 0:
        if identity == previous_identity:
            stable_rounds += 1
        else:
            stable_rounds = 1
        if stable_rounds >= 2:
            raise SystemExit(0)
    else:
        stable_rounds = 0
    previous_identity = identity
    if time.monotonic() >= deadline:
        print("writable-fd quiescence timeout", file=sys.stderr)
        raise SystemExit(errno.ETIMEDOUT)
    time.sleep(0.1)
PY
}

remove_exact_quiescent_file() {
    local path=$1
    local expected_sha256=$2
    local uid=$3
    local gid=$4
    local mode=$5
    local expected_dev=$6
    local expected_ino=$7
    private_cleanup_tombstone "$path" "$expected_sha256" "$uid" "$gid" "$mode" \
        "$expected_dev" "$expected_ino" 5
}

path_matches_exact() {
    local path=$1
    local expected_sha256=$2
    local uid=$3
    local gid=$4
    local mode=$5
    test -f "$path" || return 1
    test ! -L "$path" || return 1
    test "$(sha256sum "$path" | awk '{print $1}')" = "$expected_sha256" || return 1
    test "$(stat -c '%u %g %a' "$path")" = "$uid $gid $mode"
}

path_matches_exact_identity() {
    local path=$1 expected_sha256=$2 uid=$3 gid=$4 mode=$5
    local expected_dev=$6 expected_ino=$7
    path_matches_exact "$path" "$expected_sha256" "$uid" "$gid" "$mode" || return 1
    test "$(stat -c '%d %i' "$path")" = "$expected_dev $expected_ino"
}

restore_displaced_site_no_replace() {
    local site=$1 displaced=$2 expected_sha256=$3 uid=$4 gid=$5 mode=$6
    local expected_dev=$7 expected_ino=$8
    if [ -e "$site" ] || [ -L "$site" ]; then return 1; fi
    path_matches_exact_identity "$displaced" "$expected_sha256" "$uid" "$gid" \
        "$mode" "$expected_dev" "$expected_ino" || return 1
    rename_no_replace "$displaced" "$site" || return 1
    path_matches_exact_identity "$site" "$expected_sha256" "$uid" "$gid" \
        "$mode" "$expected_dev" "$expected_ino"
}

preserve_published_candidate_and_restore_site() {
    local site=$1 candidate=$2 displaced=$3
    local expected_current_sha256=$4 uid=$5 gid=$6 mode=$7
    local expected_current_dev=$8 expected_current_ino=$9
    local expected_candidate_sha256=${10} expected_candidate_dev=${11}
    local expected_candidate_ino=${12}
    path_matches_exact_identity "$displaced" "$expected_current_sha256" \
        "$uid" "$gid" "$mode" "$expected_current_dev" "$expected_current_ino" || return 1
    if [ -e "$candidate" ] || [ -L "$candidate" ]; then return 1; fi
    path_matches_exact_identity "$site" "$expected_candidate_sha256" \
        "$uid" "$gid" "$mode" "$expected_candidate_dev" "$expected_candidate_ino" || return 1
    rename_no_replace "$site" "$candidate" || return 1
    path_matches_exact_identity "$candidate" "$expected_candidate_sha256" \
        "$uid" "$gid" "$mode" "$expected_candidate_dev" "$expected_candidate_ino" || return 1
    restore_displaced_site_no_replace "$site" "$displaced" \
        "$expected_current_sha256" "$uid" "$gid" "$mode" \
        "$expected_current_dev" "$expected_current_ino" || return 1
    path_matches_exact_identity "$site" "$expected_current_sha256" \
        "$uid" "$gid" "$mode" "$expected_current_dev" "$expected_current_ino"
}

publish_site_no_replace() {
    local site=$1
    local candidate=$2
    local displaced=$3 # Forward publication passes the journaled ROLLBACK_CANDIDATE.
    local expected_current_sha256=$4
    local expected_candidate_sha256=$5
    local uid=$6
    local gid=$7
    local mode=$8
    local expected_current_dev=$9
    local expected_current_ino=${10}
    local expected_candidate_dev=${11}
    local expected_candidate_ino=${12}
    # rename_no_replace is Linux renameat2(RENAME_NOREPLACE); EEXIST/ENOENT is a preserved conflict.
    test -f "$site"
    test ! -L "$site"
    test -f "$candidate"
    test ! -L "$candidate"
    test ! -e "$displaced"
    test ! -L "$displaced"
    test "$(sha256sum "$site" | awk '{print $1}')" = "$expected_current_sha256"
    test "$(sha256sum "$candidate" | awk '{print $1}')" = "$expected_candidate_sha256"
    test "$(stat -c '%u %g %a' "$site")" = "$uid $gid $mode"
    test "$(stat -c '%u %g %a' "$candidate")" = "$uid $gid $mode"
    test -n "$expected_current_dev" && test -n "$expected_current_ino"
    test -n "$expected_candidate_dev" && test -n "$expected_candidate_ino"
    path_matches_exact_identity "$site" "$expected_current_sha256" \
        "$uid" "$gid" "$mode" "$expected_current_dev" "$expected_current_ino"
    path_matches_exact_identity "$candidate" "$expected_candidate_sha256" \
        "$uid" "$gid" "$mode" "$expected_candidate_dev" "$expected_candidate_ino"
    test "$expected_current_dev" = "$expected_candidate_dev"
    test "$(stat -c '%d' "$site")" = "$(stat -c '%d' "${displaced%/*}")"
    rename_no_replace "$site" "$displaced" || return 1
    test ! -e "$site"
    test ! -L "$site"
    if ! sync -f "$displaced"; then
        restore_displaced_site_no_replace "$site" "$displaced" \
            "$expected_current_sha256" "$uid" "$gid" "$mode" \
            "$expected_current_dev" "$expected_current_ino" || return 1
        return 1
    fi
    if ! path_matches_exact_identity "$displaced" "$expected_current_sha256" \
        "$uid" "$gid" "$mode" "$expected_current_dev" "$expected_current_ino"; then
        restore_displaced_site_no_replace "$site" "$displaced" \
            "$expected_current_sha256" "$uid" "$gid" "$mode" \
            "$expected_current_dev" "$expected_current_ino" || return 1
        return 1
    fi
    PUBLISHED_DISPLACED_DEV=$expected_current_dev
    PUBLISHED_DISPLACED_INO=$expected_current_ino
    if ! sync -f "$candidate"; then
        restore_displaced_site_no_replace "$site" "$displaced" \
            "$expected_current_sha256" "$uid" "$gid" "$mode" \
            "$expected_current_dev" "$expected_current_ino" || return 1
        return 1
    fi
    if ! path_matches_exact_identity "$candidate" "$expected_candidate_sha256" \
        "$uid" "$gid" "$mode" "$expected_candidate_dev" "$expected_candidate_ino"; then
        restore_displaced_site_no_replace "$site" "$displaced" \
            "$expected_current_sha256" "$uid" "$gid" "$mode" \
            "$expected_current_dev" "$expected_current_ino" || return 1
        return 1
    fi
    if ! rename_no_replace "$candidate" "$site"; then
        restore_displaced_site_no_replace "$site" "$displaced" \
            "$expected_current_sha256" "$uid" "$gid" "$mode" \
            "$expected_current_dev" "$expected_current_ino" || return 1
        return 1
    fi
    if ! path_matches_exact_identity "$site" "$expected_candidate_sha256" \
        "$uid" "$gid" "$mode" "$expected_candidate_dev" "$expected_candidate_ino"; then
        preserve_published_candidate_and_restore_site "$site" "$candidate" "$displaced" \
            "$expected_current_sha256" "$uid" "$gid" "$mode" \
            "$expected_current_dev" "$expected_current_ino" \
            "$expected_candidate_sha256" "$expected_candidate_dev" "$expected_candidate_ino" \
            || return 1
        return 1
    fi
    path_matches_exact_identity "$displaced" "$expected_current_sha256" \
        "$uid" "$gid" "$mode" "$expected_current_dev" "$expected_current_ino" || return 1
    sync -f "$site"
}

performance_logs_are_owned() {
    local path
    local name
    write_find_inventory "$FIND_LOGS_INVENTORY" /var/log/nginx -maxdepth 1 \
        -name 'aifeeds-performance.jsonl*' || return 1
    while IFS= read -r -d '' path; do
        name="${path##*/}"
        printf '%s' "$name" \
            | grep -Eq '^aifeeds-performance[.]jsonl([.][0-9]+([.]gz)?)?$' || return 1
        test -f "$path" || return 1
        test ! -L "$path" || return 1
        test "$(stat -c '%U %G %a' "$path")" = 'www-data adm 640' || return 1
    done < "$FIND_LOGS_INVENTORY"
    rm -f "$FIND_LOGS_INVENTORY"
}

rotation_state_is_owned() {
    local state_path provenance snapshot
    if [ ! -e "$ROTATE_STATE_DIR" ] && [ ! -L "$ROTATE_STATE_DIR" ]; then return 0; fi
    test -d "$ROTATE_STATE_DIR" || return 1
    test ! -L "$ROTATE_STATE_DIR" || return 1
    test "$ROTATION_STATE_IDENTITY_JSON" != null || return 1
    test "$(stat -c '%u %g %a %d %i' "$ROTATE_STATE_DIR")" = \
        "$(jq -r '.directory | [.uid,.gid,.mode,.dev,.ino] | map(tostring) | join(" ")' \
            <<< "$ROTATION_STATE_IDENTITY_JSON")" || return 1
    provenance="$(jq -cer '.provenance' <<< "$ROTATION_STATE_IDENTITY_JSON")" || return 1
    snapshot="$(run_rotation_authorized_command rotation-verify "$OPERATION_ID" \
        "$ROTATION_ANCHOR_IDENTITY_JSON" "$RUNTIME_ARTIFACTS_JSON")" || return 1
    write_find_inventory "$FIND_ROTATION_INVENTORY" "$ROTATE_STATE_DIR" \
        -mindepth 1 -maxdepth 1 || return 1
    while IFS= read -r -d '' state_path; do
        case "$state_path" in "$ROTATE_STATE"|"$ROTATE_PROVENANCE") ;; *) return 1 ;; esac
    done < "$FIND_ROTATION_INVENTORY"
    rm -f "$FIND_ROTATION_INVENTORY"
    test "$(jq -er '.ledger.dev' <<< "$snapshot")" = "$(jq -er '.dev' <<< "$provenance")" \
        || return 1
    test "$(jq -er '.ledger.ino' <<< "$snapshot")" = "$(jq -er '.ino' <<< "$provenance")"
}
rotation_state_candidate_is_owned_or_absent() {
    local dev ino provenance
    test ! -L "$ROTATE_STATE_DIR_CANDIDATE" || return 1
    if [ -e "$ROTATE_STATE_DIR_CANDIDATE" ]; then
        test "$ROTATION_STATE_IDENTITY_JSON" != null || return 1
        dev="$(jq -er '.directory.dev' <<< "$ROTATION_STATE_IDENTITY_JSON")" || return 1
        ino="$(jq -er '.directory.ino' <<< "$ROTATION_STATE_IDENTITY_JSON")" || return 1
        provenance="$(jq -cer '.provenance' <<< "$ROTATION_STATE_IDENTITY_JSON")" || return 1
        directory_matches_exact_identity "$ROTATE_STATE_DIR_CANDIDATE" 0 0 750 "$dev" "$ino" \
            || return 1
        python3 "$STAGING/check-nginx-request-id.py" rotation-verify-initialized "$OPERATION_ID" \
            "$ROTATE_STATE_DIR_CANDIDATE" "$(jq -er '.dev' <<< "$provenance")" \
            "$(jq -er '.ino' <<< "$provenance")" \
            "$(jq -er '.genesis_record_sha256' <<< "$provenance")" >/dev/null || return 1
    fi
}

rollback_audit_is_owned() {
    local path
    local name
    local base_name
    if [ ! -e "$AUDIT_DIR" ] && [ ! -L "$AUDIT_DIR" ]; then return 0; fi
    test -d "$AUDIT_DIR" || return 1
    test ! -L "$AUDIT_DIR" || return 1
    test "$(stat -c '%U %G %a' "$AUDIT_DIR")" = 'root root 700' || return 1
    write_find_inventory "$FIND_AUDIT_INVENTORY" "$AUDIT_DIR" \
        -mindepth 1 -maxdepth 1 || return 1
    while IFS= read -r -d '' path; do
        test -f "$path" || return 1
        test ! -L "$path" || return 1
        test "$(stat -c '%U %G %a' "$path")" = 'root root 600' || return 1
        name="${path##*/}"
        case "$name" in
            archive-manifest.json|archive-manifest.json.tmp)
                archive_manifest_is_owned "$path" || return 1
                ;;
            archive-manifest.json.previous-gl-a-*)
                test "$path" = "$ARCHIVE_MANIFEST_PREVIOUS" || return 1
                archive_manifest_is_owned "$path" || return 1
                ;;
            *)
                base_name="${name%.candidate-gl-a-${OPERATION_ID}}"
                printf '%s' "$base_name" \
                    | grep -Eq '^aifeeds-performance[.]jsonl([.][0-9]+([.]gz)?)?$' || return 1
                ;;
        esac
    done < "$FIND_AUDIT_INVENTORY"
    rm -f "$FIND_AUDIT_INVENTORY"
}

ensure_audit_dir_owned() {
    if [ -e "$AUDIT_DIR" ] || [ -L "$AUDIT_DIR" ]; then
        test -d "$AUDIT_DIR" || return 1
        test ! -L "$AUDIT_DIR" || return 1
        test "$(stat -c '%U %G %a' "$AUDIT_DIR")" = 'root root 700' || return 1
    else
        install -d -o root -g root -m 0700 "$AUDIT_DIR" || return 1
    fi
}

assert_site_base_unchanged() {
    assert_enabled_site_target || return 1
    formal_site_matches_state "$SITE" base
}

assert_backup_unchanged() {
    local backup_dev backup_ino
    test "$SITE_BACKUP_IDENTITY_JSON" != null || return 1
    backup_dev="$(jq -er '.dev' <<< "$SITE_BACKUP_IDENTITY_JSON")" || return 1
    backup_ino="$(jq -er '.ino' <<< "$SITE_BACKUP_IDENTITY_JSON")" || return 1
    test -f "$BACKUP" || return 1
    test ! -L "$BACKUP" || return 1
    test "$(sha256sum "$BACKUP" | awk '{print $1}')" = "$SITE_BACKUP_SHA256" || return 1
    test "$(stat -c '%u' "$BACKUP")" = "$SITE_UID" || return 1
    test "$(stat -c '%g' "$BACKUP")" = "$SITE_GID" || return 1
    test "$(stat -c '%a' "$BACKUP")" = "$SITE_MODE" || return 1
    test "$(stat -c '%d %i' "$BACKUP")" = "$backup_dev $backup_ino" || return 1
}

rotation_anchor_is_owned_or_absent() {
    local state observed expected_dev expected_ino expected_sha256 expected_size observed_size
    if [ "$ROTATION_ANCHOR_IDENTITY_JSON" = null ]; then
        test ! -e "$ROTATION_ANCHOR" && test ! -L "$ROTATION_ANCHOR"
        return
    fi
    test "$(jq -er '.path' <<< "$ROTATION_ANCHOR_IDENTITY_JSON")" = "$ROTATION_ANCHOR" \
        || return 1
    test ! -L "$ROTATION_ANCHOR" || return 1
    if [ ! -e "$ROTATION_ANCHOR" ]; then return 0; fi
    observed="$(capture_regular_file_identity_stable "$ROTATION_ANCHOR")" || return 1
    expected_dev="$(jq -er '.dev' <<< "$ROTATION_ANCHOR_IDENTITY_JSON")" || return 1
    expected_ino="$(jq -er '.ino' <<< "$ROTATION_ANCHOR_IDENTITY_JSON")" || return 1
    test "$(jq -r '[.uid,.gid,.mode,.dev,.ino] | map(tostring) | join(" ")' \
        <<< "$observed")" = "0 0 600 $expected_dev $expected_ino" || return 1
    state="$(jq -er '.state' <<< "$ROTATION_ANCHOR_IDENTITY_JSON")" || return 1
    expected_sha256="$(jq -er '.sha256' <<< "$ROTATION_ANCHOR_IDENTITY_JSON")" || return 1
    expected_size="$(jq -er '.size' <<< "$ROTATION_ANCHOR_IDENTITY_JSON")" || return 1
    observed_size="$(jq -er '.size' <<< "$observed")" || return 1
    case "$state" in
        allocated|sealed)
            test "$(jq -er '.sha256' <<< "$observed")" = "$expected_sha256" || return 1
            test "$observed_size" = "$expected_size" || return 1
            ;;
        prepared)
            test "$observed_size" -le "$expected_size" || return 1
            if [ "$observed_size" = "$expected_size" ]; then
                test "$(jq -er '.sha256' <<< "$observed")" = "$expected_sha256" || return 1
            fi
            ;;
        *) return 1 ;;
    esac
}

remove_rotation_anchor() {
    local observed
    rotation_anchor_is_owned_or_absent || return 1
    if [ -e "$ROTATION_ANCHOR" ]; then
        observed="$(capture_regular_file_identity_stable "$ROTATION_ANCHOR")" || return 1
        private_cleanup_tombstone "$ROTATION_ANCHOR" "$(jq -er '.sha256' <<< "$observed")" \
            0 0 600 "$(jq -er '.dev' <<< "$ROTATION_ANCHOR_IDENTITY_JSON")" \
            "$(jq -er '.ino' <<< "$ROTATION_ANCHOR_IDENTITY_JSON")" 0 || return 1
    fi
    test ! -e "$ROTATION_ANCHOR" && test ! -L "$ROTATION_ANCHOR"
}

# Journal updates are a four-path compare-and-swap protocol.  F is the public
# journal, T is its O_EXCL update intent, P is the exact predecessor, and C is
# the private predecessor-cleanup tombstone.  This helper deliberately owns the
# whole protocol so no caller can fall back to a pathname-selected journal.
journal_update_cas() {
    local final=$1 previous=$2 kind=$3 phase=$4 legacy_expected_sha256=$5
    local payload=${6:-}
    local action=${7:-update}
    python3 - "$final" "${final}.tmp" "$previous" "${previous}.cleanup" \
        "$kind" "$phase" "$JOURNAL_OPERATION_ID" "$legacy_expected_sha256" "$payload" "$action" <<'PY'
import ctypes
import hashlib
import json
import os
import stat
import sys

final, temporary, previous, cleanup, kind, requested_phase, operation_id, legacy_hash, payload, action = sys.argv[1:]
RENAME_NOREPLACE = 1
libc = ctypes.CDLL(None, use_errno=True)


def fail(message):
    raise RuntimeError(message)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode()


def reject_duplicate_keys(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            fail("duplicate journal JSON key")
        value[key] = item
    return value


def reject_json_constant(value):
    fail("non-finite journal JSON constant: " + value)


def decode_json(raw):
    return json.loads(
        raw, object_pairs_hook=reject_duplicate_keys,
        parse_constant=reject_json_constant,
    )


def write_all(descriptor, data):
    remaining = memoryview(data)
    while remaining:
        count = os.write(descriptor, remaining)
        if count <= 0:
            fail("short journal update write")
        remaining = remaining[count:]


def rename_noreplace(source, destination):
    result = libc.renameat2(
        ctypes.c_int(-100), os.fsencode(source), ctypes.c_int(-100),
        os.fsencode(destination), ctypes.c_uint(RENAME_NOREPLACE),
    )
    if result != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), destination)


def fsync_parent():
    parent_descriptor = os.open(os.path.dirname(final), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(parent_descriptor)
    finally:
        os.close(parent_descriptor)


def exists(path):
    try:
        os.lstat(path)
        return True
    except FileNotFoundError:
        return False


def read_exact(path):
    pathname_before = os.lstat(path)
    if stat.S_ISLNK(pathname_before.st_mode):
        fail("journal update path is a symlink")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            fail("journal update path is not regular")
        if before.st_nlink != 1:
            fail("journal update link count drift")
        if (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) != (0, 0, 0o600):
            fail("journal update metadata drift")
        chunks = []
        while True:
            chunk = os.read(descriptor, 65536)
            if not chunk:
                break
            chunks.append(chunk)
        after = os.fstat(descriptor)
        pathname_after = os.lstat(path)
    finally:
        os.close(descriptor)
    identity = (
        before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns,
        before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode), before.st_nlink,
    )
    pathname_before_identity = (
        pathname_before.st_dev, pathname_before.st_ino, pathname_before.st_size,
        pathname_before.st_mtime_ns, pathname_before.st_uid, pathname_before.st_gid,
        stat.S_IMODE(pathname_before.st_mode), pathname_before.st_nlink,
    )
    if identity != pathname_before_identity:
        fail("journal pathname changed before open")
    if identity != (
        after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns,
        after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode), after.st_nlink,
    ):
        fail("journal changed while reading")
    if identity != (
        pathname_after.st_dev, pathname_after.st_ino,
        pathname_after.st_size, pathname_after.st_mtime_ns,
        pathname_after.st_uid, pathname_after.st_gid,
        stat.S_IMODE(pathname_after.st_mode), pathname_after.st_nlink,
    ):
        fail("journal pathname identity drift")
    raw = b"".join(chunks)
    if len(raw) != before.st_size:
        fail("partial journal update")
    return {
        "raw": raw, "sha256": hashlib.sha256(raw).hexdigest(),
        "dev": before.st_dev, "ino": before.st_ino,
    }


def parse_json(record):
    try:
        value = decode_json(record["raw"])
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("invalid/partial journal update") from error
    if not isinstance(value, dict):
        fail("invalid journal update payload")
    record["value"] = value
    return record


SOURCE_REQUIRED = {
    "schema", "gate", "phase", "operation_id", "g0_commit", "rollback_helper_sha256",
    "transaction_journal", "installer_candidate", "rollback_candidate", "site_backup",
    "audit_dir", "log_archive_manifest", "site_backup_sha256", "installed_site_sha256",
    "original_site_uid", "original_site_gid", "original_site_mode", "original_site_dev",
    "original_site_ino", "artifacts_sha256", "artifact_candidates", "runtime_artifacts",
    "runtime_artifacts_sealed", "rotation_state_identity", "rotation_state_snapshot",
    "rotation_anchor_identity", "site_backup_identity",
}
SOURCE_OPTIONAL = {
    "journal_update", "installer_candidate_dev", "installer_candidate_ino",
    "rollback_candidate_dev", "rollback_candidate_ino", "displaced_site_dev",
    "displaced_site_ino", "failed_from", "rollback_origin_phase", "rollback_journal",
    "rollback_commit_marker", "log_archive_manifest_sha256",
    "log_archive_manifest_generation", "log_archive_manifest_entry_count", "runtime_cleanup",
}
ROLLBACK_REQUIRED = {
    "schema", "gate", "phase", "operation_id", "g0_commit", "rollback_helper_sha256",
    "source_journal", "source_journal_sha256", "source_origin_phase", "rollback_journal",
    "rollback_commit_marker", "rollback_candidate", "site_backup", "audit_dir",
    "log_archive_manifest", "site_backup_sha256", "installed_site_sha256",
    "original_site_uid", "original_site_gid", "original_site_mode", "original_site_dev",
    "original_site_ino", "artifacts_sha256", "artifact_candidates", "runtime_artifacts",
    "runtime_artifacts_sealed", "rotation_state_identity", "rotation_state_snapshot",
    "rotation_anchor_identity", "site_backup_identity",
}
ROLLBACK_OPTIONAL = {
    "journal_update", "rollback_candidate_dev", "rollback_candidate_ino",
    "partial_backup_sha256", "partial_backup_dev", "partial_backup_ino",
    "installer_candidate_dev", "installer_candidate_ino", "displaced_site_dev",
    "displaced_site_ino", "failed_from", "source_journal_terminal_sha256",
    "log_archive_manifest_sha256", "log_archive_manifest_generation",
    "log_archive_manifest_entry_count", "runtime_cleanup",
}

AUTHORITY_SOURCE_RECORD = None


def is_integer(value, minimum=0):
    return type(value) is int and value >= minimum


def is_hex(value, size):
    import re
    return isinstance(value, str) and re.fullmatch(rf"[a-f0-9]{{{size}}}", value) is not None


EXPECTED_SLOTS = [
    "site_installer", "site_restore", "timer", "service", "rotation_status",
    "rotation_provenance", "rotation_state_dir", "rotation_anchor", "checker",
    "rotate", "format", "diff_checker", "inserter", "log",
]


RUNTIME_FINALS = {
    "timer": "/etc/systemd/system/aifeeds-performance-logrotate.timer",
    "service": "/etc/systemd/system/aifeeds-performance-logrotate.service",
    "checker": "/usr/local/sbin/aifeeds-check-nginx-request-id",
    "rotate": "/etc/aifeeds-performance-logrotate.conf",
    "format": "/etc/nginx/conf.d/aifeeds-performance-log.conf",
    "diff_checker": "/usr/local/sbin/aifeeds-verify-nginx-request-id-diff",
    "inserter": "/usr/local/sbin/aifeeds-insert-nginx-request-id",
    "log": "/var/log/nginx/aifeeds-performance.jsonl",
}


def cleanup_file_identity(value, sha256=None):
    return {
        "sha256": value["sha256"] if sha256 is None else sha256,
        "uid": value["uid"], "gid": value["gid"], "mode": value["mode"],
        "dev": value["dev"], "ino": value["ino"],
    }


def cleanup_handoff_identity(value):
    return {
        "uid": value["uid"], "gid": value["gid"], "mode": value["mode"],
        "dev": value["dev"], "ino": value["ino"],
    }


def prelive_empty_manifest_authorizes_installer_absence(business, installer_candidate):
    if business.get("source_origin_phase") not in ("initializing", "prepared") \
            or exists(installer_candidate):
        return False
    manifest_path = business.get("log_archive_manifest")
    expected_path = (
        f"/var/backups/aifeeds-performance-log/audit-{operation_id}/archive-manifest.json"
    )
    if manifest_path != expected_path \
            or exists(manifest_path + ".tmp") \
            or exists(manifest_path + f".previous-gl-a-{operation_id}"):
        return False

    def capture_manifest():
        try:
            pathname_before = os.lstat(manifest_path)
            descriptor = os.open(manifest_path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return None
        try:
            before = os.fstat(descriptor)
            chunks = []
            while True:
                chunk = os.read(descriptor, 65536)
                if not chunk:
                    break
                chunks.append(chunk)
            after = os.fstat(descriptor)
            pathname_after = os.lstat(manifest_path)
        finally:
            os.close(descriptor)
        stable = lambda item: (
            item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns,
            item.st_uid, item.st_gid, stat.S_IMODE(item.st_mode), item.st_nlink,
        )
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 \
                or (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) != (0, 0, 0o600) \
                or not (stable(pathname_before) == stable(before) == stable(after) == stable(pathname_after)):
            return None
        raw = b"".join(chunks)
        if len(raw) != before.st_size:
            return None
        return raw, stable(before)

    before_capture = capture_manifest()
    if before_capture is None:
        return False
    value = decode_json(before_capture[0])
    exact_keys = {
        "schema", "operation_id", "generation", "previous_manifest_sha256",
        "previous_manifest_dev", "previous_manifest_ino", "inventory_complete",
        "empty_inventory", "entries",
    }
    valid = isinstance(value, dict) and set(value) == exact_keys \
        and type(value.get("schema")) is int and value["schema"] == 2 \
        and value.get("operation_id") == operation_id \
        and type(value.get("generation")) is int and value["generation"] == 1 \
        and is_hex(value.get("previous_manifest_sha256"), 64) \
        and is_integer(value.get("previous_manifest_dev"), 1) \
        and is_integer(value.get("previous_manifest_ino"), 1) \
        and value.get("inventory_complete") is True \
        and value.get("empty_inventory") is True \
        and value.get("entries") == []
    if not valid:
        return False
    after_capture = capture_manifest()
    return after_capture == before_capture \
        and not exists(installer_candidate) \
        and not exists(manifest_path + ".tmp") \
        and not exists(manifest_path + f".previous-gl-a-{operation_id}")


def expected_cleanup_items(business, cleanup_value):
    actual_items = cleanup_value["items"]
    legacy_compatibility = cleanup_value.get("compatibility_mode") == "legacy_runtime_removed"
    rotation_snapshot = business["rotation_state_snapshot"]
    rotation_anchor = business["rotation_anchor_identity"]
    prepublication_runtime = (
        business["runtime_artifacts_sealed"] is False
        and isinstance(rotation_snapshot, dict)
        and rotation_snapshot.get("generation") == 0
        and rotation_snapshot.get("status") is None
        and isinstance(rotation_anchor, dict)
        and rotation_anchor.get("state") == "allocated"
    )
    result = []
    installer_candidate = f"/etc/nginx/sites-available/aifeeds.conf.candidate-gl-a-{operation_id}"

    def add(slot, action, kind_value, paths, selected, identity):
        index = len(result)
        base = selected or paths[0]
        result.append({
            "slot": slot, "action": action, "kind": kind_value, "paths": paths,
            "selected_path": selected,
            "tombstone": base + f".runtime-cleanup-gl-a-{operation_id}-{index:02d}",
            "identity": identity,
        })

    def bound_selected(paths):
        selected = actual_items[len(result)]["selected_path"]
        return selected if selected in paths else None

    def legacy_assert_absent():
        return legacy_compatibility \
            and actual_items[len(result)].get("action") == "assert_absent"

    if business["installed_site_sha256"] == "absent" \
            or legacy_assert_absent() \
            or (
                actual_items[len(result)]["action"] == "assert_absent"
                and prelive_empty_manifest_authorizes_installer_absence(
                    business, installer_candidate
                )
            ):
        add("site_installer", "assert_absent", "file", [installer_candidate], None, None)
    else:
        identity = {
            "sha256": business["installed_site_sha256"],
            "uid": business["original_site_uid"], "gid": business["original_site_gid"],
            "mode": business["original_site_mode"],
            "dev": business["installer_candidate_dev"], "ino": business["installer_candidate_ino"],
        }
        add("site_installer", "delete", "file", [installer_candidate],
            installer_candidate, identity)
    add("site_restore", "assert_absent", "file", [business["rollback_candidate"]], None, None)
    runtime = {entry["name"]: entry for entry in business["runtime_artifacts"]}

    def add_runtime(slot, name, action="delete"):
        entry = runtime.get(name)
        if entry is None:
            add(slot, "assert_absent", "file", [RUNTIME_FINALS[name]], None, None)
            return
        if name != "log" and legacy_assert_absent():
            add(slot, "assert_absent", "file", [entry["candidate"], entry["final"]], None, None)
            return
        identity = cleanup_file_identity(entry)
        if name == "log" and prepublication_runtime:
            paths = [entry["candidate"], entry["final"]]
            add(slot, "delete", "file", paths, entry["candidate"], identity)
            return
        if name == "log":
            log_identity = actual_items[len(result)]["identity"]
            identity = cleanup_handoff_identity({
                **entry, "dev": log_identity["dev"], "ino": log_identity["ino"],
            })
        paths = [entry["candidate"], entry["final"]]
        selected = entry["final"] if name == "log" else bound_selected(paths)
        add(slot, action, "file", paths, selected, identity)

    add_runtime("timer", "timer")
    add_runtime("service", "service")
    snapshot = business["rotation_state_snapshot"]
    status = snapshot.get("status") if isinstance(snapshot, dict) else None
    if status is None:
        add("rotation_status", "assert_absent", "file",
            ["/var/lib/aifeeds-performance-logrotate/status"], None, None)
    else:
        paths = [status["path"]]
        if legacy_assert_absent():
            add("rotation_status", "assert_absent", "file", paths, None, None)
        else:
            add("rotation_status", "delete", "file", paths, bound_selected(paths),
                cleanup_file_identity(status))
    state = business["rotation_state_identity"]
    if state is None:
        add("rotation_provenance", "assert_absent", "file",
            ["/var/lib/aifeeds-performance-logrotate/rotation-provenance.jsonl"], None, None)
        add("rotation_state_dir", "assert_absent", "directory", [
            f"/var/lib/aifeeds-performance-logrotate.candidate-gl-a-{operation_id}",
            "/var/lib/aifeeds-performance-logrotate",
        ], None, None)
    else:
        provenance = state["provenance"]
        directory = state["directory"]
        provenance_identity = cleanup_file_identity(
            provenance, snapshot["ledger"]["sha256"]
        )
        provenance_paths = [
            directory["candidate"] + "/rotation-provenance.jsonl", provenance["path"],
        ]
        if legacy_assert_absent():
            add("rotation_provenance", "assert_absent", "file", provenance_paths, None, None)
        else:
            add("rotation_provenance", "delete", "file", provenance_paths,
                bound_selected(provenance_paths), provenance_identity)
        directory_identity = {
            key: directory[key] for key in ("uid", "gid", "mode", "dev", "ino")
        }
        directory_paths = [directory["candidate"], directory["path"]]
        if legacy_assert_absent():
            add("rotation_state_dir", "assert_absent", "directory", directory_paths, None, None)
        else:
            add("rotation_state_dir", "delete", "directory", directory_paths,
                bound_selected(directory_paths), directory_identity)
    anchor = business["rotation_anchor_identity"]
    if anchor is None:
        add("rotation_anchor", "assert_absent", "file",
            [f"/var/backups/aifeeds-performance-log/rotation-anchor-{operation_id}.json"], None, None)
    else:
        paths = [anchor["path"]]
        if legacy_assert_absent():
            add("rotation_anchor", "assert_absent", "file", paths, None, None)
        else:
            add("rotation_anchor", "delete", "file", paths, bound_selected(paths),
                cleanup_file_identity(anchor))
    add_runtime("checker", "checker")
    add_runtime("rotate", "rotate")
    add_runtime("format", "format")
    add_runtime("diff_checker", "diff_checker")
    add_runtime("inserter", "inserter")
    add_runtime("log", "log", "archive_handoff")
    return result


def verify_cleanup_genesis_physical(cleanup_value):
    def stable(value):
        return (
            value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
            value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode), value.st_nlink,
        )

    def stable_handoff(value):
        return (
            value.st_dev, value.st_ino, value.st_uid, value.st_gid,
            stat.S_IMODE(value.st_mode), value.st_nlink,
        )

    compatibility_mode = cleanup_value.get("compatibility_mode") == "legacy_runtime_removed"
    for item in cleanup_value["items"]:
        selected = item["selected_path"]
        tombstone = item["tombstone"]
        tombstone_exists = exists(tombstone)
        compatibility_tombstone = (
            compatibility_mode and item["action"] == "delete" and tombstone_exists
        )
        if tombstone_exists and not compatibility_tombstone:
            fail("runtime cleanup genesis tombstone exists")
        if item["action"] == "assert_absent":
            if any(exists(path) for path in item["paths"]):
                fail("runtime cleanup genesis absence drift")
            continue
        if any(exists(path) for path in item["paths"] if path != selected):
            fail("runtime cleanup genesis alternate path exists")
        if compatibility_tombstone and exists(selected):
            fail("runtime cleanup compatibility source and tombstone coexist")
        physical_path = tombstone if compatibility_tombstone else selected
        pathname_before = os.lstat(physical_path)
        if stat.S_ISLNK(pathname_before.st_mode):
            fail("runtime cleanup genesis path is symlink")
        flags = os.O_RDONLY | os.O_NOFOLLOW
        if item["kind"] == "directory":
            flags |= os.O_DIRECTORY
        descriptor = os.open(physical_path, flags)
        try:
            before = os.fstat(descriptor)
            digest = None
            compatibility_directory_nonempty = False
            if item["kind"] == "file" and item["action"] != "archive_handoff":
                digest = hashlib.file_digest(
                    os.fdopen(os.dup(descriptor), "rb", buffering=0), "sha256"
                ).hexdigest()
            elif item["kind"] == "directory" and compatibility_tombstone:
                compatibility_directory_nonempty = bool(os.listdir(descriptor))
            after = os.fstat(descriptor)
            pathname_after = os.lstat(physical_path)
        finally:
            os.close(descriptor)
        stable_identity = stable_handoff if item["action"] == "archive_handoff" else stable
        if not (stable_identity(pathname_before) == stable_identity(before)
                == stable_identity(after) == stable_identity(pathname_after)):
            fail("runtime cleanup genesis path changed")
        identity = item["identity"]
        if (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode), before.st_dev, before.st_ino) != (
            identity["uid"], identity["gid"], int(identity["mode"], 8),
            identity["dev"], identity["ino"],
        ):
            fail("runtime cleanup genesis identity drift")
        if item["kind"] == "file":
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 \
                    or (item["action"] != "archive_handoff"
                        and digest != identity["sha256"]):
                fail("runtime cleanup genesis file drift")
        elif not stat.S_ISDIR(before.st_mode):
            fail("runtime cleanup genesis directory drift")
        elif compatibility_directory_nonempty:
            fail("runtime cleanup compatibility directory tombstone is not empty")


def validate_runtime_cleanup(cleanup_value, business):
    import re
    normal_keys = {"schema", "plan_sha256", "items", "cursor", "cursor_state"}
    compatibility_keys = normal_keys | {"compatibility_mode"}
    if not isinstance(cleanup_value, dict) or frozenset(cleanup_value) not in {
        frozenset(normal_keys), frozenset(compatibility_keys),
    }:
        fail("runtime cleanup top-level schema drift")
    compatibility_mode = cleanup_value.get("compatibility_mode")
    effective_business_phase = effective_phase(business)
    if compatibility_mode is not None and (
        compatibility_mode != "legacy_runtime_removed"
        or effective_business_phase not in {"runtime_removed", "nginx_reloaded", "logs_archived", "rolled_back"}
    ):
        fail("runtime cleanup compatibility mode drift")
    if type(cleanup_value["schema"]) is not int or cleanup_value["schema"] != 1:
        fail("runtime cleanup schema drift")
    items = cleanup_value["items"]
    if not isinstance(items, list) or len(items) != 14:
        fail("runtime cleanup item count drift")
    if [item.get("slot") if isinstance(item, dict) else None for item in items] != EXPECTED_SLOTS:
        fail("runtime cleanup slot order drift")
    if cleanup_value["plan_sha256"] != hashlib.sha256(canonical(items)).hexdigest():
        fail("runtime cleanup plan hash drift")
    cursor = cleanup_value["cursor"]
    state_value = cleanup_value["cursor_state"]
    if type(cursor) is not int or cursor < 0 or cursor > len(items):
        fail("runtime cleanup cursor drift")
    if state_value not in {"pending", "detaching", "detached", "complete"}:
        fail("runtime cleanup cursor state drift")
    if (state_value == "complete") != (cursor == len(items)):
        fail("runtime cleanup completion drift")
    for index, item in enumerate(items):
        if not isinstance(item, dict) or set(item) != {
            "slot", "action", "kind", "paths", "selected_path", "tombstone", "identity",
        }:
            fail("runtime cleanup item schema drift")
        if item["action"] not in {"delete", "assert_absent", "archive_handoff"}:
            fail("runtime cleanup action drift")
        if item["kind"] not in {"file", "directory"}:
            fail("runtime cleanup kind drift")
        expected_kind = "directory" if item["slot"] == "rotation_state_dir" else "file"
        if item["kind"] != expected_kind:
            fail("runtime cleanup slot kind drift")
        if (item["action"] == "archive_handoff") != (
            item["slot"] == "log" and item["selected_path"] is not None
        ) and item["action"] == "archive_handoff":
            fail("runtime cleanup archive action drift")
        if item["slot"] == "log" and item["selected_path"] is not None:
            prepublication_log = (
                business["runtime_artifacts_sealed"] is False
                and isinstance(business["rotation_state_snapshot"], dict)
                and business["rotation_state_snapshot"].get("generation") == 0
                and business["rotation_state_snapshot"].get("status") is None
                and isinstance(business["rotation_anchor_identity"], dict)
                and business["rotation_anchor_identity"].get("state") == "allocated"
            )
            expected_log_action = "delete" if prepublication_log else "archive_handoff"
            if item["action"] != expected_log_action:
                fail("runtime cleanup log action drift")
        if not isinstance(item["paths"], list) or len(item["paths"]) not in {1, 2} \
                or len(set(item["paths"])) != len(item["paths"]) \
                or not all(isinstance(path, str) and path.startswith("/") for path in item["paths"]):
            fail("runtime cleanup paths drift")
        if item["selected_path"] is not None and item["selected_path"] not in item["paths"]:
            fail("runtime cleanup selected path drift")
        expected_tombstone_base = item["selected_path"] or item["paths"][0]
        expected_tombstone = expected_tombstone_base + f".runtime-cleanup-gl-a-{operation_id}-{index:02d}"
        if item["tombstone"] != expected_tombstone:
            fail("runtime cleanup tombstone binding drift")
        identity = item["identity"]
        if (item["action"] == "assert_absent") != (identity is None):
            fail("runtime cleanup action identity drift")
        if item["action"] == "assert_absent" and item["selected_path"] is not None:
            fail("runtime cleanup absent selection drift")
        if item["action"] != "assert_absent" and item["selected_path"] is None:
            fail("runtime cleanup allocated selection drift")
        if identity is not None:
            expected_keys = {"uid", "gid", "mode", "dev", "ino"}
            if item["kind"] == "file" and item["action"] != "archive_handoff":
                expected_keys.add("sha256")
            if not isinstance(identity, dict) or set(identity) != expected_keys:
                fail("runtime cleanup identity schema drift")
            if not all(is_integer(identity[key]) for key in ("uid", "gid")) \
                    or not all(is_integer(identity[key], 1) for key in ("dev", "ino")) \
                or not isinstance(identity["mode"], str) \
                or re.fullmatch(r"[0-7]{3,4}", identity["mode"]) is None:
                fail("runtime cleanup identity type drift")
            if item["kind"] == "file" and item["action"] != "archive_handoff" \
                    and not is_hex(identity["sha256"], 64):
                fail("runtime cleanup file hash drift")
    try:
        expected_items = expected_cleanup_items(business, cleanup_value)
    except (KeyError, TypeError, ValueError) as error:
        raise RuntimeError("runtime cleanup business binding drift") from error
    if items != expected_items:
        for index, (actual, expected) in enumerate(zip(items, expected_items)):
            for key in sorted(set(actual) | set(expected)):
                if actual.get(key, MISSING) != expected.get(key, MISSING):
                    fail(f"runtime cleanup canonical item authority drift: {index}:{key}")
        fail("runtime cleanup canonical item authority drift: length")


def validate_runtime_artifacts(value):
    if not isinstance(value, list) or len(value) > 8:
        fail("runtime artifact inventory type drift")
    expected_order = [
        "format", "log", "checker", "diff_checker", "inserter", "rotate", "timer", "service",
    ]
    names = []
    for item in value:
        if not isinstance(item, dict) or set(item) != {
            "name", "final", "candidate", "sha256", "uid", "gid", "mode", "dev", "ino",
        }:
            fail("runtime artifact item schema drift")
        if not isinstance(item["name"], str) or not is_hex(item["sha256"], 64):
            fail("runtime artifact item identity drift")
        if not all(isinstance(item[key], str) for key in ("final", "candidate", "mode")):
            fail("runtime artifact item path drift")
        if not all(is_integer(item[key]) for key in ("uid", "gid")):
            fail("runtime artifact metadata drift")
        if not all(is_integer(item[key], 1) for key in ("dev", "ino")):
            fail("runtime artifact inode drift")
        names.append(item["name"])
    if names != expected_order[:len(names)]:
        fail("runtime artifact inventory order drift")
    expected_paths = {
        "format": ("/etc/nginx/conf.d/aifeeds-performance-log.conf", "/etc/nginx/conf.d/aifeeds-performance-log.conf.candidate-gl-a-" + operation_id, "644"),
        "log": ("/var/log/nginx/aifeeds-performance.jsonl", "/var/log/nginx/.aifeeds-performance.jsonl.candidate-gl-a-" + operation_id, "640"),
        "checker": ("/usr/local/sbin/aifeeds-check-nginx-request-id", "/usr/local/sbin/aifeeds-check-nginx-request-id.candidate-gl-a-" + operation_id, "755"),
        "diff_checker": ("/usr/local/sbin/aifeeds-verify-nginx-request-id-diff", "/usr/local/sbin/aifeeds-verify-nginx-request-id-diff.candidate-gl-a-" + operation_id, "755"),
        "inserter": ("/usr/local/sbin/aifeeds-insert-nginx-request-id", "/usr/local/sbin/aifeeds-insert-nginx-request-id.candidate-gl-a-" + operation_id, "755"),
        "rotate": ("/etc/aifeeds-performance-logrotate.conf", "/etc/aifeeds-performance-logrotate.conf.candidate-gl-a-" + operation_id, "644"),
        "timer": ("/etc/systemd/system/aifeeds-performance-logrotate.timer", "/etc/systemd/system/aifeeds-performance-logrotate.timer.candidate-gl-a-" + operation_id, "644"),
        "service": ("/etc/systemd/system/aifeeds-performance-logrotate.service", "/etc/systemd/system/aifeeds-performance-logrotate.service.candidate-gl-a-" + operation_id, "644"),
    }
    for item in value:
        expected_final, expected_candidate, expected_mode = expected_paths[item["name"]]
        if (item["final"], item["candidate"], item["mode"]) != (
            expected_final, expected_candidate, expected_mode,
        ):
            fail("runtime artifact operation binding drift")
        if item["name"] != "log" and (item["uid"], item["gid"]) != (0, 0):
            fail("runtime artifact root metadata drift")


def validate_business(value, legacy=False):
    if kind == "source":
        required, optional = SOURCE_REQUIRED, SOURCE_OPTIONAL
        expected_gate, self_key = "GL-a", "transaction_journal"
    else:
        required, optional = ROLLBACK_REQUIRED, ROLLBACK_OPTIONAL
        expected_gate, self_key = "GL-a-manual-rollback", "rollback_journal"
    keys = set(value)
    if not required <= keys or not keys <= required | optional:
        fail(f"{kind} journal top-level contract drift")
    if ("journal_update" in value) == legacy:
        fail(f"{kind} journal update presence drift")
    if type(value["schema"]) is not int or value["schema"] != 1 or value["gate"] != expected_gate:
        fail(f"{kind} journal business authority drift")
    if value["operation_id"] != operation_id or value[self_key] != final:
        fail(f"{kind} journal operation authority drift")
    if not is_hex(value["g0_commit"], 40) or not is_hex(value["rollback_helper_sha256"], 64):
        fail(f"{kind} journal provenance drift")
    if not is_hex(value["site_backup_sha256"], 64):
        fail(f"{kind} backup hash drift")
    if value["installed_site_sha256"] != "absent" and not is_hex(value["installed_site_sha256"], 64):
        fail(f"{kind} installed hash drift")
    if not all(is_integer(value[key]) for key in ("original_site_uid", "original_site_gid")) \
            or not all(is_integer(value[key], 1) for key in ("original_site_dev", "original_site_ino")):
        fail(f"{kind} site identity drift")
    import re
    if not isinstance(value["original_site_mode"], str) \
            or re.fullmatch(r"[0-7]{3,4}", value["original_site_mode"]) is None:
        fail(f"{kind} site mode drift")
    if type(value["runtime_artifacts_sealed"]) is not bool:
        fail(f"{kind} runtime seal type drift")
    if "runtime_cleanup" in value:
        validate_runtime_cleanup(value["runtime_cleanup"], value)
    expected_candidates = {
        "format": "/etc/nginx/conf.d/aifeeds-performance-log.conf.candidate-gl-a-" + operation_id,
        "rotate": "/etc/aifeeds-performance-logrotate.conf.candidate-gl-a-" + operation_id,
        "log": "/var/log/nginx/.aifeeds-performance.jsonl.candidate-gl-a-" + operation_id,
        "checker": "/usr/local/sbin/aifeeds-check-nginx-request-id.candidate-gl-a-" + operation_id,
        "diff_checker": "/usr/local/sbin/aifeeds-verify-nginx-request-id-diff.candidate-gl-a-" + operation_id,
        "inserter": "/usr/local/sbin/aifeeds-insert-nginx-request-id.candidate-gl-a-" + operation_id,
        "service": "/etc/systemd/system/aifeeds-performance-logrotate.service.candidate-gl-a-" + operation_id,
        "timer": "/etc/systemd/system/aifeeds-performance-logrotate.timer.candidate-gl-a-" + operation_id,
    }
    if value["artifact_candidates"] != expected_candidates:
        fail(f"{kind} artifact candidate mapping drift")
    if not isinstance(value["artifacts_sha256"], dict) or set(value["artifacts_sha256"]) != {
        "format", "rotate", "checker", "diff_checker", "inserter", "service", "timer",
    } or not all(is_hex(item, 64) for item in value["artifacts_sha256"].values()):
        fail(f"{kind} artifact hash mapping drift")
    validate_runtime_artifacts(value["runtime_artifacts"])
    for key in ("rotation_state_identity", "rotation_state_snapshot", "rotation_anchor_identity", "site_backup_identity"):
        if value[key] is not None and not isinstance(value[key], dict):
            fail(f"{kind} nested identity type drift")
    pairs = [
        ("installer_candidate_dev", "installer_candidate_ino"),
        ("rollback_candidate_dev", "rollback_candidate_ino"),
        ("displaced_site_dev", "displaced_site_ino"),
    ]
    if kind == "rollback":
        pairs.append(("partial_backup_dev", "partial_backup_ino"))
    for first, second in pairs:
        presence = (first in value, second in value)
        if presence not in ((False, False), (True, True)):
            fail(f"{kind} identity pair presence drift")
        if presence == (True, True) and not all(is_integer(value[key], 1) for key in (first, second)):
            fail(f"{kind} identity pair type drift")
    if kind == "source":
        if value["transaction_journal"] != f"/var/backups/aifeeds-performance-log/transaction-{operation_id}.json":
            fail("source journal path authority drift")
        if value["installer_candidate"] != f"/etc/nginx/sites-available/aifeeds.conf.candidate-gl-a-{operation_id}":
            fail("source installer candidate authority drift")
        if value["rollback_candidate"] != f"/etc/nginx/sites-available/aifeeds.conf.rollback-gl-a-{operation_id}":
            fail("source rollback candidate authority drift")
        if value["phase"] == "rolled_back":
            pair_fields = ("rollback_journal", "rollback_commit_marker")
            pair_presence = tuple(field in value for field in pair_fields)
            if pair_presence not in ((False, False), (True, True)):
                fail("source terminal pair presence drift")
            if pair_presence == (False, False):
                if value.get("rollback_origin_phase") not in ("initializing", "prepared"):
                    fail("source pre-live rollback origin drift")
                if not is_hex(value.get("log_archive_manifest_sha256"), 64) \
                        or type(value.get("log_archive_manifest_generation")) is not int \
                        or value["log_archive_manifest_generation"] != 1 \
                        or type(value.get("log_archive_manifest_entry_count")) is not int \
                        or value["log_archive_manifest_entry_count"] != 0:
                    fail("source pre-live empty manifest evidence drift")
            else:
                if value["rollback_journal"] != \
                        f"/var/backups/aifeeds-performance-log/rollback-transaction-{operation_id}.json" \
                        or value["rollback_commit_marker"] != \
                        f"/var/backups/aifeeds-performance-log/rollback-commit-{operation_id}.json":
                    fail("source terminal pair path authority drift")
    else:
        expected_source = f"/var/backups/aifeeds-performance-log/transaction-{operation_id}.json"
        if value["source_journal"] != expected_source:
            fail("rollback source path authority drift")
        if not is_hex(value["source_journal_sha256"], 64):
            fail("rollback source hash drift")
        physical_source = AUTHORITY_SOURCE_RECORD or read_exact(expected_source)
        source_value = parse_json(dict(physical_source))["value"]
        mirror_fields = (
            "g0_commit", "rollback_helper_sha256", "rollback_candidate", "site_backup",
            "audit_dir", "log_archive_manifest", "site_backup_sha256", "installed_site_sha256",
            "original_site_uid", "original_site_gid", "original_site_mode", "original_site_dev",
            "original_site_ino", "artifacts_sha256", "artifact_candidates", "runtime_artifacts",
            "runtime_artifacts_sealed", "rotation_state_identity",
            "rotation_anchor_identity", "site_backup_identity",
            "installer_candidate_dev", "installer_candidate_ino",
        )
        for field in mirror_fields:
            if value.get(field, MISSING) != source_value.get(field, MISSING):
                fail("rollback source mirror drift: " + field)
        source_effective_phase = source_value.get("phase")
        if source_effective_phase == "rollback_failed":
            source_effective_phase = source_value.get("failed_from")
        elif source_effective_phase == "rolled_back":
            source_effective_phase = source_value.get("rollback_origin_phase")
        if value["source_origin_phase"] != source_effective_phase:
            fail("rollback source origin mirror drift")
        marker_path = f"/var/backups/aifeeds-performance-log/rollback-commit-{operation_id}.json"
        if value["phase"] == "rolled_back":
            source_target = value.get("source_journal_terminal_sha256")
            if not is_hex(source_target, 64):
                fail("rollback terminal source target drift")
            staged_source = expected_source + ".tmp"
            if exists(staged_source) and read_exact(staged_source)["sha256"] != source_target:
                fail("rollback terminal staged source drift")
            allowed_source_hashes = {value["source_journal_sha256"], source_target}
            if exists(marker_path):
                marker = parse_json(read_exact(marker_path))["value"]
                if marker.get("operation_id") != operation_id \
                        or marker.get("source_before_sha256") != value["source_journal_sha256"] \
                        or marker.get("source_target_sha256") != source_target \
                        or marker.get("rollback_target_sha256") != hashlib.sha256(canonical(value)).hexdigest():
                    fail("rollback terminal marker source authority drift")
                allowed_source_hashes = {
                    marker["source_before_sha256"], marker["source_target_sha256"],
                }
            if physical_source["sha256"] not in allowed_source_hashes:
                fail("rollback terminal source physical authority drift")
        elif physical_source["sha256"] != value["source_journal_sha256"]:
            if not exists(marker_path):
                fail("rollback source physical authority drift")
            marker = parse_json(read_exact(marker_path))["value"]
            if (marker.get("phase"), action) not in {
                ("prepared", "publish-terminal-retain"),
                ("committed", "publish-terminal"),
            } \
                    or marker.get("operation_id") != operation_id \
                    or marker.get("source_before_sha256") != value["source_journal_sha256"] \
                    or marker.get("rollback_before_sha256") != hashlib.sha256(canonical(value)).hexdigest() \
                    or physical_source["sha256"] not in {
                        marker.get("source_before_sha256"), marker.get("source_target_sha256"),
                    }:
                fail("rollback source physical authority drift")
        if value["rollback_commit_marker"] != f"/var/backups/aifeeds-performance-log/rollback-commit-{operation_id}.json":
            fail("rollback marker authority drift")
        if value["rollback_candidate"] != f"/etc/nginx/sites-available/aifeeds.conf.rollback-gl-a-{operation_id}":
            fail("rollback candidate authority drift")
        if value["source_origin_phase"] not in SOURCE_FORWARD:
            fail("rollback source origin phase drift")
    if value["site_backup"] != f"/var/backups/aifeeds-performance-log/aifeeds.conf.bak-perf-{operation_id}":
        fail(f"{kind} backup path authority drift")
    if value["audit_dir"] != f"/var/backups/aifeeds-performance-log/audit-{operation_id}":
        fail(f"{kind} audit path authority drift")
    if value["log_archive_manifest"] != value["audit_dir"] + "/archive-manifest.json":
        fail(f"{kind} archive path authority drift")
    phases = set(SOURCE_FORWARD) | set(ROLLBACK_FLOW) | {"rollback_failed"}
    if value["phase"] not in phases:
        fail(f"{kind} phase drift")


def parse_owned(record, allow_legacy=False):
    record = parse_json(record)
    value = record["value"]
    update = value.get("journal_update")
    if update is None:
        expected_gate = "GL-a" if kind == "source" else "GL-a-manual-rollback"
        expected_path_key = "transaction_journal" if kind == "source" else "rollback_journal"
        if not allow_legacy or not legacy_hash or record["sha256"] != legacy_hash:
            fail("untrusted legacy journal")
        if value.get("schema") != 1 or value.get("gate") != expected_gate:
            fail("legacy journal business schema drift")
        if value.get("operation_id") != operation_id or value.get(expected_path_key) != final:
            fail("legacy journal operation drift")
        record["revision"] = 0
        record["legacy"] = True
        validate_business(value, legacy=True)
        return record
    if set(update) != {"schema", "revision", "self_dev", "self_ino", "predecessor"}:
        fail("journal_update keys drift")
    if type(update["schema"]) is not int or update["schema"] != 1:
        fail("journal_update schema drift")
    if type(update["revision"]) is not int or update["revision"] < 0:
        fail("journal_update numeric drift")
    for field in ("self_dev", "self_ino"):
        if type(update[field]) is not int or update[field] <= 0:
            fail("journal_update numeric drift")
    if (update["self_dev"], update["self_ino"]) != (record["dev"], record["ino"]):
        fail("journal self identity mismatch")
    if canonical(value) != record["raw"]:
        fail("journal update is not canonical")
    predecessor = update["predecessor"]
    if predecessor is not None:
        if not isinstance(predecessor, dict) or set(predecessor) != {"revision", "sha256", "dev", "ino"}:
            fail("journal predecessor keys drift")
        if type(predecessor["revision"]) is not int or predecessor["revision"] < 0:
            fail("journal predecessor revision drift")
        if type(predecessor["dev"]) is not int or predecessor["dev"] <= 0:
            fail("journal predecessor dev drift")
        if type(predecessor["ino"]) is not int or predecessor["ino"] <= 0:
            fail("journal predecessor ino drift")
        import re
        if not isinstance(predecessor["sha256"], str) or re.fullmatch(r"[a-f0-9]{64}", predecessor["sha256"]) is None:
            fail("journal predecessor hash drift")
    if (update["revision"] == 0) != (predecessor is None):
        fail("journal revision/predecessor genesis drift")
    if predecessor is not None and predecessor["revision"] != update["revision"] - 1:
        fail("journal predecessor revision jump")
    validate_business(value, legacy=False)
    record["revision"] = update["revision"]
    record["legacy"] = False
    return record


def predecessor_of(record):
    return {
        "revision": record["revision"], "sha256": record["sha256"],
        "dev": record["dev"], "ino": record["ino"],
    }


def require_predecessor(successor, predecessor_record):
    embedded = successor["value"]["journal_update"]["predecessor"]
    if embedded == predecessor_of(predecessor_record):
        return
    if embedded and embedded.get("sha256") == predecessor_record["sha256"] and (
        embedded.get("dev"), embedded.get("ino")
    ) != (predecessor_record["dev"], predecessor_record["ino"]):
        fail("same bytes on a different inode")
    fail("journal predecessor identity mismatch")


SOURCE_FORWARD = [
    "initializing", "prepared", "backup_created", "mutation_started",
    "mutated", "timer_enabled", "committed",
]
ROLLBACK_FLOW = [
    "prepared", "site_restored", "runtime_cleanup_started", "runtime_removed",
    "nginx_reloaded", "logs_archived", "rolled_back",
]
SOURCE_MUTABLE = {
    "phase", "journal_update", "installer_candidate_dev", "installer_candidate_ino",
    "installed_site_sha256", "rollback_candidate_dev", "rollback_candidate_ino",
    "runtime_artifacts", "artifacts_sha256", "runtime_artifacts_sealed", "rotation_state_identity",
    "rotation_state_snapshot", "rotation_anchor_identity", "site_backup_identity",
    "displaced_site_dev", "displaced_site_ino", "failed_from", "rollback_origin_phase",
    "rollback_journal", "rollback_commit_marker", "log_archive_manifest_sha256",
    "log_archive_manifest_generation", "log_archive_manifest_entry_count", "runtime_cleanup",
}
ROLLBACK_MUTABLE = {
    "phase", "journal_update", "rollback_candidate_dev", "rollback_candidate_ino",
    "partial_backup_sha256", "partial_backup_dev", "partial_backup_ino",
    "installer_candidate_dev", "installer_candidate_ino", "displaced_site_dev",
    "displaced_site_ino", "rotation_state_snapshot", "rotation_anchor_identity",
    "failed_from", "source_journal_terminal_sha256", "log_archive_manifest_sha256",
    "log_archive_manifest_generation", "log_archive_manifest_entry_count", "runtime_cleanup",
}


def effective_phase(value):
    phase = value.get("phase")
    if phase == "rollback_failed":
        failed_from = value.get("failed_from")
        if not isinstance(failed_from, str):
            fail("rollback_failed missing failed_from")
        return failed_from
    return phase


MISSING = object()


def changed_fields(old, new):
    return {
        key for key in set(old) | set(new)
        if old.get(key, MISSING) != new.get(key, MISSING)
    }


def validate_phase(old, new):
    old_phase = old.get("phase")
    old_effective = effective_phase(old)
    new_phase = new.get("phase")
    direct_next = False
    if new_phase == "rollback_failed":
        if new.get("failed_from") != old_effective:
            fail("rollback_failed failed_from drift")
        return old_effective, False
    if new_phase == old_effective:
        return old_effective, False
    if new_phase == "rolled_back":
        if kind == "rollback" and old_effective != "logs_archived":
            fail("rollback terminal phase jump")
        return old_effective, True
    flow = ROLLBACK_FLOW if kind == "rollback" else SOURCE_FORWARD
    if old_effective not in flow or new_phase not in flow:
        fail("semantic phase transition drift")
    direct_next = flow.index(new_phase) == flow.index(old_effective) + 1
    if not direct_next:
        fail("semantic phase regression")
    if old_phase == "rollback_failed" and not direct_next:
        fail("rollback failure recovery intent drift")
    return old_effective, direct_next


def validate_identity_progress(old, new):
    for first, second in (
        ("installer_candidate_dev", "installer_candidate_ino"),
        ("rollback_candidate_dev", "rollback_candidate_ino"),
        ("partial_backup_dev", "partial_backup_ino"),
        ("displaced_site_dev", "displaced_site_ino"),
    ):
        old_pair = (old.get(first, MISSING), old.get(second, MISSING))
        new_pair = (new.get(first, MISSING), new.get(second, MISSING))
        if MISSING in new_pair and new_pair != (MISSING, MISSING):
            fail("semantic identity pair partial")
        if old_pair != (MISSING, MISSING) and new_pair != old_pair:
            removable = (
                kind == "source" and first == "rollback_candidate_dev"
                and effective_phase(old) == "mutation_started" and new.get("phase") == "mutated"
                and new_pair == (MISSING, MISSING)
            )
            if not removable:
                fail("semantic identity pair inverse")
    if old.get("runtime_artifacts_sealed") is True and new.get("runtime_artifacts_sealed") is not True:
        fail("semantic sealed inventory inverse")
    old_items = old.get("runtime_artifacts")
    new_items = new.get("runtime_artifacts")
    if isinstance(old_items, list) and isinstance(new_items, list):
        if len(new_items) < len(old_items) or len(new_items) > len(old_items) + 1 \
                or new_items[:len(old_items)] != old_items:
            fail("semantic runtime inventory inverse")
    for key in ("site_backup_identity", "rotation_state_identity", "rotation_anchor_identity"):
        old_value = old.get(key, MISSING)
        new_value = new.get(key, MISSING)
        if old_value not in (MISSING, None) and new_value in (MISSING, None):
            fail("semantic identity removal")
        if key != "rotation_anchor_identity" and old_value not in (MISSING, None, new_value):
            fail("semantic once-set identity drift")
    old_anchor = old.get("rotation_anchor_identity")
    new_anchor = new.get("rotation_anchor_identity")
    if isinstance(old_anchor, dict) and isinstance(new_anchor, dict) and old_anchor != new_anchor:
        order = ["allocated", "prepared", "sealed"]
        if old_anchor.get("state") not in order or new_anchor.get("state") not in order \
                or order.index(new_anchor["state"]) != order.index(old_anchor["state"]) + 1:
            fail("semantic anchor state inverse")
        for key in (set(old_anchor) | set(new_anchor)) - {"state", "sha256", "size"}:
            if old_anchor.get(key, MISSING) != new_anchor.get(key, MISSING):
                fail("semantic anchor identity drift")


def validate_source_delta(old, new, old_effective, direct_next, changed):
    logical = changed - {"journal_update"}
    if old.get("phase") == "rollback_failed":
        logical -= {"failed_from"}
    if new.get("phase") == "rollback_failed":
        allowed_failure = {"phase", "failed_from"}
        if old.get("phase") == "rollback_failed":
            allowed_failure = {"runtime_cleanup"}
        if logical != allowed_failure and logical != set():
            fail("semantic rollback failure wrapper drift")
        return
    new_phase = new["phase"]
    if new_phase == old_effective:
        logical -= {"phase"}
        allowed_groups = []
        if old_effective == "prepared":
            allowed_groups = [
                {"installer_candidate_dev", "installer_candidate_ino"},
                {"site_backup_identity"},
            ]
        elif old_effective == "mutation_started":
            allowed_groups = [
                {"runtime_artifacts"}, {"rotation_state_identity"},
                {"rotation_anchor_identity"}, {"runtime_artifacts_sealed"},
                {"rollback_candidate_dev", "rollback_candidate_ino"},
                {"artifacts_sha256", "runtime_artifacts"},
            ]
        elif old_effective == "mutated":
            allowed_groups = [{"rotation_state_snapshot"}]
        if logical and logical not in allowed_groups:
            fail("semantic field delta drift: " + ",".join(sorted(logical)))
        return
    transition = (old_effective, new_phase)
    allowed = {
        ("initializing", "prepared"): {"phase", "installed_site_sha256"},
        ("prepared", "backup_created"): {"phase"},
        ("backup_created", "mutation_started"): {"phase"},
        ("mutation_started", "mutated"): {
            "phase", "rollback_candidate_dev", "rollback_candidate_ino",
        },
        ("mutated", "timer_enabled"): {"phase"},
        ("timer_enabled", "committed"): {"phase"},
    }.get(transition)
    if new_phase == "rolled_back":
        if "rollback_journal" in new or "rollback_commit_marker" in new:
            allowed = {
                "phase", "rollback_origin_phase", "rollback_journal", "rollback_commit_marker",
                "rollback_candidate_dev", "rollback_candidate_ino", "log_archive_manifest_sha256",
                "log_archive_manifest_generation", "log_archive_manifest_entry_count",
                "rotation_state_snapshot", "rotation_anchor_identity", "site_backup_identity",
            }
            required_terminal = {
                "phase", "rollback_origin_phase", "rollback_journal", "rollback_commit_marker",
                "log_archive_manifest_sha256", "log_archive_manifest_generation",
                "log_archive_manifest_entry_count",
            }
            if not required_terminal <= logical:
                fail("source terminal pair evidence drift")
        else:
            if old_effective not in ("initializing", "prepared") \
                    or new.get("rollback_origin_phase") != old_effective:
                fail("source pre-live rollback transition drift")
            allowed = {
                "phase", "rollback_origin_phase", "log_archive_manifest_sha256",
                "log_archive_manifest_generation", "log_archive_manifest_entry_count",
            }
            if not allowed <= logical:
                fail("source pre-live rollback evidence drift")
    if allowed is None or not logical <= allowed or "phase" not in logical:
        fail("semantic field delta drift: " + ",".join(sorted(logical)))


def validate_cleanup_progress(old, new):
    old_cleanup = old.get("runtime_cleanup", MISSING)
    new_cleanup = new.get("runtime_cleanup", MISSING)
    if old_cleanup is MISSING:
        if new_cleanup is MISSING:
            return
        validate_runtime_cleanup(new_cleanup, new)
        compatibility_genesis = (
            new_cleanup.get("compatibility_mode") == "legacy_runtime_removed"
            and effective_phase(old) == "runtime_removed"
            and new.get("phase") == "runtime_removed"
        )
        if new_cleanup["cursor"] != 0 or new_cleanup["cursor_state"] != "pending" \
                or (new.get("phase") != "runtime_cleanup_started" and not compatibility_genesis):
            fail("runtime cleanup genesis drift")
        verify_cleanup_genesis_physical(new_cleanup)
        return
    if new_cleanup is MISSING:
        fail("runtime cleanup removal drift")
    validate_runtime_cleanup(old_cleanup, old)
    validate_runtime_cleanup(new_cleanup, new)
    if old_cleanup["plan_sha256"] != new_cleanup["plan_sha256"] \
            or old_cleanup["items"] != new_cleanup["items"] \
            or old_cleanup.get("compatibility_mode") != new_cleanup.get("compatibility_mode"):
        fail("runtime cleanup immutable plan drift")
    old_cursor, old_state = old_cleanup["cursor"], old_cleanup["cursor_state"]
    new_cursor, new_state = new_cleanup["cursor"], new_cleanup["cursor_state"]
    allowed = {
        (old_cursor, "pending"): (old_cursor, "detaching"),
        (old_cursor, "detaching"): (old_cursor, "detached"),
        (old_cursor, "detached"): (
            old_cursor + 1,
            "complete" if old_cursor + 1 == len(old_cleanup["items"]) else "pending",
        ),
        (old_cursor, "complete"): (old_cursor, "complete"),
    }
    if (new_cursor, new_state) not in {(old_cursor, old_state), allowed[(old_cursor, old_state)]}:
        fail("runtime cleanup cursor transition drift")


def validate_rollback_delta(old, new, old_effective, direct_next, changed):
    logical = changed - {"journal_update"}
    validate_cleanup_progress(old, new)
    if old.get("phase") == "rollback_failed":
        logical -= {"failed_from"}
    if new.get("phase") == "rollback_failed":
        allowed_failure = {"phase", "failed_from"}
        if old.get("phase") == "rollback_failed":
            allowed_failure = {"runtime_cleanup"}
            initialized_candidate_snapshot = (
                logical == {"rotation_state_snapshot"}
                and old.get("failed_from") == "prepared"
                and old.get("source_origin_phase") == "mutation_started"
                and old.get("rotation_state_snapshot") is None
                and isinstance(new.get("rotation_state_snapshot"), dict)
                and new["rotation_state_snapshot"].get("generation") == 0
                and new["rotation_state_snapshot"].get("status") is None
                and new.get("runtime_artifacts_sealed") is False
                and isinstance(new.get("rotation_anchor_identity"), dict)
                and new["rotation_anchor_identity"].get("state") == "allocated"
            )
        else:
            initialized_candidate_snapshot = False
        if logical != allowed_failure and logical != set() \
                and not initialized_candidate_snapshot:
            fail("semantic rollback failure wrapper drift")
        return
    new_phase = new["phase"]
    if new_phase == old_effective:
        logical -= {"phase"}
        groups = [
            {"partial_backup_sha256", "partial_backup_dev", "partial_backup_ino"},
            {"rollback_candidate_dev", "rollback_candidate_ino"},
            {"installer_candidate_dev", "installer_candidate_ino"},
            {"displaced_site_dev", "displaced_site_ino"},
            {"rotation_state_snapshot"}, {"runtime_cleanup"},
        ]
        if logical and logical not in groups:
            fail("semantic field delta drift: " + ",".join(sorted(logical)))
        return
    allowed = {"phase"}
    if new_phase == "runtime_cleanup_started":
        allowed.add("runtime_cleanup")
    if new_phase == "runtime_removed":
        cleanup_value = new.get("runtime_cleanup")
        if cleanup_value is None or cleanup_value["cursor_state"] != "complete":
            fail("runtime removed before cleanup completion")
    if new_phase == "logs_archived":
        allowed |= {
            "log_archive_manifest_sha256", "log_archive_manifest_generation",
            "log_archive_manifest_entry_count",
        }
    if new_phase == "rolled_back":
        allowed |= {"source_journal_terminal_sha256"}
    if logical != allowed:
        fail("semantic field delta drift: " + ",".join(sorted(logical)))


def validate_delta(old, new):
    changed = changed_fields(old, new)
    allowed = SOURCE_MUTABLE if kind == "source" else ROLLBACK_MUTABLE
    illegal = changed - allowed
    if illegal:
        fail("semantic field delta drift: " + ",".join(sorted(illegal)))
    old_effective, direct_next = validate_phase(old, new)
    validate_identity_progress(old, new)
    if kind == "source":
        validate_source_delta(old, new, old_effective, direct_next, changed)
    else:
        validate_rollback_delta(old, new, old_effective, direct_next, changed)


def validate_successor(successor, predecessor_record):
    if successor["revision"] != predecessor_record["revision"] + 1:
        fail("revision jump")
    require_predecessor(successor, predecessor_record)
    validate_delta(predecessor_record["value"], successor["value"])


def validate_genesis(record):
    value = record["value"]
    update = value["journal_update"]
    expected = "initializing" if kind == "source" else "prepared"
    if value.get("phase") != expected or requested_phase not in ("", expected):
        fail("invalid journal genesis phase")
    if update["revision"] != 0 or update["predecessor"] is not None:
        fail("invalid journal genesis predecessor")
    if kind == "source":
        if set(value) != SOURCE_REQUIRED | {"journal_update"}:
            fail("source genesis top-level drift")
        if value["installed_site_sha256"] != "absent" or value["runtime_artifacts"] != [] \
                or value["runtime_artifacts_sealed"] is not False:
            fail("source genesis state drift")
        if any(value[key] is not None for key in (
            "rotation_state_identity", "rotation_state_snapshot",
            "rotation_anchor_identity", "site_backup_identity",
        )):
            fail("source genesis identity drift")
    else:
        rollback_genesis_optional = {
            "installer_candidate_dev", "installer_candidate_ino",
            "rollback_candidate_dev", "rollback_candidate_ino",
        }
        if not (ROLLBACK_REQUIRED | {"journal_update"}) <= set(value) \
                or not set(value) <= ROLLBACK_REQUIRED | {"journal_update"} | rollback_genesis_optional:
            fail("rollback genesis top-level drift")


def exact_unlink(path, expected):
    parent_path, name = os.path.split(path)
    parent_descriptor = os.open(parent_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_descriptor)
    try:
        before = os.fstat(descriptor)
        if before.st_nlink != 1:
            fail("cleanup tombstone link count drift")
        if (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) != (0, 0, 0o600):
            fail("cleanup tombstone metadata drift")
        chunks = []
        while True:
            chunk = os.read(descriptor, 65536)
            if not chunk:
                break
            chunks.append(chunk)
        held_sha256 = hashlib.sha256(b"".join(chunks)).hexdigest()
        held_before_unlink = os.fstat(descriptor)
        namespace = os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
        if (held_sha256, before.st_dev, before.st_ino) != (
            expected["sha256"], expected["dev"], expected["ino"],
        ):
            if held_sha256 == expected["sha256"]:
                fail("same bytes on a different inode")
            fail("cleanup tombstone identity drift")
        stable_identity = (
            before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns,
            before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode), before.st_nlink,
        )
        if stable_identity != (
            held_before_unlink.st_dev, held_before_unlink.st_ino,
            held_before_unlink.st_size, held_before_unlink.st_mtime_ns,
            held_before_unlink.st_uid, held_before_unlink.st_gid,
            stat.S_IMODE(held_before_unlink.st_mode), held_before_unlink.st_nlink,
        ):
            fail("cleanup tombstone changed before unlink")
        if stable_identity != (
            namespace.st_dev, namespace.st_ino, namespace.st_size, namespace.st_mtime_ns,
            namespace.st_uid, namespace.st_gid, stat.S_IMODE(namespace.st_mode),
            namespace.st_nlink,
        ):
            fail("cleanup tombstone pathname drift")
        os.unlink(name, dir_fd=parent_descriptor)
        try:
            os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            fail("cleanup tombstone unlink namespace drift")
        after = os.fstat(descriptor)
        if (
            after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns,
            after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode), after.st_nlink,
        ) != (
            before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns,
            before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode), 0,
        ):
            fail("cleanup tombstone held FD drift")
        os.fsync(parent_descriptor)
    finally:
        os.close(descriptor)
        os.close(parent_descriptor)


def is_pair_terminal(record):
    value = record["value"]
    return value.get("phase") == "rolled_back" and "rollback_commit_marker" in value


def require_terminal_authority(record, allow_terminal):
    if is_pair_terminal(record) and not allow_terminal:
        fail("terminal-staged journal requires pair bootstrap")


def test_crash(point):
    spec = os.environ.get("GL_A_TEST_JOURNAL_CAS_CRASH", "")
    if spec != f"{kind}:{requested_phase}:{point}":
        return
    fixture = "/workspace/deploy/nginx/test-fixtures/gl-a-installer"
    if not os.path.isdir(fixture):
        fail("journal CAS test hook outside fixture")
    marker = "/tmp/gl-a-test/journal-cas-crash-hit"
    try:
        descriptor = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        return
    else:
        os.fsync(descriptor)
        os.close(descriptor)
        marker_parent = os.open(os.path.dirname(marker), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(marker_parent)
        finally:
            os.close(marker_parent)
    import signal
    os.killpg(os.getpgrp(), signal.SIGKILL)
    raise SystemExit(137)


def settle(allow_terminal=False, retain_predecessor=False):
    names = {name for name, path in (
        ("F", final), ("T", temporary), ("P", previous), ("C", cleanup),
    ) if exists(path)}
    if not names:
        return None
    if names == {"T"}:
        successor = parse_owned(read_exact(temporary))
        validate_genesis(successor)
        rename_noreplace(temporary, final)
        fsync_parent()
        return parse_owned(read_exact(final))
    if names == {"F"}:
        record = parse_owned(read_exact(final), allow_legacy=True)
        if legacy_hash and record["sha256"] != legacy_hash:
            fail("external journal hash drift")
        return record
    if names == {"F", "T"}:
        old = parse_owned(read_exact(final), allow_legacy=True)
        if legacy_hash and old["sha256"] != legacy_hash:
            fail("external journal hash drift")
        successor = parse_owned(read_exact(temporary))
        validate_successor(successor, old)
        require_terminal_authority(successor, allow_terminal)
        rename_noreplace(final, previous)
        fsync_parent()
        test_crash("f-to-p")
        return settle(allow_terminal, retain_predecessor)
    if names == {"P", "T"}:
        old = parse_owned(read_exact(previous), allow_legacy=True)
        if legacy_hash and old["sha256"] != legacy_hash:
            fail("external journal hash drift")
        successor = parse_owned(read_exact(temporary))
        validate_successor(successor, old)
        require_terminal_authority(successor, allow_terminal)
        rename_noreplace(temporary, final)
        fsync_parent()
        test_crash("t-to-f")
        return settle(allow_terminal, retain_predecessor)
    if names == {"P", "F"}:
        old = parse_owned(read_exact(previous), allow_legacy=True)
        successor = parse_owned(read_exact(final))
        require_terminal_authority(successor, allow_terminal)
        if legacy_hash and legacy_hash not in (old["sha256"], successor["sha256"]):
            fail("external journal hash drift")
        validate_successor(successor, old)
        if retain_predecessor:
            return successor
        rename_noreplace(previous, cleanup)
        fsync_parent()
        test_crash("p-to-c")
        return settle(allow_terminal, retain_predecessor)
    if names == {"F", "C"}:
        old = parse_owned(read_exact(cleanup), allow_legacy=True)
        successor = parse_owned(read_exact(final))
        require_terminal_authority(successor, allow_terminal)
        if legacy_hash and legacy_hash not in (old["sha256"], successor["sha256"]):
            fail("external journal hash drift")
        validate_successor(successor, old)
        exact_unlink(cleanup, old)
        return parse_owned(read_exact(final))
    fail("invalid journal update state: " + "+".join(sorted(names)))


if action == "validate-authority-successor":
    import base64
    envelope = decode_json(payload)
    if not isinstance(envelope, dict) or set(envelope) != {
        "marker", "source_target", "rollback_target",
    }:
        fail("terminal authority validation envelope drift")
    marker_record = read_exact(envelope["marker"])
    marker_value = decode_json(marker_record["raw"])
    if canonical(marker_value) != marker_record["raw"]:
        fail("terminal authority marker is not canonical")
    if marker_value.get("phase") == "committed":
        if marker_value.get("source_journal_terminal_sha256") != marker_value.get("source_target_sha256") \
                or marker_value.get("rollback_journal_terminal_sha256") != marker_value.get("rollback_target_sha256"):
            fail("terminal committed marker target evidence drift")
        prepared_marker = dict(marker_value)
        prepared_marker["phase"] = "prepared"
        recorded_prepared_sha256 = prepared_marker.pop("prepared_marker_sha256", None)
        prepared_marker.pop("source_journal_terminal_sha256", None)
        prepared_marker.pop("rollback_journal_terminal_sha256", None)
        if hashlib.sha256(canonical(prepared_marker)).hexdigest() != recorded_prepared_sha256:
            fail("terminal committed marker predecessor evidence drift")
    elif marker_value.get("phase") != "prepared":
        fail("terminal authority marker phase drift")

    def decode_authority(name):
        authority = marker_value.get(name)
        if not isinstance(authority, dict) or set(authority) != {
            "raw_base64", "sha256", "dev", "ino",
        }:
            fail("terminal before authority schema drift")
        encoded = authority["raw_base64"]
        if not isinstance(encoded, str) or not encoded:
            fail("terminal before authority encoding drift")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except Exception as error:
            raise RuntimeError("terminal before authority base64 drift") from error
        if base64.b64encode(raw).decode("ascii") != encoded:
            fail("terminal before authority alternate encoding")
        if hashlib.sha256(raw).hexdigest() != authority["sha256"]:
            fail("terminal before authority hash drift")
        if not all(type(authority[field]) is int and authority[field] > 0 for field in ("dev", "ino")):
            fail("terminal before authority inode drift")
        return {
            "raw": raw, "sha256": authority["sha256"],
            "dev": authority["dev"], "ino": authority["ino"],
        }

    source_before = decode_authority("source_before_authority")
    rollback_before = decode_authority("rollback_before_authority")
    if marker_value.get("source_before_sha256") != source_before["sha256"] \
            or marker_value.get("rollback_before_sha256") != rollback_before["sha256"]:
        fail("terminal before authority marker hash drift")
    source_target = read_exact(envelope["source_target"])
    rollback_target = read_exact(envelope["rollback_target"])
    if source_target["sha256"] != marker_value.get("source_target_sha256") \
            or rollback_target["sha256"] != marker_value.get("rollback_target_sha256"):
        fail("terminal authority target hash drift")

    source_before_value = parse_json(dict(source_before))["value"]
    rollback_before_value = parse_json(dict(rollback_before))["value"]
    if kind == "source":
        predecessor_record = parse_owned(source_before, allow_legacy=True)
        predecessor = source_before_value.get("journal_update", {}).get("predecessor")
        if source_before["sha256"] != legacy_hash and (
            not isinstance(predecessor, dict)
            or predecessor.get("sha256") != legacy_hash
        ):
            fail("terminal source before authority external hash drift")
        successor_record = parse_owned(source_target)
    else:
        AUTHORITY_SOURCE_RECORD = source_before
        predecessor_record = parse_owned(rollback_before)
        AUTHORITY_SOURCE_RECORD = source_target
        successor_record = parse_owned(rollback_target)
    validate_successor(successor_record, predecessor_record)

    source_origin = source_before_value.get("phase")
    if source_origin == "rollback_failed":
        source_origin = source_before_value.get("failed_from")
    elif source_origin == "rolled_back":
        source_origin = source_before_value.get("rollback_origin_phase")
    if rollback_before_value.get("source_origin_phase") != source_origin:
        fail("terminal before authority source origin mirror drift")
    rollback_effective = rollback_before_value.get("phase")
    if rollback_effective == "rollback_failed":
        rollback_effective = rollback_before_value.get("failed_from")
    if rollback_effective != "logs_archived":
        fail("terminal rollback before authority phase drift")
    archive_fields = (
        "log_archive_manifest_sha256", "log_archive_manifest_generation",
        "log_archive_manifest_entry_count",
    )
    if not all(field in rollback_before_value for field in archive_fields):
        fail("terminal rollback before authority archive evidence missing")

    expected_source = dict(source_before_value)
    expected_source.pop("journal_update", None)
    expected_source.pop("failed_from", None)
    expected_source.update({
        "phase": "rolled_back",
        "rollback_journal": rollback_before_value["rollback_journal"],
        "rollback_commit_marker": rollback_before_value["rollback_commit_marker"],
        "rollback_origin_phase": source_origin,
    })
    for field in archive_fields + (
        "runtime_artifacts", "runtime_artifacts_sealed", "rotation_state_identity",
        "rotation_state_snapshot", "rotation_anchor_identity", "site_backup_identity",
    ):
        expected_source[field] = rollback_before_value[field]
    for field in ("rollback_candidate_dev", "rollback_candidate_ino"):
        if field in rollback_before_value:
            expected_source[field] = rollback_before_value[field]
        else:
            expected_source.pop(field, None)

    expected_rollback = dict(rollback_before_value)
    expected_rollback.pop("journal_update", None)
    expected_rollback.pop("failed_from", None)
    expected_rollback["phase"] = "rolled_back"
    expected_rollback["source_journal_terminal_sha256"] = source_target["sha256"]
    source_successor_base = dict(parse_json(dict(source_target))["value"])
    rollback_successor_base = dict(parse_json(dict(rollback_target))["value"])
    source_successor_base.pop("journal_update", None)
    rollback_successor_base.pop("journal_update", None)
    if source_successor_base != expected_source:
        fail("terminal source exact successor drift")
    if rollback_successor_base != expected_rollback:
        fail("terminal rollback exact successor drift")
    raise SystemExit(0)


if action == "stage" and exists(temporary):
    names = {name for name, path in (("F", final), ("T", temporary), ("P", previous), ("C", cleanup)) if exists(path)}
    if names != {"F", "T"}:
        fail("invalid terminal staged journal state")
    current = parse_owned(read_exact(final), allow_legacy=True)
    successor = parse_owned(read_exact(temporary))
    validate_successor(successor, current)
    if not is_pair_terminal(successor):
        fail("terminal staged payload drift")
    raise SystemExit(0)

current = settle(
    allow_terminal=action in {"publish-terminal", "publish-terminal-retain"},
    retain_predecessor=(action == "publish-terminal-retain"),
)
if action in {"publish-terminal", "publish-terminal-retain"}:
    if current is None or not is_pair_terminal(current):
        fail("terminal journal publication drift")
    raise SystemExit(0)
if not payload:
    raise SystemExit(0)
try:
    successor_value = decode_json(payload)
except json.JSONDecodeError as error:
    raise RuntimeError("invalid successor payload") from error
if not isinstance(successor_value, dict) or "journal_update" in successor_value:
    fail("successor base payload drift")
if successor_value.get("operation_id") != operation_id or successor_value.get("phase") != requested_phase:
    fail("successor operation/phase drift")
if current is not None:
    current_base = dict(current["value"])
    current_base.pop("journal_update", None)
    if successor_value == current_base:
        raise SystemExit(0)
    if current_base.get("phase") == "rollback_failed":
        failed_from = current_base.get("failed_from")
        if requested_phase == failed_from:
            resumed_base = dict(current_base)
            resumed_base.pop("failed_from")
            resumed_base["phase"] = failed_from
            if successor_value == resumed_base:
                raise SystemExit(0)
if current is None:
    expected = "initializing" if kind == "source" else "prepared"
    if requested_phase != expected:
        fail("only a fresh genesis may have no predecessor")
    revision, predecessor = 0, None
else:
    revision, predecessor = current["revision"] + 1, predecessor_of(current)

descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
try:
    allocated = os.fstat(descriptor)
    successor_value["journal_update"] = {
        "schema": 1, "revision": revision, "self_dev": allocated.st_dev,
        "self_ino": allocated.st_ino, "predecessor": predecessor,
    }
    write_all(descriptor, canonical(successor_value))
    os.fsync(descriptor)
finally:
    os.close(descriptor)
fsync_parent()
test_crash("t-durable")
successor = parse_owned(read_exact(temporary))
if current is None:
    validate_genesis(successor)
else:
    validate_successor(successor, current)
if is_pair_terminal(successor) and action != "stage":
    fail("terminal-staged journal requires pair bootstrap")
if action != "stage":
    settle()
PY
}

settle_journal_update() {
    local final=$1 previous=$2 kind=$3 legacy_expected_sha256=${4:-}
    journal_update_cas "$final" "$previous" "$kind" "" "$legacy_expected_sha256" ""
}

write_journal() {
    local phase=$1
    local journal_json
    local log_archive_manifest_sha256=''
    local log_archive_manifest_generation=0
    local log_archive_manifest_entry_count=0
    if [ -n "$INSTALLER_CANDIDATE_DEV" ] || [ -n "$INSTALLER_CANDIDATE_INO" ]; then
        test -n "$INSTALLER_CANDIDATE_DEV" && test -n "$INSTALLER_CANDIDATE_INO" || return 1
        printf '%s:%s' "$INSTALLER_CANDIDATE_DEV" "$INSTALLER_CANDIDATE_INO" \
            | grep -Eq '^[0-9]+:[0-9]+$' || return 1
    fi
    if [ -n "$ROLLBACK_CANDIDATE_DEV" ] || [ -n "$ROLLBACK_CANDIDATE_INO" ]; then
        test -n "$ROLLBACK_CANDIDATE_DEV" && test -n "$ROLLBACK_CANDIDATE_INO" || return 1
        printf '%s:%s' "$ROLLBACK_CANDIDATE_DEV" "$ROLLBACK_CANDIDATE_INO" \
            | grep -Eq '^[0-9]+:[0-9]+$' || return 1
    fi
    if [ "$phase" = rolled_back ]; then
        archive_manifest_is_terminal || return 1
        log_archive_manifest_sha256="$(sha256sum "$ARCHIVE_MANIFEST" | awk '{print $1}')"
        log_archive_manifest_generation="$(jq -er '.generation' "$ARCHIVE_MANIFEST")"
        log_archive_manifest_entry_count="$(jq -er '.entries | length' "$ARCHIVE_MANIFEST")"
    fi
    journal_json="$(jq -nc \
        --arg phase "$phase" \
        --arg failed_from "$LAST_JOURNAL_PHASE" \
        --arg operation_id "$OPERATION_ID" \
        --arg g0_commit "$G0_COMMIT" \
        --arg rollback_helper_sha256 "$ROLLBACK_HELPER_SHA256" \
        --arg transaction_journal "$JOURNAL" \
        --arg installer_candidate "$CANDIDATE" \
        --arg installer_candidate_dev "$INSTALLER_CANDIDATE_DEV" \
        --arg installer_candidate_ino "$INSTALLER_CANDIDATE_INO" \
        --arg rollback_candidate "$ROLLBACK_CANDIDATE" \
        --arg rollback_candidate_dev "$ROLLBACK_CANDIDATE_DEV" \
        --arg rollback_candidate_ino "$ROLLBACK_CANDIDATE_INO" \
        --arg backup "$BACKUP" \
        --arg audit_dir "$AUDIT_DIR" \
        --arg log_archive_manifest "$ARCHIVE_MANIFEST" \
        --arg log_archive_manifest_sha256 "$log_archive_manifest_sha256" \
        --argjson log_archive_manifest_generation "$log_archive_manifest_generation" \
        --argjson log_archive_manifest_entry_count "$log_archive_manifest_entry_count" \
        --arg site_backup_sha256 "$SITE_BACKUP_SHA256" \
        --arg installed_site_sha256 "$EXPECTED_INSTALLED_SITE_SHA256" \
        --argjson original_site_uid "$SITE_UID" \
        --argjson original_site_gid "$SITE_GID" \
        --arg original_site_mode "$SITE_MODE" \
        --argjson original_site_dev "$SITE_BASE_DEV" \
        --argjson original_site_ino "$SITE_BASE_INO" \
        --argjson artifacts_sha256 "$ARTIFACTS_SHA256_JSON" \
        --argjson artifact_candidates "$ARTIFACT_CANDIDATES_JSON" \
        --argjson runtime_artifacts "$RUNTIME_ARTIFACTS_JSON" \
        --argjson runtime_artifacts_sealed "$RUNTIME_ARTIFACTS_SEALED" \
        --argjson rotation_state_identity "$ROTATION_STATE_IDENTITY_JSON" \
        --argjson rotation_state_snapshot "$ROTATION_STATE_SNAPSHOT_JSON" \
        --argjson rotation_anchor_identity "$ROTATION_ANCHOR_IDENTITY_JSON" \
        --argjson site_backup_identity "$SITE_BACKUP_IDENTITY_JSON" \
        '{schema:1,gate:"GL-a",phase:$phase,operation_id:$operation_id,g0_commit:$g0_commit,
          rollback_helper_sha256:$rollback_helper_sha256,transaction_journal:$transaction_journal,
          installer_candidate:$installer_candidate,rollback_candidate:$rollback_candidate,
          site_backup:$backup,audit_dir:$audit_dir,log_archive_manifest:$log_archive_manifest,
          site_backup_sha256:$site_backup_sha256,installed_site_sha256:$installed_site_sha256,
          original_site_uid:$original_site_uid,original_site_gid:$original_site_gid,
          original_site_mode:$original_site_mode,original_site_dev:$original_site_dev,
          original_site_ino:$original_site_ino,artifacts_sha256:$artifacts_sha256,
          artifact_candidates:$artifact_candidates,
          runtime_artifacts:$runtime_artifacts,
          runtime_artifacts_sealed:$runtime_artifacts_sealed,
          rotation_state_identity:$rotation_state_identity,
          rotation_state_snapshot:$rotation_state_snapshot,
          rotation_anchor_identity:$rotation_anchor_identity,
          site_backup_identity:$site_backup_identity}
          + (if $installer_candidate_dev != "" and $installer_candidate_ino != "" then
               {installer_candidate_dev:($installer_candidate_dev | tonumber),
                installer_candidate_ino:($installer_candidate_ino | tonumber)}
             else {} end)
          + (if $rollback_candidate_dev != "" and $rollback_candidate_ino != "" then
               {rollback_candidate_dev:($rollback_candidate_dev | tonumber),
                rollback_candidate_ino:($rollback_candidate_ino | tonumber)}
             else {} end)
          + (if $phase == "rollback_failed" then {failed_from:$failed_from}
             elif $phase == "rolled_back" then
               {rollback_origin_phase:$failed_from,
                log_archive_manifest_sha256:$log_archive_manifest_sha256,
                log_archive_manifest_generation:$log_archive_manifest_generation,
                log_archive_manifest_entry_count:$log_archive_manifest_entry_count}
             else {} end)')" || return 1
    journal_update_cas "$JOURNAL" "$JOURNAL_PREVIOUS_UPDATE" source "$phase" "" \
        "$journal_json" || return 1
    # CAS already fsyncs its held file and parent dir; this redundant boundary
    # preserves failure propagation and external fault observation contracts.
    sync -f "$JOURNAL" || return 1
    JOURNAL_CREATED=1
    LAST_JOURNAL_PHASE="$phase"
}

persist_installer_candidate_identity() {
    case "$LAST_JOURNAL_PHASE" in prepared|backup_created) ;; *) return 1 ;; esac
    test -n "$INSTALLER_CANDIDATE_DEV" && test -n "$INSTALLER_CANDIDATE_INO" || return 1
    formal_site_matches_state "$CANDIDATE" installed || return 1
    write_journal "$LAST_JOURNAL_PHASE" || return 1
    formal_site_matches_state "$CANDIDATE" installed
}

capture_archive_manifest_owned_identity() {
    local path=$1
    python3 - "$path" <<'PY'
import hashlib
import json
import os
import stat
import sys

path = sys.argv[1]


def reject_constant(value):
    raise ValueError("non-finite JSON constant: " + value)


def reject_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate archive manifest JSON key")
        result[key] = value
    return result


pathname_before = os.lstat(path)
descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
try:
    before = os.fstat(descriptor)
    chunks = []
    while True:
        chunk = os.read(descriptor, 1024 * 1024)
        if not chunk:
            break
        chunks.append(chunk)
    after = os.fstat(descriptor)
    pathname_after = os.lstat(path)
finally:
    os.close(descriptor)
stable = lambda value: (
    value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
    value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode), value.st_nlink,
)
if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 \
        or (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) != (0, 0, 0o600) \
        or not (stable(pathname_before) == stable(before) == stable(after) == stable(pathname_after)):
    raise RuntimeError("archive manifest private identity drift")
raw = b"".join(chunks)
if len(raw) != before.st_size:
    raise RuntimeError("archive manifest short read")
value = json.loads(
    raw.decode("utf-8"), object_pairs_hook=reject_duplicates,
    parse_constant=reject_constant,
)
if not isinstance(value, dict):
    raise RuntimeError("archive manifest root is not an object")
print(json.dumps({
    "fingerprint": {
        "dev": before.st_dev,
        "ino": before.st_ino,
        "mtime_ns": before.st_mtime_ns,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "size": before.st_size,
    },
    "value": value,
}, sort_keys=True, separators=(",", ":")))
PY
}

capture_archive_manifest_owned() {
    local path=$1
    local operation_id=${2:-$ARCHIVE_OPERATION_ID}
    local before_identity after_identity
    before_identity="$(capture_archive_manifest_owned_identity "$path")" || return 1
    jq -e --arg operation_id "$operation_id" '
        .value | .schema == 2 and .operation_id == $operation_id and
        (keys | sort) == ["empty_inventory","entries","generation","inventory_complete",
                          "operation_id","previous_manifest_dev","previous_manifest_ino",
                          "previous_manifest_sha256","schema"] and
        (.generation | type == "number") and .generation >= 0 and
        .generation == (.generation | floor) and
        ((.generation == 0 and .previous_manifest_sha256 == null and
          .previous_manifest_dev == null and .previous_manifest_ino == null) or
         (.generation > 0 and
          (.previous_manifest_sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
          (.previous_manifest_dev | type == "number" and . > 0 and . == floor) and
          (.previous_manifest_ino | type == "number" and . > 0 and . == floor))) and
        (.inventory_complete | type == "boolean") and
        (.empty_inventory | type == "boolean") and
        ((.inventory_complete == false and .empty_inventory == false) or
         (.inventory_complete == true and
          .empty_inventory == ((.entries | length) == 0))) and
        (.entries | type == "array") and
        ([.entries[].source] | length == (unique | length)) and
        ([.entries[].destination] | length == (unique | length)) and
        ([.entries[].quarantine] | length == (unique | length)) and
        ([.entries[].candidate] | length == (unique | length)) and
        .generation == (
          (.entries | length) + (if .inventory_complete then 1 else 0 end) +
          ([.entries[] | select(.state == "quiescent" or .state == "copied" or .state == "archived")] | length) +
          ([.entries[] | select(.state == "copied" or .state == "archived")] | length) +
          ([.entries[] | select(.state == "archived" and has("candidate_dev"))] | length)
        ) and
        (if .inventory_complete == false then
           all(.entries[]; .state == "journaled")
         else
           ([.entries[].state] |
             map(if . == "archived" then "A" elif . == "copied" then "C" elif . == "quiescent" then "Q"
                 elif . == "journaled" then "J" else "X" end) |
             join("") | test("^A*(C|Q)?J*$"))
         end) and
        all(.entries[]; . as $entry | ($entry.source | split("/") | last) as $name |
          ($entry.source | test("^/var/log/nginx/aifeeds-performance[.]jsonl([.][0-9]+([.]gz)?)?$")) and
          $entry.quarantine == ("/var/log/nginx/." + $name + ".quarantine-gl-a-" + $operation_id) and
          $entry.destination == ("/var/backups/aifeeds-performance-log/audit-" + $operation_id + "/" + $name) and
          ($entry.candidate == ($entry.destination + ".candidate-gl-a-" + $operation_id)) and
          (.dev | type == "number") and (.ino | type == "number") and
          (.uid | type == "number") and (.gid | type == "number") and
          (.mode | type == "string" and test("^[0-7]{3,4}$")) and
          (.state == "journaled" or .state == "quiescent" or .state == "copied" or .state == "archived") and
          ((keys | sort) ==
            (if .state == "journaled" then
               ["candidate","destination","dev","gid","ino","mode","quarantine","source","state","uid"]
             elif .state == "quiescent" then
               ["candidate","destination","dev","final_mtime_s","final_sha256","final_size",
                "gid","ino","mode","quarantine","source","state","uid"]
             elif .state == "copied" then
               ["candidate","candidate_dev","candidate_ino","destination","dev","final_mtime_s",
                "final_sha256","final_size","gid","ino","mode","quarantine","source","state","uid"]
             elif has("candidate_dev") then
               ["candidate","candidate_dev","candidate_ino","destination","destination_dev",
                "destination_ino","dev","final_mtime_s","final_sha256","final_size","gid","ino",
                "mode","quarantine","source","state","uid"]
             else
               ["candidate","destination","destination_dev","destination_ino","dev","final_mtime_s",
                "final_sha256","final_size","gid","ino","mode","quarantine","source","state","uid"]
             end)) and
          (if .state == "journaled" then
             ((has("final_sha256") or has("final_size") or has("final_mtime_s")) | not)
           else
             (.final_sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
             (.final_size | type == "number" and . >= 0) and
             (.final_mtime_s | type == "number") and
             (if .state == "copied" then
                (.candidate_dev | type == "number" and . > 0) and
                (.candidate_ino | type == "number" and . > 0)
              elif .state == "archived" then
                (.destination_dev | type == "number" and . > 0) and
                (.destination_ino | type == "number" and . > 0) and
                (if has("candidate_dev") then
                   (.candidate_dev | type == "number" and . > 0) and
                   (.candidate_ino | type == "number" and . > 0)
                 else true end)
              else true end)
           end))' <<< "$before_identity" >/dev/null || return 1
    after_identity="$(capture_archive_manifest_owned_identity "$path")" || return 1
    test "$after_identity" = "$before_identity" || return 1
    printf '%s\n' "$before_identity"
}

archive_manifest_is_owned() {
    capture_archive_manifest_owned "$@" >/dev/null
}

archive_manifest_genesis_is_valid() {
    local path=$1
    local expected=${2:-} captured after
    captured="$(capture_archive_manifest_owned "$path")" || return 1
    if [ -n "$expected" ]; then
        test "$(jq -cS '.fingerprint' <<< "$captured")" = "$expected" || return 1
    fi
    jq -e '
        .value | .schema == 2 and .generation == 0 and
        .previous_manifest_sha256 == null and .previous_manifest_dev == null and
        .previous_manifest_ino == null and
        .inventory_complete == false and .empty_inventory == false and
        .entries == []' <<< "$captured" >/dev/null || return 1
    after="$(capture_archive_manifest_owned "$path")" || return 1
    test "$after" = "$captured"
}

capture_archive_manifest_predecessor() {
    local captured
    captured="$(capture_archive_manifest_owned "$ARCHIVE_MANIFEST")" || return 1
    jq -er '.fingerprint | [.sha256,.dev,.ino] | map(tostring) | join(" ")' \
        <<< "$captured"
}

manifest_predecessor_identity_from_successor() {
    local successor=$1
    local expected=${2:-} captured after
    captured="$(capture_archive_manifest_owned "$successor")" || return 1
    if [ -n "$expected" ]; then
        test "$(jq -cS '.fingerprint' <<< "$captured")" = "$expected" || return 1
    fi
    jq -er '
        .value |
        if .generation > 0 and (.previous_manifest_sha256 | test("^[a-f0-9]{64}$")) and
           (.previous_manifest_dev | type == "number" and . > 0 and . == floor) and
           (.previous_manifest_ino | type == "number" and . > 0 and . == floor)
        then [.previous_manifest_sha256,.previous_manifest_dev,.previous_manifest_ino] |
             map(tostring) | join(" ")
        else error("missing predecessor authority") end' <<< "$captured" || return 1
    after="$(capture_archive_manifest_owned "$successor")" || return 1
    test "$after" = "$captured"
}

archive_manifest_successor_is_valid() {
    local current=$1 successor=$2
    local current_expected=${3:-} successor_expected=${4:-}
    local captured
    if [ -z "$current_expected" ]; then
        captured="$(capture_archive_manifest_owned "$current")" || return 1
        current_expected="$(jq -cS '.fingerprint' <<< "$captured")" || return 1
    fi
    if [ -z "$successor_expected" ]; then
        captured="$(capture_archive_manifest_owned "$successor")" || return 1
        successor_expected="$(jq -cS '.fingerprint' <<< "$captured")" || return 1
    fi
    python3 - "$current" "$successor" "$current_expected" "$successor_expected" <<'PY'
import hashlib
import json
import os
import stat
import sys

current_path, successor_path, current_expected_raw, successor_expected_raw = sys.argv[1:]


def reject_constant(value):
    raise ValueError("non-finite JSON constant: " + value)


def reject_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate archive manifest JSON key")
        result[key] = value
    return result


def stable_capture(path, expected_raw):
    pathname_before = os.lstat(path)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 \
                or (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) != (0, 0, 0o600):
            raise SystemExit(1)
        chunks = []
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        after = os.fstat(descriptor)
        pathname_after = os.lstat(path)
        stable = lambda value: (
            value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
            value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode), value.st_nlink,
        )
        if not (stable(pathname_before) == stable(before) == stable(after) == stable(pathname_after)):
            raise SystemExit(1)
        if sum(map(len, chunks)) != before.st_size:
            raise SystemExit(1)
        raw = b"".join(chunks)
        fingerprint = {
            "dev": after.st_dev, "ino": after.st_ino, "mtime_ns": after.st_mtime_ns,
            "sha256": hashlib.sha256(raw).hexdigest(), "size": after.st_size,
        }
        if expected_raw and fingerprint != json.loads(expected_raw):
            raise RuntimeError("archive manifest expected identity drift")
        value = json.loads(
            raw.decode("utf-8"), object_pairs_hook=reject_duplicates,
            parse_constant=reject_constant,
        )
        if not isinstance(value, dict):
            raise RuntimeError("archive manifest root drift")
        return raw, after, value
    finally:
        os.close(descriptor)

current_raw, current_value, current = stable_capture(current_path, current_expected_raw)
successor_raw, _, successor = stable_capture(successor_path, successor_expected_raw)
if successor["generation"] != current["generation"] + 1:
    raise SystemExit(1)
if successor["previous_manifest_sha256"] != hashlib.sha256(current_raw).hexdigest():
    raise SystemExit(1)
if (successor["previous_manifest_dev"], successor["previous_manifest_ino"]) != (
    current_value.st_dev, current_value.st_ino
):
    raise SystemExit(1)
if (successor["schema"], successor["operation_id"]) != (current["schema"], current["operation_id"]):
    raise SystemExit(1)

current_entries = {entry["source"]: entry for entry in current["entries"]}
successor_entries = {entry["source"]: entry for entry in successor["entries"]}
current_sources = [entry["source"] for entry in current["entries"]]
successor_sources = [entry["source"] for entry in successor["entries"]]
if successor_sources[:len(current_sources)] != current_sources:
    raise SystemExit(1)
identity = ("source", "quarantine", "destination", "candidate", "dev", "ino", "uid", "gid", "mode")
if not current_entries.keys() <= successor_entries.keys():
    raise SystemExit(1)
for source, entry in current_entries.items():
    if any(successor_entries[source].get(key) != entry.get(key) for key in identity):
        raise SystemExit(1)

same_flags = (
    successor["inventory_complete"] == current["inventory_complete"] and
    successor["empty_inventory"] == current["empty_inventory"]
)
transition = None
new_sources = successor_entries.keys() - current_entries.keys()
if len(new_sources) == 1 and not current["inventory_complete"] and same_flags:
    source = next(iter(new_sources))
    if successor_entries[source]["state"] == "journaled" and all(
        successor_entries[key] == current_entries[key] for key in current_entries
    ):
        transition = "append"
elif not new_sources and current["entries"] == successor["entries"]:
    if (not current["inventory_complete"] and successor["inventory_complete"] and
            not current["empty_inventory"] and
            successor["empty_inventory"] == (len(current["entries"]) == 0)):
        transition = "seal"
elif (not new_sources and same_flags and current["inventory_complete"] and
      successor["inventory_complete"]):
    changed = [source for source in current_entries if current_entries[source] != successor_entries[source]]
    if len(changed) == 1:
        old = current_entries[changed[0]]
        new = successor_entries[changed[0]]
        old_without_state = {key: value for key, value in old.items() if key != "state"}
        new_without_state = {key: value for key, value in new.items() if key != "state"}
        if old["state"] == "journaled" and new["state"] == "quiescent":
            added = set(new_without_state) - set(old_without_state)
            if added == {"final_sha256", "final_size", "final_mtime_s"} and all(
                new_without_state[key] == value for key, value in old_without_state.items()
            ):
                transition = "quiesce"
        elif old["state"] == "quiescent" and new["state"] == "copied":
            added = set(new_without_state) - set(old_without_state)
            if added == {"candidate_dev", "candidate_ino"} and all(
                new_without_state[key] == value for key, value in old_without_state.items()
            ):
                transition = "copy"
        elif old["state"] in ("quiescent", "copied") and new["state"] == "archived":
            added = set(new_without_state) - set(old_without_state)
            if added == {"destination_dev", "destination_ino"} and all(
                new_without_state[key] == value for key, value in old_without_state.items()
            ):
                if old["state"] == "quiescent" and (
                    new["destination_dev"], new["destination_ino"]
                ) == (old["dev"], old["ino"]):
                    transition = "archive"
                elif old["state"] == "copied" and (
                    new["destination_dev"], new["destination_ino"]
                ) == (old["candidate_dev"], old["candidate_ino"]):
                    transition = "archive"
if transition is None:
    raise SystemExit(1)
PY
}

archive_manifest_successor_runtime_is_valid() {
    local current=$1 successor=$2
    local current_expected=${3:-} successor_expected=${4:-}
    local captured
    if [ -z "$current_expected" ]; then
        captured="$(capture_archive_manifest_owned "$current")" || return 1
        current_expected="$(jq -cS '.fingerprint' <<< "$captured")" || return 1
    fi
    if [ -z "$successor_expected" ]; then
        captured="$(capture_archive_manifest_owned "$successor")" || return 1
        successor_expected="$(jq -cS '.fingerprint' <<< "$captured")" || return 1
    fi
    python3 - "$current" "$successor" "$current_expected" "$successor_expected" <<'PY'
import hashlib
import json
import os
import stat
import sys

current_path, successor_path, current_expected_raw, successor_expected_raw = sys.argv[1:]


def reject_constant(value):
    raise ValueError("non-finite JSON constant: " + value)


def reject_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate archive manifest JSON key")
        result[key] = value
    return result


def capture_manifest(path, expected_raw):
    pathname_before = os.lstat(path)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        chunks = []
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        after = os.fstat(descriptor)
        pathname_after = os.lstat(path)
    finally:
        os.close(descriptor)
    stable = lambda value: (
        value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
        value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode), value.st_nlink,
    )
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 \
            or (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) != (0, 0, 0o600) \
            or not (stable(pathname_before) == stable(before) == stable(after) == stable(pathname_after)):
        raise RuntimeError("archive manifest runtime identity drift")
    raw = b"".join(chunks)
    if len(raw) != before.st_size:
        raise RuntimeError("archive manifest runtime short read")
    fingerprint = {
        "dev": before.st_dev, "ino": before.st_ino, "mtime_ns": before.st_mtime_ns,
        "sha256": hashlib.sha256(raw).hexdigest(), "size": before.st_size,
    }
    if expected_raw and fingerprint != json.loads(expected_raw):
        raise RuntimeError("archive manifest runtime expected identity drift")
    return json.loads(
        raw.decode("utf-8"), object_pairs_hook=reject_duplicates,
        parse_constant=reject_constant,
    )


current = capture_manifest(current_path, current_expected_raw)
successor = capture_manifest(successor_path, successor_expected_raw)
old = {entry["source"]: entry for entry in current["entries"]}
new = {entry["source"]: entry for entry in successor["entries"]}

def absent(path):
    return not os.path.lexists(path)

def capture_regular(path, uid, gid, mode, freeze_content=False):
    try:
        pathname_before = os.lstat(path)
    except FileNotFoundError:
        return None
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        digest = None
        if freeze_content:
            chunks = []
            while True:
                chunk = os.read(descriptor, 1024 * 1024)
                if not chunk:
                    break
                chunks.append(chunk)
            raw = b"".join(chunks)
            digest = hashlib.sha256(raw).hexdigest()
        after = os.fstat(descriptor)
        pathname_after = os.lstat(path)
    finally:
        os.close(descriptor)
    inode_identity = lambda value: (
        value.st_dev, value.st_ino, value.st_uid, value.st_gid,
        stat.S_IMODE(value.st_mode), value.st_nlink,
    )
    stable = (lambda value: inode_identity(value) + (value.st_size, value.st_mtime_ns)) \
        if freeze_content else inode_identity
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 \
            or (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) != (
                uid, gid, int(mode, 8),
            ) or not (stable(pathname_before) == stable(before) == stable(after) == stable(pathname_after)):
        return None
    if freeze_content and len(raw) != before.st_size:
        return None
    return before, digest

def exact_inode(entry, path):
    captured = capture_regular(path, entry["uid"], entry["gid"], entry["mode"])
    return captured is not None and (captured[0].st_dev, captured[0].st_ino) == (
        entry["dev"], entry["ino"],
    )

def exact_final(entry, path):
    captured = capture_regular(path, 0, 0, "600", True)
    if captured is None:
        return False
    value, digest = captured
    if value.st_size != entry["final_size"]:
        return False
    if "destination_dev" in entry and (value.st_dev, value.st_ino) != (
        entry["destination_dev"], entry["destination_ino"]
    ):
        return False
    return digest == entry["final_sha256"]

def exact_candidate(entry):
    captured = capture_regular(entry["candidate"], 0, 0, "600", True)
    if captured is None:
        return False
    value, digest = captured
    if (value.st_dev, value.st_ino) != (
        entry["candidate_dev"], entry["candidate_ino"]
    ) or value.st_size != entry["final_size"]:
        return False
    return digest == entry["final_sha256"]


def exact_quiescent(entry):
    captured = capture_regular(
        entry["quarantine"], entry["uid"], entry["gid"], entry["mode"], True,
    )
    if captured is None:
        captured = capture_regular(entry["quarantine"], 0, 0, "600", True)
    if captured is None:
        return False
    value, digest = captured
    return (
        (value.st_dev, value.st_ino) == (entry["dev"], entry["ino"])
        and digest == entry["final_sha256"]
        and value.st_size == entry["final_size"]
        and int(value.st_mtime) == entry["final_mtime_s"]
    )

added = new.keys() - old.keys()
changed = [source for source in old if old[source] != new[source]]
if len(added) == 1:
    entry = new[next(iter(added))]
    valid = exact_inode(entry, entry["source"]) and all(
        absent(entry[key]) for key in ("quarantine", "destination", "candidate")
    )
elif not current["inventory_complete"] and successor["inventory_complete"]:
    valid = all(
        absent(entry["source"]) and exact_inode(entry, entry["quarantine"]) and
        absent(entry["destination"]) and absent(entry["candidate"])
        for entry in new.values()
    )
elif (current["inventory_complete"] and successor["inventory_complete"] and
      len(changed) == 1 and old[changed[0]]["state"] == "journaled"):
    entry = new[changed[0]]
    captured = capture_regular(
        entry["quarantine"], entry["uid"], entry["gid"], entry["mode"], True,
    )
    if captured is None:
        valid = False
    else:
        value, digest = captured
        valid = (digest == entry["final_sha256"] and value.st_size == entry["final_size"] and
                 (value.st_dev, value.st_ino) == (entry["dev"], entry["ino"]) and
                 int(value.st_mtime) == entry["final_mtime_s"] and
                 absent(entry["destination"]) and absent(entry["candidate"]))
elif (current["inventory_complete"] and successor["inventory_complete"] and
      len(changed) == 1 and old[changed[0]]["state"] == "quiescent"):
    entry = new[changed[0]]
    if entry["state"] == "copied":
        valid = (exact_quiescent(entry) and exact_candidate(entry) and
                 absent(entry["source"]) and absent(entry["destination"]))
    else:
        valid = (exact_final(entry, entry["destination"]) and
                 all(absent(entry[key]) for key in ("source", "quarantine", "candidate")))
elif (current["inventory_complete"] and successor["inventory_complete"] and
      len(changed) == 1 and old[changed[0]]["state"] == "copied"):
    entry = new[changed[0]]
    valid = (exact_final(entry, entry["destination"]) and
             all(absent(entry[key]) for key in ("source", "quarantine", "candidate")))
else:
    valid = False
if not valid:
    raise SystemExit(1)
PY
}

archive_manifest_consumed_predecessor_is_valid() {
    local predecessor=$1 current=$2
    local predecessor_expected=${3:-} current_expected=${4:-}
    archive_manifest_successor_is_valid \
        "$predecessor" "$current" "$predecessor_expected" "$current_expected" || return 1
    archive_manifest_successor_runtime_is_valid \
        "$predecessor" "$current" "$predecessor_expected" "$current_expected"
}

recover_archive_manifest_cleanup_tombstone() {
    local predecessor_identity='' predecessor_sha256='' predecessor_dev='' predecessor_ino=''
    local cleanup_state successor_capture successor_fp path_tag cleanup_prefix cleanup_dir payload
    local payload_capture payload_fp
    if [ ! -d "$AUDIT_DIR" ] || [ -L "$AUDIT_DIR" ]; then return 0; fi
    cleanup_state="$(private_cleanup_tombstone_state "$ARCHIVE_MANIFEST_PREVIOUS")" || return 1
    if [ "$cleanup_state" = absent ]; then return 0; fi
    test "$cleanup_state" = present || return 1
    test -f "$ARCHIVE_MANIFEST" && test ! -L "$ARCHIVE_MANIFEST" || return 1
    test ! -e "$ARCHIVE_MANIFEST_TMP" && test ! -L "$ARCHIVE_MANIFEST_TMP" || return 1
    test ! -e "$ARCHIVE_MANIFEST_PREVIOUS" && test ! -L "$ARCHIVE_MANIFEST_PREVIOUS" \
        || return 1
    successor_capture="$(capture_archive_manifest_owned "$ARCHIVE_MANIFEST")" || return 1
    successor_fp="$(jq -cS '.fingerprint' <<< "$successor_capture")" || return 1
    predecessor_identity="$(manifest_predecessor_identity_from_successor \
        "$ARCHIVE_MANIFEST" "$successor_fp")" || return 1
    read -r predecessor_sha256 predecessor_dev predecessor_ino <<< "$predecessor_identity"
    path_tag="$(printf '%s' "$ARCHIVE_MANIFEST_PREVIOUS" | sha256sum \
        | awk '{print substr($1,1,16)}')" || return 1
    cleanup_prefix=".cleanup-gl-a-${ARCHIVE_OPERATION_ID}-${path_tag}-"
    cleanup_dir="${ARCHIVE_MANIFEST_PREVIOUS%/*}/${cleanup_prefix}${predecessor_dev}-${predecessor_ino}"
    payload="${cleanup_dir}/payload"
    test -d "$cleanup_dir" && test ! -L "$cleanup_dir" || return 1
    if [ -e "$payload" ] || [ -L "$payload" ]; then
        payload_capture="$(capture_archive_manifest_owned "$payload")" || return 1
        payload_fp="$(jq -cS '.fingerprint' <<< "$payload_capture")" || return 1
        test "$(jq -r '[.sha256,.dev,.ino] | map(tostring) | join(" ")' \
            <<< "$payload_fp")" = "$predecessor_sha256 $predecessor_dev $predecessor_ino" \
            || return 1
        archive_manifest_consumed_predecessor_is_valid \
            "$payload" "$ARCHIVE_MANIFEST" "$payload_fp" "$successor_fp" || return 1
    else
        test ! -L "$payload" || return 1
        archive_manifest_recovery_is_reachable "$ARCHIVE_MANIFEST" "$successor_fp" || return 1
    fi
    test "$(capture_archive_manifest_owned "$ARCHIVE_MANIFEST")" = "$successor_capture" \
        || return 1
    recover_private_cleanup_tombstone "$ARCHIVE_MANIFEST_PREVIOUS" \
        "$predecessor_sha256" 0 0 600 0 "$predecessor_dev" "$predecessor_ino" 0
}

archive_manifest_recovery_is_reachable() {
    local path=$1
    local expected=${2:-}
    local captured
    if [ -z "$expected" ]; then
        captured="$(capture_archive_manifest_owned "$path")" || return 1
        expected="$(jq -cS '.fingerprint' <<< "$captured")" || return 1
    fi
    python3 - "$path" "$expected" <<'PY'
import hashlib
import json
import os
import stat
import sys

manifest_path, expected_raw = sys.argv[1:]


def reject_constant(value):
    raise ValueError("non-finite JSON constant: " + value)


def reject_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate archive manifest JSON key")
        result[key] = value
    return result


def capture_manifest(path):
    pathname_before = os.lstat(path)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        chunks = []
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        after = os.fstat(descriptor)
        pathname_after = os.lstat(path)
    finally:
        os.close(descriptor)
    stable = lambda value: (
        value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
        value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode), value.st_nlink,
    )
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 \
            or (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) != (0, 0, 0o600) \
            or not (stable(pathname_before) == stable(before) == stable(after) == stable(pathname_after)):
        raise RuntimeError("archive reachable manifest identity drift")
    raw = b"".join(chunks)
    if len(raw) != before.st_size:
        raise RuntimeError("archive reachable manifest short read")
    fingerprint = {
        "dev": before.st_dev, "ino": before.st_ino, "mtime_ns": before.st_mtime_ns,
        "sha256": hashlib.sha256(raw).hexdigest(), "size": before.st_size,
    }
    if expected_raw and fingerprint != json.loads(expected_raw):
        raise RuntimeError("archive reachable manifest expected identity drift")
    return json.loads(
        raw.decode("utf-8"), object_pairs_hook=reject_duplicates,
        parse_constant=reject_constant,
    )


manifest = capture_manifest(manifest_path)

def absent(path):
    return not os.path.lexists(path)

def capture_regular(path, uid, gid, mode, freeze_content=False):
    try:
        pathname_before = os.lstat(path)
    except FileNotFoundError:
        return None
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        digest = None
        if freeze_content:
            chunks = []
            while True:
                chunk = os.read(descriptor, 1024 * 1024)
                if not chunk:
                    break
                chunks.append(chunk)
            raw = b"".join(chunks)
            digest = hashlib.sha256(raw).hexdigest()
        after = os.fstat(descriptor)
        pathname_after = os.lstat(path)
    finally:
        os.close(descriptor)
    inode_identity = lambda value: (
        value.st_dev, value.st_ino, value.st_uid, value.st_gid,
        stat.S_IMODE(value.st_mode), value.st_nlink,
    )
    stable = (lambda value: inode_identity(value) + (value.st_size, value.st_mtime_ns)) \
        if freeze_content else inode_identity
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 \
            or (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) != (
                uid, gid, int(mode, 8),
            ) or not (stable(pathname_before) == stable(before) == stable(after) == stable(pathname_after)):
        return None
    if freeze_content and len(raw) != before.st_size:
        return None
    return before, digest

def exact_inode(entry, path):
    captured = capture_regular(path, entry["uid"], entry["gid"], entry["mode"])
    return captured is not None and (captured[0].st_dev, captured[0].st_ino) == (
        entry["dev"], entry["ino"],
    )

def exact_quarantine(entry, freeze_content):
    captured = capture_regular(
        entry["quarantine"], entry["uid"], entry["gid"], entry["mode"], freeze_content,
    )
    if captured is None:
        captured = capture_regular(entry["quarantine"], 0, 0, "600", freeze_content)
    if captured is None:
        return False
    value, digest = captured
    if (value.st_dev, value.st_ino) != (entry["dev"], entry["ino"]):
        return False
    return not freeze_content or (
        digest == entry["final_sha256"] and value.st_size == entry["final_size"]
        and int(value.st_mtime) == entry["final_mtime_s"]
    )

def exact_final(entry, path, uid, gid, mode):
    captured = capture_regular(path, uid, gid, mode, True)
    if captured is None:
        return False
    value, digest = captured
    if value.st_size != entry["final_size"]:
        return False
    if path == entry["destination"] and "destination_dev" in entry and (
        value.st_dev, value.st_ino
    ) != (entry["destination_dev"], entry["destination_ino"]):
        return False
    if path == entry["destination"] and entry.get("state") == "copied" and (
        value.st_dev, value.st_ino
    ) != (entry["candidate_dev"], entry["candidate_ino"]):
        return False
    if path == entry["destination"] and entry.get("state") == "quiescent" and (
        value.st_dev, value.st_ino
    ) != (entry["dev"], entry["ino"]):
        return False
    if path == entry["candidate"] and "candidate_dev" in entry and (
        value.st_dev, value.st_ino
    ) != (entry["candidate_dev"], entry["candidate_ino"]):
        return False
    return digest == entry["final_sha256"]

for entry in manifest["entries"]:
    source_present = exact_inode(entry, entry["source"])
    quarantine_present = exact_quarantine(entry, entry["state"] != "journaled")
    destination_present = (
        "final_sha256" in entry and exact_final(entry, entry["destination"], 0, 0, "600")
    )
    candidate_present = (
        "candidate_dev" in entry and exact_final(entry, entry["candidate"], 0, 0, "600")
    )
    if entry["state"] == "journaled":
        if manifest["inventory_complete"]:
            valid = (absent(entry["source"]) and quarantine_present and
                     absent(entry["destination"]) and absent(entry["candidate"]))
        else:
            valid = ((source_present and absent(entry["quarantine"]) or
                     absent(entry["source"]) and quarantine_present) and
                     absent(entry["destination"]) and absent(entry["candidate"]))
    elif entry["state"] == "quiescent":
        valid = absent(entry["source"]) and (
            quarantine_present and absent(entry["destination"]) and absent(entry["candidate"]) or
            absent(entry["quarantine"]) and destination_present and absent(entry["candidate"])
        )
    elif entry["state"] == "copied":
        valid = (absent(entry["source"]) and
                 ((quarantine_present and candidate_present and absent(entry["destination"])) or
                  (quarantine_present and absent(entry["candidate"]) and destination_present) or
                  (absent(entry["quarantine"]) and absent(entry["candidate"]) and destination_present)))
    else:
        valid = (entry["state"] == "archived" and absent(entry["source"]) and
                 absent(entry["quarantine"]) and absent(entry["candidate"]) and destination_present)
    if not valid:
        raise SystemExit(1)
PY
}

publish_archive_manifest_tmp() {
    local previous_identity previous_sha previous_dev previous_ino tmp_identity tmp_sha tmp_dev tmp_ino
    if [ -e "$ARCHIVE_MANIFEST" ]; then
        archive_manifest_is_owned "$ARCHIVE_MANIFEST" || return 1
    fi
    archive_manifest_is_owned "$ARCHIVE_MANIFEST_TMP" || return 1
    sync -f "$ARCHIVE_MANIFEST_TMP" || return 1
    if [ ! -e "$ARCHIVE_MANIFEST" ] && [ ! -L "$ARCHIVE_MANIFEST" ] \
        && [ ! -e "$ARCHIVE_MANIFEST_PREVIOUS" ] && [ ! -L "$ARCHIVE_MANIFEST_PREVIOUS" ]; then
        archive_manifest_genesis_is_valid "$ARCHIVE_MANIFEST_TMP" || return 1
        rename_no_replace "$ARCHIVE_MANIFEST_TMP" "$ARCHIVE_MANIFEST" || return 1
        sync -f "$ARCHIVE_MANIFEST" || return 1
        archive_manifest_is_owned "$ARCHIVE_MANIFEST" || return 1
        return 0
    fi
    if [ -e "$ARCHIVE_MANIFEST" ] || [ -L "$ARCHIVE_MANIFEST" ]; then
        archive_manifest_is_owned "$ARCHIVE_MANIFEST" || return 1
        test ! -e "$ARCHIVE_MANIFEST_PREVIOUS" || return 1
        test ! -L "$ARCHIVE_MANIFEST_PREVIOUS" || return 1
        archive_manifest_successor_is_valid "$ARCHIVE_MANIFEST" "$ARCHIVE_MANIFEST_TMP" || return 1
        archive_manifest_successor_runtime_is_valid "$ARCHIVE_MANIFEST" "$ARCHIVE_MANIFEST_TMP" || return 1
        previous_identity="$(manifest_predecessor_identity_from_successor \
            "$ARCHIVE_MANIFEST_TMP")" || return 1
        read -r previous_sha previous_dev previous_ino <<< "$previous_identity"
        path_matches_exact_identity "$ARCHIVE_MANIFEST" "$previous_sha" 0 0 600 \
            "$previous_dev" "$previous_ino" || return 1
        rename_no_replace "$ARCHIVE_MANIFEST" "$ARCHIVE_MANIFEST_PREVIOUS" || return 1
    fi
    test ! -e "$ARCHIVE_MANIFEST"
    test ! -L "$ARCHIVE_MANIFEST"
    if ! archive_manifest_is_owned "$ARCHIVE_MANIFEST_PREVIOUS"; then
        return 1
    fi
    if [ -z "${previous_sha:-}" ]; then
        previous_identity="$(manifest_predecessor_identity_from_successor \
            "$ARCHIVE_MANIFEST_TMP")" || return 1
        read -r previous_sha previous_dev previous_ino <<< "$previous_identity"
        archive_manifest_recovery_is_reachable "$ARCHIVE_MANIFEST_PREVIOUS" || return 1
    fi
    if ! path_matches_exact_identity "$ARCHIVE_MANIFEST_PREVIOUS" "$previous_sha" 0 0 600 \
        "$previous_dev" "$previous_ino"; then
        return 1
    fi
    tmp_identity="$(capture_regular_file_identity_stable "$ARCHIVE_MANIFEST_TMP")" || return 1
    tmp_sha="$(jq -er '.sha256' <<< "$tmp_identity")" || return 1
    tmp_dev="$(jq -er '.dev' <<< "$tmp_identity")" || return 1
    tmp_ino="$(jq -er '.ino' <<< "$tmp_identity")" || return 1
    if ! sync -f "$ARCHIVE_MANIFEST_PREVIOUS"; then
        restore_previous_manifest_no_replace "$previous_sha" "$previous_dev" "$previous_ino" || return 1
        return 1
    fi
    if ! sync -f "$ARCHIVE_MANIFEST_TMP"; then
        restore_previous_manifest_no_replace "$previous_sha" "$previous_dev" "$previous_ino" || return 1
        return 1
    fi
    if [ "$(sha256sum "$ARCHIVE_MANIFEST_PREVIOUS" | awk '{print $1}')" != "$previous_sha" ] \
        || [ "$(stat -c '%d %i' "$ARCHIVE_MANIFEST_PREVIOUS")" != "$previous_dev $previous_ino" ] \
        || [ "$(sha256sum "$ARCHIVE_MANIFEST_TMP" | awk '{print $1}')" != "$tmp_sha" ] \
        || [ "$(stat -c '%d %i' "$ARCHIVE_MANIFEST_TMP")" != "$tmp_dev $tmp_ino" ] \
        || ! archive_manifest_successor_is_valid "$ARCHIVE_MANIFEST_PREVIOUS" "$ARCHIVE_MANIFEST_TMP" \
        || ! archive_manifest_successor_runtime_is_valid "$ARCHIVE_MANIFEST_PREVIOUS" "$ARCHIVE_MANIFEST_TMP"; then
        restore_previous_manifest_no_replace "$previous_sha" "$previous_dev" "$previous_ino" || return 1
        return 1
    fi
    if ! rename_no_replace "$ARCHIVE_MANIFEST_TMP" "$ARCHIVE_MANIFEST"; then
        restore_previous_manifest_no_replace "$previous_sha" "$previous_dev" "$previous_ino" || return 1
        return 1
    fi
    if ! archive_manifest_is_owned "$ARCHIVE_MANIFEST" \
        || [ "$(sha256sum "$ARCHIVE_MANIFEST" | awk '{print $1}')" != "$tmp_sha" ] \
        || [ "$(stat -c '%d %i' "$ARCHIVE_MANIFEST")" != "$tmp_dev $tmp_ino" ] \
        || [ "$(sha256sum "$ARCHIVE_MANIFEST_PREVIOUS" | awk '{print $1}')" != "$previous_sha" ] \
        || [ "$(stat -c '%d %i' "$ARCHIVE_MANIFEST_PREVIOUS")" != "$previous_dev $previous_ino" ] \
        || ! archive_manifest_consumed_predecessor_is_valid "$ARCHIVE_MANIFEST_PREVIOUS" "$ARCHIVE_MANIFEST"; then
        preserve_published_manifest_and_restore_previous "$previous_sha" "$previous_dev" "$previous_ino" || return 1
        return 1
    fi
    sync -f "$ARCHIVE_MANIFEST" || return 1
    remove_exact_manifest_file "$ARCHIVE_MANIFEST_PREVIOUS" "$previous_sha" "$previous_dev" "$previous_ino"
}

restore_previous_manifest_no_replace() {
    local expected_sha256=$1
    local expected_dev=$2
    local expected_ino=$3
    if [ -e "$ARCHIVE_MANIFEST" ] || [ -L "$ARCHIVE_MANIFEST" ]; then return 1; fi
    if [ ! -e "$ARCHIVE_MANIFEST_PREVIOUS" ] && [ ! -L "$ARCHIVE_MANIFEST_PREVIOUS" ]; then return 1; fi
    archive_manifest_recovery_is_reachable "$ARCHIVE_MANIFEST_PREVIOUS" || return 1
    path_matches_exact_identity "$ARCHIVE_MANIFEST_PREVIOUS" "$expected_sha256" 0 0 600 \
        "$expected_dev" "$expected_ino" || return 1
    sync -f "$ARCHIVE_MANIFEST_PREVIOUS" || return 1
    path_matches_exact_identity "$ARCHIVE_MANIFEST_PREVIOUS" "$expected_sha256" 0 0 600 \
        "$expected_dev" "$expected_ino" || return 1
    archive_manifest_recovery_is_reachable "$ARCHIVE_MANIFEST_PREVIOUS" || return 1
    rename_no_replace "$ARCHIVE_MANIFEST_PREVIOUS" "$ARCHIVE_MANIFEST" || return 1
    path_matches_exact_identity "$ARCHIVE_MANIFEST" "$expected_sha256" 0 0 600 \
        "$expected_dev" "$expected_ino" || return 1
    archive_manifest_recovery_is_reachable "$ARCHIVE_MANIFEST"
}

preserve_published_manifest_and_restore_previous() {
    local expected_sha256=$1 expected_dev=$2 expected_ino=$3
    if [ -e "$ARCHIVE_MANIFEST_TMP" ] || [ -L "$ARCHIVE_MANIFEST_TMP" ]; then return 1; fi
    if [ ! -e "$ARCHIVE_MANIFEST" ] && [ ! -L "$ARCHIVE_MANIFEST" ]; then return 1; fi
    if [ ! -e "$ARCHIVE_MANIFEST_PREVIOUS" ] && [ ! -L "$ARCHIVE_MANIFEST_PREVIOUS" ]; then return 1; fi
    rename_no_replace "$ARCHIVE_MANIFEST" "$ARCHIVE_MANIFEST_TMP" || return 1
    restore_previous_manifest_no_replace "$expected_sha256" "$expected_dev" "$expected_ino"
}

ensure_archive_manifest() {
    local previous_identity previous_sha previous_dev previous_ino
    local final_identity final_sha final_dev final_ino
    recover_archive_manifest_cleanup_tombstone || return 1
    test ! -L "$ARCHIVE_MANIFEST"
    test ! -L "$ARCHIVE_MANIFEST_TMP"
    test ! -L "$ARCHIVE_MANIFEST_PREVIOUS"
    if [ -e "$ARCHIVE_MANIFEST" ]; then
        archive_manifest_is_owned "$ARCHIVE_MANIFEST" || return 1
    fi
    if [ -e "$ARCHIVE_MANIFEST_PREVIOUS" ]; then
        if [ -e "$ARCHIVE_MANIFEST" ]; then
            test ! -e "$ARCHIVE_MANIFEST_TMP" || return 1
            archive_manifest_is_owned "$ARCHIVE_MANIFEST_PREVIOUS" || return 1
            archive_manifest_is_owned "$ARCHIVE_MANIFEST" || return 1
            archive_manifest_consumed_predecessor_is_valid \
                "$ARCHIVE_MANIFEST_PREVIOUS" "$ARCHIVE_MANIFEST" || return 1
            previous_identity="$(manifest_predecessor_identity_from_successor \
                "$ARCHIVE_MANIFEST")" || return 1
            read -r previous_sha previous_dev previous_ino <<< "$previous_identity"
            final_identity="$(capture_regular_file_identity_stable "$ARCHIVE_MANIFEST")" || return 1
            final_sha="$(jq -er '.sha256' <<< "$final_identity")" || return 1
            final_dev="$(jq -er '.dev' <<< "$final_identity")" || return 1
            final_ino="$(jq -er '.ino' <<< "$final_identity")" || return 1
            sync -f "$ARCHIVE_MANIFEST" || return 1
            test "$(sha256sum "$ARCHIVE_MANIFEST_PREVIOUS" | awk '{print $1}')" = "$previous_sha" || return 1
            test "$(stat -c '%d %i' "$ARCHIVE_MANIFEST_PREVIOUS")" = "$previous_dev $previous_ino" || return 1
            test "$(sha256sum "$ARCHIVE_MANIFEST" | awk '{print $1}')" = "$final_sha" || return 1
            test "$(stat -c '%d %i' "$ARCHIVE_MANIFEST")" = "$final_dev $final_ino" || return 1
            archive_manifest_consumed_predecessor_is_valid \
                "$ARCHIVE_MANIFEST_PREVIOUS" "$ARCHIVE_MANIFEST" || return 1
            remove_exact_manifest_file "$ARCHIVE_MANIFEST_PREVIOUS" \
                "$previous_sha" "$previous_dev" "$previous_ino" || return 1
        else
            test -e "$ARCHIVE_MANIFEST_TMP" || return 1
            archive_manifest_is_owned "$ARCHIVE_MANIFEST_TMP" || return 1
            publish_archive_manifest_tmp || return 1
        fi
    fi
    if [ -e "$ARCHIVE_MANIFEST_TMP" ]; then
        archive_manifest_is_owned "$ARCHIVE_MANIFEST_TMP" || return 1
        if [ -e "$ARCHIVE_MANIFEST" ]; then
            if archive_manifest_successor_is_valid "$ARCHIVE_MANIFEST" "$ARCHIVE_MANIFEST_TMP" \
                && archive_manifest_successor_runtime_is_valid "$ARCHIVE_MANIFEST" "$ARCHIVE_MANIFEST_TMP"; then
                publish_archive_manifest_tmp || return 1
            else
                return 1
            fi
        else
            archive_manifest_genesis_is_valid "$ARCHIVE_MANIFEST_TMP" || return 1
            publish_archive_manifest_tmp || return 1
        fi
    fi
    if [ ! -e "$ARCHIVE_MANIFEST" ]; then
        jq -nc --arg operation_id "$ARCHIVE_OPERATION_ID" \
            '{schema:2,operation_id:$operation_id,generation:0,previous_manifest_sha256:null,
              previous_manifest_dev:null,previous_manifest_ino:null,
              inventory_complete:false,empty_inventory:false,entries:[]}' \
            > "$ARCHIVE_MANIFEST_TMP" || return 1
        publish_archive_manifest_tmp || return 1
    fi
    archive_manifest_is_owned "$ARCHIVE_MANIFEST"
}

record_log_archive_entry() {
    local source=$1 quarantine=$2 destination=$3 candidate=$4 dev=$5 ino=$6
    local uid=$7 gid=$8 mode=$9
    local previous previous_dev previous_ino previous_identity generation
    ensure_archive_manifest || return 1
    if jq -e --arg source "$source" '.entries[] | select(.source == $source)' \
        "$ARCHIVE_MANIFEST" >/dev/null; then
        jq -e --arg source "$source" --arg quarantine "$quarantine" \
            --arg destination "$destination" --arg candidate "$candidate" \
            --argjson dev "$dev" --argjson ino "$ino" \
            --argjson uid "$uid" --argjson gid "$gid" --arg mode "$mode" '
            .entries[] | select(.source == $source) |
            .quarantine == $quarantine and .destination == $destination and
            .candidate == $candidate and .dev == $dev and .ino == $ino and
            .uid == $uid and .gid == $gid and .mode == $mode' \
            "$ARCHIVE_MANIFEST" >/dev/null || return 1
        return 0
    fi
    previous_identity="$(capture_archive_manifest_predecessor)" || return 1
    read -r previous previous_dev previous_ino <<< "$previous_identity"
    generation="$(jq -er '.generation + 1' "$ARCHIVE_MANIFEST")"
    jq --arg source "$source" --arg quarantine "$quarantine" \
        --arg destination "$destination" --arg candidate "$candidate" \
        --argjson dev "$dev" --argjson ino "$ino" \
        --argjson uid "$uid" --argjson gid "$gid" --arg mode "$mode" \
        --arg previous "$previous" --argjson previous_dev "$previous_dev" \
        --argjson previous_ino "$previous_ino" --argjson generation "$generation" '
        .entries += [{source:$source,quarantine:$quarantine,destination:$destination,
          candidate:$candidate,dev:$dev,ino:$ino,uid:$uid,gid:$gid,mode:$mode,state:"journaled"}] |
        .generation = $generation | .previous_manifest_sha256 = $previous |
        .previous_manifest_dev = $previous_dev | .previous_manifest_ino = $previous_ino' \
        "$ARCHIVE_MANIFEST" > "$ARCHIVE_MANIFEST_TMP" || return 1
    publish_archive_manifest_tmp
}

record_log_archive_quiescent() {
    local source=$1 sha256=$2 size=$3 mtime_s=$4
    local previous previous_dev previous_ino previous_identity generation
    archive_manifest_is_owned "$ARCHIVE_MANIFEST" || return 1
    if jq -e --arg source "$source" --arg sha256 "$sha256" \
        --argjson size "$size" --argjson mtime_s "$mtime_s" '
        [.entries[] | select(.source == $source and
          (.state == "quiescent" or .state == "copied" or .state == "archived") and
          .final_sha256 == $sha256 and .final_size == $size and
          .final_mtime_s == $mtime_s)] | length == 1' "$ARCHIVE_MANIFEST" >/dev/null; then
        return 0
    fi
    previous_identity="$(capture_archive_manifest_predecessor)" || return 1
    read -r previous previous_dev previous_ino <<< "$previous_identity"
    generation="$(jq -er '.generation + 1' "$ARCHIVE_MANIFEST")"
    jq --arg source "$source" --arg sha256 "$sha256" \
        --argjson size "$size" --argjson mtime_s "$mtime_s" \
        --arg previous "$previous" --argjson previous_dev "$previous_dev" \
        --argjson previous_ino "$previous_ino" --argjson generation "$generation" '
        if ([.entries[] | select(.source == $source and .state == "journaled")] | length) != 1 then error("entry")
        else .entries |= map(if .source == $source then
          . + {final_sha256:$sha256,final_size:$size,final_mtime_s:$mtime_s,state:"quiescent"}
          else . end) end |
        .generation = $generation | .previous_manifest_sha256 = $previous |
        .previous_manifest_dev = $previous_dev | .previous_manifest_ino = $previous_ino' \
        "$ARCHIVE_MANIFEST" > "$ARCHIVE_MANIFEST_TMP" || return 1
    publish_archive_manifest_tmp
}

record_log_archive_inventory_complete() {
    local previous previous_dev previous_ino previous_identity generation
    if jq -e '.inventory_complete == true and .empty_inventory == ((.entries | length) == 0)' \
        "$ARCHIVE_MANIFEST" >/dev/null; then return 0; fi
    previous_identity="$(capture_archive_manifest_predecessor)" || return 1
    read -r previous previous_dev previous_ino <<< "$previous_identity"
    generation="$(jq -er '.generation + 1' "$ARCHIVE_MANIFEST")"
    jq --arg previous "$previous" --argjson previous_dev "$previous_dev" \
        --argjson previous_ino "$previous_ino" --argjson generation "$generation" '
        .inventory_complete = true | .empty_inventory = ((.entries | length) == 0) |
        .generation = $generation | .previous_manifest_sha256 = $previous |
        .previous_manifest_dev = $previous_dev | .previous_manifest_ino = $previous_ino' \
        "$ARCHIVE_MANIFEST" > "$ARCHIVE_MANIFEST_TMP" || return 1
    publish_archive_manifest_tmp
}

record_log_archive_copied() {
    local source=$1 candidate_dev=$2 candidate_ino=$3
    local previous previous_dev previous_ino previous_identity generation
    if jq -e --arg source "$source" --argjson candidate_dev "$candidate_dev" \
        --argjson candidate_ino "$candidate_ino" '
        [.entries[] | select(.source == $source and .state == "copied" and
          .candidate_dev == $candidate_dev and .candidate_ino == $candidate_ino)] |
        length == 1' "$ARCHIVE_MANIFEST" >/dev/null; then return 0; fi
    previous_identity="$(capture_archive_manifest_predecessor)" || return 1
    read -r previous previous_dev previous_ino <<< "$previous_identity"
    generation="$(jq -er '.generation + 1' "$ARCHIVE_MANIFEST")"
    jq --arg source "$source" --argjson candidate_dev "$candidate_dev" \
        --argjson candidate_ino "$candidate_ino" --arg previous "$previous" \
        --argjson previous_dev "$previous_dev" --argjson previous_ino "$previous_ino" \
        --argjson generation "$generation" '
        if ([.entries[] | select(.source == $source and .state == "quiescent")] | length) != 1
        then error("entry")
        else .entries |= map(if .source == $source then
          . + {candidate_dev:$candidate_dev,candidate_ino:$candidate_ino,state:"copied"}
          else . end) end |
        .generation = $generation | .previous_manifest_sha256 = $previous |
        .previous_manifest_dev = $previous_dev | .previous_manifest_ino = $previous_ino' \
        "$ARCHIVE_MANIFEST" > "$ARCHIVE_MANIFEST_TMP" || return 1
    publish_archive_manifest_tmp
}

record_log_archive_archived() {
    local source=$1 destination_dev=$2 destination_ino=$3
    local previous previous_dev previous_ino previous_identity generation
    if jq -e --arg source "$source" --argjson destination_dev "$destination_dev" \
        --argjson destination_ino "$destination_ino" '
        [.entries[] | select(.source == $source and .state == "archived" and
          .destination_dev == $destination_dev and .destination_ino == $destination_ino)] |
        length == 1' \
        "$ARCHIVE_MANIFEST" >/dev/null; then return 0; fi
    previous_identity="$(capture_archive_manifest_predecessor)" || return 1
    read -r previous previous_dev previous_ino <<< "$previous_identity"
    generation="$(jq -er '.generation + 1' "$ARCHIVE_MANIFEST")"
    jq --arg source "$source" --arg previous "$previous" \
        --argjson previous_dev "$previous_dev" --argjson previous_ino "$previous_ino" \
        --argjson generation "$generation" \
        --argjson destination_dev "$destination_dev" --argjson destination_ino "$destination_ino" '
        if ([.entries[] | select(.source == $source and
          (.state == "quiescent" or .state == "copied") and
          (.final_sha256 | test("^[a-f0-9]{64}$")) and
          (.final_size | type == "number" and . >= 0))] | length) != 1 then error("entry")
        else .entries |= map(if .source == $source then
          . + {destination_dev:$destination_dev,destination_ino:$destination_ino,state:"archived"}
          else . end) end |
        .generation = $generation | .previous_manifest_sha256 = $previous |
        .previous_manifest_dev = $previous_dev | .previous_manifest_ino = $previous_ino' \
        "$ARCHIVE_MANIFEST" > "$ARCHIVE_MANIFEST_TMP" || return 1
    publish_archive_manifest_tmp
}

normalize_exact_file_metadata() {
    local path=$1 expected_sha256=$2 expected_size=$3 expected_dev=$4 expected_ino=$5
    local source_uid=$6 source_gid=$7 source_mode=$8
    python3 - "$path" "$expected_sha256" "$expected_size" "$expected_dev" "$expected_ino" \
        "$source_uid" "$source_gid" "$source_mode" <<'PY'
import hashlib
import os
import stat
import sys

path, expected_sha256, expected_size, expected_dev, expected_ino, uid, gid, mode = sys.argv[1:]
expected_size, expected_dev, expected_ino = int(expected_size), int(expected_dev), int(expected_ino)
uid, gid, mode = int(uid), int(gid), int(mode, 8)
descriptor = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
try:
    before = os.fstat(descriptor)
    current = os.lstat(path)
    if not stat.S_ISREG(before.st_mode) or not stat.S_ISREG(current.st_mode):
        raise RuntimeError("archive source is not regular")
    if (before.st_dev, before.st_ino) != (expected_dev, expected_ino) or (
        current.st_dev, current.st_ino
    ) != (expected_dev, expected_ino):
        raise RuntimeError("archive source identity drift")
    if (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode), before.st_size) not in (
        (uid, gid, mode, expected_size), (0, 0, 0o600, expected_size)
    ):
        raise RuntimeError("archive source metadata drift")
    os.lseek(descriptor, 0, os.SEEK_SET)
    with os.fdopen(os.dup(descriptor), "rb", buffering=0) as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != expected_sha256:
            raise RuntimeError("archive source content drift")
    os.fchown(descriptor, 0, 0)
    os.fchmod(descriptor, 0o600)
    os.fsync(descriptor)
    after = os.fstat(descriptor)
    current = os.lstat(path)
    if (after.st_dev, after.st_ino, after.st_size) != (expected_dev, expected_ino, expected_size):
        raise RuntimeError("archive source identity changed")
    if (current.st_dev, current.st_ino) != (expected_dev, expected_ino):
        raise RuntimeError("archive source pathname changed")
    if (after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode)) != (0, 0, 0o600):
        raise RuntimeError("archive source normalization failed")
finally:
    os.close(descriptor)
PY
}

archive_manifest_destinations_are_complete() {
    local manifest=$1 operation_id=$2
    python3 - "$manifest" "$operation_id" <<'PY'
import json
import os
import re
import sys

manifest_path, operation_id = sys.argv[1:]
with open(manifest_path, encoding="utf-8") as source:
    manifest = json.load(source)
audit_dir = os.path.dirname(manifest_path)
canonical = re.compile(r"^aifeeds-performance[.]jsonl(?:[.][0-9]+(?:[.]gz)?)?$")
expected = {entry["destination"] for entry in manifest["entries"]}
actual = {
    os.path.join(audit_dir, name)
    for name in os.listdir(audit_dir)
    if canonical.fullmatch(name)
}
if actual != expected:
    raise SystemExit(1)
if any(".candidate-gl-a-" in name for name in os.listdir(audit_dir)):
    raise SystemExit(1)
log_dir = "/var/log/nginx"
if os.path.isdir(log_dir):
    for name in os.listdir(log_dir):
        if canonical.fullmatch(name) or name.endswith(".quarantine-gl-a-" + operation_id):
            raise SystemExit(1)
PY
}

archive_manifest_is_terminal() {
    local manifest=${1:-$ARCHIVE_MANIFEST}
    local operation_id=${2:-$ARCHIVE_OPERATION_ID}
    local manifest_tmp="${manifest}.tmp"
    local manifest_previous="${manifest}.previous-gl-a-${operation_id}"
    local source quarantine destination candidate final_sha256 final_size state
    local destination_dev destination_ino
    archive_manifest_is_owned "$manifest" "$operation_id" || return 1
    test ! -e "$manifest_tmp" || return 1
    test ! -L "$manifest_tmp" || return 1
    test ! -e "$manifest_previous" || return 1
    test ! -L "$manifest_previous" || return 1
    jq -e '
        .inventory_complete == true and
        .generation == (3 * (.entries | length) + 1 +
          ([.entries[] | select(has("candidate_dev"))] | length)) and
        (((.entries | length) > 0) or .empty_inventory == true) and
        all(.entries[]; .state == "archived" and
          (.final_sha256 | test("^[a-f0-9]{64}$")) and
          (.final_size | type == "number" and . >= 0) and
          (.destination_dev | type == "number" and . > 0) and
          (.destination_ino | type == "number" and . > 0))' \
        "$manifest" >/dev/null || return 1
    prepare_private_inventory_file "$FIND_MANIFEST_TERMINAL_INVENTORY" || return 1
    jq -r '.entries[] | [.source,.quarantine,.destination,.candidate,
        .final_sha256,(.final_size|tostring),.state,
        (.destination_dev|tostring),(.destination_ino|tostring)] | @tsv' "$manifest" \
        > "$FIND_MANIFEST_TERMINAL_INVENTORY" || return 1
    while IFS=$'\t' read -r source quarantine destination candidate final_sha256 final_size state \
        destination_dev destination_ino; do
        test "$state" = archived || return 1
        test ! -e "$source" || return 1
        test ! -L "$source" || return 1
        test ! -e "$quarantine" || return 1
        test ! -L "$quarantine" || return 1
        test ! -e "$candidate" || return 1
        test ! -L "$candidate" || return 1
        test -f "$destination" || return 1
        test ! -L "$destination" || return 1
        test "$(stat -c '%u %g %a' "$destination")" = '0 0 600' || return 1
        test "$(sha256sum "$destination" | awk '{print $1}')" = "$final_sha256" || return 1
        test "$(stat -c '%s' "$destination")" = "$final_size" || return 1
        test "$(stat -c '%d %i' "$destination")" = "$destination_dev $destination_ino" \
            || return 1
    done < "$FIND_MANIFEST_TERMINAL_INVENTORY"
    rm -f "$FIND_MANIFEST_TERMINAL_INVENTORY"
    archive_manifest_destinations_are_complete "$manifest" "$operation_id"
}

ensure_empty_terminal_archive_manifest() {
    ensure_audit_dir_owned || return 1
    ensure_archive_manifest || return 1
    archive_manifest_is_owned "$ARCHIVE_MANIFEST" || return 1
    jq -e '.entries == []' "$ARCHIVE_MANIFEST" >/dev/null || return 1
    if ! jq -e '.inventory_complete == true and .empty_inventory == true' \
        "$ARCHIVE_MANIFEST" >/dev/null; then
        jq -e '.inventory_complete == false and .empty_inventory == false and .generation == 0' \
            "$ARCHIVE_MANIFEST" >/dev/null || return 1
        record_log_archive_inventory_complete || return 1
    fi
    archive_manifest_is_terminal || return 1
    jq -e '.schema == 2 and .generation == 1 and .entries == [] and
        .inventory_complete == true and .empty_inventory == true' \
        "$ARCHIVE_MANIFEST" >/dev/null
}

write_manifest_entries_inventory() {
    prepare_private_inventory_file "$FIND_MANIFEST_ENTRIES_INVENTORY" || return 1
    if ! jq -r '.entries[] | [.source,.quarantine,.destination,.candidate,
        (.dev|tostring),(.ino|tostring),(.uid|tostring),(.gid|tostring),.mode,.state,
        ((.candidate_dev // "-")|tostring),((.candidate_ino // "-")|tostring),
        ((.destination_dev // "-")|tostring),((.destination_ino // "-")|tostring)] | @tsv' "$ARCHIVE_MANIFEST" \
        > "$FIND_MANIFEST_ENTRIES_INVENTORY"; then
        return 1
    fi
}

rollback_on_failure() {
    local rc=$?
    trap - EXIT
    trap '' HUP INT TERM
    set +e
    if [ "$SUCCESS" -ne 1 ]; then
        rm -f "$SUMMARY_TMP" "$SUMMARY"
    fi
    if [ -e "$SITE_BUILD_CANDIDATE" ] || [ -L "$SITE_BUILD_CANDIDATE" ]; then
        if [ -f "$SITE_BUILD_CANDIDATE" ] && [ ! -L "$SITE_BUILD_CANDIDATE" ]; then
            rm -f "$SITE_BUILD_CANDIDATE"
        fi
    fi
    if [ "$SUCCESS" -ne 1 ] && [ "$MUTATED" -eq 1 ]; then
        SOURCE_JOURNAL_DELEGATE_SHA256=''
        if settle_journal_update "$JOURNAL" "$JOURNAL_PREVIOUS_UPDATE" source ""; then
            SOURCE_JOURNAL_DELEGATE_SHA256="$(sha256sum "$JOURNAL" | awk '{print $1}')"
        fi
        if ! printf '%s' "$SOURCE_JOURNAL_DELEGATE_SHA256" | grep -Eq '^[a-f0-9]{64}$'; then
            printf 'automatic_rollback=failed backup=%s reason=source_journal_settle\n' "$BACKUP"
            exit "$rc"
        fi
        if ! flock -u 9; then
            printf 'automatic_rollback=failed backup=%s reason=lock_handoff\n' "$BACKUP"
            exit "$rc"
        fi
        exec 9>&-
        if /bin/bash "$STAGING/rollback-aifeeds-performance-log.sh" \
            "$STAGING" "$BACKUP" "$SITE_BACKUP_SHA256" \
            "$EXPECTED_INSTALLED_SITE_SHA256" "$SITE_UID" "$SITE_GID" "$SITE_MODE" \
            "$JOURNAL" "$SOURCE_JOURNAL_DELEGATE_SHA256"; then
            printf 'automatic_rollback=pass backup=%s delegated=1\n' "$BACKUP"
        else
            printf 'automatic_rollback=failed backup=%s reason=delegated_helper\n' "$BACKUP"
        fi
        exit "$rc"
    fi
    if [ "$SUCCESS" -ne 1 ] && [ "$MUTATED" -eq 0 ] && [ "$JOURNAL_CREATED" -eq 1 ]; then
        pre_live_ok=1
        assert_enabled_site_target || pre_live_ok=0
        if ! formal_site_matches_state "$SITE" base; then
            pre_live_ok=0
        fi
        for pre_live_path in "$FORMAT" "$ROTATE" "$LOG" "$CHECKER" "$DIFF_CHECKER" "$INSERTER" \
            "$SERVICE_PATH" "$TIMER_PATH" "$ROTATE_STATE_DIR" "$ROTATE_STATE_DIR_CANDIDATE" "$ROLLBACK_CANDIDATE" \
            "$FORMAT_CANDIDATE" "$ROTATE_CANDIDATE" "$LOG_CANDIDATE" \
            "$CHECKER_CANDIDATE" "$DIFF_CHECKER_CANDIDATE" "$INSERTER_CANDIDATE" \
            "$SERVICE_CANDIDATE" "$TIMER_CANDIDATE"; do
            if [ -e "$pre_live_path" ] || [ -L "$pre_live_path" ]; then pre_live_ok=0; fi
        done
        if [ -e "$BACKUP" ] || [ -L "$BACKUP" ]; then
            if [ ! -f "$BACKUP" ] || [ -L "$BACKUP" ] \
                || [ "$(sha256sum "$BACKUP" | awk '{print $1}')" != "$SITE_BACKUP_SHA256" ] \
                || [ "$(stat -c '%u' "$BACKUP")" != "$SITE_UID" ] \
                || [ "$(stat -c '%g' "$BACKUP")" != "$SITE_GID" ] \
                || [ "$(stat -c '%a' "$BACKUP")" != "$SITE_MODE" ] \
                || [ "$SITE_BACKUP_IDENTITY_JSON" = null ] \
                || [ "$(stat -c '%d %i' "$BACKUP")" != \
                    "$(jq -r '[.dev,.ino] | map(tostring) | join(" ")' \
                        <<< "$SITE_BACKUP_IDENTITY_JSON")" ]; then
                pre_live_ok=0
            fi
        fi
        if [ -e "$CANDIDATE" ] || [ -L "$CANDIDATE" ]; then
            if ! formal_site_matches_state "$CANDIDATE" installed; then
                pre_live_ok=0
            fi
        fi
        if [ "$pre_live_ok" -eq 1 ] && { [ -e "$CANDIDATE" ] || [ -L "$CANDIDATE" ]; }; then
            persist_installer_candidate_identity || pre_live_ok=0
        fi
        if [ "$pre_live_ok" -eq 1 ]; then
            ensure_empty_terminal_archive_manifest || pre_live_ok=0
        fi
        if [ "$pre_live_ok" -eq 1 ] && { [ -e "$CANDIDATE" ] || [ -L "$CANDIDATE" ]; }; then
            if [ "$pre_live_ok" -eq 1 ]; then
                private_cleanup_tombstone "$CANDIDATE" "$EXPECTED_INSTALLED_SITE_SHA256" \
                    "$SITE_UID" "$SITE_GID" "$SITE_MODE" \
                    "$INSTALLER_CANDIDATE_DEV" "$INSTALLER_CANDIDATE_INO" 5 || pre_live_ok=0
            fi
        fi
        if [ "$pre_live_ok" -eq 1 ]; then
            write_journal rolled_back || pre_live_ok=0
        fi
        if [ "$pre_live_ok" -eq 1 ]; then
            printf 'automatic_rollback=pass backup=%s pre_live=1\n' "$BACKUP"
        else
            write_journal rollback_failed >/dev/null 2>&1 || true
            printf 'automatic_rollback=failed backup=%s reason=pre_live_drift\n' "$BACKUP"
        fi
    fi
    exit "$rc"
}

trap rollback_on_failure EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# A retry with the same operation id must be routed to recovery before live
# runtime absence checks.  Those checks intentionally fail closed, but a bare
# rc=1 hides the durable journal that explains how to resume safely.
if [ -e "$BACKUP_DIR" ] || [ -L "$BACKUP_DIR" ]; then
    test -d "$BACKUP_DIR"
    test ! -L "$BACKUP_DIR"
    test "$(stat -c '%U %G %a' "$BACKUP_DIR")" = 'root root 700'
    write_find_inventory "$FIND_JOURNAL_INVENTORY" "$BACKUP_DIR" -maxdepth 1 \
        \( -name "transaction-${OPERATION_ID}.json*" \
           -o -name "rollback-transaction-${OPERATION_ID}.json*" \
           -o -name "rollback-commit-${OPERATION_ID}.json*" \)
    if [ -s "$FIND_JOURNAL_INVENTORY" ]; then
        while IFS= read -r -d '' existing_operation_journal; do
            printf 'ERROR recovery_required=1 journal=%s phase=pending\n' \
                "$existing_operation_journal"
            break
        done < "$FIND_JOURNAL_INVENTORY"
        exit 76
    fi
    rm -f "$FIND_JOURNAL_INVENTORY"
fi

if [ ! -f "$ROTATION_LOGROTATE" ] || [ -L "$ROTATION_LOGROTATE" ] \
    || [ ! -s "$ROTATION_LOGROTATE" ] \
    || [ "$(stat -c '%U %G %a' "$ROTATION_LOGROTATE" 2>/dev/null || true)" != \
        'root root 755' ]; then
    printf 'ERROR dependency=logrotate path=%s\n' "$ROTATION_LOGROTATE"
    exit 69
fi

settle_journal_update "$JOURNAL" "$JOURNAL_PREVIOUS_UPDATE" source ""

test -f "$SITE"
test ! -L "$SITE"
assert_enabled_site_target
SITE_UID="$(stat -c '%u' "$SITE")"
SITE_GID="$(stat -c '%g' "$SITE")"
SITE_MODE="$(stat -c '%a' "$SITE")"
printf '%s' "$SITE_UID" | grep -Eq '^[0-9]+$'
printf '%s' "$SITE_GID" | grep -Eq '^[0-9]+$'
printf '%s' "$SITE_MODE" | grep -Eq '^[0-7]{3,4}$'
test "$(curl_status https://ai-feeds.com/)" = 200
test "$(curl_status 'https://api.ai-feeds.com/api/items?source_type=x_list&limit=1')" = 200
systemctl is-active --quiet nginx
nginx -t >/dev/null
AVAILABLE_KIB="$(df -Pk /var/log/nginx | awk 'NR == 2 {print $4}')"
AVAILABLE_INODES="$(df -Pi /var/log/nginx | awk 'NR == 2 {print $4}')"
printf '%s' "$AVAILABLE_KIB" | grep -Eq '^[0-9]+$'
printf '%s' "$AVAILABLE_INODES" | grep -Eq '^[0-9]+$'
test "$AVAILABLE_KIB" -ge 5242880
test "$AVAILABLE_INODES" -ge 100000

for path in \
    "$FORMAT" "$ROTATE" "$LOG" "$CHECKER" "$DIFF_CHECKER" "$INSERTER" \
    "$SERVICE_PATH" "$TIMER_PATH" "$ROTATE_STATE_DIR" "$ROTATE_STATE_DIR_CANDIDATE" \
    "$FORMAT_CANDIDATE" "$ROTATE_CANDIDATE" "$LOG_CANDIDATE" \
    "$CHECKER_CANDIDATE" "$DIFF_CHECKER_CANDIDATE" "$INSERTER_CANDIDATE" \
    "$SERVICE_CANDIDATE" "$TIMER_CANDIDATE"; do
    test ! -e "$path"
    test ! -L "$path"
done
no_performance_logs_present

for file in \
    aifeeds-performance-log.conf \
    aifeeds-performance.logrotate \
    aifeeds-performance-logrotate.service \
    aifeeds-performance-logrotate.timer \
    check-nginx-request-id.py \
    verify-nginx-request-id-diff.py \
    insert-nginx-request-id.py \
    rollback-aifeeds-performance-log.sh \
    SHA256SUMS; do
    test -f "$STAGING/$file"
    test ! -L "$STAGING/$file"
done

cd "$STAGING"
sha256sum -c SHA256SUMS
cd /
ROLLBACK_HELPER_SHA256="$(sha256sum "$STAGING/rollback-aifeeds-performance-log.sh" | awk '{print $1}')"
printf '%s' "$ROLLBACK_HELPER_SHA256" | grep -Eq '^[a-f0-9]{64}$'
FORMAT_SHA256="$(sha256sum "$STAGING/aifeeds-performance-log.conf" | awk '{print $1}')"
ROTATE_SHA256="$(sha256sum "$STAGING/aifeeds-performance.logrotate" | awk '{print $1}')"
CHECKER_SHA256="$(sha256sum "$STAGING/check-nginx-request-id.py" | awk '{print $1}')"
DIFF_CHECKER_SHA256="$(sha256sum "$STAGING/verify-nginx-request-id-diff.py" | awk '{print $1}')"
INSERTER_SHA256="$(sha256sum "$STAGING/insert-nginx-request-id.py" | awk '{print $1}')"
SERVICE_SHA256="$(sha256sum "$STAGING/aifeeds-performance-logrotate.service" | awk '{print $1}')"
TIMER_SHA256="$(sha256sum "$STAGING/aifeeds-performance-logrotate.timer" | awk '{print $1}')"
ARTIFACTS_SHA256_JSON="$(jq -nc \
    --arg format "$FORMAT_SHA256" --arg rotate "$ROTATE_SHA256" \
    --arg checker "$CHECKER_SHA256" --arg diff_checker "$DIFF_CHECKER_SHA256" \
    --arg inserter "$INSERTER_SHA256" --arg service "$SERVICE_SHA256" --arg timer "$TIMER_SHA256" \
    '{format:$format,rotate:$rotate,checker:$checker,diff_checker:$diff_checker,
      inserter:$inserter,service:$service,timer:$timer}')"
jq -e 'keys == ["checker","diff_checker","format","inserter","rotate","service","timer"] and
    all(.[]; type == "string" and test("^[a-f0-9]{64}$"))' \
    <<< "$ARTIFACTS_SHA256_JSON" >/dev/null
ARTIFACT_CANDIDATES_JSON="$(jq -nc \
    --arg format "$FORMAT_CANDIDATE" --arg rotate "$ROTATE_CANDIDATE" \
    --arg log "$LOG_CANDIDATE" --arg checker "$CHECKER_CANDIDATE" \
    --arg diff_checker "$DIFF_CHECKER_CANDIDATE" --arg inserter "$INSERTER_CANDIDATE" \
    --arg service "$SERVICE_CANDIDATE" --arg timer "$TIMER_CANDIDATE" \
    '{format:$format,rotate:$rotate,log:$log,checker:$checker,diff_checker:$diff_checker,
      inserter:$inserter,service:$service,timer:$timer}')"
jq -e 'keys == ["checker","diff_checker","format","inserter","log","rotate","service","timer"] and
    all(.[]; type == "string" and test("[.]candidate-gl-a-[0-9]{14}-[a-f0-9]{8}$"))' \
    <<< "$ARTIFACT_CANDIDATES_JSON" >/dev/null

test "$(strict_grep_count '^[[:space:]]*access_log[[:space:]]' "$SITE")" = 0
test "$(strict_grep_count '^[[:space:]]*include[[:space:]]' "$SITE")" = 4
test "$(strict_grep_count '^[[:space:]]*access_log[[:space:]]' "$ALLOWED_INCLUDE")" = 0
test "$(strict_grep_count '^[[:space:]]*proxy_pass[[:space:]]' "$ALLOWED_INCLUDE")" = 0
test "$(strict_grep_count '^[[:space:]]*proxy_set_header[[:space:]]+x-request-id[[:space:]]' "$ALLOWED_INCLUDE")" = 0
test "$(strict_grep_count '^[[:space:]]*include[[:space:]]' "$ALLOWED_INCLUDE")" = 0

if [ -e "$BACKUP_DIR" ] || [ -L "$BACKUP_DIR" ]; then
    test -d "$BACKUP_DIR"
    test ! -L "$BACKUP_DIR"
    test "$(stat -c '%U %G %a' "$BACKUP_DIR")" = 'root root 700'
else
    install -d -o root -g root -m 0700 "$BACKUP_DIR"
fi

journal_metadata_is_private() {
    local path=$1
    test -f "$path"
    test ! -L "$path"
    test "$(stat -c '%U %G %a' "$path")" = 'root root 600'
}

validate_terminal_pair_commit_marker() {
    local path=$1
    local basename="${path##*/}"
    local transaction_id="${basename#rollback-commit-}"
    local source_path
    local rollback_path
    local archive_manifest
    local archive_sha256
    local archive_generation
    local archive_entry_count
    local authority_envelope
    local saved_journal_operation_id
    transaction_id="${transaction_id%.json}"
    printf '%s' "$transaction_id" | grep -Eq '^[0-9]{14}-[a-f0-9]{8}$' || return 1
    test "$path" = "${BACKUP_DIR}/rollback-commit-${transaction_id}.json" || return 1
    source_path="${BACKUP_DIR}/transaction-${transaction_id}.json"
    rollback_path="${BACKUP_DIR}/rollback-transaction-${transaction_id}.json"
    journal_metadata_is_private "$path" || return 1
    journal_metadata_is_private "$source_path" || return 1
    journal_metadata_is_private "$rollback_path" || return 1
    jq -e --arg operation_id "$transaction_id" --arg self "$path" \
        --arg source "$source_path" --arg rollback "$rollback_path" '
        .schema == 1 and .gate == "GL-a-terminal-pair" and .phase == "committed" and
        .operation_id == $operation_id and .rollback_commit_marker == $self and
        .source_journal == $source and .rollback_journal == $rollback and
        (keys | sort) ==
          ["gate","operation_id","phase","prepared_marker_sha256",
           "rollback_before_authority","rollback_before_sha256","rollback_commit_marker",
           "rollback_journal","rollback_journal_terminal_sha256","rollback_target_sha256",
           "schema","source_before_authority","source_before_sha256","source_journal",
           "source_journal_terminal_sha256","source_target_sha256"] and
        all(.source_before_authority,.rollback_before_authority;
          (keys | sort) == ["dev","ino","raw_base64","sha256"] and
          (.dev | type == "number" and . > 0 and . == floor) and
          (.ino | type == "number" and . > 0 and . == floor) and
          (.raw_base64 | type == "string" and length > 0) and
          (.sha256 | type == "string" and test("^[a-f0-9]{64}$"))) and
        .source_before_authority.sha256 == .source_before_sha256 and
        .rollback_before_authority.sha256 == .rollback_before_sha256 and
        (.source_before_sha256 | test("^[a-f0-9]{64}$")) and
        (.rollback_before_sha256 | test("^[a-f0-9]{64}$")) and
        (.source_target_sha256 | test("^[a-f0-9]{64}$")) and
        (.rollback_target_sha256 | test("^[a-f0-9]{64}$")) and
        (.prepared_marker_sha256 | test("^[a-f0-9]{64}$")) and
        (.source_journal_terminal_sha256 | test("^[a-f0-9]{64}$")) and
        (.rollback_journal_terminal_sha256 | test("^[a-f0-9]{64}$"))' \
        "$path" >/dev/null || return 1
    test "$(jq -er '.source_journal_terminal_sha256' "$path")" = \
        "$(sha256sum "$source_path" | awk '{print $1}')" || return 1
    test "$(jq -er '.rollback_journal_terminal_sha256' "$path")" = \
        "$(sha256sum "$rollback_path" | awk '{print $1}')" || return 1
    test "$(jq -er '.source_target_sha256' "$path")" = \
        "$(sha256sum "$source_path" | awk '{print $1}')" || return 1
    test "$(jq -er '.rollback_target_sha256' "$path")" = \
        "$(sha256sum "$rollback_path" | awk '{print $1}')" || return 1
    authority_envelope="$(jq -nc --arg marker "$path" --arg source_target "$source_path" \
        --arg rollback_target "$rollback_path" \
        '{marker:$marker,source_target:$source_target,rollback_target:$rollback_target}')" \
        || return 1
    saved_journal_operation_id=$JOURNAL_OPERATION_ID
    JOURNAL_OPERATION_ID=$transaction_id
    if ! journal_update_cas "$source_path" \
        "${source_path}.previous-update-gl-a-${transaction_id}" source rolled_back \
        "$(jq -er '.source_before_sha256' "$path")" "$authority_envelope" \
        validate-authority-successor; then
        JOURNAL_OPERATION_ID=$saved_journal_operation_id
        return 1
    fi
    if ! journal_update_cas "$rollback_path" \
        "${rollback_path}.previous-update-gl-a-${transaction_id}" rollback rolled_back \
        "" "$authority_envelope" validate-authority-successor; then
        JOURNAL_OPERATION_ID=$saved_journal_operation_id
        return 1
    fi
    JOURNAL_OPERATION_ID=$saved_journal_operation_id
    jq -e --arg marker "$path" --arg rollback "$rollback_path" '
        .phase == "rolled_back" and .rollback_commit_marker == $marker and
        .rollback_journal == $rollback' "$source_path" >/dev/null || return 1
    jq -e --arg marker "$path" --arg source_sha "$(sha256sum "$source_path" | awk '{print $1}')" '
        .phase == "rolled_back" and .rollback_commit_marker == $marker and
        .source_journal_terminal_sha256 == $source_sha' "$rollback_path" >/dev/null
    archive_manifest="$(jq -er '.log_archive_manifest' "$source_path")" || return 1
    test "$archive_manifest" = "$(jq -er '.log_archive_manifest' "$rollback_path")" || return 1
    archive_manifest_is_terminal "$archive_manifest" "$transaction_id" || return 1
    archive_sha256="$(sha256sum "$archive_manifest" | awk '{print $1}')" || return 1
    archive_generation="$(jq -er '.generation' "$archive_manifest")" || return 1
    archive_entry_count="$(jq -er '.entries | length' "$archive_manifest")" || return 1
    for journal_path in "$source_path" "$rollback_path"; do
        test "$(jq -er '.log_archive_manifest_sha256' "$journal_path")" = \
            "$archive_sha256" || return 1
        test "$(jq -er '.log_archive_manifest_generation' "$journal_path")" = \
            "$archive_generation" || return 1
        test "$(jq -er '.log_archive_manifest_entry_count' "$journal_path")" = \
            "$archive_entry_count" || return 1
    done
}

terminal_runtime_inventory_is_valid() {
    local source_path=$1
    jq -e '
        (.runtime_artifacts_sealed | type == "boolean") and
        (.runtime_artifacts | type == "array") and
        (if .runtime_artifacts_sealed then .runtime_artifacts | length == 8
         else .runtime_artifacts | length <= 8 end) and
        ([.runtime_artifacts[].name] | length == (unique | length)) and
        ([.runtime_artifacts[].final] | length == (unique | length)) and
        ([.runtime_artifacts[].candidate] | length == (unique | length)) and
        all(.runtime_artifacts[];
          (.name == "format" or .name == "log" or .name == "checker" or
           .name == "diff_checker" or .name == "inserter" or .name == "rotate" or
           .name == "service" or .name == "timer") and
          (keys | sort) == ["candidate","dev","final","gid","ino","mode","name","sha256","uid"] and
          (.sha256 | test("^[a-f0-9]{64}$")) and
          (.mode | test("^[0-7]{3,4}$")) and
          (.uid | type == "number") and (.gid | type == "number") and
          (.dev | type == "number" and . > 0 and . == floor) and
          (.ino | type == "number" and . > 0 and . == floor))
    ' "$source_path" >/dev/null
}

terminal_formal_site_matches_state() {
    local source_path=$1 state=$2
    (
        SITE_BASE_SHA256="$(jq -er '.site_backup_sha256' "$source_path")" || exit 1
        EXPECTED_INSTALLED_SITE_SHA256="$(jq -er '.installed_site_sha256' "$source_path")" || exit 1
        SITE_UID="$(jq -er '.original_site_uid' "$source_path")" || exit 1
        SITE_GID="$(jq -er '.original_site_gid' "$source_path")" || exit 1
        SITE_MODE="$(jq -er '.original_site_mode' "$source_path")" || exit 1
        SITE_BASE_DEV="$(jq -er '.original_site_dev' "$source_path")" || exit 1
        SITE_BASE_INO="$(jq -er '.original_site_ino' "$source_path")" || exit 1
        INSTALLER_CANDIDATE_DEV="$(jq -r '.installer_candidate_dev // ""' "$source_path")" || exit 1
        INSTALLER_CANDIDATE_INO="$(jq -r '.installer_candidate_ino // ""' "$source_path")" || exit 1
        ROLLBACK_CANDIDATE_DEV="$(jq -r '.rollback_candidate_dev // ""' "$source_path")" || exit 1
        ROLLBACK_CANDIDATE_INO="$(jq -r '.rollback_candidate_ino // ""' "$source_path")" || exit 1
        formal_site_matches_state "$SITE" "$state"
    )
}

terminal_rotation_state_is_committed_exact() {
    local source_path=$1 identity directory provenance snapshot operation_id state_path
    identity="$(jq -cS '.rotation_state_identity' "$source_path")" || return 1
    test "$identity" != null || return 1
    directory="$(jq -cer '.directory' <<< "$identity")" || return 1
    test -d "$ROTATE_STATE_DIR" && test ! -L "$ROTATE_STATE_DIR" || return 1
    test "$(stat -c '%u %g %a %d %i' "$ROTATE_STATE_DIR")" = \
        "$(jq -r '[.uid,.gid,.mode,.dev,.ino] | map(tostring) | join(" ")' <<< "$directory")" \
        || return 1
    test ! -e "$ROTATE_STATE_DIR_CANDIDATE" && test ! -L "$ROTATE_STATE_DIR_CANDIDATE" \
        || return 1
    provenance="$(jq -cer '.provenance' <<< "$identity")" || return 1
    operation_id="$(jq -er '.operation_id' "$source_path")" || return 1
    snapshot="$(run_rotation_authorized_command rotation-verify "$operation_id" \
        "$(jq -cS '.rotation_anchor_identity' "$source_path")" \
        "$(jq -cS '.runtime_artifacts' "$source_path")")" || return 1
    test "$(jq -er '.ledger.dev' <<< "$snapshot")" = "$(jq -er '.dev' <<< "$provenance")" \
        || return 1
    test "$(jq -er '.ledger.ino' <<< "$snapshot")" = "$(jq -er '.ino' <<< "$provenance")" \
        || return 1
    write_find_inventory "$FIND_ROTATION_INVENTORY" "$ROTATE_STATE_DIR" \
        -mindepth 1 -maxdepth 1 || return 1
    while IFS= read -r -d '' state_path; do
        case "$state_path" in "$ROTATE_STATE"|"$ROTATE_PROVENANCE") ;; *) return 1 ;; esac
    done < "$FIND_ROTATION_INVENTORY"
    rm -f "$FIND_ROTATION_INVENTORY"
}

terminal_rotation_anchor_is_committed_exact() {
    local source_path=$1 operation_id identity
    operation_id="$(jq -er '.operation_id' "$source_path")" || return 1
    identity="$(jq -cS '.rotation_anchor_identity' "$source_path")" || return 1
    jq -e --arg path "${BACKUP_DIR}/rotation-anchor-${operation_id}.json" '
        (keys | sort) == ["dev","gid","ino","mode","path","sha256","size","state","uid"] and
        .state == "sealed" and .path == $path and
        (.sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
        (.size | type == "number" and . > 0 and . == floor) and
        .uid == 0 and .gid == 0 and .mode == "600" and
        (.dev | type == "number" and . > 0 and . == floor) and
        (.ino | type == "number" and . > 0 and . == floor)' \
        <<< "$identity" >/dev/null || return 1
    path_matches_exact_identity "$(jq -er '.path' <<< "$identity")" \
        "$(jq -er '.sha256' <<< "$identity")" 0 0 600 \
        "$(jq -er '.dev' <<< "$identity")" "$(jq -er '.ino' <<< "$identity")" || return 1
    test "$(stat -c '%s' "$(jq -er '.path' <<< "$identity")")" = \
        "$(jq -er '.size' <<< "$identity")"
}

runtime_artifacts_are_committed_exact() {
    local source_path=$1 entry name final candidate
    terminal_runtime_inventory_is_valid "$source_path" || return 1
    test "$(jq -er '.runtime_artifacts_sealed' "$source_path")" = true || return 1
    while IFS= read -r entry; do
        name="$(jq -er '.name' <<< "$entry")" || return 1
        final="$(jq -er '.final' <<< "$entry")" || return 1
        candidate="$(jq -er '.candidate' <<< "$entry")" || return 1
        test ! -e "$candidate" && test ! -L "$candidate" || return 1
        if [ "$name" = log ]; then
            # The live log is intentionally mutable; its pathname and metadata remain constrained.
            test -f "$final" && test ! -L "$final" || return 1
            test "$(stat -c '%u %g %a' "$final")" = \
                "$(jq -r '[.uid,.gid,.mode] | map(tostring) | join(" ")' <<< "$entry")" \
                || return 1
        else
            path_matches_exact_identity "$final" "$(jq -er '.sha256' <<< "$entry")" \
                "$(jq -er '.uid' <<< "$entry")" "$(jq -er '.gid' <<< "$entry")" \
                "$(jq -er '.mode' <<< "$entry")" "$(jq -er '.dev' <<< "$entry")" \
                "$(jq -er '.ino' <<< "$entry")" || return 1
        fi
    done < <(jq -c '.runtime_artifacts[]' "$source_path")
    terminal_rotation_anchor_is_committed_exact "$source_path" || return 1
    terminal_rotation_state_is_committed_exact "$source_path" || return 1
    terminal_formal_site_matches_state "$source_path" installed
}

runtime_artifacts_are_terminally_absent() {
    local source_path=$1 path
    terminal_runtime_inventory_is_valid "$source_path" || return 1
    for path in "$FORMAT" "$ROTATE" "$LOG" "$CHECKER" "$DIFF_CHECKER" "$INSERTER" \
        "$SERVICE_PATH" "$TIMER_PATH" "$ROTATE_STATE_DIR" "$ROTATE_STATE_DIR_CANDIDATE"; do
        test ! -e "$path" && test ! -L "$path" || return 1
    done
    path="$(jq -r '.rotation_anchor_identity.path // empty' "$source_path")" || return 1
    if [ -n "$path" ]; then
        test "$path" = "${BACKUP_DIR}/rotation-anchor-$(jq -er '.operation_id' "$source_path").json" \
            || return 1
        test ! -e "$path" && test ! -L "$path" || return 1
    fi
    while IFS= read -r path; do
        test ! -e "$path" && test ! -L "$path" || return 1
    done < <(jq -er '.artifact_candidates[]' "$source_path")
    no_performance_logs_present || return 1
    # A rolled-back journal proves the site state at that transaction's terminal
    # boundary.  It does not own SITE forever: a later deployment may validly
    # replace the live config.  The new operation validates SITE, its enabled
    # target, nginx -t, and the exact candidate diff before any mutation.
    return 0
}

assert_no_operation_cleanup_dirs_for_transaction() {
    local transaction_id=$1 audit_dir=$2
    python3 - "$transaction_id" "$BACKUP_DIR" "$audit_dir" \
        /var/log/nginx /etc/nginx/sites-available /etc/nginx/conf.d /etc \
        /usr/local/sbin /etc/systemd/system /var/lib "$ROTATE_STATE_DIR" <<'PY'
import os
import stat
import sys

transaction_id, *roots = sys.argv[1:]
prefix = f".cleanup-gl-a-{transaction_id}-"
for root in roots:
    try:
        entries = os.scandir(root)
    except FileNotFoundError:
        continue
    with entries:
        for entry in entries:
            if not entry.name.startswith(prefix):
                continue
            value = entry.stat(follow_symlinks=False)
            if stat.S_ISDIR(value.st_mode):
                raise SystemExit(f"terminal cleanup residue: {entry.path}")
            raise SystemExit(f"invalid cleanup residue: {entry.path}")
PY
}

validate_terminal_runtime_residue() {
    local source_path=$1
    local transaction_id=$2
    local phase
    local origin_phase
    local backup
    local backup_required=1
    local expected_backup_sha256
    local expected_uid
    local expected_gid
    local expected_mode
    local backup_identity
    local expected_backup_dev
    local expected_backup_ino
    local candidate_path
    local audit_dir
    local audit_path
    local audit_name
    local rollback_evidence
    local partial_sha='' partial_dev='' partial_ino='' partial_field_count=0
    local partial_audit partial_evidence_state=absent
    phase="$(jq -er '.phase' "$source_path")" || return 1
    case "$phase" in
        committed) runtime_artifacts_are_committed_exact "$source_path" || return 1 ;;
        rolled_back) runtime_artifacts_are_terminally_absent "$source_path" || return 1 ;;
        *) return 1 ;;
    esac
    origin_phase="$phase"
    if [ "$phase" = rolled_back ]; then
        origin_phase="$(jq -er '.rollback_origin_phase' "$source_path")" || return 1
        case "$origin_phase" in initializing|prepared) backup_required=0 ;; esac
    fi
    backup="$(jq -er '.site_backup' "$source_path")" || return 1
    expected_backup_sha256="$(jq -er '.site_backup_sha256' "$source_path")" || return 1
    expected_uid="$(jq -er '.original_site_uid' "$source_path")" || return 1
    expected_gid="$(jq -er '.original_site_gid' "$source_path")" || return 1
    expected_mode="$(jq -er '.original_site_mode' "$source_path")" || return 1
    backup_identity="$(jq -cS '.site_backup_identity // null' "$source_path")" || return 1
    audit_dir="$(jq -er '.audit_dir' "$source_path")" || return 1
    partial_audit="${audit_dir}/incomplete-site-backup"
    rollback_evidence="$(jq -r '.rollback_journal // ""' "$source_path")" || return 1
    if [ -n "$rollback_evidence" ]; then
        journal_metadata_is_private "$rollback_evidence" || return 1
        partial_field_count="$(jq '[has("partial_backup_sha256"),has("partial_backup_dev"),
            has("partial_backup_ino")] | map(select(.)) | length' "$rollback_evidence")" \
            || return 1
        case "$partial_field_count" in
            0) ;;
            3)
                partial_sha="$(jq -er '.partial_backup_sha256' "$rollback_evidence")" || return 1
                partial_dev="$(jq -er '.partial_backup_dev' "$rollback_evidence")" || return 1
                partial_ino="$(jq -er '.partial_backup_ino' "$rollback_evidence")" || return 1
                partial_evidence_state=archived
                ;;
            *) return 1 ;;
        esac
    fi
    if [ "$backup_identity" != null ]; then
        test "$partial_evidence_state" = absent || return 1
        test -f "$backup" && test ! -L "$backup" || return 1
        test "$(jq -er '.path' <<< "$backup_identity")" = "$backup" || return 1
        test "$(jq -er '.sha256' <<< "$backup_identity")" = "$expected_backup_sha256" || return 1
        expected_backup_dev="$(jq -er '.dev' <<< "$backup_identity")" || return 1
        expected_backup_ino="$(jq -er '.ino' <<< "$backup_identity")" || return 1
        test "$(sha256sum "$backup" | awk '{print $1}')" = "$expected_backup_sha256" || return 1
        test "$(stat -c '%u %g %a' "$backup")" = \
            "$expected_uid $expected_gid $expected_mode" || return 1
        test "$(stat -c '%d %i' "$backup")" = \
            "$expected_backup_dev $expected_backup_ino" || return 1
    else
        test "$backup_required" -eq 0 || return 1
        test ! -e "$backup" && test ! -L "$backup" || return 1
        case "$partial_evidence_state" in
            absent)
                test ! -e "$partial_audit" && test ! -L "$partial_audit" || return 1
                ;;
            archived)
                path_matches_exact_identity "$partial_audit" "$partial_sha" 0 0 600 \
                    "$partial_dev" "$partial_ino" || return 1
                ;;
            *) return 1 ;;
        esac
    fi
    for candidate_path in \
        "$(jq -er '.installer_candidate' "$source_path")" \
        "$(jq -er '.rollback_candidate' "$source_path")"; do
        test ! -e "$candidate_path" || return 1
        test ! -L "$candidate_path" || return 1
    done
    while IFS= read -r candidate_path; do
        test ! -e "$candidate_path" || return 1
        test ! -L "$candidate_path" || return 1
    done < <(jq -er '.artifact_candidates[]' "$source_path")
    if [ -e "$audit_dir" ] || [ -L "$audit_dir" ]; then
        test -d "$audit_dir" || return 1
        test ! -L "$audit_dir" || return 1
        test "$(stat -c '%U %G %a' "$audit_dir")" = 'root root 700' || return 1
        write_find_inventory "$FIND_TERMINAL_AUDIT_INVENTORY" "$audit_dir" \
            -mindepth 1 -maxdepth 1 || return 1
        while IFS= read -r -d '' audit_path; do
            test -f "$audit_path" || return 1
            test ! -L "$audit_path" || return 1
            test "$(stat -c '%U %G %a' "$audit_path")" = 'root root 600' || return 1
            audit_name="${audit_path##*/}"
            if [ "$audit_name" = incomplete-site-backup ]; then
                case "$origin_phase" in initializing|prepared) ;; *) return 1 ;; esac
                test "$partial_evidence_state" = archived || return 1
                path_matches_exact_identity "$audit_path" "$partial_sha" 0 0 600 \
                    "$partial_dev" "$partial_ino" || return 1
            elif [ "$audit_name" = archive-manifest.json ]; then
                archive_manifest_is_terminal "$audit_path" "$transaction_id" || return 1
            else
                printf '%s' "$audit_name" \
                    | grep -Eq '^aifeeds-performance[.]jsonl([.][0-9]+([.]gz)?)?$' || return 1
            fi
        done < "$FIND_TERMINAL_AUDIT_INVENTORY"
        rm -f "$FIND_TERMINAL_AUDIT_INVENTORY"
    fi
    assert_no_operation_cleanup_dirs_for_transaction "$transaction_id" "$audit_dir"
}

validate_exceptional_recovery_closure() {
    local transaction_id=$1
    local source_path="${BACKUP_DIR}/transaction-${transaction_id}.json"
    local rollback_path="${BACKUP_DIR}/rollback-transaction-${transaction_id}.json"
    local marker_path="${BACKUP_DIR}/rollback-commit-${transaction_id}.json"
    local authority="${BACKUP_DIR}/exceptional-recovery-authority-${transaction_id}.json"
    local receipt="${BACKUP_DIR}/exceptional-recovery-receipt-${transaction_id}.json"
    local authority_candidate="${authority}.candidate-gl-a-${transaction_id}"
    local receipt_candidate="${receipt}.candidate-gl-a-${transaction_id}"
    local authority_present=0 receipt_present=0
    local authority_sha source_sha rollback_sha marker_sha
    printf '%s' "$transaction_id" | grep -Eq '^[0-9]{14}-[a-f0-9]{8}$' || return 1
    for candidate in "$authority_candidate" "$receipt_candidate"; do
        test ! -e "$candidate" && test ! -L "$candidate" || return 1
    done
    if [ -e "$authority" ] || [ -L "$authority" ]; then authority_present=1; fi
    if [ -e "$receipt" ] || [ -L "$receipt" ]; then receipt_present=1; fi
    if [ "$authority_present:$receipt_present" = 0:0 ]; then return 0; fi
    test "$authority_present:$receipt_present" = 1:1 || return 1
    for evidence in "$source_path" "$rollback_path" "$marker_path" "$authority" "$receipt"; do
        journal_metadata_is_private "$evidence" || return 1
        test "$(stat -c '%h' "$evidence")" = 1 || return 1
    done
    authority_sha="$(sha256sum "$authority" | awk '{print $1}')" || return 1
    source_sha="$(sha256sum "$source_path" | awk '{print $1}')" || return 1
    rollback_sha="$(sha256sum "$rollback_path" | awk '{print $1}')" || return 1
    marker_sha="$(sha256sum "$marker_path" | awk '{print $1}')" || return 1
    jq -e \
        --arg operation_id "$transaction_id" \
        --arg source "$source_path" --arg rollback "$rollback_path" \
        --arg transaction_helper "$(jq -er '.rollback_helper_sha256' "$source_path")" \
        --arg g0_commit "$(jq -er '.g0_commit' "$source_path")" '
        (keys | sort) == ["approval_evidence_sha256","approved_utc","defect","g0_commit",
                          "gate","independent_rollback_owner","operation_id","operator","phase",
                          "recovery_executor_sha256","rollback_journal","rollback_journal_sha256",
                          "schema","source_journal","source_journal_sha256",
                          "transaction_helper_sha256"] and
        .schema == 1 and .gate == "GL-a-exceptional-recovery" and
        .phase == "authorized" and .operation_id == $operation_id and
        .g0_commit == $g0_commit and .source_journal == $source and
        .rollback_journal == $rollback and
        (.source_journal_sha256 | test("^[a-f0-9]{64}$")) and
        (.rollback_journal_sha256 | test("^[a-f0-9]{64}$")) and
        .transaction_helper_sha256 == $transaction_helper and
        (.recovery_executor_sha256 | test("^[a-f0-9]{64}$")) and
        .recovery_executor_sha256 != .transaction_helper_sha256 and
        .defect == "initialized_rotation_candidate_prepublication" and
        .operator == "Codex" and .independent_rollback_owner == "roxor" and
        (.approved_utc | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
        (.approval_evidence_sha256 | test("^[a-f0-9]{64}$"))
    ' "$authority" >/dev/null || return 1
    test "$(jq -er '.rollback_helper_sha256' "$rollback_path")" = \
        "$(jq -er '.transaction_helper_sha256' "$authority")" || return 1
    test "$(jq -er '.g0_commit' "$rollback_path")" = \
        "$(jq -er '.g0_commit' "$authority")" || return 1
    jq -e \
        --arg operation_id "$transaction_id" \
        --arg authority "$authority" --arg authority_sha "$authority_sha" \
        --arg source "$source_path" \
        --arg source_before "$(jq -er '.source_journal_sha256' "$authority")" \
        --arg source_terminal "$source_sha" \
        --arg rollback "$rollback_path" \
        --arg rollback_before "$(jq -er '.rollback_journal_sha256' "$authority")" \
        --arg rollback_terminal "$rollback_sha" \
        --arg marker "$marker_path" --arg marker_sha "$marker_sha" \
        --arg transaction_helper "$(jq -er '.transaction_helper_sha256' "$authority")" \
        --arg executor "$(jq -er '.recovery_executor_sha256' "$authority")" '
        (keys | sort) == ["authority","authority_sha256","gate","operation_id","phase",
                          "recovery_executor_sha256","rollback_before_sha256",
                          "rollback_commit_marker","rollback_commit_marker_sha256",
                          "rollback_journal","rollback_terminal_sha256","schema",
                          "source_before_sha256","source_journal","source_terminal_sha256",
                          "transaction_helper_sha256"] and
        .schema == 1 and .gate == "GL-a-exceptional-recovery" and
        .phase == "committed" and .operation_id == $operation_id and
        .authority == $authority and .authority_sha256 == $authority_sha and
        .source_journal == $source and .source_before_sha256 == $source_before and
        .source_terminal_sha256 == $source_terminal and
        .rollback_journal == $rollback and .rollback_before_sha256 == $rollback_before and
        .rollback_terminal_sha256 == $rollback_terminal and
        .rollback_commit_marker == $marker and
        .rollback_commit_marker_sha256 == $marker_sha and
        .transaction_helper_sha256 == $transaction_helper and
        .recovery_executor_sha256 == $executor
    ' "$receipt" >/dev/null || return 1
}

validate_terminal_rollback_journal() {
    local path=$1
    local transaction_id=$2
    local source_path="${BACKUP_DIR}/transaction-${transaction_id}.json"
    local source_terminal_sha256
    printf '%s' "$transaction_id" | grep -Eq '^[0-9]{14}-[a-f0-9]{8}$' || return 1
    journal_metadata_is_private "$path" || return 1
    jq -e \
        --arg operation_id "$transaction_id" --arg self "$path" --arg source "$source_path" \
        --arg backup "${BACKUP_DIR}/aifeeds.conf.bak-perf-${transaction_id}" \
        --arg audit "${BACKUP_DIR}/audit-${transaction_id}" \
        --arg archive "${BACKUP_DIR}/audit-${transaction_id}/archive-manifest.json" \
        --arg marker "${BACKUP_DIR}/rollback-commit-${transaction_id}.json" \
        --arg rollback_candidate "${SITE}.rollback-gl-a-${transaction_id}" '
        .schema == 1 and .gate == "GL-a-manual-rollback" and .phase == "rolled_back" and
        .operation_id == $operation_id and .rollback_journal == $self and
        .source_journal == $source and (.source_journal_sha256 | test("^[a-f0-9]{64}$")) and
        (.source_journal_terminal_sha256 | test("^[a-f0-9]{64}$")) and
        (.log_archive_manifest_sha256 | test("^[a-f0-9]{64}$")) and
        (.log_archive_manifest_generation | type == "number" and . >= 0 and . == floor) and
        (.log_archive_manifest_entry_count | type == "number" and . >= 0 and . == floor) and
        .site_backup == $backup and .audit_dir == $audit and .log_archive_manifest == $archive and
        .rollback_commit_marker == $marker and
        .rollback_candidate == $rollback_candidate and
        (.source_origin_phase == "initializing" or .source_origin_phase == "prepared" or
         .source_origin_phase == "backup_created" or .source_origin_phase == "mutation_started" or
         .source_origin_phase == "mutated" or
         .source_origin_phase == "timer_enabled" or .source_origin_phase == "committed") and
        (.g0_commit | test("^[a-f0-9]{40}$")) and
        (.rollback_helper_sha256 | test("^[a-f0-9]{64}$")) and
        (.site_backup_sha256 | test("^[a-f0-9]{64}$")) and
        (.installed_site_sha256 == "absent" or
         (.installed_site_sha256 | test("^[a-f0-9]{64}$"))) and
        ((.artifacts_sha256 | keys) == ["checker","diff_checker","format","inserter","rotate","service","timer"]) and
        all(.artifacts_sha256[]; type == "string" and test("^[a-f0-9]{64}$")) and
        .artifact_candidates == {
          checker:("/usr/local/sbin/aifeeds-check-nginx-request-id.candidate-gl-a-" + $operation_id),
          diff_checker:("/usr/local/sbin/aifeeds-verify-nginx-request-id-diff.candidate-gl-a-" + $operation_id),
          format:("/etc/nginx/conf.d/aifeeds-performance-log.conf.candidate-gl-a-" + $operation_id),
          inserter:("/usr/local/sbin/aifeeds-insert-nginx-request-id.candidate-gl-a-" + $operation_id),
          log:("/var/log/nginx/.aifeeds-performance.jsonl.candidate-gl-a-" + $operation_id),
          rotate:("/etc/aifeeds-performance-logrotate.conf.candidate-gl-a-" + $operation_id),
          service:("/etc/systemd/system/aifeeds-performance-logrotate.service.candidate-gl-a-" + $operation_id),
          timer:("/etc/systemd/system/aifeeds-performance-logrotate.timer.candidate-gl-a-" + $operation_id)
        } and
        (.site_backup_identity == null or
         (.site_backup_identity.path == $backup and
          .site_backup_identity.sha256 == .site_backup_sha256 and
          .site_backup_identity.uid == .original_site_uid and
          .site_backup_identity.gid == .original_site_gid and
          .site_backup_identity.mode == .original_site_mode and
          .site_backup_identity.staging_uid == 0 and
          .site_backup_identity.staging_gid == 0 and
          .site_backup_identity.staging_mode == "600" and
          (.site_backup_identity.dev | type == "number" and . > 0 and . == floor) and
          (.site_backup_identity.ino | type == "number" and . > 0 and . == floor))) and
        (.original_site_uid | type == "number") and (.original_site_gid | type == "number") and
        (.original_site_dev | type == "number") and (.original_site_ino | type == "number") and
        (.original_site_mode | type == "string" and test("^[0-7]{3,4}$"))' \
        "$path" >/dev/null || return 1
    terminal_runtime_inventory_is_valid "$path" || return 1
    journal_metadata_is_private "$source_path" || return 1
    jq -e --arg rollback "$path" \
        '.schema == 1 and .gate == "GL-a" and .phase == "rolled_back" and
         .rollback_journal == $rollback' "$source_path" >/dev/null || return 1
    test "$(jq -er '.g0_commit' "$path")" = "$(jq -er '.g0_commit' "$source_path")" || return 1
    test "$(jq -er '.rollback_helper_sha256' "$path")" = \
        "$(jq -er '.rollback_helper_sha256' "$source_path")" || return 1
    test "$(jq -er '.source_origin_phase' "$path")" = \
        "$(jq -er '.rollback_origin_phase' "$source_path")" || return 1
    for mirrored_field in site_backup audit_dir log_archive_manifest log_archive_manifest_sha256 \
        log_archive_manifest_generation log_archive_manifest_entry_count \
        rollback_commit_marker rollback_candidate \
        site_backup_sha256 site_backup_identity runtime_artifacts runtime_artifacts_sealed \
        rotation_state_identity rotation_state_snapshot rotation_anchor_identity installer_candidate_dev installer_candidate_ino \
        rollback_candidate_dev rollback_candidate_ino \
        installed_site_sha256 original_site_uid original_site_gid \
        original_site_mode original_site_dev original_site_ino; do
        test "$(jq -cS --arg field "$mirrored_field" '.[$field]' "$path")" = \
            "$(jq -cS --arg field "$mirrored_field" '.[$field]' "$source_path")" || return 1
    done
    test "$(jq -cS '.artifacts_sha256' "$path")" = \
        "$(jq -cS '.artifacts_sha256' "$source_path")" || return 1
    test "$(jq -cS '.artifact_candidates' "$path")" = \
        "$(jq -cS '.artifact_candidates' "$source_path")" || return 1
    test "$(jq -er '.log_archive_manifest_sha256' "$path")" = \
        "$(sha256sum "${BACKUP_DIR}/audit-${transaction_id}/archive-manifest.json" | awk '{print $1}')" \
        || return 1
    test "$(jq -er '.log_archive_manifest_generation' "$path")" = \
        "$(jq -er '.generation' "${BACKUP_DIR}/audit-${transaction_id}/archive-manifest.json")" \
        || return 1
    test "$(jq -er '.log_archive_manifest_entry_count' "$path")" = \
        "$(jq -er '.entries | length' "${BACKUP_DIR}/audit-${transaction_id}/archive-manifest.json")" \
        || return 1
    source_terminal_sha256="$(sha256sum "$source_path" | awk '{print $1}')" || return 1
    test "$(jq -er '.source_journal_terminal_sha256' "$path")" = "$source_terminal_sha256"
}

validate_terminal_source_journal() {
    local path=$1
    local basename="${path##*/}"
    local transaction_id="${basename#transaction-}"
    local rollback_path
    local marker_path
    local phase
    local recorded_rollback
    transaction_id="${transaction_id%.json}"
    printf '%s' "$transaction_id" | grep -Eq '^[0-9]{14}-[a-f0-9]{8}$' || return 1
    test "$path" = "${BACKUP_DIR}/transaction-${transaction_id}.json" || return 1
    journal_metadata_is_private "$path" || return 1
    jq -e \
        --arg operation_id "$transaction_id" --arg self "$path" \
        --arg backup "${BACKUP_DIR}/aifeeds.conf.bak-perf-${transaction_id}" \
        --arg audit "${BACKUP_DIR}/audit-${transaction_id}" \
        --arg archive "${BACKUP_DIR}/audit-${transaction_id}/archive-manifest.json" \
        --arg rollback_candidate "${SITE}.rollback-gl-a-${transaction_id}" '
        .schema == 1 and .gate == "GL-a" and
        (.phase == "committed" or .phase == "rolled_back") and
        .operation_id == $operation_id and .transaction_journal == $self and
        .site_backup == $backup and .audit_dir == $audit and .log_archive_manifest == $archive and
        .installer_candidate == ("/etc/nginx/sites-available/aifeeds.conf.candidate-gl-a-" + $operation_id) and
        .rollback_candidate == $rollback_candidate and
        (.g0_commit | test("^[a-f0-9]{40}$")) and
        (.rollback_helper_sha256 | test("^[a-f0-9]{64}$")) and
        (.site_backup_sha256 | test("^[a-f0-9]{64}$")) and
        (if .phase == "committed" then
           (.installed_site_sha256 | test("^[a-f0-9]{64}$"))
         else
           (.installed_site_sha256 == "absent" or
            (.installed_site_sha256 | test("^[a-f0-9]{64}$")))
         end) and
        (if .installed_site_sha256 == "absent" then
           .phase == "rolled_back" and
           (.rollback_origin_phase == "initializing" or .rollback_origin_phase == "prepared")
         else true end) and
        (.original_site_uid | type == "number") and (.original_site_gid | type == "number") and
        (.original_site_dev | type == "number") and (.original_site_ino | type == "number") and
        (.original_site_mode | type == "string" and test("^[0-7]{3,4}$")) and
        ((.artifacts_sha256 | keys) == ["checker","diff_checker","format","inserter","rotate","service","timer"]) and
        all(.artifacts_sha256[]; type == "string" and test("^[a-f0-9]{64}$")) and
        .artifact_candidates == {
          checker:("/usr/local/sbin/aifeeds-check-nginx-request-id.candidate-gl-a-" + $operation_id),
          diff_checker:("/usr/local/sbin/aifeeds-verify-nginx-request-id-diff.candidate-gl-a-" + $operation_id),
          format:("/etc/nginx/conf.d/aifeeds-performance-log.conf.candidate-gl-a-" + $operation_id),
          inserter:("/usr/local/sbin/aifeeds-insert-nginx-request-id.candidate-gl-a-" + $operation_id),
          log:("/var/log/nginx/.aifeeds-performance.jsonl.candidate-gl-a-" + $operation_id),
          rotate:("/etc/aifeeds-performance-logrotate.conf.candidate-gl-a-" + $operation_id),
          service:("/etc/systemd/system/aifeeds-performance-logrotate.service.candidate-gl-a-" + $operation_id),
          timer:("/etc/systemd/system/aifeeds-performance-logrotate.timer.candidate-gl-a-" + $operation_id)
        } and
        (.site_backup_identity == null or
         (.site_backup_identity.path == $backup and
          .site_backup_identity.sha256 == .site_backup_sha256 and
          .site_backup_identity.uid == .original_site_uid and
          .site_backup_identity.gid == .original_site_gid and
          .site_backup_identity.mode == .original_site_mode and
          .site_backup_identity.staging_uid == 0 and
          .site_backup_identity.staging_gid == 0 and
          .site_backup_identity.staging_mode == "600" and
          (.site_backup_identity.dev | type == "number" and . > 0 and . == floor) and
          (.site_backup_identity.ino | type == "number" and . > 0 and . == floor))) and
        (if .phase == "rolled_back" then
           (.rollback_origin_phase == "initializing" or .rollback_origin_phase == "prepared" or
            .rollback_origin_phase == "backup_created" or .rollback_origin_phase == "mutation_started" or
            .rollback_origin_phase == "mutated" or .rollback_origin_phase == "timer_enabled" or
            .rollback_origin_phase == "committed") and
           (.log_archive_manifest_sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
           (.log_archive_manifest_generation | type == "number" and . >= 0 and . == floor) and
           (.log_archive_manifest_entry_count | type == "number" and . >= 0 and . == floor)
         else (has("rollback_origin_phase") | not) end)' \
        "$path" >/dev/null || return 1
    terminal_runtime_inventory_is_valid "$path" || return 1
    phase="$(jq -er '.phase' "$path")" || return 1
    validate_terminal_runtime_residue "$path" "$transaction_id" || return 1
    if [ "$phase" = rolled_back ]; then
        test "$(jq -er '.log_archive_manifest_sha256' "$path")" = \
            "$(sha256sum "${BACKUP_DIR}/audit-${transaction_id}/archive-manifest.json" | awk '{print $1}')" \
            || return 1
        test "$(jq -er '.log_archive_manifest_generation' "$path")" = \
            "$(jq -er '.generation' "${BACKUP_DIR}/audit-${transaction_id}/archive-manifest.json")" \
            || return 1
        test "$(jq -er '.log_archive_manifest_entry_count' "$path")" = \
            "$(jq -er '.entries | length' "${BACKUP_DIR}/audit-${transaction_id}/archive-manifest.json")" \
            || return 1
    else
        jq -e '((has("log_archive_manifest_sha256") or
            has("log_archive_manifest_generation") or
            has("log_archive_manifest_entry_count")) | not)' "$path" >/dev/null || return 1
    fi
    rollback_path="${BACKUP_DIR}/rollback-transaction-${transaction_id}.json"
    if [ "$phase" = committed ]; then
        jq -e 'has("rollback_journal") | not' "$path" >/dev/null || return 1
        test ! -e "$rollback_path" || return 1
        test ! -L "$rollback_path" || return 1
    else
        recorded_rollback="$(jq -r '.rollback_journal // ""' "$path")" || return 1
        if [ -n "$recorded_rollback" ]; then
            test "$recorded_rollback" = "$rollback_path" || return 1
            marker_path="${BACKUP_DIR}/rollback-commit-${transaction_id}.json"
            test "$(jq -er '.rollback_commit_marker' "$path")" = "$marker_path" || return 1
            validate_terminal_rollback_journal "$rollback_path" "$transaction_id" || return 1
            validate_terminal_pair_commit_marker "$marker_path" || return 1
        else
            test ! -e "$rollback_path" || return 1
            test ! -L "$rollback_path" || return 1
            marker_path="${BACKUP_DIR}/rollback-commit-${transaction_id}.json"
            test ! -e "$marker_path" || return 1
            test ! -L "$marker_path" || return 1
        fi
    fi
    validate_exceptional_recovery_closure "$transaction_id" || return 1
}

write_find_inventory "$FIND_JOURNAL_INVENTORY" "$BACKUP_DIR" -maxdepth 1 \
    \( -name 'transaction-*.json*' -o -name 'rollback-transaction-*.json*' \
       -o -name 'rollback-commit-*.json*' \
       -o -name 'exceptional-recovery-authority-*.json*' \
       -o -name 'exceptional-recovery-receipt-*.json*' \)
while IFS= read -r -d '' existing_journal; do
    existing_basename="${existing_journal##*/}"
    case "$existing_basename" in
        rollback-commit-*.json)
            validate_terminal_pair_commit_marker "$existing_journal" || {
                printf 'ERROR recovery_required=1 journal=%s phase=invalid\n' "$existing_journal"
                exit 76
            }
            ;;
        rollback-transaction-*.json)
            existing_id="${existing_basename#rollback-transaction-}"
            existing_id="${existing_id%.json}"
            validate_terminal_rollback_journal "$existing_journal" "$existing_id" || {
                printf 'ERROR recovery_required=1 journal=%s phase=invalid\n' "$existing_journal"
                exit 76
            }
            ;;
        transaction-*.json)
            validate_terminal_source_journal "$existing_journal" || {
                printf 'ERROR recovery_required=1 journal=%s phase=invalid\n' "$existing_journal"
                exit 76
            }
            ;;
        exceptional-recovery-authority-*.json|exceptional-recovery-receipt-*.json)
            existing_id="${existing_basename#exceptional-recovery-authority-}"
            if [ "$existing_id" = "$existing_basename" ]; then
                existing_id="${existing_basename#exceptional-recovery-receipt-}"
            fi
            existing_id="${existing_id%.json}"
            validate_exceptional_recovery_closure "$existing_id" || {
                printf 'ERROR recovery_required=1 journal=%s phase=invalid\n' "$existing_journal"
                exit 76
            }
            ;;
        *)
            printf 'ERROR recovery_required=1 journal=%s phase=invalid_name\n' "$existing_journal"
            exit 76
            ;;
    esac
done < "$FIND_JOURNAL_INVENTORY"
rm -f "$FIND_JOURNAL_INVENTORY"
test ! -e "$BACKUP"
test ! -L "$BACKUP"
test ! -e "$JOURNAL"
test ! -L "$JOURNAL"
test ! -e "$JOURNAL_TMP"
test ! -L "$JOURNAL_TMP"
test ! -e "$AUDIT_DIR"
test ! -L "$AUDIT_DIR"
test ! -e "$CANDIDATE"
test ! -L "$CANDIDATE"
test ! -e "$ROLLBACK_CANDIDATE"
test ! -L "$ROLLBACK_CANDIDATE"
test ! -e "$SUMMARY_TMP"
test ! -L "$SUMMARY_TMP"
test ! -e "$SUMMARY"
test ! -L "$SUMMARY"
SITE_BASE_SHA256="$(sha256sum "$SITE" | awk '{print $1}')"
printf '%s' "$SITE_BASE_SHA256" | grep -Eq '^[a-f0-9]{64}$'
SITE_BASE_DEV="$(stat -c '%d' "$SITE")"
SITE_BASE_INO="$(stat -c '%i' "$SITE")"
printf '%s:%s' "$SITE_BASE_DEV" "$SITE_BASE_INO" | grep -Eq '^[0-9]+:[0-9]+$'
SITE_BACKUP_SHA256="$SITE_BASE_SHA256"
EXPECTED_INSTALLED_SITE_SHA256=absent
write_journal initializing

test ! -e "$SITE_BUILD_CANDIDATE"
test ! -L "$SITE_BUILD_CANDIDATE"
cp -a "$SITE" "$SITE_BUILD_CANDIDATE"
python3 "$STAGING/insert-nginx-request-id.py" "$SITE_BUILD_CANDIDATE" "$EXPECTED_PROXY_COUNT"
python3 "$STAGING/check-nginx-request-id.py" \
    --expect-proxy-count 7 \
    --allow-include /etc/letsencrypt/options-ssl-nginx.conf \
    "$SITE_BUILD_CANDIDATE"
python3 "$STAGING/verify-nginx-request-id-diff.py" \
    "$SITE" "$SITE_BUILD_CANDIDATE" "$EXPECTED_PROXY_COUNT"
EXPECTED_INSTALLED_SITE_SHA256="$(sha256sum "$SITE_BUILD_CANDIDATE" | awk '{print $1}')"
printf '%s' "$EXPECTED_INSTALLED_SITE_SHA256" | grep -Eq '^[a-f0-9]{64}$'
test "$EXPECTED_INSTALLED_SITE_SHA256" != "$SITE_BASE_SHA256"
write_journal prepared

site_build_dev="$(stat -c '%d' "$SITE_BUILD_CANDIDATE")"
site_build_ino="$(stat -c '%i' "$SITE_BUILD_CANDIDATE")"
site_candidate_identity="$(copy_file_no_replace "$SITE_BUILD_CANDIDATE" "$CANDIDATE" \
    "$EXPECTED_INSTALLED_SITE_SHA256" "$SITE_UID" "$SITE_GID" "$SITE_MODE" \
    "$site_build_dev" "$site_build_ino")"
INSTALLER_CANDIDATE_DEV=${site_candidate_identity%%:*}
INSTALLER_CANDIDATE_INO=${site_candidate_identity##*:}
test "$(stat -c '%d' "$SITE")" = "$(stat -c '%d' "$CANDIDATE")"
path_matches_exact "$CANDIDATE" "$EXPECTED_INSTALLED_SITE_SHA256" \
    "$SITE_UID" "$SITE_GID" "$SITE_MODE"
persist_installer_candidate_identity
rm -f "$SITE_BUILD_CANDIDATE"

backup_allocation_identity="$(create_site_backup_inode_no_replace)"
site_backup_dev=${backup_allocation_identity%%:*}
site_backup_ino=${backup_allocation_identity##*:}
printf '%s:%s' "$site_backup_dev" "$site_backup_ino" | grep -Eq '^[0-9]+:[0-9]+$'
SITE_BACKUP_IDENTITY_JSON="$(jq -nc --arg path "$BACKUP" \
    --arg sha256 "$SITE_BACKUP_SHA256" --argjson uid "$SITE_UID" --argjson gid "$SITE_GID" \
    --arg mode "$SITE_MODE" --argjson dev "$site_backup_dev" --argjson ino "$site_backup_ino" \
    '{path:$path,sha256:$sha256,uid:$uid,gid:$gid,mode:$mode,
      staging_uid:0,staging_gid:0,staging_mode:"600",dev:$dev,ino:$ino}')"
write_journal prepared
populate_site_backup "$site_backup_dev" "$site_backup_ino"
assert_backup_unchanged
write_journal backup_created

assert_installed_site_unchanged() {
    assert_enabled_site_target
    formal_site_matches_state "$SITE" installed
    "$CHECKER" \
        --expect-proxy-count 7 \
        --allow-include /etc/letsencrypt/options-ssl-nginx.conf \
        "$SITE" >/dev/null
    "$DIFF_CHECKER" "$BACKUP" "$SITE" "$EXPECTED_PROXY_COUNT" >/dev/null
}

formal_site_matches_state "$SITE" base
assert_enabled_site_target
write_journal mutation_started
MUTATED=1
EMPTY_SHA256="$(sha256sum /dev/null | awk '{print $1}')"
prepare_atomic_owned format "$STAGING/aifeeds-performance-log.conf" "$FORMAT" \
    "$FORMAT_CANDIDATE" "$FORMAT_SHA256" root root 644
prepare_atomic_owned log /dev/null "$LOG" "$LOG_CANDIDATE" "$EMPTY_SHA256" www-data adm 640
prepare_atomic_owned checker "$STAGING/check-nginx-request-id.py" "$CHECKER" \
    "$CHECKER_CANDIDATE" "$CHECKER_SHA256" root root 755
prepare_atomic_owned diff_checker "$STAGING/verify-nginx-request-id-diff.py" "$DIFF_CHECKER" \
    "$DIFF_CHECKER_CANDIDATE" "$DIFF_CHECKER_SHA256" root root 755
prepare_atomic_owned inserter "$STAGING/insert-nginx-request-id.py" "$INSERTER" \
    "$INSERTER_CANDIDATE" "$INSERTER_SHA256" root root 755
prepare_atomic_owned rotate "$STAGING/aifeeds-performance.logrotate" "$ROTATE" \
    "$ROTATE_CANDIDATE" "$ROTATE_SHA256" root root 644
prepare_atomic_owned timer "$STAGING/aifeeds-performance-logrotate.timer" "$TIMER_PATH" \
    "$TIMER_CANDIDATE" "$TIMER_SHA256" root root 644
prepare_rotation_state_directory
allocate_rotation_anchor
prepare_rotation_authority_and_service
runtime_artifact_inventory_is_complete
RUNTIME_ARTIFACTS_SEALED=true
write_journal mutation_started
publish_atomic_owned format "$FORMAT" "$FORMAT_CANDIDATE"
publish_atomic_owned log "$LOG" "$LOG_CANDIDATE"
publish_atomic_owned checker "$CHECKER" "$CHECKER_CANDIDATE"
publish_atomic_owned diff_checker "$DIFF_CHECKER" "$DIFF_CHECKER_CANDIDATE"
publish_atomic_owned inserter "$INSERTER" "$INSERTER_CANDIDATE"
publish_atomic_owned rotate "$ROTATE" "$ROTATE_CANDIDATE"
publish_atomic_owned service "$SERVICE_PATH" "$SERVICE_CANDIDATE"
publish_atomic_owned timer "$TIMER_PATH" "$TIMER_CANDIDATE"
publish_rotation_state_directory
formal_site_matches_state "$SITE" base
assert_enabled_site_target
ROLLBACK_CANDIDATE_DEV=$SITE_BASE_DEV
ROLLBACK_CANDIDATE_INO=$SITE_BASE_INO
write_journal mutation_started
publish_site_no_replace "$SITE" "$CANDIDATE" "$ROLLBACK_CANDIDATE" "$SITE_BASE_SHA256" "$EXPECTED_INSTALLED_SITE_SHA256" \
    "$SITE_UID" "$SITE_GID" "$SITE_MODE" "$SITE_BASE_DEV" "$SITE_BASE_INO" \
    "$INSTALLER_CANDIDATE_DEV" "$INSTALLER_CANDIDATE_INO"
assert_enabled_site_target

assert_installed_site_unchanged
test -f "$ROLLBACK_CANDIDATE"
test ! -L "$ROLLBACK_CANDIDATE"
test "$(sha256sum "$ROLLBACK_CANDIDATE" | awk '{print $1}')" = "$SITE_BASE_SHA256"
test "$(stat -c '%u %g %a' "$ROLLBACK_CANDIDATE")" = "$SITE_UID $SITE_GID $SITE_MODE"
test "$(stat -c '%d %i' "$ROLLBACK_CANDIDATE")" = "$SITE_BASE_DEV $SITE_BASE_INO"
remove_exact_quiescent_file "$ROLLBACK_CANDIDATE" "$SITE_BASE_SHA256" "$SITE_UID" "$SITE_GID" "$SITE_MODE" "$SITE_BASE_DEV" "$SITE_BASE_INO"
ROLLBACK_CANDIDATE_DEV=''
ROLLBACK_CANDIDATE_INO=''
write_journal mutated
cmp -s "$STAGING/aifeeds-performance-log.conf" "$FORMAT"
cmp -s "$STAGING/aifeeds-performance.logrotate" "$ROTATE"
logrotate -d -s "$DRY_ROTATE_STATE" "$ROTATE" >/dev/null
systemd-analyze verify "$SERVICE_PATH" "$TIMER_PATH"
nginx -t
systemctl daemon-reload
assert_enabled_site_target
systemctl reload nginx
assert_enabled_site_target
systemctl is-active --quiet nginx
assert_installed_site_unchanged

probe_is_valid() {
    local expected_probe=$1
    tail -n 2000 "$LOG" | jq -s -e --arg probe "$expected_probe" '
        def timing_shape:
            type == "string" and test("^[0-9]+([.][0-9]+)?((, ?| ?: ?)[0-9]+([.][0-9]+)?)*$");
        def timing_or_cached_dash:
            timing_shape or . == "-";
        def exact_keys:
            (keys | sort) == (["bytes_sent", "client_class", "host", "perf_probe", "request_id",
              "request_time", "status", "timestamp", "upstream_cache_status",
              "upstream_connect_time", "upstream_header_time", "upstream_response_time", "uri"] | sort);
        [ .[] | select(.perf_probe == $probe) ] as $rows
        | ($rows | length) == 2
        and any($rows[]; .host == "ai-feeds.com" and .uri == "/")
        and any($rows[]; .host == "api.ai-feeds.com" and .uri == "/api/items")
        and all($rows[];
            exact_keys
            and (.timestamp | type) == "string"
            and (.timestamp | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}:[0-9]{2}$"))
            and (.request_id | type) == "string"
            and (.request_id | test("^[A-Za-z0-9._:-]{8,128}$"))
            and .status == "200"
            and (.bytes_sent | type) == "string"
            and (.bytes_sent | test("^[0-9]+$"))
            and (.client_class == "bot" or .client_class == "iphone" or .client_class == "ipad"
              or .client_class == "android" or .client_class == "desktop" or .client_class == "other")
            and (.upstream_cache_status | type) == "string"
            and (.upstream_cache_status | test("^(|-|HIT|MISS|BYPASS|EXPIRED|STALE|UPDATING|REVALIDATED)$"))
            and (.request_time | timing_shape)
            and if .host == "api.ai-feeds.com" then
              (.upstream_connect_time | timing_shape)
              and (.upstream_header_time | timing_shape)
              and (.upstream_response_time | timing_shape)
            elif (.upstream_cache_status == "HIT" or .upstream_cache_status == "STALE"
              or .upstream_cache_status == "UPDATING" or .upstream_cache_status == "REVALIDATED") then
              (.upstream_connect_time | timing_or_cached_dash)
              and (.upstream_header_time | timing_or_cached_dash)
              and (.upstream_response_time | timing_or_cached_dash)
            else
              (.upstream_connect_time | timing_shape)
              and (.upstream_header_time | timing_shape)
              and (.upstream_response_time | timing_shape)
            end)
    ' >/dev/null
}

attempt=1
while [ "$attempt" -le 3 ]; do
    sleep 1
    probe="upstream-$(date +%s)-$(openssl rand -hex 4)"
    FRONT_STATUS="$(curl_status https://ai-feeds.com/ -H "X-Aifeeds-Perf-Probe: $probe")"
    API_STATUS="$(curl_status 'https://api.ai-feeds.com/api/items?source_type=x_list&limit=1' -H "X-Aifeeds-Perf-Probe: $probe")"
    test "$FRONT_STATUS" = 200
    test "$API_STATUS" = 200
    sleep 6
    if probe_is_valid "$probe"; then break; fi
    attempt=$((attempt + 1))
done
probe_is_valid "$probe"
assert_installed_site_unchanged

BEFORE_INODE="$(stat -c '%i' "$LOG")"
logrotate -f -s "$FORCE_ROTATE_STATE" "$ROTATE"
AFTER_INODE="$(stat -c '%i' "$LOG")"
test "$BEFORE_INODE" != "$AFTER_INODE"
attempt=1
while [ "$attempt" -le 3 ]; do
    sleep 1
    rotation_probe="upstream-$(date +%s)-$(openssl rand -hex 4)"
    ROTATION_FRONT_STATUS="$(curl_status https://ai-feeds.com/ -H "X-Aifeeds-Perf-Probe: $rotation_probe")"
    ROTATION_API_STATUS="$(curl_status 'https://api.ai-feeds.com/api/items?source_type=x_list&limit=1' -H "X-Aifeeds-Perf-Probe: $rotation_probe")"
    test "$ROTATION_FRONT_STATUS" = 200
    test "$ROTATION_API_STATUS" = 200
    sleep 6
    if probe_is_valid "$rotation_probe"; then break; fi
    attempt=$((attempt + 1))
done
probe_is_valid "$rotation_probe"
assert_installed_site_unchanged

test ! -e "$ROTATE_STATE"
test ! -L "$ROTATE_STATE"
systemctl start "$ROTATE_SERVICE"
test "$(systemctl show -p Result --value "$ROTATE_SERVICE")" = success
test -s "$ROTATE_STATE"
persist_rotation_state_identity
SYSTEMD_BEFORE_INODE="$(stat -c '%i' "$LOG")"
truncate -s 52428801 "$LOG"
test "$(stat -c '%s' "$LOG")" -ge 52428801
systemctl start "$ROTATE_SERVICE"
test "$(systemctl show -p Result --value "$ROTATE_SERVICE")" = success
persist_rotation_state_identity
SYSTEMD_AFTER_INODE="$(stat -c '%i' "$LOG")"
test "$SYSTEMD_BEFORE_INODE" != "$SYSTEMD_AFTER_INODE"
attempt=1
while [ "$attempt" -le 3 ]; do
    sleep 1
    systemd_rotation_probe="upstream-$(date +%s)-$(openssl rand -hex 4)"
    SYSTEMD_FRONT_STATUS="$(curl_status https://ai-feeds.com/ -H "X-Aifeeds-Perf-Probe: $systemd_rotation_probe")"
    SYSTEMD_API_STATUS="$(curl_status 'https://api.ai-feeds.com/api/items?source_type=x_list&limit=1' -H "X-Aifeeds-Perf-Probe: $systemd_rotation_probe")"
    test "$SYSTEMD_FRONT_STATUS" = 200
    test "$SYSTEMD_API_STATUS" = 200
    sleep 6
    if probe_is_valid "$systemd_rotation_probe"; then break; fi
    attempt=$((attempt + 1))
done
probe_is_valid "$systemd_rotation_probe"
assert_installed_site_unchanged
systemctl enable --now "$TIMER_UNIT"
systemctl is-active --quiet aifeeds-performance-logrotate.timer
systemctl is-enabled --quiet "$TIMER_UNIT"
assert_installed_site_unchanged
write_journal timer_enabled

test "$(stat -c '%a %U %G' "$LOG")" = '640 www-data adm'
test "$(stat -c '%a %U %G' "$ROTATE")" = '644 root root'
test "$(stat -c '%a %U %G' "$FORMAT")" = '644 root root'
INSTALLED_SITE_SHA256=$EXPECTED_INSTALLED_SITE_SHA256
printf '%s' "$INSTALLED_SITE_SHA256" | grep -Eq '^[a-f0-9]{64}$'
test "$INSTALLED_SITE_SHA256" = "$EXPECTED_INSTALLED_SITE_SHA256"
test "$(sha256sum "$BACKUP" | awk '{print $1}')" = "$SITE_BACKUP_SHA256"
assert_installed_site_unchanged

trap '' HUP INT TERM
write_journal committed
JOURNAL_SHA256="$(sha256sum "$JOURNAL" | awk '{print $1}')"
printf '%s' "$JOURNAL_SHA256" | grep -Eq '^[a-f0-9]{64}$'
jq -nc \
    --arg gate 'GL-a' \
    --arg operation_id "$OPERATION_ID" \
    --arg g0_commit "$G0_COMMIT" \
    --arg rollback_helper_sha256 "$ROLLBACK_HELPER_SHA256" \
    --arg rollback_candidate "$ROLLBACK_CANDIDATE" \
    --argjson artifacts_sha256 "$ARTIFACTS_SHA256_JSON" \
    --argjson artifact_candidates "$ARTIFACT_CANDIDATES_JSON" \
    --argjson runtime_artifacts "$RUNTIME_ARTIFACTS_JSON" \
    --argjson runtime_artifacts_sealed "$RUNTIME_ARTIFACTS_SEALED" \
    --argjson rotation_state_identity "$ROTATION_STATE_IDENTITY_JSON" \
    --argjson rotation_state_snapshot "$ROTATION_STATE_SNAPSHOT_JSON" \
    --argjson rotation_anchor_identity "$ROTATION_ANCHOR_IDENTITY_JSON" \
    --arg backup "$BACKUP" \
    --arg site_backup_sha256 "$SITE_BACKUP_SHA256" \
    --argjson site_backup_identity "$SITE_BACKUP_IDENTITY_JSON" \
    --arg installed_site_sha256 "$INSTALLED_SITE_SHA256" \
    --arg transaction_journal "$JOURNAL" \
    --arg transaction_journal_sha256 "$JOURNAL_SHA256" \
    --argjson original_site_uid "$SITE_UID" \
    --argjson original_site_gid "$SITE_GID" \
    --arg original_site_mode "$SITE_MODE" \
    --argjson front_status "$FRONT_STATUS" \
    --argjson api_status "$API_STATUS" \
    --argjson available_kib "$AVAILABLE_KIB" \
    --argjson available_inodes "$AVAILABLE_INODES" \
    '{schema:1,gate:$gate,operation_id:$operation_id,g0_commit:$g0_commit,
      rollback_helper_sha256:$rollback_helper_sha256,rollback_candidate:$rollback_candidate,
      artifacts_sha256:$artifacts_sha256,
      artifact_candidates:$artifact_candidates,
      runtime_artifacts:$runtime_artifacts,runtime_artifacts_sealed:$runtime_artifacts_sealed,
      rotation_state_identity:$rotation_state_identity,
      rotation_state_snapshot:$rotation_state_snapshot,
      rotation_anchor_identity:$rotation_anchor_identity,
      site_backup:$backup,site_backup_sha256:$site_backup_sha256,
      site_backup_identity:$site_backup_identity,
      installed_site_sha256:$installed_site_sha256,transaction_journal:$transaction_journal,
      transaction_journal_sha256:$transaction_journal_sha256,original_site_uid:$original_site_uid,
      original_site_gid:$original_site_gid,original_site_mode:$original_site_mode,front_status:$front_status,
      api_status:$api_status,available_kib:$available_kib,available_inodes:$available_inodes,
      json_schema:true,unique_probe:true,rotation_probe:true,systemd_rotation_probe:true,
      nginx_active:true,timer_active:true,worker_join:"deferred_to_GL-b"}' \
    > "$SUMMARY_TMP"
chmod 0600 "$SUMMARY_TMP"
sync -f "$SUMMARY_TMP"
mv -f "$SUMMARY_TMP" "$SUMMARY"
sync -f "$SUMMARY"

SUCCESS=1
printf 'gl_a=pass front_status=%s api_status=%s unique_probe=pass rotation_probe=pass nginx=active timer=active\n' \
    "$FRONT_STATUS" "$API_STATUS"
printf 'site_backup=%s\n' "$BACKUP"
