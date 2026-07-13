import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(here, 'rollback-aifeeds-performance-log.sh');
const installerPath = resolve(here, 'install-aifeeds-performance-log.sh');
const script = existsSync(scriptPath) ? readFileSync(scriptPath, 'utf8') : '';
const installer = existsSync(installerPath) ? readFileSync(installerPath, 'utf8') : '';

test('manual GL-a rollback is journaled, resumable, and drift-safe', () => {
  assert.ok(script, 'versioned rollback helper must exist');

  for (const required of [
    'set -euo pipefail',
    'LOCK=/run/aifeeds-performance-log.lock',
    'flock -n 9',
    'SOURCE_JOURNAL_SHA256',
    'ROLLBACK_HELPER_SHA256="$(sha256sum "$0"',
    'G0_COMMIT="$(jq -er \'.g0_commit\'',
    'operation_id',
    'rollback_helper_sha256',
    'ROLLBACK_JOURNAL=',
    'write_rollback_journal prepared',
    'write_rollback_journal site_restored',
    'write_rollback_journal logs_archived',
    'write_rollback_journal rolled_back',
    'write_rollback_journal rollback_failed',
    'os.fsync(parent_descriptor)',
    'formal_site_matches_state "$SITE" base',
    'formal_site_matches_state "$SITE" installed',
    'ERROR site_drift=1',
    'INSTALLER_CANDIDATE=',
    'INSTALLER_ROLLBACK_CANDIDATE=',
    'archive_performance_logs',
    'update_source_journal_rolled_back',
    'systemctl disable --now "$TIMER_UNIT"',
    'systemctl stop "$ROTATE_SERVICE"',
    'systemctl daemon-reload',
    'systemctl reload nginx',
    'systemctl is-active --quiet nginx',
    'front_status:200',
    'api_status:200',
    'gl-a-manual-rollback-summary.json',
    'ENABLED_SITE=/etc/nginx/sites-enabled/aifeeds.conf',
    'assert_enabled_site_target',
    'preflight_owned_runtime',
    'performance_logs_are_owned',
    'rotation_state_is_owned',
    'ARTIFACTS_SHA256_JSON=',
    'rollback_candidate:$rollback_candidate',
    'ROLLBACK_TERMINAL=0',
    'source_journal_terminal_sha256',
    'rollback_journal_sha256',
    'backup_present',
    'rollback_origin_phase',
    'incomplete-site-backup',
  ]) assert.ok(script.includes(required), `rollback helper missing ${required}`);

  assert.match(
    script,
    /write_rollback_journal prepared\n\nquiesce_rotation_control_plane/,
    'durable rollback journal must precede the first external mutation',
  );
  assert.ok(
    script.indexOf('update_source_journal_rolled_back')
      < script.indexOf('write_rollback_journal rolled_back'),
    'the original transaction must become terminal before rollback is declared complete',
  );
  assert.doesNotMatch(script, /rm\s+-rf\s+\/etc|rm\s+-f\s+\/etc\/[^\n]*[*?]/);
});

test('mutation_started recovery accepts owned partial transaction temps', () => {
  const earlyAbsenceGuard = script.match(
    /preflight_rotation_control_plane\ncase "\$SOURCE_ORIGIN_PHASE" in\n([\s\S]*?)\n\s*esac/,
  );

  assert.ok(earlyAbsenceGuard, 'early recovery absence guard must be explicit');
  assert.match(earlyAbsenceGuard[1], /initializing\|prepared\|backup_created\)/);
  assert.doesNotMatch(
    earlyAbsenceGuard[1],
    /mutation_started/,
    'mutation_started may already contain owned artifacts or transaction temps',
  );
  assert.ok(script.includes('mutation_started'));
  assert.ok(script.includes('transaction_temp_is_owned_or_absent'));
  assert.ok(script.includes('remove_transaction_temp'));
  assert.ok(script.includes('restore_candidate_is_owned_or_absent'));
  assert.ok(script.includes('assert_backup_unchanged'));
  assert.ok(script.includes('rollback_audit_is_terminal'));
  assert.ok(script.includes('ROLLBACK_CANDIDATE="${SITE}.rollback-gl-a-${TRANSACTION_ID}"'));
  const ownedTemp = script.match(/transaction_temp_is_owned_or_absent\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(ownedTemp, /transaction_temp_expected_sha256/);
  assert.match(ownedTemp, /path_matches_exact_identity/);
  assert.match(ownedTemp, /"\$final_metadata"/);
  assert.match(ownedTemp, /'root root 600'\) return 1/);
  assert.ok(
    script.includes('LOG_CANDIDATE="${LOG%/*}/.${LOG##*/}.candidate-gl-a-${TRANSACTION_ID}"'),
    'the rollback log candidate must stay outside the canonical live-log glob',
  );
});

