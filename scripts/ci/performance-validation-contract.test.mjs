import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const readWorkflow = (name) => readFileSync(resolve(root, `.github/workflows/${name}`), 'utf8');
const operations = readFileSync(resolve(root, 'docs/operations.md'), 'utf8');
const perfStagingChangePacket = readFileSync(
  resolve(root, 'docs/reviews/c-end-perf-staging-change-packet.md'),
  'utf8',
);
const performancePlan = readFileSync(
  resolve(root, 'docs/plans/2026-07-10-c-end-performance-optimization-plan.md'),
  'utf8',
);
const installerIntegrationHarness = readFileSync(
  resolve(root, 'deploy/nginx/install-aifeeds-performance-log.integration.test.sh'),
  'utf8',
);
const rolloutTemplate = readFileSync(
  resolve(root, 'docs/reviews/c-end-performance-rollout-template.md'),
  'utf8',
);

const cJournalCleanupScenarios = Object.freeze([
  'journal-source-g-reentry',
  'journal-source-s1-reentry',
  'journal-source-s2-reentry',
  'journal-source-s3-reentry',
  'journal-source-s4-reentry',
  'journal-source-semantic-drift',
  'journal-source-samebytes-predecessor',
  'journal-source-partial-tmp',
  'journal-source-p-only',
  'journal-source-all-three',
  'journal-source-unknown-cleanup',
  'journal-rollback-g-reentry',
  'journal-rollback-s1-reentry',
  'journal-rollback-s2-reentry',
  'journal-rollback-s3-reentry',
  'journal-rollback-s4-reentry',
  'journal-rollback-semantic-drift',
  'journal-rollback-samebytes-predecessor',
  'journal-rollback-partial-tmp',
  'journal-rollback-p-only',
  'journal-rollback-all-three',
  'journal-rollback-unknown-cleanup',
  'terminal-pair-zero-side-reentry',
  'terminal-pair-one-side-reentry',
  'terminal-pair-two-side-reentry',
  'terminal-pair-pre-marker-reentry',
  'cleanup-manual-detaching-reentry',
  'cleanup-manual-detached-reentry',
  'cleanup-automatic-detaching-reentry',
  'cleanup-automatic-detached-reentry',
  'cleanup-manual-unknown-tombstone',
  'cleanup-automatic-unknown-tombstone',
  'cleanup-manual-plan-drift',
  'cleanup-automatic-plan-drift',
  'cleanup-manual-failed-from-drift',
  'cleanup-automatic-failed-from-drift',
  'journal-source-legacy-genesis',
  'journal-rollback-legacy-genesis-rejected',
  'cleanup-manual-legacy-runtime-removed',
  'cleanup-automatic-legacy-runtime-removed',
]);

function assertLatestRunWinsByDeploymentTarget(workflow, name) {
  assert.match(workflow, new RegExp(`concurrency:\\s*\\n\\s+group:\\s*${name}-`));
  assert.match(workflow, /group:.*inputs\.env/);
  assert.match(workflow, /group:.*github\.ref_name\s*==\s*'main'.*'prod'.*'staging'/);
  assert.match(workflow, /cancel-in-progress:\s*true/);
}

function assertProductionRefGuard(workflow) {
  assert.match(
    workflow,
    /if \[ "\$TARGET" = "prod" \] && \[ "\$\{GITHUB_REF:-\}" != "refs\/heads\/main" \]; then/,
  );
  assert.match(workflow, /exit 1/);
}

function extractBashFences(document) {
  return [...document.matchAll(/^```bash\n([\s\S]*?)^```$/gm)].map((match) => match[1]);
}

function extractJqFilterBefore(document, target, occurrence = 0) {
  let targetIndex = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    targetIndex = document.indexOf(target, targetIndex + 1);
  }
  assert.notEqual(targetIndex, -1, `missing jq target ${target}`);
  const commandMatches = [...document.slice(0, targetIndex).matchAll(/\n[ \t]*jq -e /g)];
  assert.ok(commandMatches.length > 0, `missing jq command for ${target}`);
  const commandMatch = commandMatches.at(-1);
  const commandStart = commandMatch.index + commandMatch[0].indexOf('jq');
  const filterStart = document.indexOf("'\n", commandStart) + 2;
  const filterEnd = document.lastIndexOf("'", targetIndex);
  assert.ok(filterStart > commandStart + 1 && filterEnd > filterStart, `cannot extract jq for ${target}`);
  return document.slice(filterStart, filterEnd);
}

test('dashboard deploy keeps the complete frontend gate ahead of deployment', () => {
  const workflow = readWorkflow('deploy-dashboard.yml');

  for (const command of [
    'npx playwright install --with-deps chromium webkit',
    'npx playwright install-deps chromium webkit',
    'npm run lint',
    'npm run test:unit',
    'npm run build',
    'npm run test:e2e',
  ]) {
    assert.ok(workflow.includes(command), `dashboard deploy gate missing: ${command}`);
  }
  assert.match(workflow, /needs:\s*validate-before-deploy/);
});

test('worker deploy typechecks, tests, and packages before deployment', () => {
  const workflow = readWorkflow('deploy-worker.yml');

  assert.ok(workflow.includes('npx tsc --noEmit'));
  assert.ok(workflow.includes('npm test'));
  assert.ok(workflow.includes('npx wrangler deploy --dry-run'));
  assert.doesNotMatch(workflow, /if:\s*false/);
  assert.match(workflow, /needs:\s*validate-before-deploy/);
});

test('dashboard and worker deploys cancel stale runs by normalized target', () => {
  assertLatestRunWinsByDeploymentTarget(readWorkflow('deploy-dashboard.yml'), 'deploy-dashboard');
  assertLatestRunWinsByDeploymentTarget(readWorkflow('deploy-worker.yml'), 'deploy-worker');
});

test('manual production deploys fail closed outside refs/heads/main', () => {
  assertProductionRefGuard(readWorkflow('deploy-dashboard.yml'));
  assertProductionRefGuard(readWorkflow('deploy-worker.yml'));
});

test('operations documents the active worker typecheck gate', () => {
  assert.doesNotMatch(operations, /validate tsc step 当前 `if: false`/);
  assert.match(operations, /Worker TypeScript baseline 已清零/);
});

test('GL-a documents preserve both transcripts and fail closed on active log writers', () => {
  for (const [name, document] of [
    ['operations', operations],
    ['change packet', perfStagingChangePacket],
    ['performance plan', performancePlan],
  ]) {
    assert.match(document, /stdout[^\n]*stderr|stdout\/stderr/i, `${name} omits both output streams`);
    assert.match(document, /manual rollback[^\n]*transcript|人工回滚[^\n]*transcript/i, `${name} omits manual transcript`);
    assert.match(document, /quarantine/i, `${name} omits quarantine recovery`);
    assert.match(document, /writable FD/i, `${name} omits writable-fd quiescence`);
    assert.match(document, /60 秒|60s/i, `${name} omits the production quiescence deadline`);
    assert.match(document, /recovery bundle/i, `${name} omits atomic recovery evidence`);
  }
});

test('GL-a documents the complete crash-recovery evidence model', () => {
  for (const [name, document] of [
    ['operations', operations],
    ['change packet', perfStagingChangePacket],
    ['performance plan', performancePlan],
  ]) {
    assert.match(
      document,
      /terminal pair[\s\S]{0,320}?prepared\s*[→-]\s*committed/i,
      `${name} omits the prepared-to-committed terminal pair`,
    );
    assert.match(document, /archive manifest/i, `${name} omits the durable archive manifest`);
    assert.match(document, /attempt transcript/i, `${name} omits per-attempt transcripts`);
    assert.match(document, /canonical recovery bundle/i, `${name} omits the canonical recovery bundle`);
    assert.match(document, /source_target_sha256/, `${name} omits the prepared source target SHA`);
    assert.match(document, /rollback_target_sha256/, `${name} omits the prepared rollback target SHA`);
    assert.match(document, /tombstone/i, `${name} omits artifact-removal tombstones`);
    assert.match(document, /prelive empty manifest/i, `${name} omits the prelive empty-manifest contract`);
    assert.match(
      document,
      /committed marker[\s\S]{0,240}?physical chain/i,
      `${name} omits committed-marker physical-chain validation`,
    );
    assert.match(
      document,
      /fsync[^\n]*destination parent|destination parent[^\n]*fsync/i,
      `${name} omits durable recovery-bundle directory publication`,
    );
  }
  assert.doesNotMatch(
    operations,
    /gl-a-recovery-record[.]json/,
    'operations must not describe the recovery record and SHA as separate published files',
  );
});

