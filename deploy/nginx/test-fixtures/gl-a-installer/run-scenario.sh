#!/usr/bin/env bash
set -euo pipefail

scenario=${1:?scenario required}
case "$scenario" in
    preflight-logrotate-missing|recovery-logrotate-installed-after-failure|exceptional-recovery-initialized-candidate|exceptional-authority-pre-copy-crash-reentry|exceptional-authority-post-copy-crash-reentry|exceptional-authority-pre-rename-crash-reentry|exceptional-authority-post-rename-crash-reentry|exceptional-receipt-pre-copy-crash-reentry|exceptional-receipt-post-copy-crash-reentry|exceptional-receipt-pre-rename-crash-reentry|exceptional-receipt-post-rename-crash-reentry|success|reload-fail|probe-missing|logrotate-fail|service-fail-status-tmp|timer-partial-fail|term|rollback-daemon-reload-fail|concurrent-lock|manual-rollback-committed|manual-recovery-prepared|manual-recovery-initializing|manual-recovery-mutation-started|manual-recovery-site-swapped|manual-recovery-restore-candidate|manual-recovery-audit-log|systemctl-is-active-error|systemctl-is-enabled-error|negative-probe-grep-error|negative-probe-find-error|reinstall-after-auto-rollback|terminal-pair-tamper|manual-cleanup-drift|enabled-site-retarget-drift|manual-artifact-drift-terminal|manual-recovery-partial-backup|installer-journal-tmp-takeover|rollback-journal-tmp-takeover|systemd-missing-unit|site-cas-live-drift|site-cas-candidate-drift|manual-recovery-log-writer-tail|manual-recovery-log-writer-timeout|manual-recovery-terminal-pair-marker|preflight-journal-find-error|preflight-include-grep-error|archive-manifest-tmp-takeover|site-cas-internal-displaced-drift|site-cas-internal-candidate-drift|manual-site-cas-internal-candidate-drift|manual-site-cas-internal-displaced-drift|archive-manifest-stale-tmp|archive-manifest-regressive-tmp|archive-manifest-unknown-final|archive-manifest-orphan-audit|cross-filesystem-audit|terminal-pair-source-only|terminal-pair-rollback-only|terminal-pair-committed-marker-tmp|archive-manifest-previous-takeover|archive-manifest-three-way-conflict|artifact-install-candidate-takeover|artifact-install-destination-takeover|archive-manifest-previous-unknown-only|archive-manifest-previous-internal-drift|terminal-pair-internal-marker-drift|terminal-source-post-marker-check-drift|prelive-initializing-auto-rollback|prelive-prepared-auto-rollback|archive-manifest-delete-takeover|log-quarantine-delete-takeover|site-displaced-delete-takeover|archive-manifest-delete-crash-reentry|log-quarantine-delete-crash-reentry|site-displaced-delete-crash-reentry|terminal-pair-committed-tmp-drift|terminal-source-destination-drift|terminal-rollback-destination-drift|terminal-previous-delete-crash-reentry|prelive-initializing-validation-fail|prelive-prepared-delete-crash-reentry) ;;
    artifact-install-candidate-samebytes|artifact-final-delete-takeover|artifact-final-delete-crash-reentry|artifact-candidate-delete-crash-reentry|rotation-status-delete-takeover|rotation-status-delete-crash-reentry|partial-backup-destination-takeover|rotation-directory-candidate-takeover|restore-site-absent-samebytes-crash-reentry|crossfs-candidate-samebytes-takeover|crossfs-destination-samebytes-takeover|crossfs-copied-crash-reentry|crossfs-published-crash-reentry|archive-manifest-previous-valid-only|archive-manifest-previous-restart-samebytes|proc-quiescence-permission-denied|rotation-config-samebytes-takeover|rotation-logrotate-samebytes-takeover|rotation-anchor-samebytes-takeover|rotation-ledger-samebytes-takeover|rotation-child-nonzero|rotation-child-sigkill) ;;
    journal-source-g-reentry|journal-source-s1-reentry|journal-source-s2-reentry|journal-source-s3-reentry|journal-source-s4-reentry|journal-source-semantic-drift|journal-source-samebytes-predecessor|journal-source-partial-tmp|journal-source-p-only|journal-source-all-three|journal-source-unknown-cleanup|journal-rollback-g-reentry|journal-rollback-s1-reentry|journal-rollback-s2-reentry|journal-rollback-s3-reentry|journal-rollback-s4-reentry|journal-rollback-semantic-drift|journal-rollback-samebytes-predecessor|journal-rollback-partial-tmp|journal-rollback-p-only|journal-rollback-all-three|journal-rollback-unknown-cleanup|terminal-pair-zero-side-reentry|terminal-pair-one-side-reentry|terminal-pair-two-side-reentry|terminal-pair-pre-marker-reentry|terminal-source-p-bound-target-drift|terminal-source-c-bound-target-drift|cleanup-manual-detaching-reentry|cleanup-manual-detached-reentry|cleanup-automatic-detaching-reentry|cleanup-automatic-detached-reentry|cleanup-manual-unknown-tombstone|cleanup-automatic-unknown-tombstone|cleanup-manual-plan-drift|cleanup-automatic-plan-drift|cleanup-manual-failed-from-drift|cleanup-automatic-failed-from-drift|journal-source-legacy-genesis|journal-rollback-legacy-genesis-rejected|cleanup-manual-legacy-runtime-removed|cleanup-automatic-legacy-runtime-removed) ;;
    *) printf 'unknown scenario: %s\n' "$scenario" >&2; exit 64 ;;
esac

readonly fixture=/workspace/deploy/nginx/test-fixtures/gl-a-installer
readonly installer=/workspace/deploy/nginx/install-aifeeds-performance-log.sh
readonly rollback_helper=/workspace/deploy/nginx/rollback-aifeeds-performance-log.sh
rollback_helper_sha=$(sha256sum "$rollback_helper" | awk '{print $1}')
readonly rollback_helper_sha
readonly staging="/run/aifeeds-performance-log.$scenario"
readonly test_root=/tmp/gl-a-test
readonly output="$test_root/installer.out"
readonly operation_id='20260712000000-01234567'
readonly g0_commit='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
readonly shim_path="$fixture/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
readonly canary_file=/root/gl-a-secret-canary
canary="GL_A_SECRET_CANARY_$(openssl rand -hex 16)"
readonly canary

export GL_A_SCENARIO=$scenario
case "$scenario" in
    manual-recovery-log-writer-tail)
        export GL_A_TEST_LOG_QUIESCENCE_TIMEOUT_SECONDS=5
        ;;
    manual-recovery-log-writer-timeout)
        export GL_A_TEST_LOG_QUIESCENCE_TIMEOUT_SECONDS=1
        ;;
esac
export PATH=$shim_path

fail() {
    printf 'ASSERTION FAILED scenario=%s check=%s\n' "$scenario" "$1" >&2
    for diagnostic_name in output manual_output manual_reentry_output manual_crash_output \
        enabled_drift_output manual_drift_output manual_terminal_drift_output retry_output; do
        diagnostic_path=${!diagnostic_name:-}
        if [ -n "$diagnostic_path" ] && [ -s "$diagnostic_path" ]; then
            printf '%s\n' "--- $diagnostic_name" >&2
            sed "s/$canary/[REDACTED_CANARY]/g" "$diagnostic_path" | tail -n 160 >&2
        fi
    done
    find /var/backups/aifeeds-performance-log -maxdepth 2 -type f -name '*.json' \
        -exec sh -c 'printf "%s\n" "--- ${1##*/}"; jq . "$1"' _ {} \; >&2 2>/dev/null || true
    find /var/backups/aifeeds-performance-log -maxdepth 2 -type f -name 'aifeeds-performance.jsonl*' \
        -exec sh -c 'printf "%s\n" "--- ${1##*/}"; tail -n 30 "$1" | jq -c . 2>/dev/null || true' _ {} \; \
        >&2 2>/dev/null || true
    exit 1
}

wait_for_file() {
    local path=$1
    local limit=${2:-200}
    local attempt=0
    while [ "$attempt" -lt "$limit" ]; do
        [ -e "$path" ] && return 0
        sleep 0.05
        attempt=$((attempt + 1))
    done
    fail "timeout:${path##*/}"
}

wait_for_fixed_pattern() {
    local pattern=$1
    local path=$2
    local attempt=0
    while [ "$attempt" -lt 50 ]; do
        grep -R -Fq -- "$pattern" "$path" 2>/dev/null && return 0
        sleep 0.1
        attempt=$((attempt + 1))
    done
    fail "pattern-timeout:${path##*/}"
}

assert_mount_contract() {
    local options
    options=$(findmnt -n -o OPTIONS --target /workspace/deploy/nginx)
    case ",$options," in *,ro,*) ;; *) fail nginx-mount-not-readonly ;; esac
    options=$(findmnt -n -o OPTIONS --target /workspace/deploy/systemd)
    case ",$options," in *,ro,*) ;; *) fail systemd-mount-not-readonly ;; esac
    test "$(findmnt -rn -o TARGET | grep -Ec '^/workspace/deploy/(nginx|systemd)$')" -eq 2 \
        || fail unexpected-workspace-mount
    test -z "$(ip -o address show scope global)" || fail network-global-address-present
    test -z "$(ip route show default)" || fail network-default-route-present
    test "$(awk '$1 == "CapEff:" {print $2}' /proc/self/status)" != 000001ffffffffff \
        || fail privileged-container
    if findmnt -rn -o TARGET | grep -Eiq '(^|/)secrets?(/|$)'; then
        fail secret-mount-present
    fi
}

cleanup() {
    if [ -s /run/nginx.pid ]; then
        kill -QUIT "$(cat /run/nginx.pid)" 2>/dev/null || true
    fi
    if [ -n "${backend_pid:-}" ]; then
        kill "$backend_pid" 2>/dev/null || true
    fi
}
trap cleanup EXIT

assert_mount_contract
install -d -o root -g root -m 0700 "$test_root"
printf '%s\n' "$canary" > "$canary_file"
chmod 0600 "$canary_file"

rm -f /etc/nginx/sites-enabled/default
install -d -o root -g root -m 0755 \
    /etc/nginx/sites-available /etc/nginx/sites-enabled /etc/letsencrypt
install -o root -g root -m 0644 /dev/null /etc/letsencrypt/options-ssl-nginx.conf
install -o root -g root -m 0644 "$fixture/aifeeds.conf" /etc/nginx/sites-available/aifeeds.conf
ln -s /etc/nginx/sites-available/aifeeds.conf /etc/nginx/sites-enabled/aifeeds.conf
cp -a /etc/nginx/sites-available/aifeeds.conf "$test_root/aifeeds.conf.original"

python3 "$fixture/backend.py" > "$test_root/backend.out" 2>&1 &
backend_pid=$!
/usr/sbin/nginx
for _ in 1 2 3 4 5 6 7 8 9 10; do
    /usr/bin/curl -fsS -o /dev/null -H 'Host: ai-feeds.com' http://127.0.0.1:8080/ \
        2>/dev/null && break
    sleep 0.1
done
/usr/bin/curl -fsS -o /dev/null -H 'Host: ai-feeds.com' http://127.0.0.1:8080/ \
    || fail nginx-bootstrap

install -d -o root -g root -m 0700 "$staging"
payloads=(
    aifeeds-performance-log.conf
    aifeeds-performance.logrotate
    aifeeds-performance-logrotate.service
    aifeeds-performance-logrotate.timer
    check-nginx-request-id.py
    verify-nginx-request-id-diff.py
    insert-nginx-request-id.py
    rollback-aifeeds-performance-log.sh
)
for payload in "${payloads[@]}"; do
    case "$payload" in
        *.service|*.timer) source_path="/workspace/deploy/systemd/$payload" ;;
        *) source_path="/workspace/deploy/nginx/$payload" ;;
    esac
    install -o root -g root -m 0600 "$source_path" "$staging/$payload"
done
case "$scenario" in
    exceptional-*)
        printf '\n# fixture legacy helper variant\n' >> "$staging/rollback-aifeeds-performance-log.sh"
        export GL_A_TEST_INITIALIZED_CANDIDATE_RECOVERY_FAIL=1
        ;;
esac
(
    cd "$staging"
    sha256sum "${payloads[@]}" > SHA256SUMS
)
chmod 0600 "$staging/SHA256SUMS"
staged_rollback_helper_sha=$(sha256sum "$staging/rollback-aifeeds-performance-log.sh" \
    | awk '{print $1}')
case "$scenario" in
    exceptional-*)
        test "$staged_rollback_helper_sha" != "$rollback_helper_sha" \
            || fail staged-legacy-helper-sha-not-distinct
        ;;
    *)
        test "$staged_rollback_helper_sha" = "$rollback_helper_sha" \
            || fail staged-rollback-helper-sha
        ;;
esac
artifacts_sha256_json=$(jq -nc \
    --arg format "$(sha256sum "$staging/aifeeds-performance-log.conf" | awk '{print $1}')" \
    --arg rotate "$(sha256sum "$staging/aifeeds-performance.logrotate" | awk '{print $1}')" \
    --arg checker "$(sha256sum "$staging/check-nginx-request-id.py" | awk '{print $1}')" \
    --arg diff_checker "$(sha256sum "$staging/verify-nginx-request-id-diff.py" | awk '{print $1}')" \
    --arg inserter "$(sha256sum "$staging/insert-nginx-request-id.py" | awk '{print $1}')" \
    --arg service "$(sha256sum "$staging/aifeeds-performance-logrotate.service" | awk '{print $1}')" \
    --arg timer "$(sha256sum "$staging/aifeeds-performance-logrotate.timer" | awk '{print $1}')" \
    '{format:$format,rotate:$rotate,checker:$checker,diff_checker:$diff_checker,
      inserter:$inserter,service:$service,timer:$timer}')
template_artifacts_sha256_json=$artifacts_sha256_json
readonly template_artifacts_sha256_json
artifact_candidates_json=$(jq -nc \
    --arg checker "/usr/local/sbin/aifeeds-check-nginx-request-id.candidate-gl-a-${operation_id}" \
    --arg diff_checker "/usr/local/sbin/aifeeds-verify-nginx-request-id-diff.candidate-gl-a-${operation_id}" \
    --arg format "/etc/nginx/conf.d/aifeeds-performance-log.conf.candidate-gl-a-${operation_id}" \
    --arg inserter "/usr/local/sbin/aifeeds-insert-nginx-request-id.candidate-gl-a-${operation_id}" \
    --arg log "/var/log/nginx/.aifeeds-performance.jsonl.candidate-gl-a-${operation_id}" \
    --arg rotate "/etc/aifeeds-performance-logrotate.conf.candidate-gl-a-${operation_id}" \
    --arg service "/etc/systemd/system/aifeeds-performance-logrotate.service.candidate-gl-a-${operation_id}" \
    --arg timer "/etc/systemd/system/aifeeds-performance-logrotate.timer.candidate-gl-a-${operation_id}" \
    '{checker:$checker,diff_checker:$diff_checker,format:$format,inserter:$inserter,
      log:$log,rotate:$rotate,service:$service,timer:$timer}')
readonly artifact_candidates_json

run_installer() {
    local destination=$1
    set +e
    /bin/bash "$installer" "$staging" "$operation_id" "$g0_commit" > "$destination" 2>&1
    local result=$?
    set -e
    printf '%s' "$result"
}

run_installer_for_operation() {
    local destination=$1 requested_operation_id=$2
    set +e
    /bin/bash "$installer" "$staging" "$requested_operation_id" "$g0_commit" \
        > "$destination" 2>&1
    local result=$?
    set -e
    printf '%s' "$result"
}

refresh_expected_artifacts_from_journal() {
    local journal_path=$1
    artifacts_sha256_json="$(python3 - "$journal_path" \
        "$staging/aifeeds-performance-logrotate.service" \
        "$template_artifacts_sha256_json" <<'PY'
import hashlib
import json
import os
import stat
import sys

journal_path, template_path, template_json = sys.argv[1:]
with open(journal_path, encoding="utf-8") as source:
    journal = json.load(source)
template = json.loads(template_json)
observed = journal["artifacts_sha256"]
if set(observed) != set(template):
    raise SystemExit("artifact hash key drift")
for key in set(template) - {"service"}:
    if observed[key] != template[key]:
        raise SystemExit(f"static artifact hash drift: {key}")

# A terminal rollback deliberately removes the sealed runtime authority.  Its
# exact service hash is already bound by the terminal source/rollback journals;
# only live installation phases may dereference and re-prove the anchor file.
if journal.get("phase") == "rolled_back":
    print(json.dumps(observed, separators=(",", ":"), sort_keys=True))
    raise SystemExit(0)

# A crash after the immutable runtime cleanup plan completed legitimately
# removes the rendered service authority before the source journal becomes
# terminal.  In that window the exact rollback journal and completed 14-slot
# plan are the durable authority; do not dereference the deleted anchor.
anchor = journal["rotation_anchor_identity"]
if anchor is not None and not os.path.lexists(anchor["path"]):
    rollback_path = (
        "/var/backups/aifeeds-performance-log/rollback-transaction-"
        + journal["operation_id"] + ".json"
    )
    with open(rollback_path, encoding="utf-8") as source:
        rollback = json.load(source)
    cleanup = rollback.get("runtime_cleanup")
    if rollback.get("source_journal") != journal_path \
            or rollback.get("runtime_artifacts") != journal.get("runtime_artifacts") \
            or rollback.get("artifacts_sha256") != observed \
            or rollback.get("phase") not in {
                "runtime_removed", "nginx_reloaded", "logs_archived", "rollback_failed", "rolled_back",
            } or not isinstance(cleanup, dict) \
            or cleanup.get("cursor") != len(cleanup.get("items", [])) \
            or cleanup.get("cursor_state") != "complete":
        raise SystemExit("deleted runtime authority lacks completed rollback plan")
    print(json.dumps(observed, separators=(",", ":"), sort_keys=True))
    raise SystemExit(0)

services = [entry for entry in journal.get("runtime_artifacts", []) if entry.get("name") == "service"]
if not services:
    if observed["service"] != template["service"]:
        raise SystemExit("unrendered service hash drift")
else:
    if len(services) != 1:
        raise SystemExit("service runtime identity count drift")
    service = services[0]
    anchor = journal["rotation_anchor_identity"]
    runtime = journal["runtime_artifacts"]
    checker = next(entry for entry in runtime
                   if entry.get("final") == "/usr/local/sbin/aifeeds-check-nginx-request-id")
    config = next(entry for entry in runtime
                  if entry.get("final") == "/etc/aifeeds-performance-logrotate.conf")
    if anchor.get("state") != "sealed":
        raise SystemExit("rendered service lacks sealed anchor")
    with open(anchor["path"], encoding="utf-8") as source:
        authority = json.load(source)
    if authority.get("schema") != 2 or authority.get("operation_id") != journal["operation_id"]:
        raise SystemExit("rendered service authority schema drift")
    logrotate = authority.get("logrotate")
    if not isinstance(logrotate, dict) or logrotate.get("path") != "/usr/sbin/logrotate":
        raise SystemExit("rendered service logrotate authority drift")
    with open(template_path, encoding="utf-8") as source:
        rendered = source.read()
    replacements = {
        "@OPERATION_ID@": journal["operation_id"],
        "@ROTATION_ANCHOR_PATH@": anchor["path"],
        "@ROTATION_ANCHOR_DEV@": str(anchor["dev"]),
        "@ROTATION_ANCHOR_INO@": str(anchor["ino"]),
        "@ROTATION_ANCHOR_SHA256@": anchor["sha256"],
        "@CHECKER_DEV@": str(checker["dev"]),
        "@CHECKER_INO@": str(checker["ino"]),
        "@CHECKER_SHA256@": checker["sha256"],
        "@ROTATE_CONFIG_DEV@": str(config["dev"]),
        "@ROTATE_CONFIG_INO@": str(config["ino"]),
        "@ROTATE_CONFIG_SHA256@": config["sha256"],
        "@LOGROTATE_DEV@": str(logrotate["dev"]),
        "@LOGROTATE_INO@": str(logrotate["ino"]),
        "@LOGROTATE_SHA256@": logrotate["sha256"],
    }
    for token, value in replacements.items():
        expected_count = 2 if token == "@ROTATION_ANCHOR_PATH@" else 1
        if rendered.count(token) != expected_count:
            raise SystemExit(f"service placeholder count drift: {token}")
        rendered = rendered.replace(token, value)
    if "@" in rendered:
        raise SystemExit("unresolved rendered service placeholder")
    expected_service_sha = hashlib.sha256(rendered.encode()).hexdigest()
    if observed["service"] != expected_service_sha or service.get("sha256") != expected_service_sha:
        raise SystemExit("rendered service hash drift")
    for candidate in (service.get("final"), service.get("candidate")):
        if not candidate or not os.path.lexists(candidate):
            continue
        value = os.lstat(candidate)
        if not stat.S_ISREG(value.st_mode) or stat.S_ISLNK(value.st_mode):
            raise SystemExit("rendered service path is not regular")
        if (value.st_dev, value.st_ino, value.st_uid, value.st_gid,
                stat.S_IMODE(value.st_mode)) != (
                service["dev"], service["ino"], service["uid"], service["gid"],
                int(service["mode"], 8)):
            raise SystemExit("rendered service physical identity drift")
        with open(candidate, "rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != expected_service_sha:
                raise SystemExit("rendered service physical hash drift")
print(json.dumps(observed, separators=(",", ":"), sort_keys=True))
PY
)" || fail artifacts-contract
}

assert_gl_a_journal_identity() {
    local journal_path=$1
    local expected_phase=$2
    local expected_journal="/var/backups/aifeeds-performance-log/transaction-${operation_id}.json"
    local expected_backup="/var/backups/aifeeds-performance-log/aifeeds.conf.bak-perf-${operation_id}"
    local expected_audit="/var/backups/aifeeds-performance-log/audit-${operation_id}"
    local expected_candidate="/etc/nginx/sites-available/aifeeds.conf.candidate-gl-a-${operation_id}"
    local expected_rollback_candidate="/etc/nginx/sites-available/aifeeds.conf.rollback-gl-a-${operation_id}"
    test "$journal_path" = "$expected_journal" || fail gl-a-journal-path
    refresh_expected_artifacts_from_journal "$journal_path"
    jq -e \
        --arg phase "$expected_phase" \
        --arg operation_id "$operation_id" \
        --arg g0_commit "$g0_commit" \
        --arg helper_sha "$rollback_helper_sha" \
        --arg journal "$expected_journal" \
        --arg backup "$expected_backup" \
        --arg audit "$expected_audit" \
        --arg candidate "$expected_candidate" \
        --arg rollback_candidate "$expected_rollback_candidate" \
        --argjson artifacts "$artifacts_sha256_json" \
        --argjson candidates "$artifact_candidates_json" '
        .schema == 1 and .gate == "GL-a" and .phase == $phase
        and .operation_id == $operation_id and .g0_commit == $g0_commit
        and .rollback_helper_sha256 == $helper_sha
        and .transaction_journal == $journal and .site_backup == $backup
        and .audit_dir == $audit and .installer_candidate == $candidate
        and .rollback_candidate == $rollback_candidate
        and .artifacts_sha256 == $artifacts and .artifact_candidates == $candidates
    ' "$journal_path" >/dev/null || fail "gl-a-journal-identity:$expected_phase"
    test "$(stat -c '%d' "${expected_candidate%/*}")" = \
        "$(stat -c '%d' /etc/nginx/sites-available)" || fail gl-a-site-candidate-device
    if [ -e "$expected_candidate" ] || [ -L "$expected_candidate" ]; then
        test -f "$expected_candidate" || fail gl-a-site-candidate-not-regular
        test ! -L "$expected_candidate" || fail gl-a-site-candidate-symlink
        test "$(stat -c '%d' "$expected_candidate")" = \
            "$(stat -c '%d' /etc/nginx/sites-available)" \
            || fail gl-a-site-candidate-cross-device
    fi
}

assert_gl_a_summary_identity() {
    local summary_path=$1
    local journal_path="/var/backups/aifeeds-performance-log/transaction-${operation_id}.json"
    local backup_path="/var/backups/aifeeds-performance-log/aifeeds.conf.bak-perf-${operation_id}"
    local rollback_candidate="/etc/nginx/sites-available/aifeeds.conf.rollback-gl-a-${operation_id}"
    test -f "$journal_path" || fail gl-a-summary-journal-missing
    refresh_expected_artifacts_from_journal "$journal_path"
    jq -e \
        --arg operation_id "$operation_id" \
        --arg g0_commit "$g0_commit" \
        --arg helper_sha "$rollback_helper_sha" \
        --arg journal "$journal_path" \
        --arg journal_sha "$(sha256sum "$journal_path" | awk '{print $1}')" \
        --arg backup "$backup_path" \
        --arg rollback_candidate "$rollback_candidate" \
        --argjson artifacts "$artifacts_sha256_json" \
        --argjson candidates "$artifact_candidates_json" '
        .schema == 1 and .gate == "GL-a"
        and .operation_id == $operation_id and .g0_commit == $g0_commit
        and .rollback_helper_sha256 == $helper_sha
        and .transaction_journal == $journal and .transaction_journal_sha256 == $journal_sha
        and .site_backup == $backup and .rollback_candidate == $rollback_candidate
        and .artifacts_sha256 == $artifacts
        and .artifact_candidates == $candidates
    ' "$summary_path" >/dev/null || fail gl-a-summary-identity
}

load_manual_recovery_contract() {
    if [ -s "$staging/gl-a-summary.json" ]; then
        recovery_backup=$(jq -er '.site_backup' "$staging/gl-a-summary.json")
        recovery_backup_sha=$(jq -er '.site_backup_sha256' "$staging/gl-a-summary.json")
        recovery_installed_sha=$(jq -er '.installed_site_sha256' "$staging/gl-a-summary.json")
        recovery_site_uid=$(jq -er '.original_site_uid' "$staging/gl-a-summary.json")
        recovery_site_gid=$(jq -er '.original_site_gid' "$staging/gl-a-summary.json")
        recovery_site_mode=$(jq -er '.original_site_mode' "$staging/gl-a-summary.json")
        recovery_source_journal=$(jq -er '.transaction_journal' "$staging/gl-a-summary.json")
        recovery_source_sha=$(jq -er '.transaction_journal_sha256' "$staging/gl-a-summary.json")
    else
        recovery_source_journal=$(find /var/backups/aifeeds-performance-log -maxdepth 1 \
            -type f -name 'transaction-*.json' -print)
        test "$(printf '%s\n' "$recovery_source_journal" | grep -c .)" -eq 1 \
            || fail recovery-source-journal-count
        recovery_backup=$(jq -er '.site_backup' "$recovery_source_journal")
        recovery_backup_sha=$(jq -er '.site_backup_sha256' "$recovery_source_journal")
        recovery_installed_sha=$(jq -er '.installed_site_sha256' "$recovery_source_journal")
        recovery_site_uid=$(jq -er '.original_site_uid' "$recovery_source_journal")
        recovery_site_gid=$(jq -er '.original_site_gid' "$recovery_source_journal")
        recovery_site_mode=$(jq -er '.original_site_mode' "$recovery_source_journal")
        recovery_source_sha=$(sha256sum "$recovery_source_journal" | awk '{print $1}')
    fi
    test "$(sha256sum "$recovery_source_journal" | awk '{print $1}')" = "$recovery_source_sha" \
        || fail recovery-source-journal-hash
    recovery_expected_settled_sha=$recovery_source_sha
    recovery_initial_phase=$(jq -er '.phase' "$recovery_source_journal")
    test "$(jq -er '.operation_id' "$recovery_source_journal")" = "$operation_id" \
        || fail recovery-operation-id
    test "$(jq -er '.g0_commit' "$recovery_source_journal")" = "$g0_commit" \
        || fail recovery-g0-commit
    test "$(jq -er '.rollback_helper_sha256' "$recovery_source_journal")" = \
        "$rollback_helper_sha" || fail recovery-helper-sha
    refresh_expected_artifacts_from_journal "$recovery_source_journal"
    test "$(jq -cS '.artifacts_sha256' "$recovery_source_journal")" = \
        "$(jq -cS . <<< "$artifacts_sha256_json")" || fail recovery-artifacts-sha
    test "$(jq -cS '.artifact_candidates' "$recovery_source_journal")" = \
        "$(jq -cS . <<< "$artifact_candidates_json")" || fail recovery-artifact-candidates
    recovery_transaction_id=${recovery_source_journal##*/transaction-}
    recovery_transaction_id=${recovery_transaction_id%.json}
    test "$recovery_transaction_id" = "$operation_id" || fail recovery-transaction-operation-id
    recovery_rollback_journal="/var/backups/aifeeds-performance-log/rollback-transaction-${recovery_transaction_id}.json"
    recovery_manual_summary="$staging/gl-a-manual-rollback-summary.json"
    recovery_installer_candidate=$(jq -er '.installer_candidate' "$recovery_source_journal")
    test "$recovery_installer_candidate" = \
        "/etc/nginx/sites-available/aifeeds.conf.candidate-gl-a-${recovery_transaction_id}" \
        || fail recovery-installer-candidate-path
    recovery_rollback_candidate=$(jq -er '.rollback_candidate' "$recovery_source_journal")
    test "$recovery_rollback_candidate" = \
        "/etc/nginx/sites-available/aifeeds.conf.rollback-gl-a-${recovery_transaction_id}" \
        || fail recovery-rollback-candidate-path
}

run_manual_rollback() {
    local destination=$1
    set +e
    /bin/bash "$rollback_helper" \
        "$staging" \
        "$recovery_backup" \
        "$recovery_backup_sha" \
        "$recovery_installed_sha" \
        "$recovery_site_uid" \
        "$recovery_site_gid" \
        "$recovery_site_mode" \
        "$recovery_source_journal" \
        "$recovery_source_sha" > "$destination" 2>&1
    manual_rc=$?
    set -e
}

start_manual_rollback() {
    local destination=$1
    setsid /bin/bash "$rollback_helper" \
        "$staging" \
        "$recovery_backup" \
        "$recovery_backup_sha" \
        "$recovery_installed_sha" \
        "$recovery_site_uid" \
        "$recovery_site_gid" \
        "$recovery_site_mode" \
        "$recovery_source_journal" \
        "$recovery_source_sha" > "$destination" 2>&1 &
    manual_pid=$!
    assert_isolated_process_group "$manual_pid" manual-rollback
}

assert_isolated_process_group() {
    local pid=$1 label=$2 child_pgid harness_pgid
    child_pgid=$(ps -o pgid= -p "$pid" | tr -d ' ')
    harness_pgid=$(ps -o pgid= -p "$$" | tr -d ' ')
    test -n "$child_pgid" || fail "$label-process-group-missing"
    test "$child_pgid" = "$pid" || fail "$label-process-group-not-isolated"
    test "$child_pgid" != "$harness_pgid" || fail "$label-process-group-shared"
}

load_recovery_contract_from_record() {
    local record=$1 trusted_sha=$2 expected_settled_sha=${3:-$2}
    recovery_source_journal=$(jq -er '.transaction_journal' "$record")
    recovery_backup=$(jq -er '.site_backup' "$record")
    recovery_backup_sha=$(jq -er '.site_backup_sha256' "$record")
    recovery_installed_sha=$(jq -er '.installed_site_sha256' "$record")
    recovery_site_uid=$(jq -er '.original_site_uid' "$record")
    recovery_site_gid=$(jq -er '.original_site_gid' "$record")
    recovery_site_mode=$(jq -er '.original_site_mode' "$record")
    recovery_source_sha=$trusted_sha
    recovery_expected_settled_sha=$expected_settled_sha
    recovery_initial_phase=$(jq -er '
        if .phase == "rollback_failed" then .failed_from
        elif .phase == "rolled_back" then .rollback_origin_phase
        else .phase end
    ' "$record")
    recovery_transaction_id=${recovery_source_journal##*/transaction-}
    recovery_transaction_id=${recovery_transaction_id%.json}
    test "$recovery_transaction_id" = "$operation_id" || fail c-recovery-operation-id
    recovery_rollback_journal="/var/backups/aifeeds-performance-log/rollback-transaction-${recovery_transaction_id}.json"
    recovery_manual_summary="$staging/gl-a-manual-rollback-summary.json"
    recovery_installer_candidate=$(jq -er '.installer_candidate' "$record")
    recovery_rollback_candidate=$(jq -er '.rollback_candidate' "$record")
    refresh_expected_artifacts_from_journal "$record"
    if [ "$recovery_initial_phase" = committed ] && [ -s "$staging/gl-a-summary.json" ]; then
        install_summary_sha_before_rollback=$(sha256sum "$staging/gl-a-summary.json" | awk '{print $1}')
    fi
}

wait_for_c_crash() {
    local pid=$1 label=$2 wait_limit=${3:-600} result
    wait_for_file "$test_root/$label" "$wait_limit"
    set +e
    wait "$pid"
    result=$?
    set -e
    test "$result" -eq 137 || fail "$label-rc-$result"
}

complete_c_positive_reentry() {
    local expected_first_resumed=$1 source_fingerprint rollback_fingerprint marker_fingerprint
    local summary_fingerprint source_revision rollback_revision namespace_fingerprint marker
    local original_cli_source_sha
    test "$manual_rc" -eq 0 || fail "c-positive-first-rc-$manual_rc"
    c_expected_first_resumed=$expected_first_resumed
    grep -Fq "manual_rollback=pass resumed=${c_expected_first_resumed}" "$manual_output" \
        || fail c-positive-first-pass-marker
    marker="/var/backups/aifeeds-performance-log/rollback-commit-${operation_id}.json"
    jq -e --arg expected_settled_sha "$recovery_expected_settled_sha" '
        .source_before_sha256 == $expected_settled_sha
    ' "$marker" >/dev/null || fail c-positive-source-before-not-settled
    jq -e --arg expected_settled_sha "$recovery_expected_settled_sha" '
        .source_journal_sha256 == $expected_settled_sha
    ' "$recovery_rollback_journal" >/dev/null || fail c-positive-rollback-source-not-settled
    assert_cas_namespace "$recovery_source_journal" F
    assert_cas_namespace "$recovery_rollback_journal" F
    source_fingerprint=$(file_identity_fingerprint "$recovery_source_journal")
    rollback_fingerprint=$(file_identity_fingerprint "$recovery_rollback_journal")
    marker_fingerprint=$(file_identity_fingerprint "$marker")
    summary_fingerprint=$(sha256sum "$recovery_manual_summary" | awk '{print $1}')
    source_revision=$(jq -er '.journal_update.revision' "$recovery_source_journal")
    rollback_revision=$(jq -er '.journal_update.revision' "$recovery_rollback_journal")
    namespace_fingerprint=$(c_namespace_fingerprint)
    original_cli_source_sha=$recovery_source_sha
    manual_reentry_output="$test_root/c-positive-manual-reentry.out"
    run_manual_rollback "$manual_reentry_output"
    test "$recovery_source_sha" = "$original_cli_source_sha" \
        || fail c-positive-cli-source-authority-changed
    test "$manual_rc" -eq 0 || fail "c-positive-reentry-rc-$manual_rc"
    assert_cas_namespace "$recovery_source_journal" F
    assert_cas_namespace "$recovery_rollback_journal" F
    test "$(file_identity_fingerprint "$recovery_source_journal")" = "$source_fingerprint" \
        || fail c-positive-source-changed-on-reentry
    test "$(file_identity_fingerprint "$recovery_rollback_journal")" = "$rollback_fingerprint" \
        || fail c-positive-rollback-changed-on-reentry
    test "$(file_identity_fingerprint "$marker")" = "$marker_fingerprint" \
        || fail c-positive-marker-changed-on-reentry
    test "$(sha256sum "$recovery_manual_summary" | awk '{print $1}')" = "$summary_fingerprint" \
        || fail c-positive-summary-changed-on-reentry
    test "$(jq -er '.journal_update.revision' "$recovery_source_journal")" = "$source_revision" \
        || fail c-positive-source-revision-changed
    test "$(jq -er '.journal_update.revision' "$recovery_rollback_journal")" = "$rollback_revision" \
        || fail c-positive-rollback-revision-changed
    test "$(c_namespace_fingerprint)" = "$namespace_fingerprint" \
        || fail c-positive-namespace-changed-on-reentry
    c_case_terminal=1
}

c_namespace_fingerprint() {
    python3 - "$operation_id" <<'PY'
import hashlib
import json
import os
import stat
import sys

operation_id = sys.argv[1]
backup = "/var/backups/aifeeds-performance-log"
audit = f"{backup}/audit-{operation_id}"
source = f"{backup}/transaction-{operation_id}.json"
rollback = f"{backup}/rollback-transaction-{operation_id}.json"
marker = f"{backup}/rollback-commit-{operation_id}.json"
paths = set()
for final in (source, rollback):
    paths.update((
        final,
        final + ".tmp",
        final + f".previous-update-gl-a-{operation_id}",
        final + f".previous-update-gl-a-{operation_id}.cleanup",
    ))
paths.update((
    marker,
    marker + ".tmp",
    marker + f".previous-terminal-gl-a-{operation_id}",
    f"{backup}/exceptional-recovery-authority-{operation_id}.json",
    f"{backup}/exceptional-recovery-authority-{operation_id}.json.candidate-gl-a-{operation_id}",
    f"{backup}/exceptional-recovery-receipt-{operation_id}.json",
    f"{backup}/exceptional-recovery-receipt-{operation_id}.json.candidate-gl-a-{operation_id}",
))
paths.update((
    "/root/gl-a-secret-canary",
    "/etc/nginx/sites-available/aifeeds.conf",
    "/etc/nginx/sites-enabled/aifeeds.conf",
    f"/etc/nginx/sites-available/aifeeds.conf.candidate-gl-a-{operation_id}",
    f"/etc/nginx/sites-available/aifeeds.conf.rollback-gl-a-{operation_id}",
    "/etc/nginx/conf.d/aifeeds-performance-log.conf",
    f"/etc/nginx/conf.d/aifeeds-performance-log.conf.candidate-gl-a-{operation_id}",
    "/etc/aifeeds-performance-logrotate.conf",
    f"/etc/aifeeds-performance-logrotate.conf.candidate-gl-a-{operation_id}",
    "/usr/local/sbin/aifeeds-check-nginx-request-id",
    f"/usr/local/sbin/aifeeds-check-nginx-request-id.candidate-gl-a-{operation_id}",
    "/usr/local/sbin/aifeeds-verify-nginx-request-id-diff",
    f"/usr/local/sbin/aifeeds-verify-nginx-request-id-diff.candidate-gl-a-{operation_id}",
    "/usr/local/sbin/aifeeds-insert-nginx-request-id",
    f"/usr/local/sbin/aifeeds-insert-nginx-request-id.candidate-gl-a-{operation_id}",
    "/etc/systemd/system/aifeeds-performance-logrotate.service",
    f"/etc/systemd/system/aifeeds-performance-logrotate.service.candidate-gl-a-{operation_id}",
    "/etc/systemd/system/aifeeds-performance-logrotate.timer",
    f"/etc/systemd/system/aifeeds-performance-logrotate.timer.candidate-gl-a-{operation_id}",
    "/var/log/nginx/aifeeds-performance.jsonl",
    f"/var/log/nginx/.aifeeds-performance.jsonl.candidate-gl-a-{operation_id}",
    "/var/lib/aifeeds-performance-logrotate",
    f"/var/lib/aifeeds-performance-logrotate.candidate-gl-a-{operation_id}",
    "/var/lib/aifeeds-performance-logrotate/status",
    "/var/lib/aifeeds-performance-logrotate/rotation-provenance.jsonl",
    f"{backup}/rotation-anchor-{operation_id}.json",
))
archive_manifest = f"{audit}/archive-manifest.json"
paths.update((
    archive_manifest,
    archive_manifest + ".tmp",
    archive_manifest + f".previous-gl-a-{operation_id}",
    archive_manifest + f".tmp.hardlink-gl-a-{operation_id}",
))
try:
    for directory, names, files in os.walk(audit):
        paths.add(directory)
        for name in names + files:
            paths.add(os.path.join(directory, name))
except FileNotFoundError:
    pass
for root in (
    backup, "/var/log/nginx", "/etc/nginx/sites-available", "/etc/nginx/conf.d",
    "/etc/systemd/system", "/usr/local/sbin", "/var/lib",
):
    try:
        for directory, names, files in os.walk(root):
            for name in names + files:
                if f"runtime-cleanup-gl-a-{operation_id}" in name:
                    paths.add(os.path.join(directory, name))
    except FileNotFoundError:
        pass
for candidate in tuple(paths):
    try:
        candidate_stat = os.lstat(candidate)
        if not stat.S_ISREG(candidate_stat.st_mode):
            continue
        with open(candidate, encoding="utf-8") as source_file:
            document = json.load(source_file)
    except (FileNotFoundError, OSError, UnicodeDecodeError, json.JSONDecodeError):
        continue
    if not isinstance(document, dict) or not isinstance(document.get("entries"), list):
        continue
    for entry in document["entries"]:
        if not isinstance(entry, dict):
            continue
        for key in ("source", "quarantine", "destination", "candidate"):
            path = entry.get(key)
            if isinstance(path, str) and path.startswith("/"):
                paths.add(path)
result = []
for path in sorted(paths):
    try:
        value = os.lstat(path)
    except FileNotFoundError:
        result.append({"path": path, "state": "absent"})
        continue
    item = {
        "path": path, "state": "present", "dev": value.st_dev, "ino": value.st_ino,
        "uid": value.st_uid, "gid": value.st_gid,
        "mode": format(stat.S_IMODE(value.st_mode), "o"), "nlink": value.st_nlink,
        "size": value.st_size, "mtime_ns": value.st_mtime_ns,
    }
    if stat.S_ISLNK(value.st_mode):
        item["target"] = os.readlink(path)
    if stat.S_ISREG(value.st_mode):
        with open(path, "rb", buffering=0) as source_file:
            item["sha256"] = hashlib.file_digest(source_file, "sha256").hexdigest()
    elif stat.S_ISDIR(value.st_mode):
        children = []
        with os.scandir(path) as entries:
            for entry in sorted(entries, key=lambda candidate: candidate.name):
                child = entry.stat(follow_symlinks=False)
                children.append({
                    "name": entry.name, "dev": child.st_dev, "ino": child.st_ino,
                    "uid": child.st_uid, "gid": child.st_gid,
                    "mode": format(stat.S_IMODE(child.st_mode), "o"),
                    "nlink": child.st_nlink, "size": child.st_size,
                    "mtime_ns": child.st_mtime_ns,
                })
        item["children"] = children
    result.append(item)
print(hashlib.sha256(json.dumps(result, sort_keys=True, separators=(",", ":")).encode()).hexdigest())
PY
}

run_c_negative_twice_stable() {
    local destination=$1 before after
    before=$(c_namespace_fingerprint)
    run_manual_rollback "$destination"
    test "$manual_rc" -ne 0 || fail c-negative-first-false-success
    ! grep -Fq 'manual_rollback=pass' "$destination" || fail c-negative-first-false-pass
    after=$(c_namespace_fingerprint)
    test "$after" = "$before" || fail c-negative-namespace-changed-on-first-failure
    manual_reentry_output="$test_root/c-negative-manual-reentry.out"
    run_manual_rollback "$manual_reentry_output"
    test "$manual_rc" -ne 0 || fail c-negative-reentry-false-success
    ! grep -Fq 'manual_rollback=pass' "$manual_reentry_output" || fail c-negative-reentry-false-pass
    after=$(c_namespace_fingerprint)
    test "$after" = "$before" || fail c-negative-namespace-changed-on-second-failure
}

run_exceptional_rollback() {
    local destination=$1 authority=${2:-}
    local -a arguments=(
        "$staging" "$recovery_backup" "$recovery_backup_sha"
        "$recovery_installed_sha" "$recovery_site_uid" "$recovery_site_gid"
        "$recovery_site_mode" "$recovery_source_journal" "$recovery_source_sha"
    )
    if [ -n "$authority" ]; then arguments+=("$authority"); fi
    set +e
    /bin/bash "$rollback_helper" "${arguments[@]}" > "$destination" 2>&1
    manual_rc=$?
    set -e
}

assert_exceptional_rejection_stable() {
    local label=$1 authority=${2:-} before after destination
    destination="$test_root/exceptional-reject-${label}.out"
    before=$(c_namespace_fingerprint)
    run_exceptional_rollback "$destination" "$authority"
    test "$manual_rc" -ne 0 || fail "exceptional-reject-${label}-false-success"
    ! grep -Fq 'manual_rollback=pass' "$destination" \
        || fail "exceptional-reject-${label}-false-pass"
    after=$(c_namespace_fingerprint)
    test "$after" = "$before" || fail "exceptional-reject-${label}-mutation"
}

rewrite_exceptional_authority() {
    local filter=$1 temporary="${exceptional_authority}.rewrite"
    jq -cS "$filter" "$exceptional_authority" > "$temporary"
    chmod 0600 "$temporary"
    mv "$temporary" "$exceptional_authority"
}

run_manual_failure_twice_stable() {
    local destination=$1 before after
    before=$(c_namespace_fingerprint)
    run_manual_rollback "$destination"
    test "$manual_rc" -ne 0 || fail manual-stable-first-false-success
    grep -Fq 'manual_rollback=failed' "$destination" || fail manual-stable-first-marker
    ! grep -Fq 'manual_rollback=pass' "$destination" || fail manual-stable-first-false-pass
    after=$(c_namespace_fingerprint)
    test "$after" = "$before" || fail manual-stable-first-namespace-changed
    manual_reentry_output="$test_root/manual-stable-reentry.out"
    run_manual_rollback "$manual_reentry_output"
    test "$manual_rc" -ne 0 || fail manual-stable-reentry-false-success
    grep -Fq 'manual_rollback=failed' "$manual_reentry_output" \
        || fail manual-stable-reentry-marker
    ! grep -Fq 'manual_rollback=pass' "$manual_reentry_output" \
        || fail manual-stable-reentry-false-pass
    after=$(c_namespace_fingerprint)
    test "$after" = "$before" || fail manual-stable-reentry-namespace-changed
}

run_installer_negative_twice_stable() {
    local destination=$1 before after result
    before=$(c_namespace_fingerprint)
    result=$(run_installer "$destination")
    test "$result" -ne 0 || fail installer-negative-first-false-success
    ! grep -Fq 'gl_a=pass' "$destination" || fail installer-negative-first-false-pass
    after=$(c_namespace_fingerprint)
    test "$after" = "$before" || fail installer-negative-namespace-changed-on-first-failure
    installer_reentry_output="$test_root/installer-negative-reentry.out"
    result=$(run_installer "$installer_reentry_output")
    test "$result" -ne 0 || fail installer-negative-reentry-false-success
    ! grep -Fq 'gl_a=pass' "$installer_reentry_output" \
        || fail installer-negative-reentry-false-pass
    after=$(c_namespace_fingerprint)
    test "$after" = "$before" || fail installer-negative-namespace-changed-on-second-failure
}

run_installer_recovery_required_twice_stable() {
    local destination=$1 before after result
    before=$(c_namespace_fingerprint)
    result=$(run_installer "$destination")
    test "$result" -eq 76 || fail "installer-recovery-first-rc-$result"
    grep -Fq 'ERROR recovery_required=1' "$destination" \
        || fail installer-recovery-first-marker
    ! grep -Fq 'gl_a=pass' "$destination" || fail installer-recovery-first-false-pass
    after=$(c_namespace_fingerprint)
    test "$after" = "$before" || fail installer-recovery-first-namespace-changed
    installer_reentry_output="$test_root/installer-recovery-reentry.out"
    result=$(run_installer "$installer_reentry_output")
    test "$result" -eq 76 || fail "installer-recovery-reentry-rc-$result"
    grep -Fq 'ERROR recovery_required=1' "$installer_reentry_output" \
        || fail installer-recovery-reentry-marker
    ! grep -Fq 'gl_a=pass' "$installer_reentry_output" \
        || fail installer-recovery-reentry-false-pass
    after=$(c_namespace_fingerprint)
    test "$after" = "$before" || fail installer-recovery-reentry-namespace-changed
}

rewrite_json_in_place() {
    local path=$1 mutation=$2
    python3 - "$path" "$mutation" <<'PY'
import hashlib
import json
import os
import stat
import sys

path, mutation = sys.argv[1:]
with open(path, encoding="utf-8") as source:
    value = json.load(source)
if mutation == "semantic":
    value["g0_commit"] = "b" * 40
elif mutation == "rollback-terminal-jump":
    with open(value["source_journal"], "rb") as source:
        source_sha256 = hashlib.file_digest(source, "sha256").hexdigest()
    value["phase"] = "rolled_back"
    value["source_journal_terminal_sha256"] = source_sha256
    value.pop("failed_from", None)
elif mutation == "plan":
    item = value["runtime_cleanup"]["items"][0]
    descriptor = os.open("/root/gl-a-secret-canary", os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        digest = hashlib.file_digest(
            os.fdopen(os.dup(descriptor), "rb", buffering=0), "sha256"
        ).hexdigest()
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
        after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns
    ) or not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        raise SystemExit("canary identity changed")
    item["paths"] = ["/root/gl-a-secret-canary"]
    item["selected_path"] = "/root/gl-a-secret-canary"
    item["tombstone"] = (
        f"/root/gl-a-secret-canary.runtime-cleanup-gl-a-{value['operation_id']}-00"
    )
    item["identity"] = {
        "sha256": digest, "uid": before.st_uid, "gid": before.st_gid,
        "mode": format(stat.S_IMODE(before.st_mode), "o"),
        "dev": before.st_dev, "ino": before.st_ino,
    }
    encoded_items = (json.dumps(
        value["runtime_cleanup"]["items"], sort_keys=True, separators=(",", ":")
    ) + "\n").encode()
    value["runtime_cleanup"]["plan_sha256"] = hashlib.sha256(encoded_items).hexdigest()
elif mutation == "failed-from":
    value["failed_from"] = "prepared"
elif mutation == "legacy-source":
    value.pop("journal_update", None)
elif mutation == "legacy-cleanup":
    value["phase"] = "runtime_removed"
    value.pop("runtime_cleanup", None)
    value.pop("failed_from", None)
elif mutation == "terminal-marker-prepared-hash":
    value["prepared_marker_sha256"] = "c" * 64
elif mutation == "terminal-source-target":
    value["rollback_origin_phase"] = (
        "timer_enabled" if value["rollback_origin_phase"] != "timer_enabled" else "committed"
    )
else:
    raise SystemExit("unknown JSON mutation")
encoded = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
descriptor = os.open(path, os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW)
try:
    view = memoryview(encoded)
    while view:
        view = view[os.write(descriptor, view):]
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

replace_same_bytes_inode() {
    local path=$1 label=$2 preserved
    preserved="${path}.preserved-${label}"
    test ! -e "$preserved" && test ! -L "$preserved"
    mv "$path" "$preserved"
    cp "$preserved" "$path"
    chown root:root "$path"
    chmod 0600 "$path"
    test "$(sha256sum "$path" | awk '{print $1}')" = \
        "$(sha256sum "$preserved" | awk '{print $1}')"
    test "$(stat -c '%d %i' "$path")" != "$(stat -c '%d %i' "$preserved")"
}

replace_unknown_inode() {
    local path=$1 label=$2 preserved
    preserved="${path}.preserved-${label}"
    test ! -e "$preserved" && test ! -L "$preserved"
    mv "$path" "$preserved"
    printf '{"unknown":"takeover"}\n' > "$path"
    chown root:root "$path"
    chmod 0600 "$path"
}

restore_preserved_inode() {
    local path=$1 label=$2 preserved
    preserved="${path}.preserved-${label}"
    test -f "$path" && test ! -L "$path" && test -f "$preserved" && test ! -L "$preserved" \
        || fail "restore-preserved-$label-topology"
    test "$(stat -c '%U %G %a %h' "$path")" = 'root root 600 1' \
        || fail "restore-preserved-$label-current-metadata"
    test "$(stat -c '%U %G %a %h' "$preserved")" = 'root root 600 1' \
        || fail "restore-preserved-$label-authority-metadata"
    test "$(sha256sum "$path" | awk '{print $1}')" = \
        "$(sha256sum "$preserved" | awk '{print $1}')" \
        || fail "restore-preserved-$label-hash"
    test "$(stat -c '%d %i' "$path")" != "$(stat -c '%d %i' "$preserved")" \
        || fail "restore-preserved-$label-inode"
    /usr/bin/rm -f "$path"
    /usr/bin/mv "$preserved" "$path"
    /usr/bin/sync -f "$path"
    /usr/bin/sync -f "${path%/*}"
}

assert_cas_namespace() {
    local final=$1 expected=$2 namespace_operation_id=${3:-$operation_id}
    local previous cleanup observed=''
    previous="${final}.previous-update-gl-a-${namespace_operation_id}"
    cleanup="${previous}.cleanup"
    for pair in "F:$final" "T:${final}.tmp" "P:$previous" "C:$cleanup"; do
        name=${pair%%:*}
        path=${pair#*:}
        if [ -e "$path" ] || [ -L "$path" ]; then observed="${observed}${name}"; fi
    done
    test "$observed" = "$expected" || fail "cas-namespace-$expected-$observed"
}

terminal_pair_namespace_fingerprint() {
    local namespace_operation_id=$1
    python3 - "$namespace_operation_id" <<'PY'
import hashlib
import json
import os
import stat
import sys

operation_id = sys.argv[1]
root = "/var/backups/aifeeds-performance-log"
bases = (
    f"transaction-{operation_id}.json",
    f"rollback-transaction-{operation_id}.json",
    f"rollback-commit-{operation_id}.json",
)
expected = {
    bases[0], bases[0] + ".tmp",
    bases[0] + f".previous-update-gl-a-{operation_id}",
    bases[0] + f".previous-update-gl-a-{operation_id}.cleanup",
    bases[1], bases[1] + ".tmp",
    bases[1] + f".previous-update-gl-a-{operation_id}",
    bases[1] + f".previous-update-gl-a-{operation_id}.cleanup",
    bases[2], bases[2] + ".tmp",
    bases[2] + f".previous-terminal-gl-a-{operation_id}",
}
with os.scandir(root) as entries:
    discovered = {entry.name for entry in entries if any(entry.name.startswith(base) for base in bases)}
records = []
for name in sorted(expected | discovered):
    path = os.path.join(root, name)
    try:
        value = os.lstat(path)
    except FileNotFoundError:
        records.append({"name": name, "state": "absent"})
        continue
    record = {
        "name": name, "state": "present", "dev": value.st_dev, "ino": value.st_ino,
        "uid": value.st_uid, "gid": value.st_gid,
        "mode": format(stat.S_IMODE(value.st_mode), "o"), "nlink": value.st_nlink,
        "size": value.st_size, "mtime_ns": value.st_mtime_ns,
    }
    if stat.S_ISREG(value.st_mode):
        with open(path, "rb", buffering=0) as stream:
            record["sha256"] = hashlib.file_digest(stream, "sha256").hexdigest()
    elif stat.S_ISLNK(value.st_mode):
        record["target"] = os.readlink(path)
    elif stat.S_ISDIR(value.st_mode):
        with os.scandir(path) as children:
            record["children"] = sorted(child.name for child in children)
    records.append(record)
payload = json.dumps(records, separators=(",", ":"), sort_keys=True).encode()
print(hashlib.sha256(payload).hexdigest())
PY
}

assert_exact_terminal_pair() {
    local pair_operation_id=$1
    local source="/var/backups/aifeeds-performance-log/transaction-${pair_operation_id}.json"
    local rollback="/var/backups/aifeeds-performance-log/rollback-transaction-${pair_operation_id}.json"
    local marker="/var/backups/aifeeds-performance-log/rollback-commit-${pair_operation_id}.json"
    local source_sha rollback_sha marker_namespace=''
    assert_cas_namespace "$source" F "$pair_operation_id"
    assert_cas_namespace "$rollback" F "$pair_operation_id"
    for pair in "F:$marker" "T:${marker}.tmp" \
        "P:${marker}.previous-terminal-gl-a-${pair_operation_id}"; do
        name=${pair%%:*}; path=${pair#*:}
        if [ -e "$path" ] || [ -L "$path" ]; then marker_namespace="${marker_namespace}${name}"; fi
    done
    test "$marker_namespace" = F || fail terminal-pair-marker-namespace
    for path in "$source" "$rollback" "$marker"; do
        test -f "$path" && test ! -L "$path" || fail terminal-pair-record-type
        test "$(stat -c '%u %g %a %h' "$path")" = '0 0 600 1' \
            || fail terminal-pair-record-metadata
    done
    source_sha=$(sha256sum "$source" | awk '{print $1}')
    rollback_sha=$(sha256sum "$rollback" | awk '{print $1}')
    jq -e --arg operation_id "$pair_operation_id" --arg rollback "$rollback" \
        --arg marker "$marker" '
        .schema == 1 and .gate == "GL-a" and .phase == "rolled_back" and
        .operation_id == $operation_id and .rollback_journal == $rollback and
        .rollback_commit_marker == $marker and
        (.rollback_origin_phase | IN("mutation_started","mutated","timer_enabled","committed"))
    ' "$source" >/dev/null || fail terminal-pair-source-shape
    jq -e --arg operation_id "$pair_operation_id" --arg source "$source" \
        --arg marker "$marker" --arg source_sha "$source_sha" '
        .schema == 1 and .gate == "GL-a-manual-rollback" and .phase == "rolled_back" and
        .operation_id == $operation_id and .source_journal == $source and
        .rollback_commit_marker == $marker and
        .source_journal_terminal_sha256 == $source_sha
    ' "$rollback" >/dev/null || fail terminal-pair-rollback-shape
    test "$(jq -er '.rollback_origin_phase' "$source")" = \
        "$(jq -er '.source_origin_phase' "$rollback")" || fail terminal-pair-origin-mirror
    test "$(jq -cS '[.log_archive_manifest_sha256,.log_archive_manifest_generation,.log_archive_manifest_entry_count]' "$source")" = \
        "$(jq -cS '[.log_archive_manifest_sha256,.log_archive_manifest_generation,.log_archive_manifest_entry_count]' "$rollback")" \
        || fail terminal-pair-archive-mirror
    jq -e --arg operation_id "$pair_operation_id" --arg source "$source" \
        --arg rollback "$rollback" --arg marker "$marker" \
        --arg source_sha "$source_sha" --arg rollback_sha "$rollback_sha" '
        .schema == 1 and .gate == "GL-a-terminal-pair" and .phase == "committed" and
        .operation_id == $operation_id and .source_journal == $source and
        .rollback_journal == $rollback and .rollback_commit_marker == $marker and
        .source_target_sha256 == $source_sha and
        .source_journal_terminal_sha256 == $source_sha and
        .rollback_target_sha256 == $rollback_sha and
        .rollback_journal_terminal_sha256 == $rollback_sha
    ' "$marker" >/dev/null || fail terminal-pair-marker-shape
    python3 - "$pair_operation_id" "$source" "$rollback" "$marker" <<'PY'
import base64
import hashlib
import json
import os
import sys

operation_id, source_path, rollback_path, marker_path = sys.argv[1:]

def reject_constant(value):
    raise ValueError(value)

def reject_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result

def canonical(value):
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode()

def read(path):
    with open(path, "rb", buffering=0) as stream:
        raw = stream.read()
    value = json.loads(raw, object_pairs_hook=reject_duplicates, parse_constant=reject_constant)
    if canonical(value) != raw.rstrip(b"\n"):
        raise RuntimeError("noncanonical terminal record")
    return raw, value

source_raw, source = read(source_path)
rollback_raw, rollback = read(rollback_path)
marker_raw, marker = read(marker_path)
expected_marker_keys = {
    "schema", "gate", "phase", "operation_id", "source_journal", "rollback_journal",
    "rollback_commit_marker", "source_before_authority", "rollback_before_authority",
    "source_before_sha256", "rollback_before_sha256", "source_target_sha256",
    "rollback_target_sha256", "prepared_marker_sha256", "source_journal_terminal_sha256",
    "rollback_journal_terminal_sha256",
}
if set(marker) != expected_marker_keys:
    raise RuntimeError("committed marker keys drift")
if marker["operation_id"] != operation_id:
    raise RuntimeError("marker operation drift")
before_values = {}
for kind in ("source", "rollback"):
    authority = marker[f"{kind}_before_authority"]
    if set(authority) != {"raw_base64", "sha256", "dev", "ino"}:
        raise RuntimeError("before authority keys drift")
    raw = base64.b64decode(authority["raw_base64"], validate=True)
    if base64.b64encode(raw).decode() != authority["raw_base64"]:
        raise RuntimeError("before authority base64 drift")
    if hashlib.sha256(raw).hexdigest() != authority["sha256"]:
        raise RuntimeError("before authority hash drift")
    if marker[f"{kind}_before_sha256"] != authority["sha256"]:
        raise RuntimeError("before authority marker drift")
    value = json.loads(raw, object_pairs_hook=reject_duplicates, parse_constant=reject_constant)
    if raw not in (canonical(value), canonical(value) + b"\n"):
        raise RuntimeError("before authority canonical drift")
    update = value.get("journal_update")
    if not isinstance(update, dict) or update.get("self_dev") != authority["dev"] \
            or update.get("self_ino") != authority["ino"]:
        raise RuntimeError("before authority inode drift")
    before_values[kind] = value
if rollback.get("source_journal_sha256") != marker["source_before_sha256"]:
    raise RuntimeError("rollback source-before authority drift")
for kind, target in (("source", source), ("rollback", rollback)):
    before = before_values[kind]["journal_update"]
    update = target.get("journal_update")
    expected_predecessor = {
        "revision": before["revision"], "sha256": marker[f"{kind}_before_sha256"],
        "dev": before["self_dev"], "ino": before["self_ino"],
    }
    if update.get("revision") != before["revision"] + 1 \
            or update.get("predecessor") != expected_predecessor:
        raise RuntimeError("terminal target predecessor drift")
prepared = dict(marker)
prepared["phase"] = "prepared"
for key in ("prepared_marker_sha256", "source_journal_terminal_sha256",
            "rollback_journal_terminal_sha256"):
    prepared.pop(key)
if hashlib.sha256(canonical(prepared) + b"\n").hexdigest() != marker["prepared_marker_sha256"]:
    raise RuntimeError("prepared marker predecessor drift")
if hashlib.sha256(source_raw).hexdigest() != marker["source_target_sha256"] \
        or hashlib.sha256(rollback_raw).hexdigest() != marker["rollback_target_sha256"]:
    raise RuntimeError("terminal target hash drift")
manifest_path = rollback["log_archive_manifest"]
with open(manifest_path, "rb", buffering=0) as stream:
    manifest_raw = stream.read()
manifest = json.loads(
    manifest_raw, object_pairs_hook=reject_duplicates, parse_constant=reject_constant,
)
manifest_evidence = (
    hashlib.sha256(manifest_raw).hexdigest(), manifest["generation"], len(manifest["entries"]),
)
if not manifest.get("inventory_complete") or any(
        entry.get("state") != "archived" for entry in manifest["entries"]):
    raise RuntimeError("terminal manifest state drift")
for value in (source, rollback):
    observed = (
        value["log_archive_manifest_sha256"], value["log_archive_manifest_generation"],
        value["log_archive_manifest_entry_count"],
    )
    if observed != manifest_evidence:
        raise RuntimeError("terminal manifest evidence drift")
PY
}

exercise_source_journal_cas() {
    local point phase expected positive=1 source contract_record previous
    local external_predecessor_record expected_settled_record
    local external_predecessor_sha expected_settled_sha
    source="/var/backups/aifeeds-performance-log/transaction-${operation_id}.json"
    case "$scenario" in
        journal-source-g-reentry) phase=initializing; point=t-durable; expected=T ;;
        journal-source-s1-reentry|journal-source-semantic-drift|journal-source-partial-tmp)
            phase=backup_created; point=t-durable; expected=FT ;;
        journal-source-s2-reentry|journal-source-samebytes-predecessor|journal-source-p-only|journal-source-all-three)
            phase=backup_created; point=f-to-p; expected=TP ;;
        journal-source-s3-reentry) phase=backup_created; point=t-to-f; expected=FP ;;
        journal-source-s4-reentry|journal-source-unknown-cleanup)
            phase=backup_created; point=p-to-c; expected=FC ;;
        *) fail source-cas-scenario ;;
    esac
    rm -f "$test_root/journal-cas-crash-hit"
    export GL_A_TEST_JOURNAL_CAS_CRASH="source:${phase}:${point}"
    setsid /bin/bash "$installer" "$staging" "$operation_id" "$g0_commit" \
        > "$output" 2>&1 &
    installer_pid=$!
    assert_isolated_process_group "$installer_pid" source-cas-installer
    wait_for_c_crash "$installer_pid" journal-cas-crash-hit
    unset GL_A_TEST_JOURNAL_CAS_CRASH
    assert_cas_namespace "$source" "$expected"
    previous="${source}.previous-update-gl-a-${operation_id}"
    case "$expected" in
        T) contract_record="${source}.tmp"; external_predecessor_record="${source}.tmp"; expected_settled_record="${source}.tmp" ;;
        FT) contract_record="${source}.tmp"; external_predecessor_record="$source"; expected_settled_record="${source}.tmp" ;;
        TP) contract_record="${source}.tmp"; external_predecessor_record="$previous"; expected_settled_record="${source}.tmp" ;;
        FP|FC) contract_record="$source"; external_predecessor_record="$source"; expected_settled_record="$source" ;;
        *) fail source-cas-authority-topology ;;
    esac
    external_predecessor_sha=$(sha256sum "$external_predecessor_record" | awk '{print $1}')
    expected_settled_sha=$(sha256sum "$expected_settled_record" | awk '{print $1}')
    load_recovery_contract_from_record "$contract_record" "$external_predecessor_sha" "$expected_settled_sha"
    case "$scenario" in
        journal-source-semantic-drift)
            rewrite_json_in_place "${source}.tmp" semantic; positive=0 ;;
        journal-source-samebytes-predecessor)
            replace_same_bytes_inode "${source}.previous-update-gl-a-${operation_id}" source-samebytes
            positive=0
            ;;
        journal-source-partial-tmp)
            truncate -s 37 "${source}.tmp"; positive=0 ;;
        journal-source-p-only)
            rm -f "${source}.tmp"; assert_cas_namespace "$source" P; positive=0 ;;
        journal-source-all-three)
            cp "${source}.previous-update-gl-a-${operation_id}" "$source"
            chown root:root "$source"; chmod 0600 "$source"
            assert_cas_namespace "$source" FTP
            positive=0
            ;;
        journal-source-unknown-cleanup)
            chmod 0640 "${source}.previous-update-gl-a-${operation_id}.cleanup"
            metadata_before=$(c_namespace_fingerprint)
            run_manual_rollback "$test_root/source-cleanup-metadata-drift.out"
            test "$manual_rc" -ne 0 || fail source-cleanup-metadata-false-success
            test "$(c_namespace_fingerprint)" = "$metadata_before" \
                || fail source-cleanup-metadata-namespace-changed
            run_manual_rollback "$test_root/source-cleanup-metadata-drift-reentry.out"
            test "$manual_rc" -ne 0 || fail source-cleanup-metadata-reentry-false-success
            test "$(c_namespace_fingerprint)" = "$metadata_before" \
                || fail source-cleanup-metadata-reentry-namespace-changed
            chmod 0600 "${source}.previous-update-gl-a-${operation_id}.cleanup"
            replace_unknown_inode "${source}.previous-update-gl-a-${operation_id}.cleanup" source-cleanup
            positive=0
            ;;
    esac
    manual_output="$test_root/source-cas-manual.out"
    if [ "$positive" -eq 1 ]; then
        run_manual_rollback "$manual_output"
        test "$manual_rc" -eq 0 || fail "source-cas-reentry-rc-$manual_rc"
        complete_c_positive_reentry 0
    else
        run_c_negative_twice_stable "$manual_output"
        c_case_terminal=0
    fi
    rc=0
}

exercise_rollback_journal_cas() {
    local point phase expected positive=1 rollback final_record
    rc=$(run_installer "$output")
    test "$rc" -eq 0 || fail "rollback-cas-install-rc-$rc"
    load_manual_recovery_contract
    install_summary_sha_before_rollback=$(sha256sum "$staging/gl-a-summary.json" | awk '{print $1}')
    rollback=$recovery_rollback_journal
    case "$scenario" in
        journal-rollback-g-reentry) phase=prepared; point=t-durable; expected=T ;;
        journal-rollback-s1-reentry|journal-rollback-semantic-drift|journal-rollback-partial-tmp)
            phase=site_restored; point=t-durable; expected=FT ;;
        journal-rollback-s2-reentry|journal-rollback-samebytes-predecessor|journal-rollback-p-only|journal-rollback-all-three)
            phase=site_restored; point=f-to-p; expected=TP ;;
        journal-rollback-s3-reentry) phase=site_restored; point=t-to-f; expected=FP ;;
        journal-rollback-s4-reentry|journal-rollback-unknown-cleanup)
            phase=site_restored; point=p-to-c; expected=FC ;;
        *) fail rollback-cas-scenario ;;
    esac
    rm -f "$test_root/journal-cas-crash-hit"
    export GL_A_TEST_JOURNAL_CAS_CRASH="rollback:${phase}:${point}"
    start_manual_rollback "$test_root/rollback-cas-crash.out"
    wait_for_c_crash "$manual_pid" journal-cas-crash-hit
    unset GL_A_TEST_JOURNAL_CAS_CRASH
    assert_cas_namespace "$rollback" "$expected"
    if [ -f "${rollback}.tmp" ]; then final_record="${rollback}.tmp"; else final_record=$rollback; fi
    case "$scenario" in
        journal-rollback-semantic-drift)
            rewrite_json_in_place "${rollback}.tmp" rollback-terminal-jump; positive=0 ;;
        journal-rollback-samebytes-predecessor)
            replace_same_bytes_inode "${rollback}.previous-update-gl-a-${operation_id}" rollback-samebytes
            positive=0
            ;;
        journal-rollback-partial-tmp)
            truncate -s 37 "${rollback}.tmp"; positive=0 ;;
        journal-rollback-p-only)
            rm -f "${rollback}.tmp"; assert_cas_namespace "$rollback" P; positive=0 ;;
        journal-rollback-all-three)
            cp "${rollback}.previous-update-gl-a-${operation_id}" "$rollback"
            chown root:root "$rollback"; chmod 0600 "$rollback"
            assert_cas_namespace "$rollback" FTP
            positive=0
            ;;
        journal-rollback-unknown-cleanup)
            replace_unknown_inode "${rollback}.previous-update-gl-a-${operation_id}.cleanup" rollback-cleanup
            positive=0
            ;;
    esac
    manual_output="$test_root/rollback-cas-reentry.out"
    if [ "$positive" -eq 1 ]; then
        run_manual_rollback "$manual_output"
        test "$manual_rc" -eq 0 || fail "rollback-cas-reentry-rc-$manual_rc"
        complete_c_positive_reentry 0
    else
        run_c_negative_twice_stable "$manual_output"
        c_case_terminal=0
    fi
    rc=0
}

assert_runtime_cleanup_plan_shape() {
    local rollback=$1
    jq -e '
        (.phase == "runtime_cleanup_started" or .phase == "runtime_removed" or
         .phase == "rollback_failed") and
        .runtime_cleanup.schema == 1 and
        [.runtime_cleanup.items[].slot] == [
          "site_installer","site_restore","timer","service","rotation_status",
          "rotation_provenance","rotation_state_dir","rotation_anchor","checker",
          "rotate","format","diff_checker","inserter","log"
        ] and
        (.runtime_cleanup.cursor | type == "number") and
        (.runtime_cleanup.cursor_state == "pending" or
         .runtime_cleanup.cursor_state == "detaching" or
         .runtime_cleanup.cursor_state == "detached" or
         .runtime_cleanup.cursor_state == "complete")
    ' "$rollback" >/dev/null || fail runtime-cleanup-plan-shape
}

assert_format_cleanup_crash_window() {
    local expected_state=$1 expected_selected=$2 item selected tombstone expected_fingerprint
    assert_runtime_cleanup_plan_shape "$recovery_rollback_journal"
    jq -e --arg expected_state "$expected_state" '
        .runtime_cleanup.items[.runtime_cleanup.cursor].slot == "format" and
        .runtime_cleanup.cursor_state == $expected_state
    ' "$recovery_rollback_journal" >/dev/null || fail format-cleanup-crash-journal-window
    item=$(jq -cer '.runtime_cleanup.items[.runtime_cleanup.cursor]' \
        "$recovery_rollback_journal")
    selected=$(jq -er '.selected_path' <<< "$item")
    tombstone=$(jq -er '.tombstone' <<< "$item")
    test "$selected" = "$expected_selected" || fail format-cleanup-selected-path
    test ! -e "$selected" && test ! -L "$selected" || fail format-cleanup-selected-remained
    expected_fingerprint="$(jq -er '.identity.sha256' <<< "$item"):$(jq -er '.identity.dev' <<< "$item"):$(jq -er '.identity.ino' <<< "$item")"
    assert_file_identity_fingerprint "$tombstone" "$expected_fingerprint" \
        format-cleanup-tombstone
    test "$(stat -c '%u %g %a' "$tombstone")" = \
        "$(jq -er '.identity.uid' <<< "$item") $(jq -er '.identity.gid' <<< "$item") $(jq -er '.identity.mode' <<< "$item")" \
        || fail format-cleanup-tombstone-metadata
    while IFS= read -r alternate; do
        test "$alternate" = "$selected" && continue
        test ! -e "$alternate" && test ! -L "$alternate" \
            || fail format-cleanup-alternate-present
    done < <(jq -r '.paths[]' <<< "$item")
    test ! -e "$test_root/${scenario}-ready" \
        || fail "$scenario-legacy-sync-hook-reached"
    format_cleanup_tombstone=$tombstone
}

assert_official_runtime_cleanup_crash_window() {
    local expected_slot=$1 expected_cursor=$2 expected_state=$3 expected_selected=$4
    local item selected tombstone expected_tombstone expected_fingerprint alternate
    assert_runtime_cleanup_plan_shape "$recovery_rollback_journal"
    jq -e --arg expected_slot "$expected_slot" --argjson expected_cursor "$expected_cursor" \
        --arg expected_state "$expected_state" '
        .runtime_cleanup.cursor == $expected_cursor and
        .runtime_cleanup.items[$expected_cursor].slot == $expected_slot and
        .runtime_cleanup.cursor_state == $expected_state
    ' "$recovery_rollback_journal" >/dev/null \
        || fail official-runtime-cleanup-crash-journal-window
    item=$(jq -cer --argjson expected_cursor "$expected_cursor" \
        '.runtime_cleanup.items[$expected_cursor]' "$recovery_rollback_journal")
    selected=$(jq -er '.selected_path' <<< "$item")
    tombstone=$(jq -er '.tombstone' <<< "$item")
    test "$selected" = "$expected_selected" || fail official-runtime-cleanup-selected-path
    expected_tombstone="${expected_selected}.runtime-cleanup-gl-a-${operation_id}-$(printf '%02d' "$expected_cursor")"
    test "$tombstone" = "$expected_tombstone" || fail official-runtime-cleanup-tombstone-path
    test ! -e "$selected" && test ! -L "$selected" \
        || fail official-runtime-cleanup-selected-remained
    expected_fingerprint="$(jq -er '.identity.sha256' <<< "$item"):$(jq -er '.identity.dev' <<< "$item"):$(jq -er '.identity.ino' <<< "$item")"
    assert_file_identity_fingerprint "$tombstone" "$expected_fingerprint" \
        official-runtime-cleanup-tombstone
    test "$(stat -c '%u %g %a' "$tombstone")" = \
        "$(jq -er '.identity.uid' <<< "$item") $(jq -er '.identity.gid' <<< "$item") $(jq -er '.identity.mode' <<< "$item")" \
        || fail official-runtime-cleanup-tombstone-metadata
    while IFS= read -r alternate; do
        test "$alternate" = "$selected" && continue
        test ! -e "$alternate" && test ! -L "$alternate" \
            || fail official-runtime-cleanup-alternate-present
    done < <(jq -r '.paths[]' <<< "$item")
    official_runtime_cleanup_tombstone=$tombstone
}

forge_terminal_pair_pre_marker_drift() {
    local source=$1 rollback=$2 marker_tmp=$3 saved_source=$4 saved_rollback=$5
    python3 - "$source" "$rollback" "$marker_tmp" "$saved_source" "$saved_rollback" \
        "$operation_id" <<'PY'
import base64
import hashlib
import json
import os
import stat
import sys

source_path, rollback_path, marker_tmp, saved_source, saved_rollback, operation_id = sys.argv[1:]
marker_final = marker_tmp.removesuffix(".tmp")


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def read(path):
    with open(path, "rb", buffering=0) as source:
        return source.read()


def overwrite(path, raw):
    before = os.lstat(path)
    descriptor = os.open(path, os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW)
    try:
        remaining = memoryview(raw)
        while remaining:
            count = os.write(descriptor, remaining)
            if count <= 0:
                raise RuntimeError("short fixture overwrite")
            remaining = remaining[count:]
        os.fsync(descriptor)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
        raise RuntimeError("fixture target inode changed")
    parent = os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)


def authority(path):
    raw = read(path)
    value = os.lstat(path)
    return {
        "dev": value.st_dev,
        "ino": value.st_ino,
        "raw_base64": base64.b64encode(raw).decode("ascii"),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


source_raw = read(source_path + ".tmp")
rollback_raw = read(rollback_path + ".tmp")
with open(saved_source, "wb") as target:
    target.write(source_raw)
with open(saved_rollback, "wb") as target:
    target.write(rollback_raw)
os.chmod(saved_source, 0o600)
os.chmod(saved_rollback, 0o600)

source_target = json.loads(source_raw)
source_target["g0_commit"] = "b" * 40
overwrite(source_path + ".tmp", canonical(source_target))
source_target_sha256 = hashlib.sha256(read(source_path + ".tmp")).hexdigest()

rollback_target = json.loads(rollback_raw)
rollback_target["g0_commit"] = "b" * 40
rollback_target["source_journal_terminal_sha256"] = source_target_sha256
overwrite(rollback_path + ".tmp", canonical(rollback_target))
rollback_target_sha256 = hashlib.sha256(read(rollback_path + ".tmp")).hexdigest()

source_before = authority(source_path)
rollback_before = authority(rollback_path)
marker = {
    "schema": 1,
    "gate": "GL-a-terminal-pair",
    "phase": "prepared",
    "operation_id": operation_id,
    "source_journal": source_path,
    "rollback_journal": rollback_path,
    "rollback_commit_marker": marker_final,
    "source_before_authority": source_before,
    "rollback_before_authority": rollback_before,
    "source_before_sha256": source_before["sha256"],
    "rollback_before_sha256": rollback_before["sha256"],
    "source_target_sha256": source_target_sha256,
    "rollback_target_sha256": rollback_target_sha256,
}
descriptor = os.open(marker_tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
try:
    raw = canonical(marker)
    remaining = memoryview(raw)
    while remaining:
        count = os.write(descriptor, remaining)
        if count <= 0:
            raise RuntimeError("short fixture marker write")
        remaining = remaining[count:]
    os.fsync(descriptor)
finally:
    os.close(descriptor)
parent = os.open(os.path.dirname(marker_tmp), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    os.fsync(parent)
finally:
    os.close(parent)
PY
}

restore_terminal_pair_pre_marker_targets() {
    local source_tmp=$1 rollback_tmp=$2 saved_source=$3 saved_rollback=$4
    python3 - "$source_tmp" "$rollback_tmp" "$saved_source" "$saved_rollback" <<'PY'
import os
import sys

source_tmp, rollback_tmp, saved_source, saved_rollback = sys.argv[1:]
for destination, saved in ((source_tmp, saved_source), (rollback_tmp, saved_rollback)):
    before = os.lstat(destination)
    with open(saved, "rb", buffering=0) as source:
        raw = source.read()
    descriptor = os.open(destination, os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW)
    try:
        remaining = memoryview(raw)
        while remaining:
            count = os.write(descriptor, remaining)
            if count <= 0:
                raise RuntimeError("short fixture restore")
            remaining = remaining[count:]
        os.fsync(descriptor)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
        raise RuntimeError("fixture restore inode changed")
parent = os.open(os.path.dirname(source_tmp), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    os.fsync(parent)
finally:
    os.close(parent)
PY
}

exercise_terminal_pair_reentry() {
    local point marker marker_tmp saved_marker marker_namespace_before
    local saved_source_target saved_rollback_target
    rc=$(run_installer "$output")
    test "$rc" -eq 0 || fail "terminal-pair-install-rc-$rc"
    load_manual_recovery_contract
    install_summary_sha_before_rollback=$(sha256sum "$staging/gl-a-summary.json" | awk '{print $1}')
    case "$scenario" in
        terminal-pair-zero-side-reentry) point=zero-side ;;
        terminal-pair-one-side-reentry) point=one-side ;;
        terminal-pair-two-side-reentry) point=two-side ;;
        terminal-pair-pre-marker-reentry) point=pre-marker ;;
        *) fail terminal-pair-c-scenario ;;
    esac
    if [ "$scenario" = terminal-pair-pre-marker-reentry ]; then
        rm -rf "$test_root/terminal-pair-failure-hit"
        export GL_A_TEST_TERMINAL_PAIR_FAILURE=logs-archived
        manual_output="$test_root/terminal-pair-logs-archived-failure.out"
        run_manual_rollback "$manual_output"
        unset GL_A_TEST_TERMINAL_PAIR_FAILURE
        test "$manual_rc" -ne 0 || fail terminal-pair-logs-archived-false-success
        test -d "$test_root/terminal-pair-failure-hit" \
            || fail terminal-pair-logs-archived-hook-missing
        grep -Fq 'manual_rollback=failed' "$manual_output" \
            || fail terminal-pair-logs-archived-failure-marker
        manifest="/var/backups/aifeeds-performance-log/audit-${operation_id}/archive-manifest.json"
        jq -e --arg sha "$(sha256sum "$manifest" | awk '{print $1}')" \
            --argjson generation "$(jq -er '.generation' "$manifest")" \
            --argjson count "$(jq -er '.entries | length' "$manifest")" '
            .phase == "rollback_failed" and .failed_from == "logs_archived" and
            .log_archive_manifest_sha256 == $sha and
            .log_archive_manifest_generation == $generation and
            .log_archive_manifest_entry_count == $count
        ' "$recovery_rollback_journal" >/dev/null \
            || fail terminal-pair-logs-archived-evidence-lost
    fi
    rm -rf "$test_root/terminal-pair-crash-hit"
    export GL_A_TEST_TERMINAL_PAIR_CRASH=$point
    start_manual_rollback "$test_root/terminal-pair-c-crash.out"
    wait_for_c_crash "$manual_pid" terminal-pair-crash-hit
    unset GL_A_TEST_TERMINAL_PAIR_CRASH
    if [ "$scenario" = terminal-pair-pre-marker-reentry ]; then
        marker_tmp="/var/backups/aifeeds-performance-log/rollback-commit-${operation_id}.json.tmp"
        saved_source_target="$test_root/terminal-source-target.valid"
        saved_rollback_target="$test_root/terminal-rollback-target.valid"
        test ! -e "${marker_tmp%.tmp}" || fail terminal-pre-marker-final-unexpected
        forge_terminal_pair_pre_marker_drift \
            "$recovery_source_journal" "$recovery_rollback_journal" "$marker_tmp" \
            "$saved_source_target" "$saved_rollback_target"
        run_c_negative_twice_stable "$test_root/terminal-pair-authority-drift.out"
        test ! -e "${marker_tmp%.tmp}" || fail terminal-authority-drift-adopted-final-marker
        test -f "$marker_tmp" || fail terminal-authority-drift-marker-tmp-lost
        restore_terminal_pair_pre_marker_targets \
            "${recovery_source_journal}.tmp" "${recovery_rollback_journal}.tmp" \
            "$saved_source_target" "$saved_rollback_target"
        rm -f "$marker_tmp"
        sync -f "${marker_tmp%/*}"
    fi
    manual_output="$test_root/terminal-pair-c-recovery.out"
    run_manual_rollback "$manual_output"
    complete_c_positive_reentry 1
    if [ "$scenario" = terminal-pair-pre-marker-reentry ]; then
        marker="/var/backups/aifeeds-performance-log/rollback-commit-${operation_id}.json"
        saved_marker="$test_root/terminal-committed-marker.valid"
        /usr/bin/cp -p "$marker" "$saved_marker"
        marker_namespace_before=$(c_namespace_fingerprint)
        rewrite_json_in_place "$marker" terminal-marker-prepared-hash
        run_c_negative_twice_stable "$test_root/terminal-committed-marker-drift.out"
        /usr/bin/cp -p "$saved_marker" "$marker"
        sync -f "$marker"
        test "$(c_namespace_fingerprint)" = "$marker_namespace_before" \
            || fail terminal-committed-marker-restore-drift
        manual_output="$test_root/terminal-committed-marker-restored.out"
        run_manual_rollback "$manual_output"
        test "$manual_rc" -eq 0 || fail terminal-committed-marker-restored-reentry
        manual_reentry_output=$manual_output
        test "$(c_namespace_fingerprint)" = "$marker_namespace_before" \
            || fail terminal-committed-marker-restored-namespace-drift
    fi
    rc=0
}

exercise_terminal_source_bound_cleanup_drift() {
    local barrier_point expected_source_namespace terminal_marker saved_source_target
    local source_identity_before bound_source_fingerprint bound_rollback_fingerprint
    local bound_marker_fingerprint bound_summary_fingerprint bound_namespace_fingerprint
    rc=$(run_installer "$output")
    test "$rc" -eq 0 || fail "$scenario-install-rc-$rc"
    load_manual_recovery_contract
    install_summary_sha_before_rollback=$(sha256sum "$staging/gl-a-summary.json" | awk '{print $1}')
    terminal_marker="/var/backups/aifeeds-performance-log/rollback-commit-${operation_id}.json"
    case "$scenario" in
        terminal-source-p-bound-target-drift) barrier_point=cleanup-terminal-bound-fp; expected_source_namespace=FP ;;
        terminal-source-c-bound-target-drift) barrier_point=cleanup-terminal-bound-fc; expected_source_namespace=FC ;;
        *) fail terminal-source-bound-cleanup-scenario ;;
    esac

    if [ "$scenario" = terminal-source-c-bound-target-drift ]; then
        rm -f "$test_root/journal-cas-crash-hit"
        export GL_A_TEST_JOURNAL_CAS_CRASH=source:rolled_back:p-to-c
        manual_crash_output="$test_root/${scenario}.p-to-c-crash.out"
        start_manual_rollback "$manual_crash_output"
        wait_for_c_crash "$manual_pid" journal-cas-crash-hit 1200
        unset GL_A_TEST_JOURNAL_CAS_CRASH
        assert_cas_namespace "$recovery_source_journal" FC
        assert_cas_namespace "$recovery_rollback_journal" FP
    fi

    rm -f "$test_root/journal-cas-barrier-${barrier_point}-ready" \
        "$test_root/journal-cas-barrier-${barrier_point}-release"
    export GL_A_TEST_JOURNAL_CAS_BARRIER="source:rolled_back:${barrier_point}"
    manual_output="$test_root/${scenario}.bound-cleanup.out"
    start_manual_rollback "$manual_output"
    wait_for_file "$test_root/journal-cas-barrier-${barrier_point}-ready" 1200
    assert_cas_namespace "$recovery_source_journal" "$expected_source_namespace"
    assert_cas_namespace "$recovery_rollback_journal" FP
    test -f "$terminal_marker" && test ! -L "$terminal_marker" \
        || fail "$scenario-marker-missing"

    saved_source_target="$test_root/${scenario}.source-target.valid"
    /usr/bin/cp -p "$recovery_source_journal" "$saved_source_target"
    /usr/bin/sync -f "$saved_source_target"
    source_identity_before=$(stat -c '%d %i' "$recovery_source_journal")
    rewrite_json_in_place "$recovery_source_journal" terminal-source-target
    test "$(stat -c '%d %i' "$recovery_source_journal")" = "$source_identity_before" \
        || fail "$scenario-source-inode-changed-during-injection"
    assert_shape_valid_non_marker_terminal_source \
        "$recovery_source_journal" "$saved_source_target" "$terminal_marker"

    bound_source_fingerprint=$(file_identity_fingerprint "$recovery_source_journal")
    bound_rollback_fingerprint=$(file_identity_fingerprint "$recovery_rollback_journal")
    bound_marker_fingerprint=$(file_identity_fingerprint "$terminal_marker")
    bound_summary_fingerprint=$(optional_file_identity_fingerprint "$recovery_manual_summary")
    bound_namespace_fingerprint=$(c_namespace_fingerprint)
    : > "$test_root/journal-cas-barrier-${barrier_point}-release"
    set +e
    wait "$manual_pid"
    manual_rc=$?
    set -e
    unset GL_A_TEST_JOURNAL_CAS_BARRIER
    test "$manual_rc" -ne 0 || fail "$scenario-bound-cleanup-returned-zero"
    ! grep -Fq 'manual_rollback=pass' "$manual_output" \
        || fail "$scenario-bound-cleanup-false-pass"
    assert_terminal_bound_first_failure_unchanged
    rc=0
    c_case_terminal=0
}

exercise_runtime_cleanup_reentry() {
    local mode point mutation=none positive=1 rollback tomb
    local handoff_marker handoff_log handoff_dev handoff_ino handoff_size_before handoff_size_after
    case "$scenario" in
        cleanup-manual-*) mode=manual ;;
        cleanup-automatic-*) mode=automatic ;;
        *) fail cleanup-c-mode ;;
    esac
    case "$scenario" in
        cleanup-*-detaching-reentry) point=site_installer:detaching ;;
        cleanup-*-detached-reentry) point=site_installer:detached ;;
        cleanup-*-unknown-tombstone) point=site_installer:detaching; mutation=unknown ;;
        cleanup-*-plan-drift) point=site_installer:detaching; mutation=plan ;;
        cleanup-*-failed-from-drift) point=site_installer:detaching; mutation=failed-from ;;
        cleanup-*-legacy-runtime-removed) point=phase:legacy-runtime-removed-residue; mutation=legacy ;;
        *) fail cleanup-c-scenario ;;
    esac
    rm -rf "$test_root/runtime-cleanup-crash-hit"
    export GL_A_TEST_RUNTIME_CLEANUP_CRASH=$point
    if [ "$mode" = manual ]; then
        rc=$(run_installer "$output")
        test "$rc" -eq 0 || fail "cleanup-manual-install-rc-$rc"
        load_manual_recovery_contract
        install_summary_sha_before_rollback=$(sha256sum "$staging/gl-a-summary.json" | awk '{print $1}')
        start_manual_rollback "$test_root/cleanup-manual-crash.out"
        wait_for_c_crash "$manual_pid" runtime-cleanup-crash-hit
    else
        rc=$(run_installer "$output")
        test "$rc" -eq 90 || fail "cleanup-automatic-installer-rc-$rc"
        test -d "$test_root/runtime-cleanup-crash-hit" || fail cleanup-automatic-hook-missing
        grep -Fq 'automatic_rollback=failed ' "$output" || fail cleanup-automatic-failure-marker
        load_manual_recovery_contract
    fi
    unset GL_A_TEST_RUNTIME_CLEANUP_CRASH
    rollback=$recovery_rollback_journal
    test -f "$rollback" || fail cleanup-rollback-journal-missing
    if [ "$mutation" = legacy ]; then
        jq -e '.phase == "site_restored" and (.runtime_cleanup | not)' \
            "$rollback" >/dev/null || fail cleanup-legacy-residue-journal-not-preplan
        test -e /etc/systemd/system/aifeeds-performance-logrotate.service \
            || fail cleanup-legacy-residue-service-missing
        test -e /etc/nginx/conf.d/aifeeds-performance-log.conf \
            || fail cleanup-legacy-residue-format-missing
        test -e /var/log/nginx/aifeeds-performance.jsonl \
            || fail cleanup-legacy-residue-log-missing
    else
        assert_runtime_cleanup_plan_shape "$rollback"
    fi
    if [ "$scenario" = cleanup-manual-detaching-reentry ]; then
        handoff_log=/var/log/nginx/aifeeds-performance.jsonl
        handoff_marker="upstream-$(date +%s)-C0DEC0DE"
        jq -e --arg log "$handoff_log" '
            .runtime_cleanup.items[] | select(.slot == "log") |
            .action == "archive_handoff" and .selected_path == $log and
            (.identity | keys | sort) == ["dev","gid","ino","mode","uid"]
        ' "$rollback" >/dev/null || fail cleanup-log-handoff-plan-identity
        handoff_dev=$(stat -c '%d' "$handoff_log")
        handoff_ino=$(stat -c '%i' "$handoff_log")
        handoff_size_before=$(stat -c '%s' "$handoff_log")
        /usr/bin/curl -fsS -o /dev/null -H 'Host: ai-feeds.com' \
            -H "X-Aifeeds-Perf-Probe: $handoff_marker" http://127.0.0.1:8080/ \
            || fail cleanup-log-handoff-request
        sleep 6
        test "$(stat -c '%d %i' "$handoff_log")" = "$handoff_dev $handoff_ino" \
            || fail cleanup-log-handoff-inode-changed
        handoff_size_after=$(stat -c '%s' "$handoff_log")
        test "$handoff_size_after" -gt "$handoff_size_before" \
            || fail cleanup-log-handoff-size-not-increased
    fi
    case "$mutation" in
        none) ;;
        unknown)
            tomb=$(jq -er '.runtime_cleanup.items[.runtime_cleanup.cursor].tombstone' "$rollback")
            replace_unknown_inode "$tomb" cleanup-runtime-tombstone
            positive=0
            ;;
        plan)
            rewrite_json_in_place "$rollback" plan
            positive=0
            ;;
        failed-from)
            rm -f "$test_root/journal-cas-crash-hit"
            rm -rf "$test_root/terminal-pair-failure-hit"
            export GL_A_TEST_TERMINAL_PAIR_FAILURE=logs-archived
            export GL_A_TEST_JOURNAL_CAS_CRASH=rollback:rollback_failed:t-durable
            start_manual_rollback "$test_root/cleanup-failed-from-crash.out"
            wait_for_c_crash "$manual_pid" journal-cas-crash-hit
            unset GL_A_TEST_JOURNAL_CAS_CRASH
            unset GL_A_TEST_TERMINAL_PAIR_FAILURE
            test -d "$test_root/terminal-pair-failure-hit" \
                || fail cleanup-failed-from-terminal-failure-not-hit
            test -f "${rollback}.tmp" || fail cleanup-failed-from-tmp-missing
            rewrite_json_in_place "${rollback}.tmp" failed-from
            positive=0
            ;;
        legacy)
            rewrite_json_in_place "$rollback" legacy-cleanup
            ;;
        *) fail cleanup-c-mutation ;;
    esac
    manual_output="$test_root/cleanup-c-recovery.out"
    if [ "$positive" -eq 1 ]; then
        run_manual_rollback "$manual_output"
        complete_c_positive_reentry 0
        if [ "$scenario" = cleanup-manual-detaching-reentry ]; then
            grep -Fq "$handoff_marker" \
                "/var/backups/aifeeds-performance-log/audit-${operation_id}/aifeeds-performance.jsonl" \
                || fail cleanup-log-handoff-append-not-archived
        fi
    else
        run_c_negative_twice_stable "$manual_output"
        c_case_terminal=0
    fi
    rc=0
}

exercise_source_legacy_genesis() {
    local source trusted_sha marker source_fingerprint rollback_fingerprint
    local marker_fingerprint summary_fingerprint namespace_fingerprint
    source="/var/backups/aifeeds-performance-log/transaction-${operation_id}.json"
    rm -f "$test_root/journal-cas-crash-hit"
    export GL_A_TEST_JOURNAL_CAS_CRASH=source:initializing:t-durable
    setsid /bin/bash "$installer" "$staging" "$operation_id" "$g0_commit" \
        > "$output" 2>&1 &
    installer_pid=$!
    assert_isolated_process_group "$installer_pid" source-legacy-installer
    wait_for_c_crash "$installer_pid" journal-cas-crash-hit
    unset GL_A_TEST_JOURNAL_CAS_CRASH
    test ! -e "$source" && test -f "${source}.tmp" || fail source-legacy-genesis-namespace
    mv "${source}.tmp" "$source"
    rewrite_json_in_place "$source" legacy-source
    trusted_sha=$(sha256sum "$source" | awk '{print $1}')
    load_recovery_contract_from_record "$source" "$trusted_sha"
    manual_output="$test_root/source-legacy-recovery.out"
    run_manual_rollback "$manual_output"
    complete_c_positive_reentry 0
    marker="/var/backups/aifeeds-performance-log/rollback-commit-${operation_id}.json"
    source_fingerprint=$(file_identity_fingerprint "$source")
    rollback_fingerprint=$(file_identity_fingerprint "$recovery_rollback_journal")
    marker_fingerprint=$(file_identity_fingerprint "$marker")
    summary_fingerprint=$(file_identity_fingerprint "$recovery_manual_summary")
    namespace_fingerprint=$(c_namespace_fingerprint)
    recovery_source_sha=$(printf 'd%.0s' {1..64})
    run_manual_rollback "$test_root/source-legacy-wrong-arg9.out"
    test "$manual_rc" -ne 0 || fail source-legacy-wrong-arg9-returned-zero
    ! grep -Fq 'manual_rollback=pass' "$test_root/source-legacy-wrong-arg9.out" \
        || fail source-legacy-wrong-arg9-false-pass
    grep -Fq 'untrusted legacy journal' \
        "$test_root/source-legacy-wrong-arg9.out" \
        || fail source-legacy-wrong-arg9-check-not-reached
    assert_file_identity_fingerprint "$source" "$source_fingerprint" \
        source-legacy-wrong-arg9-source-changed
    assert_file_identity_fingerprint "$recovery_rollback_journal" "$rollback_fingerprint" \
        source-legacy-wrong-arg9-rollback-changed
    assert_file_identity_fingerprint "$marker" "$marker_fingerprint" \
        source-legacy-wrong-arg9-marker-changed
    assert_file_identity_fingerprint "$recovery_manual_summary" "$summary_fingerprint" \
        source-legacy-wrong-arg9-summary-changed
    test "$(c_namespace_fingerprint)" = "$namespace_fingerprint" \
        || fail source-legacy-wrong-arg9-namespace-changed
    recovery_source_sha=$trusted_sha
    rc=0
}

exercise_rollback_legacy_genesis_rejected() {
    local rollback
    rc=$(run_installer "$output")
    test "$rc" -eq 0 || fail "rollback-legacy-install-rc-$rc"
    load_manual_recovery_contract
    install_summary_sha_before_rollback=$(sha256sum "$staging/gl-a-summary.json" | awk '{print $1}')
    rollback=$recovery_rollback_journal
    rm -f "$test_root/journal-cas-crash-hit"
    export GL_A_TEST_JOURNAL_CAS_CRASH=rollback:prepared:t-durable
    start_manual_rollback "$test_root/rollback-legacy-crash.out"
    wait_for_c_crash "$manual_pid" journal-cas-crash-hit
    unset GL_A_TEST_JOURNAL_CAS_CRASH
    test ! -e "$rollback" && test -f "${rollback}.tmp" || fail rollback-legacy-genesis-namespace
    mv "${rollback}.tmp" "$rollback"
    rewrite_json_in_place "$rollback" legacy-source
    manual_output="$test_root/rollback-legacy-reentry.out"
    run_c_negative_twice_stable "$manual_output"
    c_case_terminal=0
    rc=0
}

prepare_secondary_staging() {
    secondary_operation_id=$1
    secondary_staging="/run/aifeeds-performance-log.${scenario}.secondary"
    /usr/bin/install -d -o root -g root -m 0700 "$secondary_staging"
    for payload in "${payloads[@]}"; do
        /usr/bin/install -o root -g root -m 0600 "$staging/$payload" \
            "$secondary_staging/$payload"
    done
    /usr/bin/install -o root -g root -m 0600 "$staging/SHA256SUMS" \
        "$secondary_staging/SHA256SUMS"
}

run_secondary_installer() {
    local destination=$1
    set +e
    /bin/bash "$installer" "$secondary_staging" "$secondary_operation_id" "$g0_commit" \
        > "$destination" 2>&1
    secondary_rc=$?
    set -e
}

assert_payload_artifacts_exact() {
    local paths=(
        /etc/nginx/conf.d/aifeeds-performance-log.conf
        /etc/aifeeds-performance-logrotate.conf
        /usr/local/sbin/aifeeds-check-nginx-request-id
        /usr/local/sbin/aifeeds-verify-nginx-request-id-diff
        /usr/local/sbin/aifeeds-insert-nginx-request-id
        /etc/systemd/system/aifeeds-performance-logrotate.service
        /etc/systemd/system/aifeeds-performance-logrotate.timer
    )
    local keys=(format rotate checker diff_checker inserter service timer)
    local metadata=('0 0 644' '0 0 644' '0 0 755' '0 0 755' '0 0 755' '0 0 644' '0 0 644')
    local index=0
    while [ "$index" -lt "${#paths[@]}" ]; do
        test -f "${paths[$index]}" || fail "payload-missing:${keys[$index]}"
        test ! -L "${paths[$index]}" || fail "payload-symlink:${keys[$index]}"
        test "$(stat -c '%u %g %a' "${paths[$index]}")" = "${metadata[$index]}" \
            || fail "payload-metadata:${keys[$index]}"
        test "$(sha256sum "${paths[$index]}" | awk '{print $1}')" = \
            "$(jq -er --arg key "${keys[$index]}" '.[$key]' <<< "$artifacts_sha256_json")" \
            || fail "payload-hash:${keys[$index]}"
        index=$((index + 1))
    done
}

assert_no_audit_candidates() {
    local audit_dir=$1
    local transaction_id=$2
    test -z "$(/usr/bin/find "$audit_dir" -maxdepth 1 -type f \
        -name "*.candidate-gl-a-${transaction_id}" -print -quit)" \
        || fail audit-candidate-remained
}

assert_no_operation_cleanup_residue() {
    local label=$1 root residue
    for root in /var/log/nginx /var/backups/aifeeds-performance-log \
        /etc/nginx/sites-available /etc/nginx/conf.d /etc /usr/local/sbin \
        /etc/systemd/system /var/lib; do
        [ -e "$root" ] || continue
        residue=$(find "$root" -name ".cleanup-gl-a-${operation_id}-*" -print -quit)
        test -z "$residue" || fail "$label-cleanup-residue"
    done
}

assert_crossfs_terminal_evidence() {
    local label=$1 live_dev=$2
    local audit_dir="/var/backups/aifeeds-performance-log/audit-${operation_id}"
    local manifest="$audit_dir/archive-manifest.json"
    local source quarantine candidate destination sha256 size destination_dev destination_ino
    test -f "$manifest" || fail "$label-manifest-missing"
    test ! -L "$manifest" || fail "$label-manifest-symlink"
    jq -e --arg operation_id "$operation_id" '
        .schema == 2 and .operation_id == $operation_id and
        .inventory_complete == true and .empty_inventory == false and
        .generation == (4 * (.entries | length) + 1) and
        all(.entries[]; .state == "archived" and
          (.candidate_dev | type == "number" and . > 0) and
          (.candidate_ino | type == "number" and . > 0) and
          .destination_dev == .candidate_dev and
          .destination_ino == .candidate_ino)' "$manifest" >/dev/null \
        || fail "$label-manifest-terminal"
    while IFS=$'\t' read -r source quarantine candidate destination sha256 size \
        destination_dev destination_ino; do
        test ! -e "$source" && test ! -L "$source" || fail "$label-source-remained"
        test ! -e "$quarantine" && test ! -L "$quarantine" \
            || fail "$label-quarantine-remained"
        test ! -e "$candidate" && test ! -L "$candidate" || fail "$label-candidate-remained"
        test -f "$destination" || fail "$label-destination-missing"
        test ! -L "$destination" || fail "$label-destination-symlink"
        test "$(stat -c '%u %g %a' "$destination")" = '0 0 600' \
            || fail "$label-destination-metadata"
        test "$(sha256sum "$destination" | awk '{print $1}')" = "$sha256" \
            || fail "$label-destination-hash"
        test "$(stat -c '%s' "$destination")" = "$size" || fail "$label-destination-size"
        test "$(stat -c '%d %i' "$destination")" = "$destination_dev $destination_ino" \
            || fail "$label-destination-identity"
        test "$(stat -c '%d' "$destination")" = "$(stat -c '%d' "$audit_dir")" \
            || fail "$label-destination-audit-device"
        test "$(stat -c '%d' "$destination")" != "$live_dev" \
            || fail "$label-destination-live-device"
    done < <(jq -r '.entries[] | [.source,.quarantine,.candidate,.destination,
        .final_sha256,(.final_size|tostring),(.destination_dev|tostring),
        (.destination_ino|tostring)] | @tsv' "$manifest")
    test "$(find "$audit_dir" -maxdepth 1 -type f ! -name archive-manifest.json | wc -l | tr -d ' ')" = \
        "$(jq -er '.entries | length' "$manifest")" || fail "$label-canonical-set"
    assert_no_audit_candidates "$audit_dir" "$operation_id"
    assert_no_operation_cleanup_residue "$label"
}

assert_crossfs_copied_window() {
    local label=$1
    local manifest="/var/backups/aifeeds-performance-log/audit-${operation_id}/archive-manifest.json"
    local entry source quarantine candidate destination
    entry=$(jq -cer '[.entries[] | select(.state == "copied")] |
        if length == 1 then .[0] else error("copied window") end' "$manifest") \
        || fail "$label-manifest-window"
    source=$(jq -er '.source' <<< "$entry")
    quarantine=$(jq -er '.quarantine' <<< "$entry")
    candidate=$(jq -er '.candidate' <<< "$entry")
    destination=$(jq -er '.destination' <<< "$entry")
    test ! -e "$source" && test ! -L "$source" || fail "$label-source-present"
    test ! -e "$destination" && test ! -L "$destination" || fail "$label-destination-present"
    test -f "$quarantine" && test ! -L "$quarantine" || fail "$label-quarantine-missing"
    test "$(stat -c '%d %i' "$quarantine")" = \
        "$(jq -r '[.dev,.ino] | map(tostring) | join(" ")' <<< "$entry")" \
        || fail "$label-quarantine-identity"
    test -f "$candidate" && test ! -L "$candidate" || fail "$label-candidate-missing"
    test "$(stat -c '%d %i' "$candidate")" = \
        "$(jq -r '[.candidate_dev,.candidate_ino] | map(tostring) | join(" ")' <<< "$entry")" \
        || fail "$label-candidate-identity"
    test "$(sha256sum "$candidate" | awk '{print $1}')" = "$(jq -er '.final_sha256' <<< "$entry")" \
        || fail "$label-candidate-hash"
    test "$(stat -c '%s' "$candidate")" = "$(jq -er '.final_size' <<< "$entry")" \
        || fail "$label-candidate-size"
}

assert_crossfs_published_cleanup_window() {
    local payload=$1 label=$2
    local manifest="/var/backups/aifeeds-performance-log/audit-${operation_id}/archive-manifest.json"
    local entry source quarantine candidate destination
    entry=$(jq -cer '[.entries[] | select(.state == "copied")] |
        if length == 1 then .[0] else error("published window") end' "$manifest") \
        || fail "$label-manifest-window"
    source=$(jq -er '.source' <<< "$entry")
    quarantine=$(jq -er '.quarantine' <<< "$entry")
    candidate=$(jq -er '.candidate' <<< "$entry")
    destination=$(jq -er '.destination' <<< "$entry")
    for path in "$source" "$quarantine" "$candidate"; do
        test ! -e "$path" && test ! -L "$path" || fail "$label-precleanup-path-remained"
    done
    test -f "$destination" && test ! -L "$destination" || fail "$label-destination-missing"
    test "$(stat -c '%d %i' "$destination")" = \
        "$(jq -r '[.candidate_dev,.candidate_ino] | map(tostring) | join(" ")' <<< "$entry")" \
        || fail "$label-destination-identity"
    test -f "$payload" && test ! -L "$payload" || fail "$label-payload-missing"
    test "$(stat -c '%d %i' "$payload")" = \
        "$(jq -r '[.dev,.ino] | map(tostring) | join(" ")' <<< "$entry")" \
        || fail "$label-payload-identity"
    test "$(sha256sum "$payload" | awk '{print $1}')" = "$(jq -er '.final_sha256' <<< "$entry")" \
        || fail "$label-payload-hash"
}

assert_prepared_runtime_unmutated() {
    cmp -s "$test_root/aifeeds.conf.original" /etc/nginx/sites-available/aifeeds.conf \
        || fail prepared-site-mutated
    prepared_absent_paths=(
        /etc/nginx/conf.d/aifeeds-performance-log.conf
        /etc/aifeeds-performance-logrotate.conf
        /var/log/nginx/aifeeds-performance.jsonl
        /usr/local/sbin/aifeeds-check-nginx-request-id
        /usr/local/sbin/aifeeds-verify-nginx-request-id-diff
        /usr/local/sbin/aifeeds-insert-nginx-request-id
        /etc/systemd/system/aifeeds-performance-logrotate.service
        /etc/systemd/system/aifeeds-performance-logrotate.timer
        /var/lib/aifeeds-performance-logrotate
    )
    for path in "${prepared_absent_paths[@]}"; do
        if [ -e "$path" ] || [ -L "$path" ]; then
            fail "prepared-artifact-mutated:${path##*/}"
        fi
    done
    test ! -e "$staging/gl-a-summary.json" || fail prepared-summary-created
    test ! -e "$test_root/systemctl/timer.active" || fail prepared-timer-active
    test ! -e "$test_root/systemctl/timer.enabled" || fail prepared-timer-enabled
}

assert_mutation_started_format_candidate_state() {
    local site_candidate
    local backup
    local format_candidate
    test -e "$test_root/mutation-started-format-ready" || fail mutation-started-format-marker
    assert_gl_a_journal_identity "$recovery_source_journal" mutation_started
    site_candidate=$(jq -er '.installer_candidate' "$recovery_source_journal")
    backup=$(jq -er '.site_backup' "$recovery_source_journal")
    format_candidate=$(jq -er '.artifact_candidates.format' "$recovery_source_journal")
    cmp -s "$test_root/aifeeds.conf.original" /etc/nginx/sites-available/aifeeds.conf \
        || fail mutation-started-live-site-not-base
    test "$(stat -c '%u %g %a' /etc/nginx/sites-available/aifeeds.conf)" = \
        "$(jq -er '.original_site_uid' "$recovery_source_journal") $(jq -er '.original_site_gid' "$recovery_source_journal") $(jq -er '.original_site_mode' "$recovery_source_journal")" \
        || fail mutation-started-live-site-metadata
    test -f "$backup" || fail mutation-started-backup-missing
    test ! -L "$backup" || fail mutation-started-backup-symlink
    test "$(stat -c '%u %g %a' "$backup")" = \
        "$(jq -er '.original_site_uid' "$recovery_source_journal") $(jq -er '.original_site_gid' "$recovery_source_journal") $(jq -er '.original_site_mode' "$recovery_source_journal")" \
        || fail mutation-started-backup-metadata
    test "$(sha256sum "$backup" | awk '{print $1}')" = \
        "$(jq -er '.site_backup_sha256' "$recovery_source_journal")" \
        || fail mutation-started-backup-hash
    test -f "$site_candidate" || fail mutation-started-site-candidate-missing
    test ! -L "$site_candidate" || fail mutation-started-site-candidate-symlink
    test "$(stat -c '%u %g %a' "$site_candidate")" = \
        "$(jq -er '.original_site_uid' "$recovery_source_journal") $(jq -er '.original_site_gid' "$recovery_source_journal") $(jq -er '.original_site_mode' "$recovery_source_journal")" \
        || fail mutation-started-site-candidate-metadata
    test "$(stat -c '%d' "$site_candidate")" = \
        "$(stat -c '%d' /etc/nginx/sites-available/aifeeds.conf)" \
        || fail mutation-started-site-candidate-cross-device
    test "$(sha256sum "$site_candidate" | awk '{print $1}')" = \
        "$(jq -er '.installed_site_sha256' "$recovery_source_journal")" \
        || fail mutation-started-site-candidate-hash
    test -f "$format_candidate" || fail mutation-started-format-candidate-missing
    test ! -L "$format_candidate" || fail mutation-started-format-candidate-symlink
    test "$(stat -c '%u %g %a' "$format_candidate")" = '0 0 644' \
        || fail mutation-started-format-candidate-metadata
    test "$(stat -c '%d' "$format_candidate")" = \
        "$(stat -c '%d' /etc/nginx/conf.d)" || fail mutation-started-format-candidate-cross-device
    test "$(sha256sum "$format_candidate" | awk '{print $1}')" = \
        "$(jq -er '.artifacts_sha256.format' "$recovery_source_journal")" \
        || fail mutation-started-format-candidate-hash
    test ! -e /etc/nginx/conf.d/aifeeds-performance-log.conf \
        || fail mutation-started-format-final-present
    test ! -L /etc/nginx/conf.d/aifeeds-performance-log.conf \
        || fail mutation-started-format-final-symlink
    for absent_path in \
        /etc/aifeeds-performance-logrotate.conf \
        /var/log/nginx/aifeeds-performance.jsonl \
        /usr/local/sbin/aifeeds-check-nginx-request-id \
        /usr/local/sbin/aifeeds-verify-nginx-request-id-diff \
        /usr/local/sbin/aifeeds-insert-nginx-request-id \
        /etc/systemd/system/aifeeds-performance-logrotate.service \
        /etc/systemd/system/aifeeds-performance-logrotate.timer \
        /var/lib/aifeeds-performance-logrotate; do
        test ! -e "$absent_path" || fail "mutation-started-final-present:${absent_path##*/}"
        test ! -L "$absent_path" || fail "mutation-started-final-symlink:${absent_path##*/}"
    done
    while IFS= read -r other_candidate; do
        [ "$other_candidate" = "$format_candidate" ] && continue
        test ! -e "$other_candidate" || fail "mutation-started-extra-candidate:${other_candidate##*/}"
        test ! -L "$other_candidate" || fail "mutation-started-extra-candidate-symlink:${other_candidate##*/}"
    done < <(jq -r '.[]' <<< "$artifact_candidates_json")
    test ! -e "$staging/gl-a-summary.json" || fail mutation-started-summary-present
    test ! -e "$test_root/systemctl/timer.active" || fail mutation-started-timer-active
    test ! -e "$test_root/systemctl/timer.enabled" || fail mutation-started-timer-enabled
    test "$(readlink -f /etc/nginx/sites-enabled/aifeeds.conf)" = \
        /etc/nginx/sites-available/aifeeds.conf || fail mutation-started-enabled-site-drift
}

assert_site_swapped_gap_state() {
    local site_candidate
    local backup
    test -e "$test_root/site-swapped-ready" || fail site-swapped-marker
    assert_gl_a_journal_identity "$recovery_source_journal" mutation_started
    site_candidate=$(jq -er '.installer_candidate' "$recovery_source_journal")
    backup=$(jq -er '.site_backup' "$recovery_source_journal")
    test "$(sha256sum /etc/nginx/sites-available/aifeeds.conf | awk '{print $1}')" = \
        "$(jq -er '.installed_site_sha256' "$recovery_source_journal")" \
        || fail site-swapped-live-hash
    test "$(stat -c '%u %g %a' /etc/nginx/sites-available/aifeeds.conf)" = \
        "$(jq -er '.original_site_uid' "$recovery_source_journal") $(jq -er '.original_site_gid' "$recovery_source_journal") $(jq -er '.original_site_mode' "$recovery_source_journal")" \
        || fail site-swapped-live-metadata
    test ! -e "$site_candidate" || fail site-swapped-installer-candidate-remained
    test ! -L "$site_candidate" || fail site-swapped-installer-candidate-symlink
    test -f "$backup" || fail site-swapped-backup-missing
    test "$(sha256sum "$backup" | awk '{print $1}')" = \
        "$(jq -er '.site_backup_sha256' "$recovery_source_journal")" \
        || fail site-swapped-backup-hash
    assert_payload_artifacts_exact
    test -f /var/log/nginx/aifeeds-performance.jsonl || fail site-swapped-log-missing
    test ! -L /var/log/nginx/aifeeds-performance.jsonl || fail site-swapped-log-symlink
    test "$(stat -c '%U %G %a' /var/log/nginx/aifeeds-performance.jsonl)" = \
        'www-data adm 640' || fail site-swapped-log-metadata
    test -d /var/lib/aifeeds-performance-logrotate || fail site-swapped-state-dir-missing
    test "$(stat -c '%u %g %a' /var/lib/aifeeds-performance-logrotate)" = \
        '0 0 750' || fail site-swapped-state-dir-metadata
    test ! -e /var/lib/aifeeds-performance-logrotate/status || fail site-swapped-status-present
    test ! -e "$test_root/systemctl/timer.active" || fail site-swapped-timer-active
    test ! -e "$test_root/systemctl/timer.enabled" || fail site-swapped-timer-enabled
    assert_artifact_candidates_absent
    rollback_candidate="$(jq -er '.rollback_candidate' "$recovery_source_journal")"
    test -f "$rollback_candidate" || fail site-swapped-rollback-candidate-missing
    test ! -L "$rollback_candidate" || fail site-swapped-rollback-candidate-symlink
    test "$(sha256sum "$rollback_candidate" | awk '{print $1}')" = \
        "$(jq -er '.site_backup_sha256' "$recovery_source_journal")" \
        || fail site-swapped-rollback-candidate-hash
    test ! -e "$staging/gl-a-summary.json" || fail site-swapped-summary-present
}

assert_restore_candidate_gap_state() {
    local candidate=$recovery_rollback_candidate
    test -e "$test_root/restore-candidate-ready" || fail restore-candidate-marker
    assert_gl_a_journal_identity "$recovery_source_journal" committed
    jq -e '.phase == "prepared"' "$recovery_rollback_journal" >/dev/null \
        || fail restore-candidate-rollback-phase
    test -f "$candidate" || fail restore-candidate-missing
    test ! -L "$candidate" || fail restore-candidate-symlink
    test "$(sha256sum "$candidate" | awk '{print $1}')" = "$recovery_backup_sha" \
        || fail restore-candidate-hash
    test "$(stat -c '%u %g %a' "$candidate")" = \
        "$recovery_site_uid $recovery_site_gid $recovery_site_mode" \
        || fail restore-candidate-metadata
    test "$(sha256sum /etc/nginx/sites-available/aifeeds.conf | awk '{print $1}')" = \
        "$recovery_installed_sha" || fail restore-candidate-site-swapped
    assert_payload_artifacts_exact
    test ! -e "$test_root/systemctl/timer.active" || fail restore-candidate-timer-active
    test ! -e "$test_root/systemctl/timer.enabled" || fail restore-candidate-timer-enabled
    test ! -e "$recovery_manual_summary" || fail restore-candidate-summary-present
}

assert_audit_log_gap_state() {
    local audit_dir="/var/backups/aifeeds-performance-log/audit-${operation_id}"
    local audit_log="$audit_dir/aifeeds-performance.jsonl"
    local live_log=/var/log/nginx/aifeeds-performance.jsonl
    test -e "$test_root/audit-log-ready" || fail audit-log-marker
    assert_gl_a_journal_identity "$recovery_source_journal" committed
    jq -e '.phase == "nginx_reloaded"' "$recovery_rollback_journal" >/dev/null \
        || fail audit-log-rollback-phase
    test -f "$audit_log" || fail audit-log-final-missing
    test ! -L "$audit_log" || fail audit-log-final-symlink
    test "$(stat -c '%U %G %a' "$audit_log")" = 'root root 600' \
        || fail audit-log-final-metadata
    test ! -e "$live_log" || fail audit-log-live-remained
    test ! -L "$live_log" || fail audit-log-live-symlink
    manifest="$audit_dir/archive-manifest.json"
    test -f "$manifest" || fail audit-log-manifest-missing
    jq -e --arg destination "$audit_log" '
        .inventory_complete == true and
        any(.entries[]; .destination == $destination and .state == "archived")' \
        "$manifest" >/dev/null || fail audit-log-manifest-state
    test ! -e "${audit_log}.candidate-gl-a-${operation_id}" \
        || fail audit-log-candidate-remained
    cmp -s "$test_root/aifeeds.conf.original" /etc/nginx/sites-available/aifeeds.conf \
        || fail audit-log-site-not-base
    test ! -e "$recovery_manual_summary" || fail audit-log-summary-present
}

assert_artifact_candidates_absent() {
    local candidate_path
    while IFS= read -r candidate_path; do
        test ! -e "$candidate_path" || fail "artifact-candidate-remained:${candidate_path##*/}"
        test ! -L "$candidate_path" || fail "artifact-candidate-symlink-remained:${candidate_path##*/}"
    done < <(jq -r '.[]' <<< "$artifact_candidates_json")
}

assert_manual_candidates_absent() {
    for candidate_path in \
        "$recovery_installer_candidate" \
        "$recovery_rollback_candidate"; do
        test ! -e "$candidate_path" || fail "manual-candidate-remained:${candidate_path##*/}"
        test ! -L "$candidate_path" || fail "manual-candidate-symlink-remained:${candidate_path##*/}"
    done
    assert_artifact_candidates_absent
}

capture_manual_terminal_hashes() {
    assert_manual_candidates_absent
    test -f "$recovery_source_journal" || fail manual-first-source-journal-missing
    test -f "$recovery_rollback_journal" || fail manual-first-rollback-journal-missing
    test -f "$recovery_manual_summary" || fail manual-first-summary-missing
    manual_first_source_terminal_sha=$(sha256sum "$recovery_source_journal" | awk '{print $1}')
    manual_first_rollback_terminal_sha=$(sha256sum "$recovery_rollback_journal" | awk '{print $1}')
    manual_first_summary_sha=$(sha256sum "$recovery_manual_summary" | awk '{print $1}')
}

assert_manual_reentry_unchanged() {
    test "$(sha256sum "$recovery_source_journal" | awk '{print $1}')" = "$manual_first_source_terminal_sha" \
        || fail manual-reentry-changed-source-journal
    test "$(sha256sum "$recovery_rollback_journal" | awk '{print $1}')" = "$manual_first_rollback_terminal_sha" \
        || fail manual-reentry-changed-rollback-journal
    test "$(sha256sum "$recovery_manual_summary" | awk '{print $1}')" = "$manual_first_summary_sha" \
        || fail manual-reentry-changed-summary
}

assert_runtime_artifacts_installed() {
    local allow_format_drift=${1:-0}
    local artifact_paths=(
        /etc/nginx/conf.d/aifeeds-performance-log.conf
        /etc/aifeeds-performance-logrotate.conf
        /usr/local/sbin/aifeeds-check-nginx-request-id
        /usr/local/sbin/aifeeds-verify-nginx-request-id-diff
        /usr/local/sbin/aifeeds-insert-nginx-request-id
        /etc/systemd/system/aifeeds-performance-logrotate.service
        /etc/systemd/system/aifeeds-performance-logrotate.timer
    )
    local artifact_keys=(format rotate checker diff_checker inserter service timer)
    local index=0
    while [ "$index" -lt "${#artifact_paths[@]}" ]; do
        test -f "${artifact_paths[$index]}" || fail "owned-artifact-missing:${artifact_keys[$index]}"
        test ! -L "${artifact_paths[$index]}" || fail "owned-artifact-symlink:${artifact_keys[$index]}"
        if [ "$allow_format_drift" -eq 1 ] && [ "${artifact_keys[$index]}" = format ]; then
            test "$(sha256sum "${artifact_paths[$index]}" | awk '{print $1}')" != \
                "$(jq -er '.format' <<< "$artifacts_sha256_json")" \
                || fail owned-format-drift-not-present
        else
            test "$(sha256sum "${artifact_paths[$index]}" | awk '{print $1}')" = \
                "$(jq -er --arg key "${artifact_keys[$index]}" '.[$key]' <<< "$artifacts_sha256_json")" \
                || fail "owned-artifact-drift:${artifact_keys[$index]}"
        fi
        index=$((index + 1))
    done
    test -s /var/log/nginx/aifeeds-performance.jsonl || fail owned-performance-log-missing
    test -s /var/lib/aifeeds-performance-logrotate/status || fail owned-rotate-state-missing
    test -e "$test_root/systemctl/timer.active" || fail owned-timer-inactive
    test -e "$test_root/systemctl/timer.enabled" || fail owned-timer-disabled
    test "$(sha256sum /etc/nginx/sites-available/aifeeds.conf | awk '{print $1}')" = \
        "$recovery_installed_sha" || fail owned-live-site-drift
    test -f "$recovery_backup" || fail owned-backup-missing
    test "$(sha256sum "$recovery_backup" | awk '{print $1}')" = "$recovery_backup_sha" \
        || fail owned-backup-drift
}

install_committed_contract() {
    rc=$(run_installer "$output")
    test "$rc" -eq 0 || fail "committed-install-rc-$rc"
    grep -Fq 'gl_a=pass ' "$output" || fail committed-install-marker
    load_manual_recovery_contract
    test "$recovery_initial_phase" = committed || fail source-not-committed
    assert_gl_a_journal_identity "$recovery_source_journal" committed
    assert_gl_a_summary_identity "$staging/gl-a-summary.json"
    install_summary_sha_before_rollback=$(sha256sum "$staging/gl-a-summary.json" | awk '{print $1}')
}

recover_and_reenter() {
    local prefix=$1 expected_resumed=${2:-}
    manual_output="$test_root/${prefix}-recovery.out"
    run_manual_rollback "$manual_output"
    test "$manual_rc" -eq 0 || fail "${prefix}-recovery-rc-$manual_rc"
    if [ -n "$expected_resumed" ]; then
        c_expected_first_resumed=$expected_resumed
        grep -Fq "manual_rollback=pass resumed=${expected_resumed}" "$manual_output" \
            || fail "${prefix}-recovery-resumed"
    fi
    capture_manual_terminal_hashes
    manual_reentry_output="$test_root/${prefix}-reentry.out"
    run_manual_rollback "$manual_reentry_output"
    test "$manual_rc" -eq 0 || fail "${prefix}-reentry-rc-$manual_rc"
    assert_manual_reentry_unchanged
}

assert_repeatable_manual_failure() {
    local prefix=$1
    local marker=$2
    local source_sha
    local rollback_sha rollback_fingerprint rollback_revision namespace_fingerprint
    source_sha=$(sha256sum "$recovery_source_journal" | awk '{print $1}')
    manual_output="$test_root/${prefix}.out"
    run_manual_rollback "$manual_output"
    test "$manual_rc" -ne 0 || fail "${prefix}-returned-zero"
    test -e "$marker" || fail "${prefix}-fault-not-hit"
    grep -Fq 'manual_rollback=failed' "$manual_output" || fail "${prefix}-failure-marker"
    ! grep -Fq 'manual_rollback=pass' "$manual_output" || fail "${prefix}-false-pass"
    test "$(sha256sum "$recovery_source_journal" | awk '{print $1}')" = "$source_sha" \
        || fail "${prefix}-source-changed"
    test -f "$recovery_rollback_journal" || fail "${prefix}-rollback-journal-missing"
    jq -e \
        --arg source "$recovery_source_journal" \
        --arg rollback_candidate "$recovery_rollback_candidate" \
        --arg audit "/var/backups/aifeeds-performance-log/audit-${recovery_transaction_id}" \
        --argjson artifacts "$artifacts_sha256_json" \
        --argjson candidates "$artifact_candidates_json" '
        .phase == "rollback_failed" and .source_origin_phase == "committed"
        and .source_journal == $source and .rollback_candidate == $rollback_candidate
        and .audit_dir == $audit and .artifacts_sha256 == $artifacts
        and .artifact_candidates == $candidates
    ' "$recovery_rollback_journal" >/dev/null \
        || fail "${prefix}-rollback-phase"
    assert_gl_a_journal_identity "$recovery_source_journal" committed
    test ! -e "$recovery_rollback_candidate" || fail "${prefix}-restore-candidate-remained"
    test ! -L "$recovery_rollback_candidate" || fail "${prefix}-restore-candidate-symlink"
    assert_artifact_candidates_absent
    test -f "$recovery_backup" || fail "${prefix}-backup-missing"
    test "$(sha256sum "$recovery_backup" | awk '{print $1}')" = "$recovery_backup_sha" \
        || fail "${prefix}-backup-changed"
    test "$(stat -c '%u %g %a' "$recovery_backup")" = \
        "$recovery_site_uid $recovery_site_gid $recovery_site_mode" \
        || fail "${prefix}-backup-metadata"
    test ! -e "$recovery_manual_summary" || fail "${prefix}-summary-created"
    assert_cas_namespace "$recovery_rollback_journal" F
    rollback_sha=$(sha256sum "$recovery_rollback_journal" | awk '{print $1}')
    rollback_fingerprint=$(file_identity_fingerprint "$recovery_rollback_journal")
    rollback_revision=$(jq -er '.journal_update.revision' "$recovery_rollback_journal")
    namespace_fingerprint=$(c_namespace_fingerprint)
    manual_reentry_output="$test_root/${prefix}-reentry.out"
    run_manual_rollback "$manual_reentry_output"
    test "$manual_rc" -ne 0 || fail "${prefix}-reentry-returned-zero"
    grep -Fq 'manual_rollback=failed' "$manual_reentry_output" \
        || fail "${prefix}-reentry-failure-marker"
    ! grep -Fq 'manual_rollback=pass' "$manual_reentry_output" \
        || fail "${prefix}-reentry-false-pass"
    test "$(sha256sum "$recovery_source_journal" | awk '{print $1}')" = "$source_sha" \
        || fail "${prefix}-reentry-source-changed"
    test "$(sha256sum "$recovery_rollback_journal" | awk '{print $1}')" = "$rollback_sha" \
        || fail "${prefix}-reentry-rollback-changed"
    assert_cas_namespace "$recovery_rollback_journal" F
    test "$(file_identity_fingerprint "$recovery_rollback_journal")" = \
        "$rollback_fingerprint" || fail "${prefix}-reentry-rollback-identity-changed"
    test "$(jq -er '.journal_update.revision' "$recovery_rollback_journal")" = \
        "$rollback_revision" || fail "${prefix}-reentry-rollback-revision-changed"
    test "$(c_namespace_fingerprint)" = "$namespace_fingerprint" \
        || fail "${prefix}-reentry-namespace-changed"
    test "$(sha256sum "$staging/gl-a-summary.json" | awk '{print $1}')" = \
        "$install_summary_sha_before_rollback" || fail "${prefix}-install-summary-changed"
}

file_identity_fingerprint() {
    local path=$1
    test -f "$path"
    test ! -L "$path"
    printf '%s:%s:%s' \
        "$(sha256sum "$path" | awk '{print $1}')" \
        "$(stat -c '%d' "$path")" \
        "$(stat -c '%i' "$path")"
}

optional_file_identity_fingerprint() {
    local path=$1
    if [ ! -e "$path" ] && [ ! -L "$path" ]; then
        printf '%s' absent
        return 0
    fi
    file_identity_fingerprint "$path"
}

assert_file_identity_fingerprint() {
    local path=$1
    local expected=$2
    local label=$3
    test -f "$path" || fail "$label-missing"
    test ! -L "$path" || fail "$label-symlink"
    test "$(file_identity_fingerprint "$path")" = "$expected" \
        || fail "$label-identity-changed"
}

assert_shape_valid_non_marker_terminal_source() {
    local source=$1 saved_target=$2 marker=$3 source_sha saved_sha marker_target
    test -f "$source" && test ! -L "$source" || fail terminal-bound-source-type
    test -f "$saved_target" && test ! -L "$saved_target" \
        || fail terminal-bound-saved-target-type
    test -f "$marker" && test ! -L "$marker" || fail terminal-bound-marker-type
    test "$(stat -c '%u %g %a %h' "$source")" = '0 0 600 1' \
        || fail terminal-bound-source-metadata
    test "$(<"$source")" = "$(jq -cS . "$source")" \
        || fail terminal-bound-source-noncanonical
    assert_gl_a_journal_identity "$source" rolled_back
    source_sha=$(sha256sum "$source" | awk '{print $1}')
    saved_sha=$(sha256sum "$saved_target" | awk '{print $1}')
    marker_target=$(jq -er '.source_target_sha256' "$marker")
    test "$saved_sha" = "$marker_target" || fail terminal-bound-saved-target-not-marker-target
    test "$source_sha" != "$marker_target" || fail terminal-bound-source-still-marker-target
    jq -e \
        --arg source_path "$source" \
        --arg rollback_path "$recovery_rollback_journal" \
        --arg marker_path "$marker" \
        --argjson source_dev "$(stat -c '%d' "$source")" \
        --argjson source_ino "$(stat -c '%i' "$source")" \
        --slurpfile valid "$saved_target" \
        --slurpfile marker "$marker" '
        ($valid[0]) as $valid |
        ($marker[0]) as $marker |
        ($marker.source_before_authority.raw_base64 | @base64d | fromjson) as $before |
        .schema == 1 and .gate == "GL-a" and .phase == "rolled_back" and
        .transaction_journal == $source_path and
        .rollback_journal == $rollback_path and
        .rollback_commit_marker == $marker_path and
        (.rollback_origin_phase | IN("mutation_started","mutated","timer_enabled","committed")) and
        .rollback_origin_phase != $valid.rollback_origin_phase and
        (keys | sort) == ($valid | keys | sort) and
        (del(.rollback_origin_phase) == ($valid | del(.rollback_origin_phase))) and
        .journal_update.self_dev == $source_dev and
        .journal_update.self_ino == $source_ino and
        .journal_update.revision == ($before.journal_update.revision + 1) and
        .journal_update.predecessor == {
            revision: $before.journal_update.revision,
            sha256: $marker.source_before_sha256,
            dev: $before.journal_update.self_dev,
            ino: $before.journal_update.self_ino
        }
    ' "$source" >/dev/null || fail terminal-bound-source-not-shape-valid
}

assert_terminal_bound_first_failure_unchanged() {
    assert_file_identity_fingerprint "$recovery_source_journal" "$bound_source_fingerprint" \
        "$scenario-source-changed-after-first-failure"
    assert_file_identity_fingerprint "$recovery_rollback_journal" "$bound_rollback_fingerprint" \
        "$scenario-rollback-changed-after-first-failure"
    assert_file_identity_fingerprint "$terminal_marker" "$bound_marker_fingerprint" \
        "$scenario-marker-changed-after-first-failure"
    test "$(optional_file_identity_fingerprint "$recovery_manual_summary")" = "$bound_summary_fingerprint" \
        || fail "$scenario-summary-changed-after-first-failure"
    test "$(c_namespace_fingerprint)" = "$bound_namespace_fingerprint" \
        || fail "$scenario-namespace-changed-after-first-failure"
}

assert_journaled_path_inode() {
    local path=$1 record=$2 dev_field=$3 ino_field=$4 label=$5 expected
    expected=$(jq -er --arg dev "$dev_field" --arg ino "$ino_field" '
        [.[$dev], .[$ino]] | if all(.[]; type == "number")
        then map(tostring) | join(" ") else error("journal inode missing") end
    ' "$record")
    test "$(stat -c '%d %i' "$path")" = "$expected" || fail "$label-journal-inode"
}

assert_terminal_marker_namespace_absent() {
    local marker="/var/backups/aifeeds-performance-log/rollback-commit-${operation_id}.json"
    for path in "$marker" "${marker}.tmp" "${marker}.previous-terminal-gl-a-${operation_id}"; do
        test ! -e "$path" && test ! -L "$path" || fail terminal-marker-namespace-present
    done
}

assert_same_bytes_distinct_inode_fingerprints() {
    local expected=$1 unknown=$2 label=$3
    test "${expected%%:*}" = "${unknown%%:*}" || fail "$label-hash-differs"
    test "${expected#*:}" != "${unknown#*:}" || fail "$label-inode-not-replaced"
}

prepare_archive_chain_inode_drift() {
    local manifest=$1
    archive_chain_authority=$(python3 - "$manifest" <<'PY'
import json
import os
import stat
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    manifest = json.load(source)
for entry in manifest["entries"]:
    for key in ("source", "quarantine", "candidate", "destination"):
        path = entry[key]
        try:
            value = os.lstat(path)
        except FileNotFoundError:
            continue
        if stat.S_ISREG(value.st_mode) and not stat.S_ISLNK(value.st_mode):
            print(path)
            raise SystemExit(0)
raise RuntimeError("archive manifest lacks a present physical authority")
PY
    ) || fail archive-chain-authority-discovery
    archive_chain_preserved="${manifest%/*}/.archive-chain-drift-gl-a-${operation_id}.preserved"
    test ! -e "$archive_chain_preserved" && test ! -L "$archive_chain_preserved" \
        || fail archive-chain-preserved-already-present
    archive_chain_expected_fingerprint=$(file_identity_fingerprint "$archive_chain_authority")
    /usr/bin/mv "$archive_chain_authority" "$archive_chain_preserved"
    /usr/bin/cp --preserve=all --reflink=never \
        "$archive_chain_preserved" "$archive_chain_authority"
    archive_chain_unknown_fingerprint=$(file_identity_fingerprint "$archive_chain_authority")
    assert_same_bytes_distinct_inode_fingerprints \
        "$archive_chain_expected_fingerprint" "$archive_chain_unknown_fingerprint" \
        archive-chain-drift
    assert_file_identity_fingerprint "$archive_chain_preserved" \
        "$archive_chain_expected_fingerprint" archive-chain-preserved
}

restore_archive_chain_inode_drift() {
    assert_file_identity_fingerprint "$archive_chain_authority" \
        "$archive_chain_unknown_fingerprint" archive-chain-unknown-before-restore
    assert_file_identity_fingerprint "$archive_chain_preserved" \
        "$archive_chain_expected_fingerprint" archive-chain-preserved-before-restore
    /usr/bin/rm -f "$archive_chain_authority"
    /usr/bin/mv "$archive_chain_preserved" "$archive_chain_authority"
    assert_file_identity_fingerprint "$archive_chain_authority" \
        "$archive_chain_expected_fingerprint" archive-chain-restored
    test ! -e "$archive_chain_preserved" && test ! -L "$archive_chain_preserved" \
        || fail archive-chain-preserved-remained
}

directory_identity_fingerprint() {
    local path=$1
    test -d "$path"
    test ! -L "$path"
    printf '%s:%s:%s:%s:%s' \
        "$(stat -c '%d' "$path")" "$(stat -c '%i' "$path")" \
        "$(stat -c '%u' "$path")" "$(stat -c '%g' "$path")" "$(stat -c '%a' "$path")"
}

assert_directory_identity_fingerprint() {
    local path=$1 expected=$2 label=$3
    test -d "$path" || fail "$label-missing"
    test ! -L "$path" || fail "$label-symlink"
    test "$(directory_identity_fingerprint "$path")" = "$expected" \
        || fail "$label-identity-changed"
}

assert_recorded_takeover_pair() {
    local label=$1 unknown_path=$2
    local preserved_path
    preserved_path=$(<"$test_root/${label}.preserved.path")
    assert_file_identity_fingerprint "$preserved_path" \
        "$(<"$test_root/${label}.expected.fingerprint")" "$label-expected"
    assert_file_identity_fingerprint "$unknown_path" \
        "$(<"$test_root/${label}.unknown.fingerprint")" "$label-unknown"
}

assert_prelive_automatic_terminal() {
    local origin_phase=$1 fault_marker=$2
    local journal manifest
    test -e "$fault_marker" || fail "prelive-fault-not-hit:${fault_marker##*/}"
    journal="/var/backups/aifeeds-performance-log/transaction-${operation_id}.json"
    test -f "$journal" || fail prelive-journal-missing
    jq -e --arg origin "$origin_phase" '
        .schema == 1 and .gate == "GL-a" and .phase == "rolled_back" and
        .rollback_origin_phase == $origin and (has("rollback_journal") | not) and
        (.log_archive_manifest_sha256 | test("^[a-f0-9]{64}$")) and
        .log_archive_manifest_generation == 1 and .log_archive_manifest_entry_count == 0' \
        "$journal" >/dev/null || fail prelive-journal-not-terminal
    manifest=$(jq -er '.log_archive_manifest' "$journal")
    test -f "$manifest" || fail prelive-manifest-missing
    jq -e --arg operation_id "$operation_id" '
        .schema == 2 and .operation_id == $operation_id and .generation == 1 and
        .inventory_complete == true and .empty_inventory == true and .entries == []' \
        "$manifest" >/dev/null || fail prelive-manifest-not-empty-terminal
    test "$(sha256sum "$manifest" | awk '{print $1}')" = \
        "$(jq -er '.log_archive_manifest_sha256' "$journal")" \
        || fail prelive-manifest-sha-mismatch
    test ! -e "$(jq -er '.installer_candidate' "$journal")" \
        || fail prelive-formal-candidate-remained
    test -z "$(find "$staging" -maxdepth 1 -name '.aifeeds.conf.build-gl-a-*' -print -quit)" \
        || fail prelive-build-candidate-remained
    grep -Fq 'automatic_rollback=pass ' "$output" || fail prelive-pass-marker-missing
    ! grep -Fq 'automatic_rollback=failed ' "$output" || fail prelive-false-failure-marker
}

kill_process_group_at_cleanup_barrier() {
    local pid=$1 marker=$2 destination=$3
    local wait_limit=${4:-200}
    local payload
    wait_for_file "$marker" "$wait_limit"
    payload=$(<"$destination")
    test -f "$payload" || fail "cleanup-payload-missing:${payload##*/}"
    test ! -L "$payload" || fail "cleanup-payload-symlink:${payload##*/}"
    assert_file_identity_fingerprint "$payload" \
        "$(<"${destination%.path}.fingerprint")" cleanup-payload-before-kill
    if [ "$scenario" = crossfs-published-crash-reentry ]; then
        assert_crossfs_published_cleanup_window "$payload" crossfs-published-before-kill
    fi
    kill -KILL -- "-$pid"
    set +e
    wait "$pid"
    rc=$?
    set -e
    test "$rc" -eq 137 || fail "cleanup-kill-rc-$rc"
}

crash_manual_at_manifest_tmp() {
    install_committed_contract
    manifest="/var/backups/aifeeds-performance-log/audit-${operation_id}/archive-manifest.json"
    manifest_tmp="${manifest}.tmp"
    manifest_previous="${manifest}.previous-gl-a-${operation_id}"
    committed_source_sha=$(sha256sum "$recovery_source_journal" | awk '{print $1}')
    manual_crash_output="$test_root/${scenario}-crash.out"
    start_manual_rollback "$manual_crash_output"
    wait_for_file "$test_root/archive-manifest-tmp-ready" 800
    test -f "$manifest" || fail "$scenario-final-missing-at-barrier"
    test -f "$manifest_tmp" || fail "$scenario-tmp-missing-at-barrier"
    test ! -e "$manifest_previous" || fail "$scenario-previous-present-at-barrier"
    test "$(jq -er '.generation' "$manifest_tmp")" -eq \
        "$(( $(jq -er '.generation' "$manifest") + 1 ))" \
        || fail "$scenario-tmp-generation-not-successor"
    test "$(jq -er '.previous_manifest_sha256' "$manifest_tmp")" = \
        "$(sha256sum "$manifest" | awk '{print $1}')" \
        || fail "$scenario-tmp-predecessor-hash"
    test "$(jq -r '[.previous_manifest_dev,.previous_manifest_ino] |
        map(tostring) | join(" ")' "$manifest_tmp")" = "$(stat -c '%d %i' "$manifest")" \
        || fail "$scenario-tmp-predecessor-inode"
    kill -KILL -- "-$manual_pid"
    set +e
    wait "$manual_pid"
    rc=$?
    set -e
    test "$rc" -eq 137 || fail "$scenario-kill-rc-$rc"
    ! grep -Fq 'manual_rollback=pass' "$manual_crash_output" \
        || fail "$scenario-crash-false-pass"
}

crash_manual_at_manifest_previous() {
    install_committed_contract
    manifest="/var/backups/aifeeds-performance-log/audit-${operation_id}/archive-manifest.json"
    manifest_tmp="${manifest}.tmp"
    manifest_previous="${manifest}.previous-gl-a-${operation_id}"
    committed_source_sha=$(sha256sum "$recovery_source_journal" | awk '{print $1}')
    manual_crash_output="$test_root/${scenario}-crash.out"
    start_manual_rollback "$manual_crash_output"
    wait_for_file "$test_root/archive-manifest-previous-ready" 800
    test -f "$manifest" || fail "$scenario-final-missing-at-barrier"
    test -f "$manifest_previous" || fail "$scenario-previous-missing-at-barrier"
    test ! -e "$manifest_tmp" || fail "$scenario-tmp-present-at-barrier"
    test "$(jq -er '.generation' "$manifest")" -eq \
        "$(( $(jq -er '.generation' "$manifest_previous") + 1 ))" \
        || fail "$scenario-final-generation-not-successor"
    test "$(jq -er '.previous_manifest_sha256' "$manifest")" = \
        "$(sha256sum "$manifest_previous" | awk '{print $1}')" \
        || fail "$scenario-final-predecessor-hash"
    test "$(jq -r '[.previous_manifest_dev,.previous_manifest_ino] |
        map(tostring) | join(" ")' "$manifest")" = "$(stat -c '%d %i' "$manifest_previous")" \
        || fail "$scenario-final-predecessor-inode"
    kill -KILL -- "-$manual_pid"
    set +e
    wait "$manual_pid"
    rc=$?
    set -e
    test "$rc" -eq 137 || fail "$scenario-kill-rc-$rc"
    ! grep -Fq 'manual_rollback=pass' "$manual_crash_output" \
        || fail "$scenario-crash-false-pass"
}

run_manifest_conflict_failure() {
    local prefix=$1
    local expected_rollback_sha=${2:-}
    manual_output="$test_root/${prefix}.out"
    run_manual_rollback "$manual_output"
    test "$manual_rc" -ne 0 || fail "$prefix-returned-zero"
    grep -Fq 'manual_rollback=failed' "$manual_output" || fail "$prefix-failure-marker"
    ! grep -Fq 'manual_rollback=pass' "$manual_output" || fail "$prefix-false-pass"
    test "$(sha256sum "$recovery_source_journal" | awk '{print $1}')" = \
        "$committed_source_sha" || fail "$prefix-source-changed"
    jq -e '.phase == "committed"' "$recovery_source_journal" >/dev/null \
        || fail "$prefix-source-phase"
    test -f "$recovery_rollback_journal" || fail "$prefix-rollback-journal-missing"
    jq -e '.phase == "rollback_failed"' "$recovery_rollback_journal" >/dev/null \
        || fail "$prefix-rollback-phase"
    if [ -n "$expected_rollback_sha" ]; then
        test "$(sha256sum "$recovery_rollback_journal" | awk '{print $1}')" = \
            "$expected_rollback_sha" || fail "$prefix-rollback-changed"
    fi
    test ! -e "$recovery_manual_summary" || fail "$prefix-summary-created"
    test ! -L "$recovery_manual_summary" || fail "$prefix-summary-symlink"
}

run_manifest_read_only_conflict_failure() {
    local prefix=$1 expected_phase=$2 expected_fingerprint=${3:-}
    manual_output="$test_root/${prefix}.out"
    run_manual_rollback "$manual_output"
    test "$manual_rc" -ne 0 || fail "$prefix-returned-zero"
    grep -Fq 'manual_rollback=failed' "$manual_output" || fail "$prefix-failure-marker"
    ! grep -Fq 'manual_rollback=pass' "$manual_output" || fail "$prefix-false-pass"
    test "$(sha256sum "$recovery_source_journal" | awk '{print $1}')" = \
        "$committed_source_sha" || fail "$prefix-source-changed"
    jq -e '.phase == "committed"' "$recovery_source_journal" >/dev/null \
        || fail "$prefix-source-phase"
    if [ "$expected_phase" = absent ]; then
        assert_cas_namespace "$recovery_rollback_journal" ""
    else
        assert_cas_namespace "$recovery_rollback_journal" F
        jq -e --arg operation_id "$operation_id" --arg expected_phase "$expected_phase" '
            .operation_id == $operation_id and .phase == $expected_phase
        ' "$recovery_rollback_journal" >/dev/null || fail "$prefix-rollback-phase"
        test -n "$expected_fingerprint" || fail "$prefix-rollback-fingerprint-missing"
        assert_file_identity_fingerprint "$recovery_rollback_journal" \
            "$expected_fingerprint" "$prefix-rollback"
    fi
    assert_terminal_marker_namespace_absent
    test ! -e "$recovery_manual_summary" && test ! -L "$recovery_manual_summary" \
        || fail "$prefix-summary-created"
}

extract_product_quiescence_python() {
    local source=$1 destination=$2
    python3 - "$source" "$destination" <<'PY'
import re
import sys

source, destination = sys.argv[1:]
with open(source, encoding="utf-8") as stream:
    text = stream.read()
matches = re.findall(
    r"wait_for_writable_inode_quiescent\(\) \{.*?<<'PY'\n(.*?)\nPY\n\}",
    text,
    flags=re.DOTALL,
)
if len(matches) != 1:
    raise SystemExit("quiescence implementation extraction failed")
with open(destination, "x", encoding="utf-8") as stream:
    stream.write(matches[0])
    stream.write("\n")
PY
    chmod 0600 "$destination"
}

rotation_ledger_generation() {
    jq -se 'last.generation' /var/lib/aifeeds-performance-logrotate/rotation-provenance.jsonl
}

exercise_rotation_authority_samebytes_takeover() {
    local target label expected_fingerprint unknown_fingerprint
    local preserved replacement unknown_evidence ledger status
    local ledger_attack_fingerprint status_attack_fingerprint tail_before generation_before
    local failed_rc generation_after
    install_committed_contract
    ledger=/var/lib/aifeeds-performance-logrotate/rotation-provenance.jsonl
    status=/var/lib/aifeeds-performance-logrotate/status
    case "$scenario" in
        rotation-config-samebytes-takeover)
            target=/etc/aifeeds-performance-logrotate.conf
            label=rotation-config
            ;;
        rotation-logrotate-samebytes-takeover)
            target=/usr/sbin/logrotate
            label=rotation-logrotate
            ;;
        rotation-anchor-samebytes-takeover)
            target="/var/backups/aifeeds-performance-log/rotation-anchor-${operation_id}.json"
            label=rotation-anchor
            ;;
        rotation-ledger-samebytes-takeover)
            target=$ledger
            label=rotation-ledger
            ;;
        *) fail rotation-takeover-scenario ;;
    esac
    if [ "$target" = "$ledger" ]; then
        preserved="/var/lib/aifeeds-performance-logrotate.preserved-a2-${operation_id}"
        replacement="/var/lib/aifeeds-performance-logrotate.replacement-a2-${operation_id}"
        unknown_evidence="/var/lib/aifeeds-performance-logrotate.unknown-a2-${operation_id}"
    else
        preserved="${target}.preserved-a2-${operation_id}"
        replacement="${target}.replacement-a2-${operation_id}"
        unknown_evidence="${target}.unknown-a2-${operation_id}"
    fi
    for path in "$preserved" "$replacement" "$unknown_evidence"; do
        test ! -e "$path" && test ! -L "$path" || fail "$label-evidence-preexists"
    done
    expected_fingerprint=$(file_identity_fingerprint "$target")
    /usr/bin/mv "$target" "$preserved"
    /usr/bin/cp --preserve=all "$preserved" "$replacement"
    /usr/bin/mv "$replacement" "$target"
    unknown_fingerprint=$(file_identity_fingerprint "$target")
    assert_same_bytes_distinct_inode_fingerprints \
        "$expected_fingerprint" "$unknown_fingerprint" "$label-takeover"
    ledger_attack_fingerprint=$(file_identity_fingerprint "$ledger")
    status_attack_fingerprint=$(file_identity_fingerprint "$status")
    tail_before=$(jq -cSse 'last' "$ledger")
    generation_before=$(rotation_ledger_generation)
    rm -f "$test_root/systemctl/service.succeeded"
    set +e
    systemctl start aifeeds-performance-logrotate.service \
        > "$test_root/${label}-service.out" 2>&1
    failed_rc=$?
    set -e
    test "$failed_rc" -ne 0 || fail "$label-service-false-pass"
    test ! -e "$test_root/systemctl/service.succeeded" || fail "$label-service-success-marker"
    assert_file_identity_fingerprint "$target" "$unknown_fingerprint" \
        "$label-unknown-preserved"
    assert_file_identity_fingerprint "$ledger" "$ledger_attack_fingerprint" \
        "$label-ledger-mutated"
    assert_file_identity_fingerprint "$status" "$status_attack_fingerprint" \
        "$label-status-mutated"
    test "$(jq -cSse 'last' "$ledger")" = "$tail_before" || fail "$label-tail-advanced"
    test "$(rotation_ledger_generation)" -eq "$generation_before" \
        || fail "$label-generation-advanced"
    test -z "$(find /var/lib/aifeeds-performance-logrotate -mindepth 1 -maxdepth 1 \
        -type d -name 'generation-*' -print -quit)" || fail "$label-workspace-created"
    /usr/bin/mv "$target" "$unknown_evidence"
    /usr/bin/mv "$preserved" "$target"
    assert_file_identity_fingerprint "$target" "$expected_fingerprint" "$label-authority-restored"
    assert_file_identity_fingerprint "$unknown_evidence" "$unknown_fingerprint" \
        "$label-unknown-evidence"
    rm -f "$test_root/systemctl/service.succeeded"
    systemctl start aifeeds-performance-logrotate.service
    test -e "$test_root/systemctl/service.succeeded" || fail "$label-recovery-service-marker"
    generation_after=$(rotation_ledger_generation)
    test "$generation_after" -eq "$((generation_before + 1))" \
        || fail "$label-recovery-generation"
    jq -se --argjson generation "$generation_after" '
        last.phase == "committed" and last.generation == $generation
    ' "$ledger" >/dev/null || fail "$label-recovery-tail"
    rc=0
}

prepare_authorized_logrotate_fault_fixture() {
    local real=/usr/sbin/logrotate.a2-real fixture_path=/tmp/gl-a-test/logrotate-authority-fixture
    test ! -e "$real" && test ! -L "$real" || fail child-fixture-real-preexists
    /usr/bin/mv /usr/sbin/logrotate "$real"
    printf '%s\n' \
        '#!/usr/bin/env bash' \
        'set -euo pipefail' \
        'if [ -e /tmp/gl-a-test/logrotate-child-evidence.enabled ]; then' \
        '  case "$0" in /proc/self/fd/[0-9]*) ;; *) exit 97 ;; esac' \
        '  test "$#" -eq 3 && test "$1" = -s' \
        '  printf "call\\n" >> /tmp/gl-a-test/logrotate-child.calls' \
        '  /usr/bin/sync -f /tmp/gl-a-test/logrotate-child.calls' \
        'fi' \
        'if [ -e /tmp/gl-a-test/logrotate-child-fault.enabled ]; then' \
        '  case "${GL_A_SCENARIO:?}" in' \
        '    rotation-child-nonzero) exit 42 ;;' \
        '    rotation-child-sigkill) kill -KILL "$$"; exit 99 ;;' \
        '    *) exit 98 ;;' \
        '  esac' \
        'fi' \
        'exec /usr/sbin/logrotate.a2-real "$@"' > "$fixture_path"
    /usr/bin/install -o root -g root -m 0755 "$fixture_path" /usr/sbin/logrotate
    test "$(stat -c '%U %G %a' /usr/sbin/logrotate)" = 'root root 755' \
        || fail child-fixture-metadata
}

exercise_rotation_child_failure() {
    local ledger=/var/lib/aifeeds-performance-logrotate/rotation-provenance.jsonl
    local status=/var/lib/aifeeds-performance-logrotate/status
    local generation_before target_generation failed_rc status_fingerprint generation_after
    generation_before=$(rotation_ledger_generation)
    target_generation=$((generation_before + 1))
    status_fingerprint=$(file_identity_fingerprint "$status")
    : > /tmp/gl-a-test/logrotate-child-evidence.enabled
    : > /tmp/gl-a-test/logrotate-child-fault.enabled
    rm -f "$test_root/systemctl/service.succeeded"
    set +e
    systemctl start aifeeds-performance-logrotate.service \
        > "$test_root/${scenario}-service.out" 2>&1
    failed_rc=$?
    set -e
    test "$failed_rc" -ne 0 || fail "$scenario-service-false-pass"
    test ! -e "$test_root/systemctl/service.succeeded" || fail "$scenario-service-success-marker"
    test "$(grep -c '^call$' /tmp/gl-a-test/logrotate-child.calls)" -eq 1 \
        || fail "$scenario-child-call-count"
    grep -Fxq 'ERROR rotation_provenance=1' "$test_root/${scenario}-service.out" \
        || fail "$scenario-generic-error"
    ! grep -Eiq 'traceback|typeerror|permissionerror' "$test_root/${scenario}-service.out" \
        || fail "$scenario-error-leak"
    assert_file_identity_fingerprint "$status" "$status_fingerprint" "$scenario-status-adopted"
    jq -se --argjson generation "$target_generation" '
        last.phase == "prepared" and last.generation == $generation and
        ([.[] | select(.generation == $generation and
          (.phase == "captured" or .phase == "committed"))] | length) == 0
    ' "$ledger" >/dev/null || fail "$scenario-ledger-tail"
    rm -f /tmp/gl-a-test/logrotate-child-fault.enabled
    systemctl start aifeeds-performance-logrotate.service \
        > "$test_root/${scenario}-recovery-service.out"
    test "$(grep -c '^call$' /tmp/gl-a-test/logrotate-child.calls)" -eq 2 \
        || fail "$scenario-recovery-child-call-count"
    generation_after=$(rotation_ledger_generation)
    test "$generation_after" -eq "$target_generation" || fail "$scenario-recovery-generation"
    jq -se --argjson generation "$target_generation" '
        last.phase == "committed" and last.generation == $generation
    ' "$ledger" >/dev/null || fail "$scenario-recovery-tail"
    rc=0
}

case "$scenario" in
    exceptional-*)
        cp -a /usr/sbin/logrotate "$test_root/logrotate.restore"
        rc=$(run_installer "$output")
        test "$rc" -ne 0 || fail exceptional-forward-false-success
        grep -Fq 'automatic_rollback=failed ' "$output" \
            || fail exceptional-forward-rollback-not-failed
        test -e "$test_root/initialized-candidate-recovery-fail-hit" \
            || fail exceptional-legacy-fault-not-hit
        unset GL_A_TEST_INITIALIZED_CANDIDATE_RECOVERY_FAIL
        /usr/bin/install -o root -g root -m 0755 "$test_root/logrotate.restore" \
            /usr/sbin/logrotate
        recovery_source_journal="/var/backups/aifeeds-performance-log/transaction-${operation_id}.json"
        recovery_rollback_journal="/var/backups/aifeeds-performance-log/rollback-transaction-${operation_id}.json"
        jq -e '.phase == "mutation_started"' "$recovery_source_journal" >/dev/null \
            || fail exceptional-source-not-mutation-started
        jq -e '.phase == "rollback_failed" and .failed_from == "prepared"' \
            "$recovery_rollback_journal" >/dev/null \
            || fail exceptional-rollback-not-prepared-failure
        recovery_backup=$(jq -er '.site_backup' "$recovery_source_journal")
        recovery_backup_sha=$(jq -er '.site_backup_sha256' "$recovery_source_journal")
        recovery_installed_sha=$(jq -er '.installed_site_sha256' "$recovery_source_journal")
        recovery_site_uid=$(jq -er '.original_site_uid' "$recovery_source_journal")
        recovery_site_gid=$(jq -er '.original_site_gid' "$recovery_source_journal")
        recovery_site_mode=$(jq -er '.original_site_mode' "$recovery_source_journal")
        recovery_source_sha=$(sha256sum "$recovery_source_journal" | awk '{print $1}')
        recovery_rollback_sha=$(sha256sum "$recovery_rollback_journal" | awk '{print $1}')
        transaction_helper_sha=$(jq -er '.rollback_helper_sha256' "$recovery_source_journal")
        test "$transaction_helper_sha" != "$rollback_helper_sha" \
            || fail exceptional-helper-sha-not-distinct
        exceptional_authority="$staging/exceptional-recovery-authority-${operation_id}.json"
        jq -ncS \
            --arg operation_id "$operation_id" --arg g0_commit "$g0_commit" \
            --arg source_journal "$recovery_source_journal" \
            --arg source_journal_sha256 "$recovery_source_sha" \
            --arg rollback_journal "$recovery_rollback_journal" \
            --arg rollback_journal_sha256 "$recovery_rollback_sha" \
            --arg transaction_helper_sha256 "$transaction_helper_sha" \
            --arg recovery_executor_sha256 "$rollback_helper_sha" \
            --arg approval_evidence_sha256 "$(printf fixture-approval | sha256sum | awk '{print $1}')" '
            {schema:1,gate:"GL-a-exceptional-recovery",phase:"authorized",
             operation_id:$operation_id,g0_commit:$g0_commit,
             source_journal:$source_journal,source_journal_sha256:$source_journal_sha256,
             rollback_journal:$rollback_journal,rollback_journal_sha256:$rollback_journal_sha256,
             transaction_helper_sha256:$transaction_helper_sha256,
             recovery_executor_sha256:$recovery_executor_sha256,
             defect:"initialized_rotation_candidate_prepublication",
             operator:"Codex",independent_rollback_owner:"roxor",
             approved_utc:"2026-07-14T00:00:00Z",
             approval_evidence_sha256:$approval_evidence_sha256}' \
            > "$exceptional_authority"
        chmod 0600 "$exceptional_authority"
        if [ "$scenario" = exceptional-recovery-initialized-candidate ]; then
            cp -a "$exceptional_authority" "${exceptional_authority}.valid"

            assert_exceptional_rejection_stable no-authority

            rewrite_exceptional_authority '.operation_id = "20260712000000-deadbeef"'
            assert_exceptional_rejection_stable wrong-operation "$exceptional_authority"
            cp -a "${exceptional_authority}.valid" "$exceptional_authority"

            rewrite_exceptional_authority '.source_journal_sha256 = ("b" * 64)'
            assert_exceptional_rejection_stable wrong-source-sha "$exceptional_authority"
            cp -a "${exceptional_authority}.valid" "$exceptional_authority"

            rewrite_exceptional_authority '.rollback_journal_sha256 = ("c" * 64)'
            assert_exceptional_rejection_stable wrong-rollback-sha "$exceptional_authority"
            cp -a "${exceptional_authority}.valid" "$exceptional_authority"

            rewrite_exceptional_authority \
                '.recovery_executor_sha256 = .transaction_helper_sha256'
            assert_exceptional_rejection_stable equal-helper-shas "$exceptional_authority"
            cp -a "${exceptional_authority}.valid" "$exceptional_authority"

            chmod 0644 "$exceptional_authority"
            assert_exceptional_rejection_stable wrong-metadata "$exceptional_authority"
            chmod 0600 "$exceptional_authority"

            mv "$exceptional_authority" "${exceptional_authority}.symlink-target"
            ln -s "${exceptional_authority}.symlink-target" "$exceptional_authority"
            assert_exceptional_rejection_stable symlink-input "$exceptional_authority"
            rm -f "$exceptional_authority"
            mv "${exceptional_authority}.symlink-target" "$exceptional_authority"

            rewrite_exceptional_authority '.unknown = true'
            assert_exceptional_rejection_stable unknown-key "$exceptional_authority"
            mv "${exceptional_authority}.valid" "$exceptional_authority"
            chmod 0600 "$exceptional_authority"
        else
            exceptional_artifact=${scenario#exceptional-}
            exceptional_artifact=${exceptional_artifact%%-*}
            exceptional_point=${scenario#exceptional-${exceptional_artifact}-}
            exceptional_point=${exceptional_point%-crash-reentry}
            export GL_A_TEST_EXCEPTIONAL_PUBLICATION_CRASH="${exceptional_artifact}:${exceptional_point}"
            manual_crash_output="$test_root/exceptional-crash.out"
            run_exceptional_rollback "$manual_crash_output" "$exceptional_authority"
            test "$manual_rc" -eq 137 || fail "exceptional-crash-rc-$manual_rc"
            test -d "/tmp/gl-a-test/exceptional-${exceptional_artifact}-${exceptional_point}-crash-hit" \
                || fail exceptional-crash-hook-not-hit
            unset GL_A_TEST_EXCEPTIONAL_PUBLICATION_CRASH
        fi

        manual_output="$test_root/exceptional-recovery.out"
        run_exceptional_rollback "$manual_output" "$exceptional_authority"
        test "$manual_rc" -eq 0 || fail "exceptional-recovery-rc-$manual_rc"
        ;;
    recovery-logrotate-installed-after-failure)
        rc=$(run_installer "$output")
        test "$rc" -ne 0 || fail recovery-logrotate-forward-false-success
        test -e "$test_root/logrotate-removed-after-preflight" \
            || fail recovery-logrotate-removal-not-injected
        ;;
    preflight-logrotate-missing)
        rm -f /usr/sbin/logrotate
        rc=$(run_installer "$output")
        ;;
    journal-source-legacy-genesis)
        exercise_source_legacy_genesis
        ;;
    journal-rollback-legacy-genesis-rejected)
        exercise_rollback_legacy_genesis_rejected
        ;;
    journal-source-g-reentry|journal-source-s1-reentry|journal-source-s2-reentry|journal-source-s3-reentry|journal-source-s4-reentry|journal-source-semantic-drift|journal-source-samebytes-predecessor|journal-source-partial-tmp|journal-source-p-only|journal-source-all-three|journal-source-unknown-cleanup)
        exercise_source_journal_cas
        ;;
    journal-rollback-g-reentry|journal-rollback-s1-reentry|journal-rollback-s2-reentry|journal-rollback-s3-reentry|journal-rollback-s4-reentry|journal-rollback-semantic-drift|journal-rollback-samebytes-predecessor|journal-rollback-partial-tmp|journal-rollback-p-only|journal-rollback-all-three|journal-rollback-unknown-cleanup)
        exercise_rollback_journal_cas
        ;;
    terminal-pair-zero-side-reentry|terminal-pair-one-side-reentry|terminal-pair-two-side-reentry|terminal-pair-pre-marker-reentry)
        exercise_terminal_pair_reentry
        ;;
    terminal-source-p-bound-target-drift|terminal-source-c-bound-target-drift)
        exercise_terminal_source_bound_cleanup_drift
        ;;
    cleanup-manual-detaching-reentry|cleanup-manual-detached-reentry|cleanup-automatic-detaching-reentry|cleanup-automatic-detached-reentry|cleanup-manual-unknown-tombstone|cleanup-automatic-unknown-tombstone|cleanup-manual-plan-drift|cleanup-automatic-plan-drift|cleanup-manual-failed-from-drift|cleanup-automatic-failed-from-drift|cleanup-manual-legacy-runtime-removed|cleanup-automatic-legacy-runtime-removed)
        exercise_runtime_cleanup_reentry
        ;;
    proc-quiescence-permission-denied)
        python3 - <<'PY'
with open("/proc/self/status", encoding="ascii") as source:
    capabilities = next(line for line in source if line.startswith("CapEff:"))
if int(capabilities.split()[1], 16) & (1 << 19):
    raise SystemExit("SYS_PTRACE unexpectedly present")
PY
        probe_target=/var/log/nginx/aifeeds-performance.no-sys-ptrace-probe
        probe_ready=/tmp/gl-a-no-sys-ptrace-writer-ready
        probe_python="$test_root/product-quiescence.py"
        probe_output="$test_root/no-sys-ptrace.out"
        probe_quarantine="${probe_target}.quarantine"
        probe_destination="/var/backups/aifeeds-performance-log/${probe_target##*/}"
        printf 'quiescence-probe\n' > "$probe_target"
        chown www-data:adm "$probe_target"
        chmod 0640 "$probe_target"
        probe_fingerprint=$(file_identity_fingerprint "$probe_target")
        extract_product_quiescence_python "$rollback_helper" "$probe_python"
        setsid /usr/sbin/runuser -u www-data -- /bin/bash -c \
            'exec 9>>"$1"; printf ready > "$2"; while :; do sleep 1; done' \
            _ "$probe_target" "$probe_ready" &
        writer_pid=$!
        wait_for_file "$probe_ready"
        grep -Fxq ready "$probe_ready" || fail proc-permission-writer-not-ready
        probe_dev=$(stat -c '%d' "$probe_target")
        probe_ino=$(stat -c '%i' "$probe_target")
        set +e
        python3 - "$probe_target" "$probe_dev" "$probe_ino" 1 \
            < "$probe_python" > "$probe_output" 2>&1
        rc=$?
        set -e
        kill -TERM -- "-$writer_pid"
        set +e
        wait "$writer_pid"
        set -e
        test "$rc" -ne 0 || fail proc-permission-returned-zero
        grep -Eq 'cannot (scan|stat|read) /proc/' "$probe_output" \
            || fail proc-permission-error-not-observed
        ! grep -Eq '(manual_rollback|automatic_rollback|gl_a)=pass' "$probe_output" \
            || fail proc-permission-false-pass
        assert_file_identity_fingerprint "$probe_target" "$probe_fingerprint" \
            proc-permission-target-moved-or-changed
        test ! -e "$probe_quarantine" && test ! -L "$probe_quarantine" \
            || fail proc-permission-quarantine-created
        test ! -e "$probe_destination" && test ! -L "$probe_destination" \
            || fail proc-permission-destination-created
        test ! -e "$staging/gl-a-summary.json" && test ! -L "$staging/gl-a-summary.json" \
            || fail proc-permission-install-summary-created
        test ! -e "$staging/gl-a-manual-rollback-summary.json" \
            && test ! -L "$staging/gl-a-manual-rollback-summary.json" \
            || fail proc-permission-rollback-summary-created
        ;;
    term)
        setsid /bin/bash "$installer" "$staging" "$operation_id" "$g0_commit" > "$output" 2>&1 &
        installer_pid=$!
        wait_for_file "$test_root/term-ready"
        kill -TERM -- "-$installer_pid"
        set +e
        wait "$installer_pid"
        rc=$?
        set -e
        test "$rc" -eq 143 || fail "term-rc-$rc"
        ;;
    concurrent-lock)
        /bin/bash "$installer" "$staging" "$operation_id" "$g0_commit" > "$output" 2>&1 &
        first_pid=$!
        wait_for_file "$test_root/concurrent-ready"
        second_output="$test_root/installer-second.out"
        second_rc=$(run_installer "$second_output")
        test "$second_rc" -eq 75 || fail "concurrent-second-rc-$second_rc"
        grep -Fxq 'ERROR deployment_lock=busy' "$second_output" || fail concurrent-lock-message
        : > "$test_root/concurrent-release"
        set +e
        wait "$first_pid"
        rc=$?
        set -e
        test "$rc" -eq 0 || fail "concurrent-first-rc-$rc"
        ;;
    rotation-config-samebytes-takeover|rotation-logrotate-samebytes-takeover|rotation-anchor-samebytes-takeover|rotation-ledger-samebytes-takeover)
        exercise_rotation_authority_samebytes_takeover
        ;;
    rotation-child-nonzero|rotation-child-sigkill)
        prepare_authorized_logrotate_fault_fixture
        install_committed_contract
        exercise_rotation_child_failure
        ;;
    manual-rollback-committed)
        rc=$(run_installer "$output")
        test "$rc" -eq 0 || fail "manual-committed-install-rc-$rc"
        grep -Fq 'gl_a=pass ' "$output" || fail manual-committed-install-marker
        load_manual_recovery_contract
        test "$recovery_initial_phase" = committed || fail manual-source-not-committed
        assert_gl_a_journal_identity "$recovery_source_journal" committed
        assert_gl_a_summary_identity "$staging/gl-a-summary.json"
        install_summary_sha_before_rollback=$(sha256sum "$staging/gl-a-summary.json" | awk '{print $1}')
        manual_output="$test_root/manual-rollback.out"
        run_manual_rollback "$manual_output"
        test "$manual_rc" -eq 0 || fail "manual-rollback-rc-$manual_rc"
        capture_manual_terminal_hashes
        manual_reentry_output="$test_root/manual-rollback-reentry.out"
        run_manual_rollback "$manual_reentry_output"
        test "$manual_rc" -eq 0 || fail "manual-rollback-reentry-rc-$manual_rc"
        assert_manual_reentry_unchanged
        ;;
    manual-recovery-prepared)
        setsid /bin/bash "$installer" "$staging" "$operation_id" "$g0_commit" > "$output" 2>&1 &
        installer_pid=$!
        wait_for_file "$test_root/prepared-barrier-ready"
        recovery_source_journal=$(find /var/backups/aifeeds-performance-log -maxdepth 1 \
            -type f -name 'transaction-*.json' -print)
        test "$(printf '%s\n' "$recovery_source_journal" | grep -c .)" -eq 1 \
            || fail prepared-source-journal-count
        jq -e '.schema == 1 and .gate == "GL-a" and .phase == "prepared"' \
            "$recovery_source_journal" >/dev/null || fail prepared-journal-phase-before-kill
        assert_gl_a_journal_identity "$recovery_source_journal" prepared
        prepared_transaction_id=${recovery_source_journal##*/transaction-}
        prepared_transaction_id=${prepared_transaction_id%.json}
        prepared_installer_candidate=$(jq -er '.installer_candidate' "$recovery_source_journal")
        prepared_rollback_candidate=$(jq -er '.rollback_candidate' "$recovery_source_journal")
        test -f "$prepared_installer_candidate" || fail prepared-installer-candidate-not-created
        test ! -L "$prepared_installer_candidate" || fail prepared-installer-candidate-symlink
        test "$(sha256sum "$prepared_installer_candidate" | awk '{print $1}')" = \
            "$(jq -er '.installed_site_sha256' "$recovery_source_journal")" \
            || fail prepared-installer-candidate-hash
        test ! -e "$prepared_rollback_candidate" || fail prepared-rollback-candidate-created
        test ! -L "$prepared_rollback_candidate" || fail prepared-rollback-candidate-symlink
        test ! -e "$(jq -er '.site_backup' "$recovery_source_journal")" \
            || fail prepared-backup-created
        assert_prepared_runtime_unmutated
        prepared_source_sha=$(sha256sum "$recovery_source_journal" | awk '{print $1}')
        kill -KILL -- "-$installer_pid"
        set +e
        wait "$installer_pid"
        rc=$?
        set -e
        test "$rc" -eq 137 || fail "prepared-kill-rc-$rc"
        assert_prepared_runtime_unmutated
        test "$(sha256sum "$recovery_source_journal" | awk '{print $1}')" = "$prepared_source_sha" \
            || fail prepared-journal-changed-after-kill
        jq -e '.phase == "prepared"' "$recovery_source_journal" >/dev/null \
            || fail prepared-journal-phase-after-kill
        load_manual_recovery_contract
        test "$recovery_initial_phase" = prepared || fail manual-source-not-prepared
        manual_output="$test_root/manual-recovery.out"
        run_manual_rollback "$manual_output"
        test "$manual_rc" -eq 0 || fail "manual-recovery-rc-$manual_rc"
        capture_manual_terminal_hashes
        manual_reentry_output="$test_root/manual-recovery-reentry.out"
        run_manual_rollback "$manual_reentry_output"
        test "$manual_rc" -eq 0 || fail "manual-recovery-reentry-rc-$manual_rc"
        assert_manual_reentry_unchanged
        ;;
    manual-recovery-initializing)
        setsid /bin/bash "$installer" "$staging" "$operation_id" "$g0_commit" > "$output" 2>&1 &
        installer_pid=$!
        wait_for_file "$test_root/initializing-barrier-ready"
        recovery_source_journal=$(find /var/backups/aifeeds-performance-log -maxdepth 1 \
            -type f -name 'transaction-*.json' -print)
        test "$(printf '%s\n' "$recovery_source_journal" | grep -c .)" -eq 1 \
            || fail initializing-source-journal-count
        assert_gl_a_journal_identity "$recovery_source_journal" initializing
        test "$(jq -er '.installed_site_sha256' "$recovery_source_journal")" = absent \
            || fail initializing-installed-site-not-absent
        initializing_candidate=$(jq -er '.installer_candidate' "$recovery_source_journal")
        initializing_backup=$(jq -er '.site_backup' "$recovery_source_journal")
        test ! -e "$initializing_candidate" || fail initializing-candidate-created
        test ! -L "$initializing_candidate" || fail initializing-candidate-symlink
        test ! -e "$initializing_backup" || fail initializing-backup-created
        test ! -L "$initializing_backup" || fail initializing-backup-symlink
        assert_prepared_runtime_unmutated
        initializing_source_sha=$(sha256sum "$recovery_source_journal" | awk '{print $1}')
        kill -KILL -- "-$installer_pid"
        set +e
        wait "$installer_pid"
        rc=$?
        set -e
        test "$rc" -eq 137 || fail "initializing-kill-rc-$rc"
        assert_prepared_runtime_unmutated
        test "$(sha256sum "$recovery_source_journal" | awk '{print $1}')" = "$initializing_source_sha" \
            || fail initializing-journal-changed-after-kill
        assert_gl_a_journal_identity "$recovery_source_journal" initializing
        test ! -e "$initializing_candidate" || fail initializing-candidate-after-kill
        test ! -e "$initializing_backup" || fail initializing-backup-after-kill
        load_manual_recovery_contract
        test "$recovery_initial_phase" = initializing || fail manual-source-not-initializing
        manual_output="$test_root/manual-initializing-recovery.out"
        run_manual_rollback "$manual_output"
        test "$manual_rc" -eq 0 || fail "manual-initializing-recovery-rc-$manual_rc"
        capture_manual_terminal_hashes
        manual_reentry_output="$test_root/manual-initializing-recovery-reentry.out"
        run_manual_rollback "$manual_reentry_output"
        test "$manual_rc" -eq 0 || fail "manual-initializing-reentry-rc-$manual_rc"
        assert_manual_reentry_unchanged
        ;;
    manual-recovery-mutation-started)
        setsid /bin/bash "$installer" "$staging" "$operation_id" "$g0_commit" > "$output" 2>&1 &
        installer_pid=$!
        wait_for_file "$test_root/mutation-started-format-ready"
        recovery_source_journal=$(find /var/backups/aifeeds-performance-log -maxdepth 1 \
            -type f -name 'transaction-*.json' -print)
        test "$(printf '%s\n' "$recovery_source_journal" | grep -c .)" -eq 1 \
            || fail mutation-started-source-journal-count
        assert_mutation_started_format_candidate_state
        mutation_started_source_sha=$(sha256sum "$recovery_source_journal" | awk '{print $1}')
        kill -KILL -- "-$installer_pid"
        set +e
        wait "$installer_pid"
        rc=$?
        set -e
        test "$rc" -eq 137 || fail "mutation-started-kill-rc-$rc"
        test "$(sha256sum "$recovery_source_journal" | awk '{print $1}')" = \
            "$mutation_started_source_sha" || fail mutation-started-journal-changed-after-kill
        assert_mutation_started_format_candidate_state
        load_manual_recovery_contract
        test "$recovery_initial_phase" = mutation_started || fail manual-source-not-mutation-started
        manual_output="$test_root/manual-mutation-started-recovery.out"
        run_manual_rollback "$manual_output"
        test "$manual_rc" -eq 0 || fail "manual-mutation-started-recovery-rc-$manual_rc"
        capture_manual_terminal_hashes
        manual_reentry_output="$test_root/manual-mutation-started-reentry.out"
        run_manual_rollback "$manual_reentry_output"
        test "$manual_rc" -eq 0 || fail "manual-mutation-started-reentry-rc-$manual_rc"
        assert_manual_reentry_unchanged
        ;;
    manual-recovery-site-swapped)
        setsid /bin/bash "$installer" "$staging" "$operation_id" "$g0_commit" > "$output" 2>&1 &
        installer_pid=$!
        wait_for_file "$test_root/site-swapped-ready"
        recovery_source_journal=$(find /var/backups/aifeeds-performance-log -maxdepth 1 \
            -type f -name 'transaction-*.json' -print)
        test "$(printf '%s\n' "$recovery_source_journal" | grep -c .)" -eq 1 \
            || fail site-swapped-source-journal-count
        assert_site_swapped_gap_state
        site_swapped_source_sha=$(sha256sum "$recovery_source_journal" | awk '{print $1}')
        kill -KILL -- "-$installer_pid"
        set +e
        wait "$installer_pid"
        rc=$?
        set -e
        test "$rc" -eq 137 || fail "site-swapped-kill-rc-$rc"
        ! grep -Fq 'gl_a=pass ' "$output" || fail site-swapped-false-pass
        test "$(sha256sum "$recovery_source_journal" | awk '{print $1}')" = \
            "$site_swapped_source_sha" || fail site-swapped-source-changed-after-kill
        assert_site_swapped_gap_state
        load_manual_recovery_contract
        test "$recovery_initial_phase" = mutation_started || fail site-swapped-origin-phase
        recover_and_reenter site-swapped
        ;;
    manual-recovery-restore-candidate)
        install_committed_contract
        : > "$test_root/restore-candidate-manual-phase-enabled"
        committed_source_sha=$(sha256sum "$recovery_source_journal" | awk '{print $1}')
        manual_crash_output="$test_root/restore-candidate-crash.out"
        start_manual_rollback "$manual_crash_output"
        wait_for_file "$test_root/restore-candidate-ready"
        assert_restore_candidate_gap_state
        restore_pre_kill_journal_sha=$(sha256sum "$recovery_rollback_journal" | awk '{print $1}')
        kill -KILL -- "-$manual_pid"
        set +e
        wait "$manual_pid"
        rc=$?
        set -e
        test "$rc" -eq 137 || fail "restore-candidate-kill-rc-$rc"
        ! grep -Fq 'manual_rollback=pass' "$manual_crash_output" \
            || fail restore-candidate-crash-false-pass
        test "$(sha256sum "$recovery_source_journal" | awk '{print $1}')" = \
            "$committed_source_sha" || fail restore-candidate-source-changed
        test "$(sha256sum "$recovery_rollback_journal" | awk '{print $1}')" = \
            "$restore_pre_kill_journal_sha" || fail restore-candidate-journal-changed
        assert_restore_candidate_gap_state
        recover_and_reenter restore-candidate
        ;;
    manual-recovery-audit-log)
        install_committed_contract
        committed_source_sha=$(sha256sum "$recovery_source_journal" | awk '{print $1}')
        manual_crash_output="$test_root/audit-log-crash.out"
        start_manual_rollback "$manual_crash_output"
        wait_for_file "$test_root/audit-log-ready" 1200
        assert_audit_log_gap_state
        audit_pre_kill_journal_sha=$(sha256sum "$recovery_rollback_journal" | awk '{print $1}')
        kill -KILL -- "-$manual_pid"
        set +e
        wait "$manual_pid"
        rc=$?
        set -e
        test "$rc" -eq 137 || fail "audit-log-kill-rc-$rc"
        ! grep -Fq 'manual_rollback=pass' "$manual_crash_output" \
            || fail audit-log-crash-false-pass
        test "$(sha256sum "$recovery_source_journal" | awk '{print $1}')" = \
            "$committed_source_sha" || fail audit-log-source-changed
        test "$(sha256sum "$recovery_rollback_journal" | awk '{print $1}')" = \
            "$audit_pre_kill_journal_sha" || fail audit-log-journal-changed
        assert_audit_log_gap_state
        recover_and_reenter audit-log
        ;;
    manual-recovery-partial-backup)
        setsid /bin/bash "$installer" "$staging" "$operation_id" "$g0_commit" > "$output" 2>&1 &
        installer_pid=$!
        wait_for_file "$test_root/partial-backup-ready"
        recovery_source_journal=$(find /var/backups/aifeeds-performance-log -maxdepth 1 \
            -type f -name 'transaction-*.json' -print)
        partial_backup=$(jq -er '.site_backup' "$recovery_source_journal")
        test -s "$partial_backup" || fail partial-backup-missing
        test "$(sha256sum "$partial_backup" | awk '{print $1}')" != \
            "$(jq -er '.site_backup_sha256' "$recovery_source_journal")" \
            || fail partial-backup-not-partial
        kill -KILL -- "-$installer_pid"
        set +e
        wait "$installer_pid"
        rc=$?
        set -e
        test "$rc" -eq 137 || fail "partial-backup-kill-rc-$rc"
        load_manual_recovery_contract
        test "$recovery_initial_phase" = prepared || fail partial-backup-origin-phase
        recover_and_reenter partial-backup
        test -f "/var/backups/aifeeds-performance-log/audit-${operation_id}/incomplete-site-backup" \
            || fail partial-backup-audit-missing
        ;;
    partial-backup-destination-takeover)
        rc=$(run_installer "$output")
        test "$rc" -ne 0 || fail partial-backup-destination-takeover-returned-zero
        test -e "$test_root/partial-backup-destination-takeover-hit" \
            || fail partial-backup-destination-takeover-not-hit
        journal="/var/backups/aifeeds-performance-log/transaction-${operation_id}.json"
        jq -e '.phase == "rollback_failed" and .site_backup_identity != null' "$journal" >/dev/null \
            || fail partial-backup-destination-journal
        takeover_backup=$(jq -er '.site_backup' "$journal")
        assert_recorded_takeover_pair partial-backup-destination "$takeover_backup"
        takeover_unknown_fingerprint=$(file_identity_fingerprint "$takeover_backup")
        takeover_preserved_path=$(<"$test_root/partial-backup-destination.preserved.path")
        takeover_expected_fingerprint=$(file_identity_fingerprint "$takeover_preserved_path")
        load_manual_recovery_contract
        manual_output="$test_root/partial-backup-destination-manual.out"
        run_manual_rollback "$manual_output"
        test "$manual_rc" -ne 0 || fail partial-backup-destination-manual-returned-zero
        assert_file_identity_fingerprint "$takeover_backup" "$takeover_unknown_fingerprint" \
            partial-backup-destination-first-unknown
        assert_file_identity_fingerprint "$takeover_preserved_path" "$takeover_expected_fingerprint" \
            partial-backup-destination-first-expected
        manual_reentry_output="$test_root/partial-backup-destination-manual-reentry.out"
        run_manual_rollback "$manual_reentry_output"
        test "$manual_rc" -ne 0 || fail partial-backup-destination-reentry-returned-zero
        assert_file_identity_fingerprint "$takeover_backup" "$takeover_unknown_fingerprint" \
            partial-backup-destination-reentry-unknown
        assert_file_identity_fingerprint "$takeover_preserved_path" "$takeover_expected_fingerprint" \
            partial-backup-destination-reentry-expected
        ;;
    installer-journal-tmp-takeover)
        rm -f "$test_root/journal-cas-crash-hit"
        export GL_A_TEST_JOURNAL_CAS_CRASH=source:initializing:t-durable
        setsid /bin/bash "$installer" "$staging" "$operation_id" "$g0_commit" > "$output" 2>&1 &
        installer_pid=$!
        assert_isolated_process_group "$installer_pid" installer-journal-tmp
        wait_for_c_crash "$installer_pid" journal-cas-crash-hit
        unset GL_A_TEST_JOURNAL_CAS_CRASH
        installer_journal="/var/backups/aifeeds-performance-log/transaction-${operation_id}.json"
        installer_journal_tmp="/var/backups/aifeeds-performance-log/transaction-${operation_id}.json.tmp"
        assert_cas_namespace "$installer_journal" T
        test -f "$installer_journal_tmp" || fail installer-journal-tmp-missing
        replace_same_bytes_inode "$installer_journal_tmp" installer-journal-tmp
        installer_valid_tmp="${installer_journal_tmp}.preserved-installer-journal-tmp"
        installer_attacker_fingerprint=$(file_identity_fingerprint "$installer_journal_tmp")
        installer_valid_fingerprint=$(file_identity_fingerprint "$installer_valid_tmp")
        run_installer_negative_twice_stable "$test_root/installer-journal-takeover-negative.out"
        assert_cas_namespace "$installer_journal" T
        assert_file_identity_fingerprint "$installer_journal_tmp" "$installer_attacker_fingerprint" \
            installer-journal-tmp-attacker
        assert_file_identity_fingerprint "$installer_valid_tmp" "$installer_valid_fingerprint" \
            installer-journal-tmp-authority
        restore_preserved_inode "$installer_journal_tmp" installer-journal-tmp
        assert_file_identity_fingerprint "$installer_journal_tmp" "$installer_valid_fingerprint" \
            installer-journal-tmp-restored
        takeover_output="$test_root/installer-journal-restored-retry.out"
        takeover_rc=$(run_installer "$takeover_output")
        test "$takeover_rc" -eq 76 \
            || fail "installer-journal-restored-retry-rc-$takeover_rc"
        grep -Fq 'ERROR recovery_required=1' "$takeover_output" \
            || fail installer-journal-restored-retry-missing-recovery-required
        ! grep -Fq 'gl_a=pass' "$takeover_output" \
            || fail installer-journal-restored-retry-false-pass
        assert_cas_namespace "$installer_journal" T
        assert_file_identity_fingerprint "$installer_journal_tmp" "$installer_valid_fingerprint" \
            installer-journal-tmp-retry-authority
        installer_valid_sha=$(sha256sum "$installer_journal_tmp" | awk '{print $1}')
        load_recovery_contract_from_record \
            "$installer_journal_tmp" "$installer_valid_sha" "$installer_valid_sha"
        rm -f "$test_root/journal-cas-crash-hit"
        export GL_A_TEST_JOURNAL_CAS_CRASH=rollback:prepared:t-durable
        manual_crash_output="$test_root/installer-journal-source-settle-crash.out"
        start_manual_rollback "$manual_crash_output"
        wait_for_c_crash "$manual_pid" journal-cas-crash-hit
        unset GL_A_TEST_JOURNAL_CAS_CRASH
        assert_cas_namespace "$installer_journal" F
        assert_cas_namespace "$recovery_rollback_journal" T
        assert_file_identity_fingerprint "$installer_journal" "$installer_valid_fingerprint" \
            installer-journal-source-settled
        installer_valid_sha=$(sha256sum "$installer_journal" | awk '{print $1}')
        load_recovery_contract_from_record \
            "$installer_journal" "$installer_valid_sha" "$installer_valid_sha"
        recover_and_reenter installer-journal-tmp 0
        rc=0
        ;;
    rollback-journal-tmp-takeover)
        install_committed_contract
        rm -f "$test_root/journal-cas-crash-hit"
        export GL_A_TEST_JOURNAL_CAS_CRASH=rollback:prepared:t-durable
        manual_crash_output="$test_root/rollback-journal-tmp-crash.out"
        start_manual_rollback "$manual_crash_output"
        wait_for_c_crash "$manual_pid" journal-cas-crash-hit
        unset GL_A_TEST_JOURNAL_CAS_CRASH
        rollback_tmp="${recovery_rollback_journal}.tmp"
        assert_cas_namespace "$recovery_rollback_journal" T
        test -f "$rollback_tmp" || fail rollback-journal-tmp-missing
        replace_same_bytes_inode "$rollback_tmp" rollback-journal-tmp
        rollback_valid_tmp="${rollback_tmp}.preserved-rollback-journal-tmp"
        rollback_attacker_fingerprint=$(file_identity_fingerprint "$rollback_tmp")
        rollback_valid_fingerprint=$(file_identity_fingerprint "$rollback_valid_tmp")
        run_c_negative_twice_stable "$test_root/rollback-journal-takeover-negative.out"
        assert_cas_namespace "$recovery_rollback_journal" T
        assert_file_identity_fingerprint "$rollback_tmp" "$rollback_attacker_fingerprint" \
            rollback-journal-tmp-attacker
        assert_file_identity_fingerprint "$rollback_valid_tmp" "$rollback_valid_fingerprint" \
            rollback-journal-tmp-authority
        restore_preserved_inode "$rollback_tmp" rollback-journal-tmp
        assert_file_identity_fingerprint "$rollback_tmp" "$rollback_valid_fingerprint" \
            rollback-journal-tmp-restored
        recover_and_reenter rollback-journal-tmp 0
        rc=0
        ;;
    systemd-missing-unit)
        install_committed_contract
        manual_output="$test_root/systemd-missing-unit.out"
        run_manual_rollback "$manual_output"
        test "$manual_rc" -eq 0 || fail "systemd-missing-unit-rc-$manual_rc"
        test ! -e /etc/systemd/system/aifeeds-performance-logrotate.timer \
            || fail systemd-missing-timer-remained
        test ! -e /etc/systemd/system/aifeeds-performance-logrotate.service \
            || fail systemd-missing-service-remained
        capture_manual_terminal_hashes
        manual_reentry_output="$test_root/systemd-missing-unit-reentry.out"
        run_manual_rollback "$manual_reentry_output"
        test "$manual_rc" -eq 0 || fail "systemd-missing-unit-reentry-rc-$manual_rc"
        assert_manual_reentry_unchanged
        ;;
    site-cas-live-drift|site-cas-candidate-drift)
        rc=$(run_installer "$output")
        test "$rc" -ne 0 || fail "$scenario-returned-zero"
        test -e "$test_root/site-${scenario#site-cas-}-injected" || fail "$scenario-not-injected"
        journal="/var/backups/aifeeds-performance-log/transaction-${operation_id}.json"
        assert_cas_namespace "$journal" F
        jq -e '.phase == "mutation_started"' "$journal" >/dev/null \
            || fail "$scenario-source-phase"
        assert_gl_a_journal_identity "$journal" mutation_started
        source_sha=$(sha256sum "$journal" | awk '{print $1}')
        source_fingerprint=$(file_identity_fingerprint "$journal")
        source_revision=$(jq -er '.journal_update.revision' "$journal")
        rollback_journal="/var/backups/aifeeds-performance-log/rollback-transaction-${operation_id}.json"
        assert_terminal_marker_namespace_absent
        forward_candidate=$(jq -er '.installer_candidate' "$journal")
        forward_displaced=$(jq -er '.rollback_candidate' "$journal")
        grep -Fq 'automatic_rollback=failed ' "$output" || fail "$scenario-failure-marker"
        ! grep -Fq 'automatic_rollback=pass' "$output" || fail "$scenario-false-pass"
        case "$scenario" in
            site-cas-live-drift)
                conflict_path=/etc/nginx/sites-available/aifeeds.conf
                grep -Fq '# concurrent live drift' "$conflict_path" \
                    || fail site-cas-live-drift-lost
                assert_journaled_path_inode "$conflict_path" "$journal" \
                    original_site_dev original_site_ino site-cas-live-drift-conflict
                test "$(sha256sum "$forward_candidate" | awk '{print $1}')" = \
                    "$(jq -er '.installed_site_sha256' "$journal")" \
                    || fail site-cas-live-forward-candidate-changed
                test ! -e "$forward_displaced" && test ! -L "$forward_displaced" \
                    || fail site-cas-live-displaced-present
                assert_cas_namespace "$rollback_journal" ""
                ;;
            site-cas-candidate-drift)
                candidate=$forward_candidate
                conflict_path=$candidate
                grep -Fq '# concurrent candidate drift' "$conflict_path" \
                    || fail site-cas-candidate-drift-lost
                cmp -s "$test_root/aifeeds.conf.original" /etc/nginx/sites-available/aifeeds.conf \
                    || fail site-cas-candidate-overwrote-live
                assert_journaled_path_inode "$conflict_path" "$journal" \
                    installer_candidate_dev installer_candidate_ino site-cas-candidate-conflict
                test ! -e "$forward_displaced" && test ! -L "$forward_displaced" \
                    || fail site-cas-candidate-displaced-present
                assert_cas_namespace "$rollback_journal" F
                jq -e --arg source "$journal" --arg source_sha "$source_sha" '
                    .phase == "rollback_failed" and .failed_from == "prepared" and
                    .source_origin_phase == "mutation_started" and
                    .source_journal == $source and .source_journal_sha256 == $source_sha
                ' "$rollback_journal" >/dev/null || fail site-cas-candidate-rollback-authority
                rollback_fingerprint=$(file_identity_fingerprint "$rollback_journal")
                rollback_revision=$(jq -er '.journal_update.revision' "$rollback_journal")
                ;;
        esac
        conflict_fingerprint=$(file_identity_fingerprint "$conflict_path")
        namespace_fingerprint=$(c_namespace_fingerprint)
        run_installer_recovery_required_twice_stable "$test_root/${scenario}-retry.out"
        assert_file_identity_fingerprint "$journal" "$source_fingerprint" \
            "$scenario-source"
        test "$(jq -er '.journal_update.revision' "$journal")" = "$source_revision" \
            || fail "$scenario-source-revision-changed"
        assert_file_identity_fingerprint "$conflict_path" "$conflict_fingerprint" \
            "$scenario-conflict"
        if [ "$scenario" = site-cas-live-drift ]; then
            assert_cas_namespace "$rollback_journal" ""
        else
            assert_file_identity_fingerprint "$rollback_journal" "$rollback_fingerprint" \
                "$scenario-rollback"
            test "$(jq -er '.journal_update.revision' "$rollback_journal")" = \
                "$rollback_revision" || fail "$scenario-rollback-revision-changed"
        fi
        test "$(c_namespace_fingerprint)" = "$namespace_fingerprint" \
            || fail "$scenario-namespace-changed"
        test ! -e "$staging/gl-a-summary.json" || fail "$scenario-summary-created"
        ;;
    site-cas-internal-displaced-drift|site-cas-internal-candidate-drift)
        rc=$(run_installer "$output")
        test "$rc" -ne 0 || fail "$scenario-returned-zero"
        test -e "$test_root/${scenario}-injected" || fail "$scenario-not-injected"
        journal="/var/backups/aifeeds-performance-log/transaction-${operation_id}.json"
        assert_cas_namespace "$journal" F
        jq -e '.phase == "mutation_started"' "$journal" >/dev/null \
            || fail "$scenario-source-phase"
        assert_gl_a_journal_identity "$journal" mutation_started
        source_sha=$(sha256sum "$journal" | awk '{print $1}')
        source_fingerprint=$(file_identity_fingerprint "$journal")
        source_revision=$(jq -er '.journal_update.revision' "$journal")
        rollback_journal="/var/backups/aifeeds-performance-log/rollback-transaction-${operation_id}.json"
        assert_terminal_marker_namespace_absent
        grep -Fq 'automatic_rollback=failed ' "$output" || fail "$scenario-failure-marker"
        ! grep -Fq 'automatic_rollback=pass ' "$output" || fail "$scenario-false-pass"
        forward_candidate=$(jq -er '.installer_candidate' "$journal")
        forward_displaced=$(jq -er '.rollback_candidate' "$journal")
        case "$scenario" in
            site-cas-internal-displaced-drift)
                conflict_path=$forward_displaced
                test ! -e /etc/nginx/sites-available/aifeeds.conf \
                    && test ! -L /etc/nginx/sites-available/aifeeds.conf \
                    || fail site-cas-internal-displaced-live-present
                grep -Fq '# internal displaced drift' "$conflict_path" \
                    || fail site-cas-internal-displaced-drift-lost
                assert_journaled_path_inode "$conflict_path" "$journal" \
                    rollback_candidate_dev rollback_candidate_ino \
                    site-cas-internal-displaced-conflict
                test "$(sha256sum "$forward_candidate" | awk '{print $1}')" = \
                    "$(jq -er '.installed_site_sha256' "$journal")" \
                    || fail site-cas-internal-displaced-candidate-changed
                assert_cas_namespace "$rollback_journal" ""
                ;;
            site-cas-internal-candidate-drift)
                conflict_path=$forward_candidate
                grep -Fq '# internal candidate drift' "$conflict_path" \
                    || fail site-cas-internal-candidate-drift-lost
                cmp -s "$test_root/aifeeds.conf.original" /etc/nginx/sites-available/aifeeds.conf \
                    || fail site-cas-internal-candidate-live-not-restored
                test ! -e "$forward_displaced" || fail "$scenario-displaced-path-remained"
                test ! -L "$forward_displaced" || fail "$scenario-displaced-path-symlink"
                assert_journaled_path_inode "$conflict_path" "$journal" \
                    installer_candidate_dev installer_candidate_ino \
                    site-cas-internal-candidate-conflict
                assert_cas_namespace "$rollback_journal" F
                jq -e --arg source "$journal" --arg source_sha "$source_sha" '
                    .phase == "rollback_failed" and .failed_from == "prepared" and
                    .source_origin_phase == "mutation_started" and
                    .source_journal == $source and .source_journal_sha256 == $source_sha
                ' "$rollback_journal" >/dev/null \
                    || fail site-cas-internal-candidate-rollback-authority
                rollback_fingerprint=$(file_identity_fingerprint "$rollback_journal")
                rollback_revision=$(jq -er '.journal_update.revision' "$rollback_journal")
                ;;
        esac
        conflict_fingerprint=$(file_identity_fingerprint "$conflict_path")
        namespace_fingerprint=$(c_namespace_fingerprint)
        run_installer_recovery_required_twice_stable "$test_root/${scenario}-retry.out"
        assert_file_identity_fingerprint "$conflict_path" "$conflict_fingerprint" \
            "$scenario-conflict"
        assert_file_identity_fingerprint "$journal" "$source_fingerprint" \
            "$scenario-source"
        test "$(jq -er '.journal_update.revision' "$journal")" = "$source_revision" \
            || fail "$scenario-source-revision-changed"
        if [ "$scenario" = site-cas-internal-displaced-drift ]; then
            assert_cas_namespace "$rollback_journal" ""
        else
            assert_file_identity_fingerprint "$rollback_journal" "$rollback_fingerprint" \
                "$scenario-rollback"
            test "$(jq -er '.journal_update.revision' "$rollback_journal")" = \
                "$rollback_revision" || fail "$scenario-rollback-revision-changed"
        fi
        test "$(c_namespace_fingerprint)" = "$namespace_fingerprint" \
            || fail "$scenario-namespace-changed"
        test ! -e "$staging/gl-a-summary.json" || fail "$scenario-summary-created"
        ;;
    manual-site-cas-internal-displaced-drift|manual-site-cas-internal-candidate-drift)
        install_committed_contract
        committed_source_sha=$(sha256sum "$recovery_source_journal" | awk '{print $1}')
        source_fingerprint=$(file_identity_fingerprint "$recovery_source_journal")
        source_revision=$(jq -er '.journal_update.revision' "$recovery_source_journal")
        assert_cas_namespace "$recovery_source_journal" F
        jq -e '.phase == "committed"' "$recovery_source_journal" >/dev/null \
            || fail "$scenario-source-phase"
        manual_output="$test_root/${scenario}.out"
        run_manual_rollback "$manual_output"
        test "$manual_rc" -ne 0 || fail "$scenario-returned-zero"
        test -e "$test_root/${scenario}-injected" || fail "$scenario-not-injected"
        grep -Fq 'manual_rollback=failed' "$manual_output" || fail "$scenario-failure-marker"
        ! grep -Fq 'manual_rollback=pass' "$manual_output" || fail "$scenario-false-pass"
        assert_terminal_marker_namespace_absent
        test "$(sha256sum "$recovery_source_journal" | awk '{print $1}')" = \
            "$committed_source_sha" || fail "$scenario-source-changed"
        case "$scenario" in
            manual-site-cas-internal-displaced-drift)
                conflict_path=$recovery_installer_candidate
                test ! -e /etc/nginx/sites-available/aifeeds.conf \
                    && test ! -L /etc/nginx/sites-available/aifeeds.conf \
                    || fail manual-site-cas-internal-displaced-live-present
                grep -Fq '# manual internal displaced drift' "$conflict_path" \
                    || fail manual-site-cas-internal-displaced-drift-lost
                assert_journaled_path_inode "$conflict_path" "$recovery_source_journal" \
                    installer_candidate_dev installer_candidate_ino \
                    manual-site-cas-internal-displaced-conflict
                test "$(sha256sum "$recovery_rollback_candidate" | awk '{print $1}')" = \
                    "$recovery_backup_sha" || fail manual-site-cas-internal-displaced-restore-changed
                jq -e --arg source "$recovery_source_journal" \
                    --arg source_sha "$committed_source_sha" '
                    .phase == "rollback_failed" and .failed_from == "prepared" and
                    .source_origin_phase == "committed" and
                    .source_journal == $source and .source_journal_sha256 == $source_sha
                ' "$recovery_rollback_journal" >/dev/null \
                    || fail manual-site-cas-internal-displaced-rollback-authority
                assert_cas_namespace "$recovery_rollback_journal" F
                ;;
            manual-site-cas-internal-candidate-drift)
                conflict_path=$recovery_rollback_candidate
                grep -Fq '# manual internal candidate drift' "$conflict_path" \
                    || fail manual-site-cas-internal-candidate-drift-lost
                assert_journaled_path_inode "$conflict_path" "$recovery_rollback_journal" \
                    rollback_candidate_dev rollback_candidate_ino \
                    manual-site-cas-internal-candidate-conflict
                test "$(sha256sum /etc/nginx/sites-available/aifeeds.conf | awk '{print $1}')" = \
                    "$recovery_installed_sha" || fail manual-site-cas-internal-candidate-live-not-restored
                test ! -e "$recovery_installer_candidate" \
                    && test ! -L "$recovery_installer_candidate" \
                    || fail manual-site-cas-internal-candidate-installer-present
                jq -e --arg source "$recovery_source_journal" \
                    --arg source_sha "$committed_source_sha" '
                    .phase == "prepared" and (has("failed_from") | not) and
                    .source_origin_phase == "committed" and
                    .source_journal == $source and .source_journal_sha256 == $source_sha
                ' "$recovery_rollback_journal" >/dev/null \
                    || fail manual-site-cas-internal-candidate-rollback-authority
                rollback_tmp="${recovery_rollback_journal}.tmp"
                rollback_before_sha=$(sha256sum "$recovery_rollback_journal" | awk '{print $1}')
                rollback_before_dev=$(stat -c '%d' "$recovery_rollback_journal")
                rollback_before_ino=$(stat -c '%i' "$recovery_rollback_journal")
                rollback_before_revision=$(jq -er '.journal_update.revision' "$recovery_rollback_journal")
                assert_cas_namespace "$recovery_rollback_journal" FT
                jq -e --arg source "$recovery_source_journal" \
                    --arg source_sha "$committed_source_sha" \
                    --arg predecessor_sha "$rollback_before_sha" \
                    --argjson predecessor_dev "$rollback_before_dev" \
                    --argjson predecessor_ino "$rollback_before_ino" \
                    --argjson predecessor_revision "$rollback_before_revision" '
                    .phase == "rollback_failed" and .failed_from == "prepared" and
                    .source_origin_phase == "committed" and
                    .source_journal == $source and .source_journal_sha256 == $source_sha and
                    .journal_update.predecessor == {
                        sha256:$predecessor_sha, dev:$predecessor_dev,
                        ino:$predecessor_ino, revision:$predecessor_revision
                    } and .journal_update.revision == $predecessor_revision + 1
                ' "$rollback_tmp" >/dev/null \
                    || fail manual-site-cas-internal-candidate-rollback-tmp-authority
                rollback_tmp_fingerprint=$(file_identity_fingerprint "$rollback_tmp")
                rollback_tmp_revision=$(jq -er '.journal_update.revision' "$rollback_tmp")
                ;;
        esac
        conflict_fingerprint=$(file_identity_fingerprint "$conflict_path")
        rollback_fingerprint=$(file_identity_fingerprint "$recovery_rollback_journal")
        rollback_revision=$(jq -er '.journal_update.revision' "$recovery_rollback_journal")
        namespace_fingerprint=$(c_namespace_fingerprint)
        run_manual_failure_twice_stable "$test_root/${scenario}-stable.out"
        assert_file_identity_fingerprint "$conflict_path" "$conflict_fingerprint" \
            "$scenario-conflict"
        assert_file_identity_fingerprint "$recovery_source_journal" "$source_fingerprint" \
            "$scenario-source"
        test "$(jq -er '.journal_update.revision' "$recovery_source_journal")" = \
            "$source_revision" || fail "$scenario-reentry-source-revision-changed"
        assert_file_identity_fingerprint "$recovery_rollback_journal" "$rollback_fingerprint" \
            "$scenario-rollback"
        test "$(jq -er '.journal_update.revision' "$recovery_rollback_journal")" = \
            "$rollback_revision" || fail "$scenario-reentry-rollback-changed"
        if [ "$scenario" = manual-site-cas-internal-candidate-drift ]; then
            assert_cas_namespace "$recovery_rollback_journal" FT
            assert_file_identity_fingerprint "$rollback_tmp" "$rollback_tmp_fingerprint" \
                "$scenario-rollback-tmp"
            test "$(jq -er '.journal_update.revision' "$rollback_tmp")" = \
                "$rollback_tmp_revision" || fail "$scenario-reentry-rollback-tmp-changed"
        fi
        test "$(c_namespace_fingerprint)" = "$namespace_fingerprint" \
            || fail "$scenario-reentry-namespace-changed"
        assert_terminal_marker_namespace_absent
        test ! -e "$recovery_manual_summary" || fail "$scenario-summary-created"
        ;;
    manual-recovery-log-writer-tail)
        install_committed_contract
        live_log=/var/log/nginx/aifeeds-performance.jsonl
        quarantine="/var/log/nginx/.aifeeds-performance.jsonl.quarantine-gl-a-${operation_id}"
        exec {writer_fd}>>"$live_log"
        manual_output="$test_root/log-writer-tail.out"
        start_manual_rollback "$manual_output" {writer_fd}>&-
        wait_for_file "$quarantine" 1200
        printf '{"marker":"TAIL"}\n' >&"$writer_fd"
        exec {writer_fd}>&-
        set +e
        wait "$manual_pid"
        manual_rc=$?
        set -e
        test "$manual_rc" -eq 0 || fail "log-writer-tail-rc-$manual_rc"
        grep -Fq '"marker":"TAIL"' \
            "/var/backups/aifeeds-performance-log/audit-${operation_id}/aifeeds-performance.jsonl" \
            || fail log-writer-tail-lost
        capture_manual_terminal_hashes
        manual_reentry_output="$test_root/log-writer-tail-reentry.out"
        run_manual_rollback "$manual_reentry_output"
        test "$manual_rc" -eq 0 || fail "log-writer-tail-reentry-rc-$manual_rc"
        assert_manual_reentry_unchanged
        ;;
    manual-recovery-log-writer-timeout)
        install_committed_contract
        live_log=/var/log/nginx/aifeeds-performance.jsonl
        quarantine="/var/log/nginx/.aifeeds-performance.jsonl.quarantine-gl-a-${operation_id}"
        exec {writer_fd}>>"$live_log"
        manual_output="$test_root/log-writer-timeout.out"
        run_manual_rollback "$manual_output"
        test "$manual_rc" -ne 0 || fail log-writer-timeout-returned-zero
        test -f "$quarantine" || fail log-writer-timeout-quarantine-lost
        test -f "/var/backups/aifeeds-performance-log/audit-${operation_id}/archive-manifest.json" \
            || fail log-writer-timeout-manifest-lost
        exec {writer_fd}>&-
        load_manual_recovery_contract
        recover_and_reenter log-writer-timeout
        ;;
    manual-recovery-terminal-pair-marker)
        install_committed_contract
        manual_crash_output="$test_root/terminal-pair-marker-crash.out"
        start_manual_rollback "$manual_crash_output"
        wait_for_file "$test_root/terminal-pair-marker-ready" 1200
        marker_tmp="/var/backups/aifeeds-performance-log/rollback-commit-${operation_id}.json.tmp"
        test -f "$marker_tmp" || fail terminal-pair-marker-tmp-missing
        test ! -e "${marker_tmp%.tmp}" || fail terminal-pair-marker-final-premature
        kill -KILL -- "-$manual_pid"
        set +e
        wait "$manual_pid"
        rc=$?
        set -e
        test "$rc" -eq 137 || fail "terminal-pair-marker-kill-rc-$rc"
        recover_and_reenter terminal-pair-marker
        ;;
    prelive-initializing-auto-rollback|prelive-initializing-validation-fail)
        rc=$(run_installer "$output")
        test "$rc" -ne 0 || fail "$scenario-returned-zero"
        case "$scenario" in
            prelive-initializing-auto-rollback)
                fault_marker="$test_root/prelive-initializing-failure-hit"
                ;;
            *) fault_marker="$test_root/prelive-initializing-validation-failure-hit" ;;
        esac
        assert_prelive_automatic_terminal initializing "$fault_marker"
        ;;
    prelive-prepared-auto-rollback)
        rc=$(run_installer "$output")
        test "$rc" -ne 0 || fail prelive-prepared-returned-zero
        assert_prelive_automatic_terminal prepared \
            "$test_root/prelive-prepared-failure-hit"
        ;;
    artifact-install-destination-takeover)
        rc=$(run_installer "$output")
        test "$rc" -ne 0 || fail artifact-install-destination-takeover-returned-zero
        journal="/var/backups/aifeeds-performance-log/transaction-${operation_id}.json"
        rollback_journal="/var/backups/aifeeds-performance-log/rollback-transaction-${operation_id}.json"
        jq -e '.phase == "mutation_started"' "$journal" >/dev/null \
            || fail artifact-install-destination-source-not-mutation-started
        assert_cas_namespace "$journal" F
        assert_cas_namespace "$rollback_journal" ''
        candidate=$(jq -er '.artifact_candidates.format' "$journal")
        destination=/etc/nginx/conf.d/aifeeds-performance-log.conf
        test -e "$test_root/artifact-install-destination-takeover-hit" \
            || fail artifact-destination-takeover-not-hit
        assert_file_identity_fingerprint "$candidate" \
            "$(<"$test_root/artifact-install-destination.candidate.fingerprint")" \
            artifact-destination-candidate
        assert_file_identity_fingerprint "$destination" \
            "$(<"$test_root/artifact-install-destination.unknown.fingerprint")" \
            artifact-destination-unknown
        artifact_destination_source_fingerprint=$(file_identity_fingerprint "$journal")
        artifact_destination_candidate_fingerprint=$(file_identity_fingerprint "$candidate")
        artifact_destination_unknown_fingerprint=$(file_identity_fingerprint "$destination")
        retry_output="$test_root/artifact-install-destination-takeover-retry.out"
        retry_rc=$(run_installer "$retry_output")
        test "$retry_rc" -eq 76 || fail "artifact-install-destination-retry-rc-$retry_rc"
        assert_cas_namespace "$journal" F
        assert_cas_namespace "$rollback_journal" ''
        assert_file_identity_fingerprint "$journal" "$artifact_destination_source_fingerprint" \
            artifact-destination-retry-source
        assert_file_identity_fingerprint "$candidate" "$artifact_destination_candidate_fingerprint" \
            artifact-destination-retry-candidate
        assert_file_identity_fingerprint "$destination" "$artifact_destination_unknown_fingerprint" \
            artifact-destination-retry-unknown
        ;;
    artifact-install-candidate-takeover|artifact-install-candidate-samebytes)
        rc=$(run_installer "$output")
        test "$rc" -ne 0 || fail "$scenario-returned-zero"
        journal="/var/backups/aifeeds-performance-log/transaction-${operation_id}.json"
        rollback_journal="/var/backups/aifeeds-performance-log/rollback-transaction-${operation_id}.json"
        jq -e '.phase == "mutation_started"' "$journal" >/dev/null \
            || fail "$scenario-source-not-mutation-started"
        jq -e '.phase == "rollback_failed" and .failed_from == "prepared" and
            (.runtime_cleanup | not)' "$rollback_journal" >/dev/null \
            || fail "$scenario-rollback-not-failed"
        artifact_source_fingerprint=$(file_identity_fingerprint "$journal")
        artifact_rollback_fingerprint=$(file_identity_fingerprint "$rollback_journal")
        case "$scenario" in
            artifact-install-candidate-takeover)
                candidate=$(jq -er '.artifact_candidates.format' "$journal")
                test -e "$test_root/artifact-install-candidate-takeover-hit" \
                    || fail artifact-candidate-takeover-not-hit
                assert_recorded_takeover_pair artifact-install-candidate "$candidate"
                test "$(stat -c '%u %g %a' "$candidate")" = '0 0 600' \
                    || fail artifact-candidate-not-private-ambiguous
                ;;
            artifact-install-candidate-samebytes)
                candidate=$(jq -er '.artifact_candidates.format' "$journal")
                test -e "$test_root/artifact-install-candidate-samebytes-hit" \
                    || fail artifact-candidate-samebytes-not-hit
                assert_recorded_takeover_pair artifact-install-candidate-samebytes "$candidate"
                expected_fingerprint=$(<"$test_root/artifact-install-candidate-samebytes.expected.fingerprint")
                unknown_fingerprint=$(<"$test_root/artifact-install-candidate-samebytes.unknown.fingerprint")
                test "${expected_fingerprint%%:*}" = "${unknown_fingerprint%%:*}" \
                    || fail artifact-candidate-samebytes-hash-drift
                test "${expected_fingerprint#*:}" != "${unknown_fingerprint#*:}" \
                    || fail artifact-candidate-samebytes-identity-not-changed
                ;;
        esac
        retry_output="$test_root/${scenario}-retry.out"
        retry_rc=$(run_installer "$retry_output")
        test "$retry_rc" -eq 76 || fail "$scenario-retry-rc-$retry_rc"
        assert_file_identity_fingerprint "$journal" "$artifact_source_fingerprint" \
            "$scenario-retry-source"
        assert_file_identity_fingerprint "$rollback_journal" "$artifact_rollback_fingerprint" \
            "$scenario-retry-rollback"
        case "$scenario" in
            artifact-install-candidate-takeover)
                assert_recorded_takeover_pair artifact-install-candidate "$candidate"
                test "$(stat -c '%u %g %a' "$candidate")" = '0 0 600' \
                    || fail artifact-candidate-reentry-not-private-ambiguous
                ;;
            artifact-install-candidate-samebytes)
                assert_recorded_takeover_pair artifact-install-candidate-samebytes "$candidate"
                ;;
        esac
        ;;
    rotation-directory-candidate-takeover)
        rc=$(run_installer "$output")
        test "$rc" -ne 0 || fail rotation-directory-candidate-returned-zero
        test -e "$test_root/rotation-directory-candidate-takeover-hit" \
            || fail rotation-directory-candidate-not-hit
        source_journal="/var/backups/aifeeds-performance-log/transaction-${operation_id}.json"
        rollback_journal="/var/backups/aifeeds-performance-log/rollback-transaction-${operation_id}.json"
        jq -e '.phase == "mutation_started" and .rotation_state_identity != null' \
            "$source_journal" >/dev/null || fail rotation-directory-candidate-source-journal
        jq -e '.phase == "rollback_failed" and .failed_from == "prepared" and
            (.runtime_cleanup // null) == null' "$rollback_journal" >/dev/null \
            || fail rotation-directory-candidate-rollback-journal
        assert_cas_namespace "$source_journal" F
        assert_cas_namespace "$rollback_journal" F
        rotation_candidate=$(jq -er '.rotation_state_identity.directory.candidate' "$source_journal")
        rotation_preserved=$(<"$test_root/rotation-directory-candidate.preserved.path")
        assert_directory_identity_fingerprint "$rotation_candidate" \
            "$(<"$test_root/rotation-directory-candidate.unknown.fingerprint")" \
            rotation-directory-candidate-unknown
        assert_directory_identity_fingerprint "$rotation_preserved" \
            "$(<"$test_root/rotation-directory-candidate.expected.fingerprint")" \
            rotation-directory-candidate-expected
        test -f "$rotation_candidate/unknown" || fail rotation-directory-unknown-file-missing
        rotation_preserved_file="$rotation_preserved/rotation-provenance.jsonl"
        test -f "$rotation_preserved_file" || fail rotation-directory-preserved-file-missing
        rotation_source_fingerprint=$(file_identity_fingerprint "$source_journal")
        rotation_rollback_fingerprint=$(file_identity_fingerprint "$rollback_journal")
        rotation_candidate_fingerprint=$(directory_identity_fingerprint "$rotation_candidate")
        rotation_preserved_fingerprint=$(directory_identity_fingerprint "$rotation_preserved")
        rotation_unknown_file_fingerprint=$(file_identity_fingerprint "$rotation_candidate/unknown")
        rotation_preserved_file_fingerprint=$(file_identity_fingerprint "$rotation_preserved_file")
        retry_output="$test_root/rotation-directory-candidate-retry.out"
        retry_rc=$(run_installer "$retry_output")
        test "$retry_rc" -eq 76 || fail "rotation-directory-candidate-retry-rc-$retry_rc"
        assert_file_identity_fingerprint "$source_journal" "$rotation_source_fingerprint" \
            rotation-directory-retry-source
        assert_file_identity_fingerprint "$rollback_journal" "$rotation_rollback_fingerprint" \
            rotation-directory-retry-rollback
        assert_directory_identity_fingerprint "$rotation_candidate" "$rotation_candidate_fingerprint" \
            rotation-directory-retry-unknown-dir
        assert_directory_identity_fingerprint "$rotation_preserved" "$rotation_preserved_fingerprint" \
            rotation-directory-retry-preserved-dir
        assert_file_identity_fingerprint "$rotation_candidate/unknown" \
            "$rotation_unknown_file_fingerprint" rotation-directory-retry-unknown-file
        assert_file_identity_fingerprint "$rotation_preserved_file" \
            "$rotation_preserved_file_fingerprint" rotation-directory-retry-preserved-file
        ;;
    archive-manifest-previous-unknown-only)
        install_committed_contract
        committed_source_sha=$(sha256sum "$recovery_source_journal" | awk '{print $1}')
        audit_dir="/var/backups/aifeeds-performance-log/audit-${operation_id}"
        manifest_previous="${audit_dir}/archive-manifest.json.previous-gl-a-${operation_id}"
        install -d -o root -g root -m 0700 "$audit_dir"
        printf '{"unknown_manifest_predecessor":true}\n' > "$manifest_previous"
        chown root:root "$manifest_previous"
        chmod 0600 "$manifest_previous"
        previous_fingerprint=$(file_identity_fingerprint "$manifest_previous")
        run_manifest_read_only_conflict_failure \
            archive-manifest-previous-unknown-only absent
        assert_file_identity_fingerprint "$manifest_previous" "$previous_fingerprint" \
            previous-unknown-only
        run_manifest_read_only_conflict_failure \
            archive-manifest-previous-unknown-only-reentry absent
        assert_file_identity_fingerprint "$manifest_previous" "$previous_fingerprint" \
            previous-unknown-only-reentry
        ;;
    archive-manifest-previous-valid-only)
        install_committed_contract
        committed_source_sha=$(sha256sum "$recovery_source_journal" | awk '{print $1}')
        audit_dir="/var/backups/aifeeds-performance-log/audit-${operation_id}"
        manifest_previous="${audit_dir}/archive-manifest.json.previous-gl-a-${operation_id}"
        install -d -o root -g root -m 0700 "$audit_dir"
        jq -nc --arg operation_id "$operation_id" \
            '{schema:2,operation_id:$operation_id,generation:0,previous_manifest_sha256:null,
              previous_manifest_dev:null,previous_manifest_ino:null,
              inventory_complete:false,empty_inventory:false,entries:[]}' \
            > "$manifest_previous"
        chown root:root "$manifest_previous"
        chmod 0600 "$manifest_previous"
        previous_fingerprint=$(file_identity_fingerprint "$manifest_previous")
        run_manifest_read_only_conflict_failure \
            archive-manifest-previous-valid-only absent
        assert_file_identity_fingerprint "$manifest_previous" "$previous_fingerprint" \
            previous-valid-only
        run_manifest_read_only_conflict_failure \
            archive-manifest-previous-valid-only-reentry absent
        assert_file_identity_fingerprint "$manifest_previous" "$previous_fingerprint" \
            previous-valid-only-reentry
        ;;
    archive-manifest-previous-restart-samebytes)
        crash_manual_at_manifest_tmp
        /usr/bin/mv "$manifest" "$manifest_previous"
        expected_fingerprint=$(file_identity_fingerprint "$manifest_previous")
        test "$(jq -er '.previous_manifest_sha256' "$manifest_tmp")" = \
            "${expected_fingerprint%%:*}" || fail previous-restart-persisted-hash
        test "$(jq -r '[.previous_manifest_dev,.previous_manifest_ino] |
            map(tostring) | join(":")' "$manifest_tmp")" = "${expected_fingerprint#*:}" \
            || fail previous-restart-persisted-inode
        preserved="${manifest_previous}.preserved-gl-a-test-restart"
        /usr/bin/mv "$manifest_previous" "$preserved"
        /usr/bin/cp "$preserved" "$manifest_previous"
        chown root:root "$manifest_previous"
        chmod 0600 "$manifest_previous"
        unknown_fingerprint=$(file_identity_fingerprint "$manifest_previous")
        tmp_fingerprint=$(file_identity_fingerprint "$manifest_tmp")
        previous_restart_rollback_fingerprint=$(
            file_identity_fingerprint "$recovery_rollback_journal"
        )
        assert_same_bytes_distinct_inode_fingerprints "$expected_fingerprint" \
            "$unknown_fingerprint" previous-restart-samebytes
        run_manifest_read_only_conflict_failure archive-manifest-previous-restart-samebytes nginx_reloaded \
            "$previous_restart_rollback_fingerprint"
        assert_file_identity_fingerprint "$manifest_previous" "$unknown_fingerprint" \
            previous-restart-unknown
        assert_file_identity_fingerprint "$preserved" "$expected_fingerprint" \
            previous-restart-expected
        assert_file_identity_fingerprint "$manifest_tmp" "$tmp_fingerprint" previous-restart-tmp
        run_manifest_read_only_conflict_failure archive-manifest-previous-restart-samebytes-reentry nginx_reloaded \
            "$previous_restart_rollback_fingerprint"
        assert_file_identity_fingerprint "$manifest_previous" "$unknown_fingerprint" \
            previous-restart-reentry-unknown
        assert_file_identity_fingerprint "$preserved" "$expected_fingerprint" \
            previous-restart-reentry-expected
        assert_file_identity_fingerprint "$manifest_tmp" "$tmp_fingerprint" \
            previous-restart-reentry-tmp
        ;;
    archive-manifest-previous-internal-drift)
        crash_manual_at_manifest_tmp
        /usr/bin/mv "$manifest" "$manifest_previous"
        expected_before=$(file_identity_fingerprint "$manifest_previous")
        test "$(jq -r '[.previous_manifest_dev,.previous_manifest_ino] |
            map(tostring) | join(":")' "$manifest_tmp")" = "${expected_before#*:}" \
            || fail previous-internal-persisted-inode
        : > "$test_root/archive-manifest-previous-internal-drift-armed"
        run_manifest_conflict_failure archive-manifest-previous-internal-drift
        test -e "$test_root/archive-manifest-previous-internal-drift-hit" \
            || fail previous-internal-drift-not-hit
        assert_recorded_takeover_pair archive-manifest-previous-internal "$manifest_previous"
        conflict_rollback_sha=$(sha256sum "$recovery_rollback_journal" | awk '{print $1}')
        run_manifest_conflict_failure archive-manifest-previous-internal-drift-reentry \
            "$conflict_rollback_sha"
        assert_recorded_takeover_pair archive-manifest-previous-internal "$manifest_previous"
        ;;
    preflight-journal-find-error|preflight-include-grep-error)
        rc=$(run_installer "$output")
        test "$rc" -ne 0 || fail "$scenario-returned-zero"
        test -e "$test_root/${scenario}-hit" || fail "$scenario-not-hit"
        test -z "$(find /var/backups/aifeeds-performance-log -maxdepth 1 \
            -type f -name 'transaction-*.json*' -print 2>/dev/null || true)" \
            || fail "$scenario-created-journal"
        assert_prepared_runtime_unmutated
        ;;
    archive-manifest-tmp-takeover)
        install_committed_contract
        manual_crash_output="$test_root/archive-manifest-tmp-crash.out"
        start_manual_rollback "$manual_crash_output"
        wait_for_file "$test_root/archive-manifest-tmp-ready" 800
        manifest="/var/backups/aifeeds-performance-log/audit-${operation_id}/archive-manifest.json"
        test -f "$manifest" || fail archive-manifest-final-missing
        test -f "${manifest}.tmp" || fail archive-manifest-tmp-missing
        kill -KILL -- "-$manual_pid"
        set +e
        wait "$manual_pid"
        rc=$?
        set -e
        test "$rc" -eq 137 || fail "archive-manifest-tmp-kill-rc-$rc"
        manifest_hardlink="${manifest}.tmp.hardlink-gl-a-${operation_id}"
        /usr/bin/ln "${manifest}.tmp" "$manifest_hardlink"
        test "$(stat -c '%h' "${manifest}.tmp")" -eq 2 \
            || fail archive-manifest-tmp-hardlink-count
        test "$(stat -c '%d %i' "${manifest}.tmp")" = \
            "$(stat -c '%d %i' "$manifest_hardlink")" \
            || fail archive-manifest-tmp-hardlink-identity
        run_c_negative_twice_stable "$test_root/archive-manifest-tmp-hardlink-negative.out"
        test "$(stat -c '%h' "${manifest}.tmp")" -eq 2 \
            || fail archive-manifest-tmp-hardlink-count-after-failures
        /usr/bin/rm -f "$manifest_hardlink"
        test "$(stat -c '%h' "${manifest}.tmp")" -eq 1 \
            || fail archive-manifest-tmp-hardlink-count-after-restore
        recover_and_reenter archive-manifest-tmp
        ;;
    archive-manifest-stale-tmp)
        crash_manual_at_manifest_tmp
        /usr/bin/cp -f "$manifest" "$manifest_tmp"
        chown root:root "$manifest_tmp"
        chmod 0600 "$manifest_tmp"
        /usr/bin/sync -f "$manifest_tmp"
        test "$(jq -er '.generation' "$manifest_tmp")" -eq \
            "$(jq -er '.generation' "$manifest")" || fail stale-tmp-generation
        final_fingerprint=$(file_identity_fingerprint "$manifest")
        tmp_fingerprint=$(file_identity_fingerprint "$manifest_tmp")
        stale_rollback_fingerprint=$(file_identity_fingerprint "$recovery_rollback_journal")
        run_manifest_read_only_conflict_failure archive-manifest-stale-tmp nginx_reloaded \
            "$stale_rollback_fingerprint"
        assert_file_identity_fingerprint "$manifest" "$final_fingerprint" stale-tmp-final
        assert_file_identity_fingerprint "$manifest_tmp" "$tmp_fingerprint" stale-tmp-tmp
        run_manifest_read_only_conflict_failure archive-manifest-stale-tmp-reentry nginx_reloaded \
            "$stale_rollback_fingerprint"
        assert_file_identity_fingerprint "$manifest" "$final_fingerprint" stale-tmp-reentry-final
        assert_file_identity_fingerprint "$manifest_tmp" "$tmp_fingerprint" stale-tmp-reentry-tmp
        ;;
    archive-manifest-regressive-tmp)
        crash_manual_at_manifest_tmp
        final_generation=$(jq -er '.generation' "$manifest")
        regressive_generation=$((final_generation - 1))
        test "$regressive_generation" -gt 0 || fail regressive-tmp-generation-precondition
        jq --argjson generation "$regressive_generation" \
            '.generation = $generation' "$manifest_tmp" \
            > "$test_root/archive-manifest-regressive.json"
        /usr/bin/install -o root -g root -m 0600 \
            "$test_root/archive-manifest-regressive.json" "$manifest_tmp"
        /usr/bin/sync -f "$manifest_tmp"
        test "$(jq -er '.generation' "$manifest_tmp")" -lt "$final_generation" \
            || fail regressive-tmp-not-regressive
        final_fingerprint=$(file_identity_fingerprint "$manifest")
        tmp_fingerprint=$(file_identity_fingerprint "$manifest_tmp")
        regressive_rollback_fingerprint=$(file_identity_fingerprint "$recovery_rollback_journal")
        run_manifest_read_only_conflict_failure archive-manifest-regressive-tmp nginx_reloaded \
            "$regressive_rollback_fingerprint"
        assert_file_identity_fingerprint "$manifest" "$final_fingerprint" regressive-tmp-final
        assert_file_identity_fingerprint "$manifest_tmp" "$tmp_fingerprint" regressive-tmp-tmp
        run_manifest_read_only_conflict_failure archive-manifest-regressive-tmp-reentry nginx_reloaded \
            "$regressive_rollback_fingerprint"
        assert_file_identity_fingerprint "$manifest" "$final_fingerprint" regressive-tmp-reentry-final
        assert_file_identity_fingerprint "$manifest_tmp" "$tmp_fingerprint" regressive-tmp-reentry-tmp
        ;;
    archive-manifest-unknown-final)
        crash_manual_at_manifest_tmp
        unknown_final_entry_count=$(jq -er '.entries | length' "$manifest")
        test "$unknown_final_entry_count" -gt 0 || fail unknown-final-empty-source
        jq --arg impossible_previous \
            '0000000000000000000000000000000000000000000000000000000000000000' \
            '.generation = 99 | .previous_manifest_sha256 = $impossible_previous' "$manifest" \
            > "$test_root/archive-manifest-unknown-final.json"
        /usr/bin/install -o root -g root -m 0600 \
            "$test_root/archive-manifest-unknown-final.json" "$manifest"
        /usr/bin/sync -f "$manifest"
        jq -e --arg operation_id "$operation_id" \
            --argjson entry_count "$unknown_final_entry_count" '
            .schema == 2 and .operation_id == $operation_id and .generation == 99 and
            .inventory_complete == true and .empty_inventory == false and
            (.entries | length) == $entry_count and
            (.previous_manifest_sha256 | test("^[a-f0-9]{64}$")) and
            (.previous_manifest_dev | type == "number" and . > 0) and
            (.previous_manifest_ino | type == "number" and . > 0) and
            (keys | sort) == ["empty_inventory","entries","generation","inventory_complete",
                              "operation_id","previous_manifest_dev","previous_manifest_ino",
                              "previous_manifest_sha256","schema"]' \
            "$manifest" >/dev/null || fail unknown-final-shape
        final_fingerprint=$(file_identity_fingerprint "$manifest")
        tmp_fingerprint=$(file_identity_fingerprint "$manifest_tmp")
        unknown_rollback_fingerprint=$(file_identity_fingerprint "$recovery_rollback_journal")
        run_manifest_read_only_conflict_failure archive-manifest-unknown-final nginx_reloaded \
            "$unknown_rollback_fingerprint"
        assert_file_identity_fingerprint "$manifest" "$final_fingerprint" unknown-final-final
        assert_file_identity_fingerprint "$manifest_tmp" "$tmp_fingerprint" unknown-final-tmp
        run_manifest_read_only_conflict_failure archive-manifest-unknown-final-reentry nginx_reloaded \
            "$unknown_rollback_fingerprint"
        assert_file_identity_fingerprint "$manifest" "$final_fingerprint" unknown-final-reentry-final
        assert_file_identity_fingerprint "$manifest_tmp" "$tmp_fingerprint" unknown-final-reentry-tmp
        ;;
    archive-manifest-orphan-audit)
        crash_manual_at_manifest_tmp
        orphan_audit="${manifest%/*}/aifeeds-performance.jsonl.999"
        printf '{"orphan_audit":"preserve"}\n' > "$test_root/orphan-audit.jsonl"
        /usr/bin/install -o root -g root -m 0600 "$test_root/orphan-audit.jsonl" "$orphan_audit"
        /usr/bin/sync -f "$orphan_audit"
        orphan_fingerprint=$(file_identity_fingerprint "$orphan_audit")
        run_manifest_conflict_failure archive-manifest-orphan-audit
        assert_file_identity_fingerprint "$orphan_audit" "$orphan_fingerprint" orphan-audit
        run_manifest_conflict_failure archive-manifest-orphan-audit-reentry
        assert_file_identity_fingerprint "$orphan_audit" "$orphan_fingerprint" orphan-audit-reentry
        ;;
    archive-manifest-previous-takeover)
        crash_manual_at_manifest_previous
        previous_fingerprint=$(file_identity_fingerprint "$manifest_previous")
        final_fingerprint=$(file_identity_fingerprint "$manifest")
        recover_and_reenter archive-manifest-previous-takeover
        test ! -e "$manifest_previous" || fail previous-takeover-previous-remained
        test ! -L "$manifest_previous" || fail previous-takeover-previous-symlink
        test "$(file_identity_fingerprint "$manifest")" != "$final_fingerprint" \
            || fail previous-takeover-final-did-not-progress
        test -n "$previous_fingerprint" || fail previous-takeover-fingerprint-empty
        ;;
    archive-manifest-three-way-conflict)
        crash_manual_at_manifest_previous
        /usr/bin/install -o root -g root -m 0600 "$manifest" "$manifest_tmp"
        /usr/bin/sync -f "$manifest_tmp"
        previous_fingerprint=$(file_identity_fingerprint "$manifest_previous")
        final_fingerprint=$(file_identity_fingerprint "$manifest")
        tmp_fingerprint=$(file_identity_fingerprint "$manifest_tmp")
        three_way_rollback_fingerprint=$(file_identity_fingerprint "$recovery_rollback_journal")
        run_manifest_read_only_conflict_failure archive-manifest-three-way-conflict nginx_reloaded \
            "$three_way_rollback_fingerprint"
        assert_file_identity_fingerprint "$manifest_previous" "$previous_fingerprint" three-way-previous
        assert_file_identity_fingerprint "$manifest" "$final_fingerprint" three-way-final
        assert_file_identity_fingerprint "$manifest_tmp" "$tmp_fingerprint" three-way-tmp
        run_manifest_read_only_conflict_failure archive-manifest-three-way-conflict-reentry nginx_reloaded \
            "$three_way_rollback_fingerprint"
        assert_file_identity_fingerprint "$manifest_previous" "$previous_fingerprint" three-way-reentry-previous
        assert_file_identity_fingerprint "$manifest" "$final_fingerprint" three-way-reentry-final
        assert_file_identity_fingerprint "$manifest_tmp" "$tmp_fingerprint" three-way-reentry-tmp
        ;;
    log-quarantine-delete-takeover)
        install_committed_contract
        manual_output="$test_root/log-quarantine-delete-takeover.out"
        run_manual_rollback "$manual_output"
        test "$manual_rc" -ne 0 || fail log-quarantine-delete-takeover-returned-zero
        test -e "$test_root/log-quarantine-delete-takeover-hit" \
            || fail log-quarantine-delete-takeover-not-hit
        recorded_unknown_fingerprint=$(<"$test_root/log-quarantine-delete-takeover.unknown.fingerprint")
        canonical_quarantines=(/var/log/nginx/.aifeeds-performance.jsonl*.quarantine-gl-a-${operation_id})
        canonical_match_count=0
        unknown_path=''
        for quarantine_candidate in "${canonical_quarantines[@]}"; do
            test -f "$quarantine_candidate" && test ! -L "$quarantine_candidate" || continue
            if [ "$(file_identity_fingerprint "$quarantine_candidate")" = \
                "$recorded_unknown_fingerprint" ]; then
                canonical_match_count=$((canonical_match_count + 1))
                unknown_path=$quarantine_candidate
            fi
        done
        test "$canonical_match_count" -eq 1 || fail log-quarantine-canonical-match-count
        assert_recorded_takeover_pair log-quarantine-delete-takeover "$unknown_path"
        assert_cas_namespace "$recovery_source_journal" F
        assert_cas_namespace "$recovery_rollback_journal" F
        jq -e '.phase == "committed"' "$recovery_source_journal" >/dev/null \
            || fail log-quarantine-source-phase
        jq -e '.phase == "rollback_failed" and .failed_from == "nginx_reloaded" and
            .runtime_cleanup.cursor == 14 and .runtime_cleanup.cursor_state == "complete"' \
            "$recovery_rollback_journal" >/dev/null || fail log-quarantine-rollback-phase
        log_quarantine_preserved=$(<"$test_root/log-quarantine-delete-takeover.preserved.path")
        log_quarantine_source_fingerprint=$(file_identity_fingerprint "$recovery_source_journal")
        log_quarantine_rollback_fingerprint=$(file_identity_fingerprint "$recovery_rollback_journal")
        log_quarantine_unknown_fingerprint=$(file_identity_fingerprint "$unknown_path")
        log_quarantine_expected_fingerprint=$(file_identity_fingerprint "$log_quarantine_preserved")
        manual_reentry_output="$test_root/log-quarantine-delete-takeover-reentry.out"
        run_manual_rollback "$manual_reentry_output"
        test "$manual_rc" -ne 0 || fail log-quarantine-delete-takeover-reentry-zero
        assert_file_identity_fingerprint "$recovery_source_journal" \
            "$log_quarantine_source_fingerprint" log-quarantine-reentry-source
        assert_file_identity_fingerprint "$recovery_rollback_journal" \
            "$log_quarantine_rollback_fingerprint" log-quarantine-reentry-rollback
        assert_file_identity_fingerprint "$unknown_path" "$log_quarantine_unknown_fingerprint" \
            log-quarantine-reentry-unknown
        assert_file_identity_fingerprint "$log_quarantine_preserved" \
            "$log_quarantine_expected_fingerprint" log-quarantine-reentry-expected
        ;;
    artifact-final-delete-takeover)
        install_committed_contract
        rm -rf "$test_root/runtime-cleanup-crash-hit"
        export GL_A_TEST_RUNTIME_CLEANUP_CRASH=checker:detaching
        manual_crash_output="$test_root/artifact-final-delete-takeover-crash.out"
        start_manual_rollback "$manual_crash_output"
        wait_for_c_crash "$manual_pid" runtime-cleanup-crash-hit 1200
        unset GL_A_TEST_RUNTIME_CLEANUP_CRASH
        test "$recovery_initial_phase" = committed || fail artifact-final-takeover-origin-phase
        assert_official_runtime_cleanup_crash_window checker 8 detaching \
            /usr/local/sbin/aifeeds-check-nginx-request-id
        test ! -e "$test_root/artifact-final-delete-takeover-hit" \
            || fail artifact-final-delete-takeover-legacy-hook-reached
        recover_and_reenter artifact-final-delete-takeover
        test ! -e "$official_runtime_cleanup_tombstone" \
            && test ! -L "$official_runtime_cleanup_tombstone" \
            || fail artifact-final-cleanup-tombstone-remained
        ;;
    rotation-status-delete-takeover)
        install_committed_contract
        rm -rf "$test_root/runtime-cleanup-crash-hit"
        export GL_A_TEST_RUNTIME_CLEANUP_CRASH=rotation_status:detached
        manual_crash_output="$test_root/rotation-status-delete-takeover-crash.out"
        start_manual_rollback "$manual_crash_output"
        wait_for_c_crash "$manual_pid" runtime-cleanup-crash-hit 1200
        unset GL_A_TEST_RUNTIME_CLEANUP_CRASH
        test "$recovery_initial_phase" = committed || fail rotation-status-takeover-origin-phase
        assert_official_runtime_cleanup_crash_window rotation_status 4 detached \
            /var/lib/aifeeds-performance-logrotate/status
        test ! -e "$test_root/rotation-status-delete-takeover-hit" \
            || fail rotation-status-delete-takeover-legacy-hook-reached
        recover_and_reenter rotation-status-delete-takeover
        test ! -e "$official_runtime_cleanup_tombstone" \
            && test ! -L "$official_runtime_cleanup_tombstone" \
            || fail rotation-status-cleanup-tombstone-remained
        ;;
    archive-manifest-delete-takeover)
        install_committed_contract
        manual_output="$test_root/${scenario}.out"
        run_manual_rollback "$manual_output"
        test "$manual_rc" -ne 0 || fail "$scenario-returned-zero"
        test -e "$test_root/${scenario}-hit" || fail "$scenario-not-hit"
        case "$scenario" in
            archive-manifest-delete-takeover)
                unknown_path="/var/backups/aifeeds-performance-log/audit-${operation_id}/archive-manifest.json.previous-gl-a-${operation_id}"
                ;;
        esac
        assert_recorded_takeover_pair "$scenario" "$unknown_path"
        takeover_unknown_fingerprint=$(file_identity_fingerprint "$unknown_path")
        takeover_preserved_path=$(<"$test_root/${scenario}.preserved.path")
        takeover_expected_fingerprint=$(file_identity_fingerprint "$takeover_preserved_path")
        manual_reentry_output="$test_root/${scenario}-reentry.out"
        run_manual_rollback "$manual_reentry_output"
        test "$manual_rc" -ne 0 || fail "$scenario-reentry-returned-zero"
        assert_file_identity_fingerprint "$unknown_path" "$takeover_unknown_fingerprint" \
            "$scenario-reentry-unknown"
        assert_file_identity_fingerprint "$takeover_preserved_path" "$takeover_expected_fingerprint" \
            "$scenario-reentry-expected"
        ;;
    site-displaced-delete-takeover)
        rc=$(run_installer "$output")
        test "$rc" -ne 0 || fail site-displaced-delete-takeover-returned-zero
        test -e "$test_root/site-displaced-delete-takeover-hit" \
            || fail site-displaced-delete-takeover-not-hit
        source_journal="/var/backups/aifeeds-performance-log/transaction-${operation_id}.json"
        rollback_journal="/var/backups/aifeeds-performance-log/rollback-transaction-${operation_id}.json"
        jq -e '.phase == "mutation_started"' "$source_journal" >/dev/null \
            || fail site-displaced-delete-takeover-source-journal
        jq -e '.phase == "rollback_failed" and .failed_from == "prepared" and
            (.runtime_cleanup // null) == null' "$rollback_journal" >/dev/null \
            || fail site-displaced-delete-takeover-rollback-journal
        assert_cas_namespace "$source_journal" F
        assert_cas_namespace "$rollback_journal" F
        unknown_path=$(jq -er '.rollback_candidate' "$source_journal")
        assert_recorded_takeover_pair site-displaced-delete-takeover "$unknown_path"
        site_displaced_preserved=$(<"$test_root/site-displaced-delete-takeover.preserved.path")
        site_displaced_source_fingerprint=$(file_identity_fingerprint "$source_journal")
        site_displaced_rollback_fingerprint=$(file_identity_fingerprint "$rollback_journal")
        site_displaced_unknown_fingerprint=$(file_identity_fingerprint "$unknown_path")
        site_displaced_expected_fingerprint=$(file_identity_fingerprint "$site_displaced_preserved")
        retry_output="$test_root/site-displaced-delete-takeover-retry.out"
        retry_rc=$(run_installer "$retry_output")
        test "$retry_rc" -eq 76 || fail "site-displaced-delete-takeover-retry-rc-$retry_rc"
        assert_file_identity_fingerprint "$source_journal" "$site_displaced_source_fingerprint" \
            site-displaced-retry-source
        assert_file_identity_fingerprint "$rollback_journal" "$site_displaced_rollback_fingerprint" \
            site-displaced-retry-rollback
        assert_file_identity_fingerprint "$unknown_path" "$site_displaced_unknown_fingerprint" \
            site-displaced-retry-unknown
        assert_file_identity_fingerprint "$site_displaced_preserved" "$site_displaced_expected_fingerprint" \
            site-displaced-retry-expected
        ;;
    rotation-status-delete-crash-reentry)
        install_committed_contract
        rm -rf "$test_root/runtime-cleanup-crash-hit"
        export GL_A_TEST_RUNTIME_CLEANUP_CRASH=rotation_status:detaching
        manual_crash_output="$test_root/rotation-status-delete-crash-reentry-crash.out"
        start_manual_rollback "$manual_crash_output"
        wait_for_c_crash "$manual_pid" runtime-cleanup-crash-hit 1200
        unset GL_A_TEST_RUNTIME_CLEANUP_CRASH
        assert_official_runtime_cleanup_crash_window rotation_status 4 detaching \
            /var/lib/aifeeds-performance-logrotate/status
        recover_and_reenter rotation-status-delete-crash-reentry
        test ! -e "$official_runtime_cleanup_tombstone" \
            && test ! -L "$official_runtime_cleanup_tombstone" \
            || fail rotation-status-crash-cleanup-tombstone-remained
        ;;
    archive-manifest-delete-crash-reentry)
        install_committed_contract
        manual_crash_output="$test_root/${scenario}-crash.out"
        start_manual_rollback "$manual_crash_output"
        kill_process_group_at_cleanup_barrier "$manual_pid" \
            "$test_root/${scenario}-ready" "$test_root/${scenario}.payload.path" \
            1600
        load_manual_recovery_contract
        manifest="/var/backups/aifeeds-performance-log/audit-${operation_id}/archive-manifest.json"
        cleanup_payload=$(<"$test_root/${scenario}.payload.path")
        test -f "$manifest" && test ! -L "$manifest" \
            || fail archive-manifest-delete-final-missing
        test -f "$cleanup_payload" && test ! -L "$cleanup_payload" \
            || fail archive-manifest-delete-cleanup-payload-missing
        test ! -e "${manifest}.tmp" && test ! -L "${manifest}.tmp" \
            || fail archive-manifest-delete-unexpected-tmp
        test ! -e "${manifest}.previous-gl-a-${operation_id}" \
            && test ! -L "${manifest}.previous-gl-a-${operation_id}" \
            || fail archive-manifest-delete-unexpected-previous
        prepare_archive_chain_inode_drift "$manifest"
        run_c_negative_twice_stable \
            "$test_root/archive-manifest-delete-chain-drift-negative.out"
        restore_archive_chain_inode_drift
        recover_and_reenter "$scenario"
        cleanup_payload=$(<"$test_root/${scenario}.payload.path")
        test ! -e "$cleanup_payload" || fail "$scenario-payload-remained"
        test ! -L "$cleanup_payload" || fail "$scenario-payload-symlink-remained"
        test ! -e "${cleanup_payload%/payload}" || fail "$scenario-directory-remained"
        ;;
    artifact-final-delete-crash-reentry)
        install_committed_contract
        rm -rf "$test_root/runtime-cleanup-crash-hit"
        export GL_A_TEST_RUNTIME_CLEANUP_CRASH=format:detaching
        manual_crash_output="$test_root/artifact-final-delete-crash-reentry-crash.out"
        start_manual_rollback "$manual_crash_output"
        wait_for_c_crash "$manual_pid" runtime-cleanup-crash-hit 1200
        unset GL_A_TEST_RUNTIME_CLEANUP_CRASH
        test "$recovery_initial_phase" = committed || fail artifact-final-crash-origin-phase
        assert_format_cleanup_crash_window detaching \
            /etc/nginx/conf.d/aifeeds-performance-log.conf
        recover_and_reenter artifact-final-delete-crash-reentry
        test ! -e "$format_cleanup_tombstone" && test ! -L "$format_cleanup_tombstone" \
            || fail artifact-final-cleanup-tombstone-remained
        ;;
    log-quarantine-delete-crash-reentry)
        install_committed_contract
        live_log=/var/log/nginx/aifeeds-performance.jsonl
        live_dev=$(stat -c '%d' "$live_log")
        live_ino=$(stat -c '%i' "$live_log")
        quarantine="/var/log/nginx/.aifeeds-performance.jsonl.quarantine-gl-a-${operation_id}"
        destination="/var/backups/aifeeds-performance-log/audit-${operation_id}/aifeeds-performance.jsonl"
        manual_output="$test_root/log-quarantine-delete-crash-reentry.out"
        run_manual_rollback "$manual_output"
        test "$manual_rc" -eq 0 || fail "log-quarantine-samefs-rc-$manual_rc"
        test ! -e "$test_root/log-quarantine-delete-crash-reentry-ready" \
            || fail log-quarantine-samefs-legacy-hook-reached
        manifest="/var/backups/aifeeds-performance-log/audit-${operation_id}/archive-manifest.json"
        jq -e --arg source "$live_log" --arg quarantine "$quarantine" \
            --arg destination "$destination" --argjson live_dev "$live_dev" \
            --argjson live_ino "$live_ino" '
            any(.entries[];
                .source == $source and .quarantine == $quarantine and
                .destination == $destination and .state == "archived" and
                .dev == $live_dev and .ino == $live_ino and
                .destination_dev == $live_dev and .destination_ino == $live_ino)
        ' "$manifest" >/dev/null || fail samefs-log-manifest-identity
        test "$(stat -c '%d %i' "$destination")" = "$live_dev $live_ino" \
            || fail samefs-log-destination-identity
        test ! -e "$quarantine" && test ! -L "$quarantine" \
            || fail samefs-log-quarantine-remained
        capture_manual_terminal_hashes
        manual_reentry_output="$test_root/log-quarantine-delete-crash-reentry-reentry.out"
        run_manual_rollback "$manual_reentry_output"
        test "$manual_rc" -eq 0 || fail "log-quarantine-samefs-reentry-rc-$manual_rc"
        assert_manual_reentry_unchanged
        ;;
    artifact-candidate-delete-crash-reentry)
        setsid /bin/bash "$installer" "$staging" "$operation_id" "$g0_commit" > "$output" 2>&1 &
        installer_pid=$!
        wait_for_file "$test_root/artifact-candidate-source-ready"
        kill -KILL -- "-$installer_pid"
        set +e
        wait "$installer_pid"
        rc=$?
        set -e
        test "$rc" -eq 137 || fail "artifact-candidate-source-kill-rc-$rc"
        load_manual_recovery_contract
        test "$recovery_initial_phase" = mutation_started \
            || fail artifact-candidate-crash-origin-phase
        rm -rf "$test_root/runtime-cleanup-crash-hit"
        export GL_A_TEST_RUNTIME_CLEANUP_CRASH=format:detached
        manual_crash_output="$test_root/artifact-candidate-delete-crash-reentry-crash.out"
        start_manual_rollback "$manual_crash_output"
        wait_for_c_crash "$manual_pid" runtime-cleanup-crash-hit 1200
        unset GL_A_TEST_RUNTIME_CLEANUP_CRASH
        format_candidate=$(jq -er '.artifact_candidates.format' "$recovery_source_journal")
        assert_format_cleanup_crash_window detached "$format_candidate"
        recover_and_reenter artifact-candidate-delete-crash-reentry
        test ! -e "$format_cleanup_tombstone" && test ! -L "$format_cleanup_tombstone" \
            || fail artifact-candidate-cleanup-tombstone-remained
        ;;
    site-displaced-delete-crash-reentry)
        setsid /bin/bash "$installer" "$staging" "$operation_id" "$g0_commit" > "$output" 2>&1 &
        installer_pid=$!
        kill_process_group_at_cleanup_barrier "$installer_pid" \
            "$test_root/site-displaced-delete-crash-reentry-ready" \
            "$test_root/site-displaced-delete-crash-reentry.payload.path"
        load_manual_recovery_contract
        test "$recovery_initial_phase" = mutation_started \
            || fail site-displaced-crash-origin-phase
        recover_and_reenter site-displaced-delete-crash-reentry
        cleanup_payload=$(<"$test_root/site-displaced-delete-crash-reentry.payload.path")
        test ! -e "$cleanup_payload" || fail site-displaced-crash-payload-remained
        test ! -e "${cleanup_payload%/payload}" || fail site-displaced-crash-directory-remained
        ;;
    prelive-prepared-delete-crash-reentry)
        setsid /bin/bash "$installer" "$staging" "$operation_id" "$g0_commit" > "$output" 2>&1 &
        installer_pid=$!
        kill_process_group_at_cleanup_barrier "$installer_pid" \
            "$test_root/prelive-prepared-delete-crash-reentry-ready" \
            "$test_root/prelive-prepared-delete-crash-reentry.payload.path"
        recovery_source_journal="/var/backups/aifeeds-performance-log/transaction-${operation_id}.json"
        jq -e '.phase == "prepared" and
            (.installer_candidate_dev | type == "number") and
            (.installer_candidate_ino | type == "number")' \
            "$recovery_source_journal" >/dev/null || fail prelive-prepared-crash-source-identity
        cleanup_payload=$(<"$test_root/prelive-prepared-delete-crash-reentry.payload.path")
        cleanup_fingerprint=$(<"$test_root/prelive-prepared-delete-crash-reentry.payload.fingerprint")
        test "$(jq -er '.installer_candidate_dev' "$recovery_source_journal"):$(jq -er '.installer_candidate_ino' "$recovery_source_journal")" = \
            "$(cut -d: -f2-3 <<< "$cleanup_fingerprint")" \
            || fail prelive-prepared-crash-journal-payload-identity
        load_manual_recovery_contract
        recover_and_reenter prelive-prepared-delete-crash-reentry
        test ! -e "$cleanup_payload" || fail prelive-prepared-crash-payload-remained
        test ! -e "${cleanup_payload%/payload}" || fail prelive-prepared-crash-directory-remained
        ;;
    restore-site-absent-samebytes-crash-reentry)
        install_committed_contract
        manual_crash_output="$test_root/restore-site-absent-samebytes-crash.out"
        start_manual_rollback "$manual_crash_output"
        wait_for_file "$test_root/restore-site-absent-samebytes-ready"
        kill -KILL -- "-$manual_pid"
        set +e
        wait "$manual_pid"
        rc=$?
        set -e
        test "$rc" -eq 137 || fail "restore-site-absent-kill-rc-$rc"
        test ! -e /etc/nginx/sites-available/aifeeds.conf \
            || fail restore-site-absent-site-present
        test -s "$test_root/restore-site-absent.rollback.expected.fingerprint" \
            || fail restore-site-absent-rollback-fingerprint-missing
        test -s "$test_root/restore-site-absent.installer.expected.fingerprint" \
            || fail restore-site-absent-installer-fingerprint-missing
        for label in restore-site-absent.rollback restore-site-absent.installer; do
            canonical=$recovery_installer_candidate
            if [ "$label" = restore-site-absent.rollback ]; then
                canonical=$recovery_rollback_candidate
            fi
            preserved=$(<"$test_root/${label}.preserved.path")
            unknown_fingerprint=$(<"$test_root/${label}.unknown.fingerprint")
            expected_fingerprint=$(<"$test_root/${label}.expected.fingerprint")
            assert_file_identity_fingerprint "$canonical" "$unknown_fingerprint" "$label-unknown"
            assert_file_identity_fingerprint "$preserved" "$expected_fingerprint" "$label-expected"
        done
        for attempt in first reentry; do
            manual_output="$test_root/restore-site-absent-${attempt}.out"
            run_manual_rollback "$manual_output"
            test "$manual_rc" -ne 0 || fail "restore-site-absent-${attempt}-returned-zero"
            ! grep -Fq 'manual_rollback=pass' "$manual_output" \
                || fail "restore-site-absent-${attempt}-false-pass"
            for label in restore-site-absent.rollback restore-site-absent.installer; do
                canonical=$recovery_installer_candidate
                if [ "$label" = restore-site-absent.rollback ]; then
                    canonical=$recovery_rollback_candidate
                fi
                preserved=$(<"$test_root/${label}.preserved.path")
                assert_file_identity_fingerprint "$canonical" \
                    "$(<"$test_root/${label}.unknown.fingerprint")" "$label-${attempt}-unknown"
                assert_file_identity_fingerprint "$preserved" \
                    "$(<"$test_root/${label}.expected.fingerprint")" "$label-${attempt}-expected"
            done
        done
        ;;
    crossfs-candidate-samebytes-takeover)
        install_committed_contract
        committed_source_sha=$(sha256sum "$recovery_source_journal" | awk '{print $1}')
        run_manifest_conflict_failure crossfs-candidate-samebytes
        test -e "$test_root/crossfs-candidate-samebytes-takeover-hit" \
            || fail crossfs-candidate-samebytes-not-hit
        candidate=$(find "/var/backups/aifeeds-performance-log/audit-${operation_id}" \
            -maxdepth 1 -type f -name "*.candidate-gl-a-${operation_id}" -print -quit)
        test -n "$candidate" || fail crossfs-candidate-samebytes-canonical-missing
        preserved=$(<"$test_root/crossfs-candidate-samebytes.preserved.path")
        candidate_unknown=$(<"$test_root/crossfs-candidate-samebytes.unknown.fingerprint")
        candidate_expected=$(<"$test_root/crossfs-candidate-samebytes.expected.fingerprint")
        assert_same_bytes_distinct_inode_fingerprints "$candidate_expected" "$candidate_unknown" \
            crossfs-candidate-samebytes
        assert_file_identity_fingerprint "$candidate" "$candidate_unknown" crossfs-candidate-unknown
        assert_file_identity_fingerprint "$preserved" "$candidate_expected" crossfs-candidate-expected
        conflict_rollback_sha=$(sha256sum "$recovery_rollback_journal" | awk '{print $1}')
        run_manifest_conflict_failure crossfs-candidate-samebytes-reentry "$conflict_rollback_sha"
        assert_file_identity_fingerprint "$candidate" "$candidate_unknown" crossfs-candidate-reentry-unknown
        assert_file_identity_fingerprint "$preserved" "$candidate_expected" crossfs-candidate-reentry-expected
        ;;
    crossfs-destination-samebytes-takeover)
        install_committed_contract
        committed_source_sha=$(sha256sum "$recovery_source_journal" | awk '{print $1}')
        run_manifest_conflict_failure crossfs-destination-samebytes
        test -e "$test_root/crossfs-destination-samebytes-takeover-hit" \
            || fail crossfs-destination-samebytes-not-hit
        manifest="/var/backups/aifeeds-performance-log/audit-${operation_id}/archive-manifest.json"
        destination=$(jq -er '.entries[] | select(.state == "copied") | .destination' "$manifest")
        candidate=$(jq -er '.entries[] | select(.state == "copied") | .candidate' "$manifest")
        destination_unknown=$(<"$test_root/crossfs-destination.unknown.fingerprint")
        candidate_expected=$(<"$test_root/crossfs-destination.candidate.fingerprint")
        assert_same_bytes_distinct_inode_fingerprints "$candidate_expected" "$destination_unknown" \
            crossfs-destination-samebytes
        assert_file_identity_fingerprint "$destination" "$destination_unknown" crossfs-destination-unknown
        assert_file_identity_fingerprint "$candidate" "$candidate_expected" crossfs-destination-candidate
        conflict_rollback_sha=$(sha256sum "$recovery_rollback_journal" | awk '{print $1}')
        run_manifest_conflict_failure crossfs-destination-samebytes-reentry "$conflict_rollback_sha"
        assert_file_identity_fingerprint "$destination" "$destination_unknown" crossfs-destination-reentry-unknown
        assert_file_identity_fingerprint "$candidate" "$candidate_expected" crossfs-destination-reentry-candidate
        ;;
    crossfs-copied-crash-reentry)
        install_committed_contract
        crossfs_live_dev=$(stat -c '%d' /var/log/nginx/aifeeds-performance.jsonl)
        manual_crash_output="$test_root/crossfs-copied-crash.out"
        start_manual_rollback "$manual_crash_output"
        wait_for_file "$test_root/crossfs-copied-crash-reentry-ready" 800
        assert_crossfs_copied_window crossfs-copied-before-kill
        kill -KILL -- "-$manual_pid"
        set +e
        wait "$manual_pid"
        rc=$?
        set -e
        test "$rc" -eq 137 || fail "crossfs-copied-kill-rc-$rc"
        recover_and_reenter crossfs-copied-crash-reentry
        assert_crossfs_terminal_evidence crossfs-copied-terminal "$crossfs_live_dev"
        ;;
    crossfs-published-crash-reentry)
        install_committed_contract
        crossfs_live_dev=$(stat -c '%d' /var/log/nginx/aifeeds-performance.jsonl)
        manual_crash_output="$test_root/crossfs-published-crash.out"
        start_manual_rollback "$manual_crash_output"
        kill_process_group_at_cleanup_barrier "$manual_pid" \
            "$test_root/crossfs-published-crash-reentry-ready" \
            "$test_root/crossfs-published-crash-reentry.payload.path" 800
        recover_and_reenter crossfs-published-crash-reentry
        assert_crossfs_terminal_evidence crossfs-published-terminal "$crossfs_live_dev"
        ;;
    cross-filesystem-audit)
        install_committed_contract
        live_log=/var/log/nginx/aifeeds-performance.jsonl
        audit_dir="/var/backups/aifeeds-performance-log/audit-${operation_id}"
        test "$(stat -c '%d' /var/log/nginx)" != \
            "$(stat -c '%d' /var/backups/aifeeds-performance-log)" \
            || fail cross-filesystem-not-mounted
        printf '{"crossfs_marker":"%s"}\n' "$operation_id" >> "$live_log"
        crossfs_live_dev=$(stat -c '%d' "$live_log")
        manual_output="$test_root/cross-filesystem-audit.out"
        run_manual_rollback "$manual_output"
        test "$manual_rc" -eq 0 || fail "cross-filesystem-audit-rc-$manual_rc"
        manifest="$audit_dir/archive-manifest.json"
        assert_crossfs_terminal_evidence cross-filesystem "$crossfs_live_dev"
        grep -R -Fq -- "\"crossfs_marker\":\"${operation_id}\"" "$audit_dir" \
            || fail cross-filesystem-tail-lost
        capture_manual_terminal_hashes
        manual_reentry_output="$test_root/cross-filesystem-audit-reentry.out"
        run_manual_rollback "$manual_reentry_output"
        test "$manual_rc" -eq 0 || fail "cross-filesystem-audit-reentry-rc-$manual_rc"
        assert_manual_reentry_unchanged
        ;;
    terminal-pair-source-only)
        install_committed_contract
        rm -rf "$test_root/terminal-pair-crash-hit"
        export GL_A_TEST_TERMINAL_PAIR_CRASH=one-side
        manual_crash_output="$test_root/terminal-pair-source-only-crash.out"
        start_manual_rollback "$manual_crash_output"
        wait_for_c_crash "$manual_pid" terminal-pair-crash-hit
        unset GL_A_TEST_TERMINAL_PAIR_CRASH
        terminal_marker="/var/backups/aifeeds-performance-log/rollback-commit-${operation_id}.json"
        test -f "$terminal_marker" || fail terminal-pair-source-only-marker-missing
        jq -e '.phase == "prepared"' "$terminal_marker" >/dev/null \
            || fail terminal-pair-source-only-marker-phase
        jq -e '.phase == "rolled_back"' "$recovery_source_journal" >/dev/null \
            || fail terminal-pair-source-only-source-phase
        ! jq -e '.phase == "rolled_back"' "$recovery_rollback_journal" >/dev/null 2>&1 \
            || fail terminal-pair-source-only-rollback-premature
        recover_and_reenter terminal-pair-source-only
        ;;
    terminal-pair-rollback-only)
        install_committed_contract
        rm -rf "$test_root/terminal-pair-crash-hit"
        export GL_A_TEST_TERMINAL_PAIR_CRASH=two-side
        manual_crash_output="$test_root/terminal-pair-rollback-only-crash.out"
        start_manual_rollback "$manual_crash_output"
        wait_for_c_crash "$manual_pid" terminal-pair-crash-hit
        unset GL_A_TEST_TERMINAL_PAIR_CRASH
        terminal_marker="/var/backups/aifeeds-performance-log/rollback-commit-${operation_id}.json"
        test -f "$terminal_marker" || fail terminal-pair-rollback-only-marker-missing
        jq -e '.phase == "prepared"' "$terminal_marker" >/dev/null \
            || fail terminal-pair-rollback-only-marker-phase
        jq -e '.phase == "rolled_back"' "$recovery_source_journal" >/dev/null \
            || fail terminal-pair-rollback-only-source-not-yet-terminal
        jq -e '.phase == "rolled_back"' "$recovery_rollback_journal" >/dev/null \
            || fail terminal-pair-rollback-only-rollback-phase
        source_previous="${recovery_source_journal}.previous-update-gl-a-${operation_id}"
        source_target="${recovery_source_journal}.tmp"
        test -f "$source_previous" && test ! -L "$source_previous" \
            || fail terminal-pair-rollback-only-source-previous-missing
        test ! -e "$source_target" && test ! -L "$source_target" \
            || fail terminal-pair-rollback-only-source-target-tmp-present
        /usr/bin/mv "$recovery_source_journal" "$source_target"
        /usr/bin/mv "$source_previous" "$recovery_source_journal"
        /usr/bin/sync -f "$recovery_source_journal"
        test "$(sha256sum "$recovery_source_journal" | awk '{print $1}')" = \
            "$(jq -er '.source_before_sha256' "$terminal_marker")" \
            || fail terminal-pair-rollback-only-source-before-hash
        test "$(sha256sum "$source_target" | awk '{print $1}')" = \
            "$(jq -er '.source_target_sha256' "$terminal_marker")" \
            || fail terminal-pair-rollback-only-source-target-hash
        jq -e '.phase == "committed"' "$recovery_source_journal" >/dev/null \
            || fail terminal-pair-rollback-only-source-not-restored
        recover_and_reenter terminal-pair-rollback-only
        ;;
    terminal-pair-committed-marker-tmp)
        install_committed_contract
        manual_crash_output="$test_root/terminal-pair-committed-marker-tmp-crash.out"
        start_manual_rollback "$manual_crash_output"
        wait_for_file "$test_root/terminal-pair-committed-marker-tmp-ready" 1200
        terminal_marker="/var/backups/aifeeds-performance-log/rollback-commit-${operation_id}.json"
        terminal_marker_tmp="${terminal_marker}.tmp"
        terminal_marker_previous="${terminal_marker}.previous-terminal-gl-a-${operation_id}"
        test ! -e "$terminal_marker" || fail terminal-pair-committed-marker-final-present
        test -f "$terminal_marker_tmp" || fail terminal-pair-committed-marker-tmp-missing
        test -f "$terminal_marker_previous" || fail terminal-pair-committed-marker-previous-missing
        jq -e '.phase == "prepared"' "$terminal_marker_previous" >/dev/null \
            || fail terminal-pair-committed-marker-previous-phase
        jq -e '.phase == "committed"' "$terminal_marker_tmp" >/dev/null \
            || fail terminal-pair-committed-marker-tmp-phase
        jq -e '.phase == "rolled_back"' "$recovery_source_journal" >/dev/null \
            || fail terminal-pair-committed-marker-source-phase
        jq -e '.phase == "rolled_back"' "$recovery_rollback_journal" >/dev/null \
            || fail terminal-pair-committed-marker-rollback-phase
        kill -KILL -- "-$manual_pid"
        set +e
        wait "$manual_pid"
        rc=$?
        set -e
        test "$rc" -eq 137 || fail "terminal-pair-committed-marker-kill-rc-$rc"
        recover_and_reenter terminal-pair-committed-marker-tmp
        test ! -e "$terminal_marker_tmp" || fail terminal-pair-committed-marker-tmp-remained
        ;;
    terminal-pair-committed-tmp-drift)
        install_committed_contract
        manual_output="$test_root/terminal-pair-committed-tmp-drift.out"
        run_manual_rollback "$manual_output"
        test "$manual_rc" -ne 0 || fail terminal-pair-committed-tmp-drift-returned-zero
        test -e "$test_root/terminal-pair-committed-tmp-drift-hit" \
            || fail terminal-pair-committed-tmp-drift-not-hit
        terminal_marker="/var/backups/aifeeds-performance-log/rollback-commit-${operation_id}.json"
        terminal_marker_previous="${terminal_marker}.previous-terminal-gl-a-${operation_id}"
        terminal_marker_tmp="${terminal_marker}.tmp"
        test ! -e "$terminal_marker" || fail terminal-pair-committed-tmp-drift-final-present
        test -f "$terminal_marker_previous" || fail terminal-pair-committed-tmp-drift-previous-missing
        assert_recorded_takeover_pair terminal-pair-committed-tmp "$terminal_marker_tmp"
        previous_fingerprint=$(file_identity_fingerprint "$terminal_marker_previous")
        unknown_fingerprint=$(file_identity_fingerprint "$terminal_marker_tmp")
        manual_reentry_output="$test_root/terminal-pair-committed-tmp-drift-reentry.out"
        run_manual_rollback "$manual_reentry_output"
        test "$manual_rc" -ne 0 || fail terminal-pair-committed-tmp-drift-reentry-returned-zero
        assert_file_identity_fingerprint "$terminal_marker_previous" "$previous_fingerprint" \
            terminal-pair-committed-tmp-drift-reentry-previous
        assert_file_identity_fingerprint "$terminal_marker_tmp" "$unknown_fingerprint" \
            terminal-pair-committed-tmp-drift-reentry-tmp
        ;;
    terminal-source-post-marker-check-drift)
        install_committed_contract
        terminal_marker="/var/backups/aifeeds-performance-log/rollback-commit-${operation_id}.json"
        export GL_A_TEST_TERMINAL_PAIR_BARRIER=source-post-marker-check
        manual_output="$test_root/terminal-source-post-marker-check-drift.out"
        start_manual_rollback "$manual_output"
        wait_for_file "$test_root/terminal-pair-source-post-marker-check-ready" 1200
        assert_cas_namespace "$recovery_source_journal" FP
        assert_cas_namespace "$recovery_rollback_journal" FP
        test -f "$terminal_marker" && test ! -L "$terminal_marker" \
            || fail terminal-source-post-marker-check-marker-missing
        replacement_marker="${terminal_marker}.replacement-fixture"
        /usr/bin/cp -p "$terminal_marker" "$replacement_marker"
        rewrite_json_in_place "$replacement_marker" terminal-marker-prepared-hash
        /usr/bin/mv "$replacement_marker" "$terminal_marker"
        /usr/bin/sync -f "$terminal_marker"
        /usr/bin/sync -f "${terminal_marker%/*}"
        bound_source_fingerprint=$(file_identity_fingerprint "$recovery_source_journal")
        bound_rollback_fingerprint=$(file_identity_fingerprint "$recovery_rollback_journal")
        bound_marker_fingerprint=$(file_identity_fingerprint "$terminal_marker")
        bound_summary_fingerprint=$(optional_file_identity_fingerprint "$recovery_manual_summary")
        bound_namespace_fingerprint=$(c_namespace_fingerprint)
        : > "$test_root/terminal-pair-source-post-marker-check-release"
        set +e
        wait "$manual_pid"
        manual_rc=$?
        set -e
        unset GL_A_TEST_TERMINAL_PAIR_BARRIER
        test "$manual_rc" -ne 0 || fail terminal-source-post-marker-check-returned-zero
        grep -Fq 'terminal bound cleanup marker hash drift' "$manual_output" \
            || fail terminal-source-post-marker-check-bound-hash-check-not-reached
        ! grep -Fq 'manual_rollback=pass' "$manual_output" \
            || fail terminal-source-post-marker-check-false-pass
        assert_terminal_bound_first_failure_unchanged
        run_manual_rollback "$test_root/terminal-source-post-marker-check-retry.out"
        test "$manual_rc" -ne 0 || fail terminal-source-post-marker-check-retry-zero
        test "$(c_namespace_fingerprint)" = "$bound_namespace_fingerprint" \
            || fail terminal-source-post-marker-check-retry-changed
        ;;
    terminal-source-destination-drift|terminal-rollback-destination-drift)
        install_committed_contract
        manual_output="$test_root/${scenario}.out"
        run_manual_rollback "$manual_output"
        test "$manual_rc" -eq 0 || fail "$scenario-rc-$manual_rc"
        test ! -e "$test_root/${scenario}-hit" \
            || fail "$scenario-legacy-journal-namespace-reached"
        assert_exact_terminal_pair "$operation_id"
        capture_manual_terminal_hashes
        manual_reentry_output="$test_root/${scenario}-reentry.out"
        run_manual_rollback "$manual_reentry_output"
        test "$manual_rc" -eq 0 || fail "$scenario-reentry-rc-$manual_rc"
        assert_manual_reentry_unchanged
        assert_exact_terminal_pair "$operation_id"
        ;;
    terminal-pair-internal-marker-drift)
        install_committed_contract
        manual_output="$test_root/terminal-pair-internal-marker-drift.out"
        run_manual_rollback "$manual_output"
        test "$manual_rc" -ne 0 || fail terminal-pair-internal-marker-drift-returned-zero
        test -e "$test_root/terminal-pair-internal-marker-drift-hit" \
            || fail terminal-pair-internal-marker-drift-not-hit
        terminal_marker="/var/backups/aifeeds-performance-log/rollback-commit-${operation_id}.json"
        source_fingerprint="$(<"$test_root/terminal-pair-internal.source.fingerprint")"
        marker_fingerprint="$(<"$test_root/terminal-pair-internal.marker.fingerprint")"
        assert_file_identity_fingerprint "$recovery_source_journal" "$source_fingerprint" \
            terminal-pair-internal-source
        assert_file_identity_fingerprint "$terminal_marker" "$marker_fingerprint" \
            terminal-pair-internal-marker
        manual_reentry_output="$test_root/terminal-pair-internal-marker-drift-reentry.out"
        run_manual_rollback "$manual_reentry_output"
        test "$manual_rc" -ne 0 || fail terminal-pair-internal-marker-drift-reentry-zero
        assert_file_identity_fingerprint "$recovery_source_journal" "$source_fingerprint" \
            terminal-pair-internal-reentry-source
        assert_file_identity_fingerprint "$terminal_marker" "$marker_fingerprint" \
            terminal-pair-internal-reentry-marker
        ;;
    terminal-previous-delete-crash-reentry)
        install_committed_contract
        manual_crash_output="$test_root/terminal-previous-delete-crash-reentry.out"
        start_manual_rollback "$manual_crash_output"
        kill_process_group_at_cleanup_barrier "$manual_pid" \
            "$test_root/terminal-previous-delete-crash-reentry-ready" \
            "$test_root/terminal-previous-delete-crash-reentry.payload.path" 1200
        recover_and_reenter terminal-previous-delete-crash-reentry 1
        cleanup_payload=$(<"$test_root/terminal-previous-delete-crash-reentry.payload.path")
        test ! -e "$cleanup_payload" || fail terminal-previous-crash-payload-remained
        test ! -e "${cleanup_payload%/payload}" || fail terminal-previous-crash-dir-remained
        ;;
    systemctl-is-active-error)
        install_committed_contract
        assert_repeatable_manual_failure systemctl-is-active \
            "$test_root/systemctl/is-active-control-error-hit"
        ;;
    systemctl-is-enabled-error)
        install_committed_contract
        assert_repeatable_manual_failure systemctl-is-enabled \
            "$test_root/systemctl/is-enabled-control-error-hit"
        ;;
    negative-probe-grep-error)
        install_committed_contract
        : > "$test_root/negative-probe-enabled"
        assert_repeatable_manual_failure negative-probe-grep \
            "$test_root/negative-grep-error-hit"
        ;;
    negative-probe-find-error)
        install_committed_contract
        : > "$test_root/negative-probe-enabled"
        assert_repeatable_manual_failure negative-probe-find \
            "$test_root/negative-find-error-hit"
        ;;
    reinstall-after-auto-rollback)
        rc=$(run_installer "$output")
        test "$rc" -ne 0 || fail reinstall-first-returned-zero
        grep -Fq 'automatic_rollback=pass ' "$output" || fail reinstall-first-rollback-not-pass
        ! grep -Fq 'automatic_rollback=failed ' "$output" || fail reinstall-first-false-failure
        old_source_journal="/var/backups/aifeeds-performance-log/transaction-${operation_id}.json"
        old_rollback_journal="/var/backups/aifeeds-performance-log/rollback-transaction-${operation_id}.json"
        old_marker="/var/backups/aifeeds-performance-log/rollback-commit-${operation_id}.json"
        assert_gl_a_journal_identity "$old_source_journal" rolled_back
        assert_exact_terminal_pair "$operation_id"
        old_pair_namespace_fingerprint=$(terminal_pair_namespace_fingerprint "$operation_id")
        old_source_fingerprint=$(file_identity_fingerprint "$old_source_journal")
        old_rollback_fingerprint=$(file_identity_fingerprint "$old_rollback_journal")
        old_marker_fingerprint=$(file_identity_fingerprint "$old_marker")
        old_source_revision=$(jq -er '.journal_update.revision' "$old_source_journal")
        old_rollback_revision=$(jq -er '.journal_update.revision' "$old_rollback_journal")
        cmp -s "$test_root/aifeeds.conf.original" /etc/nginx/sites-available/aifeeds.conf \
            || fail reinstall-first-site-not-base
        secondary_operation_id='20260712000001-89abcdef'
        prepare_secondary_staging "$secondary_operation_id"
        secondary_output="$test_root/secondary-installer.out"
        run_secondary_installer "$secondary_output"
        test "$secondary_rc" -eq 0 || fail "reinstall-secondary-rc-$secondary_rc"
        grep -Fq 'gl_a=pass ' "$secondary_output" || fail reinstall-secondary-pass-missing
        ! grep -Fq 'recovery_required=1' "$secondary_output" || fail reinstall-false-recovery-required
        assert_exact_terminal_pair "$operation_id"
        test "$(terminal_pair_namespace_fingerprint "$operation_id")" = \
            "$old_pair_namespace_fingerprint" || fail reinstall-old-terminal-namespace-changed
        assert_file_identity_fingerprint "$old_source_journal" "$old_source_fingerprint" \
            reinstall-old-source
        assert_file_identity_fingerprint "$old_rollback_journal" "$old_rollback_fingerprint" \
            reinstall-old-rollback
        assert_file_identity_fingerprint "$old_marker" "$old_marker_fingerprint" reinstall-old-marker
        test "$(jq -er '.journal_update.revision' "$old_source_journal")" = \
            "$old_source_revision" || fail reinstall-old-source-revision-changed
        test "$(jq -er '.journal_update.revision' "$old_rollback_journal")" = \
            "$old_rollback_revision" || fail reinstall-old-rollback-revision-changed
        secondary_journal="/var/backups/aifeeds-performance-log/transaction-${secondary_operation_id}.json"
        assert_cas_namespace "$secondary_journal" F "$secondary_operation_id"
        secondary_rollback="/var/backups/aifeeds-performance-log/rollback-transaction-${secondary_operation_id}.json"
        secondary_marker="/var/backups/aifeeds-performance-log/rollback-commit-${secondary_operation_id}.json"
        assert_cas_namespace "$secondary_rollback" '' "$secondary_operation_id"
        for path in "$secondary_marker" "${secondary_marker}.tmp" \
            "${secondary_marker}.previous-terminal-gl-a-${secondary_operation_id}"; do
            test ! -e "$path" && test ! -L "$path" || fail reinstall-secondary-pair-present
        done
        jq -e --arg operation_id "$secondary_operation_id" --arg g0_commit "$g0_commit" \
            --arg helper_sha "$rollback_helper_sha" --arg journal "$secondary_journal" \
            --arg backup "/var/backups/aifeeds-performance-log/aifeeds.conf.bak-perf-${secondary_operation_id}" \
            --arg audit "/var/backups/aifeeds-performance-log/audit-${secondary_operation_id}" \
            --arg candidate "/etc/nginx/sites-available/aifeeds.conf.candidate-gl-a-${secondary_operation_id}" \
            --arg rollback_candidate "/etc/nginx/sites-available/aifeeds.conf.rollback-gl-a-${secondary_operation_id}" '
            .schema == 1 and .gate == "GL-a" and .phase == "committed" and
            .operation_id == $operation_id and .g0_commit == $g0_commit and
            .rollback_helper_sha256 == $helper_sha and .transaction_journal == $journal and
            .site_backup == $backup and .audit_dir == $audit and
            .installer_candidate == $candidate and .rollback_candidate == $rollback_candidate and
            .runtime_artifacts_sealed == true and
            (has("rollback_journal") | not) and (has("rollback_commit_marker") | not)
            ' \
            "$secondary_journal" >/dev/null || fail reinstall-secondary-journal
        test -s "$secondary_staging/gl-a-summary.json" || fail reinstall-secondary-summary
        jq -e --arg operation_id "$secondary_operation_id" --arg journal "$secondary_journal" \
            --arg journal_sha "$(sha256sum "$secondary_journal" | awk '{print $1}')" '
            .schema == 1 and .gate == "GL-a" and .operation_id == $operation_id and
            .transaction_journal == $journal and .transaction_journal_sha256 == $journal_sha
        ' "$secondary_staging/gl-a-summary.json" >/dev/null \
            || fail reinstall-secondary-summary-identity
        rc=$secondary_rc
        ;;
    terminal-pair-tamper)
        install_committed_contract
        manual_output="$test_root/tamper-initial-rollback.out"
        run_manual_rollback "$manual_output"
        test "$manual_rc" -eq 0 || fail "tamper-initial-rollback-rc-$manual_rc"
        capture_manual_terminal_hashes
        terminal_source_sha=$(sha256sum "$recovery_source_journal" | awk '{print $1}')
        terminal_summary_sha=$(sha256sum "$recovery_manual_summary" | awk '{print $1}')
        tamper_tmp="$test_root/rollback-journal-tampered.json"
        jq '.audit_dir = "/var/backups/aifeeds-performance-log/audit-mirror-tampered"' \
            "$recovery_rollback_journal" > "$tamper_tmp"
        chmod 0600 "$tamper_tmp"
        /usr/bin/mv -f "$tamper_tmp" "$recovery_rollback_journal"
        /usr/bin/sync -f "$recovery_rollback_journal"
        tampered_rollback_sha=$(sha256sum "$recovery_rollback_journal" | awk '{print $1}')
        test "$tampered_rollback_sha" != "$manual_first_rollback_terminal_sha" \
            || fail tamper-not-applied
        secondary_operation_id='20260712000002-fedcba98'
        prepare_secondary_staging "$secondary_operation_id"
        secondary_output="$test_root/tamper-secondary-installer.out"
        run_secondary_installer "$secondary_output"
        test "$secondary_rc" -eq 76 || fail "tamper-secondary-rc-$secondary_rc"
        grep -Fq 'recovery_required=1' "$secondary_output" || fail tamper-recovery-required-missing
        ! grep -Fq 'gl_a=pass ' "$secondary_output" || fail tamper-secondary-false-pass
        test "$(sha256sum "$recovery_source_journal" | awk '{print $1}')" = "$terminal_source_sha" \
            || fail tamper-source-changed
        test "$(sha256sum "$recovery_rollback_journal" | awk '{print $1}')" = \
            "$tampered_rollback_sha" || fail tamper-rollback-changed-by-scanner
        test "$(sha256sum "$recovery_manual_summary" | awk '{print $1}')" = \
            "$terminal_summary_sha" || fail tamper-summary-changed
        test ! -e "/var/backups/aifeeds-performance-log/transaction-${secondary_operation_id}.json" \
            || fail tamper-secondary-journal-created
        ;;
    manual-cleanup-drift)
        install_committed_contract
        committed_source_sha=$(sha256sum "$recovery_source_journal" | awk '{print $1}')
        manual_crash_output="$test_root/cleanup-drift-crash.out"
        start_manual_rollback "$manual_crash_output"
        wait_for_file "$test_root/cleanup-drift-ready"
        jq -e '.phase == "site_restored"' "$recovery_rollback_journal" >/dev/null \
            || fail cleanup-drift-site-restored-phase
        cmp -s "$test_root/aifeeds.conf.original" /etc/nginx/sites-available/aifeeds.conf \
            || fail cleanup-drift-site-not-restored
        printf '\n# concurrent cleanup drift\n' >> /etc/nginx/conf.d/aifeeds-performance-log.conf
        cleanup_drift_sha=$(sha256sum /etc/nginx/conf.d/aifeeds-performance-log.conf | awk '{print $1}')
        kill -KILL -- "-$manual_pid"
        set +e
        wait "$manual_pid"
        rc=$?
        set -e
        test "$rc" -eq 137 || fail "cleanup-drift-kill-rc-$rc"
        ! grep -Fq 'manual_rollback=pass' "$manual_crash_output" \
            || fail cleanup-drift-crash-false-pass
        test "$(sha256sum "$recovery_source_journal" | awk '{print $1}')" = \
            "$committed_source_sha" || fail cleanup-drift-source-changed-after-kill
        assert_repeatable_manual_failure cleanup-drift "$test_root/cleanup-drift-ready"
        test "$(sha256sum /etc/nginx/conf.d/aifeeds-performance-log.conf | awk '{print $1}')" = \
            "$cleanup_drift_sha" || fail cleanup-drift-artifact-cleaned
        test -f /etc/aifeeds-performance-logrotate.conf || fail cleanup-drift-further-cleanup-ran
        ;;
    enabled-site-retarget-drift)
        rc=$(run_installer "$output")
        test "$rc" -eq 0 || fail "enabled-drift-install-rc-$rc"
        test -e "$test_root/mutation-started-verified" || fail enabled-drift-mutation-started-not-verified
        load_manual_recovery_contract
        test "$recovery_initial_phase" = committed || fail enabled-drift-source-not-committed
        assert_gl_a_journal_identity "$recovery_source_journal" committed
        assert_gl_a_summary_identity "$staging/gl-a-summary.json"
        enabled_source_sha=$(sha256sum "$recovery_source_journal" | awk '{print $1}')
        enabled_summary_sha=$(sha256sum "$staging/gl-a-summary.json" | awk '{print $1}')
        unrelated_site=/etc/nginx/sites-available/unrelated.conf
        /usr/bin/install -o root -g root -m 0644 "$test_root/aifeeds.conf.original" "$unrelated_site"
        unrelated_site_sha=$(sha256sum "$unrelated_site" | awk '{print $1}')
        ln -sfn "$unrelated_site" /etc/nginx/sites-enabled/aifeeds.conf
        test "$(readlink -f /etc/nginx/sites-enabled/aifeeds.conf)" = "$unrelated_site" \
            || fail enabled-drift-retarget-not-applied
        enabled_drift_output="$test_root/manual-enabled-site-drift.out"
        run_manual_rollback "$enabled_drift_output"
        test "$manual_rc" -ne 0 || fail enabled-drift-rollback-returned-zero
        grep -Fq 'manual_rollback=failed' "$enabled_drift_output" \
            || fail enabled-drift-failure-marker
        test "$(sha256sum "$recovery_source_journal" | awk '{print $1}')" = "$enabled_source_sha" \
            || fail enabled-drift-source-journal-changed
        test "$(sha256sum "$staging/gl-a-summary.json" | awk '{print $1}')" = "$enabled_summary_sha" \
            || fail enabled-drift-install-summary-changed
        test ! -e "$recovery_rollback_journal" || fail enabled-drift-rollback-journal-created
        test ! -L "$recovery_rollback_journal" || fail enabled-drift-rollback-journal-symlink
        test ! -e "${recovery_rollback_journal}.tmp" || fail enabled-drift-rollback-journal-tmp-created
        test ! -e "$recovery_manual_summary" || fail enabled-drift-manual-summary-created
        test ! -e "${recovery_manual_summary}.tmp" || fail enabled-drift-manual-summary-tmp-created
        test "$(readlink -f /etc/nginx/sites-enabled/aifeeds.conf)" = "$unrelated_site" \
            || fail enabled-drift-retarget-cleaned
        test "$(sha256sum "$unrelated_site" | awk '{print $1}')" = "$unrelated_site_sha" \
            || fail enabled-drift-unrelated-site-changed
        assert_runtime_artifacts_installed
        ;;
    manual-artifact-drift-terminal)
        rc=$(run_installer "$output")
        test "$rc" -eq 0 || fail "artifact-drift-install-rc-$rc"
        test -e "$test_root/mutation-started-verified" || fail artifact-drift-mutation-started-not-verified
        load_manual_recovery_contract
        test "$recovery_initial_phase" = committed || fail artifact-drift-source-not-committed
        assert_gl_a_journal_identity "$recovery_source_journal" committed
        assert_gl_a_summary_identity "$staging/gl-a-summary.json"
        drift_source_sha=$(sha256sum "$recovery_source_journal" | awk '{print $1}')
        drift_install_summary_sha=$(sha256sum "$staging/gl-a-summary.json" | awk '{print $1}')
        printf '\n# harness artifact content drift\n' >> /etc/nginx/conf.d/aifeeds-performance-log.conf
        drift_format_sha=$(sha256sum /etc/nginx/conf.d/aifeeds-performance-log.conf | awk '{print $1}')
        test "$drift_format_sha" != "$(jq -er '.format' <<< "$artifacts_sha256_json")" \
            || fail artifact-drift-not-applied
        manual_drift_output="$test_root/manual-artifact-drift.out"
        run_manual_rollback "$manual_drift_output"
        test "$manual_rc" -ne 0 || fail artifact-drift-rollback-returned-zero
        grep -Fq 'manual_rollback=failed' "$manual_drift_output" \
            || fail artifact-drift-failure-marker
        test "$(sha256sum /etc/nginx/conf.d/aifeeds-performance-log.conf | awk '{print $1}')" = \
            "$drift_format_sha" || fail artifact-drift-was-cleaned
        test "$(sha256sum "$recovery_source_journal" | awk '{print $1}')" = "$drift_source_sha" \
            || fail artifact-drift-source-journal-changed
        test "$(sha256sum "$staging/gl-a-summary.json" | awk '{print $1}')" = \
            "$drift_install_summary_sha" || fail artifact-drift-install-summary-changed
        test ! -e "$recovery_rollback_journal" || fail artifact-drift-rollback-journal-created
        test ! -L "$recovery_rollback_journal" || fail artifact-drift-rollback-journal-symlink
        test ! -e "${recovery_rollback_journal}.tmp" || fail artifact-drift-rollback-journal-tmp-created
        test ! -e "$recovery_manual_summary" || fail artifact-drift-manual-summary-created
        test ! -L "$recovery_manual_summary" || fail artifact-drift-manual-summary-symlink
        assert_runtime_artifacts_installed 1
        /usr/bin/install -o root -g root -m 0644 "$staging/aifeeds-performance-log.conf" \
            /etc/nginx/conf.d/aifeeds-performance-log.conf
        assert_runtime_artifacts_installed
        manual_output="$test_root/manual-artifact-drift-recovered.out"
        run_manual_rollback "$manual_output"
        test "$manual_rc" -eq 0 || fail "artifact-drift-recovery-rc-$manual_rc"
        capture_manual_terminal_hashes
        manual_reentry_output="$test_root/manual-artifact-drift-reentry.out"
        run_manual_rollback "$manual_reentry_output"
        test "$manual_rc" -eq 0 || fail "artifact-drift-reentry-rc-$manual_rc"
        assert_manual_reentry_unchanged
        test ! -e "${recovery_rollback_journal}.tmp" || fail terminal-artifact-journal-tmp-remained
        test ! -e "${recovery_manual_summary}.tmp" || fail terminal-artifact-summary-tmp-remained
        /usr/bin/install -o root -g root -m 0644 /dev/null \
            /etc/nginx/conf.d/aifeeds-performance-log.conf
        printf '# terminal artifact drift\n' >> /etc/nginx/conf.d/aifeeds-performance-log.conf
        terminal_drift_format_sha=$(sha256sum /etc/nginx/conf.d/aifeeds-performance-log.conf | awk '{print $1}')
        manual_terminal_drift_output="$test_root/manual-terminal-artifact-drift.out"
        run_manual_rollback "$manual_terminal_drift_output"
        test "$manual_rc" -ne 0 || fail terminal-artifact-drift-returned-zero
        grep -Fq 'manual_rollback=failed' "$manual_terminal_drift_output" \
            || fail terminal-artifact-drift-failure-marker
        ! grep -Fq 'manual_rollback=pass' "$manual_terminal_drift_output" \
            || fail terminal-artifact-drift-false-pass
        assert_manual_reentry_unchanged
        test "$(sha256sum /etc/nginx/conf.d/aifeeds-performance-log.conf | awk '{print $1}')" = \
            "$terminal_drift_format_sha" || fail terminal-artifact-drift-cleaned
        jq -e '.phase == "rolled_back"' "$recovery_source_journal" >/dev/null \
            || fail terminal-artifact-source-overwritten
        jq -e '.phase == "rolled_back"' "$recovery_rollback_journal" >/dev/null \
            || fail terminal-artifact-journal-overwritten
        ;;
    *) rc=$(run_installer "$output") ;;
esac

assert_no_canary_leak() {
    local paths=(
        "$test_root"
        "$staging"
        /var/backups/aifeeds-performance-log
        /var/log/nginx
        /etc/nginx
        /etc/systemd/system
        /usr/local/sbin
    )
    if grep -R -F -q -- "$canary" "${paths[@]}" 2>/dev/null; then
        fail secret-canary-leaked
    fi
}

assert_nginx_process_active() {
    test -s /run/nginx.pid || fail nginx-pid-missing
    kill -0 "$(cat /run/nginx.pid)" || fail nginx-inactive
}

assert_nginx_active() {
    assert_nginx_process_active
    /usr/sbin/nginx -t >/dev/null 2>&1 || fail nginx-config-invalid
}

assert_manual_rollback_terminal() {
    cmp -s "$test_root/aifeeds.conf.original" /etc/nginx/sites-available/aifeeds.conf \
        || fail manual-site-not-base
    test "$(stat -c '%a %U %G' /etc/nginx/sites-available/aifeeds.conf)" = '644 root root' \
        || fail manual-site-metadata
    manual_absent_paths=(
        /etc/nginx/conf.d/aifeeds-performance-log.conf
        /etc/aifeeds-performance-logrotate.conf
        /usr/local/sbin/aifeeds-check-nginx-request-id
        /usr/local/sbin/aifeeds-verify-nginx-request-id-diff
        /usr/local/sbin/aifeeds-insert-nginx-request-id
        /etc/systemd/system/aifeeds-performance-logrotate.service
        /etc/systemd/system/aifeeds-performance-logrotate.timer
        /var/lib/aifeeds-performance-logrotate
    )
    for path in "${manual_absent_paths[@]}"; do
        if [ -e "$path" ] || [ -L "$path" ]; then
            fail "manual-artifact-remained:${path##*/}"
        fi
    done
    test -z "$(find /var/log/nginx -maxdepth 1 -name 'aifeeds-performance.jsonl*' -print -quit)" \
        || fail manual-live-log-remained
    test ! -e "$test_root/systemctl/timer.active" || fail manual-timer-active
    test ! -e "$test_root/systemctl/timer.enabled" || fail manual-timer-enabled
    test -s "$recovery_manual_summary" || fail manual-summary-missing
    test "$(stat -c '%a %U %G' "$recovery_manual_summary")" = '600 root root' \
        || fail manual-summary-metadata
    case "$recovery_initial_phase" in
        committed)
            test -e "$test_root/mutation-started-verified" || fail committed-mutation-started-not-verified
            test -s "$staging/gl-a-summary.json" || fail committed-install-summary-missing
            test "$(stat -c '%a %U %G' "$staging/gl-a-summary.json")" = '600 root root' \
                || fail committed-install-summary-metadata
            test "$(sha256sum "$staging/gl-a-summary.json" | awk '{print $1}')" = \
                "$install_summary_sha_before_rollback" || fail committed-install-summary-changed
            ;;
        mutation_started)
            test -e "$test_root/mutation-started-verified" || fail mutation-started-phase-not-verified
            test ! -e "$staging/gl-a-summary.json" || fail mutation-started-install-summary-present
            ;;
        backup_created)
            test ! -e "$test_root/mutation-started-verified" || fail backup-created-reached-mutation-started
            test ! -e "$staging/gl-a-summary.json" || fail backup-created-install-summary-present
            ;;
        mutated)
            test -e "$test_root/mutation-started-verified" || fail mutated-phase-not-verified
            test ! -e "$staging/gl-a-summary.json" || fail mutated-install-summary-present
            ;;
        prepared)
            test ! -e "$test_root/mutation-started-verified" || fail prepared-reached-mutation-started
            test ! -e "$staging/gl-a-summary.json" || fail prepared-install-summary-present
            ;;
        initializing)
            test ! -e "$test_root/mutation-started-verified" || fail initializing-reached-mutation-started
            test ! -e "$staging/gl-a-summary.json" || fail initializing-install-summary-present
            ;;
        *) fail "manual-initial-phase:$recovery_initial_phase" ;;
    esac
    test -f "$recovery_source_journal" || fail manual-source-journal-missing
    test ! -L "$recovery_source_journal" || fail manual-source-journal-symlink
    test "$(stat -c '%a %U %G' "$recovery_source_journal")" = '600 root root' \
        || fail manual-source-journal-metadata
    test -f "$recovery_rollback_journal" || fail manual-rollback-journal-missing
    test ! -L "$recovery_rollback_journal" || fail manual-rollback-journal-symlink
    test "$(stat -c '%a %U %G' "$recovery_rollback_journal")" = '600 root root' \
        || fail manual-rollback-journal-metadata
    jq -e --arg rollback "$recovery_rollback_journal" --arg origin "$recovery_initial_phase" '
        .schema == 1 and .gate == "GL-a" and .phase == "rolled_back"
        and .rollback_journal == $rollback and .rollback_origin_phase == $origin
    ' "$recovery_source_journal" >/dev/null || fail manual-source-journal-terminal
    assert_gl_a_journal_identity "$recovery_source_journal" rolled_back
    expected_rollback_commit_marker="/var/backups/aifeeds-performance-log/rollback-commit-${recovery_transaction_id}.json"
    settled_source_sha=$(jq -er '.source_before_sha256' "$expected_rollback_commit_marker") \
        || fail manual-source-before-sha
    jq -e \
        --arg source "$recovery_source_journal" \
        --arg source_sha "$settled_source_sha" \
        --arg origin "$recovery_initial_phase" \
        --arg operation_id "$operation_id" \
        --arg g0_commit "$g0_commit" \
        --arg helper_sha "$rollback_helper_sha" \
        --argjson artifacts "$artifacts_sha256_json" \
        --argjson candidates "$artifact_candidates_json" \
        --arg rollback_candidate "$recovery_rollback_candidate" \
        --arg audit "/var/backups/aifeeds-performance-log/audit-${recovery_transaction_id}" \
        --arg backup "$recovery_backup" \
        --arg backup_sha "$recovery_backup_sha" \
        --arg installed_sha "$recovery_installed_sha" \
        --argjson site_uid "$recovery_site_uid" \
        --argjson site_gid "$recovery_site_gid" \
        --arg site_mode "$recovery_site_mode" '
        .schema == 1 and .gate == "GL-a-manual-rollback" and .phase == "rolled_back"
        and .operation_id == $operation_id and .g0_commit == $g0_commit
        and .rollback_helper_sha256 == $helper_sha
        and .artifacts_sha256 == $artifacts and .artifact_candidates == $candidates
        and .source_journal == $source and .source_journal_sha256 == $source_sha
        and .source_origin_phase == $origin
        and .rollback_candidate == $rollback_candidate
        and .audit_dir == $audit
        and .site_backup == $backup and .site_backup_sha256 == $backup_sha
        and .installed_site_sha256 == $installed_sha
        and .original_site_uid == $site_uid and .original_site_gid == $site_gid
        and .original_site_mode == $site_mode
    ' "$recovery_rollback_journal" >/dev/null || fail manual-rollback-journal-terminal
    test "$(sha256sum "$recovery_source_journal" | awk '{print $1}')" != "$recovery_source_sha" \
        || fail manual-source-journal-not-updated
    expected_audit_dir="/var/backups/aifeeds-performance-log/audit-${recovery_transaction_id}"
    expected_archive_manifest="${expected_audit_dir}/archive-manifest.json"
    for evidence_file in "$expected_archive_manifest" "$expected_rollback_commit_marker"; do
        test -f "$evidence_file" || fail "manual-evidence-missing:${evidence_file##*/}"
        test ! -L "$evidence_file" || fail "manual-evidence-symlink:${evidence_file##*/}"
        test "$(stat -c '%a %U %G' "$evidence_file")" = '600 root root' \
            || fail "manual-evidence-metadata:${evidence_file##*/}"
    done
    archive_manifest_sha=$(sha256sum "$expected_archive_manifest" | awk '{print $1}')
    archive_manifest_generation=$(jq -er '.generation' "$expected_archive_manifest")
    archive_manifest_entry_count=$(jq -er '.entries | length' "$expected_archive_manifest")
    rollback_commit_marker_sha=$(sha256sum "$expected_rollback_commit_marker" | awk '{print $1}')
    for evidence_sha in "$archive_manifest_sha" "$rollback_commit_marker_sha"; do
        printf '%s' "$evidence_sha" | grep -Eq '^[a-f0-9]{64}$' \
            || fail manual-evidence-sha-format
    done
    jq -e --arg operation_id "$recovery_transaction_id" \
        --arg source "$recovery_source_journal" \
        --arg rollback "$recovery_rollback_journal" \
        --arg marker "$expected_rollback_commit_marker" \
        --arg source_sha "$(sha256sum "$recovery_source_journal" | awk '{print $1}')" \
        --arg rollback_sha "$(sha256sum "$recovery_rollback_journal" | awk '{print $1}')" '
        .schema == 1 and .gate == "GL-a-terminal-pair" and .phase == "committed" and
        .operation_id == $operation_id and .source_journal == $source and
        .rollback_journal == $rollback and .rollback_commit_marker == $marker and
        .source_journal_terminal_sha256 == $source_sha and
        .rollback_journal_terminal_sha256 == $rollback_sha' \
        "$expected_rollback_commit_marker" >/dev/null || fail manual-commit-marker-physical-link
    jq -e \
        --arg source "$recovery_source_journal" \
        --arg rollback "$recovery_rollback_journal" \
        --arg operation_id "$operation_id" \
        --arg g0_commit "$g0_commit" \
        --arg helper_sha "$rollback_helper_sha" \
        --arg backup_sha "$recovery_backup_sha" \
        --arg rollback_candidate "$recovery_rollback_candidate" \
        --arg audit "$expected_audit_dir" \
        --arg archive "$expected_archive_manifest" \
        --arg archive_sha "$archive_manifest_sha" \
        --argjson archive_generation "$archive_manifest_generation" \
        --argjson archive_entry_count "$archive_manifest_entry_count" \
        --arg marker "$expected_rollback_commit_marker" \
        --arg marker_sha "$rollback_commit_marker_sha" \
        --argjson artifacts "$artifacts_sha256_json" \
        --argjson candidates "$artifact_candidates_json" '
        .schema == 1 and .gate == "GL-a-manual-rollback"
        and .operation_id == $operation_id and .g0_commit == $g0_commit
        and .rollback_helper_sha256 == $helper_sha
        and .backup_sha256 == $backup_sha and .artifacts_sha256 == $artifacts
        and .artifact_candidates == $candidates
        and .source_journal == $source and .rollback_journal == $rollback
        and .rollback_candidate == $rollback_candidate
        and .audit_dir == $audit
        and .log_archive_manifest == $archive
        and .log_archive_manifest_sha256 == $archive_sha
        and .log_archive_manifest_generation == $archive_generation
        and .log_archive_manifest_entry_count == $archive_entry_count
        and .rollback_commit_marker == $marker
        and .rollback_commit_marker_sha256 == $marker_sha
        and .site_restored == true and .metadata_restored == true
        and .timer_inactive == true and .service_inactive == true
        and .nginx_active == true and .front_status == 200 and .api_status == 200
    ' "$recovery_manual_summary" >/dev/null || fail manual-summary-shape
    expected_rollback_journal="/var/backups/aifeeds-performance-log/rollback-transaction-${recovery_transaction_id}.json"
    test "$recovery_rollback_journal" = "$expected_rollback_journal" \
        || fail manual-rollback-journal-not-deterministic
    audit_dir=$(jq -er '.audit_dir' "$recovery_manual_summary")
    test "$audit_dir" = "$expected_audit_dir" \
        || fail manual-audit-not-deterministic
    test -d "$audit_dir" || fail manual-audit-dir-missing
    test ! -L "$audit_dir" || fail manual-audit-dir-symlink
    test "$(stat -c '%a %U %G' "$audit_dir")" = '700 root root' \
        || fail manual-audit-dir-metadata
    assert_no_audit_candidates "$audit_dir" "$recovery_transaction_id"
    expected_backup_present=true
    case "$recovery_initial_phase" in initializing|prepared) expected_backup_present=false ;; esac
    test "$(jq -er '.backup_present' "$recovery_manual_summary")" = "$expected_backup_present" \
        || fail manual-summary-backup-presence
    if [ "$expected_backup_present" = true ]; then
        test -f "$recovery_backup" || fail manual-backup-missing
        test "$(sha256sum "$recovery_backup" | awk '{print $1}')" = "$recovery_backup_sha" \
            || fail manual-backup-hash
        test "$(stat -c '%u %g %a' "$recovery_backup")" = \
            "$recovery_site_uid $recovery_site_gid $recovery_site_mode" \
            || fail manual-backup-metadata
    else
        test ! -e "$recovery_backup" || fail manual-early-backup-present
        test ! -L "$recovery_backup" || fail manual-early-backup-symlink
    fi
    test "$(jq -er '.source_journal_terminal_sha256' "$recovery_manual_summary")" = \
        "$(sha256sum "$recovery_source_journal" | awk '{print $1}')" \
        || fail manual-summary-source-terminal-sha
    test "$(jq -er '.rollback_journal_sha256' "$recovery_manual_summary")" = \
        "$(sha256sum "$recovery_rollback_journal" | awk '{print $1}')" \
        || fail manual-summary-rollback-journal-sha
    test "$(jq -cS '.artifacts_sha256' "$recovery_manual_summary")" = \
        "$(jq -cS . <<< "$artifacts_sha256_json")" || fail manual-summary-artifacts-sha
    test "$(jq -cS '.artifact_candidates' "$recovery_manual_summary")" = \
        "$(jq -cS . <<< "$artifact_candidates_json")" || fail manual-summary-artifact-candidates
    expected_first_resumed=${c_expected_first_resumed:-0}
    if [ -z "${c_expected_first_resumed+x}" ]; then
        case "$scenario" in
            manual-recovery-terminal-pair-marker|terminal-pair-source-only|terminal-pair-rollback-only|terminal-pair-committed-marker-tmp)
                expected_first_resumed=1
                ;;
        esac
    fi
    grep -Fq "manual_rollback=pass resumed=${expected_first_resumed}" "$manual_output" \
        || fail manual-first-pass-marker
    grep -Fq 'manual_rollback=pass resumed=1' "$manual_reentry_output" \
        || fail manual-reentry-pass-marker
    assert_manual_candidates_absent
    assert_nginx_active
}

assert_real_logrotate_fd_rotation_and_verify() {
    local journal anchor logrotate generation_before generation_after verify_output
    local service_line
    local -a service_command
    journal="/var/backups/aifeeds-performance-log/transaction-${operation_id}.json"
    anchor="/var/backups/aifeeds-performance-log/rotation-anchor-${operation_id}.json"
    logrotate=$(jq -cer '.logrotate' "$anchor")
    jq -e --arg operation_id "$operation_id" '
        .schema == 2 and .operation_id == $operation_id and
        (.logrotate | keys | sort) == ["dev","gid","ino","mode","path","sha256","size","uid"] and
        .logrotate.path == "/usr/sbin/logrotate" and
        .logrotate.uid == 0 and .logrotate.gid == 0 and .logrotate.mode == "755"
    ' "$anchor" >/dev/null || fail real-logrotate-authority-shape
    test "$(stat -c '%d %i %u %g %a %s' /usr/sbin/logrotate)" = \
        "$(jq -r '[.dev,.ino,.uid,.gid,.mode,.size] | map(tostring) | join(" ")' \
            <<< "$logrotate")" || fail real-logrotate-authority-metadata
    test "$(sha256sum /usr/sbin/logrotate | awk '{print $1}')" = \
        "$(jq -er '.sha256' <<< "$logrotate")" || fail real-logrotate-authority-hash
    python3 - /usr/local/sbin/aifeeds-check-nginx-request-id /usr/sbin/logrotate <<'PY'
import importlib.util
import importlib.machinery
import os
import pathlib
import sys

checker, logrotate = map(pathlib.Path, sys.argv[1:])
with open(logrotate, "rb") as source:
    if source.read(4) != b"\x7fELF":
        raise SystemExit("authorized logrotate is not the real ELF binary")
loader = importlib.machinery.SourceFileLoader("aifeeds_installed_checker", str(checker))
spec = importlib.util.spec_from_loader(loader.name, loader)
if spec is None or spec.loader is None:
    raise SystemExit("cannot load installed checker")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
descriptor = os.open(logrotate, os.O_RDONLY | os.O_NOFOLLOW)
try:
    expected = f"/proc/self/fd/{descriptor}"
    if module._fd_runtime_path(descriptor) != expected:
        raise SystemExit("Linux runtime did not select procfs executable FD")
finally:
    os.close(descriptor)
PY
    generation_before=$(rotation_ledger_generation)
    rm -f "$test_root/systemctl/service.succeeded"
    systemctl start aifeeds-performance-logrotate.service
    test -e "$test_root/systemctl/service.succeeded" || fail real-logrotate-service-marker
    generation_after=$(rotation_ledger_generation)
    test "$generation_after" -eq "$((generation_before + 1))" \
        || fail real-logrotate-timer-generation
    service_line=$(sed -n 's/^ExecStart=//p' \
        /etc/systemd/system/aifeeds-performance-logrotate.service)
    read -r -a service_command <<< "$service_line"
    test "${#service_command[@]}" -eq 16 || fail real-logrotate-verify-argv-count
    service_command[1]=rotation-verify
    verify_output="$test_root/rotation-verify.json"
    "${service_command[@]}" > "$verify_output"
    jq -e --argjson generation "$generation_after" '
        .generation == $generation and .ledger.path ==
        "/var/lib/aifeeds-performance-logrotate/rotation-provenance.jsonl" and
        .status.path == "/var/lib/aifeeds-performance-logrotate/status"
    ' "$verify_output" >/dev/null || fail real-logrotate-verify-snapshot
    jq -e '.phase == "committed"' "$journal" >/dev/null || fail real-logrotate-source-phase
}

assert_success() {
    test "$rc" -eq 0 || fail "success-rc-$rc"
    grep -Fq 'gl_a=pass ' "$output" || fail success-marker
    test -e "$test_root/mutation-started-verified" || fail success-mutation-started-not-verified
    test -s "$staging/gl-a-summary.json" || fail summary-missing
    test "$(stat -c '%a %U %G' "$staging/gl-a-summary.json")" = '600 root root' \
        || fail summary-metadata
    jq -e \
        --arg operation_id "$operation_id" \
        --arg g0_commit "$g0_commit" \
        --arg helper_sha "$rollback_helper_sha" '
        .schema == 1 and .gate == "GL-a"
        and .operation_id == $operation_id and .g0_commit == $g0_commit
        and .rollback_helper_sha256 == $helper_sha
        and .front_status == 200 and .api_status == 200
        and .json_schema == true and .unique_probe == true and .rotation_probe == true
        and .nginx_active == true and .timer_active == true
        and .worker_join == "deferred_to_GL-b"
    ' "$staging/gl-a-summary.json" >/dev/null || fail summary-shape
    test "$(grep -Eic '^[[:space:]]*proxy_set_header[[:space:]]+X-Request-Id[[:space:]]+\$request_id;' /etc/nginx/sites-available/aifeeds.conf)" -eq 7 \
        || fail request-id-count
    test -s /var/log/nginx/aifeeds-performance.jsonl || fail performance-log-empty
    jq -s -e '
        [ .[] | select(.perf_probe != "-") ]
        | group_by(.perf_probe)
        | any(.[]; length == 2
            and any(.[]; .host == "ai-feeds.com" and .uri == "/")
            and any(.[]; .host == "api.ai-feeds.com" and .uri == "/api/items"))
    ' /var/log/nginx/aifeeds-performance.jsonl >/dev/null || fail live-probe-pair-missing
    test -s /var/lib/aifeeds-performance-logrotate/status || fail rotate-state-empty
    test -e "$test_root/systemctl/timer.active" || fail timer-inactive
    test -e "$test_root/systemctl/timer.enabled" || fail timer-disabled
    journal=$(find /var/backups/aifeeds-performance-log -maxdepth 1 -type f -name 'transaction-*.json')
    test -n "$journal" || fail journal-missing
    test "$(find /var/backups/aifeeds-performance-log -maxdepth 1 -type f -name 'transaction-*.json' | wc -l)" -eq 1 \
        || fail journal-count
    jq -e '.gate == "GL-a" and .phase == "committed"' "$journal" >/dev/null \
        || fail journal-not-committed
    assert_gl_a_journal_identity "$journal" committed
    assert_gl_a_summary_identity "$staging/gl-a-summary.json"
    test "$(stat -c '%a %U %G' "$journal")" = '600 root root' || fail journal-metadata
    backup=$(jq -er '.site_backup' "$staging/gl-a-summary.json")
    test -f "$backup" || fail backup-missing
    test ! -L "$backup" || fail backup-symlink
    test "$(stat -c '%a %U %G' "$backup")" = '644 root root' || fail backup-metadata
    test "$(sha256sum "$backup" | awk '{print $1}')" = "$(jq -er '.site_backup_sha256' "$staging/gl-a-summary.json")" \
        || fail backup-hash
    test "$(sha256sum /etc/nginx/sites-available/aifeeds.conf | awk '{print $1}')" = "$(jq -er '.installed_site_sha256' "$staging/gl-a-summary.json")" \
        || fail installed-site-hash
    test "$(stat -c '%a %U %G' /var/backups/aifeeds-performance-log)" = '700 root root' \
        || fail backup-dir-metadata
    test "$(stat -c '%a %U %G' /var/log/nginx/aifeeds-performance.jsonl)" = '640 www-data adm' \
        || fail performance-log-metadata
    test "$(stat -c '%a %U %G' /etc/aifeeds-performance-logrotate.conf)" = '644 root root' \
        || fail rotate-config-metadata
    test "$(stat -c '%a %U %G' /etc/nginx/conf.d/aifeeds-performance-log.conf)" = '644 root root' \
        || fail performance-config-metadata
    test ! -e "/etc/nginx/sites-available/aifeeds.conf.candidate-gl-a-${operation_id}" \
        || fail success-site-candidate-remained
    test ! -L "/etc/nginx/sites-available/aifeeds.conf.candidate-gl-a-${operation_id}" \
        || fail success-site-candidate-symlink
    assert_artifact_candidates_absent
    assert_nginx_active
    if [ "$scenario" = success ]; then
        assert_real_logrotate_fd_rotation_and_verify
    fi
}

assert_rollback() {
    local expected_phase=$1 expected_source_phase=$1
    local live_log=/var/log/nginx/aifeeds-performance.jsonl rollback_journal
    local expected_log_identity observed_log_identity
    if [ "$expected_phase" = rollback_failed ]; then
        expected_source_phase=mutated
    fi
    test "$rc" -ne 0 || fail failure-returned-zero
    test -e "$test_root/mutation-started-verified" || fail rollback-mutation-started-not-verified
    cmp -s "$test_root/aifeeds.conf.original" /etc/nginx/sites-available/aifeeds.conf \
        || fail site-not-restored
    test "$(stat -c '%a %U %G' /etc/nginx/sites-available/aifeeds.conf)" = '644 root root' \
        || fail site-metadata-not-restored
    test "$(grep -Eic '^[[:space:]]*proxy_set_header[[:space:]]+X-Request-Id' /etc/nginx/sites-available/aifeeds.conf || true)" -eq 0 \
        || fail request-id-remained
    absent_paths=(
        /etc/nginx/conf.d/aifeeds-performance-log.conf
        /etc/aifeeds-performance-logrotate.conf
        /usr/local/sbin/aifeeds-check-nginx-request-id
        /usr/local/sbin/aifeeds-verify-nginx-request-id-diff
        /usr/local/sbin/aifeeds-insert-nginx-request-id
        /etc/systemd/system/aifeeds-performance-logrotate.service
        /etc/systemd/system/aifeeds-performance-logrotate.timer
        /var/lib/aifeeds-performance-logrotate
    )
    for path in "${absent_paths[@]}"; do
        if [ -e "$path" ] || [ -L "$path" ]; then fail "artifact-remained:${path##*/}"; fi
    done
    if [ "$expected_phase" != rollback_failed ] \
        && { [ -e "$live_log" ] || [ -L "$live_log" ]; }; then
        fail "artifact-remained:${live_log##*/}"
    fi
    test ! -e "$staging/gl-a-summary.json" || fail rollback-summary-remained
    test ! -e "$staging/gl-a-summary.json.tmp" || fail rollback-summary-tmp-remained
    test ! -e "$test_root/systemctl/timer.active" || fail rollback-timer-active
    test ! -e "$test_root/systemctl/timer.enabled" || fail rollback-timer-enabled
    backup=$(find /var/backups/aifeeds-performance-log -maxdepth 1 -type f -name 'aifeeds.conf.bak-perf-*')
    test -n "$backup" || fail backup-missing
    test "$(find /var/backups/aifeeds-performance-log -maxdepth 1 -type f -name 'aifeeds.conf.bak-perf-*' | wc -l)" -eq 1 \
        || fail backup-count
    cmp -s "$test_root/aifeeds.conf.original" "$backup" || fail backup-content
    test "$(stat -c '%a %U %G' "$backup")" = '644 root root' || fail backup-metadata
    test "$(stat -c '%a %U %G' /var/backups/aifeeds-performance-log)" = '700 root root' \
        || fail backup-dir-metadata
    journal=$(find /var/backups/aifeeds-performance-log -maxdepth 1 -type f -name 'transaction-*.json')
    test -n "$journal" || fail journal-missing
    test "$(find /var/backups/aifeeds-performance-log -maxdepth 1 -type f -name 'transaction-*.json' | wc -l)" -eq 1 \
        || fail journal-count
    jq -e --arg phase "$expected_source_phase" '.gate == "GL-a" and .phase == $phase' \
        "$journal" >/dev/null || fail "journal-phase-$expected_source_phase"
    assert_gl_a_journal_identity "$journal" "$expected_source_phase"
    test "$(stat -c '%a %U %G' "$journal")" = '600 root root' || fail journal-metadata
    if [ "$expected_phase" = rollback_failed ]; then
        rollback_journal="/var/backups/aifeeds-performance-log/rollback-transaction-${operation_id}.json"
        test -f "$rollback_journal" && test ! -L "$rollback_journal" \
            || fail rollback-failed-journal-missing
        jq -e --arg log "$live_log" '
            .phase == "rollback_failed" and .failed_from == "runtime_removed" and
            ((has("log_archive_manifest_sha256") or
              has("log_archive_manifest_generation") or
              has("log_archive_manifest_entry_count")) | not) and
            .runtime_cleanup.cursor_state == "complete" and
            .runtime_cleanup.cursor == (.runtime_cleanup.items | length) and
            ([.runtime_cleanup.items[] | select(
              .slot == "log" and .action == "archive_handoff" and
              .selected_path == $log and .kind == "file" and
              (.identity | keys | sort) == ["dev","gid","ino","mode","uid"]
            )] | length) == 1
        ' "$rollback_journal" >/dev/null || fail rollback-live-log-handoff-plan
        test -f "$live_log" && test ! -L "$live_log" \
            || fail rollback-live-log-handoff-missing
        expected_log_identity="$(jq -r '
            .runtime_cleanup.items[] | select(.slot == "log") |
            [.identity.uid,.identity.gid,.identity.mode,.identity.dev,.identity.ino] |
            map(tostring) | join(" ")
        ' "$rollback_journal")"
        observed_log_identity="$(stat -c '%u %g %a %d %i' "$live_log")"
        test "$observed_log_identity" = "$expected_log_identity" \
            || fail rollback-live-log-handoff-identity
    fi
    if [ "$expected_phase" = rollback_failed ]; then
        audit_dir="/var/backups/aifeeds-performance-log/audit-${operation_id}"
        test ! -e "$audit_dir" && test ! -L "$audit_dir" \
            || fail rollback-failed-audit-premature
    else
        audit_dir=$(find /var/backups/aifeeds-performance-log -mindepth 1 -maxdepth 1 \
            -type d -name 'audit-*')
        test -n "$audit_dir" || fail audit-dir-missing
        test "$(find /var/backups/aifeeds-performance-log -mindepth 1 -maxdepth 1 -type d -name 'audit-*' | wc -l)" -eq 1 \
            || fail audit-dir-count
        test "$(stat -c '%a %U %G' "$audit_dir")" = '700 root root' || fail audit-dir-metadata
        test "$(find "$audit_dir" -mindepth 1 -maxdepth 1 -type f | wc -l)" -ge 1 \
            || fail audit-log-missing
        while IFS= read -r audit_log; do
            test "$(stat -c '%a %U %G' "$audit_log")" = '600 root root' \
                || fail audit-log-metadata
        done < <(find "$audit_dir" -mindepth 1 -maxdepth 1 -type f)
    fi
    test ! -e "/etc/nginx/sites-available/aifeeds.conf.rollback-gl-a-${operation_id}" \
        || fail rollback-candidate-remained
    test ! -L "/etc/nginx/sites-available/aifeeds.conf.rollback-gl-a-${operation_id}" \
        || fail rollback-candidate-symlink
    test ! -e "/etc/nginx/sites-available/aifeeds.conf.candidate-gl-a-${operation_id}" \
        || fail site-candidate-remained
    test ! -L "/etc/nginx/sites-available/aifeeds.conf.candidate-gl-a-${operation_id}" \
        || fail site-candidate-symlink
    assert_artifact_candidates_absent
    if [ "$expected_phase" != rollback_failed ]; then
        assert_no_audit_candidates "$audit_dir" "$operation_id"
    fi
    assert_nginx_active
}

if [ -n "${c_case_terminal+x}" ]; then
    if [ "$c_case_terminal" -eq 1 ]; then
        assert_manual_rollback_terminal
    else
        assert_nginx_active
    fi
else
case "$scenario" in
    exceptional-*)
        assert_exact_terminal_pair "$operation_id"
        exceptional_authority_final="/var/backups/aifeeds-performance-log/exceptional-recovery-authority-${operation_id}.json"
        exceptional_receipt="/var/backups/aifeeds-performance-log/exceptional-recovery-receipt-${operation_id}.json"
        test -f "$exceptional_authority_final" && test ! -L "$exceptional_authority_final" \
            || fail exceptional-authority-not-durable
        test -f "$exceptional_receipt" && test ! -L "$exceptional_receipt" \
            || fail exceptional-receipt-missing
        test ! -e "$staging/.exceptional-recovery-receipt-${operation_id}.render" \
            && test ! -L "$staging/.exceptional-recovery-receipt-${operation_id}.render" \
            || fail exceptional-receipt-render-remained
        test "$(stat -c '%u %g %a %h' "$exceptional_receipt")" = '0 0 600 1' \
            || fail exceptional-receipt-metadata
        terminal_source_sha=$(sha256sum "$recovery_source_journal" | awk '{print $1}')
        terminal_rollback_sha=$(sha256sum "$recovery_rollback_journal" | awk '{print $1}')
        terminal_marker="/var/backups/aifeeds-performance-log/rollback-commit-${operation_id}.json"
        terminal_marker_sha=$(sha256sum "$terminal_marker" | awk '{print $1}')
        jq -e \
            --arg operation_id "$operation_id" \
            --arg authority "$exceptional_authority_final" \
            --arg authority_sha "$(sha256sum "$exceptional_authority_final" | awk '{print $1}')" \
            --arg source "$recovery_source_journal" \
            --arg source_before "$recovery_source_sha" \
            --arg source_terminal "$terminal_source_sha" \
            --arg rollback "$recovery_rollback_journal" \
            --arg rollback_before "$recovery_rollback_sha" \
            --arg rollback_terminal "$terminal_rollback_sha" \
            --arg marker "$terminal_marker" --arg marker_sha "$terminal_marker_sha" \
            --arg transaction_helper "$transaction_helper_sha" \
            --arg executor "$rollback_helper_sha" '
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
        ' "$exceptional_receipt" >/dev/null || fail exceptional-receipt-contract
        terminal_namespace_before=$(terminal_pair_namespace_fingerprint "$operation_id")
        receipt_fingerprint=$(file_identity_fingerprint "$exceptional_receipt")
        manual_reentry_output="$test_root/exceptional-reentry.out"
        set +e
        /bin/bash "$rollback_helper" \
            "$staging" "$recovery_backup" "$recovery_backup_sha" \
            "$recovery_installed_sha" "$recovery_site_uid" "$recovery_site_gid" \
            "$recovery_site_mode" "$recovery_source_journal" "$recovery_source_sha" \
            "$exceptional_authority" > "$manual_reentry_output" 2>&1
        manual_reentry_rc=$?
        set -e
        test "$manual_reentry_rc" -eq 0 || fail "exceptional-reentry-rc-$manual_reentry_rc"
        grep -Fq 'manual_rollback=pass resumed=1' "$manual_reentry_output" \
            || fail exceptional-reentry-pass-marker
        test "$(terminal_pair_namespace_fingerprint "$operation_id")" = \
            "$terminal_namespace_before" || fail exceptional-reentry-terminal-changed
        assert_file_identity_fingerprint "$exceptional_receipt" "$receipt_fingerprint" \
            exceptional-reentry-receipt
        test "$(jq -er '.rollback_helper_sha256' "$recovery_source_journal")" = \
            "$transaction_helper_sha" || fail exceptional-source-helper-binding-changed
        cmp -s "$test_root/aifeeds.conf.original" /etc/nginx/sites-available/aifeeds.conf \
            || fail exceptional-site-not-base
        assert_artifact_candidates_absent
        test ! -e "/var/lib/aifeeds-performance-logrotate.candidate-gl-a-${operation_id}" \
            || fail exceptional-rotation-candidate-remained
        assert_nginx_active
        if [ "$scenario" = exceptional-recovery-initialized-candidate ]; then
            closure_operation_id=20260714000000-89abcdef
            closure_output="$test_root/exceptional-installer-closure.out"

            mv "$exceptional_receipt" "$test_root/exceptional-receipt.preserved"
            closure_rc=$(run_installer_for_operation "$closure_output" "$closure_operation_id")
            test "$closure_rc" -eq 76 || fail "exceptional-authority-only-rc-$closure_rc"
            grep -Fq 'ERROR recovery_required=1' "$closure_output" \
                || fail exceptional-authority-only-marker
            mv "$test_root/exceptional-receipt.preserved" "$exceptional_receipt"

            mv "$exceptional_authority_final" "$test_root/exceptional-authority.preserved"
            closure_rc=$(run_installer_for_operation "$closure_output" "$closure_operation_id")
            test "$closure_rc" -eq 76 || fail "exceptional-receipt-only-rc-$closure_rc"
            grep -Fq 'ERROR recovery_required=1' "$closure_output" \
                || fail exceptional-receipt-only-marker
            mv "$test_root/exceptional-authority.preserved" "$exceptional_authority_final"

            mv "$exceptional_receipt" "$test_root/exceptional-receipt.preserved"
            jq -cS '.source_terminal_sha256 = ("d" * 64)' \
                "$test_root/exceptional-receipt.preserved" > "$exceptional_receipt"
            chown root:root "$exceptional_receipt"
            chmod 0600 "$exceptional_receipt"
            closure_rc=$(run_installer_for_operation "$closure_output" "$closure_operation_id")
            test "$closure_rc" -eq 76 || fail "exceptional-receipt-drift-rc-$closure_rc"
            grep -Fq 'ERROR recovery_required=1' "$closure_output" \
                || fail exceptional-receipt-drift-marker
            rm -f "$exceptional_receipt"
            mv "$test_root/exceptional-receipt.preserved" "$exceptional_receipt"

            rm -f /usr/sbin/logrotate
            closure_rc=$(run_installer_for_operation "$closure_output" "$closure_operation_id")
            test "$closure_rc" -eq 69 || fail "exceptional-closed-preflight-rc-$closure_rc"
            grep -Fxq 'ERROR dependency=logrotate path=/usr/sbin/logrotate' "$closure_output" \
                || fail exceptional-closed-preflight-marker
            test ! -e "/var/backups/aifeeds-performance-log/transaction-${closure_operation_id}.json" \
                || fail exceptional-closed-new-journal
            test ! -e "/etc/nginx/sites-available/aifeeds.conf.candidate-gl-a-${closure_operation_id}" \
                || fail exceptional-closed-new-candidate
        fi
        ;;
    preflight-logrotate-missing)
        test "$rc" -ne 0 || fail preflight-logrotate-false-success
        grep -Fxq 'ERROR dependency=logrotate path=/usr/sbin/logrotate' "$output" \
            || fail preflight-logrotate-error-marker
        cmp -s "$test_root/aifeeds.conf.original" /etc/nginx/sites-available/aifeeds.conf \
            || fail preflight-logrotate-site-mutated
        test ! -e /var/backups/aifeeds-performance-log \
            || fail preflight-logrotate-backup-namespace-created
        test ! -L /var/backups/aifeeds-performance-log \
            || fail preflight-logrotate-backup-namespace-symlink
        test ! -e "/etc/nginx/sites-available/aifeeds.conf.candidate-gl-a-${operation_id}" \
            || fail preflight-logrotate-site-candidate-created
        assert_artifact_candidates_absent
        assert_nginx_active
        ;;
    proc-quiescence-permission-denied)
        assert_file_identity_fingerprint "$probe_target" "$probe_fingerprint" \
            proc-permission-terminal-target
        ;;
    success|concurrent-lock|rotation-config-samebytes-takeover|rotation-logrotate-samebytes-takeover|rotation-anchor-samebytes-takeover|rotation-ledger-samebytes-takeover|rotation-child-nonzero|rotation-child-sigkill) assert_success ;;
    manual-rollback-committed|manual-recovery-prepared|manual-recovery-initializing|manual-recovery-mutation-started|manual-recovery-site-swapped|manual-recovery-restore-candidate|manual-recovery-audit-log|manual-recovery-partial-backup|installer-journal-tmp-takeover|rollback-journal-tmp-takeover|systemd-missing-unit|manual-recovery-log-writer-tail|manual-recovery-log-writer-timeout|manual-recovery-terminal-pair-marker|archive-manifest-tmp-takeover|archive-manifest-previous-takeover|cross-filesystem-audit|crossfs-copied-crash-reentry|crossfs-published-crash-reentry|terminal-pair-source-only|terminal-pair-rollback-only|terminal-pair-committed-marker-tmp|archive-manifest-delete-crash-reentry|log-quarantine-delete-crash-reentry|site-displaced-delete-crash-reentry|terminal-previous-delete-crash-reentry|prelive-prepared-delete-crash-reentry|artifact-final-delete-crash-reentry|artifact-candidate-delete-crash-reentry|rotation-status-delete-crash-reentry)
        assert_manual_rollback_terminal
        ;;
    site-cas-internal-displaced-drift|manual-site-cas-internal-displaced-drift|restore-site-absent-samebytes-crash-reentry)
        assert_nginx_process_active
        ;;
    systemctl-is-active-error|systemctl-is-enabled-error|negative-probe-grep-error|negative-probe-find-error|manual-cleanup-drift|site-cas-live-drift|site-cas-candidate-drift|site-cas-internal-candidate-drift|manual-site-cas-internal-displaced-drift|manual-site-cas-internal-candidate-drift|preflight-journal-find-error|preflight-include-grep-error|archive-manifest-stale-tmp|archive-manifest-regressive-tmp|archive-manifest-unknown-final|archive-manifest-orphan-audit|archive-manifest-three-way-conflict|prelive-initializing-auto-rollback|prelive-initializing-validation-fail|prelive-prepared-auto-rollback|artifact-install-candidate-takeover|artifact-install-candidate-samebytes|artifact-install-destination-takeover|archive-manifest-previous-unknown-only|archive-manifest-previous-valid-only|archive-manifest-previous-restart-samebytes|archive-manifest-previous-internal-drift|archive-manifest-delete-takeover|log-quarantine-delete-takeover|site-displaced-delete-takeover|terminal-pair-committed-tmp-drift|terminal-source-post-marker-check-drift|terminal-source-destination-drift|terminal-rollback-destination-drift|terminal-pair-internal-marker-drift|artifact-final-delete-takeover|rotation-status-delete-takeover|partial-backup-destination-takeover|rotation-directory-candidate-takeover|crossfs-candidate-samebytes-takeover|crossfs-destination-samebytes-takeover)
        assert_nginx_active
        ;;
    reinstall-after-auto-rollback)
        test "$secondary_rc" -eq 0 || fail reinstall-secondary-not-terminal
        assert_nginx_active
        ;;
    terminal-pair-tamper)
        cmp -s "$test_root/aifeeds.conf.original" /etc/nginx/sites-available/aifeeds.conf \
            || fail tamper-site-changed
        assert_nginx_active
        ;;
    enabled-site-retarget-drift)
        test "$(jq -er '.phase' "$recovery_source_journal")" = committed \
            || fail enabled-drift-source-phase
        test -s "$staging/gl-a-summary.json" || fail enabled-drift-summary-missing
        test -s /run/nginx.pid || fail enabled-drift-nginx-pid-missing
        kill -0 "$(cat /run/nginx.pid)" || fail enabled-drift-nginx-inactive
        ;;
    manual-artifact-drift-terminal)
        test "$(stat -c '%a %U %G' "$recovery_source_journal")" = '600 root root' \
            || fail terminal-artifact-source-metadata
        test "$(stat -c '%a %U %G' "$recovery_rollback_journal")" = '600 root root' \
            || fail terminal-artifact-journal-metadata
        test "$(stat -c '%a %U %G' "$recovery_manual_summary")" = '600 root root' \
            || fail terminal-artifact-summary-metadata
        test "$(sha256sum "$staging/gl-a-summary.json" | awk '{print $1}')" = \
            "$drift_install_summary_sha" || fail terminal-artifact-install-summary-changed
        jq -e --arg rollback "$recovery_rollback_journal" '
            .phase == "rolled_back" and .rollback_origin_phase == "committed"
            and .rollback_journal == $rollback
        ' "$recovery_source_journal" >/dev/null || fail terminal-artifact-source-identity
        assert_gl_a_journal_identity "$recovery_source_journal" rolled_back
        jq -e \
            --arg operation_id "$operation_id" \
            --arg helper_sha "$rollback_helper_sha" \
            --arg rollback_candidate "$recovery_rollback_candidate" \
            --argjson artifacts "$artifacts_sha256_json" \
            --argjson candidates "$artifact_candidates_json" '
            .phase == "rolled_back" and .operation_id == $operation_id
            and .rollback_helper_sha256 == $helper_sha
            and .rollback_candidate == $rollback_candidate
            and .artifacts_sha256 == $artifacts and .artifact_candidates == $candidates
        ' "$recovery_rollback_journal" >/dev/null || fail terminal-artifact-journal-identity
        test "$(jq -er '.source_journal_terminal_sha256' "$recovery_manual_summary")" = \
            "$(sha256sum "$recovery_source_journal" | awk '{print $1}')" \
            || fail terminal-artifact-summary-source-sha
        test "$(jq -er '.rollback_journal_sha256' "$recovery_manual_summary")" = \
            "$(sha256sum "$recovery_rollback_journal" | awk '{print $1}')" \
            || fail terminal-artifact-summary-journal-sha
        test "$(jq -er '.backup_present' "$recovery_manual_summary")" = true \
            || fail terminal-artifact-summary-backup-presence
        test "$(jq -cS '.artifacts_sha256' "$recovery_manual_summary")" = \
            "$(jq -cS . <<< "$artifacts_sha256_json")" \
            || fail terminal-artifact-summary-artifacts
        test "$(jq -cS '.artifact_candidates' "$recovery_manual_summary")" = \
            "$(jq -cS . <<< "$artifact_candidates_json")" \
            || fail terminal-artifact-summary-candidates
        test "$(jq -er '.rollback_candidate' "$recovery_manual_summary")" = \
            "$recovery_rollback_candidate" || fail terminal-artifact-summary-rollback-candidate
        assert_no_audit_candidates "/var/backups/aifeeds-performance-log/audit-${operation_id}" \
            "$operation_id"
        assert_manual_candidates_absent
        test "$(readlink -f /etc/nginx/sites-enabled/aifeeds.conf)" = \
            /etc/nginx/sites-available/aifeeds.conf || fail terminal-artifact-enabled-site-drift
        test -s /run/nginx.pid || fail terminal-artifact-nginx-pid-missing
        kill -0 "$(cat /run/nginx.pid)" || fail terminal-artifact-nginx-inactive
        ;;
    rollback-daemon-reload-fail)
        test -e "$test_root/systemctl/deployment-reload-injected" || fail deployment-fault-marker
        test -e "$test_root/systemctl/rollback-daemon-reload-injected" || fail rollback-fault-marker
        grep -Fq 'injected deployment nginx reload failure' "$output" || fail deployment-fault-not-hit
        grep -Fq 'injected rollback daemon-reload failure' "$output" || fail rollback-fault-not-hit
        grep -Fq 'automatic_rollback=failed ' "$output" || fail rollback-failure-marker
        ! grep -Fq 'automatic_rollback=pass ' "$output" || fail rollback-false-pass
        assert_rollback rollback_failed
        ;;
    reload-fail)
        test -e "$test_root/systemctl/deployment-reload-injected" || fail reload-fault-marker
        grep -Fq 'injected deployment nginx reload failure' "$output" || fail reload-fault-not-hit
        grep -Fq 'automatic_rollback=pass ' "$output" || fail rollback-pass-marker
        assert_rollback rolled_back
        ;;
    probe-missing)
        test -e "$test_root/probe-missing-injected" || fail probe-missing-fault-marker
        grep -Fq 'automatic_rollback=pass ' "$output" || fail rollback-pass-marker
        assert_rollback rolled_back
        audit_dir=$(find /var/backups/aifeeds-performance-log -mindepth 1 -maxdepth 1 -type d -name 'audit-*')
        wait_for_fixed_pattern '"perf_probe":"-"' "$audit_dir"
        ;;
    logrotate-fail)
        test -e "$test_root/logrotate-force-injected" || fail logrotate-fault-marker
        grep -Fq 'injected logrotate force failure' "$output" || fail logrotate-fault-not-hit
        grep -Fq 'automatic_rollback=pass ' "$output" || fail rollback-pass-marker
        assert_rollback rolled_back
        ;;
    service-fail-status-tmp)
        test -e "$test_root/systemctl/service-status-tmp-injected" || fail service-status-tmp-fault-marker
        grep -Fq 'injected rotate service failure' "$output" || fail service-fault-not-hit
        grep -Fq 'automatic_rollback=failed ' "$output" || fail service-status-tmp-failure-marker
        ! grep -Fq 'automatic_rollback=pass ' "$output" || fail service-status-tmp-false-pass
        status_tmp=/var/lib/aifeeds-performance-logrotate/status.tmp
        test -f "$status_tmp" || fail service-status-tmp-missing
        status_tmp_fingerprint=$(file_identity_fingerprint "$status_tmp")
        journal="/var/backups/aifeeds-performance-log/transaction-${operation_id}.json"
        rollback_journal="/var/backups/aifeeds-performance-log/rollback-transaction-${operation_id}.json"
        source_sha=$(sha256sum "$journal" | awk '{print $1}')
        jq -e '.phase == "mutated"' "$journal" >/dev/null \
            || fail service-status-tmp-source-not-stable
        jq -e --arg source_sha "$source_sha" '
            .phase == "rollback_failed" and .failed_from == "prepared" and
            .source_journal_sha256 == $source_sha
        ' "$rollback_journal" >/dev/null || fail service-status-tmp-rollback-not-failed
        retry_output="$test_root/service-status-tmp-retry.out"
        retry_rc=$(run_installer "$retry_output")
        test "$retry_rc" -eq 76 || fail "service-status-tmp-retry-rc-$retry_rc"
        assert_file_identity_fingerprint "$status_tmp" "$status_tmp_fingerprint" \
            service-status-tmp-reentry
        assert_nginx_active
        ;;
    timer-partial-fail)
        test -e "$test_root/systemctl/timer-partial-injected" || fail timer-partial-fault-marker
        grep -Fq 'injected partial timer enable failure' "$output" || fail timer-fault-not-hit
        grep -Fq 'automatic_rollback=pass ' "$output" || fail rollback-pass-marker
        assert_rollback rolled_back
        ;;
    term)
        test -e "$test_root/term-ready" || fail term-fault-not-hit
        grep -Fq 'automatic_rollback=pass ' "$output" || fail rollback-pass-marker
        assert_rollback rolled_back
        ;;
    *)
        grep -Fq 'automatic_rollback=pass ' "$output" || fail rollback-pass-marker
        assert_rollback rolled_back
        ;;
esac
fi

assert_no_canary_leak
printf 'PASS scenario=%s rc=%s\n' "$scenario" "$rc"