test('manual SITE restore uses no-replace three-path CAS and never overwrites drift', () => {
  const cas = script.match(/publish_site_no_replace\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

  assert.ok(cas, 'rollback publish_site_no_replace helper must exist');
  assert.match(cas, /renameat2/);
  assert.match(cas, /RENAME_NOREPLACE/);
  assert.match(cas, /INSTALLER_CANDIDATE/);
  assert.match(cas, /EEXIST|File exists/);
  assert.ok(script.includes(
    'publish_site_no_replace "$SITE" "$ROLLBACK_CANDIDATE" "$INSTALLER_CANDIDATE" "$INSTALLED_SITE_SHA256" "$BACKUP_SHA256"',
  ));
  assert.doesNotMatch(script, /mv -f "\$ROLLBACK_CANDIDATE" "\$SITE"/);
  assert.doesNotMatch(cas, /RENAME_EXCHANGE/);
  assert.match(script, /installer_candidate/);
});

test('SITE-absent recovery requires both restore candidates to match journaled inodes', () => {
  const recovery = script.match(
    /if \[ ! -e "\$SITE" \] && \[ ! -L "\$SITE" \]; then([\s\S]*?)\nfi\n\nCURRENT_SITE_SHA256=/,
  )?.[1] ?? '';

  assert.ok(recovery, 'SITE-absent recovery branch must exist');
  for (const required of [
    'ROLLBACK_CANDIDATE_DEV',
    'ROLLBACK_CANDIDATE_INO',
    'INSTALLER_CANDIDATE_DEV',
    'INSTALLER_CANDIDATE_INO',
    'path_matches_exact_identity "$ROLLBACK_CANDIDATE"',
    'path_matches_exact_identity "$INSTALLER_CANDIDATE"',
  ]) assert.ok(recovery.includes(required), `SITE-absent recovery missing ${required}`);
  assert.ok(
    recovery.lastIndexOf('path_matches_exact_identity "$INSTALLER_CANDIDATE"')
      < recovery.indexOf('rename_no_replace "$ROLLBACK_CANDIDATE" "$SITE"'),
    'both candidate identities must be checked before SITE publication',
  );
});

test('manual SITE restore closes both internal rename drift windows without deleting conflicts', () => {
  const cas = script.match(/publish_site_no_replace\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

  for (const required of [
    'candidate_dev',
    'candidate_ino',
    'path_matches_exact_identity "$displaced"',
    'path_matches_exact_identity "$candidate"',
    'restore_displaced_site_no_replace "$site" "$displaced"',
    'preserve_published_candidate_and_restore_site',
    'sync -f "$displaced"',
    'sync -f "$candidate"',
  ]) assert.ok(cas.includes(required), `manual SITE CAS missing internal drift guard ${required}`);

  assert.ok(
    cas.lastIndexOf('path_matches_exact_identity "$candidate"')
      < cas.indexOf('rename_no_replace "$candidate" "$site"'),
    'manual candidate identity must be revalidated immediately before publication',
  );
  assert.doesNotMatch(cas, /rm\s+-f\s+"\$(site|candidate|displaced)"/);
});

test('manual SITE restore preserves and quiesces the displaced installed inode before cleanup', () => {
  for (const required of [
    'wait_for_writable_inode_quiescent',
    '/proc',
    'fdinfo',
    'O_ACCMODE',
    'remove_exact_quiescent_file',
    'original_site_dev',
    'original_site_ino',
    'INSTALLER_CANDIDATE_DEV',
    'INSTALLER_CANDIDATE_INO',
  ]) assert.ok(script.includes(required), `rollback helper missing displaced-inode guard ${required}`);

  const plan = script.match(/build_runtime_cleanup_plan\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  const unlink = script.match(/runtime_cleanup_unlink_item\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(plan.includes('add("site_installer", "delete"'));
  assert.ok(plan.includes('"dev": int(installer_dev), "ino": int(installer_ino)'));
  assert.ok(unlink.includes('before = os.fstat(descriptor)'));
  assert.ok(unlink.includes('after.st_nlink'));
  assert.doesNotMatch(script, /if \[ -e "\$INSTALLER_CANDIDATE" \]; then rm -f "\$INSTALLER_CANDIDATE"; fi/);
});

test('manual rollback treats systemd and negative-probe query errors as failures', () => {
  for (const required of [
    'unit_is_inactive',
    'timer_is_disabled',
    'no_performance_logs_present',
    'probe_absent_from_audit',
    'ensure_audit_dir_owned',
  ]) assert.ok(script.includes(required), `rollback helper missing fail-closed ${required}`);
  const quiesce = script.match(/quiesce_rotation_control_plane\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  for (const required of [
    'systemctl disable --now "$TIMER_UNIT"',
    'systemctl stop "$ROTATE_SERVICE"',
    'unit_is_inactive "$TIMER_UNIT"',
    'unit_is_inactive "$ROTATE_SERVICE"',
    'timer_is_disabled',
  ]) assert.ok(quiesce.includes(required), `manual rotation quiescence missing ${required}`);
  assert.doesNotMatch(quiesce, /\|\|\s*true/);
  const cleanup = script.slice(script.indexOf(
    'write_rollback_journal prepared\n\nquiesce_rotation_control_plane',
  ));
  assert.ok(
    cleanup.indexOf('quiesce_rotation_control_plane') < cleanup.indexOf('start_runtime_cleanup_plan'),
    'manual control plane must be quiescent before rotation state cleanup',
  );
  assert.ok(
    cleanup.indexOf('run_rotation_authorized_command rotation-recover')
      < cleanup.lastIndexOf('quiesce_rotation_control_plane'),
    'manual rollback must re-prove quiescence after rotation recovery',
  );
});

test('manual crash reentry accepts absent rotation state only after a durable cleanup phase', () => {
  const persist = script.match(/persist_rotation_state_identity\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.ok(script.includes('RESUME_ROLLBACK_PHASE'));
  assert.match(persist, /runtime_removed\|nginx_reloaded\|logs_archived/);
  assert.match(persist, /ROTATION_STATE_SNAPSHOT_JSON/);
  assert.doesNotMatch(
    persist.slice(0, persist.indexOf('return 0')),
    /rollback_failed/,
  );
});

test('manual rollback accepts inactive missing units but rejects rc4 control-plane failures', () => {
  const inactiveCheck = script.match(/unit_is_inactive\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

  assert.ok(inactiveCheck, 'rollback unit_is_inactive helper must exist');
  assert.match(inactiveCheck, /3:inactive\|4:inactive/);
  assert.doesNotMatch(inactiveCheck, /4:failed/);
});

test('manual safety inventories propagate find errors instead of hiding process-substitution rc', () => {
  assert.ok(script.includes('write_find_inventory'));
  assert.doesNotMatch(script, /done < <\(find\b/);
  assert.doesNotMatch(script, /\$\(find\b/);
});

test('manual log rollback uses journaled quarantine and writable-fd quiescence', () => {
  for (const required of [
    'LOG_QUARANTINE_SUFFIX',
    'ARCHIVE_MANIFEST',
    'record_log_archive_entry',
    'rename_no_replace "$log_path" "$quarantine"',
    'wait_for_writable_inode_quiescent "$quarantine"',
    'record_log_archive_quiescent',
    'record_log_archive_archived',
    'archive_manifest_is_terminal',
    'rename_no_replace "$destination_candidate" "$destination"',
  ]) assert.ok(script.includes(required), `rollback helper missing log quarantine contract ${required}`);

  assert.doesNotMatch(script, /rm -f "\$log_path"/);
  assert.doesNotMatch(script, /mv -f "\$destination_candidate" "\$destination"/);
  assert.match(script, /archive-manifest[.]json\|archive-manifest[.]json[.]tmp\)/);
  const terminalAudit = script.match(/rollback_audit_is_terminal\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.ok(terminalAudit.includes('test ! -e "$ARCHIVE_MANIFEST_TMP"'));
  assert.ok(terminalAudit.includes('archive_manifest_is_terminal'));
  assert.match(script, /LOG_QUIESCENCE_TIMEOUT_SECONDS=60/);
  assert.ok(script.includes(
    'wait_for_writable_inode_quiescent "$quarantine" "$log_dev" "$log_ino" "$LOG_QUIESCENCE_TIMEOUT_SECONDS"',
  ));
  const manifestCapture = script.match(
    /capture_archive_manifest_owned\(\) \{([\s\S]*?)\n\}\n\narchive_manifest_is_owned\(\)/,
  )?.[1] ?? '';
  const manifestWrapper = script.match(/archive_manifest_is_owned\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const manifestOwner = `${manifestCapture}\n${manifestWrapper}`;
  for (const required of ['split("/") | last', '"/var/backups/aifeeds-performance-log/audit-" + $operation_id', '".quarantine-gl-a-" + $operation_id']) {
    assert.ok(manifestOwner.includes(required), `manual manifest identity is not operation-bound: ${required}`);
  }
});

test('manual archive manifest takeover is generation-bound, monotonic, and terminally complete', () => {
  const manifestCapture = script.match(
    /capture_archive_manifest_owned\(\) \{([\s\S]*?)\n\}\n\narchive_manifest_is_owned\(\)/,
  )?.[1] ?? '';
  const manifestWrapper = script.match(/archive_manifest_is_owned\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const manifestOwner = `${manifestCapture}\n${manifestWrapper}`;
  const publisher = script.match(/publish_archive_manifest_tmp\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const terminal = script.match(/archive_manifest_is_terminal\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

  for (const required of ['generation', 'previous_manifest_sha256', 'previous_manifest_dev', 'previous_manifest_ino']) {
    assert.ok(manifestOwner.includes(required), `manual manifest ownership missing ${required}`);
  }
  for (const required of [
    'keys | sort',
    'final_mtime_s',
    'inventory_complete == false',
    'generation == (',
    'test("^A*(C|Q)?J*$")',
  ]) {
    assert.ok(manifestOwner.includes(required), `manual manifest exact schema missing ${required}`);
  }
  for (const required of [
    'archive_manifest_successor_is_valid',
    'archive_manifest_consumed_predecessor_is_valid',
    'ARCHIVE_MANIFEST_PREVIOUS',
    'restore_previous_manifest_no_replace',
    'rename_no_replace "$ARCHIVE_MANIFEST" "$ARCHIVE_MANIFEST_PREVIOUS"',
    'rename_no_replace "$ARCHIVE_MANIFEST_TMP" "$ARCHIVE_MANIFEST"',
    'remove_exact_manifest_file',
  ]) assert.ok(script.includes(required), `manual manifest takeover missing ${required}`);
  assert.ok(script.includes('successor_sources[:len(current_sources)] != current_sources'));
  assert.doesNotMatch(publisher, /rename_exchange/);
  assert.doesNotMatch(publisher, /mv\s+-f\s+"\$ARCHIVE_MANIFEST_TMP"\s+"\$ARCHIVE_MANIFEST"/);
  assert.ok(script.includes('final_mtime_s'));
  assert.ok(!script.includes('final_mtime_ns'));
  assert.ok(terminal.includes('archive_manifest_destinations_are_complete'));
  const ensure = script.match(/ensure_archive_manifest\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(
    ensure,
    /archive_manifest_consumed_predecessor_is_valid\s+\\?\s*"\$ARCHIVE_MANIFEST_PREVIOUS"\s+"\$ARCHIVE_MANIFEST"/,
  );
});

test('manual manifest predecessor recovery rejects unknown identity and private tombstones preserve cleanup conflicts', () => {
  const restore = script.match(/restore_previous_manifest_no_replace\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const manifestCleanup = script.match(/remove_exact_manifest_file\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const quiescentCleanup = script.match(/remove_exact_quiescent_file\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const tombstoneCleanup = script.match(/private_cleanup_tombstone\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

  for (const required of ['expected_sha256', 'expected_dev', 'expected_ino', 'path_matches_exact_identity', 'archive_manifest_recovery_is_reachable']) {
    assert.ok(restore.includes(required), `manual manifest predecessor restore missing ${required}`);
  }
  assert.doesNotMatch(restore, /sha256sum "\$ARCHIVE_MANIFEST_PREVIOUS"|stat -c [^\n]*ARCHIVE_MANIFEST_PREVIOUS/);
  const ensure = script.match(/ensure_archive_manifest\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.doesNotMatch(ensure, /restore_previous_manifest_no_replace\s*(?:\|\||;|\n)/);
  assert.ok(script.includes('manifest_predecessor_identity_from_successor'));
  assert.ok(script.includes('capture_archive_manifest_predecessor'));
  assert.ok(manifestCleanup.includes('private_cleanup_tombstone'));
  assert.ok(quiescentCleanup.includes('private_cleanup_tombstone'));
  for (const required of ['rename_no_replace', 'tombstone', 'expected_dev', 'expected_ino', '0700']) {
    assert.ok(tombstoneCleanup.includes(required), `manual private tombstone cleanup missing ${required}`);
  }
  assert.doesNotMatch(tombstoneCleanup, /os[.]unlink\(path\)/);
  const recovery = script.match(/recover_private_cleanup_tombstone\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  for (const required of ['.cleanup-gl-a-', 'expected_sha256', 'expected_dev', 'expected_ino', 'private_cleanup_tombstone']) {
    assert.ok(recovery.includes(required), `manual cross-process tombstone recovery missing ${required}`);
  }
  const archiveRecovery = script.match(
    /recover_archive_manifest_cleanup_tombstone\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  assert.ok(archiveRecovery.includes('private_cleanup_tombstone_state'));
  assert.ok(
    archiveRecovery.indexOf('private_cleanup_tombstone_state')
      < archiveRecovery.indexOf('manifest_predecessor_identity_from_successor'),
    'manual genesis manifests must not require predecessor authority without a cleanup tombstone',
  );
});

test('source and rollback terminal journals use a recoverable commit marker', () => {
  for (const required of [
    'ROLLBACK_COMMIT_MARKER=',
    'terminal_pair_commit_marker_is_owned',
    'recover_terminal_pair_commit',
    'write_terminal_pair_commit_marker prepared',
    'write_terminal_pair_commit_marker committed',
    'rollback_commit_marker:$rollback_commit_marker',
  ]) assert.ok(script.includes(required), `rollback helper missing terminal-pair commit ${required}`);

  const prepared = script.lastIndexOf('write_terminal_pair_commit_marker prepared');
  const source = script.lastIndexOf('update_source_journal_rolled_back');
  const rollback = script.lastIndexOf('write_rollback_journal rolled_back');
  const committed = script.lastIndexOf('write_terminal_pair_commit_marker committed');
  const cleanup = script.lastIndexOf('cleanup_terminal_pair_predecessors');
  const summary = script.lastIndexOf('emit_summary');
  assert.ok(prepared < source && source < rollback && rollback < committed);
  assert.ok(committed < cleanup && cleanup < summary, 'direct terminal path must clean retained predecessors before summary');
});

test('terminal-pair prepared marker precommits exact target bytes and committed validation is physical', () => {
  const markerWriter = script.match(/write_terminal_pair_commit_marker\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const recovery = script.match(/recover_terminal_pair_commit\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  for (const required of [
    'source_target_sha256',
    'rollback_target_sha256',
    'SOURCE_JOURNAL_TMP',
    'ROLLBACK_JOURNAL_TMP',
  ]) assert.ok(markerWriter.includes(required), `terminal target precommit missing ${required}`);
  assert.ok(markerWriter.includes('jq -ncS'));
  assert.ok(markerWriter.includes('jq -cS'));
  for (const required of ['update_source_journal_rolled_back', 'write_rollback_journal rolled_back']) {
    assert.ok(recovery.includes(required), `terminal recovery must reject non-precommitted state: ${required}`);
  }
  const physical = script.match(
    /validate_committed_terminal_pair_physical_chain\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  for (const required of [
    'source_journal_terminal_sha256',
    'rollback_journal_terminal_sha256',
    'rollback_commit_marker',
    'assert_terminal_manifest_journal_mirror',
  ]) assert.ok(physical.includes(required), `committed physical chain missing ${required}`);
  for (const required of [
    'SOURCE_JOURNAL_PREVIOUS_UPDATE',
    'ROLLBACK_JOURNAL_PREVIOUS_UPDATE',
    'ROLLBACK_COMMIT_MARKER_PREVIOUS',
    'stage_terminal_pair_journals',
    'publish-terminal',
  ]) assert.ok(script.includes(required), `terminal no-replace publication missing ${required}`);
  assert.doesNotMatch(markerWriter, /mv\s+-f\s+"\$ROLLBACK_COMMIT_MARKER_TMP"/);
});

test('terminal recovery has one physical precommit gate before marker or journal publication', () => {
  const unified = script.match(
    /terminal_pair_unified_precommit_recover\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  const recovery = script.match(/recover_terminal_pair_commit\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const markerWriter = script.match(
    /write_terminal_pair_commit_marker\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  const startup = script.match(
    /test -d "\$BACKUP_DIR"([\s\S]*?)G0_COMMIT=/,
  )?.[1] ?? '';
  for (const required of [
    'assert_terminal_state',
    'validate_staged_terminal_pair_cross',
    'validate_terminal_pair_intent_namespace',
    'stage_terminal_pair_journals',
  ]) assert.ok(`${unified}\n${recovery}`.includes(required), `terminal precommit missing ${required}`);
  assert.ok(
    recovery.indexOf('assert_terminal_state')
      < recovery.indexOf('takeover_terminal_pair_commit_marker_tmp'),
    'physical terminal state must precede marker takeover',
  );
  assert.ok(markerWriter.includes('validate_staged_terminal_pair_cross'));
  assert.ok(script.includes('terminal_pair_target_records_are_consistent'));
  assert.ok(script.includes('terminal namespace final is neither before nor target'));
  assert.ok(script.includes('def read_exact(path, require_canonical=True):'));
  for (const required of [
    'source_before_authority',
    'rollback_before_authority',
    'capture_terminal_pair_before_authority',
    'validate-authority-successor',
    'base64.b64decode(encoded, validate=True)',
    'terminal source exact successor drift',
    'terminal rollback exact successor drift',
    'publish-terminal-retain',
    'cleanup_terminal_pair_predecessors',
  ]) assert.ok(script.includes(required), `terminal before-authority proof missing ${required}`);
  assert.ok(script.includes('(marker.get("phase"), action) not in {'));
  assert.ok(script.includes('(\"prepared\", \"publish-terminal-retain\")'));
  assert.ok(script.includes('(\"committed\", \"publish-terminal\")'));
  assert.ok(markerWriter.includes('validate_terminal_pair_intent_namespace "$ROLLBACK_COMMIT_MARKER_TMP"'));
  assert.ok(script.includes('select_terminal_journal_load_record'));
  assert.ok(startup.includes('SOURCE_JOURNAL_LOAD="$(select_terminal_journal_load_record source)"'));
  assert.ok(startup.includes('ROLLBACK_JOURNAL_LOAD="$(select_terminal_journal_load_record rollback)"'));
  assert.ok(startup.includes('TERMINAL_RECOVERY_PENDING=1'));
  assert.doesNotMatch(startup, /publish-terminal/);
});

test('terminal rollback publication is exactly idempotent for an already-published target', () => {
  const writer = script.match(/write_rollback_journal\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  for (const required of [
    'test "$phase" = rolled_back',
    '.rollback_target_sha256',
    'validate_terminal_pair_intent_namespace',
    'ROLLBACK_TERMINAL=1',
    'return 0',
  ]) assert.ok(writer.includes(required), `terminal rollback idempotency missing ${required}`);
});

test('manual terminal journal pair mirrors exact archive manifest evidence', () => {
  const rollbackWriter = script.match(/write_rollback_journal\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const rollbackRenderer = script.match(/render_rollback_journal\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const sourceWriter = script.match(/update_source_journal_rolled_back\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const sourceRenderer = script.match(/render_source_journal_rolled_back\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const terminal = script.match(/assert_terminal_manifest_journal_mirror\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

  for (const required of [
    'log_archive_manifest_sha256',
    'log_archive_manifest_generation',
    'log_archive_manifest_entry_count',
  ]) {
    assert.ok(
      `${rollbackRenderer}\n${rollbackWriter}`.includes(required),
      `rollback terminal renderer/writer missing ${required}`,
    );
    assert.ok(
      `${sourceRenderer}\n${sourceWriter}`.includes(required),
      `source terminal renderer/writer missing ${required}`,
    );
    assert.ok(terminal.includes(required), `terminal mirror validator missing ${required}`);
  }
});

test('manual summary binds archive manifest and terminal-pair marker hashes', () => {
  const summary = script.match(/emit_summary\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

  for (const required of [
    'log_archive_manifest',
    'log_archive_manifest_sha256',
    'rollback_commit_marker',
    'rollback_commit_marker_sha256',
  ]) assert.ok(summary.includes(required), `manual summary missing ${required}`);
});

test('manual source and rollback journals share strict update CAS without terminal namespace overlap', () => {
  for (const required of [
    'SOURCE_JOURNAL_PREVIOUS_UPDATE="${SOURCE_JOURNAL}.previous-update-gl-a-${TRANSACTION_ID}"',
    'ROLLBACK_JOURNAL_PREVIOUS_UPDATE="${ROLLBACK_JOURNAL}.previous-update-gl-a-${TRANSACTION_ID}"',
    'journal_update_cas',
    'settle_journal_update "$SOURCE_JOURNAL"',
    'settle_journal_update "$ROLLBACK_JOURNAL"',
    'O_EXCL | os.O_NOFOLLOW',
    'same bytes on a different inode',
    'revision jump',
    'semantic phase regression',
  ]) assert.ok(script.includes(required), `manual journal CAS missing ${required}`);
  assert.ok(
    script.indexOf('settle_journal_update "$SOURCE_JOURNAL"')
      < script.indexOf('settle_journal_update "$ROLLBACK_JOURNAL"'),
    'manual recovery must settle source before rollback',
  );
  assert.notEqual(
    script.indexOf('SOURCE_JOURNAL_PREVIOUS_UPDATE'),
    script.indexOf('SOURCE_JOURNAL_PREVIOUS="${SOURCE_JOURNAL}.previous-terminal'),
    'update and terminal predecessor namespaces must remain distinct',
  );
  assert.doesNotMatch(script, /mv -f "\$ROLLBACK_JOURNAL_TMP" "\$ROLLBACK_JOURNAL"/);
});

test('source authority advances from external predecessor to validated settled F', () => {
  const main = script.slice(script.indexOf('test -d "$BACKUP_DIR"'));
  const settle = main.indexOf(
    'settle_journal_update "$SOURCE_JOURNAL" "$SOURCE_JOURNAL_PREVIOUS_UPDATE"',
  );
  const capture = main.indexOf(
    'SOURCE_JOURNAL_SETTLED_SHA256="$(capture_regular_file_identity_stable "$SOURCE_JOURNAL"',
  );
  const rebind = main.indexOf('SOURCE_JOURNAL_SHA256=$SOURCE_JOURNAL_SETTLED_SHA256');
  assert.ok(script.includes('SOURCE_JOURNAL_EXTERNAL_SHA256=$9'));
  assert.ok(script.includes('source "$SOURCE_JOURNAL_EXTERNAL_SHA256"'));
  assert.ok(settle >= 0 && settle < capture && capture < rebind);
  assert.ok(
    rebind < main.indexOf('CURRENT_SOURCE_SHA256="$(sha256sum "$SOURCE_JOURNAL"'),
    'settled F must be active before current-source admission',
  );
});

test('terminal pending rebinds source-before only through marker authority or staged CAS', () => {
  const binder = script.match(
    /bind_terminal_pending_source_authority\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  const normalizedBinder = binder.replace(/\\\s*/g, '').replace(/\s+/g, ' ');
  for (const required of [
    'terminal_pair_commit_marker_is_owned "$marker"',
    'marker_sha256="$(sha256sum "$marker"',
    "candidate=\"$(jq -er '.source_before_sha256' \"$marker\")\"",
    '--arg marker_sha256 "$marker_sha256"',
    'marker_sha256:$marker_sha256',
    'source rolled_back "$SOURCE_JOURNAL_EXTERNAL_SHA256" "$envelope" validate-authority-successor',
    'validate-authority-successor',
    'journal_update_cas "$SOURCE_JOURNAL"',
    'source rolled_back "$SOURCE_JOURNAL_EXTERNAL_SHA256" "" stage',
    'capture_regular_file_identity_stable "$SOURCE_JOURNAL"',
    'SOURCE_JOURNAL_SHA256=$SOURCE_JOURNAL_SETTLED_SHA256',
  ]) assert.ok(normalizedBinder.includes(required), `terminal source authority binder missing ${required}`);
  assert.ok(script.includes('predecessor.get("sha256") != legacy_hash'));
  const main = script.slice(script.indexOf('SOURCE_JOURNAL_FINAL=$SOURCE_JOURNAL'));
  assert.ok(
    main.indexOf('bind_terminal_pending_source_authority')
      < main.indexOf('select_terminal_journal_load_record source'),
  );
});

test('legacy runtime_removed without a cleanup object rebuilds the durable 14-slot plan', () => {
  const runner = script.match(/resume_legacy_runtime_removed_cleanup\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  for (const required of [
    'test "$RUNTIME_CLEANUP_JSON" = null',
    'build_runtime_cleanup_plan',
    'legacy_runtime_removed',
    'write_rollback_journal runtime_removed',
    'complete_runtime_cleanup_plan',
  ]) assert.ok(runner.includes(required), `legacy runtime cleanup recovery missing ${required}`);
  const resume = script.slice(script.lastIndexOf('runtime_removed|nginx_reloaded|logs_archived)'));
  for (const required of [
    'compatibility_mode == "legacy_runtime_removed"',
    'cursor_state != "complete"',
    'complete_runtime_cleanup_plan',
  ]) assert.ok(resume.includes(required), `legacy failed-wrapper resume missing ${required}`);
  const persist = script.match(/persist_runtime_cleanup_progress\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.ok(
    persist.indexOf('[ "$phase" = rollback_failed ]')
      < persist.indexOf('compatibility_mode == "legacy_runtime_removed"'),
    'rollback_failed must retain its wrapper while compatibility cleanup advances',
  );
  const builder = script.match(/build_runtime_cleanup_plan\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY/)?.[1] ?? '';
  for (const required of [
    'allow_legacy_recorded_absence',
    'compatibility_mode',
    'legacy_runtime_removed',
    'existing_tombstones',
    'selected_tombstones',
    'legacy runtime cleanup tombstone identity drift',
  ]) assert.ok(builder.includes(required), `legacy runtime cleanup builder missing ${required}`);
  assert.ok(script.includes('runtime cleanup compatibility source and tombstone coexist'));
  assert.ok(script.includes('runtime cleanup compatibility directory tombstone is not empty'));
  assert.match(script, /runtime_removed\|nginx_reloaded\|logs_archived\)[\s\S]*?resume_legacy_runtime_removed_cleanup/);
});

test('rollback_failed is a CAS phase with exact failed_from recovery intent', () => {
  const renderer = script.match(/render_rollback_journal\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const writer = script.match(/write_rollback_journal\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  for (const required of ['failed_from', 'ROLLBACK_FAILURE_FROM', 'rollback_failed']) {
    assert.ok(`${renderer}\n${writer}`.includes(required), `rollback failure intent missing ${required}`);
  }
  assert.match(script, /rollback_failed\)[\s\S]*?RESUME_ROLLBACK_PHASE="\$\(jq -er '[.]failed_from'/);
  assert.ok(renderer.includes('$failed_from == "logs_archived"'));
  assert.ok(renderer.includes('log_archive_manifest_sha256:$log_archive_manifest_sha256'));
});

test('settled rollback_failed same-phase resume is a business-exact CAS no-op', () => {
  const writer = script.match(/journal_update_cas\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY/)?.[1] ?? '';
  for (const required of [
    'current_base.get("phase") == "rollback_failed"',
    'failed_from = current_base.get("failed_from")',
    'requested_phase == failed_from',
    'resumed_base.pop("failed_from")',
    'resumed_base["phase"] = failed_from',
    'successor_value == resumed_base',
  ]) assert.ok(writer.includes(required), `failure resume no-op missing ${required}`);
  assert.ok(
    writer.indexOf('successor_value == resumed_base')
      < writer.indexOf('descriptor = os.open(temporary'),
    'business-identical failure resume must return before allocating T',
  );
});

test('rollback journal validator uses exact phase deltas and direct failed-phase continuation', () => {
  const writer = script.match(/journal_update_cas\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY/)?.[1] ?? '';
  for (const required of [
    'MISSING = object()',
    'validate_business',
    'ROLLBACK_REQUIRED',
    'validate_source_delta',
    'validate_rollback_delta',
    'failed_from',
    'old_effective',
    'direct_next',
    'reject_duplicate_keys',
    'reject_json_constant',
  ]) assert.ok(writer.includes(required), `phase-specific journal validator missing ${required}`);
  assert.ok(writer.includes('kind == "rollback" and old_effective != "logs_archived"'));
  assert.ok(writer.includes('rollback terminal phase jump'));
  assert.doesNotMatch(writer, /old\.get\(key\) != new\.get\(key\)/);
});

test('terminal journal intents are staged before their actual hashes enter the prepared marker', () => {
  for (const required of [
    'stage_terminal_journal_update',
    'SOURCE_JOURNAL_PREVIOUS_UPDATE',
    'ROLLBACK_JOURNAL_PREVIOUS_UPDATE',
    'terminal-staged journal requires pair bootstrap',
    'source_target_sha256="$(sha256sum "$SOURCE_JOURNAL_TMP"',
    'rollback_target_sha256="$(sha256sum "$ROLLBACK_JOURNAL_TMP"',
  ]) assert.ok(script.includes(required), `terminal staged-pair protocol missing ${required}`);
  assert.ok(
    script.indexOf('stage_terminal_journal_update "$SOURCE_JOURNAL"')
      < script.indexOf('write_terminal_pair_commit_marker prepared'),
  );
});

test('runtime cleanup is an immutable 14-slot journal plan shared by automatic and manual rollback', () => {
  for (const required of [
    'RUNTIME_CLEANUP_JSON',
    'build_runtime_cleanup_plan',
    'run_runtime_cleanup_plan',
    'runtime_cleanup_started',
    'plan_sha256',
    'cursor_state',
    'archive_handoff',
    'assert_absent',
    'site_installer',
    'site_restore',
    'rotation_status',
    'rotation_provenance',
    'rotation_state_dir',
  ]) assert.ok(script.includes(required), `runtime cleanup protocol missing ${required}`);
  const builder = script.match(/build_runtime_cleanup_plan\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY/)?.[1] ?? '';
  assert.ok(builder.includes('EXPECTED_SLOTS'));
  assert.ok(builder.includes('len(items) != 14'));
  assert.ok(builder.includes('selected_path'));
  assert.ok(builder.includes('canonical(items)'));
});

test('runtime cleanup rejects physical conflicts before failure-journal mutation', () => {
  const runner = script.match(/run_runtime_cleanup_plan\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const failure = script.match(/mark_failure\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const detacher = script.match(
    /runtime_cleanup_detach_item\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY/,
  )?.[1] ?? '';
  const unlinker = script.match(
    /runtime_cleanup_unlink_item\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY/,
  )?.[1] ?? '';
  for (const required of [
    'RUNTIME_CLEANUP_READ_ONLY_PREFLIGHT_FAILED=1',
    'runtime_cleanup_detach_item "$item" 1',
    'runtime_cleanup_unlink_item "$item" 1',
    'RUNTIME_CLEANUP_READ_ONLY_PREFLIGHT_FAILED=0',
  ]) assert.ok(runner.includes(required), `runtime cleanup read-only gate missing ${required}`);
  assert.ok(detacher.includes('validate_only = sys.argv[2] == "1"'));
  assert.ok(detacher.indexOf('if validate_only:') < detacher.indexOf('libc.renameat2('));
  assert.ok(unlinker.includes('validate_only = sys.argv[2] == "1"'));
  assert.ok(unlinker.indexOf('if validate_only:') < unlinker.indexOf('os.unlink(name'));
  assert.ok(failure.includes('RUNTIME_CLEANUP_READ_ONLY_PREFLIGHT_FAILED'));
  assert.ok(
    failure.indexOf('RUNTIME_CLEANUP_READ_ONLY_PREFLIGHT_FAILED')
      < failure.indexOf('write_rollback_journal rollback_failed'),
  );
});

test('runtime cleanup hands the mutable live log to the archive without freezing an early hash', () => {
  const builder = script.match(/build_runtime_cleanup_plan\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY/)?.[1] ?? '';
  const detacher = script.match(/runtime_cleanup_detach_item\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY/)?.[1] ?? '';
  const archiver = script.match(/archive_performance_logs\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  for (const source of [builder, detacher]) {
    assert.ok(source.includes('archive_handoff'));
    assert.ok(source.includes('stable_handoff'));
  }
  assert.ok(script.includes('assert_runtime_cleanup_log_handoff'));
  assert.ok(archiver.includes('assert_runtime_cleanup_log_handoff'));
  assert.match(builder, /def identity_for_handoff\([\s\S]*?"dev"[\s\S]*?"ino"/);
  const handoffIdentity = builder.match(
    /def identity_for_handoff\([\s\S]*?\n\n\ndef identity_for_directory/,
  )?.[0] ?? '';
  assert.doesNotMatch(
    handoffIdentity,
    /sha256/,
  );
});

test('runtime cleanup plan is canonically bound to business authority before physical mutation', () => {
  for (const required of [
    'expected_cleanup_items',
    'runtime cleanup canonical item authority drift',
    'verify_cleanup_genesis_physical',
    'runtime cleanup genesis alternate path exists',
    'runtime cleanup action identity drift',
    'runtime cleanup slot kind drift',
    're.fullmatch(r"[0-7]{3,4}"',
    'stable_identity(pathname_before) == stable_identity(before)',
    'cleanup tombstone changed before unlink',
  ]) assert.ok(script.includes(required), `canonical cleanup authority missing ${required}`);
  assert.ok(script.includes('if items != expected_items:'));
  assert.ok(script.includes('verify_cleanup_genesis_physical(new_cleanup)'));
});

test('completed normal cleanup plans are not reclassified from post-cleanup absence', () => {
  const writer = script.match(/journal_update_cas\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY/)?.[1] ?? '';
  const expected = writer.match(/def expected_cleanup_items\([\s\S]*?\n\s*return result/)?.[0] ?? '';
  assert.ok(expected.includes('actual_items[len(result)]["action"] == "assert_absent"'));
  assert.ok(expected.includes('prelive_empty_manifest_authorizes_installer_absence'));
  assert.ok(
    expected.indexOf('actual_items[len(result)]["action"] == "assert_absent"')
      < expected.indexOf('prelive_empty_manifest_authorizes_installer_absence'),
  );
});

test('runtime cleanup unlink rejects every non-selected alternate before any action branch', () => {
  const unlink = script.match(/runtime_cleanup_unlink_item\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY/)?.[1] ?? '';
  const guard = unlink.indexOf('cleanup alternate path reappeared before unlink');
  assert.ok(guard > 0);
  assert.ok(guard < unlink.indexOf('if item["action"] == "assert_absent"'));
  assert.ok(guard < unlink.indexOf('if not exists(tombstone)'));
  assert.ok(guard < unlink.indexOf('os.unlink(name'));
});

test('archive manifest F/T/P/C recovery is preflight-bound to the immutable log handoff', () => {
  const ensure = script.match(/ensure_archive_manifest\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const publish = script.match(/publish_archive_manifest_tmp\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const recover = script.match(
    /recover_archive_manifest_cleanup_tombstone\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  for (const body of [ensure, publish, recover]) {
    assert.ok(body.includes('archive_manifest_namespace_handoff_preflight'));
  }
  for (const required of [
    '000:absent',
    '010:absent',
    '100:absent',
    '110:absent',
    '011:absent',
    '101:absent',
    '100:payload',
    '100:empty',
    'discover_archive_manifest_cleanup_namespace',
    'capture_archive_manifest_owned "$c_payload"',
    'archive_manifest_consumed_predecessor_is_valid',
    'archive_manifest_recovery_is_reachable "$frontier" "$frontier_fp"',
    'assert_runtime_cleanup_log_handoff "$frontier" "$frontier_fp"',
    'ARCHIVE_READ_ONLY_PREFLIGHT_FAILED=1',
    'ARCHIVE_READ_ONLY_PREFLIGHT_FAILED=0',
    'test ! -e "$ARCHIVE_MANIFEST" && test ! -L "$ARCHIVE_MANIFEST"',
    'test ! -e "$ARCHIVE_MANIFEST_TMP" && test ! -L "$ARCHIVE_MANIFEST_TMP"',
  ]) assert.ok(script.includes(required), `archive preflight missing ${required}`);
  assert.ok(script.includes('.cleanup-gl-a-${ARCHIVE_OPERATION_ID}-${path_tag}-'));
  assert.ok(script.includes('payload_fingerprint'));
  assert.ok(script.includes('test "$(jq -cS \'.fingerprint\' <<< "$c_owned")" = "$c_fp"'));
  assert.doesNotMatch(script, /archive_manifest_namespace_handoff_preflight_legacy/);
  const failureTrap = script.match(/mark_failure\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.ok(failureTrap.includes('ARCHIVE_READ_ONLY_PREFLIGHT_FAILED'));
  assert.ok(
    failureTrap.indexOf('ARCHIVE_READ_ONLY_PREFLIGHT_FAILED')
      < failureTrap.indexOf('write_rollback_journal rollback_failed'),
    'read-only archive preflight failure must bypass rollback_failed publication',
  );
});

test('archive proof holds manifest identities, permits mutable journaled tails, and unlinks only by held dirfd', () => {
  for (const required of [
    'capture_archive_manifest_owned_identity',
    'object_pairs_hook=reject_duplicates',
    'parse_constant=reject_constant',
    'before.st_nlink != 1',
    'archive manifest short read',
    'archive manifest runtime short read',
    'archive reachable manifest short read',
    'fingerprint != json.loads(expected_raw)',
    'if freeze_content else inode_identity',
    'if freeze_content and len(raw) != before.st_size',
    'remove_exact_empty_private_cleanup_directory',
    'os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)',
    'os.rmdir(name, dir_fd=parent)',
    'os.unlink(name, dir_fd=parent)',
    'private cleanup held tombstone drift after unlink',
    'private cleanup held directory drift after rmdir',
  ]) assert.ok(script.includes(required), `archive held-authority proof missing ${required}`);
  assert.doesNotMatch(script, /os[.]unlink\(tombstone\)|rmdir "\$cleanup_dir"/);
});

test('runtime cleanup persists detaching and detached around exact NOREPLACE tombstones', () => {
  const runner = script.match(/run_runtime_cleanup_plan\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const persist = script.match(/persist_runtime_cleanup_progress\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const protocol = `${runner}\n${persist}`;
  for (const required of [
    'cursor_state',
    'detaching',
    'detached',
    'runtime_cleanup_detach_item',
    'runtime_cleanup_unlink_item',
    'write_rollback_journal runtime_cleanup_started',
  ]) assert.ok(protocol.includes(required), `cleanup runner missing ${required}`);
  assert.ok(
    runner.indexOf('cursor_state="detaching"')
      < runner.indexOf('runtime_cleanup_detach_item "$item" || return 1'),
    'detaching intent must be durable before rename',
  );
  assert.ok(
    runner.indexOf('cursor_state="detached"')
      < runner.indexOf('runtime_cleanup_unlink_item "$item" || return 1'),
    'detached intent must be durable before unlink',
  );
});

test('automatic rollback hands off the lock and delegates the same rollback helper', () => {
  const trap = installer.match(/rollback_on_failure\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  for (const required of [
    'flock -u 9',
    'exec 9>&-',
    'SOURCE_JOURNAL_DELEGATE_SHA256',
    'rollback-aifeeds-performance-log.sh',
    'automatic_rollback=pass',
  ]) assert.ok(trap.includes(required), `automatic rollback delegation missing ${required}`);
});