test('GL-a activates journal CAS and freezes the 14-slot cleanup scenario contract', () => {
  assert.equal(cJournalCleanupScenarios.length, 40);
  for (const [name, document] of [
    ['operations', operations],
    ['change packet', perfStagingChangePacket],
    ['performance plan', performancePlan],
  ]) {
    assert.match(document, /C journal update CAS (?:已激活|active)/i, `${name} omits active C journal CAS`);
    assert.match(document, /consumer activation[\s\S]{0,100}?(?:active|已激活)/i);
    assert.match(document, /harness name[-/]count freeze[\s\S]{0,100}?(?:active|frozen|已冻结)/i);
    assert.match(document, /transaction-<operation-id>[.]json/);
    assert.match(document, /rollback-transaction-<operation-id>[.]json/);
    assert.match(document, /[.]previous-update-gl-a-<operation-id>/);
    for (const field of ['journal_update', 'revision', 'self_dev', 'self_ino', 'predecessor']) {
      assert.match(document, new RegExp(`\\b${field}\\b`), `${name} omits ${field}`);
    }
    assert.match(document, /O_EXCL\|O_NOFOLLOW/);
    assert.match(document, /fsync\(fd\)[+]fsync\(parent\)/);
    assert.match(
      document,
      /S0[\s\S]{0,160}?S1[\s\S]{0,160}?S2[\s\S]{0,160}?S3[\s\S]{0,240}?S4/,
      `${name} omits the complete S0-S4 journal recovery topology`,
    );
    assert.match(
      document,
      /S4[^\n]{0,180}?F\(new\)[+]C\(cleanup tombstone\)[^\n]{0,120}?P absent/i,
      `${name} omits the S4 F+C topology`,
    );
    assert.match(
      document,
      /S4[\s\S]{0,320}?exact[\s\S]{0,120}?C[\s\S]{0,120}?predecessor[\s\S]{0,220}?held-dirfd unlink[\s\S]{0,120}?S0/i,
      `${name} omits exact S4 recovery back to S0`,
    );
    assert.match(
      document,
      /invalid\/partial T[\s\S]{0,180}?(?:preserv|保留)[\s\S]{0,100}?fail closed/i,
      `${name} permits partial tmp cleanup`,
    );
    assert.match(document, /[.]previous-update-[^\n]*[.]previous-terminal-/);
    assert.match(document, /only S0|只接受\s*S0/i);
    assert.match(document, /recovery_required/);
    assert.match(document, /14-slot runtime cleanup/i, `${name} omits the immutable cleanup plan size`);
    assert.match(
      document,
      /source legacy\s+genesis[\s\S]{0,160}?(?:CLI|external)[\s\S]{0,100}?hash[\s\S]{0,140}?(?:accept|trusted)/i,
      `${name} omits source legacy-genesis trust`,
    );
    assert.match(
      document,
      /rollback legacy\s+genesis[\s\S]{0,180}?no externally trusted hash[\s\S]{0,140}?(?:reject|fail closed)/i,
      `${name} omits rollback legacy-genesis rejection`,
    );
    assert.match(document, /135 scenarios \(95 old [+] 40 new\)/i, `${name} omits frozen matrix count`);
    for (const scenario of cJournalCleanupScenarios) {
      assert.ok(document.includes(scenario), `${name} omits frozen scenario ${scenario}`);
    }
  }
});

test('GL-a documents the source-journal runtime identity and zero-residue cleanup contract', () => {
  for (const [name, document] of [
    ['operations', operations],
    ['change packet', perfStagingChangePacket],
    ['performance plan', performancePlan],
  ]) {
    assert.match(
      document,
      /runtime artifact manifest[\s\S]{0,320}?source transaction journal[\s\S]{0,240}?runtime_artifacts[\s\S]{0,160}?runtime_artifacts_sealed/i,
      `${name} does not locate runtime identity in the source journal`,
    );
    assert.match(
      document,
      /8 candidates[\s\S]{0,240}?dev[\s\S]{0,120}?ino[\s\S]{0,120}?sha(?:256)?[\s\S]{0,160}?meta/i,
      `${name} omits the eight candidate identities`,
    );
    assert.match(
      document,
      /seal(?:ed)?[\s\S]{0,180}?before any final|seal[^\n]*才[^\n]*final/i,
      `${name} permits publication before the runtime inventory is sealed`,
    );
    assert.match(document, /7 immutable finals/i, `${name} omits immutable-final cleanup`);
    assert.match(document, /8 candidates/i, `${name} omits candidate cleanup`);
    assert.match(document, /live log[\s\S]{0,160}?archive manifest/i, `${name} mishandles the live log`);
    assert.match(document, /rotation_state_identity/, `${name} omits rotation-state identity`);
    assert.match(document, /rotation_state_snapshot/, `${name} omits mutable rotation-state evidence`);
    assert.match(document, /genesis_record_sha256/, `${name} omits the stable ledger anchor`);
    assert.match(document, /tail_record_sha256/, `${name} omits the verified ledger tail`);
    assert.match(document, /rotation-wrapper/, `${name} omits the authorized rotation writer`);
    assert.match(
      document,
      /authority-bound ledger inode FD flock/i,
      `${name} omits the single authority-bound ledger lock domain`,
    );
    assert.match(
      document,
      /\/run\/aifeeds-performance-log-rotation[.]lock[\s\S]{0,180}?compatibility-only[\s\S]{0,160}?not (?:an? )?(?:authority|serialization) domain/i,
      `${name} treats the legacy pathname as an authority or serialization domain`,
    );
    assert.match(
      document,
      /status inode\/hash[\s\S]{0,100}?(?:not permanent|不是永久)/i,
      `${name} treats a mutable status inode as permanent identity`,
    );
    assert.match(document, /site_backup_identity/, `${name} omits backup allocation identity`);
    assert.match(document, /O_EXCL/, `${name} omits exclusive backup allocation`);
    assert.match(
      document,
      /pre-mutation base SITE identity[\s\S]{0,180}?original[^\n]*inode/i,
      `${name} does not bind the pre-mutation site to the original inode`,
    );
    assert.match(
      document,
      /committed installed SITE identity[\s\S]{0,180}?installer candidate[^\n]*inode/i,
      `${name} does not bind the committed site to the installer-candidate inode`,
    );
    assert.match(
      document,
      /rolled[_ -]back[\s\S]{0,40}?base SITE identity[\s\S]{0,180}?rollback candidate[^\n]*inode[\s\S]{0,180}?otherwise[^\n]*original[^\n]*inode/i,
      `${name} does not bind the restored site to the rollback-candidate inode`,
    );
    assert.match(
      document,
      /phase[\s\S]{0,100}?recorded identity[\s\S]{0,160}?never derive[\s\S]{0,80}?current path/i,
      `${name} permits identity to be reconstructed from a current pathname`,
    );
    assert.match(
      document,
      /manual[\s\S]{0,160}?(?:derive|adopt)[\s\S]{0,80}?unknown/i,
      `${name} permits manual recovery to adopt unknown backup state`,
    );
    assert.match(
      document,
      /physical[\s\S]{0,180}?(?:final|candidate)[\s\S]{0,180}?rotation[\s\S]{0,120}?zero residue/i,
      `${name} omits terminal physical zero-residue validation`,
    );
    assert.match(
      document,
      /no independent runtime manifest/i,
      `${name} invents a standalone runtime manifest artifact`,
    );
    assert.doesNotMatch(document, /durable receipt/i, `${name} invents a durable receipt artifact`);
  }
});

