#!/usr/bin/env bash
set -euo pipefail
umask 077

SITE=/etc/nginx/sites-available/aifeeds.conf
ENABLED_SITE=/etc/nginx/sites-enabled/aifeeds.conf
FORMAT=/etc/nginx/conf.d/aifeeds-performance-log.conf
ROTATE=/etc/aifeeds-performance-logrotate.conf
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
LOCK=/run/aifeeds-performance-log.lock
BACKUP_DIR=/var/backups/aifeeds-performance-log

test "$(id -u)" = 0
case "$#" in 9|10) ;; *) exit 2 ;; esac
OUTPUT_DIR=$1
BACKUP=$2
BACKUP_SHA256=$3
INSTALLED_SITE_SHA256=$4
SITE_UID=$5
SITE_GID=$6
SITE_MODE=$7
SOURCE_JOURNAL=$8
SOURCE_JOURNAL_EXTERNAL_SHA256=$9
EXCEPTIONAL_AUTHORITY_INPUT=${10:-}
SOURCE_JOURNAL_SHA256=$SOURCE_JOURNAL_EXTERNAL_SHA256
SOURCE_JOURNAL_SETTLED_SHA256=''

case "$OUTPUT_DIR" in /run/aifeeds-performance-log.*) ;; *) exit 2 ;; esac
test -d "$OUTPUT_DIR"
test ! -L "$OUTPUT_DIR"
test "$(stat -c '%u' "$OUTPUT_DIR")" = 0
test "$(stat -c '%a' "$OUTPUT_DIR")" = 700
printf '%s' "$BACKUP" \
    | grep -Eq '^/var/backups/aifeeds-performance-log/aifeeds[.]conf[.]bak-perf-[0-9]{14}-[a-f0-9]{8}$'
printf '%s' "$SOURCE_JOURNAL" \
    | grep -Eq '^/var/backups/aifeeds-performance-log/transaction-[0-9]{14}-[a-f0-9]{8}[.]json$'
printf '%s' "$BACKUP_SHA256$SOURCE_JOURNAL_SHA256" | grep -Eq '^[a-f0-9]{128}$'
case "$INSTALLED_SITE_SHA256" in
    absent) ;;
    *) printf '%s' "$INSTALLED_SITE_SHA256" | grep -Eq '^[a-f0-9]{64}$' ;;
esac
printf '%s' "$SITE_UID:$SITE_GID:$SITE_MODE" | grep -Eq '^[0-9]+:[0-9]+:[0-7]{3,4}$'

SOURCE_BASENAME="${SOURCE_JOURNAL##*/}"
TRANSACTION_ID="${SOURCE_BASENAME#transaction-}"
TRANSACTION_ID="${TRANSACTION_ID%.json}"
TRANSACTION_STAMP="${TRANSACTION_ID%%-*}"
printf '%s' "$TRANSACTION_ID" | grep -Eq '^[0-9]{14}-[a-f0-9]{8}$'
JOURNAL_OPERATION_ID=$TRANSACTION_ID
FORMAT_CANDIDATE="${FORMAT}.candidate-gl-a-${TRANSACTION_ID}"
ROTATE_CANDIDATE="${ROTATE}.candidate-gl-a-${TRANSACTION_ID}"
LOG_CANDIDATE="${LOG%/*}/.${LOG##*/}.candidate-gl-a-${TRANSACTION_ID}"
CHECKER_CANDIDATE="${CHECKER}.candidate-gl-a-${TRANSACTION_ID}"
DIFF_CHECKER_CANDIDATE="${DIFF_CHECKER}.candidate-gl-a-${TRANSACTION_ID}"
INSERTER_CANDIDATE="${INSERTER}.candidate-gl-a-${TRANSACTION_ID}"
SERVICE_CANDIDATE="${SERVICE_PATH}.candidate-gl-a-${TRANSACTION_ID}"
TIMER_CANDIDATE="${TIMER_PATH}.candidate-gl-a-${TRANSACTION_ID}"
ROTATE_STATE_DIR_CANDIDATE="${ROTATE_STATE_DIR}.candidate-gl-a-${TRANSACTION_ID}"
ROTATION_ANCHOR="${BACKUP_DIR}/rotation-anchor-${TRANSACTION_ID}.json"
EXPECTED_ARTIFACT_CANDIDATES_JSON="$(jq -nc \
    --arg format "$FORMAT_CANDIDATE" --arg rotate "$ROTATE_CANDIDATE" \
    --arg log "$LOG_CANDIDATE" --arg checker "$CHECKER_CANDIDATE" \
    --arg diff_checker "$DIFF_CHECKER_CANDIDATE" --arg inserter "$INSERTER_CANDIDATE" \
    --arg service "$SERVICE_CANDIDATE" --arg timer "$TIMER_CANDIDATE" \
    '{format:$format,rotate:$rotate,log:$log,checker:$checker,diff_checker:$diff_checker,
      inserter:$inserter,service:$service,timer:$timer}')"
ROLLBACK_EXECUTOR_SHA256="$(sha256sum "$0" | awk '{print $1}')"
ROLLBACK_HELPER_SHA256=$ROLLBACK_EXECUTOR_SHA256
printf '%s' "$ROLLBACK_EXECUTOR_SHA256" | grep -Eq '^[a-f0-9]{64}$'
ROLLBACK_JOURNAL="${BACKUP_DIR}/rollback-transaction-${TRANSACTION_ID}.json"
SOURCE_JOURNAL_TMP="${SOURCE_JOURNAL}.tmp"
ROLLBACK_JOURNAL_TMP="${ROLLBACK_JOURNAL}.tmp"
SOURCE_JOURNAL_PREVIOUS_UPDATE="${SOURCE_JOURNAL}.previous-update-gl-a-${TRANSACTION_ID}"
ROLLBACK_JOURNAL_PREVIOUS_UPDATE="${ROLLBACK_JOURNAL}.previous-update-gl-a-${TRANSACTION_ID}"
ROLLBACK_COMMIT_MARKER="${BACKUP_DIR}/rollback-commit-${TRANSACTION_ID}.json"
ROLLBACK_COMMIT_MARKER_TMP="${ROLLBACK_COMMIT_MARKER}.tmp"
ROLLBACK_COMMIT_MARKER_PREVIOUS="${ROLLBACK_COMMIT_MARKER}.previous-terminal-gl-a-${TRANSACTION_ID}"
EXCEPTIONAL_AUTHORITY="${BACKUP_DIR}/exceptional-recovery-authority-${TRANSACTION_ID}.json"
EXCEPTIONAL_AUTHORITY_CANDIDATE="${EXCEPTIONAL_AUTHORITY}.candidate-gl-a-${TRANSACTION_ID}"
EXCEPTIONAL_RECEIPT="${BACKUP_DIR}/exceptional-recovery-receipt-${TRANSACTION_ID}.json"
EXCEPTIONAL_RECEIPT_CANDIDATE="${EXCEPTIONAL_RECEIPT}.candidate-gl-a-${TRANSACTION_ID}"
EXCEPTIONAL_RECEIPT_RENDER="${OUTPUT_DIR}/.exceptional-recovery-receipt-${TRANSACTION_ID}.render"
AUDIT_DIR="${BACKUP_DIR}/audit-${TRANSACTION_ID}"
ARCHIVE_MANIFEST="${AUDIT_DIR}/archive-manifest.json"
ARCHIVE_MANIFEST_TMP="${ARCHIVE_MANIFEST}.tmp"
ARCHIVE_MANIFEST_PREVIOUS="${ARCHIVE_MANIFEST}.previous-gl-a-${TRANSACTION_ID}"
LOG_QUARANTINE_SUFFIX="quarantine-gl-a-${TRANSACTION_ID}"
ARCHIVE_OPERATION_ID="$TRANSACTION_ID"
LOG_QUIESCENCE_TIMEOUT_SECONDS=60
if [ -n "${GL_A_TEST_LOG_QUIESCENCE_TIMEOUT_SECONDS:-}" ]; then
    test -d /workspace/deploy/nginx/test-fixtures/gl-a-installer
    printf '%s' "$GL_A_TEST_LOG_QUIESCENCE_TIMEOUT_SECONDS" | grep -Eq '^[1-9][0-9]*$'
    LOG_QUIESCENCE_TIMEOUT_SECONDS="$GL_A_TEST_LOG_QUIESCENCE_TIMEOUT_SECONDS"
fi
ROLLBACK_CANDIDATE="${SITE}.rollback-gl-a-${TRANSACTION_ID}"
INSTALLER_ROLLBACK_CANDIDATE="$ROLLBACK_CANDIDATE"
SUMMARY_TMP="${OUTPUT_DIR}/gl-a-manual-rollback-summary.json.tmp"
SUMMARY="${OUTPUT_DIR}/gl-a-manual-rollback-summary.json"
FIND_LOGS_INVENTORY="$OUTPUT_DIR/.find-logs.inventory"
FIND_ROTATION_INVENTORY="$OUTPUT_DIR/.find-rotation.inventory"
FIND_AUDIT_INVENTORY="$OUTPUT_DIR/.find-audit.inventory"
FIND_AUDIT_TERMINAL_INVENTORY="$OUTPUT_DIR/.find-audit-terminal.inventory"
FIND_ARCHIVE_INVENTORY="$OUTPUT_DIR/.find-archive.inventory"
FIND_SYMLINK_INVENTORY="$OUTPUT_DIR/.find-symlink.inventory"
FIND_QUARANTINE_INVENTORY="$OUTPUT_DIR/.find-quarantine.inventory"
FIND_MANIFEST_ENTRIES_INVENTORY="$OUTPUT_DIR/.find-manifest-entries.inventory"
FIND_MANIFEST_TERMINAL_INVENTORY="$OUTPUT_DIR/.find-manifest-terminal.inventory"
ROLLBACK_JOURNAL_CREATED=0
ROLLBACK_TERMINAL=0
SUCCESS=0
TERMINAL_ARCHIVE_MANIFEST_SHA256=''
TERMINAL_ARCHIVE_MANIFEST_GENERATION=''
TERMINAL_ARCHIVE_MANIFEST_ENTRY_COUNT=''
INSTALLER_CANDIDATE_DEV=''
INSTALLER_CANDIDATE_INO=''
RUNTIME_ARTIFACTS_JSON='[]'
RUNTIME_ARTIFACTS_SEALED=false
ROTATION_STATE_IDENTITY_JSON='null'
ROTATION_STATE_SNAPSHOT_JSON='null'
ROTATION_ANCHOR_IDENTITY_JSON='null'
SITE_BACKUP_IDENTITY_JSON='null'
ROLLBACK_CANDIDATE_DEV=''
ROLLBACK_CANDIDATE_INO=''
PARTIAL_BACKUP_SHA256=''
PARTIAL_BACKUP_DEV=''
PARTIAL_BACKUP_INO=''
RESUME_ROLLBACK_PHASE=none
ROLLBACK_FAILURE_FROM=none
LAST_ROLLBACK_PHASE=none
RUNTIME_CLEANUP_JSON='null'
TERMINAL_RECOVERY_PENDING=0
ARCHIVE_READ_ONLY_PREFLIGHT_FAILED=0
RUNTIME_CLEANUP_READ_ONLY_PREFLIGHT_FAILED=0
EXCEPTIONAL_RECOVERY=0
EXCEPTIONAL_AUTHORITY_SHA256=''
EXCEPTIONAL_SOURCE_BEFORE_SHA256=''
EXCEPTIONAL_ROLLBACK_BEFORE_SHA256=''

test ! -L "$SUMMARY_TMP"
test ! -L "$SUMMARY"
if [ -e "$SUMMARY_TMP" ]; then test -f "$SUMMARY_TMP"; fi
if [ -e "$SUMMARY" ]; then
    test -f "$SUMMARY"
    test "$(stat -c '%U %G %a' "$SUMMARY")" = 'root root 600'
fi

exec 9>"$LOCK"
if ! flock -n 9; then
    printf 'ERROR deployment_lock=busy\n'
    exit 75
fi

curl_status() {
    local url=$1
    curl -fsS --connect-timeout 5 --max-time 15 -o /dev/null -w '%{http_code}' "$url"
}

prepare_private_inventory_file() {
    local inventory=$1
    case "$inventory" in "$OUTPUT_DIR"/.find-*.inventory) ;; *) return 1 ;; esac
    test ! -L "$inventory"
    if [ -e "$inventory" ]; then
        test -f "$inventory"
        test "$(stat -c '%U %G %a' "$inventory")" = 'root root 600'
        rm -f "$inventory"
    fi
    install -o root -g root -m 0600 /dev/null "$inventory"
}

write_find_inventory() {
    local inventory=$1
    shift
    prepare_private_inventory_file "$inventory"
    if ! find "$@" -print0 > "$inventory"; then
        rm -f "$inventory"
        return 1
    fi
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

runtime_artifacts_are_operation_bound() {
    local entry name compact expected
    jq -e '
        length <= 8 and
        ([.[].name] | length == (unique | length)) and
        ([.[].final] | length == (unique | length)) and
        ([.[].candidate] | length == (unique | length)) and
        all(.[];
          (keys | sort) == ["candidate","dev","final","gid","ino","mode","name","sha256","uid"] and
          (.sha256 | test("^[a-f0-9]{64}$")) and (.mode | test("^[0-7]{3,4}$")) and
          (.uid | type == "number") and (.gid | type == "number") and
          (.dev | type == "number" and . > 0 and . == floor) and
          (.ino | type == "number" and . > 0 and . == floor))
    ' <<< "$RUNTIME_ARTIFACTS_JSON" >/dev/null || return 1
    while IFS= read -r entry; do
        name="$(jq -er '.name' <<< "$entry")" || return 1
        compact="$(jq -r '[.final,.candidate,.sha256,(.uid|tostring),(.gid|tostring),.mode] | join(":")' \
            <<< "$entry")" || return 1
        case "$name" in
            format) expected="$FORMAT:$FORMAT_CANDIDATE:$FORMAT_SHA256:0:0:644" ;;
            log) expected="$LOG:$LOG_CANDIDATE:$(sha256sum /dev/null | awk '{print $1}'):$(id -u www-data):$(getent group adm | cut -d: -f3):640" ;;
            checker) expected="$CHECKER:$CHECKER_CANDIDATE:$CHECKER_SHA256:0:0:755" ;;
            diff_checker) expected="$DIFF_CHECKER:$DIFF_CHECKER_CANDIDATE:$DIFF_CHECKER_SHA256:0:0:755" ;;
            inserter) expected="$INSERTER:$INSERTER_CANDIDATE:$INSERTER_SHA256:0:0:755" ;;
            rotate) expected="$ROTATE:$ROTATE_CANDIDATE:$ROTATE_SHA256:0:0:644" ;;
            service) expected="$SERVICE_PATH:$SERVICE_CANDIDATE:$SERVICE_SHA256:0:0:644" ;;
            timer) expected="$TIMER_PATH:$TIMER_CANDIDATE:$TIMER_SHA256:0:0:644" ;;
            *) return 1 ;;
        esac
        test "$compact" = "$expected" || return 1
    done < <(jq -c '.[]' <<< "$RUNTIME_ARTIFACTS_JSON")
}

artifact_expected_or_absent() {
    local path=$1
    local expected_sha256=$2
    local expected_metadata=$3 entry
    test ! -L "$path"
    if [ -e "$path" ]; then
        test -f "$path"
        entry="$(runtime_artifact_entry_for_path "$path")"
        test "$(jq -er '.sha256' <<< "$entry")" = "$expected_sha256"
        test "$(jq -r '[.uid,.gid,.mode] | map(tostring) | join(" ")' <<< "$entry")" = \
            "$expected_metadata"
        path_matches_exact_identity "$path" "$expected_sha256" \
            "$(jq -er '.uid' <<< "$entry")" "$(jq -er '.gid' <<< "$entry")" \
            "$(jq -er '.mode' <<< "$entry")" "$(jq -er '.dev' <<< "$entry")" \
            "$(jq -er '.ino' <<< "$entry")"
    fi
}

formal_site_matches_state() {
    local path=$1 state=$2 expected_sha256 expected_dev expected_ino
    case "$state" in
        base)
            expected_sha256=$BACKUP_SHA256
            expected_dev=${ROLLBACK_CANDIDATE_DEV:-$SITE_BASE_DEV}
            expected_ino=${ROLLBACK_CANDIDATE_INO:-$SITE_BASE_INO}
            ;;
        installed)
            test "$INSTALLED_SITE_SHA256" != absent
            test -n "$INSTALLER_CANDIDATE_DEV" && test -n "$INSTALLER_CANDIDATE_INO"
            expected_sha256=$INSTALLED_SITE_SHA256
            expected_dev=$INSTALLER_CANDIDATE_DEV
            expected_ino=$INSTALLER_CANDIDATE_INO
            ;;
        *) return 1 ;;
    esac
    path_matches_exact_identity "$path" "$expected_sha256" "$SITE_UID" "$SITE_GID" \
        "$SITE_MODE" "$expected_dev" "$expected_ino"
}

restore_candidate_is_owned_or_absent() {
    local path=$1
    test ! -L "$path"
    if [ -e "$path" ]; then
        formal_site_matches_state "$path" base
    fi
}

transaction_temp_is_owned_or_absent() {
    local path=$1
    local final_metadata=$2
    local metadata expected_sha256 entry
    test ! -L "$path"
    if [ -e "$path" ]; then
        test -f "$path"
        metadata="$(stat -c '%U %G %a' "$path")"
        case "$metadata" in
            'root root 600') return 1 ;;
            "$final_metadata")
                entry="$(runtime_artifact_entry_for_path "$path")"
                expected_sha256="$(transaction_temp_expected_sha256 "$path")"
                test "$(jq -er '.sha256' <<< "$entry")" = "$expected_sha256"
                path_matches_exact_identity "$path" "$expected_sha256" \
                    "$(jq -er '.uid' <<< "$entry")" "$(jq -er '.gid' <<< "$entry")" \
                    "$(jq -er '.mode' <<< "$entry")" "$(jq -er '.dev' <<< "$entry")" \
                    "$(jq -er '.ino' <<< "$entry")"
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

remove_transaction_temp() {
    local path=$1
    local final_metadata=$2 entry
    transaction_temp_is_owned_or_absent "$path" "$final_metadata"
    if [ -e "$path" ]; then
        entry="$(runtime_artifact_entry_for_path "$path")"
        private_cleanup_tombstone "$path" "$(jq -er '.sha256' <<< "$entry")" \
            "$(jq -er '.uid' <<< "$entry")" "$(jq -er '.gid' <<< "$entry")" \
            "$(jq -er '.mode' <<< "$entry")" "$(jq -er '.dev' <<< "$entry")" \
            "$(jq -er '.ino' <<< "$entry")" 0
    fi
    test ! -e "$path"
    test ! -L "$path"
}

remove_restore_candidate() {
    local path=$1
    local candidate_dev candidate_ino
    assert_owned_cleanup_state
    restore_candidate_is_owned_or_absent "$path"
    if [ -e "$path" ]; then
        candidate_dev="$(stat -c '%d' "$path")"
        candidate_ino="$(stat -c '%i' "$path")"
        private_cleanup_tombstone "$path" "$BACKUP_SHA256" "$SITE_UID" "$SITE_GID" \
            "$SITE_MODE" "$candidate_dev" "$candidate_ino" 0
    fi
    test ! -e "$path"
    test ! -L "$path"
    assert_owned_cleanup_state
}

remove_all_transaction_temps() {
    remove_transaction_temp "$FORMAT_CANDIDATE" 'root root 644'
    remove_transaction_temp "$ROTATE_CANDIDATE" 'root root 644'
    remove_transaction_temp "$LOG_CANDIDATE" 'www-data adm 640'
    remove_transaction_temp "$CHECKER_CANDIDATE" 'root root 755'
    remove_transaction_temp "$DIFF_CHECKER_CANDIDATE" 'root root 755'
    remove_transaction_temp "$INSERTER_CANDIDATE" 'root root 755'
    remove_transaction_temp "$SERVICE_CANDIDATE" 'root root 644'
    remove_transaction_temp "$TIMER_CANDIDATE" 'root root 644'
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

recover_runtime_artifact_cleanup_tombstones() {
    local entry name path
    runtime_artifacts_are_operation_bound || return 1
    while IFS= read -r entry; do
        name="$(jq -er '.name' <<< "$entry")" || return 1
        path="$(jq -er '.candidate' <<< "$entry")" || return 1
        recover_private_cleanup_tombstone "$path" "$(jq -er '.sha256' <<< "$entry")" \
            "$(jq -er '.uid' <<< "$entry")" "$(jq -er '.gid' <<< "$entry")" \
            "$(jq -er '.mode' <<< "$entry")" 0 "$(jq -er '.dev' <<< "$entry")" \
            "$(jq -er '.ino' <<< "$entry")" 0 || return 1
        if [ "$name" != log ]; then
            path="$(jq -er '.final' <<< "$entry")" || return 1
            recover_private_cleanup_tombstone "$path" "$(jq -er '.sha256' <<< "$entry")" \
                "$(jq -er '.uid' <<< "$entry")" "$(jq -er '.gid' <<< "$entry")" \
                "$(jq -er '.mode' <<< "$entry")" 0 "$(jq -er '.dev' <<< "$entry")" \
                "$(jq -er '.ino' <<< "$entry")" 0 || return 1
        fi
    done < <(jq -c '.[]' <<< "$RUNTIME_ARTIFACTS_JSON")
}

private_cleanup_tombstone_exists() {
    local path=$1 parent path_tag prefix
    parent=${path%/*}
    path_tag="$(printf '%s' "$path" | sha256sum | awk '{print substr($1,1,16)}')" || return 1
    prefix=".cleanup-gl-a-${ARCHIVE_OPERATION_ID}-${path_tag}-"
    python3 - "$parent" "$prefix" <<'PY'
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
            raise SystemExit(2)
        matches.append(entry.path)
if len(matches) > 1:
    raise SystemExit(2)
raise SystemExit(0 if matches else 1)
PY
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
    local dir_dev dir_ino entry provenance ledger_identity snapshot checker_path checker_entry
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
        snapshot="$(run_rotation_authorized_command rotation-verify "$TRANSACTION_ID" \
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

write_terminal_tmp_no_replace() {
    local path=$1 expected_sha256=$2
    python3 /dev/fd/3 "$path" "$expected_sha256" 3<<'PY'
import hashlib
import os
import sys

path, expected_sha256 = sys.argv[1:]
descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
try:
    digest = hashlib.sha256()
    while True:
        chunk = sys.stdin.buffer.read(1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
        view = memoryview(chunk)
        while view:
            view = view[os.write(descriptor, view):]
    if digest.hexdigest() != expected_sha256:
        raise RuntimeError("terminal tmp hash mismatch")
    os.fchmod(descriptor, 0o600)
    os.fchown(descriptor, 0, 0)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
parent = os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(parent)
finally:
    os.close(parent)
PY
}

publish_new_terminal_file_no_replace() {
    local tmp=$1 final=$2 expected_sha256=$3
    local tmp_dev tmp_ino
    test ! -e "$final" && test ! -L "$final" || return 1
    path_matches_exact "$tmp" "$expected_sha256" 0 0 600 || return 1
    tmp_dev="$(stat -c '%d' "$tmp")" || return 1
    tmp_ino="$(stat -c '%i' "$tmp")" || return 1
    sync -f "$tmp" || return 1
    path_matches_exact_identity "$tmp" "$expected_sha256" 0 0 600 \
        "$tmp_dev" "$tmp_ino" || return 1
    rename_no_replace "$tmp" "$final" || return 1
    sync -f "$final" || return 1
    path_matches_exact_identity "$final" "$expected_sha256" 0 0 600 \
        "$tmp_dev" "$tmp_ino"
}

publish_terminal_file_no_replace() {
    local final=$1 tmp=$2 previous=$3 before_sha256=$4 target_sha256=$5
    local before_dev before_ino target_dev target_ino
    test ! -e "$previous" && test ! -L "$previous" || return 1
    path_matches_exact "$final" "$before_sha256" 0 0 600 || return 1
    path_matches_exact "$tmp" "$target_sha256" 0 0 600 || return 1
    before_dev="$(stat -c '%d' "$final")" || return 1
    before_ino="$(stat -c '%i' "$final")" || return 1
    target_dev="$(stat -c '%d' "$tmp")" || return 1
    target_ino="$(stat -c '%i' "$tmp")" || return 1
    test "$before_dev" = "$target_dev" || return 1
    rename_no_replace "$final" "$previous" || return 1
    sync -f "$previous" || return 1
    path_matches_exact_identity "$previous" "$before_sha256" 0 0 600 \
        "$before_dev" "$before_ino" || return 1
    sync -f "$tmp" || return 1
    path_matches_exact_identity "$tmp" "$target_sha256" 0 0 600 \
        "$target_dev" "$target_ino" || return 1
    rename_no_replace "$tmp" "$final" || return 1
    sync -f "$final" || return 1
    path_matches_exact_identity "$final" "$target_sha256" 0 0 600 \
        "$target_dev" "$target_ino" || return 1
    path_matches_exact_identity "$previous" "$before_sha256" 0 0 600 \
        "$before_dev" "$before_ino" || return 1
    remove_exact_manifest_file "$previous" "$before_sha256" "$before_dev" "$before_ino"
}

recover_terminal_file_publication() {
    local final=$1 tmp=$2 previous=$3 before_sha256=$4 target_sha256=$5
    local previous_dev previous_ino target_dev target_ino cleanup_probe_rc
    test ! -L "$final" && test ! -L "$tmp" && test ! -L "$previous" || return 1
    if private_cleanup_tombstone_exists "$previous"; then
        path_matches_exact "$final" "$target_sha256" 0 0 600 || return 1
        test ! -e "$tmp" || return 1
        recover_private_cleanup_tombstone "$previous" "$before_sha256" 0 0 600 0 '' '' 1 \
            || return 1
    else
        cleanup_probe_rc=$?
        test "$cleanup_probe_rc" -eq 1 || return 1
    fi
    if [ -e "$previous" ]; then
        path_matches_exact "$previous" "$before_sha256" 0 0 600 || return 1
        previous_dev="$(stat -c '%d' "$previous")" || return 1
        previous_ino="$(stat -c '%i' "$previous")" || return 1
        sync -f "$previous" || return 1
        path_matches_exact_identity "$previous" "$before_sha256" 0 0 600 \
            "$previous_dev" "$previous_ino" || return 1
        if [ ! -e "$final" ]; then
            if [ -e "$tmp" ]; then
                path_matches_exact "$tmp" "$target_sha256" 0 0 600 || return 1
                target_dev="$(stat -c '%d' "$tmp")" || return 1
                target_ino="$(stat -c '%i' "$tmp")" || return 1
                sync -f "$tmp" || return 1
                path_matches_exact_identity "$tmp" "$target_sha256" 0 0 600 \
                    "$target_dev" "$target_ino" || return 1
                rename_no_replace "$tmp" "$final" || return 1
                sync -f "$final" || return 1
                path_matches_exact_identity "$final" "$target_sha256" 0 0 600 \
                    "$target_dev" "$target_ino" || return 1
            else
                rename_no_replace "$previous" "$final" || return 1
                sync -f "$final" || return 1
                path_matches_exact_identity "$final" "$before_sha256" 0 0 600 \
                    "$previous_dev" "$previous_ino" || return 1
                return 0
            fi
        else
            path_matches_exact "$final" "$target_sha256" 0 0 600 || return 1
            target_dev="$(stat -c '%d' "$final")" || return 1
            target_ino="$(stat -c '%i' "$final")" || return 1
            sync -f "$final" || return 1
            path_matches_exact_identity "$final" "$target_sha256" 0 0 600 \
                "$target_dev" "$target_ino" || return 1
            test ! -e "$tmp" || return 1
        fi
        remove_exact_manifest_file "$previous" "$before_sha256" \
            "$previous_dev" "$previous_ino" || return 1
    elif [ -e "$final" ]; then
        if path_matches_exact "$final" "$target_sha256" 0 0 600; then
            test ! -e "$tmp" || return 1
        else
            path_matches_exact "$final" "$before_sha256" 0 0 600 || return 1
            if [ -e "$tmp" ]; then
                publish_terminal_file_no_replace "$final" "$tmp" "$previous" \
                    "$before_sha256" "$target_sha256" || return 1
            fi
        fi
    else
        test ! -e "$tmp" || return 1
    fi
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
    local path=$1 expected_sha256=$2 uid=$3 gid=$4 mode=$5
    test -f "$path" || return 1
    test ! -L "$path" || return 1
    test "$(sha256sum "$path" | awk '{print $1}')" = "$expected_sha256" || return 1
    test "$(stat -c '%u %g %a' "$path")" = "$uid $gid $mode"
}

path_matches_exact_identity() {
    local path=$1 expected_sha256=$2 uid=$3 gid=$4 mode=$5
    local expected_dev=$6 expected_ino=$7
    test -f "$path" || return 1
    test ! -L "$path" || return 1
    test "$(sha256sum "$path" | awk '{print $1}')" = "$expected_sha256" || return 1
    test "$(stat -c '%u %g %a' "$path")" = "$uid $gid $mode" || return 1
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
    local displaced=$3 # Manual restore passes the journaled INSTALLER_CANDIDATE.
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

quiesce_rotation_control_plane() {
    if ! systemctl disable --now "$TIMER_UNIT" >/dev/null 2>&1; then
        test ! -e "$TIMER_PATH" && test ! -L "$TIMER_PATH" || return 1
    fi
    if ! systemctl stop "$ROTATE_SERVICE" >/dev/null 2>&1; then
        test ! -e "$SERVICE_PATH" && test ! -L "$SERVICE_PATH" || return 1
    fi
    unit_is_inactive "$TIMER_UNIT" || return 1
    unit_is_inactive "$ROTATE_SERVICE" || return 1
    timer_is_disabled
}

no_performance_logs_present() {
    write_find_inventory "$FIND_LOGS_INVENTORY" /var/log/nginx -maxdepth 1 \
        -name 'aifeeds-performance.jsonl*'
    test ! -s "$FIND_LOGS_INVENTORY"
    rm -f "$FIND_LOGS_INVENTORY"
}

probe_absent_from_audit() {
    local root=$1
    local probe=$2
    local rc
    if [ ! -e "$root" ] && [ ! -L "$root" ]; then return 0; fi
    test -d "$root"
    test ! -L "$root"
    if grep -R -a -F -q -- "$probe" "$root"; then
        return 1
    else
        rc=$?
    fi
    test "$rc" -eq 1
}

performance_logs_are_owned() {
    local path
    local name
    write_find_inventory "$FIND_LOGS_INVENTORY" /var/log/nginx -maxdepth 1 \
        -name 'aifeeds-performance.jsonl*'
    while IFS= read -r -d '' path; do
        name="${path##*/}"
        printf '%s' "$name" \
            | grep -Eq '^aifeeds-performance[.]jsonl([.][0-9]+([.]gz)?)?$'
        test -f "$path"
        test ! -L "$path"
        test "$(stat -c '%U %G %a' "$path")" = 'www-data adm 640'
    done < "$FIND_LOGS_INVENTORY"
    rm -f "$FIND_LOGS_INVENTORY"
}

rotation_state_is_owned() {
    local state_path provenance snapshot
    if [ ! -e "$ROTATE_STATE_DIR" ] && [ ! -L "$ROTATE_STATE_DIR" ]; then return 0; fi
    test -d "$ROTATE_STATE_DIR"
    test ! -L "$ROTATE_STATE_DIR"
    test "$ROTATION_STATE_IDENTITY_JSON" != null
    test "$(stat -c '%u %g %a %d %i' "$ROTATE_STATE_DIR")" = \
        "$(jq -r '.directory | [.uid,.gid,.mode,.dev,.ino] | map(tostring) | join(" ")' \
            <<< "$ROTATION_STATE_IDENTITY_JSON")"
    provenance="$(jq -cer '.provenance' <<< "$ROTATION_STATE_IDENTITY_JSON")"
    snapshot="$(run_rotation_authorized_command rotation-verify "$TRANSACTION_ID" \
        "$ROTATION_ANCHOR_IDENTITY_JSON" "$RUNTIME_ARTIFACTS_JSON")"
    write_find_inventory "$FIND_ROTATION_INVENTORY" "$ROTATE_STATE_DIR" \
        -mindepth 1 -maxdepth 1
    while IFS= read -r -d '' state_path; do
        case "$state_path" in "$ROTATE_STATE"|"$ROTATE_PROVENANCE") ;; *) return 1 ;; esac
    done < "$FIND_ROTATION_INVENTORY"
    rm -f "$FIND_ROTATION_INVENTORY"
    test "$(jq -er '.ledger.dev' <<< "$snapshot")" = "$(jq -er '.dev' <<< "$provenance")"
    test "$(jq -er '.ledger.ino' <<< "$snapshot")" = "$(jq -er '.ino' <<< "$provenance")"
}
rotation_state_candidate_is_owned_or_absent() {
    local dev ino provenance checker_path checker_entry
    test ! -L "$ROTATE_STATE_DIR_CANDIDATE" || return 1
    if [ -e "$ROTATE_STATE_DIR_CANDIDATE" ]; then
        test "$ROTATION_STATE_IDENTITY_JSON" != null || return 1
        dev="$(jq -er '.directory.dev' <<< "$ROTATION_STATE_IDENTITY_JSON")" || return 1
        ino="$(jq -er '.directory.ino' <<< "$ROTATION_STATE_IDENTITY_JSON")" || return 1
        provenance="$(jq -cer '.provenance' <<< "$ROTATION_STATE_IDENTITY_JSON")" || return 1
        directory_matches_exact_identity "$ROTATE_STATE_DIR_CANDIDATE" 0 0 750 "$dev" "$ino" \
            || return 1
        checker_path=$CHECKER
        if [ ! -e "$checker_path" ] && [ ! -L "$checker_path" ]; then checker_path=$CHECKER_CANDIDATE; fi
        checker_entry="$(runtime_artifact_entry_for_path "$checker_path")" || return 1
        path_matches_exact_identity "$checker_path" "$(jq -er '.sha256' <<< "$checker_entry")" \
            "$(jq -er '.uid' <<< "$checker_entry")" "$(jq -er '.gid' <<< "$checker_entry")" \
            "$(jq -er '.mode' <<< "$checker_entry")" "$(jq -er '.dev' <<< "$checker_entry")" \
            "$(jq -er '.ino' <<< "$checker_entry")" || return 1
        "$checker_path" rotation-verify-initialized "$TRANSACTION_ID" \
            "$ROTATE_STATE_DIR_CANDIDATE" "$(jq -er '.dev' <<< "$provenance")" \
            "$(jq -er '.ino' <<< "$provenance")" \
            "$(jq -er '.genesis_record_sha256' <<< "$provenance")" >/dev/null || return 1
    fi
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
    if not stat.S_ISREG(before.st_mode):
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

capture_site_backup_identity_stable() {
    local path=$1 expected_dev=$2 expected_ino=$3
    python3 - "$path" "$expected_dev" "$expected_ino" <<'PY'
import hashlib
import json
import os
import stat
import sys

path, expected_dev, expected_ino = sys.argv[1:]
expected_dev, expected_ino = int(expected_dev), int(expected_ino)
descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
try:
    before = os.fstat(descriptor)
    if not stat.S_ISREG(before.st_mode):
        raise RuntimeError("site backup is not regular")
    if (before.st_dev, before.st_ino) != (expected_dev, expected_ino):
        raise RuntimeError("site backup descriptor identity changed")
    with os.fdopen(os.dup(descriptor), "rb", buffering=0) as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    after = os.fstat(descriptor)
    current = os.lstat(path)
    stable_before = (
        before.st_dev, before.st_ino, before.st_uid, before.st_gid,
        stat.S_IMODE(before.st_mode), before.st_size, before.st_mtime_ns,
    )
    stable_after = (
        after.st_dev, after.st_ino, after.st_uid, after.st_gid,
        stat.S_IMODE(after.st_mode), after.st_size, after.st_mtime_ns,
    )
    if stable_before != stable_after:
        raise RuntimeError("site backup changed while hashing")
    if (current.st_dev, current.st_ino) != (expected_dev, expected_ino):
        raise RuntimeError("site backup pathname changed")
    if (current.st_uid, current.st_gid, stat.S_IMODE(current.st_mode), current.st_size) != (
        after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode), after.st_size,
    ):
        raise RuntimeError("site backup pathname metadata changed")
    result = {
        "sha256": digest,
        "uid": after.st_uid,
        "gid": after.st_gid,
        "mode": format(stat.S_IMODE(after.st_mode), "o"),
        "dev": after.st_dev,
        "ino": after.st_ino,
    }
finally:
    os.close(descriptor)
print(json.dumps(result, separators=(",", ":"), sort_keys=True))
PY
}

