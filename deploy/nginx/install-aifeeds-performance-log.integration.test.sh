#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"
FIXTURE_DIR="$SCRIPT_DIR/test-fixtures/gl-a-installer"
BASE_DIGEST='sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90'
IMAGE="aifeeds-gl-a-installer-test:${BASE_DIGEST#sha256:}"
case "$(uname -s)" in
    Darwin) SNAPSHOT_PARENT=/private/tmp ;;
    *) SNAPSHOT_PARENT=/tmp ;;
esac
SNAPSHOT_ROOT="$(mktemp -d "$SNAPSHOT_PARENT/aifeeds-gl-a-installer.XXXXXX")"
cleanup_snapshot() { rm -rf "$SNAPSHOT_ROOT"; }
trap cleanup_snapshot EXIT HUP INT TERM
install -d -m 0700 "$SNAPSHOT_ROOT/deploy"
cp -a "$REPO_ROOT/deploy/nginx" "$SNAPSHOT_ROOT/deploy/nginx"
cp -a "$REPO_ROOT/deploy/systemd" "$SNAPSHOT_ROOT/deploy/systemd"

required_files=(
    Dockerfile
    run-scenario.sh
    aifeeds.conf
    backend.py
    shims/cp
    shims/curl
    shims/find
    shims/grep
    shims/install
    shims/logrotate
    shims/mv
    shims/sync
    shims/systemctl
)
for relative_path in "${required_files[@]}"; do
    test -f "$FIXTURE_DIR/$relative_path"
done
test -f "$SCRIPT_DIR/rollback-aifeeds-performance-log.sh"

docker build \
    --label "org.opencontainers.image.base.digest=$BASE_DIGEST" \
    --tag "$IMAGE" \
    --file "$FIXTURE_DIR/Dockerfile" \
    "$FIXTURE_DIR"

test "$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.base.digest" }}' "$IMAGE")" = "$BASE_DIGEST"
docker_server_os="$(docker info --format '{{.OSType}}')"
readonly docker_server_os