test('manual GL-a rollback publishes an operation-and-attempt transcript before enforcing pipe status', () => {
  const rollback = operations.match(
    /\*\*精确人工\/崩溃恢复回滚\*\*[\s\S]*?(?=\n回滚只撤销 nginx)/,
  )?.[0] ?? '';
  assert.ok(rollback, 'manual rollback section must exist');
  assert.match(rollback, /ROLLBACK_ATTEMPT_ID=/);
  assert.match(
    rollback,
    /ROLLBACK_OUTPUT_FINAL="\$EVIDENCE\/gl-a-manual-rollback-output-\$\{OPERATION_ID\}-\$\{ROLLBACK_ATTEMPT_ID\}[.]txt"/,
  );
  assert.match(
    rollback,
    /publish_local_file_no_replace "\$ROLLBACK_OUTPUT_TMP" "\$ROLLBACK_OUTPUT_FINAL"/,
  );
  assert.doesNotMatch(rollback, /mv -(?:f|n) "\$ROLLBACK_OUTPUT_TMP"/);

  const capture = rollback.indexOf('ROLLBACK_PIPE_RESULTS=("${PIPESTATUS[@]}")');
  const privateTmp = rollback.indexOf('chmod 0600 "$ROLLBACK_OUTPUT_TMP"');
  const publish = rollback.indexOf(
    'publish_local_file_no_replace "$ROLLBACK_OUTPUT_TMP" "$ROLLBACK_OUTPUT_FINAL"',
  );
  const enforce = rollback.indexOf('if [ "$ROLLBACK_TEE_RC" -ne 0 ]');
  assert.ok(capture >= 0 && capture < privateTmp, 'PIPESTATUS must be captured before chmod changes it');
  assert.ok(privateTmp < publish, 'the temporary transcript must be 0600 before publication');
  assert.ok(publish < enforce, 'the final transcript must exist before either pipeline status is enforced');
});

test('forward and manual local evidence use durable same-parent NOREPLACE publication', () => {
  const forward = operations.match(
    /\*\*GL-a 部署[\s\S]*?(?=\n本地在任何远端写之前)/,
  )?.[0] ?? '';
  const rollback = operations.match(
    /\*\*精确人工\/崩溃恢复回滚\*\*[\s\S]*?(?=\n回滚只撤销 nginx)/,
  )?.[0] ?? '';
  for (const [name, section, publications] of [
    ['forward', forward, [
      ['$INSTALL_OUTPUT_TMP', '$INSTALL_OUTPUT_FINAL'],
      ['$LOCAL_SUMMARY_TMP', '$LOCAL_SUMMARY_FINAL'],
    ]],
    ['manual', rollback, [
      ['$ROLLBACK_OUTPUT_TMP', '$ROLLBACK_OUTPUT_FINAL'],
      ['$ROLLBACK_SUMMARY_TMP', '$ROLLBACK_SUMMARY'],
    ]],
  ]) {
    assert.match(section, /publish_local_file_no_replace\(\)/, `${name} omits the file publisher`);
    assert.match(section, /renamex_np/, `${name} omits Darwin NOREPLACE`);
    assert.match(section, /renameat2/, `${name} omits Linux NOREPLACE`);
    assert.match(section, /os[.]fsync\(parent_fd\)/, `${name} omits parent fsync`);
    assert.match(
      section,
      /test "\$\(dirname "\$source"\)" = "\$\(dirname "\$destination"\)"/,
      `${name} does not require same-parent publication`,
    );
    assert.match(section, /remove_owned_local_tmp\(\)/, `${name} omits exact-identity tmp cleanup`);
    for (const [source, destination] of publications) {
      const escapedSource = source.replaceAll('$', '\\$');
      const escapedDestination = destination.replaceAll('$', '\\$');
      assert.match(
        section,
        new RegExp(`publish_local_file_no_replace "${escapedSource}" "${escapedDestination}"`),
        `${name} does not publish ${destination} with NOREPLACE`,
      );
    }
    assert.doesNotMatch(section, /mv -(?:f|n) "\$(?:INSTALL_OUTPUT|LOCAL_SUMMARY|ROLLBACK_OUTPUT|ROLLBACK_SUMMARY)_TMP"/);
    assert.match(section, /PUBLISH_ATTEMPTED=1[\s\S]{0,160}?publish_local_file_no_replace/);
    assert.match(section, /publish collision[^\n]*preserved owned tmp and unknown destination/i);
  }
  assert.match(forward, /LOCAL_SUMMARY_TMP_DEV=/);
  assert.match(forward, /LOCAL_SUMMARY_TMP_INO=/);
  assert.match(
    forward,
    /remove_owned_local_tmp "\$LOCAL_SUMMARY_TMP" "\$LOCAL_SUMMARY_TMP_DEV"[\s\\]+"\$LOCAL_SUMMARY_TMP_INO"/,
  );
  assert.match(rollback, /ROLLBACK_SUMMARY_TMP_DEV=/);
  assert.match(rollback, /ROLLBACK_SUMMARY_TMP_INO=/);
  assert.match(
    rollback,
    /remove_owned_local_tmp "\$ROLLBACK_SUMMARY_TMP" "\$ROLLBACK_SUMMARY_TMP_DEV"[\s\\]+"\$ROLLBACK_SUMMARY_TMP_INO"/,
  );
});

test('GL-a documents the local evidence no-clobber lifecycle', () => {
  for (const [name, document] of [
    ['operations', operations],
    ['change packet', perfStagingChangePacket],
    ['performance plan', performancePlan],
  ]) {
    assert.match(
      document,
      /forward transcript[\s\S]{0,180}?forward summary[\s\S]{0,180}?manual transcript[\s\S]{0,180}?manual summary[\s\S]{0,180}?same-parent NOREPLACE/i,
      `${name} omits one of the four local evidence publications`,
    );
    assert.match(
      document,
      /publish collision[\s\S]{0,160}?owned tmp[\s\S]{0,120}?unknown destination/i,
      `${name} discards ambiguous collision evidence`,
    );
    assert.match(
      document,
      /O_EXCL[\s\S]{0,160}?recorded dev\/ino[\s\S]{0,160}?failure cleanup/i,
      `${name} permits pathname-derived temporary-file cleanup`,
    );
    assert.match(
      document,
      /parent directory[^\n]*fsync|fsync[^\n]*parent directory/i,
      `${name} omits publication durability`,
    );
    assert.doesNotMatch(document, /test[^\n]{0,80}mv -f[^\n]*(?:transcript|summary)/i);
  }
});

test('manual GL-a rollback validates exact manifest and commit-marker evidence in its local summary', () => {
  const rollback = operations.match(
    /\*\*精确人工\/崩溃恢复回滚\*\*[\s\S]*?(?=\n回滚只撤销 nginx)/,
  )?.[0] ?? '';
  assert.ok(rollback, 'manual rollback section must exist');
  assert.ok(
    rollback.includes(
      'EXPECTED_LOG_ARCHIVE_MANIFEST="/var/backups/aifeeds-performance-log/audit-${OPERATION_ID}/archive-manifest.json"',
    ),
  );
  assert.ok(
    rollback.includes(
      'EXPECTED_ROLLBACK_COMMIT_MARKER="/var/backups/aifeeds-performance-log/rollback-commit-${OPERATION_ID}.json"',
    ),
  );
  assert.match(rollback, /--arg log_archive_manifest "\$EXPECTED_LOG_ARCHIVE_MANIFEST"/);
  assert.match(rollback, /--arg rollback_commit_marker "\$EXPECTED_ROLLBACK_COMMIT_MARKER"/);
  assert.match(rollback, /[.]log_archive_manifest == \$log_archive_manifest/);
  assert.match(rollback, /[.]log_archive_manifest_sha256 \| test\("\^\[a-f0-9\]\{64\}\$"\)/);
  assert.match(rollback, /[.]rollback_commit_marker == \$rollback_commit_marker/);
  assert.match(rollback, /[.]rollback_commit_marker_sha256 \| test\("\^\[a-f0-9\]\{64\}\$"\)/);
  assert.match(
    rollback,
    /[.]log_archive_manifest_generation \| type == "number" and [.][ ]*>= 0 and [.][ ]*== floor/,
  );
  assert.match(
    rollback,
    /[.]log_archive_manifest_entry_count \| type == "number" and [.][ ]*>= 0 and [.][ ]*== floor/,
  );
  assert.match(
    rollback,
    /[.]log_archive_manifest_generation >= \(3 \* [.]+log_archive_manifest_entry_count \+ 1\)/,
  );
  assert.match(
    rollback,
    /[.]log_archive_manifest_generation <= \(4 \* [.]+log_archive_manifest_entry_count \+ 1\)/,
  );
  for (const field of [
    'runtime_artifacts',
    'runtime_artifacts_sealed',
    'rotation_state_identity',
    'rotation_state_snapshot',
    'rotation_anchor_identity',
    'site_backup_identity',
  ]) assert.match(rollback, new RegExp(`[.]${field}`), `manual summary does not consume ${field}`);
  assert.match(rollback, /\([.]runtime_artifacts \| length\) <= 8/);
  assert.match(rollback, /if [.]+runtime_artifacts_sealed then \([.]+runtime_artifacts \| length\) == 8/);
  assert.match(
    rollback,
    /\(keys \| sort\) == \["candidate","dev","final","gid","ino","mode","name","sha256","uid"\]/,
  );
});