capture_partial_backup_identity() {
    local path=$1 expected_dev=$2 expected_ino=$3
    python3 - "$path" "$expected_dev" "$expected_ino" <<'PY'
import hashlib
import json
import os
import stat
import sys

path, expected_dev, expected_ino = sys.argv[1:]
expected_dev, expected_ino = int(expected_dev), int(expected_ino)
descriptor = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
try:
    before = os.fstat(descriptor)
    current = os.lstat(path)
    if not stat.S_ISREG(before.st_mode) or not stat.S_ISREG(current.st_mode):
        raise RuntimeError("partial backup is not regular")
    if (before.st_dev, before.st_ino) != (expected_dev, expected_ino):
        raise RuntimeError("partial backup descriptor identity changed")
    if (current.st_dev, current.st_ino) != (expected_dev, expected_ino):
        raise RuntimeError("partial backup pathname changed")
    os.fchown(descriptor, 0, 0)
    os.fchmod(descriptor, 0o600)
    os.fsync(descriptor)
    os.lseek(descriptor, 0, os.SEEK_SET)
    with os.fdopen(os.dup(descriptor), "rb", buffering=0) as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    after = os.fstat(descriptor)
    current = os.lstat(path)
    if (after.st_dev, after.st_ino) != (expected_dev, expected_ino):
        raise RuntimeError("partial backup descriptor changed")
    if (current.st_dev, current.st_ino) != (expected_dev, expected_ino):
        raise RuntimeError("partial backup pathname changed after capture")
    if (after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode)) != (0, 0, 0o600):
        raise RuntimeError("partial backup normalization failed")
    if (current.st_uid, current.st_gid, stat.S_IMODE(current.st_mode), current.st_size) != (
        0, 0, 0o600, after.st_size,
    ):
        raise RuntimeError("partial backup pathname metadata changed")
    result = {"sha256": digest, "dev": after.st_dev, "ino": after.st_ino}
finally:
    os.close(descriptor)
print(json.dumps(result, separators=(",", ":"), sort_keys=True))
PY
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
    local phase dir_dev dir_ino provenance snapshot checker_path checker_entry
    if [ ! -e "$ROTATE_STATE_DIR" ] && [ ! -L "$ROTATE_STATE_DIR" ]; then
        if [ -e "$ROTATE_STATE_DIR_CANDIDATE" ] \
            || [ -L "$ROTATE_STATE_DIR_CANDIDATE" ]; then
            if [ "${GL_A_TEST_INITIALIZED_CANDIDATE_RECOVERY_FAIL:-}" = 1 ]; then
                test -d /workspace/deploy/nginx/test-fixtures/gl-a-installer || return 1
                : > /tmp/gl-a-test/initialized-candidate-recovery-fail-hit
                return 1
            fi
            test "$ROTATION_STATE_IDENTITY_JSON" != null || return 1
            test "$ROTATION_STATE_SNAPSHOT_JSON" = null || return 1
            test "$RUNTIME_ARTIFACTS_SEALED" = false || return 1
            test "$(jq -er '.state' <<< "$ROTATION_ANCHOR_IDENTITY_JSON")" = allocated \
                || return 1
            case "$SOURCE_ORIGIN_PHASE:$RESUME_ROLLBACK_PHASE" in
                mutation_started:none|mutation_started:prepared) ;;
                *) return 1 ;;
            esac
            rotation_state_candidate_is_owned_or_absent || return 1
            checker_path=$CHECKER
            if [ ! -e "$checker_path" ] && [ ! -L "$checker_path" ]; then
                checker_path=$CHECKER_CANDIDATE
            fi
            checker_entry="$(runtime_artifact_entry_for_path "$checker_path")" || return 1
            path_matches_exact_identity "$checker_path" \
                "$(jq -er '.sha256' <<< "$checker_entry")" \
                "$(jq -er '.uid' <<< "$checker_entry")" \
                "$(jq -er '.gid' <<< "$checker_entry")" \
                "$(jq -er '.mode' <<< "$checker_entry")" \
                "$(jq -er '.dev' <<< "$checker_entry")" \
                "$(jq -er '.ino' <<< "$checker_entry")" || return 1
            provenance="$(jq -cer '.provenance' <<< "$ROTATION_STATE_IDENTITY_JSON")" \
                || return 1
            snapshot="$("$checker_path" rotation-verify-initialized "$TRANSACTION_ID" \
                "$ROTATE_STATE_DIR_CANDIDATE" "$(jq -er '.dev' <<< "$provenance")" \
                "$(jq -er '.ino' <<< "$provenance")" \
                "$(jq -er '.genesis_record_sha256' <<< "$provenance")")" || return 1
            jq -e --arg candidate_path \
                "${ROTATE_STATE_DIR_CANDIDATE}/${ROTATE_PROVENANCE##*/}" \
                --argjson dev "$(jq -er '.dev' <<< "$provenance")" \
                --argjson ino "$(jq -er '.ino' <<< "$provenance")" \
                --arg genesis "$(jq -er '.genesis_record_sha256' <<< "$provenance")" '
                (keys | sort) == ["generation","ledger","status","tail_record_sha256"] and
                .generation == 0 and .status == null and
                .tail_record_sha256 == $genesis and
                .ledger.path == $candidate_path and
                .ledger.dev == $dev and .ledger.ino == $ino and
                .ledger.uid == 0 and .ledger.gid == 0 and .ledger.mode == "600" and
                (.ledger.sha256 | test("^[a-f0-9]{64}$")) and
                (.ledger.size | type == "number" and . > 0 and . == floor)
            ' <<< "$snapshot" >/dev/null || return 1
            ROTATION_STATE_SNAPSHOT_JSON="$(jq -cS --arg path "$ROTATE_PROVENANCE" \
                '.ledger.path = $path' <<< "$snapshot")" || return 1
            phase="$(jq -er '.phase' "$ROLLBACK_JOURNAL")" || return 1
            case "$phase" in prepared|rollback_failed) ;; *) return 1 ;; esac
            write_rollback_journal "$phase"
            rotation_state_candidate_is_owned_or_absent
            return
        fi
        if [ "$ROTATION_STATE_IDENTITY_JSON" != null ]; then
            case "$RESUME_ROLLBACK_PHASE" in
                runtime_removed|nginx_reloaded|logs_archived) ;;
                *) return 1 ;;
            esac
            test "$ROTATION_STATE_SNAPSHOT_JSON" != null || return 1
        fi
        return 0
    fi
    test -d "$ROTATE_STATE_DIR" && test ! -L "$ROTATE_STATE_DIR"
    if [ "$ROTATION_STATE_IDENTITY_JSON" = null ]; then return 1; fi
    dir_dev="$(jq -er '.directory.dev' <<< "$ROTATION_STATE_IDENTITY_JSON")"
    dir_ino="$(jq -er '.directory.ino' <<< "$ROTATION_STATE_IDENTITY_JSON")"
    directory_matches_exact_identity "$ROTATE_STATE_DIR" 0 0 750 "$dir_dev" "$dir_ino"
    provenance="$(jq -cer '.provenance' <<< "$ROTATION_STATE_IDENTITY_JSON")"
    snapshot="$(run_rotation_authorized_command rotation-verify "$TRANSACTION_ID" \
        "$ROTATION_ANCHOR_IDENTITY_JSON" "$RUNTIME_ARTIFACTS_JSON")"
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
           (.status.ino | type == "number" and . > 0)))' <<< "$snapshot" >/dev/null
    ROTATION_STATE_SNAPSHOT_JSON="$(jq -cS . <<< "$snapshot")"
    phase="$(jq -er '.phase' "$ROLLBACK_JOURNAL")"
    case "$phase" in prepared|site_restored|runtime_cleanup_started|runtime_removed|nginx_reloaded|logs_archived|rollback_failed) ;;
        *) return 1 ;;
    esac
    write_rollback_journal "$phase"
    rotation_state_is_owned
}

rotation_anchor_is_owned_or_absent() {
    local state observed expected_dev expected_ino expected_sha256 expected_size observed_size
    if [ "$ROTATION_ANCHOR_IDENTITY_JSON" = null ]; then
        test ! -e "$ROTATION_ANCHOR" && test ! -L "$ROTATION_ANCHOR"
        return
    fi
    test "$(jq -er '.path' <<< "$ROTATION_ANCHOR_IDENTITY_JSON")" = "$ROTATION_ANCHOR"
    test ! -L "$ROTATION_ANCHOR"
    if [ ! -e "$ROTATION_ANCHOR" ]; then return 0; fi
    observed="$(capture_regular_file_identity_stable "$ROTATION_ANCHOR")"
    expected_dev="$(jq -er '.dev' <<< "$ROTATION_ANCHOR_IDENTITY_JSON")"
    expected_ino="$(jq -er '.ino' <<< "$ROTATION_ANCHOR_IDENTITY_JSON")"
    test "$(jq -r '[.uid,.gid,.mode,.dev,.ino] | map(tostring) | join(" ")' \
        <<< "$observed")" = "0 0 600 $expected_dev $expected_ino"
    state="$(jq -er '.state' <<< "$ROTATION_ANCHOR_IDENTITY_JSON")"
    expected_sha256="$(jq -er '.sha256' <<< "$ROTATION_ANCHOR_IDENTITY_JSON")"
    expected_size="$(jq -er '.size' <<< "$ROTATION_ANCHOR_IDENTITY_JSON")"
    observed_size="$(jq -er '.size' <<< "$observed")"
    case "$state" in
        allocated|sealed)
            test "$(jq -er '.sha256' <<< "$observed")" = "$expected_sha256"
            test "$observed_size" = "$expected_size"
            ;;
        prepared)
            test "$observed_size" -le "$expected_size"
            if [ "$observed_size" = "$expected_size" ]; then
                test "$(jq -er '.sha256' <<< "$observed")" = "$expected_sha256"
            fi
            ;;
        *) return 1 ;;
    esac
}

remove_rotation_anchor() {
    local observed
    rotation_anchor_is_owned_or_absent
    if [ -e "$ROTATION_ANCHOR" ]; then
        observed="$(capture_regular_file_identity_stable "$ROTATION_ANCHOR")"
        private_cleanup_tombstone "$ROTATION_ANCHOR" "$(jq -er '.sha256' <<< "$observed")" \
            0 0 600 "$(jq -er '.dev' <<< "$ROTATION_ANCHOR_IDENTITY_JSON")" \
            "$(jq -er '.ino' <<< "$ROTATION_ANCHOR_IDENTITY_JSON")" 0
    fi
    test ! -e "$ROTATION_ANCHOR" && test ! -L "$ROTATION_ANCHOR"
}

preflight_rotation_control_plane() {
    local dir_dev dir_ino
    artifact_expected_or_absent "$FORMAT" "$FORMAT_SHA256" '0 0 644'
    artifact_expected_or_absent "$ROTATE" "$ROTATE_SHA256" '0 0 644'
    artifact_expected_or_absent "$CHECKER" "$CHECKER_SHA256" '0 0 755'
    artifact_expected_or_absent "$DIFF_CHECKER" "$DIFF_CHECKER_SHA256" '0 0 755'
    artifact_expected_or_absent "$INSERTER" "$INSERTER_SHA256" '0 0 755'
    artifact_expected_or_absent "$SERVICE_PATH" "$SERVICE_SHA256" '0 0 644'
    artifact_expected_or_absent "$TIMER_PATH" "$TIMER_SHA256" '0 0 644'
    rotation_anchor_is_owned_or_absent
    if [ -e "$ROTATE_STATE_DIR" ] || [ -L "$ROTATE_STATE_DIR" ]; then
        test -d "$ROTATE_STATE_DIR" && test ! -L "$ROTATE_STATE_DIR"
        test "$ROTATION_STATE_IDENTITY_JSON" != null
        test "$(jq -er '.state' <<< "$ROTATION_ANCHOR_IDENTITY_JSON")" = sealed
        dir_dev="$(jq -er '.directory.dev' <<< "$ROTATION_STATE_IDENTITY_JSON")"
        dir_ino="$(jq -er '.directory.ino' <<< "$ROTATION_STATE_IDENTITY_JSON")"
        directory_matches_exact_identity "$ROTATE_STATE_DIR" 0 0 750 "$dir_dev" "$dir_ino"
        test -f "$CHECKER" && test -f "$ROTATE"
    fi
}

preflight_owned_runtime() {
    local installer_candidate_metadata
    local audit_file
    local audit_name
    local audit_base_name
    artifact_expected_or_absent "$FORMAT" "$FORMAT_SHA256" '0 0 644'
    artifact_expected_or_absent "$ROTATE" "$ROTATE_SHA256" '0 0 644'
    artifact_expected_or_absent "$CHECKER" "$CHECKER_SHA256" '0 0 755'
    artifact_expected_or_absent "$DIFF_CHECKER" "$DIFF_CHECKER_SHA256" '0 0 755'
    artifact_expected_or_absent "$INSERTER" "$INSERTER_SHA256" '0 0 755'
    artifact_expected_or_absent "$SERVICE_PATH" "$SERVICE_SHA256" '0 0 644'
    artifact_expected_or_absent "$TIMER_PATH" "$TIMER_SHA256" '0 0 644'
    test ! -L "$INSTALLER_CANDIDATE"
    if [ -e "$INSTALLER_CANDIDATE" ]; then
        test -f "$INSTALLER_CANDIDATE"
        installer_candidate_metadata="$(stat -c '%u %g %a' "$INSTALLER_CANDIDATE")"
        case "$installer_candidate_metadata" in
            '0 0 600') return 1 ;;
            "$SITE_UID $SITE_GID $SITE_MODE") ;;
            *) return 1 ;;
        esac
        test "$INSTALLED_SITE_SHA256" != absent
        test -n "$INSTALLER_CANDIDATE_DEV" && test -n "$INSTALLER_CANDIDATE_INO"
        path_matches_exact_identity "$INSTALLER_CANDIDATE" "$INSTALLED_SITE_SHA256" \
            "$SITE_UID" "$SITE_GID" "$SITE_MODE" \
            "$INSTALLER_CANDIDATE_DEV" "$INSTALLER_CANDIDATE_INO"
    fi
    restore_candidate_is_owned_or_absent "$INSTALLER_ROLLBACK_CANDIDATE"
    restore_candidate_is_owned_or_absent "$ROLLBACK_CANDIDATE"
    transaction_temp_is_owned_or_absent "$FORMAT_CANDIDATE" 'root root 644'
    transaction_temp_is_owned_or_absent "$ROTATE_CANDIDATE" 'root root 644'
    transaction_temp_is_owned_or_absent "$LOG_CANDIDATE" 'www-data adm 640'
    transaction_temp_is_owned_or_absent "$CHECKER_CANDIDATE" 'root root 755'
    transaction_temp_is_owned_or_absent "$DIFF_CHECKER_CANDIDATE" 'root root 755'
    transaction_temp_is_owned_or_absent "$INSERTER_CANDIDATE" 'root root 755'
    transaction_temp_is_owned_or_absent "$SERVICE_CANDIDATE" 'root root 644'
    transaction_temp_is_owned_or_absent "$TIMER_CANDIDATE" 'root root 644'
    rotation_state_candidate_is_owned_or_absent
    performance_logs_are_owned
    rotation_state_is_owned
    rotation_anchor_is_owned_or_absent
    if [ -e "$AUDIT_DIR" ] || [ -L "$AUDIT_DIR" ]; then
        test -d "$AUDIT_DIR"
        test ! -L "$AUDIT_DIR"
        test "$(stat -c '%U %G %a' "$AUDIT_DIR")" = 'root root 700'
        write_find_inventory "$FIND_AUDIT_INVENTORY" "$AUDIT_DIR" \
            -mindepth 1 -maxdepth 1
        while IFS= read -r -d '' audit_file; do
            test -f "$audit_file"
            test ! -L "$audit_file"
            audit_name="${audit_file##*/}"
            case "$audit_name" in
                incomplete-site-backup)
                    test "$EARLY_RECOVERY_ALLOWED" -eq 1
                    test -n "$PARTIAL_BACKUP_SHA256" && test -n "$PARTIAL_BACKUP_DEV" \
                        && test -n "$PARTIAL_BACKUP_INO"
                    path_matches_exact_identity "$audit_file" "$PARTIAL_BACKUP_SHA256" 0 0 600 \
                        "$PARTIAL_BACKUP_DEV" "$PARTIAL_BACKUP_INO"
                    ;;
                archive-manifest.json|archive-manifest.json.tmp)
                    archive_manifest_is_owned "$audit_file"
                    ;;
                archive-manifest.json.previous-gl-a-*)
                    test "$audit_file" = "$ARCHIVE_MANIFEST_PREVIOUS"
                    archive_manifest_is_owned "$audit_file"
                    ;;
                *)
                    audit_base_name="${audit_name%.candidate-gl-a-${TRANSACTION_ID}}"
                    printf '%s' "$audit_base_name" \
                        | grep -Eq '^aifeeds-performance[.]jsonl([.][0-9]+([.]gz)?)?$' \
                        || return 1
                    ;;
            esac
            test "$(stat -c '%U %G %a' "$audit_file")" = 'root root 600'
        done < "$FIND_AUDIT_INVENTORY"
        rm -f "$FIND_AUDIT_INVENTORY"
    fi
}

ensure_audit_dir_owned() {
    if [ -e "$AUDIT_DIR" ] || [ -L "$AUDIT_DIR" ]; then
        test -d "$AUDIT_DIR"
        test ! -L "$AUDIT_DIR"
        test "$(stat -c '%U %G %a' "$AUDIT_DIR")" = 'root root 700'
    else
        install -d -o root -g root -m 0700 "$AUDIT_DIR"
    fi
}

rollback_audit_is_terminal() {
    preflight_owned_runtime
    test -d "$AUDIT_DIR"
    archive_manifest_is_terminal
    test ! -e "$ARCHIVE_MANIFEST_TMP"
    test ! -L "$ARCHIVE_MANIFEST_TMP"
    test ! -e "$ARCHIVE_MANIFEST_PREVIOUS"
    test ! -L "$ARCHIVE_MANIFEST_PREVIOUS"
    write_find_inventory "$FIND_AUDIT_TERMINAL_INVENTORY" "$AUDIT_DIR" \
        -mindepth 1 -maxdepth 1 -name "*.candidate-gl-a-${TRANSACTION_ID}"
    test ! -s "$FIND_AUDIT_TERMINAL_INVENTORY"
    rm -f "$FIND_AUDIT_TERMINAL_INVENTORY"
}

# Shared source/rollback journal F/T/P/C compare-and-swap.  The update and
# terminal-pair namespaces are intentionally different; journal versions never
# use the marker's .previous-terminal paths.
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