scenarios=(
    success
    reload-fail
    probe-missing
    logrotate-fail
    service-fail-status-tmp
    timer-partial-fail
    term
    rollback-daemon-reload-fail
    concurrent-lock
    manual-rollback-committed
    manual-recovery-prepared
    manual-recovery-initializing
    manual-recovery-mutation-started
    manual-recovery-site-swapped
    manual-recovery-restore-candidate
    manual-recovery-audit-log
    systemctl-is-active-error
    systemctl-is-enabled-error
    negative-probe-grep-error
    negative-probe-find-error
    reinstall-after-auto-rollback
    terminal-pair-tamper
    manual-cleanup-drift
    enabled-site-retarget-drift
    manual-artifact-drift-terminal
    manual-recovery-partial-backup
    installer-journal-tmp-takeover
    rollback-journal-tmp-takeover
    systemd-missing-unit
    site-cas-live-drift
    site-cas-candidate-drift
    manual-recovery-log-writer-tail
    manual-recovery-log-writer-timeout
    manual-recovery-terminal-pair-marker
    preflight-journal-find-error
    preflight-include-grep-error
    archive-manifest-tmp-takeover
    site-cas-internal-displaced-drift
    site-cas-internal-candidate-drift
    manual-site-cas-internal-displaced-drift
    manual-site-cas-internal-candidate-drift
    archive-manifest-stale-tmp
    archive-manifest-regressive-tmp
    archive-manifest-unknown-final
    archive-manifest-orphan-audit
    cross-filesystem-audit
    terminal-pair-source-only
    terminal-pair-rollback-only
    terminal-pair-committed-marker-tmp
    archive-manifest-previous-takeover
    archive-manifest-three-way-conflict
    artifact-install-candidate-takeover
    artifact-install-destination-takeover
    archive-manifest-previous-unknown-only
    archive-manifest-previous-valid-only
    archive-manifest-previous-restart-samebytes
    archive-manifest-previous-internal-drift
    terminal-pair-internal-marker-drift
    prelive-initializing-auto-rollback
    prelive-prepared-auto-rollback
    archive-manifest-delete-takeover
    log-quarantine-delete-takeover
    site-displaced-delete-takeover
    archive-manifest-delete-crash-reentry
    log-quarantine-delete-crash-reentry
    site-displaced-delete-crash-reentry
    terminal-pair-committed-tmp-drift
    terminal-source-destination-drift
    terminal-rollback-destination-drift
    terminal-previous-delete-crash-reentry
    prelive-initializing-validation-fail
    prelive-prepared-delete-crash-reentry
    artifact-install-candidate-samebytes
    artifact-final-delete-takeover
    artifact-final-delete-crash-reentry
    artifact-candidate-delete-crash-reentry
    rotation-status-delete-takeover
    rotation-status-delete-crash-reentry
    partial-backup-destination-takeover
    rotation-directory-candidate-takeover
    restore-site-absent-samebytes-crash-reentry
    crossfs-candidate-samebytes-takeover
    crossfs-destination-samebytes-takeover
    crossfs-copied-crash-reentry
    crossfs-published-crash-reentry
    proc-quiescence-permission-denied
    rotation-config-samebytes-takeover
    rotation-logrotate-samebytes-takeover
    rotation-anchor-samebytes-takeover
    rotation-ledger-samebytes-takeover
    rotation-child-nonzero
    rotation-child-sigkill
    journal-source-g-reentry
    journal-source-s1-reentry
    journal-source-s2-reentry
    journal-source-s3-reentry
    journal-source-s4-reentry
    journal-source-semantic-drift
    journal-source-samebytes-predecessor
    journal-source-partial-tmp
    journal-source-p-only
    journal-source-all-three
    journal-source-unknown-cleanup
    journal-rollback-g-reentry
    journal-rollback-s1-reentry
    journal-rollback-s2-reentry
    journal-rollback-s3-reentry
    journal-rollback-s4-reentry
    journal-rollback-semantic-drift
    journal-rollback-samebytes-predecessor
    journal-rollback-partial-tmp
    journal-rollback-p-only
    journal-rollback-all-three
    journal-rollback-unknown-cleanup
    terminal-pair-zero-side-reentry
    terminal-pair-one-side-reentry
    terminal-pair-two-side-reentry
    terminal-pair-pre-marker-reentry
    terminal-source-post-marker-check-drift
    terminal-source-p-bound-target-drift
    terminal-source-c-bound-target-drift
    cleanup-manual-detaching-reentry
    cleanup-manual-detached-reentry
    cleanup-automatic-detaching-reentry
    cleanup-automatic-detached-reentry
    cleanup-manual-unknown-tombstone
    cleanup-automatic-unknown-tombstone
    cleanup-manual-plan-drift
    cleanup-automatic-plan-drift
    cleanup-manual-failed-from-drift
    cleanup-automatic-failed-from-drift
    journal-source-legacy-genesis
    journal-rollback-legacy-genesis-rejected
    cleanup-manual-legacy-runtime-removed
    cleanup-automatic-legacy-runtime-removed
)

scenario_count=${#scenarios[@]}
scenario_passed=0
scenario_skipped=0
for scenario in "${scenarios[@]}"; do
    printf 'GL-a installer integration: %s\n' "$scenario"
    docker_args=(run --rm --network none)
    if [ "$scenario" != proc-quiescence-permission-denied ]; then
        docker_args+=(--cap-add SYS_PTRACE)
    fi
    docker_args+=(--security-opt no-new-privileges)
    case "$scenario" in
        cross-filesystem-audit|crossfs-candidate-samebytes-takeover|crossfs-destination-samebytes-takeover|crossfs-copied-crash-reentry|crossfs-published-crash-reentry|log-quarantine-delete-takeover)
        if [ "$docker_server_os" != linux ]; then
            printf 'GL-a installer integration: %s skipped (Docker server OSType=%s; Linux tmpfs required)\n' \
                "$scenario" "$docker_server_os"
            scenario_skipped=$((scenario_skipped + 1))
            continue
        fi
        docker_args+=(--tmpfs /var/backups/aifeeds-performance-log:rw,nosuid,nodev,noexec,mode=0700)
        ;;
    esac
    docker_args+=(
        --mount "type=bind,src=$SNAPSHOT_ROOT/deploy/nginx,dst=/workspace/deploy/nginx,readonly"
        --mount "type=bind,src=$SNAPSHOT_ROOT/deploy/systemd,dst=/workspace/deploy/systemd,readonly"
        "$IMAGE"
        /workspace/deploy/nginx/test-fixtures/gl-a-installer/run-scenario.sh "$scenario"
    )
    docker "${docker_args[@]}"
    scenario_passed=$((scenario_passed + 1))
done

printf 'GL-a installer integration: %s/%s scenarios passed\n' "$scenario_passed" "$scenario_count"
printf 'GL-a installer integration: %s/%s scenarios skipped\n' "$scenario_skipped" "$scenario_count"