test('rolled-back recovery bundles copy and physically reconcile the operation-bound archive manifest', () => {
  const recovery = operations.match(
    /若 SIGKILL、主机重启、[\s\S]*?(?=\n\*\*精确人工\/崩溃恢复回滚\*\*)/,
  )?.[0] ?? '';
  assert.ok(recovery, 'read-only recovery capture section must exist');
  assert.ok(
    recovery.includes(
      'REMOTE_ARCHIVE_MANIFEST="/var/backups/aifeeds-performance-log/audit-${OPERATION_ID}/archive-manifest.json"',
    ),
  );
  assert.match(recovery, /RECOVERY_MANIFEST="\$RECOVERY_BUNDLE_TMP\/archive-manifest[.]json"/);
  assert.match(recovery, /[.]log_archive_manifest == \$archive_manifest/);
  assert.match(recovery, /[.]log_archive_manifest_sha256 \| test\("\^\[a-f0-9\]\{64\}\$"\)/);
  assert.match(recovery, /[.]log_archive_manifest_generation >= \(3 \* [.]+log_archive_manifest_entry_count \+ 1\)/);
  assert.match(recovery, /[.]log_archive_manifest_generation <= \(4 \* [.]+log_archive_manifest_entry_count \+ 1\)/);
  assert.match(recovery, /root@154[.]12[.]188[.]231:"\$REMOTE_ARCHIVE_MANIFEST" "\$RECOVERY_MANIFEST"/);
  assert.match(recovery, /shasum -a 256 "\$RECOVERY_MANIFEST"/);
  assert.match(recovery, /[.]operation_id == \$operation_id/);
  assert.match(recovery, /[.]generation == \$generation/);
  assert.match(recovery, /\([.]entries \| length\) == \$entry_count/);
  assert.match(recovery, /RECOVERY_MANIFEST="\$RECOVERY_BUNDLE\/archive-manifest[.]json"/);
  assert.match(recovery, /test "\$\(shasum -a 256 "\$RECOVERY_MANIFEST"/);
  assert.match(
    recovery,
    /if jq -e '[.]phase == "rolled_back"'[\s\S]*?RECOVERY_MANIFEST[\s\S]*?automatic_rollback=pass/,
    'automatic terminal reconciliation must be anchored by copied manifest evidence before transcript diagnostics',
  );
  for (const field of [
    'runtime_artifacts',
    'runtime_artifacts_sealed',
    'rotation_state_identity',
    'rotation_state_snapshot',
    'rotation_anchor_identity',
    'site_backup_identity',
  ]) assert.match(recovery, new RegExp(`[.]${field}`), `recovery record does not consume ${field}`);
  assert.match(recovery, /\([.]runtime_artifacts \| length\) <= 8/);
  assert.match(recovery, /if [.]+runtime_artifacts_sealed then \([.]+runtime_artifacts \| length\) == 8/);
});

test('GL-a local consumers validate the anchored mutable rotation ledger', () => {
  const forward = operations.match(
    /\*\*GL-a 部署[\s\S]*?(?=\n本地在任何远端写之前)/,
  )?.[0] ?? '';
  const recovery = operations.match(
    /若 SIGKILL、主机重启、[\s\S]*?(?=\n\*\*精确人工\/崩溃恢复回滚\*\*)/,
  )?.[0] ?? '';
  const rollback = operations.match(
    /\*\*精确人工\/崩溃恢复回滚\*\*[\s\S]*?(?=\n回滚只撤销 nginx)/,
  )?.[0] ?? '';
  for (const [name, section] of [['forward', forward], ['recovery', recovery], ['manual', rollback]]) {
    assert.match(section, /\["directory","files","provenance"\]/, `${name} omits identity schema`);
    assert.match(
      section,
      /\["dev","genesis_record_sha256","gid","ino","mode","path","uid"\]/,
      `${name} omits provenance-anchor schema`,
    );
    assert.match(
      section,
      /\["generation","ledger","status","tail_record_sha256"\]/,
      `${name} omits rotation snapshot schema`,
    );
    assert.match(section, /[.]rotation_state_identity[.]files == \[\]/);
    assert.match(
      section,
      /[.]rotation_state_snapshot[.]ledger[.]dev == [.]+rotation_state_identity[.]provenance[.]dev/,
    );
    assert.match(
      section,
      /[.]rotation_state_snapshot[.]ledger[.]ino == [.]+rotation_state_identity[.]provenance[.]ino/,
    );
    assert.match(section, /[.]rotation_state_snapshot[.]status == null or/);
    assert.doesNotMatch(section, /all\([.]rotation_state_identity[.]files\[\]/);
  }
  assert.match(forward, /rotation-verify/);
  assert.match(forward, /[.]generation >= \$recorded[.]generation/);
  assert.match(forward, /[.]ledger[.]dev == \$recorded[.]ledger[.]dev/);
  assert.match(forward, /[.]ledger[.]ino == \$recorded[.]ledger[.]ino/);
});

test('GL-a documents and consumes the external operation-bound rotation authority', () => {
  for (const [name, document] of [
    ['operations', operations],
    ['change packet', perfStagingChangePacket],
    ['performance plan', performancePlan],
  ]) {
    assert.match(document, /rotation_anchor_identity/, `${name} omits the external anchor identity`);
    assert.match(
      document,
      /allocated[^\n]*prepared[^\n]*sealed/i,
      `${name} omits the anchor identity state machine`,
    );
    assert.match(
      document,
      /allocated[\s\S]{0,180}?(?:empty-file|empty file|空文件)[\s\S]{0,120}?size[ =]0/i,
      `${name} does not bind allocated to the empty inode`,
    );
    assert.match(
      document,
      /prepared[\s\S]{0,180}?(?:expected|预期)[^\n]*(?:final|最终)[^\n]*(?:SHA|摘要)[^\n]*size/i,
      `${name} omits the prepared target digest and size`,
    );
    assert.match(
      document,
      /sealed[\s\S]{0,180}?physical[\s\S]{0,120}?exact/i,
      `${name} does not require physical reconciliation at seal`,
    );
    assert.match(
      document,
      /\/var\/backups\/aifeeds-performance-log\/rotation-anchor-<operation-id>[.]json/,
      `${name} omits the exact operation-bound anchor path`,
    );
    assert.match(
      document,
      /schema\s*2[\s\S]{0,180}?\{schema,operation_id,directory,provenance,checker,config,logrotate\}/i,
      `${name} omits the authority payload schema`,
    );
    for (const nestedKeys of [
      '{path,uid,gid,mode,dev,ino}',
      '{path,uid,gid,mode,dev,ino,genesis_record_sha256}',
      '{path,sha256,size,uid,gid,mode,dev,ino}',
    ]) assert.ok(document.includes(nestedKeys), `${name} omits authority schema ${nestedKeys}`);
    assert.match(
      document,
      /logrotate[\s\S]{0,180}?\{path,sha256,size,uid,gid,mode,dev,ino\}[\s\S]{0,240}?\/usr\/sbin\/logrotate[\s\S]{0,160}?root:root[\s\S]{0,80}?0?755/i,
      `${name} omits the fixed logrotate full identity`,
    );
    assert.match(
      document,
      /ExecStart[\s\S]{0,260}?operation id[\s\S]{0,220}?anchor[\s\S]{0,220}?checker[\s\S]{0,220}?config[\s\S]{0,220}?logrotate[\s\S]{0,220}?path\/dev\/ino\/SHA/i,
      `${name} does not freeze the service authority arguments`,
    );
    assert.match(
      document,
      /sealed-anchor extractor[\s\S]{0,300}?held[- ]FD[\s\S]{0,240}?final.{0,100}?exact/i,
      `${name} omits sealed-anchor extraction and held-FD final reconciliation`,
    );
    assert.match(
      document,
      /stop[\s\S]{0,100}?(?:timer|service)[\s\S]{0,220}?rotation-recover/i,
      `${name} does not order manual recovery after service quiescence`,
    );
    assert.match(
      document,
      /rolled[_ -]back[\s\S]{0,180}?retain[^\n]*identity[\s\S]{0,300}?path(?:name)?[\s\S]{0,80}?(?:absent|deleted|消失|删除)/i,
      `${name} omits the rolled-back anchor tombstone evidence`,
    );
    assert.match(
      document,
      /rolled[_ -]back[\s\S]{0,220}?allocated[\s\S]{0,100}?prepared[\s\S]{0,100}?sealed/i,
      `${name} falsely promotes partial rollback anchor evidence`,
    );
  }

  const forward = operations.match(
    /\*\*GL-a 部署[\s\S]*?(?=\n本地在任何远端写之前)/,
  )?.[0] ?? '';
  const recovery = operations.match(
    /若 SIGKILL、主机重启、[\s\S]*?(?=\n\*\*精确人工\/崩溃恢复回滚\*\*)/,
  )?.[0] ?? '';
  const rollback = operations.match(
    /\*\*精确人工\/崩溃恢复回滚\*\*[\s\S]*?(?=\n回滚只撤销 nginx)/,
  )?.[0] ?? '';
  for (const [name, section] of [
    ['forward', forward],
    ['recovery', recovery],
    ['manual', rollback],
  ]) {
    assert.match(section, /def rotation_anchor_identity_is_valid:/, `${name} omits anchor validation`);
    assert.match(
      section,
      /\["dev","gid","ino","mode","path","sha256","size","state","uid"\]/,
      `${name} omits the exact anchor identity keys`,
    );
    assert.match(
      section,
      /rotation-anchor-"? \+ \$operation_id \+ "?[.]json/,
      `${name} permits a non-operation-bound anchor path`,
    );
    assert.match(section, /[.]rotation_anchor_identity/, `${name} does not consume anchor identity`);
  }
  assert.match(forward, /def runtime_inventory_is_valid:/);
  assert.match(forward, /\([.]runtime_artifacts \| length\) == 8/);
  assert.match(forward, /[.]runtime_artifacts_sealed == true/);
  assert.match(forward, /def rotation_identity_is_valid:/);
  assert.match(forward, /[.]rotation_anchor_identity[.]state == "sealed"/);
  assert.match(forward, /REMOTE_ROTATION_ANCHOR=/);
  assert.match(forward, /sha256sum '\$REMOTE_ROTATION_ANCHOR'|sha256sum "\$REMOTE_ROTATION_ANCHOR"/);
  assert.match(recovery, /[.]rotation_anchor_identity[.]state == "allocated"/);
  assert.match(recovery, /[.]rotation_anchor_identity[.]state == "prepared"/);
  assert.match(recovery, /[.]rotation_anchor_identity[.]state == "sealed"/);
  assert.match(recovery, /[.]phase == "committed"[\s\S]{0,220}?[.]rotation_anchor_identity[.]state == "sealed"/);
  assert.match(recovery, /[.]phase == "rolled_back"[\s\S]{0,360}?rotation_anchor_identity == null or/);
  assert.match(recovery, /test ! -e '\$REMOTE_ROTATION_ANCHOR'|test ! -e "\$REMOTE_ROTATION_ANCHOR"/);
  assert.match(rollback, /if [.]rotation_anchor_identity == null then true/);
  assert.match(rollback, /[.]rotation_anchor_identity[.]state == "allocated"/);
  assert.match(rollback, /[.]rotation_anchor_identity[.]state == "prepared"/);
  assert.match(rollback, /[.]rotation_anchor_identity[.]state == "sealed"/);
  assert.match(rollback, /test ! -e '\$REMOTE_ROTATION_ANCHOR'|test ! -e "\$REMOTE_ROTATION_ANCHOR"/);
  assert.match(rollback, /aifeeds-performance-log[.]conf[.]candidate-gl-a-\$OPERATION_ID/);
  assert.match(rollback, /aifeeds-performance-logrotate[.]timer[.]candidate-gl-a-\$OPERATION_ID/);
  assert.match(rollback, /aifeeds-performance-logrotate[.]candidate-gl-a-\$OPERATION_ID/);
  assert.match(rollback, /systemctl is-active --quiet aifeeds-performance-logrotate[.]timer/);
});

test('GL-a documents and consumes the cross-filesystem archive handoff identities', () => {
  for (const [name, document] of [
    ['operations', operations],
    ['change packet', perfStagingChangePacket],
    ['performance plan', performancePlan],
  ]) {
    assert.match(document, /journaled[^\n]*quiescent[^\n]*copied[^\n]*archived/i, `${name} omits copied state`);
    assert.match(document, /candidate_dev[^\n]*candidate_ino/, `${name} omits copied-candidate identity`);
    assert.match(document, /destination_dev[^\n]*destination_ino/, `${name} omits published identity`);
    assert.match(
      document,
      /3\s*\*\s*N\s*\+\s*1[\s\S]{0,120}?count[^\n]*candidate_dev/i,
      `${name} omits the mixed-filesystem generation formula`,
    );
    assert.match(
      document,
      /samebytes[\s\S]{0,200}?(?:unknown|different inode|不同 inode)[\s\S]{0,180}?(?:fails? closed|拒绝)/i,
      `${name} permits hash-only handoff adoption`,
    );
    assert.match(
      document,
      /terminal destination[\s\S]{0,160}?physical dev\/ino[\s\S]{0,120}?recorded destination/i,
      `${name} omits terminal physical identity reconciliation`,
    );
    assert.match(document, /previous_manifest_sha256/, `${name} omits predecessor SHA`);
    assert.match(document, /previous_manifest_dev[^\n]*previous_manifest_ino/, `${name} omits predecessor inode`);
    assert.match(
      document,
      /(?:stable (?:file descriptor|fd) capture[\s\S]{0,180}?(?:SHA\/dev\/ino|SHA[^\n]*dev[^\n]*ino)|SHA\/dev\/ino[\s\S]{0,120}?captur[\s\S]{0,100}?stable file descriptor)/i,
      `${name} does not stably capture the predecessor triple`,
    );
    assert.match(document, /P\+T[^\n]*P\+F/i, `${name} omits predecessor recovery states`);
    assert.match(
      document,
      /P-only[\s\S]{0,160}?(?:fails? closed|failclosed)/i,
      `${name} adopts an unauthoritative predecessor`,
    );
  }
  const recovery = operations.match(
    /若 SIGKILL、主机重启、[\s\S]*?(?=\n\*\*精确人工\/崩溃恢复回滚\*\*)/,
  )?.[0] ?? '';
  assert.match(
    recovery,
    /\["candidate","destination","destination_dev","destination_ino","dev","final_mtime_s","final_sha256","final_size","gid","ino","mode","quarantine","source","state","uid"\]/,
  );
  assert.match(
    recovery,
    /\["candidate","candidate_dev","candidate_ino","destination","destination_dev","destination_ino","dev","final_mtime_s","final_sha256","final_size","gid","ino","mode","quarantine","source","state","uid"\]/,
  );
  assert.match(recovery, /select\(has\("candidate_dev"\)\)/);
  assert.match(
    recovery,
    /\["empty_inventory","entries","generation","inventory_complete","operation_id",\s*"previous_manifest_dev","previous_manifest_ino","previous_manifest_sha256","schema"\]/,
  );
  assert.match(recovery, /[.]generation \| type == "number" and [.][ ]*> 0/);
  assert.match(recovery, /[.]previous_manifest_sha256 \| test\("\^\[a-f0-9\]\{64\}\$"\)/);
  assert.match(recovery, /[.]previous_manifest_dev \| type == "number" and [.][ ]*> 0/);
  assert.match(recovery, /[.]previous_manifest_ino \| type == "number" and [.][ ]*> 0/);
  assert.match(recovery, /[.]destination_dev \| type == "number"/);
  assert.match(recovery, /stat -c '%d %i'/);
  assert.match(recovery, /\$destination_dev \$destination_ino/);
});

test('forward local evidence validates the allocated backup identity exposed by the summary', () => {
  const forward = operations.match(
    /\*\*GL-a 部署[\s\S]*?(?=\n本地在任何远端写之前)/,
  )?.[0] ?? '';
  assert.ok(forward, 'forward GL-a runbook section must exist');
  assert.match(forward, /[.]site_backup_identity[.]path == [.]+site_backup/);
  assert.match(forward, /[.]site_backup_identity[.]sha256 == [.]+site_backup_sha256/);
  assert.match(forward, /[.]site_backup_identity[.]staging_mode == "600"/);
  assert.match(forward, /[.]site_backup_identity[.]dev \| type == "number"/);
  assert.match(forward, /[.]site_backup_identity[.]ino \| type == "number"/);
});

test('canonical recovery bundle uses cross-platform directory NOREPLACE and preserves ambiguous state', () => {
  const recovery = operations.match(
    /若 SIGKILL、主机重启、[\s\S]*?(?=\n\*\*精确人工\/崩溃恢复回滚\*\*)/,
  )?.[0] ?? '';
  assert.ok(recovery, 'read-only recovery capture section must exist');
  assert.doesNotMatch(recovery, /mv -f "\$RECOVERY_BUNDLE_TMP" "\$RECOVERY_BUNDLE"/);
  assert.match(recovery, /RECOVERY_PUBLISH_ATTEMPTED=0/);
  assert.match(recovery, /if \[ "\$RECOVERY_PUBLISH_ATTEMPTED" = 0 \]/);
  assert.match(recovery, /RECOVERY_PUBLISH_ATTEMPTED=1[\s\S]*?python3 -/);
  assert.match(recovery, /renamex_np/);
  assert.match(recovery, /RENAME_EXCL/);
  assert.match(recovery, /renameat2/);
  assert.match(recovery, /RENAME_NOREPLACE/);
  assert.match(
    recovery,
    /parent_fd = os[.]open\(os[.]path[.]dirname\(destination\), os[.]O_RDONLY \| os[.]O_DIRECTORY\)/,
  );
  assert.match(recovery, /os[.]fsync\(parent_fd\)/);
  assert.match(recovery, /os[.]close\(parent_fd\)/);
  assert.match(recovery, /test "\$\(dirname "\$RECOVERY_BUNDLE_TMP"\)" = "\$\(dirname "\$RECOVERY_BUNDLE"\)"/);
  assert.match(recovery, /publish failed; preserved tmp and destination/);
  assert.ok(
    recovery.indexOf('RECOVERY_PUBLISH_ATTEMPTED=1')
      < recovery.lastIndexOf('test ! -e "$RECOVERY_BUNDLE"'),
    'a destination that appears during capture must preserve both the private tmp and unknown destination',
  );

  const publisher = recovery.match(
    /python3 - "\$RECOVERY_BUNDLE_TMP" "\$RECOVERY_BUNDLE" <<'PY'\n([\s\S]*?)\nPY/,
  )?.[1] ?? '';
  assert.ok(publisher, 'directory NOREPLACE publisher must be executable Python');
  const sandbox = mkdtempSync(join(tmpdir(), 'gl-a-recovery-publish-'));
  try {
    const source = join(sandbox, 'source');
    const destination = join(sandbox, 'destination');
    mkdirSync(source);
    let result = spawnSync('python3', ['-', source, destination], {
      input: publisher,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(source), false);
    assert.equal(existsSync(destination), true);

    const collision = join(sandbox, 'collision');
    mkdirSync(collision);
    result = spawnSync('python3', ['-', collision, destination], {
      input: publisher,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, 'directory NOREPLACE must reject an existing destination');
    assert.equal(existsSync(collision), true, 'collision source must be preserved');
    assert.equal(existsSync(destination), true, 'existing destination must be preserved');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('GL-a executable runbooks keep exactly 29 syntax-valid bash fences', () => {
  const operationsGlA = operations.match(
    /<!-- aifeeds-performance-log:start -->[\s\S]*?<!-- aifeeds-performance-log:end -->/,
  )?.[0] ?? '';
  const fences = [
    ...extractBashFences(operationsGlA),
    ...extractBashFences(perfStagingChangePacket),
  ];
  assert.equal(fences.length, 29);
  fences.forEach((source, index) => {
    const result = spawnSync('bash', ['-n'], { input: source, encoding: 'utf8' });
    assert.equal(result.status, 0, `bash fence ${index + 1}/29 failed syntax:\n${result.stderr}`);
  });
  const embeddedPython = fences.flatMap((source) =>
    [...source.matchAll(/<<'PY'\n([\s\S]*?)\nPY/g)].map((match) => match[1]),
  );
  assert.ok(embeddedPython.length > 0, 'GL-a runbook must contain its embedded Python publisher');
  embeddedPython.forEach((source, index) => {
    const result = spawnSync(
      'python3',
      ['-c', 'import sys; compile(sys.stdin.read(), "<embedded-python>", "exec")'],
      { input: source, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `embedded Python ${index + 1} failed compile:\n${result.stderr}`);
  });
  const evidenceJqFilters = [
    ['\n  "$LOCAL_SUMMARY_TMP" >/dev/null', 0],
    ['"$RECOVERY_RECORD" >/dev/null', 0],
    ['\n    "$RECOVERY_MANIFEST" >/dev/null', 0],
    ['\n    "$RECOVERY_MANIFEST" >/dev/null', 1],
    ['\n  "$RECORD" >/dev/null', 0],
    ['\n  "$ROLLBACK_SUMMARY_TMP" >/dev/null', 0],
  ].map(([target, occurrence]) => extractJqFilterBefore(operationsGlA, target, occurrence));
  evidenceJqFilters.forEach((source, index) => {
    const variables = [...new Set([...source.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)]
      .map((match) => match[1]))];
    const declarations = variables.flatMap((name) => ['--arg', name, '']);
    const result = spawnSync('jq', [...declarations, '-n', source], { encoding: 'utf8' });
    assert.notEqual(result.status, 3, `evidence jq ${index + 1} failed compile:\n${result.stderr}`);
  });
});

test('GL-a integration matrix derives and reports its current scenario count dynamically', () => {
  const block = installerIntegrationHarness.match(
    /^scenarios=\(\n([\s\S]*?)^\)\n\nscenario_count=/m,
  )?.[1] ?? '';
  const independentBlock = installerIntegrationHarness.match(
    /^independent_recovery_scenarios=\(\n([\s\S]*?)^\)/m,
  )?.[1] ?? '';
  const scenarios = block.split('\n').map((line) => line.trim()).filter(Boolean);
  const independentScenarios = independentBlock.split('\n')
    .map((line) => line.trim()).filter(Boolean);
  assert.equal(cJournalCleanupScenarios.length, 40, 'C journal/cleanup scenario contract drifted');
  assert.equal(scenarios.length, 135, 'update the contract deliberately when the integration matrix changes');
  assert.equal(scenarios.length - cJournalCleanupScenarios.length, 95, 'legacy matrix baseline drifted');
  assert.equal(new Set(scenarios).size, scenarios.length, 'integration scenarios must be unique');
  assert.equal(independentScenarios.length, 10, 'independent recovery contract count drifted');
  assert.equal(new Set(independentScenarios).size, independentScenarios.length,
    'independent recovery contracts must be unique');
  for (const scenario of cJournalCleanupScenarios) {
    assert.ok(scenarios.includes(scenario), `integration matrix missing ${scenario}`);
  }
  assert.match(installerIntegrationHarness, /scenario_count=\$\{#scenarios\[@\]\}/);
  assert.match(installerIntegrationHarness, /scenario_passed=\$\(\(scenario_passed \+ 1\)\)/);
  assert.match(
    installerIntegrationHarness,
    /printf 'GL-a installer integration: %s\/%s scenarios passed\\n' "\$scenario_passed" "\$scenario_count"/,
  );
  for (const [name, document] of [
    ['operations', operations],
    ['change packet', perfStagingChangePacket],
    ['performance plan', performancePlan],
  ]) {
    assert.match(document, /135 scenarios \(95 old [+] 40 new\)/i, `${name} omits frozen matrix size`);
  }
});

test('PR validation tracks and executes performance operations checks', () => {
  const workflow = readWorkflow('pr-validation.yml');

  for (const path of [
    "'deploy/**'",
    "'scripts/benchmark-aifeeds-upstream*'",
    "'scripts/run-aifeeds-staging-backfill*'",
    "'docs/operations.md'",
    "'docs/plans/2026-07-10-c-end-performance-optimization-plan.md'",
    "'docs/reviews/c-end-perf-staging-change-packet.md'",
    "'docs/reviews/c-end-performance-rollout-template.md'",
  ]) {
    assert.ok(workflow.includes(path), `PR path trigger missing: ${path}`);
  }
  assert.ok(
    (workflow.match(/docs\/reviews\/c-end-performance-rollout-template[.]md/g) ?? []).length >= 2,
    'rollout template must trigger the workflow and the performance_ops job',
  );
  assert.ok(
    (
      workflow.match(
        /docs\/plans\/2026-07-10-c-end-performance-optimization-plan[.]md/g,
      ) ?? []
    ).length >= 2,
    'performance optimization plan must trigger the workflow and the performance_ops job',
  );
  assert.ok(
    workflow.includes("'deploy/systemd/aifeeds-performance-logrotate.*'"),
    'performance systemd units must trigger the performance_ops job',
  );
  assert.match(workflow, /performance_ops:\s*\$\{\{\s*steps\.filter\.outputs\.performance_ops\s*\}\}/);
  assert.match(workflow, /validate-performance-ops:/);
  assert.ok(workflow.includes('scripts/benchmark-aifeeds-upstream.test.mjs'));
  assert.ok(workflow.includes('scripts/run-aifeeds-staging-backfill.test.mjs'));
  assert.ok(workflow.includes('deploy/nginx/*.test.mjs'));
  for (const check of [
    'deploy/nginx/check-nginx-request-id.test.py',
    'deploy/nginx/insert-nginx-request-id.test.py',
    'deploy/nginx/verify-nginx-request-id-diff.test.py',
    'bash -n deploy/nginx/install-aifeeds-performance-log.sh',
    'bash -n deploy/nginx/rollback-aifeeds-performance-log.sh',
    'bash deploy/nginx/install-aifeeds-performance-log.integration.test.sh',
  ]) assert.ok(workflow.includes(check), `performance ops workflow missing: ${check}`);
  assert.ok(workflow.includes('scripts/ci/performance-validation-contract.test.mjs'));
});

test('nginx 1.24 keepalive experiment is blocked instead of installable', () => {
  assert.match(operations, /nginx 1\.24\.0/);
  assert.match(operations, /keepalive[^\n]*BLOCKED|BLOCKED[^\n]*keepalive/i);
  assert.match(operations, /1\.27\.3/);
  assert.match(operations, /aifeeds-upstream-performance\.conf[\s\S]{0,160}?不得安装/);
});

test('perf-staging change packet is fail-closed and independently reversible', () => {
  const g7Section = perfStagingChangePacket.match(/## 9[.] G7[：:][\s\S]*?(?=\n### 9[.]3)/)?.[0] ?? '';
  const glbSection = perfStagingChangePacket
    .match(/### 9[.]3 GL-b[：:][\s\S]*?(?=\n## 10[.])/)?.[0] ?? '';
  const joinSection = perfStagingChangePacket.match(
    /### 10[.]1c[\s\S]*?(?=\n### 10[.]2)/,
  )?.[0] ?? '';
  for (const required of [
    'DNS-only',
    'aifeeds-perf-staging-bootstrap.conf',
    'aifeeds-perf-staging-server.conf',
    'nginx -t',
    'certbot certonly --webroot',
    'xlist-dashboard-perf',
    'github-cover-backfill',
    'card-image-variant-backfill',
    'migration 028',
    'aifeeds-performance-log.conf',
    '回滚',
  ]) {
    assert.ok(perfStagingChangePacket.includes(required), `change packet missing: ${required}`);
  }
  assert.match(perfStagingChangePacket, /每个远端写动作[^\n]*单独审批/);
  assert.match(perfStagingChangePacket, /不(?:设置|发送)[\s\S]{0,80}?X-Origin-Secret/);
  assert.match(perfStagingChangePacket, /keepalive[^\n]*BLOCKED|BLOCKED[^\n]*keepalive/i);
  assert.match(perfStagingChangePacket, /favorite[^\n]*N\/A/);
  assert.doesNotMatch(perfStagingChangePacket, /favorite 添加\/取消/);
  assert.match(perfStagingChangePacket, /真实访客 IP[^\n]*per-IP 限流/);
  assert.match(perfStagingChangePacket, /production origin gate/);
  assert.match(perfStagingChangePacket, /SMS 禁用态[^\n]*空 JSON/);
  assert.match(perfStagingChangePacket, /reason=sms_disabled/);
  assert.match(perfStagingChangePacket, /GL-a[^\n]*production VPS\/nginx 写/);
  assert.match(perfStagingChangePacket, /GL-b[^\n]*远端只读/);
  assert.match(perfStagingChangePacket, /GL-a[^\n]*唯一 probe/);
  assert.match(perfStagingChangePacket, /GL-b[^\n]*request-id join/);
  assert.match(perfStagingChangePacket, /production 和 staging API 均尚未回显/);
  assert.match(perfStagingChangePacket, /aifeeds-performance-logrotate\.timer/);
  assert.match(perfStagingChangePacket, /maxsize 50M/);
  assert.match(perfStagingChangePacket, /sha256sum -c SHA256SUMS/);
  assert.match(perfStagingChangePacket, /verify-nginx-request-id-diff\.py/);
  assert.match(perfStagingChangePacket, /logrotate -f -s/);
  assert.match(perfStagingChangePacket, /aifeeds-performance-log\.lock/);
  assert.match(perfStagingChangePacket, /StateDirectory=aifeeds-performance-logrotate/);
  assert.match(perfStagingChangePacket, /site 与 backup 逐字一致/);
  assert.match(perfStagingChangePacket, /site_backup_sha256/);
  assert.match(perfStagingChangePacket, /installed_site_sha256/);
  assert.match(perfStagingChangePacket, /operation id/);
  assert.match(perfStagingChangePacket, /rollback_helper_sha256/);
  assert.match(perfStagingChangePacket, /不可变副本/);
  assert.match(perfStagingChangePacket, /initializing/);
  assert.match(perfStagingChangePacket, /artifact 的 SHA/);
  assert.match(perfStagingChangePacket, /enabled symlink/);
  assert.match(perfStagingChangePacket, /既有 `rolled_back` 永不被重写/);
  assert.match(perfStagingChangePacket, /\/var\/backups\/aifeeds-performance-log/);
  assert.match(perfStagingChangePacket, /current site[^\n]*漂移/);
  assert.match(perfStagingChangePacket, /无 Worker header/);
  assert.match(perfStagingChangePacket, /无 nginx row/);
  assert.match(perfStagingChangePacket, /request-id 不一致/);
  assert.match(perfStagingChangePacket, /禁止盲目回滚/);
  assert.match(perfStagingChangePacket, /direct_worker_header_present/);
  assert.match(perfStagingChangePacket, /direct_worker_echo_matches/);
  assert.match(perfStagingChangePacket, /perf_worker_header_present/);
  assert.match(perfStagingChangePacket, /probe_row_count/);
  assert.match(perfStagingChangePacket, /nginx_request_id_present/);
  assert.match(perfStagingChangePacket, /nginx_log_fetch_ok/);
  assert.match(perfStagingChangePacket, /last_log_fetch_rc/);
  assert.ok(g7Section, 'G7 section must exist');
  assert.ok(
    (g7Section.match(/SSH_OPTS=\(-o BatchMode=yes/g) ?? []).length >= 5,
    'every independently executable G7 shell must define bounded SSH options',
  );
  assert.doesNotMatch(g7Section, /ssh\s+-o\s+ConnectTimeout|ssh\s+-i\s+~\/.ssh\/aifeeds-hk[.]pem/);
  assert.ok(
    (g7Section.match(/timeout --signal=TERM --kill-after=30s/g) ?? []).length >= 3,
    'certbot, nginx transactions, and rollback must have remote hard timeouts',
  );
  assert.match(perfStagingChangePacket, /log_fetch_attempts/);
  assert.match(perfStagingChangePacket, /BatchMode=yes/);
  assert.match(perfStagingChangePacket, /ConnectTimeout=10/);
  assert.match(perfStagingChangePacket, /ServerAliveCountMax=2/);
  assert.match(perfStagingChangePacket, /timeout 15s tail/);
  assert.match(perfStagingChangePacket, /\.probe_row_count == 1/);
  assert.match(perfStagingChangePacket, /GL-b 自身是只读 gate，不授权任何写回滚/);
  assert.ok(glbSection, 'GL-b section must exist');
  assert.ok(
    glbSection.indexOf('SSH_OPTS=(-o BatchMode=yes')
      < glbSection.indexOf('ssh "${SSH_OPTS[@]}"'),
    'GL-b must define its bounded SSH options in the same shell block before first use',
  );
  assert.ok(
    perfStagingChangePacket.indexOf('install -m 0600 "$RAW_DIR/summary.json"')
      < perfStagingChangePacket.indexOf("jq -e '.direct_transport_ok == true"),
    'GL-b must persist a privacy-safe diagnostic summary before enforcing acceptance',
  );
  assert.match(perfStagingChangePacket, /Task 3 JSONL/);
  assert.match(perfStagingChangePacket, /card-variant-spike-candidate\.json/);
  assert.match(perfStagingChangePacket, /card-variant-spike-assets\.signature\.json/);
  assert.match(perfStagingChangePacket, /CONTENT_LENGTH/);
  assert.match(perfStagingChangePacket, /sips -g pixelWidth/);
  assert.match(perfStagingChangePacket, /map\(\.width\) == \[400, 800\]/);
  assert.match(perfStagingChangePacket, /EXPECTED_PREFIX/);
  assert.match(perfStagingChangePacket, /test "\$ASSET_SHA256" = "\$URL_SHA256"/);
  assert.match(perfStagingChangePacket, /不能把 nullable `next_cursor` 猜成/);
  assert.ok(
    (perfStagingChangePacket.match(/\.status\) == "complete"/g) ?? []).length >= 2,
    'both write backfills must reject a bounded pause as gate completion',
  );
  assert.match(perfStagingChangePacket, /"sources":\["news","x"\]/);
  assert.doesNotMatch(perfStagingChangePacket, /"sources":\["blog","podcast"\]/);
  assert.ok(
    (perfStagingChangePacket.match(/Authorization: Bearer \$CF_DNS_API_TOKEN/g) ?? []).length >= 3,
    'DNS read/create/delete must use the scoped DNS token',
  );
  assert.doesNotMatch(perfStagingChangePacket, /Authorization: Bearer \$CLOUDFLARE_API_TOKEN/);
  assert.match(perfStagingChangePacket, /G6c credential gate 当前 BLOCKED/);
  assert.match(perfStagingChangePacket, /test:e2e:perf-staging/);
  assert.match(perfStagingChangePacket, /E2E_OUTPUT_DIR="\$EVIDENCE\/playwright"/);
  assert.match(perfStagingChangePacket, /E2E_PERF_PROBE="\$E2E_PERF_PROBE"/);
  assert.match(perfStagingChangePacket, /PLAYWRIGHT_NO_COPY_PROMPT=1/);
  assert.match(perfStagingChangePacket, /PLAYWRIGHT_STATUS=\$\?/);
  assert.match(perfStagingChangePacket, /-iname '\*\.md'/);
  assert.match(perfStagingChangePacket, /nginx-worker-join-summary\.json/);
  assert.match(perfStagingChangePacket, /tail -n 20000 \/var\/log\/nginx\/aifeeds-performance\.jsonl/);
  assert.match(perfStagingChangePacket, /request_id_join/);
  assert.match(perfStagingChangePacket, /browser_request_ids_joined/);
  assert.match(perfStagingChangePacket, /matching_rows >= 6/);
  assert.match(perfStagingChangePacket, /codex_perf_probe=1/);
  assert.match(perfStagingChangePacket, /workerStart>0/);
  assert.match(perfStagingChangePacket, /aifeeds:feed-ready/);
  assert.match(perfStagingChangePacket, /cold feed-ready ≤5s \/ LCP ≤7s/);
  assert.match(perfStagingChangePacket, /CLS[^\n]*≤0\.1/);
  assert.match(perfStagingChangePacket, /feed-ready cutoff/);
  assert.match(perfStagingChangePacket, /CLS 记录 `unsupported`/);
  assert.match(perfStagingChangePacket, /desktop=`x_list \+ blog,podcast \+ product_hunt`/);
  assert.match(perfStagingChangePacket, /卡图 `\/r\/`[\s\S]{0,120}?staging-api\.ai-feeds\.com/);
  assert.match(perfStagingChangePacket, /video poster/);
  assert.match(perfStagingChangePacket, /aifeeds:cls-settled/);
  assert.match(perfStagingChangePacket, /非受信任[^\n]*pointerdown/);
  assert.match(perfStagingChangePacket, /BROWSER_UA='Mozilla\/5\.0/);
  assert.match(perfStagingChangePacket, /dns-operation-id\.txt/);
  assert.match(perfStagingChangePacket, /\.dns-operation\.lock/);
  assert.match(perfStagingChangePacket, /dns-create-prepared\.txt/);
  assert.match(
    perfStagingChangePacket,
    /attempted_tmp=.*&&[\s\S]{0,300}?mv .*ATTEMPTED_FILE.*&&[\s\S]{0,120}?exec curl -sS/,
  );
  assert.match(perfStagingChangePacket, /exec curl -sS/);
  assert.match(perfStagingChangePacket, /another DNS create\/rollback process/);
  assert.match(perfStagingChangePacket, /comment:\$comment/);
  assert.match(perfStagingChangePacket, /aifeeds-perf-staging-dns\\\.\[A-Za-z0-9\]/);
  assert.match(perfStagingChangePacket, /mktemp -d \/run\/aifeeds-perf-staging\.XXXXXX/);
  assert.match(perfStagingChangePacket, /aifeeds-perf-staging-nginx\.lock/);
  assert.match(perfStagingChangePacket, /SITE_CREATED=0/);
  assert.match(perfStagingChangePacket, /LINK_CREATED=0/);
  assert.match(perfStagingChangePacket, /if \[ "\$LINK_CREATED" = 1 \]/);
  assert.match(perfStagingChangePacket, /if \[ "\$SITE_CREATED" = 1 \]/);
  assert.match(perfStagingChangePacket, /nginx-bootstrap-remote\.sha256/);
  assert.match(perfStagingChangePacket, /nginx-final-remote\.sha256/);
  assert.doesNotMatch(perfStagingChangePacket, /\/tmp\/aifeeds-perf-staging-(?:bootstrap|server)\.conf/);
  assert.doesNotMatch(perfStagingChangePacket, /\/tmp\/perf-staging-/);
  assert.doesNotMatch(perfStagingChangePacket, /\$EVIDENCE\/worker-smoke\.json/);
  assert.doesNotMatch(perfStagingChangePacket, /\$EVIDENCE\/[^\n]*gzip-decoded\.json/);
  assert.doesNotMatch(perfStagingChangePacket, /\$EVIDENCE\/card-variant-spike-item\.json/);
  assert.match(perfStagingChangePacket, /aifeeds-perf-g1\.XXXXXX/);
  assert.match(perfStagingChangePacket, /aifeeds-perf-g2\.XXXXXX/);
  assert.match(perfStagingChangePacket, /aifeeds-perf-g4b1\.XXXXXX/);
  assert.ok(joinSection, '10.1c join section must exist');
  assert.ok(
    joinSection.includes('test "$(cat "$EVIDENCE/commit.txt")" = "$(git rev-parse HEAD)"'),
    '10.1c must bind evidence to the frozen commit',
  );
  assert.ok(
    joinSection.includes('test -z "$(git status --porcelain)"'),
    '10.1c must reject a dirty worktree before writing acceptance evidence',
  );
  assert.ok(
    joinSection.indexOf('SSH_OPTS=(-o BatchMode=yes')
      < joinSection.indexOf('ssh "${SSH_OPTS[@]}"'),
    '10.1c must define bounded SSH options in its own shell block',
  );
  assert.match(joinSection, /timeout 15s tail -n 20000/);
});

test('rollout evidence is privacy-safe and distinguishes cold from warm service worker', () => {
  assert.match(rolloutTemplate, /cold-warm-page-performance\.json/);
  assert.match(rolloutTemplate, /workerStart/);
  assert.match(rolloutTemplate, /feed-ready/);
  assert.match(rolloutTemplate, /cold feed-ready ≤5s/);
  assert.match(rolloutTemplate, /CLS ≤0\.1/);
  assert.match(rolloutTemplate, /feed-ready 作为请求竞争 cutoff/);
  assert.match(rolloutTemplate, /video poster/);
  assert.match(rolloutTemplate, /字体[^\n]*CLS|CLS[^\n]*字体/);
  assert.match(rolloutTemplate, /禁止[\s\S]{0,40}?URL、query、item id/);
  assert.match(rolloutTemplate, /禁止 trace、HAR、截图、录像、HTML report 和 storageState/);
  assert.doesNotMatch(rolloutTemplate, /waterfall、trace、截图\/HAR 链接/);
});