def test_barrier(point):
    spec = os.environ.get("GL_A_TEST_JOURNAL_CAS_BARRIER", "")
    if spec != f"{kind}:{requested_phase}:{point}":
        return
    fixture = "/workspace/deploy/nginx/test-fixtures/gl-a-installer"
    if not os.path.isdir(fixture):
        fail("journal CAS barrier outside fixture")
    ready = f"/tmp/gl-a-test/journal-cas-barrier-{point}-ready"
    release = f"/tmp/gl-a-test/journal-cas-barrier-{point}-release"
    descriptor = os.open(ready, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    marker_parent = os.open(os.path.dirname(ready), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(marker_parent)
    finally:
        os.close(marker_parent)
    import time
    for _ in range(1200):
        try:
            released = os.lstat(release)
        except FileNotFoundError:
            time.sleep(0.05)
            continue
        if stat.S_ISLNK(released.st_mode) or not stat.S_ISREG(released.st_mode):
            fail("journal CAS barrier release type drift")
        return
    fail("journal CAS barrier timeout")


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


if action == "cleanup-terminal-bound":
    import re
    if kind != "source" or requested_phase != "rolled_back" or legacy_hash or not payload:
        fail("terminal bound cleanup invocation drift")
    envelope = decode_json(payload)
    if not isinstance(envelope, dict) or set(envelope) != {"marker", "marker_sha256", "before_sha256", "target_sha256"}:
        fail("terminal bound cleanup envelope drift")
    if not all(
        isinstance(envelope.get(field), str)
        and re.fullmatch(r"[a-f0-9]{64}", envelope[field]) is not None
        for field in ("marker_sha256", "before_sha256", "target_sha256")
    ):
        fail("terminal bound cleanup hash envelope drift")
    expected_marker = f"/var/backups/aifeeds-performance-log/rollback-commit-{operation_id}.json"
    if envelope.get("marker") != expected_marker:
        fail("terminal bound cleanup marker path drift")

    def validate_terminal_bound_marker():
        marker_record = read_exact(envelope["marker"])
        if marker_record["sha256"] != envelope["marker_sha256"]:
            fail("terminal bound cleanup marker hash drift")
        marker_value = decode_json(marker_record["raw"])
        if not isinstance(marker_value, dict) or canonical(marker_value) != marker_record["raw"]:
            fail("terminal bound cleanup marker is not canonical")
        if set(marker_value) != {
            "schema", "gate", "phase", "operation_id", "source_journal",
            "rollback_journal", "rollback_commit_marker", "source_before_authority",
            "rollback_before_authority", "source_before_sha256", "rollback_before_sha256",
            "source_target_sha256", "rollback_target_sha256", "prepared_marker_sha256",
            "source_journal_terminal_sha256", "rollback_journal_terminal_sha256",
        }:
            fail("terminal bound cleanup marker schema drift")
        if marker_value.get("schema") != 1 or marker_value.get("gate") != "GL-a-terminal-pair" \
                or marker_value.get("phase") != "committed":
            fail("terminal bound cleanup marker phase drift")
        if marker_value.get("operation_id") != operation_id:
            fail("terminal bound cleanup marker operation drift")
        if marker_value.get("source_journal") != final:
            fail("terminal bound cleanup marker source path drift")
        if marker_value.get("rollback_journal") != \
                f"/var/backups/aifeeds-performance-log/rollback-transaction-{operation_id}.json" \
                or marker_value.get("rollback_commit_marker") != envelope["marker"]:
            fail("terminal bound cleanup marker namespace drift")
        if marker_value.get("source_before_sha256") != envelope["before_sha256"]:
            fail("terminal bound cleanup marker before hash drift")
        if marker_value.get("source_target_sha256") != envelope["target_sha256"]:
            fail("terminal bound cleanup marker target hash drift")
        if marker_value.get("source_journal_terminal_sha256") != envelope["target_sha256"]:
            fail("terminal bound cleanup marker terminal hash drift")
        source_authority = marker_value.get("source_before_authority")
        if not isinstance(source_authority, dict) \
                or source_authority.get("sha256") != envelope["before_sha256"]:
            fail("terminal bound cleanup marker source authority drift")
        return envelope["before_sha256"], envelope["target_sha256"]

    bound_before_sha256, bound_target_sha256 = validate_terminal_bound_marker()
    legacy_hash = bound_before_sha256

    def capture_terminal_bound_state(expected_names=None):
        names = {name for name, path in (
            ("F", final), ("T", temporary), ("P", previous), ("C", cleanup),
        ) if exists(path)}
        if names not in ({"F"}, {"F", "P"}, {"F", "C"}):
            fail("invalid terminal bound cleanup state: " + "+".join(sorted(names)))
        if expected_names is not None and names != expected_names:
            fail("terminal bound cleanup state changed across barrier")
        refreshed_before, refreshed_target = validate_terminal_bound_marker()
        if (refreshed_before, refreshed_target) != (bound_before_sha256, bound_target_sha256):
            fail("terminal bound cleanup authority changed")
        final_record = parse_owned(read_exact(final))
        if final_record["sha256"] != bound_target_sha256:
            fail("terminal bound cleanup final target drift")
        require_terminal_authority(final_record, True)
        if not is_pair_terminal(final_record):
            fail("terminal bound cleanup final phase drift")
        if names == {"F"}:
            return names, final_record, None
        predecessor_path = previous if names == {"F", "P"} else cleanup
        predecessor_record = parse_owned(read_exact(predecessor_path), allow_legacy=True)
        if predecessor_record["sha256"] != bound_before_sha256:
            fail("terminal bound cleanup predecessor drift")
        validate_successor(final_record, predecessor_record)
        return names, final_record, predecessor_record

    def settle_terminal_bound():
        names, final_record, predecessor_record = capture_terminal_bound_state()
        if names == {"F"}:
            return final_record
        if names == {"F", "P"}:
            test_barrier("cleanup-terminal-bound-fp")
            names, final_record, predecessor_record = capture_terminal_bound_state({"F", "P"})
            rename_noreplace(previous, cleanup)
            fsync_parent()
            test_crash("p-to-c")
            return settle_terminal_bound()
        test_barrier("cleanup-terminal-bound-fc")
        names, final_record, predecessor_record = capture_terminal_bound_state({"F", "C"})
        exact_unlink(cleanup, predecessor_record)
        return settle_terminal_bound()

    settle_terminal_bound()
    raise SystemExit(0)


if action == "validate-authority-successor":
    import base64
    envelope = decode_json(payload)
    if not isinstance(envelope, dict) or set(envelope) != {
        "marker", "source_target", "rollback_target", "marker_sha256",
        "source_before_sha256",
    }:
        fail("terminal authority validation envelope drift")
    marker_record = read_exact(envelope["marker"])
    if envelope["marker_sha256"] \
            and marker_record["sha256"] != envelope["marker_sha256"]:
        fail("terminal authority marker hash drift")
    marker_value = decode_json(marker_record["raw"])
    if marker_value.get("source_before_sha256") != envelope["source_before_sha256"]:
        fail("terminal authority source before hash drift")
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

render_rollback_journal() {
    local phase=$1
    local source_terminal_sha256=${2:-}
    local displaced_site_dev=${PUBLISHED_DISPLACED_DEV:-}
    local displaced_site_ino=${PUBLISHED_DISPLACED_INO:-}
    jq -nc \
        --arg phase "$phase" \
        --arg failed_from "$ROLLBACK_FAILURE_FROM" \
        --arg operation_id "$TRANSACTION_ID" \
        --arg g0_commit "$G0_COMMIT" \
        --arg rollback_helper_sha256 "$ROLLBACK_HELPER_SHA256" \
        --arg source_journal "$SOURCE_JOURNAL" \
        --arg source_journal_sha256 "$SOURCE_JOURNAL_SHA256" \
        --arg source_journal_terminal_sha256 "$source_terminal_sha256" \
        --arg source_origin_phase "$SOURCE_ORIGIN_PHASE" \
        --arg rollback_journal "$ROLLBACK_JOURNAL" \
        --arg rollback_commit_marker "$ROLLBACK_COMMIT_MARKER" \
        --arg rollback_candidate "$ROLLBACK_CANDIDATE" \
        --arg rollback_candidate_dev "$ROLLBACK_CANDIDATE_DEV" \
        --arg rollback_candidate_ino "$ROLLBACK_CANDIDATE_INO" \
        --arg partial_backup_sha256 "$PARTIAL_BACKUP_SHA256" \
        --arg partial_backup_dev "$PARTIAL_BACKUP_DEV" \
        --arg partial_backup_ino "$PARTIAL_BACKUP_INO" \
        --arg installer_candidate_dev "$INSTALLER_CANDIDATE_DEV" \
        --arg installer_candidate_ino "$INSTALLER_CANDIDATE_INO" \
        --arg backup "$BACKUP" \
        --arg audit_dir "$AUDIT_DIR" \
        --arg log_archive_manifest "$ARCHIVE_MANIFEST" \
        --arg log_archive_manifest_sha256 "$TERMINAL_ARCHIVE_MANIFEST_SHA256" \
        --argjson log_archive_manifest_generation "${TERMINAL_ARCHIVE_MANIFEST_GENERATION:-0}" \
        --argjson log_archive_manifest_entry_count "${TERMINAL_ARCHIVE_MANIFEST_ENTRY_COUNT:-0}" \
        --arg backup_sha256 "$BACKUP_SHA256" \
        --arg installed_site_sha256 "$INSTALLED_SITE_SHA256" \
        --argjson original_site_uid "$SITE_UID" \
        --argjson original_site_gid "$SITE_GID" \
        --arg original_site_mode "$SITE_MODE" \
        --argjson original_site_dev "$SITE_BASE_DEV" \
        --argjson original_site_ino "$SITE_BASE_INO" \
        --arg displaced_site_dev "$displaced_site_dev" \
        --arg displaced_site_ino "$displaced_site_ino" \
        --argjson artifacts_sha256 "$ARTIFACTS_SHA256_JSON" \
        --argjson artifact_candidates "$ARTIFACT_CANDIDATES_JSON" \
        --argjson runtime_artifacts "$RUNTIME_ARTIFACTS_JSON" \
        --argjson runtime_artifacts_sealed "$RUNTIME_ARTIFACTS_SEALED" \
        --argjson rotation_state_identity "$ROTATION_STATE_IDENTITY_JSON" \
        --argjson rotation_state_snapshot "$ROTATION_STATE_SNAPSHOT_JSON" \
        --argjson rotation_anchor_identity "$ROTATION_ANCHOR_IDENTITY_JSON" \
        --argjson site_backup_identity "$SITE_BACKUP_IDENTITY_JSON" \
        --argjson runtime_cleanup "$RUNTIME_CLEANUP_JSON" \
        '{schema:1,gate:"GL-a-manual-rollback",phase:$phase,operation_id:$operation_id,
          g0_commit:$g0_commit,rollback_helper_sha256:$rollback_helper_sha256,
          source_journal:$source_journal,
          source_journal_sha256:$source_journal_sha256,source_origin_phase:$source_origin_phase,
          rollback_journal:$rollback_journal,rollback_commit_marker:$rollback_commit_marker,
          rollback_candidate:$rollback_candidate,
          site_backup:$backup,audit_dir:$audit_dir,log_archive_manifest:$log_archive_manifest,
          site_backup_sha256:$backup_sha256,
          installed_site_sha256:$installed_site_sha256,original_site_uid:$original_site_uid,
          original_site_gid:$original_site_gid,original_site_mode:$original_site_mode,
          original_site_dev:$original_site_dev,original_site_ino:$original_site_ino,
          artifacts_sha256:$artifacts_sha256,artifact_candidates:$artifact_candidates,
          runtime_artifacts:$runtime_artifacts,runtime_artifacts_sealed:$runtime_artifacts_sealed,
          rotation_state_identity:$rotation_state_identity,
          rotation_state_snapshot:$rotation_state_snapshot,
          rotation_anchor_identity:$rotation_anchor_identity,
          site_backup_identity:$site_backup_identity}
          + (if $rollback_candidate_dev != "" and $rollback_candidate_ino != "" then
               {rollback_candidate_dev:($rollback_candidate_dev | tonumber),
                rollback_candidate_ino:($rollback_candidate_ino | tonumber)}
             else {} end)
          + (if $partial_backup_sha256 != "" and $partial_backup_dev != "" and
                 $partial_backup_ino != "" then
               {partial_backup_sha256:$partial_backup_sha256,
                partial_backup_dev:($partial_backup_dev | tonumber),
                partial_backup_ino:($partial_backup_ino | tonumber)}
             else {} end)
          + (if $installer_candidate_dev != "" and $installer_candidate_ino != "" then
               {installer_candidate_dev:($installer_candidate_dev | tonumber),
                installer_candidate_ino:($installer_candidate_ino | tonumber)}
             else {} end)
          + (if $displaced_site_dev != "" and $displaced_site_ino != "" then
               {displaced_site_dev:($displaced_site_dev | tonumber),
                displaced_site_ino:($displaced_site_ino | tonumber)}
             else {} end)
          + (if $runtime_cleanup != null then {runtime_cleanup:$runtime_cleanup} else {} end)
          + (if $phase == "rollback_failed" then
               {failed_from:$failed_from}
               + (if $failed_from == "logs_archived" then
                    {log_archive_manifest_sha256:$log_archive_manifest_sha256,
                     log_archive_manifest_generation:$log_archive_manifest_generation,
                     log_archive_manifest_entry_count:$log_archive_manifest_entry_count}
                  else {} end)
             elif $phase == "logs_archived" or $phase == "rolled_back" then
               {log_archive_manifest_sha256:$log_archive_manifest_sha256,
                log_archive_manifest_generation:$log_archive_manifest_generation,
                log_archive_manifest_entry_count:$log_archive_manifest_entry_count}
               + (if $phase == "rolled_back" then
                    {source_journal_terminal_sha256:$source_journal_terminal_sha256}
                  else {} end)
             else {} end)'
}

write_rollback_journal() {
    local phase=$1
    local journal_json
    local journal_tmp="${ROLLBACK_JOURNAL}.tmp"
    local source_terminal_sha256=''
    local displaced_site_dev=${PUBLISHED_DISPLACED_DEV:-}
    local displaced_site_ino=${PUBLISHED_DISPLACED_INO:-}
    if [ -f "$ROLLBACK_JOURNAL" ] && [ ! -L "$ROLLBACK_JOURNAL" ] \
        && jq -e '.phase == "rolled_back"' "$ROLLBACK_JOURNAL" >/dev/null 2>&1; then
        test "$phase" = rolled_back || return 1
        terminal_pair_commit_marker_is_owned "$ROLLBACK_COMMIT_MARKER" || return 1
        test "$(sha256sum "$ROLLBACK_JOURNAL" | awk '{print $1}')" = \
            "$(jq -er '.rollback_target_sha256' "$ROLLBACK_COMMIT_MARKER")" || return 1
        validate_terminal_pair_intent_namespace "$ROLLBACK_COMMIT_MARKER" || return 1
        ROLLBACK_JOURNAL_CREATED=1
        ROLLBACK_TERMINAL=1
        return 0
    fi
    test ! -L "$journal_tmp"
    if [ "$phase" = rollback_failed ]; then
        if [ "$ROLLBACK_FAILURE_FROM" = none ]; then
            ROLLBACK_FAILURE_FROM="$(jq -er '
                if .phase == "rollback_failed" then .failed_from else .phase end
            ' "$ROLLBACK_JOURNAL")" || return 1
        fi
    fi
    if [ "$phase" = logs_archived ]; then
        archive_manifest_is_terminal || return 1
        TERMINAL_ARCHIVE_MANIFEST_SHA256="$(sha256sum "$ARCHIVE_MANIFEST" | awk '{print $1}')" \
            || return 1
        TERMINAL_ARCHIVE_MANIFEST_GENERATION="$(jq -er '.generation' "$ARCHIVE_MANIFEST")" \
            || return 1
        TERMINAL_ARCHIVE_MANIFEST_ENTRY_COUNT="$(jq -er '.entries | length' "$ARCHIVE_MANIFEST")" \
            || return 1
        printf '%s:%s:%s' "$TERMINAL_ARCHIVE_MANIFEST_SHA256" \
            "$TERMINAL_ARCHIVE_MANIFEST_GENERATION" "$TERMINAL_ARCHIVE_MANIFEST_ENTRY_COUNT" \
            | grep -Eq '^[a-f0-9]{64}:[0-9]+:[0-9]+$' || return 1
    fi
    if [ "$phase" = rolled_back ]; then
        terminal_pair_commit_marker_is_owned "$ROLLBACK_COMMIT_MARKER"
        test "$(jq -er '.phase' "$ROLLBACK_COMMIT_MARKER")" = prepared
        validate_terminal_pair_intent_namespace "$ROLLBACK_COMMIT_MARKER"
        if [ -e "$journal_tmp" ] || [ -L "$journal_tmp" ]; then
            test ! -L "$journal_tmp"
            test "$(sha256sum "$journal_tmp" | awk '{print $1}')" = \
                "$(jq -er '.rollback_target_sha256' "$ROLLBACK_COMMIT_MARKER")"
        fi
        journal_update_cas "$ROLLBACK_JOURNAL" "$ROLLBACK_JOURNAL_PREVIOUS_UPDATE" \
            rollback rolled_back "" "" publish-terminal-retain || return 1
    else
        journal_json="$(render_rollback_journal "$phase" "$source_terminal_sha256")" || return 1
        journal_update_cas "$ROLLBACK_JOURNAL" "$ROLLBACK_JOURNAL_PREVIOUS_UPDATE" \
            rollback "$phase" "" "$journal_json" || return 1
    fi
    # CAS already fsyncs its held file and parent dir; this redundant boundary
    # preserves failure propagation and external fault observation contracts.
    sync -f "$ROLLBACK_JOURNAL" || return 1
    ROLLBACK_JOURNAL_CREATED=1
    if [ "$phase" = rolled_back ]; then
        test "$(sha256sum "$ROLLBACK_JOURNAL" | awk '{print $1}')" = \
            "$(jq -er '.rollback_target_sha256' "$ROLLBACK_COMMIT_MARKER")"
        ROLLBACK_TERMINAL=1
    else
        LAST_ROLLBACK_PHASE="$phase"
    fi
}

render_source_journal_rolled_back() {
    local source_base=${1:-$SOURCE_JOURNAL}
    jq --arg rollback_journal "$ROLLBACK_JOURNAL" --arg origin "$SOURCE_ORIGIN_PHASE" \
        --arg rollback_candidate_dev "$ROLLBACK_CANDIDATE_DEV" \
        --arg rollback_candidate_ino "$ROLLBACK_CANDIDATE_INO" \
        --arg rollback_commit_marker "$ROLLBACK_COMMIT_MARKER" \
        --arg log_archive_manifest_sha256 "$TERMINAL_ARCHIVE_MANIFEST_SHA256" \
        --argjson log_archive_manifest_generation "$TERMINAL_ARCHIVE_MANIFEST_GENERATION" \
        --argjson log_archive_manifest_entry_count "$TERMINAL_ARCHIVE_MANIFEST_ENTRY_COUNT" \
        --argjson runtime_artifacts "$RUNTIME_ARTIFACTS_JSON" \
        --argjson runtime_artifacts_sealed "$RUNTIME_ARTIFACTS_SEALED" \
        --argjson rotation_state_identity "$ROTATION_STATE_IDENTITY_JSON" \
        --argjson rotation_state_snapshot "$ROTATION_STATE_SNAPSHOT_JSON" \
        --argjson rotation_anchor_identity "$ROTATION_ANCHOR_IDENTITY_JSON" \
        --argjson site_backup_identity "$SITE_BACKUP_IDENTITY_JSON" \
        '.phase = "rolled_back" | .rollback_journal = $rollback_journal |
         .rollback_commit_marker = $rollback_commit_marker |
         .rollback_origin_phase = $origin |
         .log_archive_manifest_sha256 = $log_archive_manifest_sha256 |
         .log_archive_manifest_generation = $log_archive_manifest_generation |
         .log_archive_manifest_entry_count = $log_archive_manifest_entry_count |
         .runtime_artifacts = $runtime_artifacts |
         .runtime_artifacts_sealed = $runtime_artifacts_sealed |
         .rotation_state_identity = $rotation_state_identity |
         .rotation_state_snapshot = $rotation_state_snapshot |
         .rotation_anchor_identity = $rotation_anchor_identity |
         .site_backup_identity = $site_backup_identity |
         (if $rollback_candidate_dev != "" and $rollback_candidate_ino != "" then
            .rollback_candidate_dev = ($rollback_candidate_dev | tonumber) |
            .rollback_candidate_ino = ($rollback_candidate_ino | tonumber)
         else del(.rollback_candidate_dev,.rollback_candidate_ino) end) |
         del(.failed_from,.journal_update)' \
        "$source_base"
}

stage_terminal_journal_update() {
    local final=$1 previous=$2 kind=$3 payload=$4
    local legacy_expected=''
    if [ "$kind" = source ]; then legacy_expected=$SOURCE_JOURNAL_SHA256; fi
    journal_update_cas "$final" "$previous" "$kind" rolled_back \
        "$legacy_expected" "$payload" stage
}

stage_terminal_pair_journals() {
    local source_json rollback_json source_target_sha256 rollback_target_sha256
    source_json="$(render_source_journal_rolled_back)" || return 1
    stage_terminal_journal_update "$SOURCE_JOURNAL" "$SOURCE_JOURNAL_PREVIOUS_UPDATE" \
        source "$source_json" || return 1
    source_target_sha256="$(sha256sum "$SOURCE_JOURNAL_TMP" | awk '{print $1}')" || return 1
    rollback_json="$(render_rollback_journal rolled_back "$source_target_sha256")" || return 1
    stage_terminal_journal_update "$ROLLBACK_JOURNAL" "$ROLLBACK_JOURNAL_PREVIOUS_UPDATE" \
        rollback "$rollback_json" || return 1
    rollback_target_sha256="$(sha256sum "$ROLLBACK_JOURNAL_TMP" | awk '{print $1}')" || return 1
    printf '%s%s' "$source_target_sha256" "$rollback_target_sha256" \
        | grep -Eq '^[a-f0-9]{128}$'
}

validate_terminal_pair_authority_successors() {
    local marker=$1 source_target=$2 rollback_target=$3
    local expected_marker_sha256=${4:-} source_before_sha256 envelope
    source_before_sha256="$(jq -er '.source_before_sha256' "$marker")" || return 1
    envelope="$(jq -nc --arg marker "$marker" --arg source_target "$source_target" \
        --arg rollback_target "$rollback_target" \
        --arg marker_sha256 "$expected_marker_sha256" \
        --arg source_before_sha256 "$source_before_sha256" \
        '{marker:$marker,source_target:$source_target,rollback_target:$rollback_target,
          marker_sha256:$marker_sha256,source_before_sha256:$source_before_sha256}')" \
        || return 1
    journal_update_cas "$SOURCE_JOURNAL" "$SOURCE_JOURNAL_PREVIOUS_UPDATE" \
        source rolled_back "$SOURCE_JOURNAL_SHA256" "$envelope" \
        validate-authority-successor || return 1
    journal_update_cas "$ROLLBACK_JOURNAL" "$ROLLBACK_JOURNAL_PREVIOUS_UPDATE" \
        rollback rolled_back "" "$envelope" validate-authority-successor
}

terminal_pair_target_records_are_consistent() {
    local source_target=$1 rollback_target=$2
    local source_before=${3:--} rollback_before=${4:--}
    local marker=${5:-}
    local expected_marker_sha256=${6:-}
    local field source_target_sha256
    local expected_source expected_rollback actual_source actual_rollback
    test -f "$source_target" && test ! -L "$source_target"
    test -f "$rollback_target" && test ! -L "$rollback_target"
    test "$(stat -c '%U %G %a' "$source_target")" = 'root root 600'
    test "$(stat -c '%U %G %a' "$rollback_target")" = 'root root 600'
    source_target_sha256="$(sha256sum "$source_target" | awk '{print $1}')"
    jq -e --arg rollback "$ROLLBACK_JOURNAL" --arg marker "$ROLLBACK_COMMIT_MARKER" \
        --arg origin "$SOURCE_ORIGIN_PHASE" \
        --arg manifest_sha "$TERMINAL_ARCHIVE_MANIFEST_SHA256" \
        --argjson manifest_generation "$TERMINAL_ARCHIVE_MANIFEST_GENERATION" \
        --argjson manifest_count "$TERMINAL_ARCHIVE_MANIFEST_ENTRY_COUNT" '
        .phase == "rolled_back" and .rollback_origin_phase == $origin and
        .rollback_journal == $rollback and .rollback_commit_marker == $marker and
        .log_archive_manifest_sha256 == $manifest_sha and
        .log_archive_manifest_generation == $manifest_generation and
        .log_archive_manifest_entry_count == $manifest_count
    ' "$source_target" >/dev/null
    jq -e --arg source "$SOURCE_JOURNAL" --arg marker "$ROLLBACK_COMMIT_MARKER" \
        --arg source_target_sha256 "$source_target_sha256" \
        --arg manifest_sha "$TERMINAL_ARCHIVE_MANIFEST_SHA256" \
        --argjson manifest_generation "$TERMINAL_ARCHIVE_MANIFEST_GENERATION" \
        --argjson manifest_count "$TERMINAL_ARCHIVE_MANIFEST_ENTRY_COUNT" '
        .phase == "rolled_back" and .source_journal == $source and
        .rollback_commit_marker == $marker and
        .source_journal_terminal_sha256 == $source_target_sha256 and
        .log_archive_manifest_sha256 == $manifest_sha and
        .log_archive_manifest_generation == $manifest_generation and
        .log_archive_manifest_entry_count == $manifest_count
    ' "$rollback_target" >/dev/null
    # A newly staged marker is not business authority.  When its marker-bound
    # predecessors remain available, derive both terminal payloads exclusively
    # from those predecessors; never let target bytes authorize themselves.
    if [ "$source_before" != - ] && [ "$rollback_before" != - ]; then
        expected_source="$(render_source_journal_rolled_back "$source_before" | jq -cS .)" \
            || return 1
        actual_source="$(jq -cS 'del(.journal_update)' "$source_target")" || return 1
        test "$actual_source" = "$expected_source" || return 1
        expected_rollback="$(render_rollback_journal rolled_back "$source_target_sha256" | jq -cS .)" \
            || return 1
        actual_rollback="$(jq -cS 'del(.journal_update)' "$rollback_target")" || return 1
        test "$actual_rollback" = "$expected_rollback" || return 1
    fi
    if [ -n "$marker" ]; then
        validate_terminal_pair_authority_successors \
            "$marker" "$source_target" "$rollback_target" \
            "$expected_marker_sha256" || return 1
    fi
    for field in g0_commit rollback_helper_sha256 rollback_candidate site_backup audit_dir \
        log_archive_manifest site_backup_sha256 installed_site_sha256 original_site_uid \
        original_site_gid original_site_mode original_site_dev original_site_ino \
        artifacts_sha256 artifact_candidates runtime_artifacts runtime_artifacts_sealed \
        rotation_state_identity rotation_state_snapshot rotation_anchor_identity \
        site_backup_identity installer_candidate_dev installer_candidate_ino \
        rollback_candidate_dev rollback_candidate_ino; do
        test "$(jq -cS --arg field "$field" '.[$field]' "$source_target")" = \
            "$(jq -cS --arg field "$field" '.[$field]' "$rollback_target")"
    done
}

validate_staged_terminal_pair_cross() {
    test -f "$SOURCE_JOURNAL_TMP" && test ! -L "$SOURCE_JOURNAL_TMP"
    test -f "$ROLLBACK_JOURNAL_TMP" && test ! -L "$ROLLBACK_JOURNAL_TMP"
    terminal_pair_target_records_are_consistent \
        "$SOURCE_JOURNAL_TMP" "$ROLLBACK_JOURNAL_TMP" \
        "$SOURCE_JOURNAL" "$ROLLBACK_JOURNAL"
}

validate_terminal_pair_intent_namespace() {
    local marker=$1 target_paths source_before source_target rollback_before rollback_target
    local expected_marker_sha256=${2:-} marker_phase
    terminal_pair_commit_marker_is_owned "$marker" || return 1
    target_paths="$(python3 - "$marker" \
        "${expected_marker_sha256:--}" "$SOURCE_JOURNAL_SHA256" \
        "$SOURCE_JOURNAL" "$SOURCE_JOURNAL_TMP" "$SOURCE_JOURNAL_PREVIOUS_UPDATE" \
        "${SOURCE_JOURNAL_PREVIOUS_UPDATE}.cleanup" \
        "$ROLLBACK_JOURNAL" "$ROLLBACK_JOURNAL_TMP" "$ROLLBACK_JOURNAL_PREVIOUS_UPDATE" \
        "${ROLLBACK_JOURNAL_PREVIOUS_UPDATE}.cleanup" <<'PY'
import hashlib
import json
import os
import stat
import sys

marker_path, expected_marker_sha256, source_external_sha256 = sys.argv[1:4]
source_paths = sys.argv[4:8]
rollback_paths = sys.argv[8:12]


def reject_constant(value):
    raise ValueError("non-finite JSON constant: " + value)


def reject_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def read_exact(path, require_canonical=True):
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
        pathname = os.lstat(path)
    finally:
        os.close(descriptor)
    stable = lambda value: (
        value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
        value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode), value.st_nlink,
    )
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 \
            or (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) != (0, 0, 0o600) \
            or not (stable(before) == stable(after) == stable(pathname)):
        raise RuntimeError("terminal namespace record identity drift")
    raw = b"".join(chunks)
    value = json.loads(
        raw.decode("utf-8"), object_pairs_hook=reject_duplicates,
        parse_constant=reject_constant,
    )
    canonical = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    if require_canonical and raw != canonical:
        raise RuntimeError("terminal namespace record is not canonical")
    return {
        "path": path, "sha256": hashlib.sha256(raw).hexdigest(), "value": value,
        "dev": before.st_dev, "ino": before.st_ino,
    }


marker_record = read_exact(marker_path)
if expected_marker_sha256 != "-" \
        and marker_record["sha256"] != expected_marker_sha256:
    raise RuntimeError("terminal namespace marker hash drift")
marker = marker_record["value"]
if marker.get("source_before_sha256") != source_external_sha256:
    raise RuntimeError("terminal namespace source authority drift")
marker_phase = marker.get("phase")
if marker_phase not in {"prepared", "committed"}:
    raise RuntimeError("terminal namespace marker phase drift")


def validate_update(record, allow_legacy=False):
    update = record["value"].get("journal_update")
    if update is None:
        if allow_legacy:
            return 0
        raise RuntimeError("terminal namespace journal_update missing")
    if set(update) != {"schema", "revision", "self_dev", "self_ino", "predecessor"} \
            or update["schema"] != 1 or type(update["revision"]) is not int \
            or update["revision"] < 0 or (update["self_dev"], update["self_ino"]) != (
                record["dev"], record["ino"],
            ):
        raise RuntimeError("terminal namespace journal_update self identity drift")
    return update["revision"]


def validate_namespace(paths, before_sha256, target_sha256, allow_legacy_before=False):
    final_path, temporary_path, previous_path, cleanup_path = paths
    records = {}
    for label, path in (
        ("final", final_path), ("temporary", temporary_path),
        ("previous", previous_path), ("cleanup", cleanup_path),
    ):
        try:
            records[label] = read_exact(path)
        except FileNotFoundError:
            pass
    final = records.get("final")
    temporary = records.get("temporary")
    predecessors = [records[key] for key in ("previous", "cleanup") if key in records]
    if len(predecessors) > 1:
        raise RuntimeError("terminal namespace has two predecessors")
    predecessor = predecessors[0] if predecessors else None
    if final is not None and final["sha256"] == before_sha256:
        if temporary is None or temporary["sha256"] != target_sha256 or predecessor is not None:
            raise RuntimeError("terminal namespace staged state drift")
        target = temporary
        before = final
    elif final is not None and final["sha256"] == target_sha256:
        if temporary is not None or (predecessor is not None and predecessor["sha256"] != before_sha256):
            raise RuntimeError("terminal namespace published state drift")
        target = final
        before = predecessor
    elif final is None:
        if temporary is None or temporary["sha256"] != target_sha256 \
                or predecessor is None or predecessor["sha256"] != before_sha256:
            raise RuntimeError("terminal namespace publication window drift")
        target = temporary
        before = predecessor
    else:
        raise RuntimeError("terminal namespace final is neither before nor target")
    if target["value"].get("phase") != "rolled_back":
        raise RuntimeError("terminal namespace target phase drift")
    update = target["value"].get("journal_update")
    validate_update(target)
    embedded = update.get("predecessor") if isinstance(update, dict) else None
    if not isinstance(embedded, dict) or embedded.get("sha256") != before_sha256:
        raise RuntimeError("terminal namespace target predecessor hash drift")
    if before is not None:
        before_revision = validate_update(before, allow_legacy=allow_legacy_before)
        if embedded != {
            "revision": before_revision, "sha256": before["sha256"],
            "dev": before["dev"], "ino": before["ino"],
        } or update.get("revision") != before_revision + 1:
            raise RuntimeError("terminal namespace exact predecessor drift")
    return (before["path"] if before is not None else "-"), target["path"]


source_before, source_target = validate_namespace(
    source_paths, marker["source_before_sha256"], marker["source_target_sha256"],
    allow_legacy_before=True,
)
rollback_before, rollback_target = validate_namespace(
    rollback_paths, marker["rollback_before_sha256"], marker["rollback_target_sha256"],
)
print("\t".join((marker_phase, source_before, source_target, rollback_before, rollback_target)))
PY
)" || return 1
    IFS=$'\t' read -r marker_phase source_before source_target rollback_before rollback_target \
        <<< "$target_paths"
    # Until the committed marker is durable, the marker-bound predecessor
    # records are the only business authority from which terminal bytes may be
    # derived.  A prepared marker alone is therefore never enough to mutate.
    if [ "$marker_phase" = prepared ]; then
        test "$source_before" != - && test "$rollback_before" != - || return 1
    fi
    terminal_pair_target_records_are_consistent \
        "$source_target" "$rollback_target" "$source_before" "$rollback_before" "$marker" \
        "$expected_marker_sha256"
}

bootstrap_terminal_staged_pair() {
    if [ -e "$SOURCE_JOURNAL_TMP" ] || [ -L "$SOURCE_JOURNAL_TMP" ] \
        || [ -e "$ROLLBACK_JOURNAL_TMP" ] || [ -L "$ROLLBACK_JOURNAL_TMP" ] \
        || [ -e "$ROLLBACK_COMMIT_MARKER" ] || [ -L "$ROLLBACK_COMMIT_MARKER" ]; then
        terminal_pair_unified_precommit_recover
    fi
}

update_source_journal_rolled_back() {
    local expected_target_sha256
    terminal_pair_commit_marker_is_owned "$ROLLBACK_COMMIT_MARKER"
    test "$(jq -er '.phase' "$ROLLBACK_COMMIT_MARKER")" = prepared
    validate_terminal_pair_intent_namespace "$ROLLBACK_COMMIT_MARKER"
    expected_target_sha256="$(jq -er '.source_target_sha256' "$ROLLBACK_COMMIT_MARKER")"
    if [ -e "$SOURCE_JOURNAL_TMP" ] || [ -L "$SOURCE_JOURNAL_TMP" ]; then
        test ! -L "$SOURCE_JOURNAL_TMP"
        test "$(sha256sum "$SOURCE_JOURNAL_TMP" | awk '{print $1}')" = "$expected_target_sha256"
    fi
    journal_update_cas "$SOURCE_JOURNAL" "$SOURCE_JOURNAL_PREVIOUS_UPDATE" source \
        rolled_back "$SOURCE_JOURNAL_SHA256" "" publish-terminal-retain
    test "$(sha256sum "$SOURCE_JOURNAL" | awk '{print $1}')" = "$expected_target_sha256"
}

terminal_pair_commit_marker_is_owned() {
    local path=$1
    test -f "$path"
    test ! -L "$path"
    test "$(stat -c '%U %G %a' "$path")" = 'root root 600'
    jq -e --arg operation_id "$TRANSACTION_ID" --arg source "$SOURCE_JOURNAL" \
        --arg rollback "$ROLLBACK_JOURNAL" --arg self "$ROLLBACK_COMMIT_MARKER" '
        .schema == 1 and .gate == "GL-a-terminal-pair" and
        .operation_id == $operation_id and .source_journal == $source and
        .rollback_journal == $rollback and .rollback_commit_marker == $self and
        (keys | sort) ==
          (if .phase == "prepared" then
             ["gate","operation_id","phase","rollback_before_authority",
              "rollback_before_sha256","rollback_commit_marker","rollback_journal",
              "rollback_target_sha256","schema","source_before_authority",
              "source_before_sha256","source_journal","source_target_sha256"]
           else
             ["gate","operation_id","phase","prepared_marker_sha256",
              "rollback_before_authority","rollback_before_sha256","rollback_commit_marker",
              "rollback_journal","rollback_journal_terminal_sha256","rollback_target_sha256",
              "schema","source_before_authority","source_before_sha256","source_journal",
              "source_journal_terminal_sha256","source_target_sha256"] end) and
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
        (.phase == "prepared" or
          (.phase == "committed" and
           (.prepared_marker_sha256 | test("^[a-f0-9]{64}$")) and
           (.source_journal_terminal_sha256 | test("^[a-f0-9]{64}$")) and
           (.rollback_journal_terminal_sha256 | test("^[a-f0-9]{64}$"))))' \
        "$path" >/dev/null
}

validate_committed_terminal_pair_candidate() {
    local candidate=$1 prepared=$2 field
    terminal_pair_commit_marker_is_owned "$prepared"
    terminal_pair_commit_marker_is_owned "$candidate"
    test "$(jq -er '.phase' "$prepared")" = prepared
    test "$(jq -er '.phase' "$candidate")" = committed
    test "$(jq -er '.prepared_marker_sha256' "$candidate")" = \
        "$(sha256sum "$prepared" | awk '{print $1}')"
    for field in schema gate operation_id source_journal rollback_journal rollback_commit_marker \
        source_before_authority rollback_before_authority source_before_sha256 \
        rollback_before_sha256 source_target_sha256 rollback_target_sha256; do
        test "$(jq -cS --arg field "$field" '.[$field]' "$prepared")" = \
            "$(jq -cS --arg field "$field" '.[$field]' "$candidate")"
    done
    test "$(jq -er '.source_journal_terminal_sha256' "$candidate")" = \
        "$(jq -er '.source_target_sha256' "$candidate")"
    test "$(jq -er '.rollback_journal_terminal_sha256' "$candidate")" = \
        "$(jq -er '.rollback_target_sha256' "$candidate")"
    test "$(jq -er '.source_target_sha256' "$candidate")" = \
        "$(sha256sum "$SOURCE_JOURNAL" | awk '{print $1}')"
    test "$(jq -er '.rollback_target_sha256' "$candidate")" = \
        "$(sha256sum "$ROLLBACK_JOURNAL" | awk '{print $1}')"
    jq -e --arg rollback "$ROLLBACK_JOURNAL" --arg marker "$ROLLBACK_COMMIT_MARKER" '
        .phase == "rolled_back" and .rollback_journal == $rollback and
        .rollback_commit_marker == $marker' "$SOURCE_JOURNAL" >/dev/null
    jq -e --arg source "$SOURCE_JOURNAL" --arg marker "$ROLLBACK_COMMIT_MARKER" \
        --arg source_sha256 "$(sha256sum "$SOURCE_JOURNAL" | awk '{print $1}')" '
        .phase == "rolled_back" and .source_journal == $source and
        .rollback_commit_marker == $marker and
        .source_journal_terminal_sha256 == $source_sha256' \
        "$ROLLBACK_JOURNAL" >/dev/null
}

capture_terminal_pair_before_authority() {
    python3 - "$SOURCE_JOURNAL" "$ROLLBACK_JOURNAL" "$SOURCE_JOURNAL_SHA256" <<'PY'
import base64
import hashlib
import json
import os
import stat
import sys

source_path, rollback_path, external_source_sha256 = sys.argv[1:]


def reject_constant(value):
    raise ValueError("non-finite JSON constant: " + value)


def reject_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def capture(path, require_canonical):
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
        raise RuntimeError("terminal before authority identity drift")
    raw = b"".join(chunks)
    value = json.loads(
        raw.decode("utf-8"), object_pairs_hook=reject_duplicates,
        parse_constant=reject_constant,
    )
    canonical = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    if require_canonical and raw != canonical:
        raise RuntimeError("terminal rollback before authority is not canonical")
    return {
        "dev": before.st_dev,
        "ino": before.st_ino,
        "raw_base64": base64.b64encode(raw).decode("ascii"),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }, value


source, _ = capture(source_path, False)
rollback, rollback_value = capture(rollback_path, True)
if source["sha256"] != external_source_sha256:
    raise RuntimeError("terminal source before authority external hash drift")
rollback_effective = rollback_value.get("phase")
if rollback_effective == "rollback_failed":
    rollback_effective = rollback_value.get("failed_from")
if rollback_effective != "logs_archived":
    raise RuntimeError("terminal rollback before authority phase drift")
print(json.dumps({
    "source_before_authority": source,
    "rollback_before_authority": rollback,
}, sort_keys=True, separators=(",", ":")))
PY
}

takeover_terminal_pair_commit_marker_tmp() {
    local final_phase tmp_phase before_sha256 target_sha256 tmp_dev tmp_ino
    test ! -L "$ROLLBACK_COMMIT_MARKER"
    test ! -L "$ROLLBACK_COMMIT_MARKER_TMP"
    test ! -L "$ROLLBACK_COMMIT_MARKER_PREVIOUS"
    if [ -e "$ROLLBACK_COMMIT_MARKER_PREVIOUS" ]; then
        terminal_pair_commit_marker_is_owned "$ROLLBACK_COMMIT_MARKER_PREVIOUS"
        test "$(jq -er '.phase' "$ROLLBACK_COMMIT_MARKER_PREVIOUS")" = prepared
        before_sha256="$(sha256sum "$ROLLBACK_COMMIT_MARKER_PREVIOUS" | awk '{print $1}')"
        if [ -e "$ROLLBACK_COMMIT_MARKER" ]; then
            test ! -e "$ROLLBACK_COMMIT_MARKER_TMP"
            validate_committed_terminal_pair_candidate \
                "$ROLLBACK_COMMIT_MARKER" "$ROLLBACK_COMMIT_MARKER_PREVIOUS"
            target_sha256="$(sha256sum "$ROLLBACK_COMMIT_MARKER" | awk '{print $1}')"
        elif [ -e "$ROLLBACK_COMMIT_MARKER_TMP" ]; then
            validate_committed_terminal_pair_candidate \
                "$ROLLBACK_COMMIT_MARKER_TMP" "$ROLLBACK_COMMIT_MARKER_PREVIOUS"
            target_sha256="$(sha256sum "$ROLLBACK_COMMIT_MARKER_TMP" | awk '{print $1}')"
        else
            target_sha256=$(printf '%064d' 0)
        fi
        recover_terminal_file_publication "$ROLLBACK_COMMIT_MARKER" \
            "$ROLLBACK_COMMIT_MARKER_TMP" "$ROLLBACK_COMMIT_MARKER_PREVIOUS" \
            "$before_sha256" "$target_sha256"
    fi
    if [ -e "$ROLLBACK_COMMIT_MARKER" ]; then
        terminal_pair_commit_marker_is_owned "$ROLLBACK_COMMIT_MARKER"
        final_phase="$(jq -er '.phase' "$ROLLBACK_COMMIT_MARKER")"
        if [ "$final_phase" = committed ]; then
            before_sha256="$(jq -er '.prepared_marker_sha256' "$ROLLBACK_COMMIT_MARKER")"
            target_sha256="$(sha256sum "$ROLLBACK_COMMIT_MARKER" | awk '{print $1}')"
            recover_terminal_file_publication "$ROLLBACK_COMMIT_MARKER" \
                "$ROLLBACK_COMMIT_MARKER_TMP" "$ROLLBACK_COMMIT_MARKER_PREVIOUS" \
                "$before_sha256" "$target_sha256"
            return 0
        fi
        test "$final_phase" = prepared
        recover_private_cleanup_tombstone "$ROLLBACK_COMMIT_MARKER_TMP" \
            "$(sha256sum "$ROLLBACK_COMMIT_MARKER" | awk '{print $1}')" \
            0 0 600 0 '' '' 1
        if [ ! -e "$ROLLBACK_COMMIT_MARKER_TMP" ]; then return 0; fi
        terminal_pair_commit_marker_is_owned "$ROLLBACK_COMMIT_MARKER_TMP"
        tmp_phase="$(jq -er '.phase' "$ROLLBACK_COMMIT_MARKER_TMP")"
        if [ "$tmp_phase" = prepared ]; then
            test "$(sha256sum "$ROLLBACK_COMMIT_MARKER" | awk '{print $1}')" = \
                "$(sha256sum "$ROLLBACK_COMMIT_MARKER_TMP" | awk '{print $1}')"
            tmp_dev="$(stat -c '%d' "$ROLLBACK_COMMIT_MARKER_TMP")"
            tmp_ino="$(stat -c '%i' "$ROLLBACK_COMMIT_MARKER_TMP")"
            remove_exact_manifest_file "$ROLLBACK_COMMIT_MARKER_TMP" \
                "$(sha256sum "$ROLLBACK_COMMIT_MARKER_TMP" | awk '{print $1}')" \
                "$tmp_dev" "$tmp_ino"
            return 0
        fi
        validate_committed_terminal_pair_candidate \
            "$ROLLBACK_COMMIT_MARKER_TMP" "$ROLLBACK_COMMIT_MARKER"
        before_sha256="$(sha256sum "$ROLLBACK_COMMIT_MARKER" | awk '{print $1}')"
        target_sha256="$(sha256sum "$ROLLBACK_COMMIT_MARKER_TMP" | awk '{print $1}')"
        recover_terminal_file_publication "$ROLLBACK_COMMIT_MARKER" \
            "$ROLLBACK_COMMIT_MARKER_TMP" "$ROLLBACK_COMMIT_MARKER_PREVIOUS" \
            "$before_sha256" "$target_sha256"
        return 0
    fi
    if [ ! -e "$ROLLBACK_COMMIT_MARKER_TMP" ]; then return 0; fi
    terminal_pair_commit_marker_is_owned "$ROLLBACK_COMMIT_MARKER_TMP"
    test "$(jq -er '.phase' "$ROLLBACK_COMMIT_MARKER_TMP")" = prepared
    target_sha256="$(sha256sum "$ROLLBACK_COMMIT_MARKER_TMP" | awk '{print $1}')"
    publish_new_terminal_file_no_replace "$ROLLBACK_COMMIT_MARKER_TMP" \
        "$ROLLBACK_COMMIT_MARKER" "$target_sha256"
}

write_terminal_pair_commit_marker() {
    local phase=$1
    local source_terminal_sha256
    local rollback_terminal_sha256
    local source_target_sha256
    local rollback_target_sha256
    local prepared_marker_sha256
    local marker_target_sha256
    local marker_json
    local before_authority_json
    test ! -e "$ROLLBACK_COMMIT_MARKER_TMP"
    test ! -L "$ROLLBACK_COMMIT_MARKER_TMP"
    case "$phase" in
        prepared)
            test ! -e "$ROLLBACK_COMMIT_MARKER"
            test ! -L "$ROLLBACK_COMMIT_MARKER"
            test -f "$SOURCE_JOURNAL_TMP" && test ! -L "$SOURCE_JOURNAL_TMP"
            test -f "$ROLLBACK_JOURNAL_TMP" && test ! -L "$ROLLBACK_JOURNAL_TMP"
            validate_staged_terminal_pair_cross
            before_authority_json="$(capture_terminal_pair_before_authority)" || return 1
            source_target_sha256="$(sha256sum "$SOURCE_JOURNAL_TMP" | awk '{print $1}')"
            rollback_target_sha256="$(sha256sum "$ROLLBACK_JOURNAL_TMP" | awk '{print $1}')"
            printf '%s%s' "$source_target_sha256" "$rollback_target_sha256" \
                | grep -Eq '^[a-f0-9]{128}$'
            marker_json="$(jq -ncS --arg operation_id "$TRANSACTION_ID" --arg source "$SOURCE_JOURNAL" \
                --arg rollback "$ROLLBACK_JOURNAL" --arg self "$ROLLBACK_COMMIT_MARKER" \
                --argjson before_authority "$before_authority_json" \
                --arg source_target_sha256 "$source_target_sha256" \
                --arg rollback_target_sha256 "$rollback_target_sha256" \
                '{schema:1,gate:"GL-a-terminal-pair",phase:"prepared",operation_id:$operation_id,
                  source_journal:$source,rollback_journal:$rollback,rollback_commit_marker:$self,
                  source_before_authority:$before_authority.source_before_authority,
                  rollback_before_authority:$before_authority.rollback_before_authority,
                  source_before_sha256:$before_authority.source_before_authority.sha256,
                  rollback_before_sha256:$before_authority.rollback_before_authority.sha256,
                  source_target_sha256:$source_target_sha256,
                  rollback_target_sha256:$rollback_target_sha256}')"
            marker_target_sha256="$(printf '%s\n' "$marker_json" | sha256sum | awk '{print $1}')"
            printf '%s\n' "$marker_json" \
                | write_terminal_tmp_no_replace "$ROLLBACK_COMMIT_MARKER_TMP" \
                    "$marker_target_sha256"
            validate_terminal_pair_intent_namespace "$ROLLBACK_COMMIT_MARKER_TMP"
            publish_new_terminal_file_no_replace "$ROLLBACK_COMMIT_MARKER_TMP" \
                "$ROLLBACK_COMMIT_MARKER" "$marker_target_sha256"
            ;;
        committed)
            assert_terminal_state
            assert_terminal_manifest_journal_mirror
            terminal_pair_commit_marker_is_owned "$ROLLBACK_COMMIT_MARKER"
            test "$(jq -er '.phase' "$ROLLBACK_COMMIT_MARKER")" = prepared
            validate_terminal_pair_intent_namespace "$ROLLBACK_COMMIT_MARKER"
            source_terminal_sha256="$(sha256sum "$SOURCE_JOURNAL" | awk '{print $1}')"
            rollback_terminal_sha256="$(sha256sum "$ROLLBACK_JOURNAL" | awk '{print $1}')"
            prepared_marker_sha256="$(sha256sum "$ROLLBACK_COMMIT_MARKER" | awk '{print $1}')"
            marker_json="$(jq -cS --arg source_terminal_sha256 "$source_terminal_sha256" \
                --arg rollback_terminal_sha256 "$rollback_terminal_sha256" \
                --arg prepared_marker_sha256 "$prepared_marker_sha256" '
                .phase = "committed" |
                .prepared_marker_sha256 = $prepared_marker_sha256 |
                .source_journal_terminal_sha256 = $source_terminal_sha256 |
                .rollback_journal_terminal_sha256 = $rollback_terminal_sha256' \
                "$ROLLBACK_COMMIT_MARKER")"
            marker_target_sha256="$(printf '%s\n' "$marker_json" | sha256sum | awk '{print $1}')"
            printf '%s\n' "$marker_json" \
                | write_terminal_tmp_no_replace "$ROLLBACK_COMMIT_MARKER_TMP" \
                    "$marker_target_sha256"
            validate_committed_terminal_pair_candidate \
                "$ROLLBACK_COMMIT_MARKER_TMP" "$ROLLBACK_COMMIT_MARKER"
            validate_terminal_pair_intent_namespace "$ROLLBACK_COMMIT_MARKER"
            publish_terminal_file_no_replace "$ROLLBACK_COMMIT_MARKER" \
                "$ROLLBACK_COMMIT_MARKER_TMP" "$ROLLBACK_COMMIT_MARKER_PREVIOUS" \
                "$prepared_marker_sha256" "$marker_target_sha256"
            ;;
        *) return 1 ;;
    esac
    terminal_pair_commit_marker_is_owned "$ROLLBACK_COMMIT_MARKER"
}

terminal_pair_test_barrier() {
    local point=$1 spec=${GL_A_TEST_TERMINAL_PAIR_BARRIER:-}
    local ready release attempt=0
    [ "$spec" = "$point" ] || return 0
    test -d /workspace/deploy/nginx/test-fixtures/gl-a-installer \
        || { printf 'terminal pair test hook outside fixture\n' >&2; return 1; }
    ready="/tmp/gl-a-test/terminal-pair-${point}-ready"
    release="/tmp/gl-a-test/terminal-pair-${point}-release"
    : > "$ready"
    while [ ! -e "$release" ] && [ ! -L "$release" ] && [ "$attempt" -lt 1200 ]; do
        sleep 0.05
        attempt=$((attempt + 1))
    done
    test -f "$release" && test ! -L "$release"
}

cleanup_terminal_pair_predecessors() {
    local terminal_source_cleanup_payload terminal_source_marker_sha256
    terminal_pair_commit_marker_is_owned "$ROLLBACK_COMMIT_MARKER" || return 1
    test "$(jq -er '.phase' "$ROLLBACK_COMMIT_MARKER")" = committed || return 1
    validate_terminal_pair_intent_namespace "$ROLLBACK_COMMIT_MARKER" || return 1
    terminal_source_marker_sha256="$(sha256sum "$ROLLBACK_COMMIT_MARKER" | awk '{print $1}')" \
        || return 1
    terminal_source_cleanup_payload="$(jq -nc \
        --arg marker "$ROLLBACK_COMMIT_MARKER" \
        --arg marker_sha256 "$terminal_source_marker_sha256" \
        --arg before_sha256 "$(jq -er '.source_before_sha256' "$ROLLBACK_COMMIT_MARKER")" \
        --arg target_sha256 "$(jq -er '.source_target_sha256' "$ROLLBACK_COMMIT_MARKER")" \
        '{marker:$marker,marker_sha256:$marker_sha256,before_sha256:$before_sha256,target_sha256:$target_sha256}')" \
        || return 1
    terminal_pair_commit_marker_is_owned "$ROLLBACK_COMMIT_MARKER" || return 1
    validate_terminal_pair_intent_namespace "$ROLLBACK_COMMIT_MARKER" \
        "$terminal_source_marker_sha256" || return 1
    terminal_pair_test_barrier source-post-marker-check || return 1
    journal_update_cas "$SOURCE_JOURNAL" "$SOURCE_JOURNAL_PREVIOUS_UPDATE" \
        source rolled_back "" "$terminal_source_cleanup_payload" cleanup-terminal-bound || return 1
    journal_update_cas "$ROLLBACK_JOURNAL" "$ROLLBACK_JOURNAL_PREVIOUS_UPDATE" \
        rollback rolled_back "" "" publish-terminal || return 1
    validate_terminal_pair_intent_namespace "$ROLLBACK_COMMIT_MARKER"
}

recover_terminal_pair_commit() {
    local marker_phase intent_marker
    assert_terminal_state
    intent_marker="$(terminal_pair_intent_marker_path)" || return 1
    if [ -n "$intent_marker" ]; then
        validate_terminal_pair_intent_namespace "$intent_marker" || return 1
    fi
    takeover_terminal_pair_commit_marker_tmp
    if [ ! -e "$ROLLBACK_COMMIT_MARKER" ] && [ ! -L "$ROLLBACK_COMMIT_MARKER" ]; then return 0; fi
    terminal_pair_commit_marker_is_owned "$ROLLBACK_COMMIT_MARKER"
    marker_phase="$(jq -er '.phase' "$ROLLBACK_COMMIT_MARKER")"
    if [ "$marker_phase" = committed ]; then
        cleanup_terminal_pair_predecessors
        validate_committed_terminal_pair_physical_chain
        return
    fi
    validate_terminal_pair_intent_namespace "$ROLLBACK_COMMIT_MARKER"
    update_source_journal_rolled_back
    assert_terminal_state
    validate_terminal_pair_intent_namespace "$ROLLBACK_COMMIT_MARKER"
    write_rollback_journal rolled_back
    assert_terminal_state
    validate_terminal_pair_intent_namespace "$ROLLBACK_COMMIT_MARKER"
    write_terminal_pair_commit_marker committed
    cleanup_terminal_pair_predecessors
    validate_committed_terminal_pair_physical_chain
}

terminal_pair_intent_marker_path() {
    local path phase
    if [ -e "$ROLLBACK_COMMIT_MARKER" ] || [ -L "$ROLLBACK_COMMIT_MARKER" ]; then
        terminal_pair_commit_marker_is_owned "$ROLLBACK_COMMIT_MARKER" || return 1
        phase="$(jq -er '.phase' "$ROLLBACK_COMMIT_MARKER")" || return 1
        if [ "$phase" = committed ]; then
            printf '%s\n' "$ROLLBACK_COMMIT_MARKER"
            return 0
        fi
    fi
    for path in "$ROLLBACK_COMMIT_MARKER" "$ROLLBACK_COMMIT_MARKER_PREVIOUS" \
        "$ROLLBACK_COMMIT_MARKER_TMP"; do
        if [ ! -e "$path" ] && [ ! -L "$path" ]; then continue; fi
        terminal_pair_commit_marker_is_owned "$path" || return 1
        phase="$(jq -er '.phase' "$path")" || return 1
        if [ "$phase" = prepared ]; then
            printf '%s\n' "$path"
            return 0
        fi
    done
    if [ -e "$ROLLBACK_COMMIT_MARKER" ] || [ -L "$ROLLBACK_COMMIT_MARKER" ]; then
        printf '%s\n' "$ROLLBACK_COMMIT_MARKER"
        return 0
    fi
    if [ -e "$ROLLBACK_COMMIT_MARKER_TMP" ] || [ -L "$ROLLBACK_COMMIT_MARKER_TMP" ]; then
        printf '%s\n' "$ROLLBACK_COMMIT_MARKER_TMP"
        return 0
    fi
    printf '\n'
}

terminal_marker_target_path() {
    local marker=$1 kind=$2 final temporary target_field expected path captured found=''
    case "$kind" in
        source)
            final=$SOURCE_JOURNAL
            temporary=$SOURCE_JOURNAL_TMP
            target_field=source_target_sha256
            ;;
        rollback)
            final=$ROLLBACK_JOURNAL
            temporary=$ROLLBACK_JOURNAL_TMP
            target_field=rollback_target_sha256
            ;;
        *) return 1 ;;
    esac
    expected="$(jq -er --arg field "$target_field" '.[$field]' "$marker")" || return 1
    for path in "$final" "$temporary"; do
        if [ ! -e "$path" ] && [ ! -L "$path" ]; then continue; fi
        test -f "$path" && test ! -L "$path" || return 1
        test "$(stat -c '%U %G %a' "$path")" = 'root root 600' || return 1
        captured="$(capture_regular_file_identity_stable "$path")" || return 1
        if [ "$(jq -er '.sha256' <<< "$captured")" = "$expected" ]; then
            test -z "$found" || return 1
            found=$path
        fi
    done
    test -n "$found" || return 1
    printf '%s\n' "$found"
}

bind_terminal_pending_source_authority() {
    local marker marker_sha256 candidate source_target rollback_target envelope captured
    marker="$(terminal_pair_intent_marker_path)" || return 1
    if [ -n "$marker" ]; then
        terminal_pair_commit_marker_is_owned "$marker" || return 1
        marker_sha256="$(sha256sum "$marker" | awk '{print $1}')" || return 1
        candidate="$(jq -er '.source_before_sha256' "$marker")" || return 1
        source_target="$(terminal_marker_target_path "$marker" source)" || return 1
        rollback_target="$(terminal_marker_target_path "$marker" rollback)" || return 1
        envelope="$(jq -nc --arg marker "$marker" --arg source_target "$source_target" \
            --arg rollback_target "$rollback_target" --arg marker_sha256 "$marker_sha256" \
            --arg source_before_sha256 "$candidate" \
            '{marker:$marker,source_target:$source_target,rollback_target:$rollback_target,
              marker_sha256:$marker_sha256,source_before_sha256:$source_before_sha256}')" \
            || return 1
        journal_update_cas "$SOURCE_JOURNAL" "$SOURCE_JOURNAL_PREVIOUS_UPDATE" \
            source rolled_back "$SOURCE_JOURNAL_EXTERNAL_SHA256" "$envelope" \
            validate-authority-successor \
            || return 1
        journal_update_cas "$ROLLBACK_JOURNAL" "$ROLLBACK_JOURNAL_PREVIOUS_UPDATE" \
            rollback rolled_back "" "$envelope" validate-authority-successor || return 1
        SOURCE_JOURNAL_SETTLED_SHA256=$candidate
        SOURCE_JOURNAL_SHA256=$candidate
        return 0
    fi
    # A marker-less terminal-pair crash may leave only staged T records.  First
    # prove F -> T through the shared CAS using the original external authority;
    # only then may the stable physical F become the active source-before hash.
    journal_update_cas "$SOURCE_JOURNAL" "$SOURCE_JOURNAL_PREVIOUS_UPDATE" \
        source rolled_back "$SOURCE_JOURNAL_EXTERNAL_SHA256" "" stage || return 1
    captured="$(capture_regular_file_identity_stable "$SOURCE_JOURNAL")" || return 1
    SOURCE_JOURNAL_SETTLED_SHA256="$(jq -er '.sha256' <<< "$captured")" || return 1
    SOURCE_JOURNAL_SHA256=$SOURCE_JOURNAL_SETTLED_SHA256
}

select_terminal_journal_load_record() {
    local kind=$1 final temporary previous cleanup marker before_field target_field
    local before_sha256='' target_sha256='' path sha256
    case "$kind" in
        source)
            final=$SOURCE_JOURNAL
            temporary=$SOURCE_JOURNAL_TMP
            previous=$SOURCE_JOURNAL_PREVIOUS_UPDATE
            cleanup="${SOURCE_JOURNAL_PREVIOUS_UPDATE}.cleanup"
            before_field=source_before_sha256
            target_field=source_target_sha256
            ;;
        rollback)
            final=$ROLLBACK_JOURNAL
            temporary=$ROLLBACK_JOURNAL_TMP
            previous=$ROLLBACK_JOURNAL_PREVIOUS_UPDATE
            cleanup="${ROLLBACK_JOURNAL_PREVIOUS_UPDATE}.cleanup"
            before_field=rollback_before_sha256
            target_field=rollback_target_sha256
            ;;
        *) return 1 ;;
    esac
    marker="$(terminal_pair_intent_marker_path)" || return 1
    if [ -n "$marker" ]; then
        before_sha256="$(jq -er --arg field "$before_field" '.[$field]' "$marker")" || return 1
        target_sha256="$(jq -er --arg field "$target_field" '.[$field]' "$marker")" || return 1
    fi
    # Prefer before-authority so terminal target bytes cannot redefine the
    # physical gate.  Every choice is read-only; publication happens later.
    for path in "$final" "$previous" "$cleanup" "$temporary"; do
        if [ ! -e "$path" ] && [ ! -L "$path" ]; then continue; fi
        test -f "$path" && test ! -L "$path" || return 1
        test "$(stat -c '%U %G %a' "$path")" = 'root root 600' || return 1
        sha256="$(sha256sum "$path" | awk '{print $1}')" || return 1
        if [ -z "$marker" ] || [ "$sha256" = "$before_sha256" ]; then
            printf '%s\n' "$path"
            return 0
        fi
    done
    for path in "$final" "$temporary"; do
        if [ ! -e "$path" ] && [ ! -L "$path" ]; then continue; fi
        sha256="$(sha256sum "$path" | awk '{print $1}')" || return 1
        if [ "$sha256" = "$target_sha256" ]; then
            printf '%s\n' "$path"
            return 0
        fi
    done
    return 1
}

terminal_pair_unified_precommit_recover() {
    local intent_marker
    assert_terminal_state
    intent_marker="$(terminal_pair_intent_marker_path)" || return 1
    if [ -z "$intent_marker" ]; then
        stage_terminal_pair_journals || return 1
        validate_staged_terminal_pair_cross || return 1
        write_terminal_pair_commit_marker prepared || return 1
    else
        validate_terminal_pair_intent_namespace "$intent_marker" || return 1
    fi
    recover_terminal_pair_commit
}

bootstrap_terminal_journal_publications() {
    terminal_pair_unified_precommit_recover
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
        .value | if .generation > 0 and (.previous_manifest_sha256 | test("^[a-f0-9]{64}$")) and
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

discover_archive_manifest_cleanup_namespace() {
    local path=$1 parent path_tag prefix
    parent=${path%/*}
    path_tag="$(printf '%s' "$path" | sha256sum | awk '{print substr($1,1,16)}')" \
        || return 1
    prefix=".cleanup-gl-a-${ARCHIVE_OPERATION_ID}-${path_tag}-"
    python3 - "$parent" "$prefix" <<'PY'
import hashlib
import json
import os
import re
import stat
import sys

parent_path, prefix = sys.argv[1:]


def stable(value):
    return (
        value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
        value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode), value.st_nlink,
    )


try:
    parent = os.open(parent_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
except FileNotFoundError:
    print('{"state":"absent"}')
    raise SystemExit(0)
try:
    names = [name for name in os.listdir(parent) if name.startswith(prefix)]
    if len(names) > 1:
        raise RuntimeError("multiple archive cleanup namespaces")
    if not names:
        print('{"state":"absent"}')
        raise SystemExit(0)
    name = names[0]
    suffix = name[len(prefix):]
    if re.fullmatch(r"[0-9]+-[0-9]+", suffix) is None:
        raise RuntimeError("archive cleanup namespace suffix drift")
    suffix_dev, suffix_ino = map(int, suffix.split("-"))
    directory = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        before = os.fstat(directory)
        namespace = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if not stat.S_ISDIR(before.st_mode) or before.st_nlink != 2 \
                or (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) != (0, 0, 0o700) \
                or stable(before) != stable(namespace):
            raise RuntimeError("archive cleanup directory identity drift")
        children = os.listdir(directory)
        if children not in ([], ["payload"]):
            raise RuntimeError("archive cleanup directory contents drift")
        result = {
            "directory": {
                "dev": before.st_dev, "ino": before.st_ino,
                "mtime_ns": before.st_mtime_ns, "nlink": before.st_nlink,
                "size": before.st_size,
            },
            "directory_path": os.path.join(parent_path, name),
            "payload_path": os.path.join(parent_path, name, "payload"),
            "state": "empty" if not children else "payload",
            "suffix_dev": suffix_dev,
            "suffix_ino": suffix_ino,
        }
        if children:
            payload = os.open("payload", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
            try:
                payload_before = os.fstat(payload)
                chunks = []
                while True:
                    chunk = os.read(payload, 1024 * 1024)
                    if not chunk:
                        break
                    chunks.append(chunk)
                payload_after = os.fstat(payload)
                payload_namespace = os.stat("payload", dir_fd=directory, follow_symlinks=False)
            finally:
                os.close(payload)
            if not stat.S_ISREG(payload_before.st_mode) or payload_before.st_nlink != 1 \
                    or (payload_before.st_uid, payload_before.st_gid,
                        stat.S_IMODE(payload_before.st_mode)) != (0, 0, 0o600) \
                    or not (stable(payload_before) == stable(payload_after) == stable(payload_namespace)):
                raise RuntimeError("archive cleanup payload identity drift")
            raw = b"".join(chunks)
            if len(raw) != payload_before.st_size:
                raise RuntimeError("archive cleanup payload short read")
            json.loads(raw.decode("utf-8"))
            result["payload_fingerprint"] = {
                "dev": payload_before.st_dev, "ino": payload_before.st_ino,
                "mtime_ns": payload_before.st_mtime_ns,
                "sha256": hashlib.sha256(raw).hexdigest(), "size": payload_before.st_size,
            }
            if (suffix_dev, suffix_ino) != (payload_before.st_dev, payload_before.st_ino):
                raise RuntimeError("archive cleanup payload suffix identity drift")
        after = os.fstat(directory)
        namespace_after = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if not (stable(before) == stable(after) == stable(namespace_after)):
            raise RuntimeError("archive cleanup directory changed during discovery")
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    finally:
        os.close(directory)
finally:
    os.close(parent)
PY
}

archive_manifest_namespace_handoff_preflight() {
    local f_present=0 t_present=0 p_present=0 topology frontier=- frontier_fp=''
    local f_capture='' t_capture='' p_capture='' c_capture c_after c_state c_payload='' c_owned=''
    local f_fp='' t_fp='' p_fp='' c_fp='' predecessor_identity predecessor_sha predecessor_dev predecessor_ino
    ARCHIVE_READ_ONLY_PREFLIGHT_FAILED=1
    if [ -e "$ARCHIVE_MANIFEST" ] || [ -L "$ARCHIVE_MANIFEST" ]; then
        f_capture="$(capture_archive_manifest_owned "$ARCHIVE_MANIFEST")" || return 1
        f_fp="$(jq -cS '.fingerprint' <<< "$f_capture")" || return 1
        f_present=1
    fi
    if [ -e "$ARCHIVE_MANIFEST_TMP" ] || [ -L "$ARCHIVE_MANIFEST_TMP" ]; then
        t_capture="$(capture_archive_manifest_owned "$ARCHIVE_MANIFEST_TMP")" || return 1
        t_fp="$(jq -cS '.fingerprint' <<< "$t_capture")" || return 1
        t_present=1
    fi
    if [ -e "$ARCHIVE_MANIFEST_PREVIOUS" ] || [ -L "$ARCHIVE_MANIFEST_PREVIOUS" ]; then
        p_capture="$(capture_archive_manifest_owned "$ARCHIVE_MANIFEST_PREVIOUS")" || return 1
        p_fp="$(jq -cS '.fingerprint' <<< "$p_capture")" || return 1
        p_present=1
    fi
    c_capture="$(discover_archive_manifest_cleanup_namespace \
        "$ARCHIVE_MANIFEST_PREVIOUS")" || return 1
    c_state="$(jq -er '.state' <<< "$c_capture")" || return 1
    topology="${f_present}${t_present}${p_present}:${c_state}"
    case "$topology" in
        000:absent)
            ;;
        010:absent)
            archive_manifest_genesis_is_valid "$ARCHIVE_MANIFEST_TMP" "$t_fp" || return 1
            frontier=$ARCHIVE_MANIFEST_TMP
            frontier_fp=$t_fp
            ;;
        100:absent)
            frontier=$ARCHIVE_MANIFEST
            frontier_fp=$f_fp
            ;;
        110:absent)
            archive_manifest_successor_is_valid \
                "$ARCHIVE_MANIFEST" "$ARCHIVE_MANIFEST_TMP" "$f_fp" "$t_fp" || return 1
            archive_manifest_successor_runtime_is_valid \
                "$ARCHIVE_MANIFEST" "$ARCHIVE_MANIFEST_TMP" "$f_fp" "$t_fp" || return 1
            frontier=$ARCHIVE_MANIFEST_TMP
            frontier_fp=$t_fp
            ;;
        011:absent)
            archive_manifest_successor_is_valid \
                "$ARCHIVE_MANIFEST_PREVIOUS" "$ARCHIVE_MANIFEST_TMP" "$p_fp" "$t_fp" \
                || return 1
            archive_manifest_successor_runtime_is_valid \
                "$ARCHIVE_MANIFEST_PREVIOUS" "$ARCHIVE_MANIFEST_TMP" "$p_fp" "$t_fp" \
                || return 1
            frontier=$ARCHIVE_MANIFEST_TMP
            frontier_fp=$t_fp
            ;;
        101:absent)
            archive_manifest_consumed_predecessor_is_valid \
                "$ARCHIVE_MANIFEST_PREVIOUS" "$ARCHIVE_MANIFEST" "$p_fp" "$f_fp" \
                || return 1
            frontier=$ARCHIVE_MANIFEST
            frontier_fp=$f_fp
            ;;
        100:payload)
            c_payload="$(jq -er '.payload_path' <<< "$c_capture")" || return 1
            c_fp="$(jq -cS '.payload_fingerprint' <<< "$c_capture")" || return 1
            c_owned="$(capture_archive_manifest_owned "$c_payload")" || return 1
            test "$(jq -cS '.fingerprint' <<< "$c_owned")" = "$c_fp" || return 1
            predecessor_identity="$(manifest_predecessor_identity_from_successor \
                "$ARCHIVE_MANIFEST" "$f_fp")" || return 1
            read -r predecessor_sha predecessor_dev predecessor_ino <<< "$predecessor_identity"
            test "$(jq -r '[.sha256,.dev,.ino] | map(tostring) | join(" ")' <<< "$c_fp")" = \
                "$predecessor_sha $predecessor_dev $predecessor_ino" || return 1
            archive_manifest_consumed_predecessor_is_valid \
                "$c_payload" "$ARCHIVE_MANIFEST" "$c_fp" "$f_fp" || return 1
            frontier=$ARCHIVE_MANIFEST
            frontier_fp=$f_fp
            ;;
        100:empty)
            predecessor_identity="$(manifest_predecessor_identity_from_successor \
                "$ARCHIVE_MANIFEST" "$f_fp")" || return 1
            read -r predecessor_sha predecessor_dev predecessor_ino <<< "$predecessor_identity"
            test "$(jq -r '[.suffix_dev,.suffix_ino] | map(tostring) | join(" ")' \
                <<< "$c_capture")" = "$predecessor_dev $predecessor_ino" || return 1
            frontier=$ARCHIVE_MANIFEST
            frontier_fp=$f_fp
            ;;
        *) return 1 ;;
    esac
    if [ "$frontier" != - ]; then
        archive_manifest_recovery_is_reachable "$frontier" "$frontier_fp" || return 1
    fi
    assert_runtime_cleanup_log_handoff "$frontier" "$frontier_fp" || return 1
    if [ "$f_present" -eq 1 ]; then
        test "$(capture_archive_manifest_owned "$ARCHIVE_MANIFEST")" = "$f_capture" || return 1
    else
        test ! -e "$ARCHIVE_MANIFEST" && test ! -L "$ARCHIVE_MANIFEST" || return 1
    fi
    if [ "$t_present" -eq 1 ]; then
        test "$(capture_archive_manifest_owned "$ARCHIVE_MANIFEST_TMP")" = "$t_capture" || return 1
    else
        test ! -e "$ARCHIVE_MANIFEST_TMP" && test ! -L "$ARCHIVE_MANIFEST_TMP" || return 1
    fi
    if [ "$p_present" -eq 1 ]; then
        test "$(capture_archive_manifest_owned "$ARCHIVE_MANIFEST_PREVIOUS")" = "$p_capture" \
            || return 1
    else
        test ! -e "$ARCHIVE_MANIFEST_PREVIOUS" \
            && test ! -L "$ARCHIVE_MANIFEST_PREVIOUS" || return 1
    fi
    c_after="$(discover_archive_manifest_cleanup_namespace \
        "$ARCHIVE_MANIFEST_PREVIOUS")" || return 1
    test "$c_after" = "$c_capture" || return 1
    ARCHIVE_READ_ONLY_PREFLIGHT_FAILED=0
}

recover_archive_manifest_cleanup_tombstone() {
    local predecessor_identity='' predecessor_sha256='' predecessor_dev='' predecessor_ino=''
    local cleanup_state
    archive_manifest_namespace_handoff_preflight || return 1
    if [ ! -d "$AUDIT_DIR" ] || [ -L "$AUDIT_DIR" ]; then return 0; fi
    cleanup_state="$(private_cleanup_tombstone_state "$ARCHIVE_MANIFEST_PREVIOUS")" || return 1
    if [ "$cleanup_state" = absent ]; then return 0; fi
    test "$cleanup_state" = present || return 1
    if [ -f "$ARCHIVE_MANIFEST" ] && [ ! -L "$ARCHIVE_MANIFEST" ]; then
        predecessor_identity="$(manifest_predecessor_identity_from_successor \
            "$ARCHIVE_MANIFEST")" || return 1
    elif [ -f "$ARCHIVE_MANIFEST_TMP" ] && [ ! -L "$ARCHIVE_MANIFEST_TMP" ]; then
        predecessor_identity="$(manifest_predecessor_identity_from_successor \
            "$ARCHIVE_MANIFEST_TMP")" || return 1
    fi
    if [ -z "$predecessor_identity" ]; then return 1; fi
    read -r predecessor_sha256 predecessor_dev predecessor_ino <<< "$predecessor_identity"
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
    archive_manifest_namespace_handoff_preflight || return 1
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
    archive_manifest_namespace_handoff_preflight || return 1
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

write_manifest_entries_inventory() {
    prepare_private_inventory_file "$FIND_MANIFEST_ENTRIES_INVENTORY"
    jq -r '.entries[] | [.source,.quarantine,.destination,.candidate,
        (.dev|tostring),(.ino|tostring),(.uid|tostring),(.gid|tostring),.mode,.state,
        ((.candidate_dev // "-")|tostring),((.candidate_ino // "-")|tostring),
        ((.destination_dev // "-")|tostring),((.destination_ino // "-")|tostring)] | @tsv' "$ARCHIVE_MANIFEST" \
        > "$FIND_MANIFEST_ENTRIES_INVENTORY"
}

assert_runtime_cleanup_log_handoff() {
    local manifest_path=${1:-$ARCHIVE_MANIFEST}
    local manifest_expected=${2:-}
    local captured
    if [ "$manifest_path" != - ] && [ -z "$manifest_expected" ]; then
        captured="$(capture_archive_manifest_owned "$manifest_path")" || return 1
        manifest_expected="$(jq -cS '.fingerprint' <<< "$captured")" || return 1
    fi
    python3 - "$RUNTIME_CLEANUP_JSON" "$LOG" "$LOG_CANDIDATE" \
        "$manifest_path" "$manifest_expected" <<'PY'
import hashlib
import json
import os
import stat
import sys

cleanup = json.loads(sys.argv[1])
log_path, runtime_candidate_path, manifest_path, manifest_expected_raw = sys.argv[2:]

# Legacy runtime_removed journals predate the immutable cleanup plan.  Their
# compatibility path is validated by the archive manifest itself.
if cleanup is None:
    raise SystemExit(0)

items = [item for item in cleanup["items"] if item["slot"] == "log"]
if len(items) != 1:
    raise RuntimeError("runtime cleanup log handoff count drift")
item = items[0]


def exists(path):
    try:
        os.lstat(path)
        return True
    except FileNotFoundError:
        return False


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
        raise RuntimeError("runtime cleanup archive manifest identity drift")
    raw = b"".join(chunks)
    fingerprint = {
        "dev": before.st_dev, "ino": before.st_ino, "mtime_ns": before.st_mtime_ns,
        "sha256": hashlib.sha256(raw).hexdigest(), "size": before.st_size,
    }
    if manifest_expected_raw and fingerprint != json.loads(manifest_expected_raw):
        raise RuntimeError("runtime cleanup archive manifest expected identity drift")
    return json.loads(
        raw.decode("utf-8"), object_pairs_hook=reject_duplicates,
        parse_constant=reject_constant,
    )


manifest = None if manifest_path == "-" else capture_manifest(manifest_path)
entries = [] if manifest is None else [
    entry for entry in manifest["entries"] if entry["source"] == log_path
]

if item["action"] == "assert_absent":
    if item["selected_path"] is not None or item["identity"] is not None \
            or entries or any(exists(path) for path in (
                log_path, runtime_candidate_path, item["tombstone"],
            )):
        raise RuntimeError("runtime cleanup absent log handoff drift")
    raise SystemExit(0)

if item["action"] == "delete":
    if item["selected_path"] != runtime_candidate_path \
            or item["paths"] != [runtime_candidate_path, log_path] \
            or entries or exists(log_path):
        raise RuntimeError("runtime cleanup candidate log delete drift")
    raise SystemExit(0)

if item["action"] != "archive_handoff" or item["selected_path"] != log_path \
        or item["paths"] != [runtime_candidate_path, log_path] \
        or exists(runtime_candidate_path) or exists(item["tombstone"]):
    raise RuntimeError("runtime cleanup live log handoff drift")

identity = item["identity"]
if set(identity) != {"uid", "gid", "mode", "dev", "ino"}:
    raise RuntimeError("runtime cleanup live log identity schema drift")
expected_source = (
    identity["dev"], identity["ino"], identity["uid"], identity["gid"],
    int(identity["mode"], 8), 1,
)


def inode_identity(value):
    return (
        value.st_dev, value.st_ino, value.st_uid, value.st_gid,
        stat.S_IMODE(value.st_mode), value.st_nlink,
    )


def capture(path, freeze_content=False):
    pathname_before = os.lstat(path)
    if stat.S_ISLNK(pathname_before.st_mode):
        raise RuntimeError("runtime cleanup log chain contains a symlink")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        digest = None
        if freeze_content:
            digest = hashlib.file_digest(
                os.fdopen(os.dup(descriptor), "rb", buffering=0), "sha256"
            ).hexdigest()
        after = os.fstat(descriptor)
        pathname_after = os.lstat(path)
    finally:
        os.close(descriptor)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        raise RuntimeError("runtime cleanup log chain is not a private regular file")
    if freeze_content:
        stable = lambda value: inode_identity(value) + (value.st_size, value.st_mtime_ns)
    else:
        stable = inode_identity
    if not (stable(pathname_before) == stable(before) == stable(after) == stable(pathname_after)):
        raise RuntimeError("runtime cleanup log chain changed during proof")
    return before, digest


def assert_manifest_binding(entry):
    expected_name = os.path.basename(log_path)
    expected_quarantine = os.path.join(
        os.path.dirname(log_path),
        "." + expected_name + ".quarantine-gl-a-" + manifest["operation_id"],
    )
    expected_destination = os.path.join(os.path.dirname(manifest_path), expected_name)
    expected_candidate = expected_destination + ".candidate-gl-a-" + manifest["operation_id"]
    if (entry["source"], entry["quarantine"], entry["destination"], entry["candidate"]) != (
        log_path, expected_quarantine, expected_destination, expected_candidate,
    ):
        raise RuntimeError("runtime cleanup log manifest path binding drift")
    if (entry["dev"], entry["ino"], entry["uid"], entry["gid"], entry["mode"]) != (
        identity["dev"], identity["ino"], identity["uid"], identity["gid"], identity["mode"],
    ):
        raise RuntimeError("runtime cleanup log manifest inode binding drift")


if exists(log_path):
    if len(entries) > 1:
        raise RuntimeError("runtime cleanup live log manifest multiplicity drift")
    before, _ = capture(log_path)
    if inode_identity(before) != expected_source:
        raise RuntimeError("runtime cleanup live log inode handoff drift")
    if entries:
        entry = entries[0]
        assert_manifest_binding(entry)
        if entry["state"] != "journaled" or any(exists(entry[key]) for key in (
            "quarantine", "candidate", "destination",
        )):
            raise RuntimeError("runtime cleanup live log pre-rename state drift")
    raise SystemExit(0)

if len(entries) != 1:
    raise RuntimeError("runtime cleanup detached log lacks manifest authority")
entry = entries[0]
assert_manifest_binding(entry)
state = entry["state"]
quarantine = entry["quarantine"]
archive_candidate = entry["candidate"]
destination = entry["destination"]
quarantine_exists = exists(quarantine)
archive_candidate_exists = exists(archive_candidate)
destination_exists = exists(destination)

if quarantine_exists:
    before, digest = capture(quarantine, state != "journaled")
    quarantine_identity = inode_identity(before)
    allowed = {expected_source}
    allowed.add((identity["dev"], identity["ino"], 0, 0, 0o600, 1))
    if quarantine_identity not in allowed:
        raise RuntimeError("runtime cleanup quarantine identity drift")
    if state != "journaled" and (
        digest != entry["final_sha256"] or before.st_size != entry["final_size"]
    ):
        raise RuntimeError("runtime cleanup quarantine content drift")

if archive_candidate_exists:
    if state != "copied" or not quarantine_exists or destination_exists:
        raise RuntimeError("runtime cleanup archive candidate state drift")
    before, digest = capture(archive_candidate, True)
    if inode_identity(before) != (
        entry["candidate_dev"], entry["candidate_ino"], 0, 0, 0o600, 1,
    ) or digest != entry["final_sha256"] or before.st_size != entry["final_size"]:
        raise RuntimeError("runtime cleanup archive candidate identity drift")

if destination_exists:
    if archive_candidate_exists or state not in {"quiescent", "copied", "archived"}:
        raise RuntimeError("runtime cleanup archive destination state drift")
    if state == "quiescent":
        destination_dev, destination_ino = identity["dev"], identity["ino"]
    elif state == "copied":
        destination_dev, destination_ino = entry["candidate_dev"], entry["candidate_ino"]
    else:
        destination_dev, destination_ino = entry["destination_dev"], entry["destination_ino"]
    before, digest = capture(destination, True)
    if inode_identity(before) != (destination_dev, destination_ino, 0, 0, 0o600, 1) \
            or digest != entry["final_sha256"] or before.st_size != entry["final_size"]:
        raise RuntimeError("runtime cleanup archive destination identity drift")

valid_shape = {
    "journaled": quarantine_exists and not archive_candidate_exists and not destination_exists,
    "quiescent": ((quarantine_exists and not archive_candidate_exists and not destination_exists)
                  or (destination_exists and not quarantine_exists and not archive_candidate_exists)),
    "copied": ((quarantine_exists and archive_candidate_exists and not destination_exists)
               or (destination_exists and not archive_candidate_exists)),
    "archived": destination_exists and not quarantine_exists and not archive_candidate_exists,
}.get(state, False)
if not valid_shape:
    raise RuntimeError("runtime cleanup log archive chain shape drift")
PY
}

archive_performance_logs() {
    local log_path
    local log_name
    local quarantine
    local destination
    local destination_candidate
    local log_dev log_ino log_uid log_gid log_mode
    local quarantine_sha256 quarantine_size quarantine_mtime
    local archive_state candidate_dev candidate_ino destination_dev destination_ino
    local copy_identity expected_destination_dev expected_destination_ino runtime_log_item
    ensure_audit_dir_owned
    ensure_archive_manifest
    assert_runtime_cleanup_log_handoff
    write_find_inventory "$FIND_SYMLINK_INVENTORY" /var/log/nginx -maxdepth 1 \
        -type l -name 'aifeeds-performance.jsonl*'
    test ! -s "$FIND_SYMLINK_INVENTORY"
    rm -f "$FIND_SYMLINK_INVENTORY"
    write_find_inventory "$FIND_ARCHIVE_INVENTORY" /var/log/nginx -maxdepth 1 \
        -type f -name 'aifeeds-performance.jsonl*'
    while IFS= read -r -d '' log_path; do
        log_name="${log_path##*/}"
        printf '%s' "$log_name" \
            | grep -Eq '^aifeeds-performance[.]jsonl([.][0-9]+([.]gz)?)?$'
        quarantine="${log_path%/*}/.${log_name}.${LOG_QUARANTINE_SUFFIX}"
        destination="$AUDIT_DIR/$log_name"
        destination_candidate="${destination}.candidate-gl-a-${ARCHIVE_OPERATION_ID}"
        test "$(stat -c '%U %G %a' "$log_path")" = 'www-data adm 640'
        if [ "$log_path" = "$LOG" ] && [ "$RUNTIME_CLEANUP_JSON" != null ]; then
            assert_runtime_cleanup_log_handoff
            runtime_log_item="$(jq -cer '
                [.items[] | select(.slot == "log")] |
                if length == 1 and .[0].action == "archive_handoff" then .[0]
                else error("live log handoff unavailable") end
            ' <<< "$RUNTIME_CLEANUP_JSON")"
            read -r log_dev log_ino log_uid log_gid log_mode <<< "$(jq -r '
                .identity | [.dev,.ino,.uid,.gid,.mode] | map(tostring) | join(" ")
            ' <<< "$runtime_log_item")"
        else
            log_dev="$(stat -c '%d' "$log_path")"
            log_ino="$(stat -c '%i' "$log_path")"
            log_uid="$(stat -c '%u' "$log_path")"
            log_gid="$(stat -c '%g' "$log_path")"
            log_mode="$(stat -c '%a' "$log_path")"
        fi
        record_log_archive_entry "$log_path" "$quarantine" "$destination" \
            "$destination_candidate" "$log_dev" "$log_ino" "$log_uid" "$log_gid" "$log_mode"
        test ! -e "$quarantine"
        test ! -L "$quarantine"
        if [ "$log_path" = "$LOG" ]; then assert_runtime_cleanup_log_handoff; fi
        rename_no_replace "$log_path" "$quarantine"
    done < "$FIND_ARCHIVE_INVENTORY"
    rm -f "$FIND_ARCHIVE_INVENTORY"
    record_log_archive_inventory_complete

    write_manifest_entries_inventory
    while IFS=$'\t' read -r log_path quarantine destination destination_candidate \
        log_dev log_ino log_uid log_gid log_mode archive_state candidate_dev candidate_ino \
        destination_dev destination_ino; do
        test ! -e "$log_path"
        test ! -L "$log_path"
        if [ -e "$quarantine" ] || [ -L "$quarantine" ]; then
            test -f "$quarantine"
            test ! -L "$quarantine"
            test "$(stat -c '%d %i' "$quarantine")" = "$log_dev $log_ino"
            case "$(stat -c '%u %g %a' "$quarantine")" in
                "$log_uid $log_gid $log_mode"|'0 0 600') ;;
                *) return 1 ;;
            esac
            wait_for_writable_inode_quiescent "$quarantine" "$log_dev" "$log_ino" "$LOG_QUIESCENCE_TIMEOUT_SECONDS"
            quarantine_sha256="$(sha256sum "$quarantine" | awk '{print $1}')"
            quarantine_size="$(stat -c '%s' "$quarantine")"
            quarantine_mtime="$(stat -c '%Y' "$quarantine")"
            record_log_archive_quiescent "$log_path" "$quarantine_sha256" \
                "$quarantine_size" "$quarantine_mtime"
            if [ "$archive_state" = journaled ]; then archive_state=quiescent; fi
        else
            quarantine_sha256="$(jq -er --arg source "$log_path" \
                '.entries[] | select(.source == $source) | .final_sha256' "$ARCHIVE_MANIFEST")"
            quarantine_size="$(jq -er --arg source "$log_path" \
                '.entries[] | select(.source == $source) | .final_size' "$ARCHIVE_MANIFEST")"
        fi

        if [ -e "$destination" ] || [ -L "$destination" ]; then
            case "$archive_state" in
                quiescent)
                    test "$(stat -c '%d' "${quarantine%/*}")" = \
                        "$(stat -c '%d' "${destination%/*}")"
                    expected_destination_dev=$log_dev
                    expected_destination_ino=$log_ino
                    ;;
                copied)
                    test "$candidate_dev" != - && test "$candidate_ino" != -
                    expected_destination_dev=$candidate_dev
                    expected_destination_ino=$candidate_ino
                    ;;
                archived)
                    test "$destination_dev" != - && test "$destination_ino" != -
                    expected_destination_dev=$destination_dev
                    expected_destination_ino=$destination_ino
                    ;;
                *) return 1 ;;
            esac
            test -f "$destination"
            test ! -L "$destination"
            test "$(stat -c '%u %g %a' "$destination")" = '0 0 600'
            test "$(sha256sum "$destination" | awk '{print $1}')" = "$quarantine_sha256"
            test "$(stat -c '%s' "$destination")" = "$quarantine_size"
            test "$(stat -c '%d %i' "$destination")" = \
                "$expected_destination_dev $expected_destination_ino"
            test ! -e "$destination_candidate"
            test ! -L "$destination_candidate"
            recover_private_cleanup_tombstone "$quarantine" "$quarantine_sha256" \
                "$log_uid" "$log_gid" "$log_mode" "$LOG_QUIESCENCE_TIMEOUT_SECONDS" \
                "$log_dev" "$log_ino" 0
            if [ -e "$quarantine" ] || [ -L "$quarantine" ]; then
                test "$(stat -c '%d' "${quarantine%/*}")" != \
                    "$(stat -c '%d' "${destination%/*}")"
                test "$(stat -c '%u %g %a' "$quarantine")" = \
                    "$log_uid $log_gid $log_mode"
                remove_exact_quiescent_file "$quarantine" "$quarantine_sha256" \
                    "$log_uid" "$log_gid" "$log_mode" "$log_dev" "$log_ino"
            fi
            record_log_archive_archived "$log_path" \
                "$expected_destination_dev" "$expected_destination_ino"
            continue
        fi
        test -f "$quarantine"
        if [ "$(stat -c '%d' "${quarantine%/*}")" = \
            "$(stat -c '%d' "${destination%/*}")" ]; then
            test "$archive_state" = quiescent
            test ! -e "$destination_candidate"
            test ! -L "$destination_candidate"
            normalize_exact_file_metadata "$quarantine" "$quarantine_sha256" \
                "$quarantine_size" "$log_dev" "$log_ino" "$log_uid" "$log_gid" "$log_mode"
            wait_for_writable_inode_quiescent "$quarantine" "$log_dev" "$log_ino" "$LOG_QUIESCENCE_TIMEOUT_SECONDS"
            test "$(sha256sum "$quarantine" | awk '{print $1}')" = "$quarantine_sha256"
            test "$(stat -c '%s' "$quarantine")" = "$quarantine_size"
            rename_no_replace "$quarantine" "$destination"
            expected_destination_dev=$log_dev
            expected_destination_ino=$log_ino
        else
            if [ -e "$destination_candidate" ] || [ -L "$destination_candidate" ]; then
                test "$archive_state" = copied
                test "$candidate_dev" != - && test "$candidate_ino" != -
                test -f "$destination_candidate"
                test ! -L "$destination_candidate"
                test "$(stat -c '%u %g %a' "$destination_candidate")" = '0 0 600'
                test "$(sha256sum "$destination_candidate" | awk '{print $1}')" = \
                    "$quarantine_sha256"
                test "$(stat -c '%s' "$destination_candidate")" = "$quarantine_size"
                test "$(stat -c '%d %i' "$destination_candidate")" = \
                    "$candidate_dev $candidate_ino"
            else
                test "$archive_state" = quiescent
                copy_identity="$(copy_file_no_replace "$quarantine" "$destination_candidate" \
                    "$quarantine_sha256" 0 0 600 "$log_dev" "$log_ino")"
                candidate_dev=${copy_identity%%:*}
                candidate_ino=${copy_identity##*:}
                record_log_archive_copied "$log_path" "$candidate_dev" "$candidate_ino"
                archive_state=copied
            fi
            sync -f "$destination_candidate"
            path_matches_exact_identity "$destination_candidate" "$quarantine_sha256" \
                0 0 600 "$candidate_dev" "$candidate_ino"
            wait_for_writable_inode_quiescent "$quarantine" "$log_dev" "$log_ino" "$LOG_QUIESCENCE_TIMEOUT_SECONDS"
            test "$(sha256sum "$quarantine" | awk '{print $1}')" = "$quarantine_sha256"
            test "$(stat -c '%s' "$quarantine")" = "$quarantine_size"
            rename_no_replace "$destination_candidate" "$destination"
            test "$(stat -c '%d %i' "$destination")" = "$candidate_dev $candidate_ino"
            remove_exact_quiescent_file "$quarantine" "$quarantine_sha256" \
                "$log_uid" "$log_gid" "$log_mode" "$log_dev" "$log_ino"
            expected_destination_dev=$candidate_dev
            expected_destination_ino=$candidate_ino
        fi
        test -f "$destination"
        test ! -L "$destination"
        test "$(stat -c '%u %g %a' "$destination")" = '0 0 600'
        test "$(sha256sum "$destination" | awk '{print $1}')" = "$quarantine_sha256"
        test "$(stat -c '%d %i' "$destination")" = \
            "$expected_destination_dev $expected_destination_ino"
        record_log_archive_archived "$log_path" \
            "$expected_destination_dev" "$expected_destination_ino"
    done < "$FIND_MANIFEST_ENTRIES_INVENTORY"
    rm -f "$FIND_MANIFEST_ENTRIES_INVENTORY"
    no_performance_logs_present
    write_find_inventory "$FIND_QUARANTINE_INVENTORY" /var/log/nginx -maxdepth 1 \
        -name ".aifeeds-performance.jsonl*.${LOG_QUARANTINE_SUFFIX}"
    test ! -s "$FIND_QUARANTINE_INVENTORY"
    rm -f "$FIND_QUARANTINE_INVENTORY"
    archive_manifest_is_terminal
}

remove_regular_artifact() {
    local path=$1
    local expected_sha256=$2
    local expected_metadata=$3 entry
    assert_owned_cleanup_state
    artifact_expected_or_absent "$path" "$expected_sha256" "$expected_metadata"
    if [ -e "$path" ]; then
        entry="$(runtime_artifact_entry_for_path "$path")"
        private_cleanup_tombstone "$path" "$expected_sha256" \
            "$(jq -er '.uid' <<< "$entry")" "$(jq -er '.gid' <<< "$entry")" \
            "$(jq -er '.mode' <<< "$entry")" "$(jq -er '.dev' <<< "$entry")" \
            "$(jq -er '.ino' <<< "$entry")" 0
    fi
    test ! -e "$path"
    test ! -L "$path"
    assert_owned_cleanup_state
}

prelive_empty_manifest_authorizes_installer_absence() {
    local before_capture after_capture
    case "$SOURCE_ORIGIN_PHASE" in initializing|prepared) ;; *) return 1 ;; esac
    test "$INSTALLED_SITE_SHA256" != absent || return 1
    test ! -e "$INSTALLER_CANDIDATE" && test ! -L "$INSTALLER_CANDIDATE" || return 1
    test ! -e "$ARCHIVE_MANIFEST_TMP" && test ! -L "$ARCHIVE_MANIFEST_TMP" || return 1
    test ! -e "$ARCHIVE_MANIFEST_PREVIOUS" && test ! -L "$ARCHIVE_MANIFEST_PREVIOUS" \
        || return 1
    before_capture="$(capture_archive_manifest_owned "$ARCHIVE_MANIFEST")" || return 1
    archive_manifest_is_terminal "$ARCHIVE_MANIFEST" "$TRANSACTION_ID" || return 1
    jq -e --arg operation_id "$TRANSACTION_ID" '
        .value |
        (keys | sort) == ["empty_inventory","entries","generation","inventory_complete",
                          "operation_id","previous_manifest_dev","previous_manifest_ino",
                          "previous_manifest_sha256","schema"] and
        .schema == 2 and .operation_id == $operation_id and .generation == 1 and
        (.previous_manifest_sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
        (.previous_manifest_dev | type == "number" and . > 0 and . == floor) and
        (.previous_manifest_ino | type == "number" and . > 0 and . == floor) and
        .inventory_complete == true and .empty_inventory == true and .entries == []' \
        <<< "$before_capture" >/dev/null || return 1
    after_capture="$(capture_archive_manifest_owned "$ARCHIVE_MANIFEST")" || return 1
    test "$after_capture" = "$before_capture" || return 1
    test ! -e "$INSTALLER_CANDIDATE" && test ! -L "$INSTALLER_CANDIDATE" || return 1
    test ! -e "$ARCHIVE_MANIFEST_TMP" && test ! -L "$ARCHIVE_MANIFEST_TMP" || return 1
    test ! -e "$ARCHIVE_MANIFEST_PREVIOUS" && test ! -L "$ARCHIVE_MANIFEST_PREVIOUS"
}

build_runtime_cleanup_plan() {
    local allow_recorded_installer_absence=0
    local allow_legacy_recorded_absence=0
    if prelive_empty_manifest_authorizes_installer_absence; then
        allow_recorded_installer_absence=1
    fi
    if [ "$RESUME_ROLLBACK_PHASE" = runtime_removed ] \
        && [ "$RUNTIME_CLEANUP_JSON" = null ]; then
        allow_legacy_recorded_absence=1
    fi
    python3 - "$TRANSACTION_ID" "$SOURCE_ORIGIN_PHASE" "$RUNTIME_ARTIFACTS_JSON" \
        "$ROTATION_STATE_IDENTITY_JSON" "$ROTATION_STATE_SNAPSHOT_JSON" \
        "$ROTATION_ANCHOR_IDENTITY_JSON" "$RUNTIME_ARTIFACTS_SEALED" \
        "$INSTALLER_CANDIDATE" "$INSTALLED_SITE_SHA256" \
        "$SITE_UID" "$SITE_GID" "$SITE_MODE" "$INSTALLER_CANDIDATE_DEV" \
        "$INSTALLER_CANDIDATE_INO" "$ROLLBACK_CANDIDATE" "$ROLLBACK_CANDIDATE_DEV" \
        "$ROLLBACK_CANDIDATE_INO" "$BACKUP_SHA256" \
        "$allow_recorded_installer_absence" "$allow_legacy_recorded_absence" <<'PY'
import hashlib
import json
import os
import stat
import sys

(operation_id, source_phase, runtime_json, state_json, snapshot_json, anchor_json,
 runtime_sealed_raw, installer_candidate, installed_sha256, site_uid, site_gid, site_mode,
 installer_dev, installer_ino, restore_candidate, restore_dev, restore_ino) = sys.argv[1:18]
restore_sha256 = sys.argv[18]
allow_recorded_installer_absence = sys.argv[19] == "1"
allow_legacy_recorded_absence = sys.argv[20] == "1"
runtime = json.loads(runtime_json)
state_identity = json.loads(state_json)
snapshot = json.loads(snapshot_json)
anchor = json.loads(anchor_json)
runtime_sealed = json.loads(runtime_sealed_raw)
if not isinstance(runtime_sealed, bool):
    raise RuntimeError("runtime seal type drift")
site_uid, site_gid = int(site_uid), int(site_gid)
EXPECTED_SLOTS = [
    "site_installer", "site_restore", "timer", "service", "rotation_status",
    "rotation_provenance", "rotation_state_dir", "rotation_anchor", "checker",
    "rotate", "format", "diff_checker", "inserter", "log",
]


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def absent(path):
    try:
        os.lstat(path)
    except FileNotFoundError:
        return True
    return False


def identity_for_file(value):
    return {
        "sha256": value["sha256"], "uid": value["uid"], "gid": value["gid"],
        "mode": value["mode"], "dev": value["dev"], "ino": value["ino"],
    }


def identity_for_handoff(value):
    return {
        "uid": value["uid"], "gid": value["gid"], "mode": value["mode"],
        "dev": value["dev"], "ino": value["ino"],
    }


def identity_for_directory(value):
    return {
        "uid": value["uid"], "gid": value["gid"], "mode": value["mode"],
        "dev": value["dev"], "ino": value["ino"],
    }


def stable_stat(value):
    return (
        value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
        value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode), value.st_nlink,
    )


def stable_handoff(value):
    return (
        value.st_dev, value.st_ino, value.st_uid, value.st_gid,
        stat.S_IMODE(value.st_mode), value.st_nlink,
    )


def current_handoff_identity(path, recorded):
    pathname_before = os.lstat(path)
    if stat.S_ISLNK(pathname_before.st_mode):
        raise RuntimeError("runtime cleanup handoff is a symlink")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        after = os.fstat(descriptor)
        pathname_after = os.lstat(path)
    finally:
        os.close(descriptor)
    if not (stable_handoff(pathname_before) == stable_handoff(before)
            == stable_handoff(after) == stable_handoff(pathname_after)):
        raise RuntimeError("runtime cleanup file changed while capturing identity")
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        raise RuntimeError("runtime cleanup handoff is not a private regular file")
    if (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode)) != (
        recorded["uid"], recorded["gid"], int(recorded["mode"], 8),
    ):
        raise RuntimeError("runtime cleanup handoff metadata drift")
    return {
        "uid": before.st_uid, "gid": before.st_gid,
        "mode": format(stat.S_IMODE(before.st_mode), "o"),
        "dev": before.st_dev, "ino": before.st_ino,
    }


def matches(path, identity, kind, action):
    try:
        value = os.lstat(path)
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(value.st_mode):
        raise RuntimeError("runtime cleanup path is a symlink")
    expected_mode = int(identity["mode"], 8)
    if (value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode), value.st_dev, value.st_ino) != (
        identity["uid"], identity["gid"], expected_mode, identity["dev"], identity["ino"],
    ):
        return False
    if kind == "directory" and not stat.S_ISDIR(value.st_mode):
        return False
    if kind == "file" and (not stat.S_ISREG(value.st_mode) or value.st_nlink != 1):
        return False
    flags = os.O_RDONLY | os.O_NOFOLLOW
    if kind == "directory":
        flags |= os.O_DIRECTORY
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        digest = None
        if kind == "file" and action != "archive_handoff":
            digest = hashlib.file_digest(
                os.fdopen(os.dup(descriptor), "rb", buffering=0), "sha256"
            ).hexdigest()
        after = os.fstat(descriptor)
        pathname_after = os.lstat(path)
    finally:
        os.close(descriptor)
    stable_identity = stable_handoff if action == "archive_handoff" else stable_stat
    if not (stable_identity(value) == stable_identity(before) == stable_identity(after)
            == stable_identity(pathname_after)):
        raise RuntimeError("runtime cleanup path changed while proving identity")
    return kind == "directory" or action == "archive_handoff" \
        or digest == identity["sha256"]


items = []


def add(slot, action, kind, paths, identity, allow_recorded_absence=False):
    if slot != EXPECTED_SLOTS[len(items)]:
        raise RuntimeError("runtime cleanup slot order drift")
    selected = [
        path for path in paths
        if identity is not None and matches(path, identity, kind, action)
    ]
    existing = [path for path in paths if not absent(path)]
    if action == "assert_absent":
        if existing:
            raise RuntimeError("recorded-absent runtime path exists")
        selected_path = None
    elif allow_recorded_absence and not existing:
        tombstone_paths = [
            path + f".runtime-cleanup-gl-a-{operation_id}-{len(items):02d}"
            for path in paths
        ]
        existing_tombstones = [path for path in tombstone_paths if not absent(path)]
        selected_tombstones = [
            path for path in tombstone_paths
            if identity is not None and matches(path, identity, kind, action)
        ]
        if existing_tombstones:
            if len(selected_tombstones) != 1 or existing_tombstones != selected_tombstones:
                raise RuntimeError("legacy runtime cleanup tombstone identity drift")
            selected_path = paths[tombstone_paths.index(selected_tombstones[0])]
        else:
            action = "assert_absent"
            identity = None
            selected_path = None
    else:
        if len(selected) != 1 or existing != selected:
            raise RuntimeError("recorded runtime identity must occupy exactly one path")
        selected_path = selected[0]
    tombstone_base = selected_path or paths[0]
    items.append({
        "slot": slot, "action": action, "kind": kind, "paths": paths,
        "selected_path": selected_path,
        "tombstone": tombstone_base + f".runtime-cleanup-gl-a-{operation_id}-{len(items):02d}",
        "identity": identity,
    })


if installed_sha256 == "absent":
    add("site_installer", "assert_absent", "file", [installer_candidate], None, True)
else:
    installer_identity = {
        "sha256": installed_sha256, "uid": site_uid, "gid": site_gid, "mode": site_mode,
        "dev": int(installer_dev), "ino": int(installer_ino),
    }
    add("site_installer", "delete", "file", [installer_candidate], installer_identity,
        allow_recorded_installer_absence or allow_legacy_recorded_absence)

# site_restored is durable evidence that the operation-bound restore candidate
# was consumed by the exact SITE CAS; current pathname absence is only checked.
add("site_restore", "assert_absent", "file", [restore_candidate], None, True)

runtime_by_name = {item["name"]: item for item in runtime}


def add_runtime(slot, name, action="delete"):
    entry = runtime_by_name.get(name)
    if entry is None:
        add(slot, "assert_absent", "file", [
            {
                "timer": "/etc/systemd/system/aifeeds-performance-logrotate.timer",
                "service": "/etc/systemd/system/aifeeds-performance-logrotate.service",
                "checker": "/usr/local/sbin/aifeeds-check-nginx-request-id",
                "rotate": "/etc/aifeeds-performance-logrotate.conf",
                "format": "/etc/nginx/conf.d/aifeeds-performance-log.conf",
                "diff_checker": "/usr/local/sbin/aifeeds-verify-nginx-request-id-diff",
                "inserter": "/usr/local/sbin/aifeeds-insert-nginx-request-id",
                "log": "/var/log/nginx/aifeeds-performance.jsonl",
            }[name]
        ], None, True)
        return
    identity = identity_for_file(entry)
    if action == "archive_handoff":
        if not absent(entry["candidate"]):
            raise RuntimeError("runtime cleanup log candidate exists")
        identity = current_handoff_identity(entry["final"], entry)
    add(slot, action, "file", [entry["candidate"], entry["final"]], identity,
        allow_legacy_recorded_absence and action != "archive_handoff")


add_runtime("timer", "timer")
add_runtime("service", "service")

status = snapshot.get("status") if isinstance(snapshot, dict) else None
if status is None:
    add("rotation_status", "assert_absent", "file", [
        "/var/lib/aifeeds-performance-logrotate/status",
    ], None, True)
else:
    add("rotation_status", "delete", "file", [status["path"]], identity_for_file(status),
        allow_legacy_recorded_absence)

if state_identity is None:
    add("rotation_provenance", "assert_absent", "file", [
        "/var/lib/aifeeds-performance-logrotate/rotation-provenance.jsonl",
    ], None, True)
    add("rotation_state_dir", "assert_absent", "directory", [
        "/var/lib/aifeeds-performance-logrotate.candidate-gl-a-" + operation_id,
        "/var/lib/aifeeds-performance-logrotate",
    ], None, True)
else:
    provenance = state_identity["provenance"]
    directory = state_identity["directory"]
    candidate_provenance = directory["candidate"] + "/rotation-provenance.jsonl"
    add("rotation_provenance", "delete", "file", [candidate_provenance, provenance["path"]],
        identity_for_file({**provenance, "sha256": snapshot["ledger"]["sha256"]}),
        allow_legacy_recorded_absence)
    add("rotation_state_dir", "delete", "directory", [directory["candidate"], directory["path"]],
        identity_for_directory(directory), allow_legacy_recorded_absence)

if anchor is None:
    add("rotation_anchor", "assert_absent", "file", [
        "/var/backups/aifeeds-performance-log/rotation-anchor-" + operation_id + ".json",
    ], None, True)
else:
    add("rotation_anchor", "delete", "file", [anchor["path"]], identity_for_file(anchor),
        allow_legacy_recorded_absence)

add_runtime("checker", "checker")
add_runtime("rotate", "rotate")
add_runtime("format", "format")
add_runtime("diff_checker", "diff_checker")
add_runtime("inserter", "inserter")
prepublication_runtime = (
    runtime_sealed is False
    and isinstance(snapshot, dict)
    and snapshot.get("generation") == 0
    and snapshot.get("status") is None
    and isinstance(anchor, dict)
    and anchor.get("state") == "allocated"
)
if prepublication_runtime:
    log_entry = runtime_by_name.get("log")
    if log_entry is None or absent(log_entry["candidate"]) or not absent(log_entry["final"]):
        raise RuntimeError("prepublication runtime log topology drift")
    add_runtime("log", "log", "delete")
else:
    add_runtime("log", "log", "archive_handoff")

if len(items) != 14:
    raise RuntimeError("runtime cleanup plan must contain 14 slots")
result = {
    "schema": 1,
    "plan_sha256": hashlib.sha256(canonical(items)).hexdigest(),
    "items": items,
    "cursor": 0,
    "cursor_state": "pending",
}
if allow_legacy_recorded_absence:
    result["compatibility_mode"] = "legacy_runtime_removed"
print(json.dumps(result, sort_keys=True, separators=(",", ":")))
PY
}

runtime_cleanup_detach_item() {
    local item=$1
    local validate_only=${2:-0}
    python3 - "$item" "$validate_only" <<'PY'
import ctypes
import hashlib
import json
import os
import stat
import sys

item = json.loads(sys.argv[1])
validate_only = sys.argv[2] == "1"
RENAME_NOREPLACE = 1
libc = ctypes.CDLL(None, use_errno=True)


def exists(path):
    try:
        os.lstat(path)
        return True
    except FileNotFoundError:
        return False


def stable_stat(value):
    return (
        value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
        value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode), value.st_nlink,
    )


def stable_handoff(value):
    return (
        value.st_dev, value.st_ino, value.st_uid, value.st_gid,
        stat.S_IMODE(value.st_mode), value.st_nlink,
    )


def matches(path):
    identity = item["identity"]
    pathname_before = os.lstat(path)
    if stat.S_ISLNK(pathname_before.st_mode):
        raise RuntimeError("cleanup path is a symlink")
    if (
        pathname_before.st_uid, pathname_before.st_gid,
        stat.S_IMODE(pathname_before.st_mode), pathname_before.st_dev, pathname_before.st_ino,
    ) != (
        identity["uid"], identity["gid"], int(identity["mode"], 8), identity["dev"], identity["ino"],
    ):
        raise RuntimeError("cleanup inode identity drift")
    if item["kind"] == "directory":
        if not stat.S_ISDIR(pathname_before.st_mode):
            raise RuntimeError("cleanup directory kind drift")
    elif not stat.S_ISREG(pathname_before.st_mode) or pathname_before.st_nlink != 1:
        raise RuntimeError("cleanup file kind/link drift")
    flags = os.O_RDONLY | os.O_NOFOLLOW
    if item["kind"] == "directory":
        flags |= os.O_DIRECTORY
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        digest = None
        if item["kind"] == "file" and item["action"] != "archive_handoff":
            digest = hashlib.file_digest(
                os.fdopen(os.dup(descriptor), "rb", buffering=0), "sha256"
            ).hexdigest()
        after = os.fstat(descriptor)
        pathname_after = os.lstat(path)
    finally:
        os.close(descriptor)
    stable_identity = stable_handoff if item["action"] == "archive_handoff" else stable_stat
    if not (stable_identity(pathname_before) == stable_identity(before)
            == stable_identity(after) == stable_identity(pathname_after)):
        raise RuntimeError("cleanup path changed while proving identity")
    if item["kind"] == "file" and item["action"] != "archive_handoff" \
            and digest != identity["sha256"]:
        raise RuntimeError("cleanup file hash drift")


selected = item["selected_path"]
tombstone = item["tombstone"]
other_paths = [path for path in item["paths"] if path != selected]
if any(exists(path) for path in other_paths):
    raise RuntimeError("cleanup non-selected path exists")
if item["action"] == "assert_absent":
    if any(exists(path) for path in item["paths"]) or exists(tombstone):
        raise RuntimeError("cleanup assert_absent drift")
    raise SystemExit(0)
if item["action"] == "archive_handoff":
    if exists(tombstone):
        raise RuntimeError("archive handoff tombstone drift")
    matches(selected)
    raise SystemExit(0)
source_exists, tombstone_exists = exists(selected), exists(tombstone)
if source_exists and not tombstone_exists:
    matches(selected)
    if validate_only:
        raise SystemExit(0)
    result = libc.renameat2(
        ctypes.c_int(-100), os.fsencode(selected), ctypes.c_int(-100),
        os.fsencode(tombstone), ctypes.c_uint(RENAME_NOREPLACE),
    )
    if result != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), tombstone)
    parent_descriptor = os.open(os.path.dirname(selected), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(parent_descriptor)
    finally:
        os.close(parent_descriptor)
elif source_exists or not tombstone_exists:
    raise RuntimeError("cleanup detaching physical state drift")
matches(tombstone)
PY
}

runtime_cleanup_unlink_item() {
    local item=$1
    local validate_only=${2:-0}
    python3 - "$item" "$validate_only" <<'PY'
import hashlib
import json
import os
import stat
import sys

item = json.loads(sys.argv[1])
validate_only = sys.argv[2] == "1"
selected = item["selected_path"]
tombstone = item["tombstone"]


def exists(path):
    try:
        os.lstat(path)
        return True
    except FileNotFoundError:
        return False


alternate_paths = [path for path in item["paths"] if path != selected]
if any(exists(path) for path in alternate_paths):
    raise RuntimeError("cleanup alternate path reappeared before unlink")


def stable_stat(value):
    return (
        value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
        value.st_uid, value.st_gid, stat.S_IMODE(value.st_mode), value.st_nlink,
    )


def stable_handoff(value):
    return (
        value.st_dev, value.st_ino, value.st_uid, value.st_gid,
        stat.S_IMODE(value.st_mode), value.st_nlink,
    )


def prove_path(path):
    identity = item["identity"]
    pathname_before = os.lstat(path)
    if stat.S_ISLNK(pathname_before.st_mode):
        raise RuntimeError("cleanup proof path is a symlink")
    if item["kind"] == "directory":
        if not stat.S_ISDIR(pathname_before.st_mode):
            raise RuntimeError("cleanup proof directory kind drift")
    elif not stat.S_ISREG(pathname_before.st_mode) or pathname_before.st_nlink != 1:
        raise RuntimeError("cleanup proof file kind/link drift")
    if (
        pathname_before.st_uid, pathname_before.st_gid,
        stat.S_IMODE(pathname_before.st_mode), pathname_before.st_dev, pathname_before.st_ino,
    ) != (
        identity["uid"], identity["gid"], int(identity["mode"], 8),
        identity["dev"], identity["ino"],
    ):
        raise RuntimeError("cleanup proof exact identity drift")
    flags = os.O_RDONLY | os.O_NOFOLLOW
    if item["kind"] == "directory":
        flags |= os.O_DIRECTORY
    descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        digest = None
        if item["kind"] == "file" and item["action"] != "archive_handoff":
            digest = hashlib.file_digest(
                os.fdopen(os.dup(descriptor), "rb", buffering=0), "sha256"
            ).hexdigest()
        after = os.fstat(descriptor)
        pathname_after = os.lstat(path)
    finally:
        os.close(descriptor)
    stable_identity = stable_handoff if item["action"] == "archive_handoff" else stable_stat
    if not (stable_identity(pathname_before) == stable_identity(before)
            == stable_identity(after) == stable_identity(pathname_after)):
        raise RuntimeError("cleanup proof path changed")
    if item["kind"] == "file" and item["action"] != "archive_handoff" \
            and digest != identity["sha256"]:
        raise RuntimeError("cleanup proof hash drift")


if item["action"] == "assert_absent":
    if any(exists(path) for path in item["paths"]) or exists(tombstone):
        raise RuntimeError("cleanup absent item changed")
    raise SystemExit(0)
if item["action"] == "archive_handoff":
    if not exists(selected) or exists(tombstone):
        raise RuntimeError("archive handoff changed")
    prove_path(selected)
    raise SystemExit(0)
if exists(selected):
    raise RuntimeError("cleanup selected path reappeared")
if not exists(tombstone):
    # detached is durable proof that absence may only be the completed unlink
    raise SystemExit(0)
parent_path, name = os.path.split(tombstone)
parent_descriptor = os.open(parent_path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
flags = os.O_RDONLY | os.O_NOFOLLOW
if item["kind"] == "directory":
    flags |= os.O_DIRECTORY
descriptor = os.open(name, flags, dir_fd=parent_descriptor)
try:
    before = os.fstat(descriptor)
    identity = item["identity"]
    if (before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode), before.st_dev, before.st_ino) != (
        identity["uid"], identity["gid"], int(identity["mode"], 8), identity["dev"], identity["ino"],
    ):
        raise RuntimeError("cleanup tombstone exact identity drift")
    if item["kind"] == "directory":
        if not stat.S_ISDIR(before.st_mode):
            raise RuntimeError("cleanup tombstone directory kind drift")
        if os.listdir(descriptor):
            raise RuntimeError("cleanup directory tombstone is not empty")
        digest = None
    else:
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise RuntimeError("cleanup tombstone link count drift")
        digest = hashlib.file_digest(os.fdopen(os.dup(descriptor), "rb", buffering=0), "sha256").hexdigest()
        if digest != identity["sha256"]:
            raise RuntimeError("cleanup tombstone hash drift")
    held_before_unlink = os.fstat(descriptor)
    namespace = os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
    if not (stable_stat(before) == stable_stat(held_before_unlink) == stable_stat(namespace)):
        raise RuntimeError("cleanup tombstone changed before unlink")
    if validate_only:
        raise SystemExit(0)
    if item["kind"] == "directory":
        os.rmdir(name, dir_fd=parent_descriptor)
    else:
        os.unlink(name, dir_fd=parent_descriptor)
    try:
        os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        raise RuntimeError("cleanup tombstone unlink drift")
    after = os.fstat(descriptor)
    if item["kind"] == "directory":
        after_identity = (
            after.st_dev, after.st_ino, after.st_uid, after.st_gid,
            stat.S_IMODE(after.st_mode), after.st_nlink,
        )
        expected_after = (
            before.st_dev, before.st_ino, before.st_uid, before.st_gid,
            stat.S_IMODE(before.st_mode), 0,
        )
    else:
        after_identity = (
            after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns,
            after.st_uid, after.st_gid, stat.S_IMODE(after.st_mode), after.st_nlink,
        )
        expected_after = (
            before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns,
            before.st_uid, before.st_gid, stat.S_IMODE(before.st_mode), 0,
        )
    if after_identity != expected_after:
        raise RuntimeError("cleanup tombstone held descriptor drift")
    os.fsync(parent_descriptor)
finally:
    os.close(descriptor)
    os.close(parent_descriptor)
PY
}

persist_runtime_cleanup_progress() {
    local phase
    phase="$(jq -er '.phase' "$ROLLBACK_JOURNAL")" || return 1
    if [ "$phase" = rollback_failed ]; then
        write_rollback_journal rollback_failed
    elif jq -e '.runtime_cleanup.compatibility_mode == "legacy_runtime_removed"' \
        "$ROLLBACK_JOURNAL" >/dev/null; then
        test "$phase" = runtime_removed || return 1
        write_rollback_journal runtime_removed
    else
        write_rollback_journal runtime_cleanup_started
    fi
}

runtime_cleanup_test_crash() {
    local point=$1 item=$2 spec=${GL_A_TEST_RUNTIME_CLEANUP_CRASH:-} slot
    [ -n "$spec" ] || return 0
    test -d /workspace/deploy/nginx/test-fixtures/gl-a-installer \
        || { printf 'runtime cleanup test hook outside fixture\n' >&2; return 1; }
    slot="$(jq -er '.slot' <<< "$item")" || return 1
    [ "$spec" = "$slot:$point" ] || return 0
    if mkdir /tmp/gl-a-test/runtime-cleanup-crash-hit 2>/dev/null; then
        kill -KILL "$$"
    fi
}

run_runtime_cleanup_plan() {
    local cursor_state cursor item next_cursor
    while :; do
        RUNTIME_CLEANUP_JSON="$(jq -cS '.runtime_cleanup' "$ROLLBACK_JOURNAL")" || return 1
        cursor_state="$(jq -er '.cursor_state' <<< "$RUNTIME_CLEANUP_JSON")" || return 1
        cursor="$(jq -er '.cursor' <<< "$RUNTIME_CLEANUP_JSON")" || return 1
        if [ "$cursor_state" = complete ]; then return 0; fi
        item="$(jq -cer --argjson cursor "$cursor" '.items[$cursor]' \
            <<< "$RUNTIME_CLEANUP_JSON")" || return 1
        case "$cursor_state" in
            pending)
                RUNTIME_CLEANUP_READ_ONLY_PREFLIGHT_FAILED=1
                runtime_cleanup_detach_item "$item" 1 || return 1
                cursor_state="detaching"
                RUNTIME_CLEANUP_JSON="$(jq -cS --arg cursor_state "$cursor_state" \
                    '.cursor_state=$cursor_state' <<< "$RUNTIME_CLEANUP_JSON")" || return 1
                persist_runtime_cleanup_progress || return 1
                runtime_cleanup_detach_item "$item" || return 1
                RUNTIME_CLEANUP_READ_ONLY_PREFLIGHT_FAILED=0
                runtime_cleanup_test_crash detaching "$item"
                ;;
            detaching)
                RUNTIME_CLEANUP_READ_ONLY_PREFLIGHT_FAILED=1
                runtime_cleanup_detach_item "$item" 1 || return 1
                runtime_cleanup_detach_item "$item" || return 1
                RUNTIME_CLEANUP_READ_ONLY_PREFLIGHT_FAILED=0
                cursor_state="detached"
                RUNTIME_CLEANUP_JSON="$(jq -cS --arg cursor_state "$cursor_state" \
                    '.cursor_state=$cursor_state' <<< "$RUNTIME_CLEANUP_JSON")" || return 1
                persist_runtime_cleanup_progress || return 1
                runtime_cleanup_test_crash detached "$item"
                ;;
            detached)
                RUNTIME_CLEANUP_READ_ONLY_PREFLIGHT_FAILED=1
                runtime_cleanup_unlink_item "$item" 1 || return 1
                runtime_cleanup_unlink_item "$item" || return 1
                RUNTIME_CLEANUP_READ_ONLY_PREFLIGHT_FAILED=0
                next_cursor=$((cursor + 1))
                if [ "$next_cursor" -eq "$(jq -r '.items | length' <<< "$RUNTIME_CLEANUP_JSON")" ]; then
                    cursor_state="complete"
                else
                    cursor_state="pending"
                fi
                RUNTIME_CLEANUP_JSON="$(jq -cS --argjson cursor "$next_cursor" \
                    --arg cursor_state "$cursor_state" \
                    '.cursor=$cursor | .cursor_state=$cursor_state' \
                    <<< "$RUNTIME_CLEANUP_JSON")" || return 1
                persist_runtime_cleanup_progress || return 1
                ;;
            *) return 1 ;;
        esac
    done
}

complete_runtime_cleanup_plan() {
    test "$RUNTIME_CLEANUP_JSON" != null
    run_runtime_cleanup_plan
    assert_owned_cleanup_state
    write_rollback_journal runtime_removed
    runtime_cleanup_test_crash runtime_removed '{"slot":"phase"}'
}

start_runtime_cleanup_plan() {
    assert_owned_cleanup_state
    runtime_cleanup_test_crash legacy-runtime-removed-residue '{"slot":"phase"}'
    RUNTIME_CLEANUP_JSON="$(build_runtime_cleanup_plan)"
    write_rollback_journal runtime_cleanup_started
    complete_runtime_cleanup_plan
}

resume_legacy_runtime_removed_cleanup() {
    test "$RESUME_ROLLBACK_PHASE" = runtime_removed
    test "$RUNTIME_CLEANUP_JSON" = null
    assert_owned_cleanup_state
    RUNTIME_CLEANUP_JSON="$(build_runtime_cleanup_plan)"
    test "$(jq -er '.compatibility_mode' <<< "$RUNTIME_CLEANUP_JSON")" = \
        legacy_runtime_removed
    write_rollback_journal runtime_removed
    complete_runtime_cleanup_plan
}

terminal_pair_test_crash() {
    local point=$1 spec=${GL_A_TEST_TERMINAL_PAIR_CRASH:-}
    [ "$spec" = "$point" ] || return 0
    test -d /workspace/deploy/nginx/test-fixtures/gl-a-installer \
        || { printf 'terminal pair test hook outside fixture\n' >&2; return 1; }
    if mkdir /tmp/gl-a-test/terminal-pair-crash-hit 2>/dev/null; then
        kill -KILL "$$"
    fi
}

terminal_pair_test_failure() {
    local point=$1 spec=${GL_A_TEST_TERMINAL_PAIR_FAILURE:-}
    [ "$spec" = "$point" ] || return 0
    test -d /workspace/deploy/nginx/test-fixtures/gl-a-installer \
        || { printf 'terminal pair failure hook outside fixture\n' >&2; return 1; }
    if mkdir /tmp/gl-a-test/terminal-pair-failure-hit 2>/dev/null; then
        return 97
    fi
}

exceptional_publication_test_crash() {
    local artifact=$1 point=$2 spec=${GL_A_TEST_EXCEPTIONAL_PUBLICATION_CRASH:-}
    [ "$spec" = "${artifact}:${point}" ] || return 0
    test -d /workspace/deploy/nginx/test-fixtures/gl-a-installer \
        || { printf 'exceptional publication test hook outside fixture\n' >&2; return 1; }
    if mkdir "/tmp/gl-a-test/exceptional-${artifact}-${point}-crash-hit" 2>/dev/null; then
        kill -KILL "$$"
    fi
}

assert_site_base_unchanged() {
    assert_enabled_site_target
    formal_site_matches_state "$SITE" base
}

assert_backup_unchanged() {
    local backup_dev backup_ino
    if [ "$BACKUP_PRESENT" -eq 1 ]; then
        test "$SITE_BACKUP_IDENTITY_JSON" != null
        backup_dev="$(jq -er '.dev' <<< "$SITE_BACKUP_IDENTITY_JSON")"
        backup_ino="$(jq -er '.ino' <<< "$SITE_BACKUP_IDENTITY_JSON")"
        test -f "$BACKUP"
        test ! -L "$BACKUP"
        test "$(sha256sum "$BACKUP" | awk '{print $1}')" = "$BACKUP_SHA256"
        test "$(stat -c '%u' "$BACKUP")" = "$SITE_UID"
        test "$(stat -c '%g' "$BACKUP")" = "$SITE_GID"
        test "$(stat -c '%a' "$BACKUP")" = "$SITE_MODE"
        test "$(stat -c '%d %i' "$BACKUP")" = "$backup_dev $backup_ino"
    else
        test "$EARLY_RECOVERY_ALLOWED" -eq 1
        test ! -e "$BACKUP"
        test ! -L "$BACKUP"
    fi
}

assert_owned_cleanup_state() {
    assert_site_base_unchanged
    assert_backup_unchanged
    preflight_owned_runtime
}

assert_no_operation_cleanup_dirs() {
    python3 - "$ARCHIVE_OPERATION_ID" "$BACKUP_DIR" "$AUDIT_DIR" \
        /var/log/nginx /etc/nginx/sites-available /etc/nginx/conf.d /etc \
        /usr/local/sbin /etc/systemd/system /var/lib "$ROTATE_STATE_DIR" <<'PY'
import os
import stat
import sys

operation_id, *roots = sys.argv[1:]
prefix = f".cleanup-gl-a-{operation_id}-"
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

assert_terminal_state() {
    assert_enabled_site_target
    formal_site_matches_state "$SITE" base
    assert_backup_unchanged
    for path in "$FORMAT" "$ROTATE" "$CHECKER" "$DIFF_CHECKER" "$INSERTER" \
        "$SERVICE_PATH" "$TIMER_PATH" "$ROTATE_STATE_DIR" "$ROTATE_STATE_DIR_CANDIDATE" \
        "$ROTATION_ANCHOR" \
        "$INSTALLER_CANDIDATE" "$INSTALLER_ROLLBACK_CANDIDATE" "$ROLLBACK_CANDIDATE" \
        "$FORMAT_CANDIDATE" "$ROTATE_CANDIDATE" "$LOG_CANDIDATE" \
        "$CHECKER_CANDIDATE" "$DIFF_CHECKER_CANDIDATE" "$INSERTER_CANDIDATE" \
        "$SERVICE_CANDIDATE" "$TIMER_CANDIDATE"; do
        test ! -e "$path"
        test ! -L "$path"
    done
    no_performance_logs_present
    rollback_audit_is_terminal
    assert_no_operation_cleanup_dirs
    unit_is_inactive "$TIMER_UNIT"
    unit_is_inactive "$ROTATE_SERVICE"
    timer_is_disabled
    systemctl is-active --quiet nginx
    test "$(curl_status https://ai-feeds.com/)" = 200
    test "$(curl_status 'https://api.ai-feeds.com/api/items?source_type=x_list&limit=1')" = 200
    TERMINAL_ARCHIVE_MANIFEST_SHA256="$(sha256sum "$ARCHIVE_MANIFEST" | awk '{print $1}')"
    TERMINAL_ARCHIVE_MANIFEST_GENERATION="$(jq -er '.generation' "$ARCHIVE_MANIFEST")"
    TERMINAL_ARCHIVE_MANIFEST_ENTRY_COUNT="$(jq -er '.entries | length' "$ARCHIVE_MANIFEST")"
    printf '%s' "$TERMINAL_ARCHIVE_MANIFEST_SHA256" | grep -Eq '^[a-f0-9]{64}$'
    printf '%s:%s' "$TERMINAL_ARCHIVE_MANIFEST_GENERATION" \
        "$TERMINAL_ARCHIVE_MANIFEST_ENTRY_COUNT" | grep -Eq '^[0-9]+:[0-9]+$'
}

assert_terminal_manifest_journal_mirror() {
    local journal
    for journal in "$SOURCE_JOURNAL" "$ROLLBACK_JOURNAL"; do
        jq -e --arg sha256 "$TERMINAL_ARCHIVE_MANIFEST_SHA256" \
            --argjson generation "$TERMINAL_ARCHIVE_MANIFEST_GENERATION" \
            --argjson entry_count "$TERMINAL_ARCHIVE_MANIFEST_ENTRY_COUNT" '
            .phase == "rolled_back" and
            .log_archive_manifest_sha256 == $sha256 and
            .log_archive_manifest_generation == $generation and
            .log_archive_manifest_entry_count == $entry_count' "$journal" >/dev/null
    done
    for field in runtime_artifacts runtime_artifacts_sealed rotation_state_identity \
        rotation_state_snapshot rotation_anchor_identity site_backup_identity installer_candidate_dev \
        installer_candidate_ino rollback_candidate_dev rollback_candidate_ino; do
        test "$(jq -cS --arg field "$field" '.[$field]' "$SOURCE_JOURNAL")" = \
            "$(jq -cS --arg field "$field" '.[$field]' "$ROLLBACK_JOURNAL")"
    done
}

prevalidate_exceptional_authority() {
    local transaction_helper_sha source_sha rollback_sha authority_sha
    local source_before_sha rollback_before_sha terminal_state=0
    if [ -z "$EXCEPTIONAL_AUTHORITY_INPUT" ]; then return 0; fi
    test "$EXCEPTIONAL_AUTHORITY_INPUT" = \
        "${OUTPUT_DIR}/exceptional-recovery-authority-${TRANSACTION_ID}.json"
    test -f "$EXCEPTIONAL_AUTHORITY_INPUT"
    test ! -L "$EXCEPTIONAL_AUTHORITY_INPUT"
    test "$(stat -c '%u %g %a %h' "$EXCEPTIONAL_AUTHORITY_INPUT")" = '0 0 600 1'
    authority_sha="$(sha256sum "$EXCEPTIONAL_AUTHORITY_INPUT" | awk '{print $1}')"
    printf '%s' "$authority_sha" | grep -Eq '^[a-f0-9]{64}$'
    source_sha="$(sha256sum "$SOURCE_JOURNAL" | awk '{print $1}')"
    rollback_sha="$(sha256sum "$ROLLBACK_JOURNAL" | awk '{print $1}')"
    source_before_sha="$(jq -er '.source_journal_sha256' \
        "$EXCEPTIONAL_AUTHORITY_INPUT")"
    rollback_before_sha="$(jq -er '.rollback_journal_sha256' \
        "$EXCEPTIONAL_AUTHORITY_INPUT")"
    transaction_helper_sha="$(jq -er '.transaction_helper_sha256' \
        "$EXCEPTIONAL_AUTHORITY_INPUT")"
    jq -e \
        --arg operation_id "$TRANSACTION_ID" \
        --arg source_journal "$SOURCE_JOURNAL" \
        --arg source_journal_sha256 "$source_before_sha" \
        --arg rollback_journal "$ROLLBACK_JOURNAL" \
        --arg rollback_journal_sha256 "$rollback_before_sha" \
        --arg transaction_helper_sha256 "$transaction_helper_sha" \
        --arg recovery_executor_sha256 "$ROLLBACK_EXECUTOR_SHA256" '
        (keys | sort) == ["approval_evidence_sha256","approved_utc","defect","g0_commit",
                          "gate","independent_rollback_owner","operation_id","operator","phase",
                          "recovery_executor_sha256","rollback_journal","rollback_journal_sha256",
                          "schema","source_journal","source_journal_sha256",
                          "transaction_helper_sha256"] and
        .schema == 1 and .gate == "GL-a-exceptional-recovery" and
        .phase == "authorized" and .operation_id == $operation_id and
        (.g0_commit | test("^[a-f0-9]{40}$")) and
        .source_journal == $source_journal and
        .source_journal_sha256 == $source_journal_sha256 and
        .rollback_journal == $rollback_journal and
        .rollback_journal_sha256 == $rollback_journal_sha256 and
        .transaction_helper_sha256 == $transaction_helper_sha256 and
        .recovery_executor_sha256 == $recovery_executor_sha256 and
        .transaction_helper_sha256 != .recovery_executor_sha256 and
        .defect == "initialized_rotation_candidate_prepublication" and
        .operator == "Codex" and .independent_rollback_owner == "roxor" and
        (.approved_utc | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
        (.approval_evidence_sha256 | test("^[a-f0-9]{64}$"))
    ' "$EXCEPTIONAL_AUTHORITY_INPUT" >/dev/null
    test "$SOURCE_JOURNAL_EXTERNAL_SHA256" = "$source_before_sha"
    test "$(jq -er '.operation_id' "$SOURCE_JOURNAL")" = "$TRANSACTION_ID"
    test "$(jq -er '.g0_commit' "$SOURCE_JOURNAL")" = \
        "$(jq -er '.g0_commit' "$EXCEPTIONAL_AUTHORITY_INPUT")"
    test "$(jq -er '.rollback_helper_sha256' "$SOURCE_JOURNAL")" = \
        "$transaction_helper_sha"
    test "$(jq -er '.operation_id' "$ROLLBACK_JOURNAL")" = "$TRANSACTION_ID"
    test "$(jq -er '.rollback_helper_sha256' "$ROLLBACK_JOURNAL")" = \
        "$transaction_helper_sha"
    if [ "$source_sha:$rollback_sha" = "$source_before_sha:$rollback_before_sha" ]; then
        test "$(jq -er '.phase' "$SOURCE_JOURNAL")" = mutation_started
        test "$(jq -er '.phase' "$ROLLBACK_JOURNAL")" = rollback_failed
        test "$(jq -er '.failed_from' "$ROLLBACK_JOURNAL")" = prepared
    else
        test "$(jq -er '.phase' "$SOURCE_JOURNAL")" = rolled_back
        test "$(jq -er '.phase' "$ROLLBACK_JOURNAL")" = rolled_back
        test -f "$ROLLBACK_COMMIT_MARKER"
        test ! -L "$ROLLBACK_COMMIT_MARKER"
        test "$(jq -er '.phase' "$ROLLBACK_COMMIT_MARKER")" = committed
        test "$(jq -er '.source_journal_terminal_sha256' "$ROLLBACK_COMMIT_MARKER")" = \
            "$source_sha"
        test "$(jq -er '.rollback_journal_terminal_sha256' "$ROLLBACK_COMMIT_MARKER")" = \
            "$rollback_sha"
        test -f "$EXCEPTIONAL_AUTHORITY"
        test ! -L "$EXCEPTIONAL_AUTHORITY"
        test "$(sha256sum "$EXCEPTIONAL_AUTHORITY" | awk '{print $1}')" = "$authority_sha"
        terminal_state=1
    fi
    for residue in "$SOURCE_JOURNAL_TMP" "$SOURCE_JOURNAL_PREVIOUS_UPDATE" \
        "${SOURCE_JOURNAL_PREVIOUS_UPDATE}.cleanup" "$ROLLBACK_JOURNAL_TMP" \
        "$ROLLBACK_JOURNAL_PREVIOUS_UPDATE" "${ROLLBACK_JOURNAL_PREVIOUS_UPDATE}.cleanup" \
        "$ROLLBACK_COMMIT_MARKER_TMP" "$ROLLBACK_COMMIT_MARKER_PREVIOUS"; do
        test ! -e "$residue"
        test ! -L "$residue"
    done
    if [ "$terminal_state" -eq 0 ]; then
        test ! -e "$ROLLBACK_COMMIT_MARKER"
        test ! -L "$ROLLBACK_COMMIT_MARKER"
    fi
    ROLLBACK_HELPER_SHA256=$transaction_helper_sha
    EXCEPTIONAL_AUTHORITY_SHA256=$authority_sha
    EXCEPTIONAL_SOURCE_BEFORE_SHA256=$source_before_sha
    EXCEPTIONAL_ROLLBACK_BEFORE_SHA256=$rollback_before_sha
    EXCEPTIONAL_RECOVERY=1
}

persist_exceptional_authority() {
    local input_dev input_ino candidate_identity
    if [ "$EXCEPTIONAL_RECOVERY" -ne 1 ]; then return 0; fi
    test -f "$EXCEPTIONAL_AUTHORITY_INPUT"
    test ! -L "$EXCEPTIONAL_AUTHORITY_INPUT"
    test "$(sha256sum "$EXCEPTIONAL_AUTHORITY_INPUT" | awk '{print $1}')" = \
        "$EXCEPTIONAL_AUTHORITY_SHA256"
    if [ -e "$EXCEPTIONAL_AUTHORITY" ] || [ -L "$EXCEPTIONAL_AUTHORITY" ]; then
        test ! -e "$EXCEPTIONAL_AUTHORITY_CANDIDATE"
        test ! -L "$EXCEPTIONAL_AUTHORITY_CANDIDATE"
        path_matches_exact "$EXCEPTIONAL_AUTHORITY" "$EXCEPTIONAL_AUTHORITY_SHA256" 0 0 600
        return
    fi
    if [ -e "$EXCEPTIONAL_AUTHORITY_CANDIDATE" ] \
        || [ -L "$EXCEPTIONAL_AUTHORITY_CANDIDATE" ]; then
        path_matches_exact "$EXCEPTIONAL_AUTHORITY_CANDIDATE" \
            "$EXCEPTIONAL_AUTHORITY_SHA256" 0 0 600
    else
        exceptional_publication_test_crash authority pre-copy
        input_dev="$(stat -c '%d' "$EXCEPTIONAL_AUTHORITY_INPUT")"
        input_ino="$(stat -c '%i' "$EXCEPTIONAL_AUTHORITY_INPUT")"
        candidate_identity="$(copy_file_no_replace "$EXCEPTIONAL_AUTHORITY_INPUT" \
            "$EXCEPTIONAL_AUTHORITY_CANDIDATE" "$EXCEPTIONAL_AUTHORITY_SHA256" \
            0 0 600 "$input_dev" "$input_ino")"
        printf '%s' "$candidate_identity" | grep -Eq '^[0-9]+:[0-9]+$'
        exceptional_publication_test_crash authority post-copy
    fi
    sync -f "$EXCEPTIONAL_AUTHORITY_CANDIDATE"
    exceptional_publication_test_crash authority pre-rename
    rename_no_replace "$EXCEPTIONAL_AUTHORITY_CANDIDATE" "$EXCEPTIONAL_AUTHORITY"
    exceptional_publication_test_crash authority post-rename
    sync -f "$EXCEPTIONAL_AUTHORITY"
    sync -f "$BACKUP_DIR"
    path_matches_exact "$EXCEPTIONAL_AUTHORITY" "$EXCEPTIONAL_AUTHORITY_SHA256" 0 0 600
}

persist_exceptional_receipt() {
    local source_terminal_sha=$1 rollback_terminal_sha=$2 marker_sha=$3
    local receipt_json receipt_sha render_dev render_ino candidate_identity
    if [ "$EXCEPTIONAL_RECOVERY" -ne 1 ]; then return 0; fi
    path_matches_exact "$EXCEPTIONAL_AUTHORITY" "$EXCEPTIONAL_AUTHORITY_SHA256" 0 0 600
    receipt_json="$(jq -ncS \
        --arg operation_id "$TRANSACTION_ID" \
        --arg authority "$EXCEPTIONAL_AUTHORITY" \
        --arg authority_sha256 "$EXCEPTIONAL_AUTHORITY_SHA256" \
        --arg source_journal "$SOURCE_JOURNAL_FINAL" \
        --arg source_before_sha256 "$EXCEPTIONAL_SOURCE_BEFORE_SHA256" \
        --arg source_terminal_sha256 "$source_terminal_sha" \
        --arg rollback_journal "$ROLLBACK_JOURNAL_FINAL" \
        --arg rollback_before_sha256 "$EXCEPTIONAL_ROLLBACK_BEFORE_SHA256" \
        --arg rollback_terminal_sha256 "$rollback_terminal_sha" \
        --arg rollback_commit_marker "$ROLLBACK_COMMIT_MARKER" \
        --arg rollback_commit_marker_sha256 "$marker_sha" \
        --arg transaction_helper_sha256 "$ROLLBACK_HELPER_SHA256" \
        --arg recovery_executor_sha256 "$ROLLBACK_EXECUTOR_SHA256" '
        {schema:1,gate:"GL-a-exceptional-recovery",phase:"committed",
         operation_id:$operation_id,authority:$authority,authority_sha256:$authority_sha256,
         source_journal:$source_journal,source_before_sha256:$source_before_sha256,
         source_terminal_sha256:$source_terminal_sha256,
         rollback_journal:$rollback_journal,rollback_before_sha256:$rollback_before_sha256,
         rollback_terminal_sha256:$rollback_terminal_sha256,
         rollback_commit_marker:$rollback_commit_marker,
         rollback_commit_marker_sha256:$rollback_commit_marker_sha256,
         transaction_helper_sha256:$transaction_helper_sha256,
         recovery_executor_sha256:$recovery_executor_sha256}')" || return 1
    receipt_sha="$(printf '%s\n' "$receipt_json" | sha256sum | awk '{print $1}')"
    if [ -e "$EXCEPTIONAL_RECEIPT" ] || [ -L "$EXCEPTIONAL_RECEIPT" ]; then
        test ! -e "$EXCEPTIONAL_RECEIPT_CANDIDATE"
        test ! -L "$EXCEPTIONAL_RECEIPT_CANDIDATE"
        path_matches_exact "$EXCEPTIONAL_RECEIPT" "$receipt_sha" 0 0 600
        if [ -e "$EXCEPTIONAL_RECEIPT_RENDER" ] \
            || [ -L "$EXCEPTIONAL_RECEIPT_RENDER" ]; then
            path_matches_exact "$EXCEPTIONAL_RECEIPT_RENDER" "$receipt_sha" 0 0 600
            rm -f "$EXCEPTIONAL_RECEIPT_RENDER"
            sync -f "$OUTPUT_DIR"
        fi
        return
    fi
    if [ -e "$EXCEPTIONAL_RECEIPT_CANDIDATE" ] \
        || [ -L "$EXCEPTIONAL_RECEIPT_CANDIDATE" ]; then
        path_matches_exact "$EXCEPTIONAL_RECEIPT_CANDIDATE" "$receipt_sha" 0 0 600
    else
        if [ -e "$EXCEPTIONAL_RECEIPT_RENDER" ] \
            || [ -L "$EXCEPTIONAL_RECEIPT_RENDER" ]; then
            path_matches_exact "$EXCEPTIONAL_RECEIPT_RENDER" "$receipt_sha" 0 0 600
        else
            printf '%s\n' "$receipt_json" > "$EXCEPTIONAL_RECEIPT_RENDER"
            chmod 0600 "$EXCEPTIONAL_RECEIPT_RENDER"
            sync -f "$EXCEPTIONAL_RECEIPT_RENDER"
        fi
        exceptional_publication_test_crash receipt pre-copy
        render_dev="$(stat -c '%d' "$EXCEPTIONAL_RECEIPT_RENDER")"
        render_ino="$(stat -c '%i' "$EXCEPTIONAL_RECEIPT_RENDER")"
        candidate_identity="$(copy_file_no_replace "$EXCEPTIONAL_RECEIPT_RENDER" \
            "$EXCEPTIONAL_RECEIPT_CANDIDATE" "$receipt_sha" 0 0 600 \
            "$render_dev" "$render_ino")"
        printf '%s' "$candidate_identity" | grep -Eq '^[0-9]+:[0-9]+$'
        exceptional_publication_test_crash receipt post-copy
    fi
    if [ -e "$EXCEPTIONAL_RECEIPT_RENDER" ] \
        || [ -L "$EXCEPTIONAL_RECEIPT_RENDER" ]; then
        path_matches_exact "$EXCEPTIONAL_RECEIPT_RENDER" "$receipt_sha" 0 0 600
        rm -f "$EXCEPTIONAL_RECEIPT_RENDER"
        sync -f "$OUTPUT_DIR"
    fi
    sync -f "$EXCEPTIONAL_RECEIPT_CANDIDATE"
    exceptional_publication_test_crash receipt pre-rename
    rename_no_replace "$EXCEPTIONAL_RECEIPT_CANDIDATE" "$EXCEPTIONAL_RECEIPT"
    exceptional_publication_test_crash receipt post-rename
    sync -f "$EXCEPTIONAL_RECEIPT"
    sync -f "$BACKUP_DIR"
    path_matches_exact "$EXCEPTIONAL_RECEIPT" "$receipt_sha" 0 0 600
}

validate_committed_terminal_pair_physical_chain() {
    local source_journal_terminal_sha256
    local rollback_journal_terminal_sha256
    terminal_pair_commit_marker_is_owned "$ROLLBACK_COMMIT_MARKER"
    test "$(jq -er '.phase' "$ROLLBACK_COMMIT_MARKER")" = committed
    for terminal_residue in "$SOURCE_JOURNAL_TMP" "$SOURCE_JOURNAL_PREVIOUS_UPDATE" \
        "${SOURCE_JOURNAL_PREVIOUS_UPDATE}.cleanup" \
        "$ROLLBACK_JOURNAL_TMP" "$ROLLBACK_JOURNAL_PREVIOUS_UPDATE" \
        "${ROLLBACK_JOURNAL_PREVIOUS_UPDATE}.cleanup" \
        "$ROLLBACK_COMMIT_MARKER_TMP" "$ROLLBACK_COMMIT_MARKER_PREVIOUS"; do
        test ! -e "$terminal_residue"
        test ! -L "$terminal_residue"
    done
    assert_terminal_state
    assert_terminal_manifest_journal_mirror
    source_journal_terminal_sha256="$(sha256sum "$SOURCE_JOURNAL" | awk '{print $1}')"
    rollback_journal_terminal_sha256="$(sha256sum "$ROLLBACK_JOURNAL" | awk '{print $1}')"
    test "$(jq -er '.source_journal_terminal_sha256' "$ROLLBACK_COMMIT_MARKER")" = \
        "$source_journal_terminal_sha256"
    test "$(jq -er '.rollback_journal_terminal_sha256' "$ROLLBACK_COMMIT_MARKER")" = \
        "$rollback_journal_terminal_sha256"
    test "$(jq -er '.source_target_sha256' "$ROLLBACK_COMMIT_MARKER")" = \
        "$source_journal_terminal_sha256"
    test "$(jq -er '.rollback_target_sha256' "$ROLLBACK_COMMIT_MARKER")" = \
        "$rollback_journal_terminal_sha256"
    jq -e --arg rollback "$ROLLBACK_JOURNAL" --arg marker "$ROLLBACK_COMMIT_MARKER" '
        .phase == "rolled_back" and .rollback_journal == $rollback and
        .rollback_commit_marker == $marker' "$SOURCE_JOURNAL" >/dev/null
    jq -e --arg source "$SOURCE_JOURNAL" --arg marker "$ROLLBACK_COMMIT_MARKER" \
        --arg source_sha256 "$source_journal_terminal_sha256" '
        .phase == "rolled_back" and .source_journal == $source and
        .rollback_commit_marker == $marker and
        .source_journal_terminal_sha256 == $source_sha256' \
        "$ROLLBACK_JOURNAL" >/dev/null
}

emit_summary() {
    local source_terminal_sha256
    local rollback_journal_sha256
    local log_archive_manifest_sha256
    local rollback_commit_marker_sha256
    local log_archive_manifest_generation
    local log_archive_manifest_entry_count
    local backup_present=false
    validate_committed_terminal_pair_physical_chain
    source_terminal_sha256="$(sha256sum "$SOURCE_JOURNAL" | awk '{print $1}')"
    rollback_journal_sha256="$(sha256sum "$ROLLBACK_JOURNAL" | awk '{print $1}')"
    assert_terminal_manifest_journal_mirror
    log_archive_manifest_sha256="$TERMINAL_ARCHIVE_MANIFEST_SHA256"
    rollback_commit_marker_sha256="$(sha256sum "$ROLLBACK_COMMIT_MARKER" | awk '{print $1}')"
    log_archive_manifest_generation="$TERMINAL_ARCHIVE_MANIFEST_GENERATION"
    log_archive_manifest_entry_count="$TERMINAL_ARCHIVE_MANIFEST_ENTRY_COUNT"
    if [ -f "$BACKUP" ] && [ ! -L "$BACKUP" ]; then backup_present=true; fi
    persist_exceptional_receipt "$source_terminal_sha256" "$rollback_journal_sha256" \
        "$rollback_commit_marker_sha256"
    jq -nc \
        --arg backup_sha256 "$BACKUP_SHA256" \
        --arg operation_id "$TRANSACTION_ID" \
        --arg g0_commit "$G0_COMMIT" \
        --arg rollback_helper_sha256 "$ROLLBACK_HELPER_SHA256" \
        --arg source_journal_terminal_sha256 "$source_terminal_sha256" \
        --arg rollback_journal_sha256 "$rollback_journal_sha256" \
        --arg rollback_candidate "$ROLLBACK_CANDIDATE" \
        --arg rollback_commit_marker "$ROLLBACK_COMMIT_MARKER" \
        --arg rollback_commit_marker_sha256 "$rollback_commit_marker_sha256" \
        --arg log_archive_manifest "$ARCHIVE_MANIFEST" \
        --arg log_archive_manifest_sha256 "$log_archive_manifest_sha256" \
        --argjson log_archive_manifest_generation "$log_archive_manifest_generation" \
        --argjson log_archive_manifest_entry_count "$log_archive_manifest_entry_count" \
        --argjson artifacts_sha256 "$ARTIFACTS_SHA256_JSON" \
        --argjson artifact_candidates "$ARTIFACT_CANDIDATES_JSON" \
        --argjson runtime_artifacts "$RUNTIME_ARTIFACTS_JSON" \
        --argjson runtime_artifacts_sealed "$RUNTIME_ARTIFACTS_SEALED" \
        --argjson rotation_state_identity "$ROTATION_STATE_IDENTITY_JSON" \
        --argjson rotation_state_snapshot "$ROTATION_STATE_SNAPSHOT_JSON" \
        --argjson rotation_anchor_identity "$ROTATION_ANCHOR_IDENTITY_JSON" \
        --argjson site_backup_identity "$SITE_BACKUP_IDENTITY_JSON" \
        --argjson backup_present "$backup_present" \
        --arg source_journal "$SOURCE_JOURNAL" \
        --arg rollback_journal "$ROLLBACK_JOURNAL" \
        --arg audit_dir "$AUDIT_DIR" \
        '{schema:1,gate:"GL-a-manual-rollback",operation_id:$operation_id,g0_commit:$g0_commit,
          rollback_helper_sha256:$rollback_helper_sha256,backup_sha256:$backup_sha256,
          source_journal:$source_journal,rollback_journal:$rollback_journal,
          rollback_commit_marker:$rollback_commit_marker,
          rollback_commit_marker_sha256:$rollback_commit_marker_sha256,
          log_archive_manifest:$log_archive_manifest,
          log_archive_manifest_sha256:$log_archive_manifest_sha256,
          log_archive_manifest_generation:$log_archive_manifest_generation,
          log_archive_manifest_entry_count:$log_archive_manifest_entry_count,
          rollback_candidate:$rollback_candidate,audit_dir:$audit_dir,
          source_journal_terminal_sha256:$source_journal_terminal_sha256,
          rollback_journal_sha256:$rollback_journal_sha256,artifacts_sha256:$artifacts_sha256,
          artifact_candidates:$artifact_candidates,runtime_artifacts:$runtime_artifacts,
          runtime_artifacts_sealed:$runtime_artifacts_sealed,
          rotation_state_identity:$rotation_state_identity,
          rotation_state_snapshot:$rotation_state_snapshot,
          rotation_anchor_identity:$rotation_anchor_identity,
          site_backup_identity:$site_backup_identity,
          backup_present:$backup_present,
          site_restored:true,metadata_restored:true,timer_inactive:true,service_inactive:true,
          nginx_active:true,front_status:200,api_status:200}' > "$SUMMARY_TMP"
    chmod 0600 "$SUMMARY_TMP"
    sync -f "$SUMMARY_TMP"
    mv -f "$SUMMARY_TMP" "$SUMMARY"
    sync -f "$SUMMARY"
}

mark_failure() {
    local rc=$?
    trap - EXIT
    trap '' HUP INT TERM
    if [ "$SUCCESS" -eq 1 ]; then
        exit "$rc"
    fi
    set +e
    if [ "$ARCHIVE_READ_ONLY_PREFLIGHT_FAILED" -eq 1 ] \
        || [ "$RUNTIME_CLEANUP_READ_ONLY_PREFLIGHT_FAILED" -eq 1 ]; then
        printf 'manual_rollback=failed\n'
        exit "$rc"
    fi
    if [ -f "$ROLLBACK_JOURNAL" ] && [ ! -L "$ROLLBACK_JOURNAL" ] \
        && jq -e '.phase == "rolled_back"' "$ROLLBACK_JOURNAL" >/dev/null 2>&1; then
        ROLLBACK_TERMINAL=1
    elif [ -f "${ROLLBACK_JOURNAL}.tmp" ] && [ ! -L "${ROLLBACK_JOURNAL}.tmp" ] \
        && jq -e '.phase == "rolled_back"' "${ROLLBACK_JOURNAL}.tmp" >/dev/null 2>&1; then
        ROLLBACK_TERMINAL=1
    fi
    rm -f "$SUMMARY_TMP"
    if [ "$ROLLBACK_TERMINAL" -ne 1 ]; then
        rm -f "$SUMMARY"
    fi
    if [ "$SUCCESS" -ne 1 ] && [ "$ROLLBACK_JOURNAL_CREATED" -eq 1 ] \
        && [ "$ROLLBACK_TERMINAL" -ne 1 ] \
        && [ ! -e "$ROLLBACK_COMMIT_MARKER" ] && [ ! -L "$ROLLBACK_COMMIT_MARKER" ] \
        && [ ! -e "$ROLLBACK_COMMIT_MARKER_TMP" ] && [ ! -L "$ROLLBACK_COMMIT_MARKER_TMP" ]; then
        write_rollback_journal rollback_failed >/dev/null 2>&1 || true
    fi
    printf 'manual_rollback=failed\n'
    exit "$rc"
}

prevalidate_exceptional_authority

trap mark_failure EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

test -d "$BACKUP_DIR"
test ! -L "$BACKUP_DIR"
test "$(stat -c '%U %G %a' "$BACKUP_DIR")" = 'root root 700'
if [ -e "$ROLLBACK_COMMIT_MARKER" ] || [ -L "$ROLLBACK_COMMIT_MARKER" ] \
    || [ -e "$ROLLBACK_COMMIT_MARKER_TMP" ] || [ -L "$ROLLBACK_COMMIT_MARKER_TMP" ] \
    || [ -e "$ROLLBACK_COMMIT_MARKER_PREVIOUS" ] || [ -L "$ROLLBACK_COMMIT_MARKER_PREVIOUS" ] \
    || { [ -f "$SOURCE_JOURNAL" ] && jq -e '.phase == "rolled_back"' \
        "$SOURCE_JOURNAL" >/dev/null 2>&1; } \
    || { [ -f "$SOURCE_JOURNAL_TMP" ] && jq -e '.phase == "rolled_back"' \
        "$SOURCE_JOURNAL_TMP" >/dev/null 2>&1; } \
    || { [ -f "$ROLLBACK_JOURNAL" ] && jq -e '.phase == "rolled_back"' \
        "$ROLLBACK_JOURNAL" >/dev/null 2>&1; } \
    || { [ -f "$ROLLBACK_JOURNAL_TMP" ] && jq -e '.phase == "rolled_back"' \
        "$ROLLBACK_JOURNAL_TMP" >/dev/null 2>&1; }; then
    # Terminal namespaces are read-only until source/rollback authority and the
    # complete physical terminal state have been loaded and re-proved below.
    TERMINAL_RECOVERY_PENDING=1
else
if [ -e "$SOURCE_JOURNAL_TMP" ] || [ -L "$SOURCE_JOURNAL_TMP" ]; then
    test ! -L "$SOURCE_JOURNAL_TMP"
    settle_journal_update "$SOURCE_JOURNAL" "$SOURCE_JOURNAL_PREVIOUS_UPDATE" \
        source "$SOURCE_JOURNAL_EXTERNAL_SHA256"
else
    settle_journal_update "$SOURCE_JOURNAL" "$SOURCE_JOURNAL_PREVIOUS_UPDATE" \
        source "$SOURCE_JOURNAL_EXTERNAL_SHA256"
fi
SOURCE_JOURNAL_SETTLED_SHA256="$(capture_regular_file_identity_stable "$SOURCE_JOURNAL" \
    | jq -er '.sha256')"
printf '%s' "$SOURCE_JOURNAL_SETTLED_SHA256" | grep -Eq '^[a-f0-9]{64}$'
SOURCE_JOURNAL_SHA256=$SOURCE_JOURNAL_SETTLED_SHA256
if [ -e "$ROLLBACK_JOURNAL_TMP" ] || [ -L "$ROLLBACK_JOURNAL_TMP" ]; then
    test ! -L "$ROLLBACK_JOURNAL_TMP"
    settle_journal_update "$ROLLBACK_JOURNAL" "$ROLLBACK_JOURNAL_PREVIOUS_UPDATE" rollback ""
elif [ -e "$ROLLBACK_JOURNAL" ] || [ -e "$ROLLBACK_JOURNAL_PREVIOUS_UPDATE" ] \
    || [ -e "${ROLLBACK_JOURNAL_PREVIOUS_UPDATE}.cleanup" ]; then
    settle_journal_update "$ROLLBACK_JOURNAL" "$ROLLBACK_JOURNAL_PREVIOUS_UPDATE" rollback ""
fi
fi
SOURCE_JOURNAL_FINAL=$SOURCE_JOURNAL
ROLLBACK_JOURNAL_FINAL=$ROLLBACK_JOURNAL
if [ "$TERMINAL_RECOVERY_PENDING" -eq 1 ]; then
    bind_terminal_pending_source_authority
    SOURCE_JOURNAL_LOAD="$(select_terminal_journal_load_record source)"
    ROLLBACK_JOURNAL_LOAD="$(select_terminal_journal_load_record rollback)"
    SOURCE_JOURNAL=$SOURCE_JOURNAL_LOAD
    ROLLBACK_JOURNAL=$ROLLBACK_JOURNAL_LOAD
fi
test -f "$SOURCE_JOURNAL"
test ! -L "$SOURCE_JOURNAL"
test "$(stat -c '%U %G %a' "$SOURCE_JOURNAL")" = 'root root 600'
G0_COMMIT="$(jq -er '.g0_commit' "$SOURCE_JOURNAL")"
printf '%s' "$G0_COMMIT" | grep -Eq '^[a-f0-9]{40}$'
SOURCE_INITIAL_PHASE="$(jq -er '.phase' "$SOURCE_JOURNAL")"
case "$SOURCE_INITIAL_PHASE" in
    rollback_failed) SOURCE_ORIGIN_PHASE="$(jq -er '.failed_from' "$SOURCE_JOURNAL")" ;;
    rolled_back) SOURCE_ORIGIN_PHASE="$(jq -er '.rollback_origin_phase' "$SOURCE_JOURNAL")" ;;
    *) SOURCE_ORIGIN_PHASE="$SOURCE_INITIAL_PHASE" ;;
esac
case "$SOURCE_ORIGIN_PHASE" in
    initializing|prepared|backup_created|mutation_started|mutated|timer_enabled|committed) ;;
    *) exit 1 ;;
esac
SITE_BASE_DEV="$(jq -er '.original_site_dev' "$SOURCE_JOURNAL")"
SITE_BASE_INO="$(jq -er '.original_site_ino' "$SOURCE_JOURNAL")"
printf '%s:%s' "$SITE_BASE_DEV" "$SITE_BASE_INO" | grep -Eq '^[0-9]+:[0-9]+$'
INSTALLER_CANDIDATE="$(jq -er '.installer_candidate' "$SOURCE_JOURNAL")"
test "$INSTALLER_CANDIDATE" = \
    "/etc/nginx/sites-available/aifeeds.conf.candidate-gl-a-${TRANSACTION_ID}" \
    || { printf 'ERROR installer_candidate_identity=1\n'; exit 79; }
INSTALLER_CANDIDATE_DEV="$(jq -r '.installer_candidate_dev // ""' "$SOURCE_JOURNAL")"
INSTALLER_CANDIDATE_INO="$(jq -r '.installer_candidate_ino // ""' "$SOURCE_JOURNAL")"
if [ -n "$INSTALLER_CANDIDATE_DEV" ] || [ -n "$INSTALLER_CANDIDATE_INO" ]; then
    test -n "$INSTALLER_CANDIDATE_DEV" && test -n "$INSTALLER_CANDIDATE_INO"
    printf '%s:%s' "$INSTALLER_CANDIDATE_DEV" "$INSTALLER_CANDIDATE_INO" \
        | grep -Eq '^[0-9]+:[0-9]+$'
fi
ROLLBACK_CANDIDATE_DEV="$(jq -r '.rollback_candidate_dev // ""' "$SOURCE_JOURNAL")"
ROLLBACK_CANDIDATE_INO="$(jq -r '.rollback_candidate_ino // ""' "$SOURCE_JOURNAL")"
SOURCE_ROLLBACK_CANDIDATE_DEV=$ROLLBACK_CANDIDATE_DEV
SOURCE_ROLLBACK_CANDIDATE_INO=$ROLLBACK_CANDIDATE_INO
if [ -n "$ROLLBACK_CANDIDATE_DEV" ] || [ -n "$ROLLBACK_CANDIDATE_INO" ]; then
    test -n "$ROLLBACK_CANDIDATE_DEV" && test -n "$ROLLBACK_CANDIDATE_INO"
    printf '%s:%s' "$ROLLBACK_CANDIDATE_DEV" "$ROLLBACK_CANDIDATE_INO" \
        | grep -Eq '^[0-9]+:[0-9]+$'
fi
INSTALLER_STAGE_DIR="${INSTALLER_CANDIDATE%/*}"
test "$INSTALLER_STAGE_DIR" = /etc/nginx/sites-available
test -d "$INSTALLER_STAGE_DIR"
test ! -L "$INSTALLER_STAGE_DIR"
test "$(stat -c '%u' "$INSTALLER_STAGE_DIR")" = 0
INSTALLER_STAGE_MODE="$(stat -c '%a' "$INSTALLER_STAGE_DIR")"
printf '%s' "$INSTALLER_STAGE_MODE" | grep -Eq '^[0-7]{3,4}$'
test "$((8#$INSTALLER_STAGE_MODE & 0022))" -eq 0
ARTIFACTS_SHA256_JSON="$(jq -cS '.artifacts_sha256' "$SOURCE_JOURNAL")"
jq -e 'keys == ["checker","diff_checker","format","inserter","rotate","service","timer"] and
    all(.[]; type == "string" and test("^[a-f0-9]{64}$"))' \
    <<< "$ARTIFACTS_SHA256_JSON" >/dev/null
ARTIFACT_CANDIDATES_JSON="$(jq -cS '.artifact_candidates' "$SOURCE_JOURNAL")"
test "$ARTIFACT_CANDIDATES_JSON" = "$(jq -cS . <<< "$EXPECTED_ARTIFACT_CANDIDATES_JSON")"
FORMAT_SHA256="$(jq -er '.format' <<< "$ARTIFACTS_SHA256_JSON")"
ROTATE_SHA256="$(jq -er '.rotate' <<< "$ARTIFACTS_SHA256_JSON")"
CHECKER_SHA256="$(jq -er '.checker' <<< "$ARTIFACTS_SHA256_JSON")"
DIFF_CHECKER_SHA256="$(jq -er '.diff_checker' <<< "$ARTIFACTS_SHA256_JSON")"
INSERTER_SHA256="$(jq -er '.inserter' <<< "$ARTIFACTS_SHA256_JSON")"
SERVICE_SHA256="$(jq -er '.service' <<< "$ARTIFACTS_SHA256_JSON")"
TIMER_SHA256="$(jq -er '.timer' <<< "$ARTIFACTS_SHA256_JSON")"
RUNTIME_ARTIFACTS_JSON="$(jq -cS '.runtime_artifacts // []' "$SOURCE_JOURNAL")"
RUNTIME_ARTIFACTS_SEALED="$(jq -r '.runtime_artifacts_sealed // false' "$SOURCE_JOURNAL")"
case "$RUNTIME_ARTIFACTS_SEALED" in true|false) ;; *) exit 1 ;; esac
ROTATION_STATE_IDENTITY_JSON="$(jq -cS '.rotation_state_identity // null' "$SOURCE_JOURNAL")"
ROTATION_STATE_SNAPSHOT_JSON="$(jq -cS '.rotation_state_snapshot // null' "$SOURCE_JOURNAL")"
ROTATION_ANCHOR_IDENTITY_JSON="$(jq -cS '.rotation_anchor_identity // null' "$SOURCE_JOURNAL")"
SITE_BACKUP_IDENTITY_JSON="$(jq -cS '.site_backup_identity // null' "$SOURCE_JOURNAL")"
if [ "$ROTATION_ANCHOR_IDENTITY_JSON" = null ]; then
    case "$SOURCE_ORIGIN_PHASE" in initializing|prepared|backup_created|mutation_started) ;; *) exit 1 ;; esac
    test ! -e "$ROTATION_ANCHOR" && test ! -L "$ROTATION_ANCHOR"
else
    jq -e --arg path "$ROTATION_ANCHOR" '
        (keys | sort) == ["dev","gid","ino","mode","path","sha256","size","state","uid"] and
        (.state == "allocated" or .state == "prepared" or .state == "sealed") and
        .path == $path and (.sha256 | test("^[a-f0-9]{64}$")) and
        (.size | type == "number" and . >= 0 and . == floor) and
        .uid == 0 and .gid == 0 and .mode == "600" and
        (.dev | type == "number" and . > 0 and . == floor) and
        (.ino | type == "number" and . > 0 and . == floor) and
        (if .state == "allocated" then .size == 0 else .size > 0 end)' \
        <<< "$ROTATION_ANCHOR_IDENTITY_JSON" >/dev/null
fi
if [ "$SITE_BACKUP_IDENTITY_JSON" = null ]; then
    case "$SOURCE_ORIGIN_PHASE" in initializing|prepared) ;; *) exit 1 ;; esac
else
    jq -e --arg path "$BACKUP" --arg sha256 "$BACKUP_SHA256" \
        --argjson uid "$SITE_UID" --argjson gid "$SITE_GID" --arg mode "$SITE_MODE" '
        (keys | sort) == ["dev","gid","ino","mode","path","sha256","staging_gid",
                          "staging_mode","staging_uid","uid"] and
        .path == $path and .sha256 == $sha256 and .uid == $uid and .gid == $gid and
        .mode == $mode and .staging_uid == 0 and .staging_gid == 0 and
        .staging_mode == "600" and
        (.dev | type == "number" and . > 0 and . == floor) and
        (.ino | type == "number" and . > 0 and . == floor)
    ' <<< "$SITE_BACKUP_IDENTITY_JSON" >/dev/null
fi
runtime_artifacts_are_operation_bound
if [ "$RUNTIME_ARTIFACTS_SEALED" = true ]; then
    test "$(jq -r 'length' <<< "$RUNTIME_ARTIFACTS_JSON")" = 8
fi
jq -e \
    --arg operation_id "$TRANSACTION_ID" \
    --arg g0_commit "$G0_COMMIT" \
    --arg rollback_helper_sha256 "$ROLLBACK_HELPER_SHA256" \
    --arg transaction_journal "$SOURCE_JOURNAL_FINAL" \
    --arg installer_candidate "$INSTALLER_CANDIDATE" \
    --arg rollback_candidate "$ROLLBACK_CANDIDATE" \
    --arg backup "$BACKUP" --arg backup_sha "$BACKUP_SHA256" \
    --arg installed_sha "$INSTALLED_SITE_SHA256" \
    --argjson site_uid "$SITE_UID" --argjson site_gid "$SITE_GID" --arg site_mode "$SITE_MODE" \
    --argjson site_dev "$SITE_BASE_DEV" --argjson site_ino "$SITE_BASE_INO" \
    --argjson artifact_candidates "$ARTIFACT_CANDIDATES_JSON" \
    --argjson site_backup_identity "$SITE_BACKUP_IDENTITY_JSON" \
    --arg audit "${BACKUP_DIR}/audit-${TRANSACTION_ID}" --arg archive "$ARCHIVE_MANIFEST" '
    .schema == 1 and .gate == "GL-a" and .operation_id == $operation_id and
    .g0_commit == $g0_commit and .rollback_helper_sha256 == $rollback_helper_sha256 and
    .transaction_journal == $transaction_journal and .installer_candidate == $installer_candidate and
    .rollback_candidate == $rollback_candidate and
    .site_backup == $backup and .site_backup_sha256 == $backup_sha and
    .installed_site_sha256 == $installed_sha and .audit_dir == $audit and
    .log_archive_manifest == $archive and
    .original_site_uid == $site_uid and .original_site_gid == $site_gid and
    .original_site_mode == $site_mode and .original_site_dev == $site_dev and
    .original_site_ino == $site_ino and .artifact_candidates == $artifact_candidates and
    .site_backup_identity == $site_backup_identity and
    (.phase == "initializing" or .phase == "prepared" or .phase == "backup_created" or
     .phase == "mutation_started" or
     .phase == "mutated" or .phase == "timer_enabled" or .phase == "committed" or
     .phase == "rollback_failed" or .phase == "rolled_back")' \
    "$SOURCE_JOURNAL" >/dev/null

EARLY_RECOVERY_ALLOWED=0
case "$SOURCE_ORIGIN_PHASE" in initializing|prepared) EARLY_RECOVERY_ALLOWED=1 ;; esac
BACKUP_PRESENT=0
BACKUP_STATE=absent
if [ -e "$BACKUP" ] || [ -L "$BACKUP" ]; then
    test "$SITE_BACKUP_IDENTITY_JSON" != null
    backup_observed_identity="$(capture_site_backup_identity_stable "$BACKUP" \
        "$(jq -er '.dev' <<< "$SITE_BACKUP_IDENTITY_JSON")" \
        "$(jq -er '.ino' <<< "$SITE_BACKUP_IDENTITY_JSON")")"
    if [ "$(jq -er '.uid' <<< "$backup_observed_identity")" = "$SITE_UID" ] \
        && [ "$(jq -er '.gid' <<< "$backup_observed_identity")" = "$SITE_GID" ] \
        && [ "$(jq -er '.mode' <<< "$backup_observed_identity")" = "$SITE_MODE" ] \
        && [ "$(jq -er '.sha256' <<< "$backup_observed_identity")" = "$BACKUP_SHA256" ]; then
        BACKUP_PRESENT=1
        BACKUP_STATE=valid
    else
        test "$EARLY_RECOVERY_ALLOWED" = 1
        BACKUP_STATE=partial
    fi
else
    test "$EARLY_RECOVERY_ALLOWED" = 1
fi

if [ -e "$ROLLBACK_JOURNAL" ] || [ -L "$ROLLBACK_JOURNAL" ]; then
    test -f "$ROLLBACK_JOURNAL"
    test ! -L "$ROLLBACK_JOURNAL"
    test "$(stat -c '%U %G %a' "$ROLLBACK_JOURNAL")" = 'root root 600'
    jq -e \
        --arg source "$SOURCE_JOURNAL_FINAL" --arg source_sha "$SOURCE_JOURNAL_SHA256" \
        --arg operation_id "$TRANSACTION_ID" --arg g0_commit "$G0_COMMIT" \
        --arg rollback_helper_sha256 "$ROLLBACK_HELPER_SHA256" \
        --arg rollback_journal "$ROLLBACK_JOURNAL_FINAL" \
        --arg rollback_candidate "$ROLLBACK_CANDIDATE" \
        --arg rollback_commit_marker "$ROLLBACK_COMMIT_MARKER" \
        --arg source_origin_phase "$SOURCE_ORIGIN_PHASE" \
        --argjson artifacts_sha256 "$ARTIFACTS_SHA256_JSON" \
        --argjson artifact_candidates "$ARTIFACT_CANDIDATES_JSON" \
        --arg backup "$BACKUP" --arg backup_sha "$BACKUP_SHA256" \
        --arg installed_sha "$INSTALLED_SITE_SHA256" --arg audit "$AUDIT_DIR" \
        --arg archive "$ARCHIVE_MANIFEST" \
        --argjson site_uid "$SITE_UID" --argjson site_gid "$SITE_GID" --arg site_mode "$SITE_MODE" \
        --argjson site_dev "$SITE_BASE_DEV" --argjson site_ino "$SITE_BASE_INO" '
        .schema == 1 and .gate == "GL-a-manual-rollback" and
        .operation_id == $operation_id and .g0_commit == $g0_commit and
        .rollback_helper_sha256 == $rollback_helper_sha256 and
        .rollback_journal == $rollback_journal and
        .rollback_commit_marker == $rollback_commit_marker and
        .rollback_candidate == $rollback_candidate and
        .artifacts_sha256 == $artifacts_sha256 and
        .artifact_candidates == $artifact_candidates and
        .source_origin_phase == $source_origin_phase and
        .source_journal == $source and .source_journal_sha256 == $source_sha and
        .site_backup == $backup and .site_backup_sha256 == $backup_sha and
        .installed_site_sha256 == $installed_sha and .audit_dir == $audit and
        .log_archive_manifest == $archive and
        .original_site_uid == $site_uid and .original_site_gid == $site_gid and
        .original_site_mode == $site_mode and .original_site_dev == $site_dev and
        .original_site_ino == $site_ino and
        (.phase == "prepared" or .phase == "site_restored" or
         .phase == "runtime_cleanup_started" or .phase == "runtime_removed" or
         .phase == "nginx_reloaded" or .phase == "logs_archived" or
         .phase == "rollback_failed" or .phase == "rolled_back") and
        (if .phase == "rolled_back" then
           (.source_journal_terminal_sha256 | test("^[a-f0-9]{64}$"))
         else (has("source_journal_terminal_sha256") | not) end)' \
        "$ROLLBACK_JOURNAL" >/dev/null
    ROLLBACK_JOURNAL_CREATED=1
    RESUME_ROLLBACK_PHASE="$(jq -er '.phase' "$ROLLBACK_JOURNAL")"
    case "$RESUME_ROLLBACK_PHASE" in
        rollback_failed)
            RESUME_ROLLBACK_PHASE="$(jq -er '.failed_from' "$ROLLBACK_JOURNAL")"
            ROLLBACK_FAILURE_FROM="$RESUME_ROLLBACK_PHASE"
            ;;
    esac
    if jq -e '.phase == "rolled_back"' "$ROLLBACK_JOURNAL" >/dev/null; then
        ROLLBACK_TERMINAL=1
    fi
fi

if [ "$ROLLBACK_JOURNAL_CREATED" = 1 ] \
    && jq -e 'has("displaced_site_dev") and has("displaced_site_ino")' \
        "$ROLLBACK_JOURNAL" >/dev/null; then
    PUBLISHED_DISPLACED_DEV="$(jq -er '.displaced_site_dev' "$ROLLBACK_JOURNAL")"
    PUBLISHED_DISPLACED_INO="$(jq -er '.displaced_site_ino' "$ROLLBACK_JOURNAL")"
    printf '%s:%s' "$PUBLISHED_DISPLACED_DEV" "$PUBLISHED_DISPLACED_INO" \
        | grep -Eq '^[0-9]+:[0-9]+$'
fi
if [ "$ROLLBACK_JOURNAL_CREATED" = 1 ]; then
    test "$(jq -cS '.runtime_artifacts' "$ROLLBACK_JOURNAL")" = "$RUNTIME_ARTIFACTS_JSON"
    test "$(jq -er '.runtime_artifacts_sealed' "$ROLLBACK_JOURNAL")" = \
        "$RUNTIME_ARTIFACTS_SEALED"
    test "$(jq -cS '.site_backup_identity' "$ROLLBACK_JOURNAL")" = \
        "$SITE_BACKUP_IDENTITY_JSON"
    test "$(jq -cS '.rotation_anchor_identity // null' "$ROLLBACK_JOURNAL")" = \
        "$ROTATION_ANCHOR_IDENTITY_JSON"
    ROTATION_STATE_IDENTITY_JSON="$(jq -cS '.rotation_state_identity' "$ROLLBACK_JOURNAL")"
    ROTATION_STATE_SNAPSHOT_JSON="$(jq -cS '.rotation_state_snapshot // null' "$ROLLBACK_JOURNAL")"
    ROTATION_ANCHOR_IDENTITY_JSON="$(jq -cS '.rotation_anchor_identity // null' "$ROLLBACK_JOURNAL")"
    RUNTIME_CLEANUP_JSON="$(jq -cS '.runtime_cleanup // null' "$ROLLBACK_JOURNAL")"
    if jq -e '.phase == "logs_archived" or .phase == "rolled_back" or
        (.phase == "rollback_failed" and .failed_from == "logs_archived")' \
        "$ROLLBACK_JOURNAL" >/dev/null; then
        TERMINAL_ARCHIVE_MANIFEST_SHA256="$(jq -er '.log_archive_manifest_sha256' "$ROLLBACK_JOURNAL")"
        TERMINAL_ARCHIVE_MANIFEST_GENERATION="$(jq -er '.log_archive_manifest_generation' "$ROLLBACK_JOURNAL")"
        TERMINAL_ARCHIVE_MANIFEST_ENTRY_COUNT="$(jq -er '.log_archive_manifest_entry_count' "$ROLLBACK_JOURNAL")"
    fi
    journal_rollback_candidate_dev="$(jq -r '.rollback_candidate_dev // ""' "$ROLLBACK_JOURNAL")"
    journal_rollback_candidate_ino="$(jq -r '.rollback_candidate_ino // ""' "$ROLLBACK_JOURNAL")"
    if [ -n "$SOURCE_ROLLBACK_CANDIDATE_DEV" ]; then
        test "$journal_rollback_candidate_dev:$journal_rollback_candidate_ino" = \
            "$SOURCE_ROLLBACK_CANDIDATE_DEV:$SOURCE_ROLLBACK_CANDIDATE_INO"
    fi
    ROLLBACK_CANDIDATE_DEV=${journal_rollback_candidate_dev:-$SOURCE_ROLLBACK_CANDIDATE_DEV}
    ROLLBACK_CANDIDATE_INO=${journal_rollback_candidate_ino:-$SOURCE_ROLLBACK_CANDIDATE_INO}
    if [ -n "$ROLLBACK_CANDIDATE_DEV" ] || [ -n "$ROLLBACK_CANDIDATE_INO" ]; then
        test -n "$ROLLBACK_CANDIDATE_DEV" && test -n "$ROLLBACK_CANDIDATE_INO"
        printf '%s:%s' "$ROLLBACK_CANDIDATE_DEV" "$ROLLBACK_CANDIDATE_INO" \
            | grep -Eq '^[0-9]+:[0-9]+$'
    fi
    PARTIAL_BACKUP_SHA256="$(jq -r '.partial_backup_sha256 // ""' "$ROLLBACK_JOURNAL")"
    PARTIAL_BACKUP_DEV="$(jq -r '.partial_backup_dev // ""' "$ROLLBACK_JOURNAL")"
    PARTIAL_BACKUP_INO="$(jq -r '.partial_backup_ino // ""' "$ROLLBACK_JOURNAL")"
    if [ -n "$PARTIAL_BACKUP_SHA256$PARTIAL_BACKUP_DEV$PARTIAL_BACKUP_INO" ]; then
        printf '%s:%s:%s' "$PARTIAL_BACKUP_SHA256" "$PARTIAL_BACKUP_DEV" "$PARTIAL_BACKUP_INO" \
            | grep -Eq '^[a-f0-9]{64}:[0-9]+:[0-9]+$'
    fi
fi

SOURCE_JOURNAL=$SOURCE_JOURNAL_FINAL
ROLLBACK_JOURNAL=$ROLLBACK_JOURNAL_FINAL
if [ "$TERMINAL_RECOVERY_PENDING" -eq 1 ]; then
    takeover_terminal_pair_commit_marker_tmp
    terminal_pair_unified_precommit_recover
else
    recover_archive_manifest_cleanup_tombstone
    recover_runtime_artifact_cleanup_tombstones
    recover_rotation_state_cleanup_tombstones
    recover_private_cleanup_tombstone "$INSTALLER_ROLLBACK_CANDIDATE" \
        "$BACKUP_SHA256" "$SITE_UID" "$SITE_GID" "$SITE_MODE" 5 \
        "$SITE_BASE_DEV" "$SITE_BASE_INO" 0
    if [ "$INSTALLED_SITE_SHA256" != absent ]; then
        if [ -n "${PUBLISHED_DISPLACED_DEV:-}" ] && [ -n "$INSTALLER_CANDIDATE_DEV" ]; then
            test "$PUBLISHED_DISPLACED_DEV:$PUBLISHED_DISPLACED_INO" = \
                "$INSTALLER_CANDIDATE_DEV:$INSTALLER_CANDIDATE_INO"
        fi
        CANDIDATE_CLEANUP_DEV=${PUBLISHED_DISPLACED_DEV:-$INSTALLER_CANDIDATE_DEV}
        CANDIDATE_CLEANUP_INO=${PUBLISHED_DISPLACED_INO:-$INSTALLER_CANDIDATE_INO}
        recover_private_cleanup_tombstone "$INSTALLER_CANDIDATE" \
            "$INSTALLED_SITE_SHA256" "$SITE_UID" "$SITE_GID" "$SITE_MODE" 5 \
            "$CANDIDATE_CLEANUP_DEV" "$CANDIDATE_CLEANUP_INO" 0
    fi
fi

CURRENT_SOURCE_SHA256="$(sha256sum "$SOURCE_JOURNAL" | awk '{print $1}')"
if [ "$CURRENT_SOURCE_SHA256" = "$SOURCE_JOURNAL_SHA256" ]; then
    jq -e \
        --arg journal "$SOURCE_JOURNAL" --arg backup "$BACKUP" \
        --arg operation_id "$TRANSACTION_ID" --arg g0_commit "$G0_COMMIT" \
        --arg rollback_helper_sha256 "$ROLLBACK_HELPER_SHA256" \
        --arg backup_sha "$BACKUP_SHA256" --arg installed_sha "$INSTALLED_SITE_SHA256" '
        .schema == 1 and .gate == "GL-a" and .operation_id == $operation_id and
        .g0_commit == $g0_commit and .rollback_helper_sha256 == $rollback_helper_sha256 and
        .transaction_journal == $journal and
        .site_backup == $backup and .site_backup_sha256 == $backup_sha and
        .installed_site_sha256 == $installed_sha' "$SOURCE_JOURNAL" >/dev/null
else
    test "$ROLLBACK_JOURNAL_CREATED" = 1
    jq -e --arg rollback_journal "$ROLLBACK_JOURNAL" \
        '.schema == 1 and .gate == "GL-a" and .phase == "rolled_back" and
         .rollback_journal == $rollback_journal' "$SOURCE_JOURNAL" >/dev/null
fi

if [ "$ROLLBACK_JOURNAL_CREATED" = 1 ] \
    && jq -e '.phase == "rolled_back"' "$ROLLBACK_JOURNAL" >/dev/null; then
    validate_committed_terminal_pair_physical_chain
    emit_summary
    validate_committed_terminal_pair_physical_chain
    SUCCESS=1
    printf 'manual_rollback=pass resumed=1\n'
    exit 0
fi

case "$RESUME_ROLLBACK_PHASE" in
none|prepared)
if [ ! -e "$SITE" ] && [ ! -L "$SITE" ]; then
    test "$INSTALLED_SITE_SHA256" != absent
    test -n "$ROLLBACK_CANDIDATE_DEV" && test -n "$ROLLBACK_CANDIDATE_INO"
    test -n "$INSTALLER_CANDIDATE_DEV" && test -n "$INSTALLER_CANDIDATE_INO"
    path_matches_exact_identity "$ROLLBACK_CANDIDATE" "$BACKUP_SHA256" \
        "$SITE_UID" "$SITE_GID" "$SITE_MODE" \
        "$ROLLBACK_CANDIDATE_DEV" "$ROLLBACK_CANDIDATE_INO"
    path_matches_exact_identity "$INSTALLER_CANDIDATE" "$INSTALLED_SITE_SHA256" \
        "$SITE_UID" "$SITE_GID" "$SITE_MODE" \
        "$INSTALLER_CANDIDATE_DEV" "$INSTALLER_CANDIDATE_INO"
    rename_no_replace "$ROLLBACK_CANDIDATE" "$SITE"
    sync -f "$SITE"
fi

CURRENT_SITE_SHA256=''
CURRENT_SITE_STATE=invalid
assert_enabled_site_target
if formal_site_matches_state "$SITE" base; then
    CURRENT_SITE_SHA256=$BACKUP_SHA256
    CURRENT_SITE_STATE=base
elif formal_site_matches_state "$SITE" installed; then
    CURRENT_SITE_SHA256=$INSTALLED_SITE_SHA256
    CURRENT_SITE_STATE=installed
else
    printf 'ERROR site_drift=1\n'
    exit 78
fi
if [ "$BACKUP_PRESENT" -ne 1 ]; then
    test "$CURRENT_SITE_SHA256" = "$BACKUP_SHA256"
fi
preflight_rotation_control_plane
case "$SOURCE_ORIGIN_PHASE" in
    initializing|prepared|backup_created)
        for early_path in "$FORMAT" "$ROTATE" "$LOG" "$CHECKER" "$DIFF_CHECKER" "$INSERTER" \
            "$SERVICE_PATH" "$TIMER_PATH" "$ROTATE_STATE_DIR" "$ROTATE_STATE_DIR_CANDIDATE"; do
            test ! -e "$early_path"
            test ! -L "$early_path"
        done
        ;;
esac

persist_exceptional_authority
write_rollback_journal prepared

quiesce_rotation_control_plane
if [ -e "$ROTATE_STATE_DIR" ] || [ -L "$ROTATE_STATE_DIR" ]; then
    run_rotation_authorized_command rotation-recover "$TRANSACTION_ID" \
        "$ROTATION_ANCHOR_IDENTITY_JSON" "$RUNTIME_ARTIFACTS_JSON" >/dev/null
fi
quiesce_rotation_control_plane
persist_rotation_state_identity
preflight_owned_runtime

if [ "$BACKUP_STATE" = partial ]; then
    ensure_audit_dir_owned
    PARTIAL_BACKUP_AUDIT="$AUDIT_DIR/incomplete-site-backup"
    test ! -e "$PARTIAL_BACKUP_AUDIT"
    test ! -L "$PARTIAL_BACKUP_AUDIT"
    partial_backup_identity="$(capture_partial_backup_identity "$BACKUP" \
        "$(jq -er '.dev' <<< "$SITE_BACKUP_IDENTITY_JSON")" \
        "$(jq -er '.ino' <<< "$SITE_BACKUP_IDENTITY_JSON")")"
    PARTIAL_BACKUP_SHA256="$(jq -er '.sha256' <<< "$partial_backup_identity")"
    PARTIAL_BACKUP_DEV="$(jq -er '.dev' <<< "$partial_backup_identity")"
    PARTIAL_BACKUP_INO="$(jq -er '.ino' <<< "$partial_backup_identity")"
    write_rollback_journal prepared
    path_matches_exact_identity "$BACKUP" "$PARTIAL_BACKUP_SHA256" 0 0 600 \
        "$PARTIAL_BACKUP_DEV" "$PARTIAL_BACKUP_INO"
    rename_no_replace "$BACKUP" "$PARTIAL_BACKUP_AUDIT"
    path_matches_exact_identity "$PARTIAL_BACKUP_AUDIT" "$PARTIAL_BACKUP_SHA256" 0 0 600 \
        "$PARTIAL_BACKUP_DEV" "$PARTIAL_BACKUP_INO"
    BACKUP_STATE=archived_partial
fi

assert_enabled_site_target

if [ "$CURRENT_SITE_STATE" = installed ]; then
    test "$BACKUP_PRESENT" = 1
    CURRENT_INSTALLED_DEV=$INSTALLER_CANDIDATE_DEV
    CURRENT_INSTALLED_INO=$INSTALLER_CANDIDATE_INO
    if [ -e "$ROLLBACK_CANDIDATE" ] || [ -L "$ROLLBACK_CANDIDATE" ]; then
        restore_candidate_is_owned_or_absent "$ROLLBACK_CANDIDATE"
    fi
    if [ ! -e "$ROLLBACK_CANDIDATE" ] && [ ! -L "$ROLLBACK_CANDIDATE" ]; then
        rollback_candidate_identity="$(copy_file_no_replace "$BACKUP" "$ROLLBACK_CANDIDATE" \
            "$BACKUP_SHA256" "$SITE_UID" "$SITE_GID" "$SITE_MODE" \
            "$(jq -er '.dev' <<< "$SITE_BACKUP_IDENTITY_JSON")" \
            "$(jq -er '.ino' <<< "$SITE_BACKUP_IDENTITY_JSON")")"
        rollback_candidate_current_dev=${rollback_candidate_identity%%:*}
        rollback_candidate_current_ino=${rollback_candidate_identity##*:}
    elif [ -n "$ROLLBACK_CANDIDATE_DEV" ] && [ -n "$ROLLBACK_CANDIDATE_INO" ]; then
        rollback_candidate_current_dev=$ROLLBACK_CANDIDATE_DEV
        rollback_candidate_current_ino=$ROLLBACK_CANDIDATE_INO
    else
        rollback_candidate_current_dev=$SITE_BASE_DEV
        rollback_candidate_current_ino=$SITE_BASE_INO
    fi
    path_matches_exact_identity "$ROLLBACK_CANDIDATE" "$BACKUP_SHA256" \
        "$SITE_UID" "$SITE_GID" "$SITE_MODE" \
        "$rollback_candidate_current_dev" "$rollback_candidate_current_ino"
    if [ -n "$ROLLBACK_CANDIDATE_DEV" ] || [ -n "$ROLLBACK_CANDIDATE_INO" ]; then
        test "$rollback_candidate_current_dev:$rollback_candidate_current_ino" = \
            "$ROLLBACK_CANDIDATE_DEV:$ROLLBACK_CANDIDATE_INO"
    else
        ROLLBACK_CANDIDATE_DEV=$rollback_candidate_current_dev
        ROLLBACK_CANDIDATE_INO=$rollback_candidate_current_ino
        write_rollback_journal prepared
    fi
    sync -f "$ROLLBACK_CANDIDATE"
    test "$(sha256sum "$ROLLBACK_CANDIDATE" | awk '{print $1}')" = "$BACKUP_SHA256"
    test "$(stat -c '%u' "$ROLLBACK_CANDIDATE")" = "$SITE_UID"
    test "$(stat -c '%g' "$ROLLBACK_CANDIDATE")" = "$SITE_GID"
    test "$(stat -c '%a' "$ROLLBACK_CANDIDATE")" = "$SITE_MODE"
    assert_enabled_site_target
    publish_site_no_replace "$SITE" "$ROLLBACK_CANDIDATE" "$INSTALLER_CANDIDATE" "$INSTALLED_SITE_SHA256" "$BACKUP_SHA256" \
        "$SITE_UID" "$SITE_GID" "$SITE_MODE" "$CURRENT_INSTALLED_DEV" "$CURRENT_INSTALLED_INO" \
        "$ROLLBACK_CANDIDATE_DEV" "$ROLLBACK_CANDIDATE_INO"
    assert_enabled_site_target
    write_rollback_journal prepared
fi
assert_site_base_unchanged
write_rollback_journal site_restored
start_runtime_cleanup_plan
    ;;
site_restored)
    assert_site_base_unchanged
    start_runtime_cleanup_plan
    ;;
runtime_cleanup_started)
    complete_runtime_cleanup_plan
    ;;
runtime_removed|nginx_reloaded|logs_archived)
    if [ "$RUNTIME_CLEANUP_JSON" = null ]; then
        resume_legacy_runtime_removed_cleanup
    elif jq -e '.compatibility_mode == "legacy_runtime_removed" and
        (.cursor_state != "complete" or .cursor != (.items | length))' \
        <<< "$RUNTIME_CLEANUP_JSON" >/dev/null; then
        complete_runtime_cleanup_plan
    else
        test "$(jq -er '.cursor_state' <<< "$RUNTIME_CLEANUP_JSON")" = complete
        test "$(jq -er '.cursor' <<< "$RUNTIME_CLEANUP_JSON")" = \
            "$(jq -er '.items | length' <<< "$RUNTIME_CLEANUP_JSON")"
    fi
    assert_owned_cleanup_state
    ;;
*) exit 1 ;;
esac

case "$RESUME_ROLLBACK_PHASE" in
nginx_reloaded|logs_archived)
    assert_owned_cleanup_state
    ;;
*)
systemctl daemon-reload
assert_owned_cleanup_state
unit_is_inactive "$TIMER_UNIT"
unit_is_inactive "$ROTATE_SERVICE"
timer_is_disabled
nginx -t >/dev/null
assert_owned_cleanup_state
systemctl reload nginx >/dev/null
assert_owned_cleanup_state
systemctl is-active --quiet nginx
write_rollback_journal nginx_reloaded
    ;;
esac

if [ "$RESUME_ROLLBACK_PHASE" != logs_archived ]; then
ROLLBACK_RUNTIME_CLEAN=0
ROLLBACK_RUNTIME_ATTEMPT=1
while [ "$ROLLBACK_RUNTIME_ATTEMPT" -le 3 ]; do
    sleep 1
    ROLLBACK_PROBE="upstream-$(date +%s)-$(openssl rand -hex 4)"
    test "$(curl -fsS --connect-timeout 5 --max-time 15 -H "X-Aifeeds-Perf-Probe: $ROLLBACK_PROBE" \
        -o /dev/null -w '%{http_code}' https://ai-feeds.com/)" = 200
    test "$(curl -fsS --connect-timeout 5 --max-time 15 -H "X-Aifeeds-Perf-Probe: $ROLLBACK_PROBE" \
        -o /dev/null -w '%{http_code}' 'https://api.ai-feeds.com/api/items?source_type=x_list&limit=1')" = 200
    sleep 6
    assert_owned_cleanup_state
    if probe_absent_from_audit /var/log/nginx "$ROLLBACK_PROBE"; then
        ROLLBACK_RUNTIME_CLEAN=1
        break
    fi
    ROLLBACK_RUNTIME_ATTEMPT=$((ROLLBACK_RUNTIME_ATTEMPT + 1))
done
test "$ROLLBACK_RUNTIME_CLEAN" = 1

assert_owned_cleanup_state
archive_performance_logs
assert_owned_cleanup_state
write_rollback_journal logs_archived
terminal_pair_test_failure logs-archived
else
    archive_manifest_is_terminal
fi

POST_ARCHIVE_PROBE="upstream-$(date +%s)-$(openssl rand -hex 4)"
test "$(curl -fsS --connect-timeout 5 --max-time 15 -H "X-Aifeeds-Perf-Probe: $POST_ARCHIVE_PROBE" \
    -o /dev/null -w '%{http_code}' https://ai-feeds.com/)" = 200
test "$(curl -fsS --connect-timeout 5 --max-time 15 -H "X-Aifeeds-Perf-Probe: $POST_ARCHIVE_PROBE" \
    -o /dev/null -w '%{http_code}' 'https://api.ai-feeds.com/api/items?source_type=x_list&limit=1')" = 200
sleep 6
assert_owned_cleanup_state
no_performance_logs_present
probe_absent_from_audit "$AUDIT_DIR" "$POST_ARCHIVE_PROBE"

assert_terminal_state
stage_terminal_pair_journals
validate_staged_terminal_pair_cross
terminal_pair_test_crash pre-marker
write_terminal_pair_commit_marker prepared
terminal_pair_test_crash zero-side
update_source_journal_rolled_back
terminal_pair_test_crash one-side
write_rollback_journal rolled_back
terminal_pair_test_crash two-side
write_terminal_pair_commit_marker committed
cleanup_terminal_pair_predecessors
validate_committed_terminal_pair_physical_chain
emit_summary
validate_committed_terminal_pair_physical_chain
SUCCESS=1
printf 'manual_rollback=pass resumed=0\n'
