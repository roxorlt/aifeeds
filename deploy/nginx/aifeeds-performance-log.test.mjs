import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const configPath = resolve(here, 'aifeeds-performance-log.conf');
const rotatePath = resolve(here, 'aifeeds-performance.logrotate');
const installerPath = resolve(here, 'install-aifeeds-performance-log.sh');
const rollbackScriptPath = resolve(here, 'rollback-aifeeds-performance-log.sh');
const checkerPath = resolve(here, 'check-nginx-request-id.py');
const systemctlShimPath = resolve(here, 'test-fixtures/gl-a-installer/shims/systemctl');
const syncShimPath = resolve(here, 'test-fixtures/gl-a-installer/shims/sync');
const integrationPath = resolve(here, 'install-aifeeds-performance-log.integration.test.sh');
const scenarioRunnerPath = resolve(here, 'test-fixtures/gl-a-installer/run-scenario.sh');
const servicePath = resolve(root, 'deploy/systemd/aifeeds-performance-logrotate.service');
const timerPath = resolve(root, 'deploy/systemd/aifeeds-performance-logrotate.timer');
const operationsPath = resolve(root, 'docs/operations.md');
const config = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
const rotate = existsSync(rotatePath) ? readFileSync(rotatePath, 'utf8') : '';
const installer = existsSync(installerPath) ? readFileSync(installerPath, 'utf8') : '';
const rollbackScript = existsSync(rollbackScriptPath) ? readFileSync(rollbackScriptPath, 'utf8') : '';
const checker = existsSync(checkerPath) ? readFileSync(checkerPath, 'utf8') : '';
const systemctlShim = existsSync(systemctlShimPath) ? readFileSync(systemctlShimPath, 'utf8') : '';
const syncShim = existsSync(syncShimPath) ? readFileSync(syncShimPath, 'utf8') : '';
const integration = existsSync(integrationPath) ? readFileSync(integrationPath, 'utf8') : '';
const scenarioRunner = existsSync(scenarioRunnerPath) ? readFileSync(scenarioRunnerPath, 'utf8') : '';
const service = existsSync(servicePath) ? readFileSync(servicePath, 'utf8') : '';
const timer = existsSync(timerPath) ? readFileSync(timerPath, 'utf8') : '';
const operations = readFileSync(operationsPath, 'utf8');

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

const quiescencePython = installer.match(
  /wait_for_writable_inode_quiescent\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY\n\}/,
)?.[1] ?? '';
const rollbackQuiescencePython = rollbackScript.match(
  /wait_for_writable_inode_quiescent\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY\n\}/,
)?.[1] ?? '';
const probeValidationFilter = installer.match(
  /tail -n 2000 "\$LOG" \| jq -s -e --arg probe "\$expected_probe" '([\s\S]*?)' >\/dev\/null/,
)?.[1] ?? '';

function runQuiescence(path, timeoutSeconds) {
  const { dev, ino } = statSync(path);
  const child = spawn('python3', ['-', path, String(dev), String(ino), String(timeoutSeconds)], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  child.stdin.end(quiescencePython);
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
}

function performanceRunbook() {
  const start = '<!-- aifeeds-performance-log:start -->';
  const end = '<!-- aifeeds-performance-log:end -->';
  const startIndex = operations.indexOf(start);
  const endIndex = operations.indexOf(end);

  if (startIndex < 0 || endIndex < startIndex) return '';
  return operations.slice(startIndex, endIndex + end.length);
}

function safeUriFor(pathname) {
  const block = config.match(/map\s+\$uri\s+\$aifeeds_safe_uri\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(block, 'safe URI map must exist');

  let fallback;
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const regexRule = line.match(/^~(\S+)\s+(\S+);$/);
    if (regexRule && new RegExp(regexRule[1]).test(pathname)) return regexRule[2];

    const defaultRule = line.match(/^default\s+(\S+);$/);
    if (defaultRule) fallback = defaultRule[1];
  }

  return fallback === '$uri' ? pathname : fallback;
}

function clientClassFor(userAgent) {
  const block = config.match(/map\s+\$http_user_agent\s+\$aifeeds_client_class\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(block, 'client class map must exist');

  let fallback;
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;

    const regexRule = line.match(/^~\*(\S+)\s+(\S+);$/);
    if (regexRule && new RegExp(regexRule[1], 'i').test(userAgent)) return regexRule[2];

    const defaultRule = line.match(/^default\s+(\S+);$/);
    if (defaultRule) fallback = defaultRule[1];
  }
  return fallback;
}

function probeRow(overrides = {}) {
  return {
    bytes_sent: '128',
    client_class: 'other',
    host: 'ai-feeds.com',
    perf_probe: 'upstream-1773566418-a1b2c3d4',
    request_id: '0123456789abcdef0123456789abcdef',
    request_time: '0.000',
    status: '200',
    timestamp: '2026-07-15T09:20:18+00:00',
    upstream_cache_status: 'HIT',
    upstream_connect_time: '',
    upstream_header_time: '',
    upstream_response_time: '',
    uri: '/',
    ...overrides,
  };
}

function validateProbeRows(rows) {
  assert.ok(probeValidationFilter, 'installer probe jq filter must be extractable');
  return spawnSync(
    'jq',
    ['-s', '-e', '--arg', 'probe', rows[0].perf_probe, probeValidationFilter],
    { input: `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, encoding: 'utf8' },
  );
}

test('performance log is a host-scoped http-context JSON include', () => {
  assert.ok(config, 'versioned performance log config must exist');
  assert.match(config, /log_format\s+aifeeds_performance\s+escape=json/);

  for (const variable of [
    '$request_id',
    '$host',
    '$uri',
    '$status',
    '$request_time',
    '$upstream_connect_time',
    '$upstream_header_time',
    '$upstream_response_time',
    '$upstream_cache_status',
    '$bytes_sent',
    '$http_user_agent',
    '$aifeeds_safe_uri',
    '$aifeeds_perf_probe',
    '$aifeeds_client_class',
  ]) {
    assert.ok(config.includes(variable), `missing ${variable}`);
  }

  assert.match(config, /map\s+\$host\s+\$aifeeds_performance_loggable\s*\{/);
  assert.match(config, /map\s+\$uri\s+\$aifeeds_safe_uri\s*\{/);
  assert.match(config, /default\s+0;/);
  for (const host of [
    'ai-feeds.com',
    'api.ai-feeds.com',
    'fonts.ai-feeds.com',
    'perf-staging.ai-feeds.com',
  ]) {
    assert.match(config, new RegExp(`\\b${host.replaceAll('.', '\\.') }\\s+1;`));
  }
  assert.match(config, /map\s+\$http_x_aifeeds_perf_probe\s+\$aifeeds_perf_probe\s*\{/);
  assert.match(config, /"~\^upstream-\[0-9\]\{10,16\}-\[A-Fa-f0-9\]\{8\}\$"/);
  assert.ok(config.includes('"perf_probe":"$aifeeds_perf_probe"'));
  assert.match(
    config,
    /access_log\s+\/var\/log\/nginx\/aifeeds-performance\.jsonl\s+aifeeds_performance\s+buffer=64k\s+flush=5s\s+if=\$aifeeds_performance_loggable;/,
  );
  assert.doesNotMatch(config, /\bproxy_set_header\b/);
  assert.doesNotMatch(config, /\$(?:request_uri|args|query_string|http_cookie|http_authorization)\b/i);
  assert.doesNotMatch(config, /origin.secret/i);
  assert.ok(config.includes('"uri":"$aifeeds_safe_uri"'));
  assert.ok(!config.includes('"uri":"$uri"'), 'raw URI must never be written directly');
  assert.ok(config.includes('"client_class":"$aifeeds_client_class"'));
  assert.ok(!config.includes('"user_agent"'), 'raw user agent must never be written');
});

test('safe URI map redacts permanent share tokens without hiding fixed routes', () => {
  assert.equal(safeUriFor('/s/permanent_share_token'), '/s/:token');
  assert.equal(safeUriFor('/s/encoded/token'), '/s/:token');
  assert.equal(safeUriFor('/api/share/poster/permanent_share_token'), '/api/share/poster/:token');
  assert.equal(safeUriFor('/api/share/poster/encoded/token'), '/api/share/poster/:token');
  assert.equal(safeUriFor('/api/admin/share/permanent_share_token'), '/api/admin/share/:token');
  assert.equal(safeUriFor('/api/admin/share/poster-cleanup'), '/api/admin/share/poster-cleanup');
  assert.equal(safeUriFor('/api/items'), '/api/items');
  assert.equal(safeUriFor('/api/items/private-item-id'), '/api/items/:id');
  assert.equal(safeUriFor('/assets/index-secret.js'), '/assets/:asset');
  assert.equal(safeUriFor('/r/x/card/private-hash.webp'), '/r/:asset');
  assert.equal(safeUriFor('/alice@example.com'), '/:other');
  assert.equal(safeUriFor('/13800138000'), '/:other');
  assert.equal(safeUriFor('/reset/private-token'), '/:other');
});

test('client classification never persists attacker-controlled user-agent text', () => {
  assert.equal(clientClassFor('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'iphone');
  assert.equal(clientClassFor('Mozilla/5.0 (Linux; Android 15; Pixel 9)'), 'android');
  assert.equal(clientClassFor('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'desktop');
  assert.equal(clientClassFor('alice@example.com private-token'), 'other');
});

test('probe validator accepts empty upstream timings only for cached front responses', () => {
  const apiRow = probeRow({
    host: 'api.ai-feeds.com',
    uri: '/api/items',
    upstream_cache_status: '',
    upstream_connect_time: '0.007',
    upstream_header_time: '0.253',
    upstream_response_time: '0.253',
  });

  const cached = validateProbeRows([probeRow(), apiRow]);
  assert.equal(cached.status, 0, cached.stderr);

  const uncached = validateProbeRows([
    probeRow({ upstream_cache_status: '' }),
    apiRow,
  ]);
  assert.notEqual(uncached.status, 0, 'uncached empty upstream timings must remain invalid');
});

test('runbook scopes installation to aifeeds sites and documents safe join and staging limits', () => {
  const runbook = performanceRunbook();
  assert.ok(runbook, 'performance log runbook markers must exist');

  for (const required of [
    '本次提交版本化',
    'staging.ai-feeds.com',
    'staging-api.ai-feeds.com',
    '不经过香港 VPS',
    '~/.ssh/aifeeds-hk.pem',
    '/etc/nginx/conf.d/aifeeds-performance-log.conf',
    '/etc/nginx/sites-available/aifeeds.conf',
    'access_log /var/log/nginx/aifeeds-performance.jsonl aifeeds_performance buffer=64k flush=5s if=$aifeeds_performance_loggable;',
    'proxy_set_header X-Request-Id $request_id;',
    'X-Request-Id',
    'Worker',
    'jq -e',
    'deploy/nginx/check-nginx-request-id.py',
    '/usr/local/sbin/aifeeds-check-nginx-request-id',
    '--expect-proxy-count 7',
    '--allow-include /etc/letsencrypt/options-ssl-nginx.conf',
    'perf_probe',
    'X-Aifeeds-Perf-Probe',
    'GL-a',
    'GL-b',
    '生产和 staging API 均尚未回显',
    '不得把 Worker join 伪装成 GL-a 已通过',
    'access_log_directives=0',
    'include_count=4',
    '/run/aifeeds-performance-log.lock',
    'StateDirectory=aifeeds-performance-logrotate',
    'site 与 backup 逐字一致',
    'timer inactive',
  ]) {
    assert.ok(runbook.includes(required), `runbook missing ${required}`);
  }

  assert.doesNotMatch(runbook, /nginx\s+-T/);
  assert.doesNotMatch(runbook, /PROXY_COUNT|REQUEST_ID_COUNT/);
  assert.doesNotMatch(runbook, /只给 root\/adm/);
  assert.match(runbook, /`www-data` 服务账号也可读/);
});

test('runbook rotates by reopening nginx and gives exact rollback files', () => {
  const runbook = performanceRunbook();

  for (const required of [
    '/etc/aifeeds-performance-logrotate.conf',
    'maxsize 50M',
    'aifeeds-performance-logrotate.timer',
    'systemctl enable --now "$TIMER_UNIT"',
    'logrotate -f -s "$FORCE_ROTATE_STATE" "$ROTATE"',
    'rotation_probe',
    'sha256sum -c SHA256SUMS',
    'verify-nginx-request-id-diff.py',
    'automatic_rollback=pass',
    'aifeeds.conf.bak-perf-',
    'rollback-aifeeds-performance-log.sh',
    'base 与 candidate',
    'rollback journal',
    '`rolled_back`',
    'site_backup_sha256',
    'installed_site_sha256',
    'SOURCE_JOURNAL_SHA256',
    'gl-a-operation-id.txt',
    'IMMUTABLE_ROLLBACK_HELPER',
    'ROLLBACK_HELPER_SHA256',
    'G0_COMMIT',
    'GL_A_RECOVERY_MODE',
    'BatchMode=yes',
    'ConnectTimeout=10',
    'ServerAliveCountMax=2',
    'timeout --signal=TERM --kill-after=30s',
    'initializing → prepared → backup_created',
    'artifacts_sha256',
    'enabled-site symlink',
    'source_journal_terminal_sha256',
    'rollback_journal_sha256',
    'flock -n 9',
    '未知 hash 立即停止',
  ]) {
    assert.ok(runbook.includes(required), `rotation/rollback missing ${required}`);
  }
  assert.doesNotMatch(runbook, /BACKUP=\/etc\/nginx\/sites-available\/aifeeds\.conf\.bak-perf-YYYY/);
});

test('versioned logging installer is private, transactional, and status-exact', () => {
  const deliveredRollbackProtocol = `${installer}\n${rollbackScript}`;
  for (const [name, content] of [
    ['rotate', rotate],
    ['installer', installer],
    ['service', service],
    ['timer', timer],
  ]) assert.ok(content, `${name} artifact must be versioned`);

  assert.match(rotate, /daily/);
  assert.match(rotate, /maxsize 50M/);
  assert.match(rotate, /rotate 14/);
  assert.match(rotate, /create 0640 www-data adm/);
  assert.match(service, /StateDirectory=aifeeds-performance-logrotate/);
  assert.match(service, /StateDirectoryMode=0750/);
  assert.match(
    service,
    /ExecStart=\/usr\/local\/sbin\/aifeeds-check-nginx-request-id rotation-wrapper/,
  );
  assert.match(service, /ConditionPathExists=\/etc\/aifeeds-performance-logrotate[.]conf/);
  assert.doesNotMatch(service, /\/etc\/logrotate[.]d\/aifeeds-performance/);
  assert.match(service, /ReadWritePaths=\/var\/log\/nginx/);
  assert.doesNotMatch(service, /ReadWritePaths=[^\n]*\s\/var\/lib(?:\s|$)/);
  assert.match(timer, /OnCalendar=[*]:0\/5/);
  assert.match(timer, /AccuracySec=30s/);
  assert.match(timer, /RandomizedDelaySec=30s/);
  assert.match(timer, /Persistent=true/);

  for (const required of [
    'set -euo pipefail',
    'sha256sum -c SHA256SUMS',
    '--expect-proxy-count 7',
    '--allow-include /etc/letsencrypt/options-ssl-nginx.conf',
    'verify-nginx-request-id-diff.py',
    'automatic_rollback=pass',
    "test \"$FRONT_STATUS\" = 200",
    "test \"$API_STATUS\" = 200",
    'curl -fsS --connect-timeout 5 --max-time 15',
    'systemctl is-active --quiet nginx',
    'systemctl is-active --quiet aifeeds-performance-logrotate.timer',
    'logrotate -f -s "$FORCE_ROTATE_STATE" "$ROTATE"',
    'rotation_probe',
    '($rows | length) == 2',
    'any($rows[]; .host == "ai-feeds.com" and .uri == "/")',
    'any($rows[]; .host == "api.ai-feeds.com" and .uri == "/api/items")',
    'ROTATION_FRONT_STATUS',
    'ROTATION_API_STATUS',
    'logrotate-dry-run.state',
    'copy_file_no_replace "$BACKUP" "$ROLLBACK_CANDIDATE"',
    'publish_site_no_replace "$SITE" "$ROLLBACK_CANDIDATE" "$INSTALLER_CANDIDATE"',
    'assert_site_base_unchanged',
    'stat -c \'%u\' "$SITE"',
    'stat -c \'%g\' "$SITE"',
    'stat -c \'%a\' "$SITE"',
    'unit_is_inactive "$TIMER_UNIT"',
    'systemctl stop "$ROTATE_SERVICE"',
    'unit_is_inactive "$ROTATE_SERVICE"',
    'timer_is_disabled',
    'ROTATE_STATE_DIR=/var/lib/aifeeds-performance-logrotate',
    'ROTATE_SERVICE=aifeeds-performance-logrotate.service',
    'systemctl start "$ROTATE_SERVICE"',
    'truncate -s 52428801 "$LOG"',
    'SYSTEMD_BEFORE_INODE=',
    'SYSTEMD_AFTER_INODE=',
    'systemd_rotation_probe',
    'test -s "$ROTATE_STATE"',
    'systemctl show -p Result --value "$ROTATE_SERVICE"',
    'LOCK=/run/aifeeds-performance-log.lock',
    'exec 9>"$LOCK"',
    'flock -n 9',
    "strict_grep_count '^[[:space:]]*include[[:space:]]' \"$ALLOWED_INCLUDE\"",
    'BACKUP_DIR=/var/backups/aifeeds-performance-log',
    'ROTATE=/etc/aifeeds-performance-logrotate.conf',
    'SITE_BASE_SHA256=',
    'EXPECTED_INSTALLED_SITE_SHA256=',
    'assert_installed_site_unchanged',
    'AVAILABLE_KIB=',
    'AVAILABLE_INODES=',
    'test "$AVAILABLE_KIB" -ge 5242880',
    'test "$AVAILABLE_INODES" -ge 100000',
    'systemd-analyze verify "$SERVICE_PATH" "$TIMER_PATH"',
    'JOURNAL="${BACKUP_DIR}/transaction-${BACKUP_ID}.json"',
    'write_journal initializing',
    'write_journal prepared',
    'write_journal backup_created',
    'write_journal mutated',
    'write_journal timer_enabled',
    'write_journal committed',
    'transaction_journal_sha256',
    'write_journal rolled_back',
    'write_journal rollback_failed',
    'os.fsync(parent_descriptor)',
    'ERROR recovery_required=1',
    "-name 'rollback-transaction-*.json*'",
    'AUDIT_DIR="${BACKUP_DIR}/audit-${BACKUP_ID}"',
    'archive_performance_logs',
    'ROLLBACK_PROBE=',
    'rm -f "$SUMMARY_TMP" "$SUMMARY"',
    'install -d -o root -g root -m 0700 "$BACKUP_DIR"',
    'stat -c \'%u\' "$BACKUP"',
    'stat -c \'%g\' "$BACKUP"',
    'stat -c \'%a\' "$BACKUP"',
    'SITE_UID=',
    'SITE_GID=',
    'SITE_MODE=',
    'site_backup_sha256',
    'installed_site_sha256',
    "trap '' HUP INT TERM",
    'formal_site_matches_state "$SITE" installed',
    'formal_site_matches_state "$SITE" base',
    'test "$#" = 3',
    'OPERATION_ID=$2',
    'G0_COMMIT=$3',
    'rollback_helper_sha256',
    'rollback-aifeeds-performance-log.sh',
    'ARTIFACTS_SHA256_JSON=',
    'rollback_candidate:$rollback_candidate',
    'rollback_artifacts_are_owned',
    'performance_logs_are_owned',
    'rotation_state_is_owned',
    'validate_terminal_source_journal',
    'validate_terminal_rollback_journal',
    'validate_terminal_runtime_residue',
    'assert_enabled_site_target',
  ]) assert.ok(deliveredRollbackProtocol.includes(required), `delivery missing ${required}`);

  assert.ok(rollbackScript.includes('start_runtime_cleanup_plan'));
  assert.ok(rollbackScript.includes('complete_runtime_cleanup_plan'));
  assert.ok(rollbackScript.includes('assert_backup_unchanged'));
  assert.ok(rollbackScript.includes('rollback_audit_is_terminal'));
  assert.doesNotMatch(
    installer.match(/rollback_on_failure\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '',
    /remove_owned_artifact|assert_automatic_cleanup_state|rollback_ok/,
  );

  assert.ok(
    installer.indexOf('systemctl enable --now "$TIMER_UNIT"')
      > installer.lastIndexOf('probe_is_valid "$rotation_probe"'),
    'timer must be enabled only after forced rotation and post-rotation writes pass',
  );
  assert.ok(
    installer.indexOf('flock -n 9') < installer.indexOf('test "$(curl_status https://ai-feeds.com/)" = 200'),
    'global deployment lock must be held before remote-state preflight',
  );
  assert.ok(
    installer.indexOf('write_journal initializing')
      < installer.indexOf('cp -a "$SITE" "$SITE_BUILD_CANDIDATE"'),
    'durable initializing journal must precede private candidate construction',
  );
  assert.ok(
    installer.indexOf('write_journal prepared')
      < installer.lastIndexOf('backup_allocation_identity="$(create_site_backup_inode_no_replace)'),
    'durable prepared journal must precede backup inode allocation',
  );

  assert.doesNotMatch(installer, /curl[^\n]*-D\s+-/);
  assert.doesNotMatch(installer, /\/tmp\/aifeeds-performance/);
  assert.doesNotMatch(installer, /\/etc\/logrotate[.]d\/aifeeds-performance/);
});

test('installer journals mutation before atomically publishing owned artifacts', () => {
  for (const required of [
    'write_journal mutation_started',
    'prepare_atomic_owned',
    'publish_atomic_owned',
    'runtime_artifacts:$runtime_artifacts',
    'runtime_artifacts_sealed:$runtime_artifacts_sealed',
    'transaction_temp_is_owned_or_absent',
    'remove_transaction_temp',
  ]) assert.ok(installer.includes(required), `installer missing ${required}`);

  assert.ok(
    installer.indexOf('write_journal mutation_started') < installer.indexOf('MUTATED=1'),
    'mutation_started must be durable before the rollback path considers the host mutated',
  );
  assert.ok(
    installer.indexOf('MUTATED=1')
      < installer.lastIndexOf('prepare_atomic_owned format "$STAGING/aifeeds-performance-log.conf"'),
    'the rollback trap must be armed before the first atomic artifact write',
  );
  assert.ok(
    installer.lastIndexOf('prepare_atomic_owned timer')
      < installer.lastIndexOf('RUNTIME_ARTIFACTS_SEALED=true')
      && installer.lastIndexOf('RUNTIME_ARTIFACTS_SEALED=true')
        < installer.lastIndexOf('publish_atomic_owned format'),
    'all eight candidate identities must be sealed before any final publication',
  );
  assert.ok(
    installer.includes('LOG_CANDIDATE="${LOG%/*}/.${LOG##*/}.candidate-gl-a-${OPERATION_ID}"'),
    'the log transaction candidate must not match the canonical live-log glob',
  );
  assert.ok(installer.includes('restore_candidate_is_owned_or_absent'));
  assert.ok(installer.includes('ROLLBACK_CANDIDATE="${SITE}.rollback-gl-a-${OPERATION_ID}"'));
});

test('site candidate is built privately and its target hash is journaled before no-replace publication', () => {
  for (const required of [
    'SITE_BUILD_CANDIDATE=',
    'copy_file_no_replace "$SITE_BUILD_CANDIDATE" "$CANDIDATE"',
    'persist_installer_candidate_identity',
    'installer_candidate_dev',
    'installer_candidate_ino',
  ]) {
    assert.ok(installer.includes(required), `private site build contract missing ${required}`);
  }
  const build = installer.lastIndexOf('cp -a "$SITE" "$SITE_BUILD_CANDIDATE"');
  const prepared = installer.indexOf('write_journal prepared', build);
  const publish = installer.lastIndexOf('copy_file_no_replace "$SITE_BUILD_CANDIDATE" "$CANDIDATE"');
  assert.ok(build < prepared && prepared < publish, 'prepared target hash must precede formal candidate publication');
  assert.ok(
    publish < installer.lastIndexOf('persist_installer_candidate_identity'),
    'formal candidate identity must be durably journaled after publication',
  );
  assert.doesNotMatch(installer, /cp -a "\$SITE" "\$CANDIDATE"/);
});

test('owned artifact publication cannot overwrite a candidate or destination takeover', () => {
  const atomicPrepare = installer.match(/prepare_atomic_owned\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const atomicPublish = installer.match(/publish_atomic_owned\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const exclusiveCreate = installer.match(/create_owned_candidate_no_replace\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const ownedTemp = installer.match(/transaction_temp_is_owned_or_absent\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

  assert.ok(atomicPrepare, 'prepare_atomic_owned helper must exist');
  assert.ok(atomicPublish, 'publish_atomic_owned helper must exist');
  assert.ok(exclusiveCreate, 'exclusive owned-candidate creator must exist');
  for (const required of ['O_EXCL', 'O_NOFOLLOW', 'expected_sha256', 'expected_dev', 'expected_ino']) {
    assert.ok(exclusiveCreate.includes(required), `exclusive candidate creation missing ${required}`);
  }
  for (const required of [
    'create_owned_candidate_no_replace',
    'path_matches_exact_identity "$candidate"',
    'record_runtime_artifact_identity',
    'write_journal "$LAST_JOURNAL_PHASE"',
  ]) assert.ok(atomicPrepare.includes(required), `atomic artifact preparation missing ${required}`);
  for (const required of [
    'runtime_artifact_inventory_is_complete',
    'rename_no_replace "$candidate" "$destination"',
    'path_matches_exact_identity "$destination"',
  ]) assert.ok(atomicPublish.includes(required), `atomic artifact publication missing ${required}`);
  assert.doesNotMatch(atomicPublish, /mv\s+-f\s+"\$candidate"\s+"\$destination"/);
  assert.match(ownedTemp, /transaction_temp_expected_sha256/);
  assert.match(ownedTemp, /path_matches_exact_identity/);
  assert.match(ownedTemp, /"\$final_metadata"/);
  assert.match(ownedTemp, /'root root 600'\) return 1/);
  const tempRemoval = installer.match(/remove_transaction_temp\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const finalRemoval = rollbackScript.match(/runtime_cleanup_unlink_item\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(tempRemoval, /private_cleanup_tombstone/);
  assert.match(finalRemoval, /os[.]open\(name, flags, dir_fd=parent_descriptor\)/);
  assert.match(finalRemoval, /after[.]st_nlink/);
  assert.doesNotMatch(tempRemoval, /rm -f/);
  assert.doesNotMatch(finalRemoval, /os[.]remove|rm -f/);
});

test('SITE publication uses no-replace three-path CAS and preserves conflicts', () => {
  const cas = installer.match(/publish_site_no_replace\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

  assert.ok(cas, 'installer publish_site_no_replace helper must exist');
  assert.match(cas, /renameat2/);
  assert.match(cas, /RENAME_NOREPLACE/);
  assert.match(cas, /ROLLBACK_CANDIDATE/);
  assert.match(cas, /EEXIST|File exists/);
  assert.match(cas, /expected_current_sha256/);
  assert.match(cas, /expected_candidate_sha256/);
  assert.ok(installer.includes(
    'publish_site_no_replace "$SITE" "$CANDIDATE" "$ROLLBACK_CANDIDATE" "$SITE_BASE_SHA256" "$EXPECTED_INSTALLED_SITE_SHA256"',
  ));
  assert.doesNotMatch(installer, /mv -f "\$CANDIDATE" "\$SITE"/);
  assert.doesNotMatch(cas, /RENAME_EXCHANGE/);
  assert.match(installer, /rollback_candidate:\$rollback_candidate/);
});

test('SITE publication closes both internal rename drift windows without deleting conflicts', () => {
  const cas = installer.match(/publish_site_no_replace\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

  for (const required of [
    'candidate_dev',
    'candidate_ino',
    'path_matches_exact_identity "$displaced"',
    'path_matches_exact_identity "$candidate"',
    'restore_displaced_site_no_replace "$site" "$displaced"',
    'preserve_published_candidate_and_restore_site',
    'sync -f "$displaced"',
    'sync -f "$candidate"',
  ]) assert.ok(cas.includes(required), `installer SITE CAS missing internal drift guard ${required}`);

  assert.ok(
    cas.lastIndexOf('path_matches_exact_identity "$candidate"')
      < cas.indexOf('rename_no_replace "$candidate" "$site"'),
    'candidate identity must be revalidated immediately before publication',
  );
  assert.doesNotMatch(cas, /rm\s+-f\s+"\$(site|candidate|displaced)"/);
});

test('SITE displaced inode is journaled and only removed after strict writable-fd quiescence', () => {
  for (const required of [
    'original_site_dev:$original_site_dev',
    'original_site_ino:$original_site_ino',
    'wait_for_writable_inode_quiescent',
    '/proc',
    'fdinfo',
    'O_ACCMODE',
    'remove_exact_quiescent_file',
  ]) assert.ok(installer.includes(required), `installer missing displaced-inode guard ${required}`);

  assert.ok(installer.includes(
    'remove_exact_quiescent_file "$ROLLBACK_CANDIDATE" "$SITE_BASE_SHA256" "$SITE_UID" "$SITE_GID" "$SITE_MODE" "$SITE_BASE_DEV" "$SITE_BASE_INO"',
  ));
  assert.doesNotMatch(
    installer,
    /test -f "\$ROLLBACK_CANDIDATE"[\s\S]{0,700}rm -f "\$ROLLBACK_CANDIDATE"/,
    'the detached original SITE must not be blindly unlinked',
  );
  assert.ok(
    installer.indexOf('write_journal mutation_started') < installer.lastIndexOf('publish_site_no_replace "$SITE"'),
    'the operation journal must be durable before detaching SITE',
  );
});

test('runtime artifacts and rotation state use durable identities and private tombstones', () => {
  for (const required of [
    'RUNTIME_ARTIFACTS_JSON',
    'RUNTIME_ARTIFACTS_SEALED',
    'record_runtime_artifact_identity',
    'runtime_artifact_inventory_is_complete',
    'ROTATE_STATE_DIR_CANDIDATE',
    'prepare_rotation_state_directory',
    'persist_rotation_state_identity',
    'private_cleanup_directory_tombstone',
    'remove_rotation_state',
  ]) assert.ok(installer.includes(required), `runtime identity contract missing ${required}`);
  assert.doesNotMatch(installer, /rm -f "\$ROTATE_STATE" "\$ROTATE_STATE[.]tmp"/);
  assert.ok(rollbackScript.includes('recover_runtime_artifact_cleanup_tombstones'));
  assert.ok(rollbackScript.includes('recover_rotation_state_cleanup_tombstones'));
  const regularRemoval = rollbackScript.match(/remove_regular_artifact\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const restoreRemoval = rollbackScript.match(/remove_restore_candidate\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(regularRemoval, /private_cleanup_tombstone/);
  assert.match(restoreRemoval, /private_cleanup_tombstone/);
  assert.doesNotMatch(regularRemoval, /rm -f/);
  assert.doesNotMatch(restoreRemoval, /rm -f/);
  assert.doesNotMatch(rollbackScript, /mv -f "\$BACKUP" "\$PARTIAL_BACKUP_AUDIT"/);
  const rotationPrepare = installer.match(
    /prepare_rotation_state_directory\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  const rotationCapture = installer.match(
    /capture_regular_file_identity_stable\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  for (const required of ['O_DIRECTORY', 'O_NOFOLLOW', 'os.fchown', 'os.fchmod', 'os.fstat', 'os.lstat', 'os.fsync']) {
    assert.ok(rotationPrepare.includes(required), `rotation directory allocation missing ${required}`);
  }
  for (const required of ['O_NOFOLLOW', 'hashlib.file_digest', 'os.fstat', 'os.lstat']) {
    assert.ok(rotationCapture.includes(required), `rotation status capture missing ${required}`);
  }
});

test('timer-driven rotation advances a stable provenance ledger instead of adopting status paths', () => {
  assert.match(service, /ExecStart=\/usr\/local\/sbin\/aifeeds-check-nginx-request-id rotation-wrapper/);
  for (const placeholder of [
    '@OPERATION_ID@',
    '@ROTATION_ANCHOR_PATH@',
    '@ROTATION_ANCHOR_DEV@',
    '@ROTATION_ANCHOR_INO@',
    '@ROTATION_ANCHOR_SHA256@',
    '@CHECKER_DEV@',
    '@CHECKER_INO@',
    '@CHECKER_SHA256@',
    '@ROTATE_CONFIG_DEV@',
    '@ROTATE_CONFIG_INO@',
    '@ROTATE_CONFIG_SHA256@',
    '@LOGROTATE_DEV@',
    '@LOGROTATE_INO@',
    '@LOGROTATE_SHA256@',
  ]) assert.ok(service.includes(placeholder), `dynamic service authority missing ${placeholder}`);
  for (const required of [
    'rotation-initialize',
    'rotation-verify',
    'ROTATE_PROVENANCE',
    'rotation_state_snapshot',
    'genesis_record_sha256',
  ]) assert.ok(installer.includes(required), `installer rotation provenance missing ${required}`);
  for (const required of [
    'rotation-verify',
    'ROTATION_STATE_SNAPSHOT_JSON',
    'rotation_state_snapshot',
    'ROTATE_PROVENANCE',
  ]) assert.ok(rollbackScript.includes(required), `manual rotation provenance missing ${required}`);
  for (const required of [
    'rotation-wrapper',
    'previous_record_sha256',
    'record_sha256',
    'repair_partial_tail',
    'renameat2',
    'renameatx_np',
    'RENAME_NOREPLACE',
  ]) assert.ok(checker.includes(required), `rotation wrapper missing ${required}`);
  const installerPersist = installer.match(
    /persist_rotation_state_identity\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  const manualPersist = rollbackScript.match(
    /persist_rotation_state_identity\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  assert.doesNotMatch(installerPersist, /capture_regular_file_identity_stable "\$ROTATE_STATE"/);
  assert.doesNotMatch(manualPersist, /capture_regular_file_identity_stable "\$ROTATE_STATE"/);
  assert.match(systemctlShim, /read -r -a service_command/);
  assert.match(systemctlShim, /service_command\[0\].*aifeeds-check-nginx-request-id/);
  assert.match(systemctlShim, /service_command\[1\].*rotation-wrapper/);
  assert.match(systemctlShim, /#service_command\[@\].*-eq 16/);
  assert.match(systemctlShim, /service_command\[13\]/);
  assert.match(systemctlShim, /service_command\[14\]/);
  assert.match(systemctlShim, /service_command\[15\]/);
  for (const required of [
    'rotation_anchor_identity',
    'runtime_artifacts',
    '.logrotate',
    '/usr/sbin/logrotate',
  ]) assert.ok(systemctlShim.includes(required), `systemctl exact argv check missing ${required}`);
  assert.match(systemctlShim, /"\$\{service_command\[@\]\}"/);
  for (const required of [
    'ROTATION_ANCHOR_IDENTITY_JSON',
    'allocate_rotation_anchor',
    'prepare_rotation_authority_and_service',
    'rotation-recover',
    'validate_rotation_authority',
    'fcntl.flock',
  ]) {
    assert.ok(
      installer.includes(required) || rollbackScript.includes(required) || checker.includes(required),
      `external rotation authority missing ${required}`,
    );
  }
});

test('rotation authority seals the fixed logrotate binary and callers extract it from the anchor', () => {
  assert.match(installer, /ROTATION_LOGROTATE=\/usr\/sbin\/logrotate/);
  for (const placeholder of ['@LOGROTATE_DEV@', '@LOGROTATE_INO@', '@LOGROTATE_SHA256@']) {
    assert.ok(scenarioRunner.includes(placeholder), `integration render missing ${placeholder}`);
  }
  const prepare = installer.match(
    /prepare_rotation_authority_and_service\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  for (const required of [
    'capture_regular_file_identity_stable "$ROTATION_LOGROTATE"',
    'schema:2',
    'logrotate:$logrotate',
    '@LOGROTATE_DEV@',
    '@LOGROTATE_INO@',
    '@LOGROTATE_SHA256@',
  ]) assert.ok(prepare.includes(required), `logrotate authority preparation missing ${required}`);
  assert.match(prepare, /\.path == \$path/);
  assert.match(prepare, /\.uid == 0 and \.gid == 0 and \.mode == "755"/);

  for (const [name, script] of [
    ['installer', installer],
    ['rollback', rollbackScript],
  ]) {
    const extractorStart = script.indexOf('extract_logrotate_identity_from_sealed_anchor() {');
    const extractorEnd = script.indexOf('\nrun_rotation_authorized_command() {', extractorStart);
    const extractor = extractorStart >= 0 && extractorEnd > extractorStart
      ? script.slice(extractorStart, extractorEnd)
      : '';
    const runner = script.match(
      /run_rotation_authorized_command\(\) \{([\s\S]*?)\n\}/,
    )?.[1] ?? '';
    for (const required of [
      'O_NOFOLLOW',
      'os.fstat',
      'os.lstat',
      'hashlib.sha256',
      'canonical',
      'schema',
      'logrotate',
      '/usr/sbin/logrotate',
      'uid',
      'gid',
      'mode',
      'isinstance(identity[key], bool)',
      'isinstance(logrotate[key], bool)',
      'for key in ("uid", "gid")',
      'not isinstance(authority["schema"], int)',
    ]) assert.ok(extractor.includes(required), `${name} sealed-anchor extraction missing ${required}`);
    assert.match(runner, /extract_logrotate_identity_from_sealed_anchor/);
    assert.match(runner, /"\$\(jq -er '\.dev' <<< "\$logrotate_entry"\)"/);
    assert.match(runner, /"\$\(jq -er '\.ino' <<< "\$logrotate_entry"\)"/);
    assert.match(runner, /"\$\(jq -er '\.sha256' <<< "\$logrotate_entry"\)"/);
    assert.doesNotMatch(runner, /capture_regular_file_identity_stable "?\$ROTATION_LOGROTATE/);
  }
});

test('backup allocation and partial recovery are source-journal inode bound', () => {
  const backupAllocator = installer.match(
    /create_site_backup_inode_no_replace\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  const backupCopy = installer.match(/populate_site_backup\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const partialCapture = rollbackScript.match(
    /capture_partial_backup_identity\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  const partialBlock = rollbackScript.match(
    /if \[ "\$BACKUP_STATE" = partial \]; then([\s\S]*?)\nfi/,
  )?.[1] ?? '';

  for (const required of [
    'SITE_BACKUP_IDENTITY_JSON',
    'site_backup_identity:$site_backup_identity',
    'create_site_backup_inode_no_replace',
    'populate_site_backup',
  ]) assert.ok(installer.includes(required), `installer backup ownership missing ${required}`);
  for (const required of ['O_EXCL', 'O_NOFOLLOW', 'os.fstat', 'os.lstat', 'os.fsync']) {
    assert.ok(backupAllocator.includes(required), `backup allocator missing ${required}`);
  }
  for (const required of ['expected_backup_dev', 'expected_backup_ino', 'os.fstat', 'os.lstat', 'os.fsync']) {
    assert.ok(backupCopy.includes(required), `backup descriptor copy missing ${required}`);
  }
  assert.doesNotMatch(installer, /cp -a "\$SITE" "\$BACKUP"/);

  for (const required of [
    'SITE_BACKUP_IDENTITY_JSON',
    'capture_partial_backup_identity',
    'expected_dev',
    'expected_ino',
    'O_NOFOLLOW',
    'os.fstat',
    'os.lstat',
  ]) assert.ok(rollbackScript.includes(required), `manual backup ownership missing ${required}`);
  assert.ok(partialCapture.includes('os.fchown'));
  assert.ok(partialCapture.includes('os.fchmod'));
  assert.ok(partialCapture.includes('hashlib.file_digest'));
  assert.ok(partialBlock.includes('capture_partial_backup_identity'));
  assert.doesNotMatch(partialBlock, /chown\s+root:root\s+"\$BACKUP"/);
  assert.doesNotMatch(partialBlock, /chmod\s+0600\s+"\$BACKUP"/);
  assert.ok(rollbackScript.includes('site_backup_identity:$site_backup_identity'));
});

test('formal SITE states are accepted only with their journaled inode identities', () => {
  for (const [label, source] of [['installer', installer], ['manual', rollbackScript]]) {
    const matcher = source.match(/formal_site_matches_state\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
    assert.ok(matcher, `${label} formal SITE matcher must exist`);
    for (const required of [
      'SITE_BASE_DEV',
      'SITE_BASE_INO',
      'INSTALLER_CANDIDATE_DEV',
      'INSTALLER_CANDIDATE_INO',
      'ROLLBACK_CANDIDATE_DEV',
      'ROLLBACK_CANDIDATE_INO',
      'path_matches_exact_identity',
    ]) assert.ok(matcher.includes(required), `${label} formal SITE matcher missing ${required}`);
  }

  const candidateOwner = installer.match(
    /site_candidate_is_owned_or_absent\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  assert.ok(candidateOwner.includes('formal_site_matches_state "$CANDIDATE" installed'));
  assert.ok(installer.includes('formal_site_matches_state "$SITE" base'));
  assert.ok(installer.includes('formal_site_matches_state "$SITE" installed'));
  assert.ok(rollbackScript.includes('formal_site_matches_state "$SITE" base'));
  assert.ok(rollbackScript.includes('formal_site_matches_state "$SITE" installed'));
  for (const required of [
    'rollback_candidate_dev',
    'rollback_candidate_ino',
    'ROLLBACK_CANDIDATE_DEV',
    'ROLLBACK_CANDIDATE_INO',
  ]) assert.ok(installer.includes(required), `source journal restore identity missing ${required}`);
});

test('terminal scanner physically reconciles runtime artifacts, rotation, and zero residue', () => {
  const residue = installer.match(
    /terminal_runtime_inventory_is_valid\(\) \{([\s\S]*?)\nvalidate_terminal_rollback_journal\(\)/,
  )?.[1] ?? '';
  const rollbackValidator = installer.match(
    /validate_terminal_rollback_journal\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  const terminalAbsent = installer.match(
    /runtime_artifacts_are_terminally_absent\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  const terminalCommitted = installer.match(
    /runtime_artifacts_are_committed_exact\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';

  for (const required of [
    'runtime_artifacts',
    'runtime_artifacts_sealed',
    'rotation_state_identity',
    'path_matches_exact_identity',
    'assert_no_operation_cleanup_dirs_for_transaction',
  ]) assert.ok(residue.includes(required), `terminal physical reconciliation missing ${required}`);
  assert.match(residue, /committed[\s\S]*rolled_back/);
  assert.ok(residue.includes('runtime_artifacts_are_terminally_absent'));
  assert.ok(residue.includes('runtime_artifacts_are_committed_exact'));
  assert.ok(terminalCommitted.includes('terminal_formal_site_matches_state "$source_path" installed'));
  assert.doesNotMatch(
    terminalAbsent,
    /terminal_formal_site_matches_state/,
    'a historical rolled-back transaction must not own a later live SITE deployment',
  );
  for (const required of [
    'runtime_artifacts',
    'runtime_artifacts_sealed',
    'rotation_state_identity',
    'site_backup_identity',
  ]) assert.ok(rollbackValidator.includes(required), `terminal journal mirror missing ${required}`);
});

test('terminal scanner accepts automatic rolled_back journals without a manual pair', () => {
  const sourceValidator = installer.match(
    /validate_terminal_source_journal\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';

  assert.ok(sourceValidator, 'terminal source validator must exist');
  assert.ok(sourceValidator.includes("jq -r '.rollback_journal // \"\"'"));
  assert.ok(!sourceValidator.includes("jq -er '.rollback_journal // empty'"));
});

test('pre-live rolled_back CAS stays narrow and archive genesis returns explicit success', () => {
  for (const [label, script] of [
    ['installer', installer],
    ['rollback', rollbackScript],
  ]) {
    const writer = script.match(
      /journal_update_cas\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY/,
    )?.[1] ?? '';
    for (const required of [
      'source pre-live rollback origin drift',
      'source pre-live empty manifest evidence drift',
      'source pre-live rollback transition drift',
      'source pre-live rollback evidence drift',
      'pair_presence not in ((False, False), (True, True))',
      'old_effective not in ("initializing", "prepared")',
      'value["log_archive_manifest_generation"] != 1',
      'value["log_archive_manifest_entry_count"] != 0',
    ]) assert.ok(writer.includes(required), `${label} pre-live CAS missing ${required}`);

    const publisher = script.match(
      /publish_archive_manifest_tmp\(\) \{([\s\S]*?)\n\}/,
    )?.[1] ?? '';
    assert.match(
      publisher,
      /archive_manifest_is_owned "\$ARCHIVE_MANIFEST" \|\| return 1\n\s*return 0/,
      `${label} archive genesis must not inherit a stale conditional status`,
    );
  }
});

test('pre-live candidate absence requires durable exact empty-manifest authority', () => {
  const writer = rollbackScript.match(
    /journal_update_cas\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY/,
  )?.[1] ?? '';
  const builder = rollbackScript.match(
    /build_runtime_cleanup_plan\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  const authority = rollbackScript.match(
    /prelive_empty_manifest_authorizes_installer_absence\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';

  for (const required of [
    'prelive_empty_manifest_authorizes_installer_absence',
    'os.O_RDONLY | os.O_NOFOLLOW',
    'before.st_nlink != 1',
    'stable(pathname_before) == stable(before) == stable(after) == stable(pathname_after)',
    'value["generation"] == 1',
    'value.get("inventory_complete") is True',
    'value.get("empty_inventory") is True',
    'value.get("entries") == []',
    'before_capture = capture_manifest()',
    'after_capture = capture_manifest()',
    'after_capture == before_capture',
    'not exists(manifest_path + ".tmp")',
    'not exists(manifest_path + f".previous-gl-a-{operation_id}")',
  ]) assert.ok(writer.includes(required), `cleanup CAS pre-live authority missing ${required}`);
  for (const required of [
    'prelive_empty_manifest_authorizes_installer_absence',
    'allow_recorded_installer_absence',
    'elif allow_recorded_absence and not existing',
  ]) assert.ok(builder.includes(required), `cleanup builder pre-live authority missing ${required}`);
  for (const required of [
    'initializing|prepared',
    'archive_manifest_is_terminal',
    '.generation == 1',
    '.inventory_complete == true',
    '.empty_inventory == true',
    '.entries == []',
    'before_capture="$(capture_archive_manifest_owned "$ARCHIVE_MANIFEST")"',
    'after_capture="$(capture_archive_manifest_owned "$ARCHIVE_MANIFEST")"',
    'test "$after_capture" = "$before_capture"',
    'ARCHIVE_MANIFEST_TMP',
    'ARCHIVE_MANIFEST_PREVIOUS',
  ]) assert.ok(authority.includes(required), `shell pre-live authority missing ${required}`);
});

test('terminal scanner validates the manual journal-pair commit marker and takeover tmp', () => {
  for (const required of [
    "-name 'rollback-commit-*.json*'",
    'validate_terminal_pair_commit_marker',
    'rollback_commit_marker',
    'source_journal_terminal_sha256',
    'rollback_journal_terminal_sha256',
  ]) assert.ok(installer.includes(required), `installer missing pair-marker validation ${required}`);
  const markerValidator = installer.match(
    /validate_terminal_pair_commit_marker\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  for (const required of [
    'source_before_authority',
    'rollback_before_authority',
    'validate-authority-successor',
    'saved_journal_operation_id',
  ]) assert.ok(markerValidator.includes(required), `installer marker authority validation missing ${required}`);
  for (const required of [
    'forge_terminal_pair_pre_marker_drift',
    'run_c_negative_twice_stable',
    'terminal-authority-drift-adopted-final-marker',
    'restore_terminal_pair_pre_marker_targets',
    'terminal-marker-prepared-hash',
    'terminal-committed-marker-restore-drift',
  ]) assert.ok(scenarioRunner.includes(required), `terminal authority dynamic fixture missing ${required}`);
});

test('prepared terminal-pair marker binds exact target hashes and recovery accepts only before or target bytes', () => {
  const markerWriter = rollbackScript.match(
    /write_terminal_pair_commit_marker\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  const recovery = rollbackScript.match(/recover_terminal_pair_commit\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

  for (const required of ['source_target_sha256', 'rollback_target_sha256', 'SOURCE_JOURNAL_TMP', 'ROLLBACK_JOURNAL_TMP']) {
    assert.ok(markerWriter.includes(required), `prepared marker target binding missing ${required}`);
  }
  for (const required of ['update_source_journal_rolled_back', 'write_rollback_journal rolled_back', 'write_terminal_pair_commit_marker committed']) {
    assert.ok(recovery.includes(required), `terminal recovery exact-state check missing ${required}`);
  }
  assert.ok(rollbackScript.includes('stage_terminal_pair_journals'));
  assert.ok(rollbackScript.includes('validate_committed_terminal_pair_physical_chain'));
});

test('terminal source cleanup binds committed marker before and target hashes inside one CAS action', () => {
  const publisher = rollbackScript.match(
    /update_source_journal_rolled_back\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  assert.ok(
    publisher.includes('rolled_back "$SOURCE_JOURNAL_SHA256" "" publish-terminal-retain'),
    'terminal source publication must carry the externally authorized legacy source hash',
  );
  assert.doesNotMatch(publisher, /rolled_back "" "" publish-terminal-retain/);

  const cleanup = rollbackScript.match(
    /cleanup_terminal_pair_predecessors\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  for (const required of [
    'local terminal_source_cleanup_payload terminal_source_marker_sha256',
    '--arg marker "$ROLLBACK_COMMIT_MARKER"',
    '--arg marker_sha256',
    '--arg before_sha256',
    '--arg target_sha256',
    '{marker:$marker,marker_sha256:$marker_sha256,before_sha256:$before_sha256,target_sha256:$target_sha256}',
    'source rolled_back "" "$terminal_source_cleanup_payload" cleanup-terminal-bound',
  ]) assert.ok(cleanup.includes(required), `terminal source bound cleanup missing ${required}`);
  assert.match(
    cleanup,
    /validate_terminal_pair_intent_namespace "\$ROLLBACK_COMMIT_MARKER" \\\n+\s+"\$terminal_source_marker_sha256"/,
  );
  assert.ok(
    cleanup.includes('rollback rolled_back "" "" publish-terminal'),
    'rollback journals must not inherit source-only legacy authority',
  );
  assert.doesNotMatch(
    cleanup,
    /source rolled_back "\$(?:SOURCE_JOURNAL_SHA256|source_publish_expected)" "" publish-terminal/,
  );

  const cas = rollbackScript.match(
    /journal_update_cas\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY/,
  )?.[1] ?? '';
  const boundAction = cas.match(
    /if action == "cleanup-terminal-bound":([\s\S]*?)\nif action == "validate-authority-successor":/,
  )?.[1] ?? '';
  for (const required of [
    'set(envelope) != {"marker", "marker_sha256", "before_sha256", "target_sha256"}',
    'marker_record = read_exact(envelope["marker"])',
    'marker_record["sha256"] != envelope["marker_sha256"]',
    'canonical(marker_value) != marker_record["raw"]',
    'marker_value.get("phase") != "committed"',
    'marker_value.get("operation_id") != operation_id',
    'marker_value.get("source_journal") != final',
    'marker_value.get("source_before_sha256") != envelope["before_sha256"]',
    'marker_value.get("source_target_sha256") != envelope["target_sha256"]',
    'names not in ({"F"}, {"F", "P"}, {"F", "C"})',
    'final_record["sha256"] != bound_target_sha256',
    'predecessor_record["sha256"] != bound_before_sha256',
    'test_barrier("cleanup-terminal-bound-fp")',
    'test_crash("p-to-c")',
    'test_barrier("cleanup-terminal-bound-fc")',
    'return settle_terminal_bound()',
  ]) assert.ok(boundAction.includes(required), `terminal source bound CAS missing ${required}`);
  assert.doesNotMatch(boundAction, /legacy_hash not in \(old\["sha256"\], successor\["sha256"\]\)/);
  assert.ok(
    cas.includes('if legacy_hash and legacy_hash not in (old["sha256"], successor["sha256"]):'),
    'the generic publish CAS must remain narrow and independent of the bound cleanup action',
  );
  const markerValidationOffsets = [...cleanup.matchAll(
    /validate_terminal_pair_intent_namespace "\$ROLLBACK_COMMIT_MARKER"/g,
  )].map((match) => match.index);
  const markerOwnershipOffsets = [...cleanup.matchAll(
    /terminal_pair_commit_marker_is_owned "\$ROLLBACK_COMMIT_MARKER"/g,
  )].map((match) => match.index);
  const payloadFreezeOffset = cleanup.indexOf(
    'terminal_source_cleanup_payload="$(jq -nc',
  );
  const sourcePublishOffset = cleanup.indexOf(
    'source rolled_back "" "$terminal_source_cleanup_payload" cleanup-terminal-bound',
  );
  const postMarkerBarrierOffset = cleanup.indexOf(
    'terminal_pair_test_barrier source-post-marker-check',
  );
  assert.equal(markerOwnershipOffsets.length, 2);
  assert.equal(markerValidationOffsets.length, 3);
  assert.ok(markerOwnershipOffsets[0] < markerValidationOffsets[0]);
  assert.ok(markerValidationOffsets[0] < payloadFreezeOffset);
  assert.ok(payloadFreezeOffset < markerOwnershipOffsets[1]);
  assert.ok(markerOwnershipOffsets[1] < markerValidationOffsets[1]);
  assert.ok(markerValidationOffsets[1] < postMarkerBarrierOffset);
  assert.ok(postMarkerBarrierOffset < sourcePublishOffset);
  assert.ok(sourcePublishOffset < markerValidationOffsets[2]);

  const intentValidator = rollbackScript.match(
    /validate_terminal_pair_intent_namespace\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  const pairConsistency = rollbackScript.match(
    /terminal_pair_target_records_are_consistent\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  const authorityValidator = rollbackScript.match(
    /validate_terminal_pair_authority_successors\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  for (const required of [
    'local expected_marker_sha256=${2:-}',
    'marker_record = read_exact(marker_path)',
    'marker_record["sha256"] != expected_marker_sha256',
    'marker = marker_record["value"]',
    '"${expected_marker_sha256:--}" "$SOURCE_JOURNAL_SHA256"',
  ]) assert.ok(intentValidator.includes(required), `terminal intent marker binding missing ${required}`);
  assert.ok(pairConsistency.includes('local expected_marker_sha256=${6:-}'));
  assert.ok(pairConsistency.includes('"$expected_marker_sha256"'));
  assert.ok(authorityValidator.includes('local expected_marker_sha256=${4:-}'));
  assert.ok(authorityValidator.includes('--arg marker_sha256 "$expected_marker_sha256"'));
  const authorityAction = cas.match(
    /if action == "validate-authority-successor":([\s\S]*?)\nif action == "stage"/,
  )?.[1] ?? '';
  assert.ok(authorityAction.includes('marker_record["sha256"] != envelope["marker_sha256"]'));

  const postMarkerDrift = scenarioRunner.match(
    /terminal-source-post-marker-check-drift\)([\s\S]*?)\n\s*;;/,
  )?.[1] ?? '';
  for (const required of [
    'GL_A_TEST_TERMINAL_PAIR_BARRIER=source-post-marker-check',
    'terminal-pair-source-post-marker-check-ready',
    'assert_cas_namespace "$recovery_source_journal" FP',
    'assert_cas_namespace "$recovery_rollback_journal" FP',
    'rewrite_json_in_place "$replacement_marker" terminal-marker-prepared-hash',
    '/usr/bin/mv "$replacement_marker" "$terminal_marker"',
    'terminal bound cleanup marker hash drift',
    'bound_source_fingerprint=$(file_identity_fingerprint "$recovery_source_journal")',
    'bound_rollback_fingerprint=$(file_identity_fingerprint "$recovery_rollback_journal")',
    'bound_marker_fingerprint=$(file_identity_fingerprint "$terminal_marker")',
    'bound_summary_fingerprint=$(optional_file_identity_fingerprint "$recovery_manual_summary")',
    'bound_namespace_fingerprint=$(c_namespace_fingerprint)',
    'assert_terminal_bound_first_failure_unchanged',
  ]) assert.ok(postMarkerDrift.includes(required), `post-marker source drift fixture missing ${required}`);

  const legacyScenario = scenarioRunner.match(
    /exercise_source_legacy_genesis\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  for (const required of [
    'trusted_sha=$(sha256sum "$source"',
    'load_recovery_contract_from_record "$source" "$trusted_sha"',
    'complete_c_positive_reentry 0',
    'recovery_source_sha=$(printf \'d%.0s\' {1..64})',
    'run_manual_rollback "$test_root/source-legacy-wrong-arg9.out"',
    'test "$manual_rc" -ne 0',
    'source-legacy-wrong-arg9-false-pass',
    'untrusted legacy journal',
    'source-legacy-wrong-arg9-source-changed',
    'source-legacy-wrong-arg9-rollback-changed',
    'source-legacy-wrong-arg9-marker-changed',
    'source-legacy-wrong-arg9-summary-changed',
    'source-legacy-wrong-arg9-namespace-changed',
    'recovery_source_sha=$trusted_sha',
  ]) assert.ok(legacyScenario.includes(required), `legacy source fixture missing ${required}`);
});

test('terminal source P/C residue fixtures reject shape-valid non-marker targets without mutation', () => {
  const scenarios = [
    'terminal-source-p-bound-target-drift',
    'terminal-source-c-bound-target-drift',
  ];
  for (const scenario of scenarios) {
    assert.ok(integration.includes(scenario), `integration matrix missing ${scenario}`);
    assert.ok(scenarioRunner.includes(scenario), `scenario runner missing ${scenario}`);
  }

  const exercise = scenarioRunner.match(
    /exercise_terminal_source_bound_cleanup_drift\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  for (const required of [
    'terminal-source-p-bound-target-drift) barrier_point=cleanup-terminal-bound-fp; expected_source_namespace=FP',
    'terminal-source-c-bound-target-drift) barrier_point=cleanup-terminal-bound-fc; expected_source_namespace=FC',
    'GL_A_TEST_JOURNAL_CAS_CRASH=source:rolled_back:p-to-c',
    'wait_for_c_crash "$manual_pid" journal-cas-crash-hit 1200',
    'assert_cas_namespace "$recovery_source_journal" FC',
    'assert_cas_namespace "$recovery_rollback_journal" FP',
    'export GL_A_TEST_JOURNAL_CAS_BARRIER="source:rolled_back:${barrier_point}"',
    'wait_for_file "$test_root/journal-cas-barrier-${barrier_point}-ready" 1200',
    'assert_cas_namespace "$recovery_source_journal" "$expected_source_namespace"',
    'assert_cas_namespace "$recovery_rollback_journal" FP',
    'saved_source_target="$test_root/${scenario}.source-target.valid"',
    'rewrite_json_in_place "$recovery_source_journal" terminal-source-target',
    'assert_shape_valid_non_marker_terminal_source',
    'bound_source_fingerprint=$(file_identity_fingerprint "$recovery_source_journal")',
    'bound_rollback_fingerprint=$(file_identity_fingerprint "$recovery_rollback_journal")',
    'bound_marker_fingerprint=$(file_identity_fingerprint "$terminal_marker")',
    'bound_summary_fingerprint=$(optional_file_identity_fingerprint "$recovery_manual_summary")',
    'bound_namespace_fingerprint=$(c_namespace_fingerprint)',
    ': > "$test_root/journal-cas-barrier-${barrier_point}-release"',
    'test "$manual_rc" -ne 0',
    'assert_terminal_bound_first_failure_unchanged',
  ]) assert.ok(exercise.includes(required), `terminal bound residue fixture missing ${required}`);

  const immutable = scenarioRunner.match(
    /assert_terminal_bound_first_failure_unchanged\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  for (const required of [
    'assert_file_identity_fingerprint "$recovery_source_journal" "$bound_source_fingerprint"',
    'assert_file_identity_fingerprint "$recovery_rollback_journal" "$bound_rollback_fingerprint"',
    'assert_file_identity_fingerprint "$terminal_marker" "$bound_marker_fingerprint"',
    'test "$(optional_file_identity_fingerprint "$recovery_manual_summary")" = "$bound_summary_fingerprint"',
    'test "$(c_namespace_fingerprint)" = "$bound_namespace_fingerprint"',
  ]) assert.ok(immutable.includes(required), `terminal bound first failure lock missing ${required}`);
});

test('terminal source journals bind the exact terminal archive manifest evidence', () => {
  const journalWriter = installer.match(/write_journal\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const sourceValidator = installer.match(/validate_terminal_source_journal\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

  for (const required of [
    'log_archive_manifest_sha256',
    'log_archive_manifest_generation',
    'log_archive_manifest_entry_count',
  ]) {
    assert.ok(journalWriter.includes(required), `terminal journal writer missing ${required}`);
    assert.ok(sourceValidator.includes(required), `terminal source validator missing ${required}`);
  }
});

test('automatic rollback treats systemd and negative-probe query errors as failures', () => {
  for (const required of [
    'unit_is_inactive',
    'timer_is_disabled',
    'no_performance_logs_present',
    'probe_absent_from_audit',
    'ensure_audit_dir_owned',
  ]) assert.ok(rollbackScript.includes(required), `delegated helper missing fail-closed ${required}`);
  const quiesce = rollbackScript.match(/quiesce_rotation_control_plane\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  for (const required of [
    'systemctl disable --now "$TIMER_UNIT"',
    'systemctl stop "$ROTATE_SERVICE"',
    'unit_is_inactive "$TIMER_UNIT"',
    'unit_is_inactive "$ROTATE_SERVICE"',
    'timer_is_disabled',
  ]) assert.ok(quiesce.includes(required), `automatic rotation quiescence missing ${required}`);
  assert.doesNotMatch(quiesce, /\|\|\s*true/);
  const failureTrap = installer.match(/rollback_on_failure\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  for (const required of [
    'flock -u 9',
    'exec 9>&-',
    'SOURCE_JOURNAL_DELEGATE_SHA256',
    'rollback-aifeeds-performance-log.sh',
  ]) assert.ok(failureTrap.includes(required), `automatic delegation missing ${required}`);
  assert.doesNotMatch(failureTrap, /rollback_ok|remove_rotation_state|remove_owned_artifact/);
  const sharedCleanup = rollbackScript.slice(rollbackScript.indexOf(
    'case "$RESUME_ROLLBACK_PHASE" in\nnone|prepared)',
  ));
  assert.ok(
    sharedCleanup.indexOf('quiesce_rotation_control_plane')
      < sharedCleanup.indexOf('start_runtime_cleanup_plan'),
    'automatic control plane must be quiescent before rotation state cleanup',
  );
  assert.ok(
    sharedCleanup.indexOf('run_rotation_authorized_command rotation-recover')
      < sharedCleanup.lastIndexOf('quiesce_rotation_control_plane'),
    'automatic rollback must re-prove quiescence after rotation recovery',
  );
});

test('inactive systemd checks accept missing units without accepting control-plane errors', () => {
  const inactiveCheck = installer.match(/unit_is_inactive\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

  assert.ok(inactiveCheck, 'installer unit_is_inactive helper must exist');
  assert.match(inactiveCheck, /3:inactive\|4:inactive/);
  assert.doesNotMatch(inactiveCheck, /4:failed/);
  assert.match(systemctlShim, /\[ ! -e "\/etc\/systemd\/system\/\$unit" \]/);
  assert.match(systemctlShim, /state=inactive[\s\S]*rc=4/);
});

test('safety inventories propagate find errors and grep counts reject control-plane errors', () => {
  for (const required of [
    'write_find_inventory',
    'strict_grep_count',
    'case "$rc" in',
    '0|1)',
  ]) assert.ok(installer.includes(required), `installer missing strict query helper ${required}`);

  assert.doesNotMatch(installer, /done < <\(find\b/);
  assert.doesNotMatch(installer, /\$\(find\b/);
  assert.doesNotMatch(installer, /grep -Eic[^\n]*\|\| true/);
});

test('log rollback quarantines live inodes and publishes immutable audit files without overwrite', () => {
  for (const required of [
    'LOG_QUARANTINE_SUFFIX',
    'ARCHIVE_MANIFEST',
    'log_archive_manifest:$log_archive_manifest',
    'record_log_archive_entry',
    'rename_no_replace "$log_path" "$quarantine"',
    'wait_for_writable_inode_quiescent "$quarantine"',
    'record_log_archive_quiescent',
    'record_log_archive_archived',
    'archive_manifest_is_terminal',
    'copy_file_no_replace "$quarantine" "$destination_candidate"',
    'rename_no_replace "$destination_candidate" "$destination"',
  ]) assert.ok(rollbackScript.includes(required), `delegated helper missing log quarantine contract ${required}`);

  assert.doesNotMatch(rollbackScript, /rm -f "\$log_path"/);
  assert.doesNotMatch(rollbackScript, /mv -f "\$destination_candidate" "\$destination"/);
  assert.match(rollbackScript, /archive-manifest[.]json\|archive-manifest[.]json[.]tmp\)/);
  const terminalAudit = rollbackScript.match(/rollback_audit_is_terminal\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.ok(terminalAudit.includes('test ! -e "$ARCHIVE_MANIFEST_TMP"'));
  assert.ok(terminalAudit.includes('archive_manifest_is_terminal'));
  assert.match(rollbackScript, /LOG_QUIESCENCE_TIMEOUT_SECONDS=60/);
  assert.ok(rollbackScript.includes(
    'wait_for_writable_inode_quiescent "$quarantine" "$log_dev" "$log_ino" "$LOG_QUIESCENCE_TIMEOUT_SECONDS"',
  ));
  const terminalManifest = rollbackScript.match(/archive_manifest_is_terminal\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  for (const required of ['final_sha256', 'final_size', 'state == "archived"', 'sha256sum', 'stat -c', 'source', 'quarantine', 'candidate']) {
    assert.ok(terminalManifest.includes(required), `terminal manifest missing tamper check ${required}`);
  }
  const manifestCapture = rollbackScript.match(
    /capture_archive_manifest_owned\(\) \{([\s\S]*?)\n\}\n\narchive_manifest_is_owned\(\)/,
  )?.[1] ?? '';
  const manifestWrapper = rollbackScript.match(
    /archive_manifest_is_owned\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  const manifestOwner = `${manifestCapture}\n${manifestWrapper}`;
  for (const required of ['split("/") | last', '"/var/backups/aifeeds-performance-log/audit-" + $operation_id', '".quarantine-gl-a-" + $operation_id']) {
    assert.ok(manifestOwner.includes(required), `manifest identity is not operation-bound: ${required}`);
  }
  assert.ok(terminalManifest.includes('prepare_private_inventory_file "$FIND_MANIFEST_TERMINAL_INVENTORY"'));
});

test('archive manifest takeover is generation-bound, monotonic, and terminally complete', () => {
  const manifestCapture = installer.match(
    /capture_archive_manifest_owned\(\) \{([\s\S]*?)\n\}\n\narchive_manifest_is_owned\(\)/,
  )?.[1] ?? '';
  const manifestWrapper = installer.match(/archive_manifest_is_owned\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const manifestOwner = `${manifestCapture}\n${manifestWrapper}`;
  const publisher = installer.match(/publish_archive_manifest_tmp\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const terminal = installer.match(/archive_manifest_is_terminal\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

  for (const required of ['generation', 'previous_manifest_sha256', 'previous_manifest_dev', 'previous_manifest_ino']) {
    assert.ok(manifestOwner.includes(required), `manifest ownership missing ${required}`);
  }
  for (const required of [
    'keys | sort',
    'final_mtime_s',
    'inventory_complete == false',
    'generation == (',
    'test("^A*(C|Q)?J*$")',
  ]) {
    assert.ok(manifestOwner.includes(required), `manifest exact schema missing ${required}`);
  }
  for (const required of [
    'archive_manifest_successor_is_valid',
    'archive_manifest_consumed_predecessor_is_valid',
    'ARCHIVE_MANIFEST_PREVIOUS',
    'restore_previous_manifest_no_replace',
    'rename_no_replace "$ARCHIVE_MANIFEST" "$ARCHIVE_MANIFEST_PREVIOUS"',
    'rename_no_replace "$ARCHIVE_MANIFEST_TMP" "$ARCHIVE_MANIFEST"',
    'remove_exact_manifest_file',
  ]) assert.ok(installer.includes(required), `manifest takeover missing ${required}`);
  assert.ok(installer.includes('successor_sources[:len(current_sources)] != current_sources'));
  assert.doesNotMatch(publisher, /rename_exchange/);
  assert.doesNotMatch(publisher, /mv\s+-f\s+"\$ARCHIVE_MANIFEST_TMP"\s+"\$ARCHIVE_MANIFEST"/);
  assert.ok(installer.includes('final_mtime_s'));
  assert.ok(!installer.includes('final_mtime_ns'));
  for (const [label, source] of [['installer', installer], ['manual', rollbackScript]]) {
    assert.ok(
      source.includes('.state == "archived" and has("candidate_dev")'),
      `${label} generation must charge the extra copied transition only to cross-filesystem archives`,
    );
  }
  assert.ok(terminal.includes('archive_manifest_destinations_are_complete'));
  const ensure = installer.match(/ensure_archive_manifest\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(
    ensure,
    /archive_manifest_consumed_predecessor_is_valid\s+\\?\s*"\$ARCHIVE_MANIFEST_PREVIOUS"\s+"\$ARCHIVE_MANIFEST"/,
  );
});

test('installer pre-live manifest recovery uses held identities and exact cleanup', () => {
  const identityCapture = installer.match(
    /capture_archive_manifest_owned_identity\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  const ownedCapture = installer.match(
    /capture_archive_manifest_owned\(\) \{([\s\S]*?)\n\}\n\narchive_manifest_is_owned\(\)/,
  )?.[1] ?? '';
  const successor = installer.match(
    /archive_manifest_successor_is_valid\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  const runtime = installer.match(
    /archive_manifest_successor_runtime_is_valid\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  const reachable = installer.match(
    /archive_manifest_recovery_is_reachable\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  const cleanup = installer.match(/private_cleanup_tombstone\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const emptyDirectory = installer.match(
    /remove_exact_empty_private_cleanup_directory\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  const cleanupRecovery = installer.match(
    /recover_archive_manifest_cleanup_tombstone\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';

  for (const required of [
    'os.O_NOFOLLOW',
    'before.st_nlink != 1',
    'reject_duplicates',
    'reject_constant',
    'len(raw) != before.st_size',
    '"fingerprint"',
    '"value"',
  ]) assert.ok(identityCapture.includes(required), `installer held manifest capture missing ${required}`);
  for (const required of [
    '.value | .schema == 2',
    'test "$after_identity" = "$before_identity"',
  ]) assert.ok(ownedCapture.includes(required), `installer captured schema proof missing ${required}`);
  for (const [label, source] of [
    ['successor', successor],
    ['runtime', runtime],
    ['reachable', reachable],
  ]) {
    for (const required of ['expected', 'os.O_NOFOLLOW', 'st_nlink != 1', 'fingerprint']) {
      assert.ok(source.includes(required), `installer ${label} expected-held proof missing ${required}`);
    }
  }
  for (const required of ['freeze_content', 'exact_quiescent', 'len(raw) != before.st_size']) {
    assert.ok(runtime.includes(required), `installer runtime freeze proof missing ${required}`);
  }
  for (const required of ['freeze_content', 'final_sha256', 'final_mtime_s']) {
    assert.ok(reachable.includes(required), `installer reachable freeze proof missing ${required}`);
  }
  for (const required of [
    'dir_fd=parent',
    'os.unlink(name, dir_fd=parent)',
    'after_unlink',
    'after_unlink) != stable(before)[:-1] + (0,)',
  ]) assert.ok(cleanup.includes(required), `installer exact cleanup missing ${required}`);
  for (const required of [
    'os.rmdir(name, dir_fd=parent)',
    'after.st_size not in (before.st_size, 0)',
    'after.st_nlink != 0',
  ]) assert.ok(emptyDirectory.includes(required), `installer exact cleanup directory missing ${required}`);
  for (const required of [
    'payload_capture',
    'archive_manifest_consumed_predecessor_is_valid',
    'archive_manifest_recovery_is_reachable',
  ]) assert.ok(cleanupRecovery.includes(required), `installer cleanup CAS preflight missing ${required}`);
});

test('cross-filesystem archive handoff journals candidate and destination inodes before adoption', () => {
  for (const [label, source] of [['delegated helper', rollbackScript]]) {
    for (const required of [
      'record_log_archive_copied',
      'candidate_dev',
      'candidate_ino',
      'destination_dev',
      'destination_ino',
      'state:"copied"',
      'normalize_exact_file_metadata',
    ]) assert.ok(source.includes(required), `${label} crossfs identity handoff missing ${required}`);
    assert.match(source, /sync -f "\$destination_candidate"/);
    assert.match(source, /path_matches_exact_identity "\$destination_candidate" "\$quarantine_sha256"/);
    const terminal = source.match(/archive_manifest_is_terminal\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
    assert.ok(terminal.includes('destination_dev'), `${label} terminal archive missing destination dev`);
    assert.ok(terminal.includes('destination_ino'), `${label} terminal archive missing destination ino`);
    assert.match(terminal, /stat -c ['"]%d %i['"] "\$destination"/);
  }
});

test('manifest predecessor recovery is identity-bound and cleanup isolates files in private tombstones', () => {
  const restore = installer.match(/restore_previous_manifest_no_replace\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const manifestCleanup = installer.match(/remove_exact_manifest_file\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const quiescentCleanup = installer.match(/remove_exact_quiescent_file\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const tombstoneCleanup = installer.match(/private_cleanup_tombstone\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';

  for (const required of ['expected_sha256', 'expected_dev', 'expected_ino', 'path_matches_exact_identity', 'archive_manifest_recovery_is_reachable']) {
    assert.ok(restore.includes(required), `manifest predecessor restore missing ${required}`);
  }
  assert.doesNotMatch(restore, /sha256sum "\$ARCHIVE_MANIFEST_PREVIOUS"|stat -c [^\n]*ARCHIVE_MANIFEST_PREVIOUS/);
  const ensure = installer.match(/ensure_archive_manifest\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.doesNotMatch(ensure, /restore_previous_manifest_no_replace\s*(?:\|\||;|\n)/);
  assert.ok(installer.includes('manifest_predecessor_identity_from_successor'));
  assert.ok(installer.includes('capture_archive_manifest_predecessor'));
  assert.ok(manifestCleanup.includes('private_cleanup_tombstone'));
  assert.ok(quiescentCleanup.includes('private_cleanup_tombstone'));
  for (const required of ['rename_no_replace', 'tombstone', 'expected_dev', 'expected_ino', '0700']) {
    assert.ok(tombstoneCleanup.includes(required), `private tombstone cleanup missing ${required}`);
  }
  assert.doesNotMatch(tombstoneCleanup, /os[.]unlink\(path\)/);
  const recovery = installer.match(/recover_private_cleanup_tombstone\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  for (const required of ['.cleanup-gl-a-', 'expected_sha256', 'expected_dev', 'expected_ino', 'private_cleanup_tombstone']) {
    assert.ok(recovery.includes(required), `cross-process tombstone recovery missing ${required}`);
  }
  const archiveRecovery = installer.match(
    /recover_archive_manifest_cleanup_tombstone\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  assert.ok(archiveRecovery.includes('private_cleanup_tombstone_state'));
  assert.ok(
    archiveRecovery.indexOf('private_cleanup_tombstone_state')
      < archiveRecovery.indexOf('manifest_predecessor_identity_from_successor'),
    'genesis manifests must not require predecessor authority unless a cleanup tombstone exists',
  );
});

test('pre-live automatic rollback seals an empty schema-2 terminal manifest before rolled_back', () => {
  const failureTrap = installer.match(/rollback_on_failure\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const emptyTerminal = installer.match(
    /ensure_empty_terminal_archive_manifest\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  for (const required of ['ensure_empty_terminal_archive_manifest', 'write_journal rolled_back']) {
    assert.ok(failureTrap.includes(required), `pre-live closure missing ${required}`);
  }
  for (const required of ['archive_manifest_is_terminal', '.schema == 2', '.generation == 1', '.entries == []']) {
    assert.ok(emptyTerminal.includes(required), `empty terminal manifest helper missing ${required}`);
  }
  assert.ok(
    failureTrap.indexOf('ensure_empty_terminal_archive_manifest')
      < failureTrap.lastIndexOf('write_journal rolled_back'),
    'empty terminal manifest must be durable before rolled_back journal publication',
  );
});

test('GL-a runbook preserves failed transcripts and reconciles automatic rollback read-only', () => {
  const runbook = performanceRunbook();

  for (const required of [
    'gl-a-install-output-${OPERATION_ID}.txt',
    'PIPE_RESULTS=("${PIPESTATUS[@]}")',
    'INSTALL_SSH_RC=',
    '.phase == "rolled_back"',
    'has("rollback_journal") | not',
    'automatic_rollback=pass',
    'AUTO_ROLLBACK_TRANSCRIPT=',
  ]) assert.ok(runbook.includes(required), `GL-a evidence recovery missing ${required}`);

  assert.ok(
    runbook.indexOf('mv -f "$INSTALL_OUTPUT_TMP" "$INSTALL_OUTPUT_FINAL"')
      < runbook.indexOf('if [ "$INSTALL_SSH_RC" -ne 0 ]'),
    'the transcript must be durable before a failed SSH/install status exits the runbook',
  );

  for (const required of [
    'ROLLBACK_ATTEMPT_ID=',
    'gl-a-manual-rollback-output-${OPERATION_ID}-${ROLLBACK_ATTEMPT_ID}.txt',
    'ROLLBACK_OUTPUT_TMP=',
    'ROLLBACK_PIPE_RESULTS=("${PIPESTATUS[@]}")',
    'ROLLBACK_SSH_RC=',
    'ROLLBACK_TEE_RC=',
    '日志 writable FD',
    '60 秒',
    'quarantine',
  ]) assert.ok(runbook.includes(required), `GL-a transcript/quiescence runbook missing ${required}`);
  assert.match(runbook, /2>&1 \\\n\s*\| tee "\$INSTALL_OUTPUT_TMP"/);
  assert.match(runbook, /2>&1 \\\n\s*\| tee "\$ROLLBACK_OUTPUT_TMP"/);

  assert.ok(
    runbook.indexOf('mv -n "$ROLLBACK_OUTPUT_TMP" "$ROLLBACK_OUTPUT_FINAL"')
      < runbook.indexOf('if [ "$ROLLBACK_SSH_RC" -ne 0 ]'),
    'manual rollback transcript must be atomically published before SSH status handling',
  );
  for (const required of [
    'RECOVERY_BUNDLE="$EVIDENCE/gl-a-recovery-bundle-${OPERATION_ID}"',
    'RECOVERY_RECORD="$RECOVERY_BUNDLE_TMP/record.json"',
    'RECOVERY_SHA="$RECOVERY_BUNDLE_TMP/record.sha256"',
    'RENAME_EXCL = 0x00000004',
    'RENAME_NOREPLACE = 1',
    'os.fsync(parent_fd)',
    'RECOVERY_RECORD="$RECOVERY_BUNDLE/record.json"',
    'RECOVERY_SHA="$RECOVERY_BUNDLE/record.sha256"',
  ]) assert.ok(runbook.includes(required), `GL-a recovery bundle missing ${required}`);
  assert.doesNotMatch(runbook, /mv -f "\$RECOVERY_BUNDLE_TMP" "\$RECOVERY_BUNDLE"/);
  assert.doesNotMatch(runbook, /mv -f "\$RECOVERY_RECORD_TMP" "\$RECOVERY_RECORD"/);
  assert.doesNotMatch(runbook, /mv -f "\$RECOVERY_SHA_TMP" "\$RECOVERY_SHA"/);
});

test('fault matrix covers real partial writes, journal CAS, 14-slot cleanup, and active writers', () => {
  const scenarios = [
    'manual-recovery-partial-backup',
    'installer-journal-tmp-takeover',
    'rollback-journal-tmp-takeover',
    'systemd-missing-unit',
    'site-cas-live-drift',
    'site-cas-candidate-drift',
    'manual-recovery-log-writer-tail',
    'manual-recovery-log-writer-timeout',
    'manual-recovery-terminal-pair-marker',
    'preflight-journal-find-error',
    'preflight-include-grep-error',
    'archive-manifest-tmp-takeover',
    'site-cas-internal-displaced-drift',
    'site-cas-internal-candidate-drift',
    'manual-site-cas-internal-displaced-drift',
    'manual-site-cas-internal-candidate-drift',
    'archive-manifest-stale-tmp',
    'archive-manifest-regressive-tmp',
    'archive-manifest-unknown-final',
    'archive-manifest-orphan-audit',
    'cross-filesystem-audit',
    'terminal-pair-source-only',
    'terminal-pair-rollback-only',
    'terminal-pair-committed-marker-tmp',
    'archive-manifest-previous-takeover',
    'archive-manifest-three-way-conflict',
    'artifact-install-candidate-takeover',
    'artifact-install-destination-takeover',
    'archive-manifest-previous-unknown-only',
    'archive-manifest-previous-valid-only',
    'archive-manifest-previous-restart-samebytes',
    'archive-manifest-previous-internal-drift',
    'terminal-pair-internal-marker-drift',
    'prelive-initializing-auto-rollback',
    'prelive-prepared-auto-rollback',
    'archive-manifest-delete-takeover',
    'log-quarantine-delete-takeover',
    'site-displaced-delete-takeover',
    'archive-manifest-delete-crash-reentry',
    'log-quarantine-delete-crash-reentry',
    'site-displaced-delete-crash-reentry',
    'terminal-pair-committed-tmp-drift',
    'terminal-source-destination-drift',
    'terminal-rollback-destination-drift',
    'terminal-previous-delete-crash-reentry',
    'prelive-initializing-validation-fail',
    'prelive-prepared-delete-crash-reentry',
    'artifact-install-candidate-samebytes',
    'artifact-final-delete-takeover',
    'artifact-final-delete-crash-reentry',
    'artifact-candidate-delete-crash-reentry',
    'rotation-status-delete-takeover',
    'rotation-status-delete-crash-reentry',
    'partial-backup-destination-takeover',
    'rotation-directory-candidate-takeover',
    'restore-site-absent-samebytes-crash-reentry',
    'crossfs-candidate-samebytes-takeover',
    'crossfs-destination-samebytes-takeover',
    'crossfs-copied-crash-reentry',
    'crossfs-published-crash-reentry',
    'proc-quiescence-permission-denied',
    'rotation-config-samebytes-takeover',
    'rotation-logrotate-samebytes-takeover',
    'rotation-anchor-samebytes-takeover',
    'rotation-ledger-samebytes-takeover',
    'rotation-child-nonzero',
    'rotation-child-sigkill',
  ];
  assert.equal(cJournalCleanupScenarios.length, 40, 'C journal/cleanup scenario contract drifted');
  for (const scenario of [...scenarios, ...cJournalCleanupScenarios]) {
    assert.ok(integration.includes(scenario), `integration matrix missing ${scenario}`);
    assert.ok(scenarioRunner.includes(scenario), `scenario runner missing ${scenario}`);
  }
  const independentRecovery = integration.match(
    /^independent_recovery_scenarios=\(\n([\s\S]*?)\n\)/m,
  )?.[1].split('\n').map((line) => line.trim()).filter(Boolean) ?? [];
  const matrix = integration.match(/^scenarios=\(\n([\s\S]*?)\n\)/m)?.[1]
    .split('\n').map((line) => line.trim()).filter(Boolean) ?? [];
  const allowlistBlock = scenarioRunner.match(/case "\$scenario" in\n([\s\S]*?)\n\s+\*\)/)?.[1] ?? '';
  const allowlist = [...allowlistBlock.matchAll(/^\s+([^*\n][^)]*)\) ;;/gm)]
    .flatMap((match) => match[1].split('|'));
  assert.equal(matrix.length, 135, 'GL-a matrix count drifted');
  assert.equal(matrix.length - cJournalCleanupScenarios.length, 95, 'GL-a legacy matrix baseline drifted');
  assert.equal(new Set(matrix).size, matrix.length, 'GL-a matrix contains duplicate scenarios');
  assert.equal(independentRecovery.length, 10, 'independent recovery contract count drifted');
  assert.equal(new Set(independentRecovery).size, independentRecovery.length,
    'independent recovery contracts contain duplicates');
  assert.deepEqual(
    [...allowlist].sort(),
    [...matrix, ...independentRecovery, 'preflight-logrotate-missing'].sort(),
    'runner allowlist must equal frozen matrix plus independent contracts',
  );
  assert.match(integration, /scenario_count=\$\{#scenarios\[@\]\}/);
  assert.match(integration, /scenario_passed=\$\(\(scenario_passed \+ 1\)\)/);
  assert.match(integration, /%s\/%s scenarios passed/);
  assert.doesNotMatch(integration, /25\/25 scenarios passed/);
  assert.match(scenarioRunner, /TAIL/);
  assert.match(scenarioRunner, /GL_A_TEST_LOG_QUIESCENCE_TIMEOUT_SECONDS/);
  assert.match(integration, /docker_args=\(run --rm --network none\)/);
  assert.match(
    integration,
    /if \[ "\$scenario" != proc-quiescence-permission-denied \]; then\n\s*docker_args\+=\(--cap-add SYS_PTRACE\)/,
  );
  assert.match(integration, /docker_args\+=\(--tmpfs \/var\/backups\/aifeeds-performance-log/);
  assert.match(integration, /docker "\$\{docker_args\[@\]\}"/);
  assert.doesNotMatch(integration, /"\$\{scenario_(?:storage|capabilities)\[@\]\}"/);
  for (const required of [
    'restore-site-absent-samebytes-ready',
    'restore-site-absent.rollback.expected.fingerprint',
    'restore-site-absent.installer.expected.fingerprint',
    'assert_crossfs_terminal_evidence',
    'assert_crossfs_copied_window',
    'assert_crossfs_published_cleanup_window',
    'assert_same_bytes_distinct_inode_fingerprints',
    'archive-manifest-previous-valid-only',
    'archive-manifest-previous-restart-samebytes',
    'wait_for_file "$test_root/archive-manifest-previous-ready" 800',
  ]) assert.ok(scenarioRunner.includes(required), `SITE-absent takeover scenario missing ${required}`);
});

test('journal tmp takeover uses CAS crash hooks and preserves attacker-owned T fail-closed', () => {
  const installerTakeover = scenarioRunner.match(
    /installer-journal-tmp-takeover\)([\s\S]*?)\n\s*;;/,
  )?.[1] ?? '';
  const rollbackTakeover = scenarioRunner.match(
    /rollback-journal-tmp-takeover\)([\s\S]*?)\n\s*;;/,
  )?.[1] ?? '';
  for (const required of [
    'GL_A_TEST_JOURNAL_CAS_CRASH=source:initializing:t-durable',
    'wait_for_c_crash "$installer_pid" journal-cas-crash-hit',
    'assert_cas_namespace "$installer_journal" T',
    'replace_same_bytes_inode "$installer_journal_tmp" installer-journal-tmp',
    'run_installer_negative_twice_stable',
    'restore_preserved_inode "$installer_journal_tmp" installer-journal-tmp',
    'installer-journal-restored-retry-rc-$takeover_rc',
    'ERROR recovery_required=1',
    'installer-journal-restored-retry-false-pass',
    'GL_A_TEST_JOURNAL_CAS_CRASH=rollback:prepared:t-durable',
    'assert_cas_namespace "$installer_journal" F',
    'assert_cas_namespace "$recovery_rollback_journal" T',
    'load_recovery_contract_from_record',
    'recover_and_reenter installer-journal-tmp 0',
  ]) assert.ok(installerTakeover.includes(required), `installer tmp takeover missing ${required}`);
  for (const required of [
    'GL_A_TEST_JOURNAL_CAS_CRASH=rollback:prepared:t-durable',
    'wait_for_c_crash "$manual_pid" journal-cas-crash-hit',
    'assert_cas_namespace "$recovery_rollback_journal" T',
    'replace_same_bytes_inode "$rollback_tmp" rollback-journal-tmp',
    'run_c_negative_twice_stable',
    'restore_preserved_inode "$rollback_tmp" rollback-journal-tmp',
    'recover_and_reenter rollback-journal-tmp 0',
  ]) assert.ok(rollbackTakeover.includes(required), `rollback tmp takeover missing ${required}`);
  assert.doesNotMatch(
    syncShim,
    /(?:installer|rollback)-journal-tmp-(?:barrier|ready)/,
    'official journal CAS hooks must not be preempted by obsolete sync barriers',
  );
});

test('site CAS drift fixtures preserve source authority and distinguish read-only preflight', () => {
  const forwardStart = scenarioRunner.indexOf('\n    site-cas-live-drift|site-cas-candidate-drift)');
  const internalStart = scenarioRunner.indexOf(
    '\n    site-cas-internal-displaced-drift|site-cas-internal-candidate-drift)',
  );
  const manualStart = scenarioRunner.indexOf(
    '\n    manual-site-cas-internal-displaced-drift|manual-site-cas-internal-candidate-drift)',
  );
  const nextStart = scenarioRunner.indexOf('\n    manual-recovery-log-writer-tail)', manualStart);
  assert.ok(forwardStart >= 0 && internalStart > forwardStart && manualStart > internalStart);
  assert.ok(nextStart > manualStart);
  const forward = scenarioRunner.slice(forwardStart, internalStart);
  const internal = scenarioRunner.slice(internalStart, manualStart);
  const manual = scenarioRunner.slice(manualStart, nextStart);
  for (const block of [forward, internal]) {
    for (const required of [
      '.phase == "mutation_started"',
      'source_fingerprint=',
      'source_revision=',
      'assert_gl_a_journal_identity "$journal" mutation_started',
      'automatic_rollback=failed',
      'run_installer_recovery_required_twice_stable',
      'assert_file_identity_fingerprint "$journal" "$source_fingerprint"',
      'source-revision-changed',
      'conflict_fingerprint=',
      'assert_journaled_path_inode',
      'assert_terminal_marker_namespace_absent',
    ]) assert.ok(block.includes(required), `forward site CAS authority missing ${required}`);
  }
  for (const required of [
    'site-cas-live-forward-candidate-changed',
    'site-cas-live-displaced-present',
    'site-cas-candidate-displaced-present',
    'site-cas-internal-displaced-live-present',
  ]) assert.ok(scenarioRunner.includes(required), `site CAS topology missing ${required}`);
  for (const block of [forward, internal]) {
    assert.ok(block.includes('assert_cas_namespace "$rollback_journal" ""'));
    assert.ok(block.includes('.phase == "rollback_failed" and .failed_from == "prepared"'));
    assert.ok(block.includes('.source_journal_sha256 == $source_sha'));
  }
  for (const required of [
    '.phase == "committed"',
    '.phase == "rollback_failed" and .failed_from == "prepared"',
    '.phase == "prepared" and (has("failed_from") | not)',
    '.source_origin_phase == "committed"',
    '.source_journal_sha256 == $source_sha',
    'source_fingerprint=',
    'assert_journaled_path_inode',
    'assert_terminal_marker_namespace_absent',
    'rollback_fingerprint=',
    'rollback_revision=',
    'namespace_fingerprint=',
    'assert_cas_namespace "$recovery_rollback_journal" FT',
    'manual-site-cas-internal-candidate-rollback-tmp-authority',
    'run_manual_failure_twice_stable',
    'reentry-rollback-changed',
    'reentry-namespace-changed',
  ]) assert.ok(manual.includes(required), `manual site CAS authority missing ${required}`);
});

test('source CAS fixture separates contract payload from externally trusted authority', () => {
  const exercise = scenarioRunner.match(
    /exercise_source_journal_cas\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  for (const required of [
    'T) contract_record="${source}.tmp"; external_predecessor_record="${source}.tmp"; expected_settled_record="${source}.tmp"',
    'FT) contract_record="${source}.tmp"; external_predecessor_record="$source"; expected_settled_record="${source}.tmp"',
    'TP) contract_record="${source}.tmp"; external_predecessor_record="$previous"; expected_settled_record="${source}.tmp"',
    'FP|FC) contract_record="$source"; external_predecessor_record="$source"; expected_settled_record="$source"',
    'external_predecessor_sha=$(sha256sum "$external_predecessor_record"',
    'expected_settled_sha=$(sha256sum "$expected_settled_record"',
    'load_recovery_contract_from_record "$contract_record" "$external_predecessor_sha" "$expected_settled_sha"',
  ]) assert.ok(exercise.includes(required), `source CAS fixture authority missing ${required}`);
  for (const required of [
    '.source_before_sha256 == $expected_settled_sha',
    '.source_journal_sha256 == $expected_settled_sha',
    'test "$recovery_source_sha" = "$original_cli_source_sha"',
  ]) assert.ok(scenarioRunner.includes(required), `positive reentry authority missing ${required}`);
  assert.ok(scenarioRunner.includes("settled_source_sha=$(jq -er '.source_before_sha256'"));
  assert.ok(scenarioRunner.includes('--arg source_sha "$settled_source_sha"'));
});

test('legacy runtime_removed fixture preserves real residue before rebuilding a cleanup plan', () => {
  const exercise = scenarioRunner.match(
    /exercise_runtime_cleanup_reentry\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  for (const required of [
    'cleanup-*-legacy-runtime-removed) point=phase:legacy-runtime-removed-residue; mutation=legacy',
    '.phase == "site_restored" and (.runtime_cleanup | not)',
    'test -e /etc/systemd/system/aifeeds-performance-logrotate.service',
    'test -e /etc/nginx/conf.d/aifeeds-performance-log.conf',
    'test -e /var/log/nginx/aifeeds-performance.jsonl',
    'rewrite_json_in_place "$rollback" legacy-cleanup',
  ]) assert.ok(exercise.includes(required), `legacy cleanup residue fixture missing ${required}`);
});

test('same-operation journal residue reaches recovery before live runtime absence checks', () => {
  const main = installer.slice(installer.indexOf('trap rollback_on_failure EXIT'));
  const gate = main.indexOf('if [ -e "$BACKUP_DIR" ] || [ -L "$BACKUP_DIR" ]; then');
  const scan = main.indexOf(
    'write_find_inventory "$FIND_JOURNAL_INVENTORY" "$BACKUP_DIR" -maxdepth 1',
    gate,
  );
  const settle = main.indexOf(
    'settle_journal_update "$JOURNAL" "$JOURNAL_PREVIOUS_UPDATE" source ""',
  );
  const liveAbsence = main.indexOf('for path in \\\n    "$FORMAT" "$ROTATE" "$LOG"');
  assert.ok(gate >= 0 && gate < scan && scan < settle && settle < liveAbsence);
  for (const required of [
    'test -d "$BACKUP_DIR"',
    'test ! -L "$BACKUP_DIR"',
    `test "$(stat -c '%U %G %a' "$BACKUP_DIR")" = 'root root 700'`,
    '-name "transaction-${OPERATION_ID}.json*"',
    '-name "rollback-transaction-${OPERATION_ID}.json*"',
    '-name "rollback-commit-${OPERATION_ID}.json*"',
    'ERROR recovery_required=1 journal=%s phase=pending',
    'exit 76',
  ]) assert.ok(main.slice(gate, settle).includes(required), `early recovery gate missing ${required}`);
});

test('failed-from drift fixture crosses a post-cleanup failure instead of an unknown-tombstone preflight', () => {
  const exercise = scenarioRunner.match(
    /exercise_runtime_cleanup_reentry\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  for (const required of [
    'GL_A_TEST_TERMINAL_PAIR_FAILURE=logs-archived',
    'GL_A_TEST_JOURNAL_CAS_CRASH=rollback:rollback_failed:t-durable',
    'cleanup-failed-from-terminal-failure-not-hit',
    'rewrite_json_in_place "${rollback}.tmp" failed-from',
  ]) assert.ok(exercise.includes(required), `failed-from fixture missing ${required}`);
  assert.ok(!exercise.includes('replace_unknown_inode "$tomb" cleanup-runtime-failed-from'));
});

test('daemon-reload rollback failure preserves the identity-bound live log handoff', () => {
  const assertion = scenarioRunner.match(/assert_rollback\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  for (const required of [
    'if [ "$expected_phase" = rollback_failed ]',
    'expected_source_phase=mutated',
    '.phase == "rollback_failed" and .failed_from == "runtime_removed"',
    '.runtime_cleanup.cursor_state == "complete"',
    'has("log_archive_manifest_sha256")',
    '.slot == "log" and .action == "archive_handoff"',
    '.selected_path == $log',
    'stat -c \'%u %g %a %d %i\'',
    'rollback-live-log-handoff-identity',
    'rollback-failed-audit-premature',
  ]) assert.ok(assertion.includes(required), `failed rollback log handoff assertion missing ${required}`);
  const absentBlock = assertion.match(/absent_paths=\(([\s\S]*?)\n\s*\)/)?.[1] ?? '';
  assert.doesNotMatch(absentBlock, /aifeeds-performance[.]jsonl/);
});

test('restore-candidate crash hook arms only after committed installation', () => {
  const scenario = scenarioRunner.match(
    /manual-recovery-restore-candidate\)([\s\S]*?)\n\s*;;/,
  )?.[1] ?? '';
  const marker = '$test_root/restore-candidate-manual-phase-enabled';
  assert.ok(scenario.includes(`: > "${marker}"`));
  assert.ok(
    scenario.indexOf('install_committed_contract')
      < scenario.indexOf(`: > "${marker}"`),
  );
  assert.ok(
    scenario.indexOf(`: > "${marker}"`)
      < scenario.indexOf('start_manual_rollback'),
  );
  for (const shim of [syncShim, readFileSync(resolve(here, 'test-fixtures/gl-a-installer/shims/cp'), 'utf8')]) {
    assert.ok(shim.includes('[ -e "$state_dir/restore-candidate-manual-phase-enabled" ]'));
  }
  const restoreCandidateShims = [
    syncShim,
    readFileSync(resolve(here, 'test-fixtures/gl-a-installer/shims/cp'), 'utf8'),
  ].join('\n');
  assert.doesNotMatch(restoreCandidateShims, /restore-candidate-journal-barrier-once/);
  assert.equal(
    restoreCandidateShims.match(/mkdir "\$state_dir\/restore-candidate-barrier-once"/g)?.length,
    3,
    'all restore-candidate interception paths must share one once-token',
  );
});

test('audit-log crash barrier allows the late rollback checkpoint to become durable', () => {
  const scenario = scenarioRunner.match(
    /manual-recovery-audit-log\)([\s\S]*?)\n\s*;;/,
  )?.[1] ?? '';
  assert.ok(
    scenario.includes('wait_for_file "$test_root/audit-log-ready" 1200'),
    'archive publication occurs after runtime cleanup and nginx reload, so the default 10s wait is insufficient',
  );
  assert.ok(
    syncShim.includes(
      'any(.entries[]; .source == "/var/log/nginx/aifeeds-performance.jsonl" and .state == "archived")',
    ),
    'the barrier must wait for the live log entry, not an earlier rotated log entry',
  );
});

test('active-writer fixture closes the inherited descriptor and keeps an exact late checkpoint', () => {
  const tailStart = scenarioRunner.lastIndexOf('\n    manual-recovery-log-writer-tail)');
  const tailEnd = scenarioRunner.indexOf('\n    manual-recovery-log-writer-timeout)', tailStart);
  const tail = scenarioRunner.slice(tailStart, tailEnd);
  assert.ok(
    tail.includes('wait_for_file "$quarantine" 1200'),
    'the live-log quarantine is published after cleanup and nginx reload, beyond the default 10s budget',
  );
  assert.ok(
    tail.includes('start_manual_rollback "$manual_output" {writer_fd}>&-'),
    'the rollback child must not inherit the writer fd whose quiescence it waits for',
  );
  assert.ok(tail.indexOf('exec {writer_fd}>>"$live_log"')
    < tail.indexOf('start_manual_rollback "$manual_output" {writer_fd}>&-'));
  assert.ok(tail.indexOf('start_manual_rollback "$manual_output" {writer_fd}>&-')
    < tail.indexOf('wait_for_file "$quarantine" 1200'));
  assert.ok(tail.indexOf('wait_for_file "$quarantine" 1200')
    < tail.indexOf(`printf '{"marker":"TAIL"}\\n' >&"$writer_fd"`));

});

test('terminal crash fixtures wait for late barriers without reloading stale source authority', () => {
  const preparedMarker = scenarioRunner.match(
    /manual-recovery-terminal-pair-marker\)([\s\S]*?)\n\s*;;/,
  )?.[1] ?? '';
  assert.ok(
    preparedMarker.includes('wait_for_file "$test_root/terminal-pair-marker-ready" 1200'),
    'prepared terminal marker publication can exceed the default barrier budget',
  );

  const committedMarkerTmp = scenarioRunner.match(
    /terminal-pair-committed-marker-tmp\)([\s\S]*?)\n\s*;;/,
  )?.[1] ?? '';
  assert.ok(
    committedMarkerTmp.includes(
      'wait_for_file "$test_root/terminal-pair-committed-marker-tmp-ready" 1200',
    ),
    'committed terminal marker tmp publication can exceed the default barrier budget',
  );

  const terminalPrevious = scenarioRunner.match(
    /terminal-previous-delete-crash-reentry\)([\s\S]*?)\n\s*;;/,
  )?.[1] ?? '';
  assert.match(
    terminalPrevious,
    /kill_process_group_at_cleanup_barrier "\$manual_pid"[\s\S]*?terminal-previous-delete-crash-reentry[.]payload[.]path" 1200/,
  );
  const afterBarrier = terminalPrevious.slice(
    terminalPrevious.indexOf('kill_process_group_at_cleanup_barrier'),
  );
  assert.doesNotMatch(afterBarrier, /load_manual_recovery_contract/);
  assert.ok(
    terminalPrevious.indexOf('install_committed_contract')
      < terminalPrevious.indexOf('kill_process_group_at_cleanup_barrier'),
  );
  assert.ok(
    terminalPrevious.indexOf('kill_process_group_at_cleanup_barrier')
      < terminalPrevious.indexOf('recover_and_reenter terminal-previous-delete-crash-reentry'),
  );
  assert.ok(
    terminalPrevious.includes('recover_and_reenter terminal-previous-delete-crash-reentry 1'),
    'terminal previous-cleanup recovery must expect a resumed first pass',
  );

  const recoverAndReenter = scenarioRunner.match(
    /recover_and_reenter\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  assert.match(
    recoverAndReenter,
    /if \[ -n "\$expected_resumed" \]; then\n\s*c_expected_first_resumed=\$expected_resumed\n\s*grep -Fq/,
    'the explicit first-pass expectation must feed the shared terminal assertions',
  );

  const terminalResume = rollbackScript.match(
    /SOURCE_JOURNAL=\$SOURCE_JOURNAL_FINAL\nROLLBACK_JOURNAL=\$ROLLBACK_JOURNAL_FINAL\nif \[ "\$TERMINAL_RECOVERY_PENDING" -eq 1 \]; then([\s\S]*?)\nelse\n\s*recover_archive_manifest_cleanup_tombstone/,
  )?.[1] ?? '';
  for (const required of [
    'takeover_terminal_pair_commit_marker_tmp',
    'terminal_pair_unified_precommit_recover',
  ]) assert.ok(terminalResume.includes(required), `terminal resume ordering missing ${required}`);
  assert.ok(
    terminalResume.indexOf('takeover_terminal_pair_commit_marker_tmp')
      < terminalResume.indexOf('terminal_pair_unified_precommit_recover'),
    'owned terminal marker cleanup must settle before the global zero-residue assertion',
  );

  const unifiedRecovery = rollbackScript.match(
    /terminal_pair_unified_precommit_recover\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  assert.match(unifiedRecovery, /^\n\s*local intent_marker\n\s*assert_terminal_state/);
  const terminalState = rollbackScript.match(/assert_terminal_state\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.ok(terminalState.includes('assert_no_operation_cleanup_dirs'));
});

test('artifact cleanup crash fixtures use the official current-namespace hook', () => {
  const helper = scenarioRunner.match(
    /assert_format_cleanup_crash_window\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  for (const required of [
    '.runtime_cleanup.items[.runtime_cleanup.cursor].slot == "format"',
    '.runtime_cleanup.cursor_state == $expected_state',
    'assert_file_identity_fingerprint "$tombstone"',
    'test ! -e "$selected"',
    'test ! -e "$test_root/${scenario}-ready"',
  ]) assert.ok(helper.includes(required), `format cleanup crash helper missing ${required}`);

  const groupedStart = scenarioRunner.indexOf('\n    archive-manifest-delete-crash-reentry)');
  const groupedEnd = scenarioRunner.indexOf('\n    artifact-final-delete-crash-reentry)', groupedStart);
  const groupedCleanup = scenarioRunner.slice(groupedStart, groupedEnd);
  assert.ok(groupedStart >= 0 && groupedEnd > groupedStart);
  assert.doesNotMatch(groupedCleanup, /artifact-(?:final|candidate)|log-quarantine/);

  const artifactFinal = scenarioRunner.match(
    /artifact-final-delete-crash-reentry\)([\s\S]*?)\n\s*;;/,
  )?.[1] ?? '';
  for (const required of [
    'GL_A_TEST_RUNTIME_CLEANUP_CRASH=format:detaching',
    'wait_for_c_crash "$manual_pid" runtime-cleanup-crash-hit 1200',
    'assert_format_cleanup_crash_window detaching',
    '/etc/nginx/conf.d/aifeeds-performance-log.conf',
    'artifact-final-cleanup-tombstone-remained',
  ]) assert.ok(artifactFinal.includes(required), `artifact final crash missing ${required}`);
  assert.doesNotMatch(
    artifactFinal,
    /kill_process_group_at_cleanup_barrier|cleanup_barrier_wait|load_manual_recovery_contract/,
  );

  const artifactCandidate = scenarioRunner.match(
    /artifact-candidate-delete-crash-reentry\)([\s\S]*?)\n\s*;;/,
  )?.[1] ?? '';
  for (const required of [
    'GL_A_TEST_RUNTIME_CLEANUP_CRASH=format:detached',
    'wait_for_c_crash "$manual_pid" runtime-cleanup-crash-hit 1200',
    "format_candidate=$(jq -er '.artifact_candidates.format' \"$recovery_source_journal\")",
    'assert_format_cleanup_crash_window detached "$format_candidate"',
    'artifact-candidate-cleanup-tombstone-remained',
  ]) assert.ok(artifactCandidate.includes(required), `artifact candidate cleanup lost ${required}`);
  const afterOfficialCrash = artifactCandidate.slice(
    artifactCandidate.indexOf('wait_for_c_crash "$manual_pid" runtime-cleanup-crash-hit 1200'),
  );
  assert.doesNotMatch(afterOfficialCrash, /load_manual_recovery_contract/);
  assert.doesNotMatch(artifactCandidate, /kill_process_group_at_cleanup_barrier|payload[.]path/);

  const rotationStatus = scenarioRunner.match(
    /rotation-status-delete-crash-reentry\)([\s\S]*?)\n\s*;;/,
  )?.[1] ?? '';
  for (const required of [
    'GL_A_TEST_RUNTIME_CLEANUP_CRASH=rotation_status:detaching',
    'wait_for_c_crash "$manual_pid" runtime-cleanup-crash-hit 1200',
    'assert_official_runtime_cleanup_crash_window rotation_status 4 detaching',
    '/var/lib/aifeeds-performance-logrotate/status',
    'recover_and_reenter rotation-status-delete-crash-reentry',
    'rotation-status-crash-cleanup-tombstone-remained',
  ]) assert.ok(rotationStatus.includes(required), `rotation status crash missing ${required}`);
  assert.doesNotMatch(
    rotationStatus,
    /kill_process_group_at_cleanup_barrier|cleanup_barrier_wait|payload[.]path/,
  );
  assert.doesNotMatch(syncShim, /rotation-status-delete-crash-reentry:rotation-status/);
});

test('takeover evidence: artifact destination refusal is pre-rollback and retry-stable', () => {
  const body = scenarioRunner.match(
    /\n    artifact-install-destination-takeover\)([\s\S]*?)\n\s*;;/,
  )?.[1] ?? '';
  assert.ok(body, 'artifact destination takeover must have an independent scenario body');
  for (const required of [
    'assert_cas_namespace "$journal" F',
    'assert_cas_namespace "$rollback_journal" \'\'',
    'artifact_destination_source_fingerprint=$(file_identity_fingerprint "$journal")',
    'artifact_destination_candidate_fingerprint=$(file_identity_fingerprint "$candidate")',
    'artifact_destination_unknown_fingerprint=$(file_identity_fingerprint "$destination")',
    'test "$retry_rc" -eq 76',
    'artifact-destination-retry-source',
    'artifact-destination-retry-candidate',
    'artifact-destination-retry-unknown',
  ]) assert.ok(body.includes(required), `artifact destination evidence missing ${required}`);
  assert.match(body, /jq -e '[^']*[.]phase == "mutation_started"[^']*' "\$journal"/);
  assert.doesNotMatch(body, /file_identity_fingerprint "\$rollback_journal"/);
});

test('takeover evidence: rotation directory refusal locks both journals and both directory trees', () => {
  const body = scenarioRunner.match(
    /\n    rotation-directory-candidate-takeover\)([\s\S]*?)\n\s*;;/,
  )?.[1] ?? '';
  for (const required of [
    'source_journal="/var/backups/aifeeds-performance-log/transaction-${operation_id}.json"',
    'rollback_journal="/var/backups/aifeeds-performance-log/rollback-transaction-${operation_id}.json"',
    'assert_cas_namespace "$source_journal" F',
    'assert_cas_namespace "$rollback_journal" F',
    'rotation_source_fingerprint=$(file_identity_fingerprint "$source_journal")',
    'rotation_rollback_fingerprint=$(file_identity_fingerprint "$rollback_journal")',
    'rotation_preserved_file="$rotation_preserved/rotation-provenance.jsonl"',
    'rotation_unknown_file_fingerprint=$(file_identity_fingerprint "$rotation_candidate/unknown")',
    'rotation_preserved_file_fingerprint=$(file_identity_fingerprint "$rotation_preserved_file")',
    'test "$retry_rc" -eq 76',
    'rotation-directory-retry-source',
    'rotation-directory-retry-rollback',
    'rotation-directory-retry-unknown-dir',
    'rotation-directory-retry-preserved-dir',
    'rotation-directory-retry-unknown-file',
    'rotation-directory-retry-preserved-file',
  ]) assert.ok(body.includes(required), `rotation directory evidence missing ${required}`);
  assert.match(body, /[.]phase == "mutation_started" and [.]rotation_state_identity != null/);
  assert.match(body, /[.]phase == "rollback_failed" and [.]failed_from == "prepared"/);
  assert.ok(body.includes('(.runtime_cleanup // null) == null'));
});

test('takeover evidence: displaced site refusal locks journal finals and the takeover pair', () => {
  const body = scenarioRunner.match(
    /\n    site-displaced-delete-takeover\)([\s\S]*?)\n\s*;;/,
  )?.[1] ?? '';
  for (const required of [
    'source_journal="/var/backups/aifeeds-performance-log/transaction-${operation_id}.json"',
    'rollback_journal="/var/backups/aifeeds-performance-log/rollback-transaction-${operation_id}.json"',
    'assert_cas_namespace "$source_journal" F',
    'assert_cas_namespace "$rollback_journal" F',
    'site_displaced_source_fingerprint=$(file_identity_fingerprint "$source_journal")',
    'site_displaced_rollback_fingerprint=$(file_identity_fingerprint "$rollback_journal")',
    'site_displaced_unknown_fingerprint=$(file_identity_fingerprint "$unknown_path")',
    'site_displaced_expected_fingerprint=$(file_identity_fingerprint "$site_displaced_preserved")',
    'test "$retry_rc" -eq 76',
    'site-displaced-retry-source',
    'site-displaced-retry-rollback',
    'site-displaced-retry-unknown',
    'site-displaced-retry-expected',
  ]) assert.ok(body.includes(required), `site displaced evidence missing ${required}`);
  assert.match(body, /[.]phase == "mutation_started"/);
  assert.match(body, /[.]phase == "rollback_failed" and [.]failed_from == "prepared"/);
  assert.ok(body.includes('(.runtime_cleanup // null) == null'));
});

test('takeover evidence: log quarantine selection is exhaustive and terminal failure is immutable', () => {
  const body = scenarioRunner.match(
    /\n    log-quarantine-delete-takeover\)([\s\S]*?)\n\s*;;/,
  )?.[1] ?? '';
  assert.ok(body, 'log quarantine takeover must have an independent scenario body');
  for (const required of [
    'recorded_unknown_fingerprint=$(<"$test_root/log-quarantine-delete-takeover.unknown.fingerprint")',
    'canonical_quarantines=(/var/log/nginx/.aifeeds-performance.jsonl*.quarantine-gl-a-${operation_id})',
    'canonical_match_count=0',
    'canonical_match_count=$((canonical_match_count + 1))',
    'test "$canonical_match_count" -eq 1',
    'assert_cas_namespace "$recovery_source_journal" F',
    'assert_cas_namespace "$recovery_rollback_journal" F',
    '.phase == "committed"',
    '.phase == "rollback_failed" and .failed_from == "nginx_reloaded"',
    '.runtime_cleanup.cursor == 14 and .runtime_cleanup.cursor_state == "complete"',
    'log_quarantine_source_fingerprint=$(file_identity_fingerprint "$recovery_source_journal")',
    'log_quarantine_rollback_fingerprint=$(file_identity_fingerprint "$recovery_rollback_journal")',
    'log-quarantine-reentry-source',
    'log-quarantine-reentry-rollback',
    'log-quarantine-reentry-unknown',
    'log-quarantine-reentry-expected',
  ]) assert.ok(body.includes(required), `log quarantine evidence missing ${required}`);
  assert.doesNotMatch(body, /find[\s\S]*?-print -quit/);
});

test('takeover evidence: final checker deletion uses the official runtime cleanup crash point', () => {
  const body = scenarioRunner.match(
    /\n    artifact-final-delete-takeover\)([\s\S]*?)\n\s*;;/,
  )?.[1] ?? '';
  assert.ok(body, 'artifact final takeover must have an independent scenario body');
  for (const required of [
    'GL_A_TEST_RUNTIME_CLEANUP_CRASH=checker:detaching',
    'wait_for_c_crash "$manual_pid" runtime-cleanup-crash-hit 1200',
    'assert_official_runtime_cleanup_crash_window checker 8 detaching',
    '/usr/local/sbin/aifeeds-check-nginx-request-id',
    'test ! -e "$test_root/artifact-final-delete-takeover-hit"',
    'recover_and_reenter artifact-final-delete-takeover',
    'artifact-final-cleanup-tombstone-remained',
  ]) assert.ok(body.includes(required), `artifact final official crash evidence missing ${required}`);
  assert.doesNotMatch(body, /run_manual_rollback "\$manual_output"|assert_recorded_takeover_pair/);

  const helper = scenarioRunner.match(
    /assert_official_runtime_cleanup_crash_window\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  for (const required of [
    'local expected_slot=$1 expected_cursor=$2 expected_state=$3 expected_selected=$4',
    '.runtime_cleanup.cursor == $expected_cursor',
    '.runtime_cleanup.items[$expected_cursor].slot == $expected_slot',
    'expected_tombstone="${expected_selected}.runtime-cleanup-gl-a-${operation_id}-$(printf \'%02d\' "$expected_cursor")"',
    'test "$tombstone" = "$expected_tombstone"',
    'assert_file_identity_fingerprint "$tombstone" "$expected_fingerprint"',
  ]) assert.ok(helper.includes(required), `official cleanup helper missing ${required}`);

  const legacyHook = syncShim.match(
    /case "\$scenario:\$cleanup_payload_kind" in([\s\S]*?)archive-manifest-delete-crash-reentry:archive-manifest/,
  )?.[1] ?? '';
  assert.doesNotMatch(legacyHook, /artifact-final-delete-takeover/);
});

test('takeover evidence: rotation status deletion uses the official detached crash point', () => {
  const body = scenarioRunner.match(
    /\n    rotation-status-delete-takeover\)([\s\S]*?)\n\s*;;/,
  )?.[1] ?? '';
  assert.ok(body, 'rotation status takeover must have an independent scenario body');
  for (const required of [
    'GL_A_TEST_RUNTIME_CLEANUP_CRASH=rotation_status:detached',
    'wait_for_c_crash "$manual_pid" runtime-cleanup-crash-hit 1200',
    'assert_official_runtime_cleanup_crash_window rotation_status 4 detached',
    '/var/lib/aifeeds-performance-logrotate/status',
    'test ! -e "$test_root/rotation-status-delete-takeover-hit"',
    'recover_and_reenter rotation-status-delete-takeover',
    'rotation-status-cleanup-tombstone-remained',
  ]) assert.ok(body.includes(required), `rotation status official crash evidence missing ${required}`);
  assert.doesNotMatch(body, /run_manual_rollback "\$manual_output"|assert_recorded_takeover_pair/);

  const legacyHook = syncShim.match(
    /case "\$scenario:\$cleanup_payload_kind" in([\s\S]*?)archive-manifest-delete-crash-reentry:archive-manifest/,
  )?.[1] ?? '';
  assert.doesNotMatch(legacyHook, /rotation-status-delete-takeover/);
});

test('same-filesystem log handoff converges directly while cross-filesystem deletion owns crash recovery', () => {
  const sameFs = scenarioRunner.match(
    /log-quarantine-delete-crash-reentry\)([\s\S]*?)\n\s*;;/,
  )?.[1] ?? '';
  for (const required of [
    'test "$manual_rc" -eq 0',
    'log-quarantine-delete-crash-reentry-ready',
    '.state == "archived"',
    '.destination_dev == $live_dev and .destination_ino == $live_ino',
    'samefs-log-destination-identity',
    'capture_manual_terminal_hashes',
    'assert_manual_reentry_unchanged',
  ]) assert.ok(sameFs.includes(required), `same-filesystem log convergence missing ${required}`);
  assert.match(sameFs, /test ! -e "\$test_root\/log-quarantine-delete-crash-reentry-ready"/);
  assert.doesNotMatch(sameFs, /kill_process_group_at_cleanup_barrier|cleanup_barrier_wait/);

  const tmpfsArm = integration.match(
    /case "\$scenario" in\n\s*([^\n]+)\)\n\s*if \[ "\$docker_server_os" != linux \]/,
  )?.[1] ?? '';
  assert.ok(tmpfsArm.includes('crossfs-published-crash-reentry'));
  assert.ok(!tmpfsArm.includes('log-quarantine-delete-crash-reentry'));

  const crossFs = scenarioRunner.match(
    /crossfs-published-crash-reentry\)([\s\S]*?)\n\s*;;/,
  )?.[1] ?? '';
  for (const required of [
    'kill_process_group_at_cleanup_barrier',
    'crossfs-published-crash-reentry.payload.path',
    'assert_crossfs_terminal_evidence',
  ]) assert.ok(crossFs.includes(required), `cross-filesystem crash coverage missing ${required}`);
  assert.ok(scenarioRunner.includes(
    'assert_crossfs_published_cleanup_window "$payload" crossfs-published-before-kill',
  ));
});

test('manifest read-only conflicts preserve their exact operation-scoped journal namespace', () => {
  const helper = scenarioRunner.match(
    /run_manifest_read_only_conflict_failure\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  for (const required of [
    'manual_rollback=failed',
    'assert_cas_namespace "$recovery_rollback_journal" ""',
    'assert_cas_namespace "$recovery_rollback_journal" F',
    'assert_file_identity_fingerprint "$recovery_rollback_journal"',
    'assert_terminal_marker_namespace_absent',
    '.operation_id == $operation_id and .phase == $expected_phase',
  ]) assert.ok(helper.includes(required), `manifest read-only conflict helper missing ${required}`);

  const unknownPrevious = scenarioRunner.match(
    /archive-manifest-previous-unknown-only\)([\s\S]*?)\n\s*;;/,
  )?.[1] ?? '';
  for (const required of [
    'run_manifest_read_only_conflict_failure',
    'archive-manifest-previous-unknown-only absent',
    'archive-manifest-previous-unknown-only-reentry absent',
  ]) assert.ok(unknownPrevious.includes(required), `unknown previous manifest lost ${required}`);

  const staleTmp = scenarioRunner.match(
    /archive-manifest-stale-tmp\)([\s\S]*?)\n\s*;;/,
  )?.[1] ?? '';
  for (const required of [
    'stale_rollback_fingerprint=',
    'run_manifest_read_only_conflict_failure archive-manifest-stale-tmp nginx_reloaded',
    'run_manifest_read_only_conflict_failure archive-manifest-stale-tmp-reentry nginx_reloaded',
  ]) assert.ok(staleTmp.includes(required), `stale manifest tmp lost ${required}`);

  const readOnlyConflictCases = [
    [
      'archive-manifest-regressive-tmp',
      [
        'regressive_rollback_fingerprint=',
        'run_manifest_read_only_conflict_failure archive-manifest-regressive-tmp nginx_reloaded',
        'run_manifest_read_only_conflict_failure archive-manifest-regressive-tmp-reentry nginx_reloaded',
        'regressive-tmp-reentry-final',
        'regressive-tmp-reentry-tmp',
      ],
    ],
    [
      'archive-manifest-unknown-final',
      [
        "unknown_final_entry_count=$(jq -er '.entries | length' \"$manifest\")",
        'unknown_rollback_fingerprint=',
        'run_manifest_read_only_conflict_failure archive-manifest-unknown-final nginx_reloaded',
        'run_manifest_read_only_conflict_failure archive-manifest-unknown-final-reentry nginx_reloaded',
        'unknown-final-reentry-final',
        'unknown-final-reentry-tmp',
      ],
    ],
    [
      'archive-manifest-three-way-conflict',
      [
        'three_way_rollback_fingerprint=',
        'run_manifest_read_only_conflict_failure archive-manifest-three-way-conflict nginx_reloaded',
        'run_manifest_read_only_conflict_failure archive-manifest-three-way-conflict-reentry nginx_reloaded',
        'three-way-reentry-previous',
        'three-way-reentry-final',
        'three-way-reentry-tmp',
      ],
    ],
    [
      'archive-manifest-previous-valid-only',
      [
        'archive-manifest-previous-valid-only absent',
        'archive-manifest-previous-valid-only-reentry absent',
        'previous-valid-only-reentry',
      ],
    ],
    [
      'archive-manifest-previous-restart-samebytes',
      [
        'previous_restart_rollback_fingerprint=',
        'run_manifest_read_only_conflict_failure archive-manifest-previous-restart-samebytes nginx_reloaded',
        'run_manifest_read_only_conflict_failure archive-manifest-previous-restart-samebytes-reentry nginx_reloaded',
        'previous-restart-reentry-unknown',
        'previous-restart-reentry-expected',
        'previous-restart-reentry-tmp',
      ],
    ],
  ];
  for (const [scenario, requiredValues] of readOnlyConflictCases) {
    const block = scenarioRunner.match(
      new RegExp(`${scenario}\\)([\\s\\S]*?)\\n\\s*;;`),
    )?.[1] ?? '';
    for (const required of requiredValues) {
      assert.ok(block.includes(required), `${scenario} lost read-only contract ${required}`);
    }
    assert.doesNotMatch(block, /\brun_manifest_conflict_failure\b/);
  }
});

test('terminal destination drift fixtures assert successful exact-pair convergence', () => {
  const block = scenarioRunner.match(
    /terminal-source-destination-drift\|terminal-rollback-destination-drift\)([\s\S]*?)\n\s*;;/,
  )?.[1] ?? '';
  for (const required of [
    'test "$manual_rc" -eq 0',
    'test ! -e "$test_root/${scenario}-hit"',
    'legacy-journal-namespace-reached',
    'assert_exact_terminal_pair "$operation_id"',
    'capture_manual_terminal_hashes',
    'assert_manual_reentry_unchanged',
  ]) assert.ok(block.includes(required), `terminal destination convergence missing ${required}`);
  assert.doesNotMatch(block, /unknown-final|target-tmp-missing|test "\$manual_rc" -ne 0/);
});

test('site-absent local conflict keeps the running nginx process without requiring a new config parse', () => {
  const finalDispatch = scenarioRunner.slice(scenarioRunner.lastIndexOf('\ncase "$scenario" in'));
  assert.match(
    finalDispatch,
    /restore-site-absent-samebytes-crash-reentry\)\s*\n?\s*assert_nginx_process_active/,
  );
  const nginxActiveArm = finalDispatch.match(
    /systemctl-is-active-error\|[\s\S]*?\)\s*\n?\s*assert_nginx_active/,
  )?.[0] ?? '';
  assert.doesNotMatch(nginxActiveArm, /restore-site-absent-samebytes-crash-reentry/);
});

test('reinstall accepts an exact prior terminal pair after a successor site deployment', () => {
  const scenario = scenarioRunner.match(
    /reinstall-after-auto-rollback\)([\s\S]*?)\n\s*;;/,
  )?.[1] ?? '';
  assert.doesNotMatch(scenario, /reinstall-first-paired-journal-created/);
  for (const required of [
    'assert_exact_terminal_pair "$operation_id"',
    'terminal_pair_namespace_fingerprint "$operation_id"',
    'old_source_revision=',
    'old_rollback_revision=',
    'old_source_fingerprint=',
    'old_rollback_fingerprint=',
    'old_marker_fingerprint=',
    'reinstall-old-terminal-namespace-changed',
    'reinstall-old-source-revision-changed',
    'reinstall-old-rollback-revision-changed',
    'reinstall-successor-site-not-changed',
    'reinstall-successor-site-invalid',
    'reinstall-successor-site-lost',
    'assert_cas_namespace "$secondary_journal" F "$secondary_operation_id"',
    'reinstall-secondary-summary-identity',
    'secondary_rollback=',
    'secondary_marker=',
    'reinstall-secondary-pair-present',
    'expected_marker_keys',
    'before authority base64 drift',
    'prepared marker predecessor drift',
    'terminal manifest evidence drift',
    'GL_A_TEST_TERMINAL_PAIR_CRASH=one-side',
    'GL_A_TEST_TERMINAL_PAIR_CRASH=two-side',
    'terminal-pair-rollback-only-source-previous-missing',
  ]) assert.ok(scenarioRunner.includes(required), `terminal-pair reinstall fixture missing ${required}`);
  assert.doesNotMatch(
    syncShim,
    /terminal-pair-(?:source|rollback)-only/,
    'the official terminal-pair crash hooks must not be preempted by obsolete sync barriers',
  );
});

test('sync fault shim reaches barriers only after real sync and never leaks false predicates', () => {
  const passthroughs = syncShim.match(/(?:exec\s+)?\/usr\/bin\/sync\s+"\$@"/g) ?? [];
  assert.deepEqual(passthroughs, ['/usr/bin/sync "$@"']);
  assert.ok(
    syncShim.indexOf('/usr/bin/sync "$@"') < syncShim.indexOf('if [ "${1:-}" = -f ]'),
    'the real durability request must complete before any fault hook or KILL barrier',
  );
  assert.match(syncShim, /# A false hook predicate[\s\S]*exit 0\s*$/);
});

test('no-SYS_PTRACE probe uses product code and proves PermissionError is fail-closed', () => {
  for (const [label, source] of [
    ['installer', quiescencePython],
    ['manual', rollbackQuiescencePython],
  ]) {
    assert.equal(
      (source.match(/except PermissionError as error:/g) ?? []).length,
      3,
      `${label} must handle every procfs permission boundary`,
    );
    assert.equal(
      (source.match(/raise RuntimeError\(f"cannot (?:scan|stat|read) \{/g) ?? []).length,
      3,
      `${label} must reject rather than skip inaccessible procfs state`,
    );
    assert.doesNotMatch(source, /except PermissionError[^\n]*:\n\s+continue/);
  }
  for (const required of [
    '1 << 19',
    'extract_product_quiescence_python "$rollback_helper"',
    'proc-permission-returned-zero',
    'proc-permission-false-pass',
    'proc-permission-target-moved-or-changed',
    'proc-permission-quarantine-created',
    'proc-permission-destination-created',
    'proc-permission-install-summary-created',
    'proc-permission-rollback-summary-created',
  ]) assert.ok(scenarioRunner.includes(required), `no-SYS_PTRACE probe missing ${required}`);
});

test('source journal updates use a strict operation-bound F/T/P CAS state machine', () => {
  for (const required of [
    'JOURNAL_PREVIOUS_UPDATE="${JOURNAL}.previous-update-gl-a-${OPERATION_ID}"',
    'journal_update_cas',
    'settle_journal_update',
    'O_EXCL | os.O_NOFOLLOW',
    'write_all',
    'rename_noreplace',
    'journal_update',
    'self_dev',
    'self_ino',
    'predecessor',
    'same bytes on a different inode',
    'invalid journal update state',
    'revision jump',
    'semantic phase regression',
  ]) assert.ok(installer.includes(required), `source journal CAS missing ${required}`);

  const writer = installer.match(/journal_update_cas\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY/)?.[1] ?? '';
  for (const required of [
    'os.fstat(descriptor)',
    'os.fsync(descriptor)',
    'os.fsync(parent_descriptor)',
    'RENAME_NOREPLACE',
  ]) assert.ok(writer.includes(required), `source journal CAS writer missing ${required}`);
  assert.doesNotMatch(writer, /os\.replace|os\.rename\(/);
  assert.doesNotMatch(installer, /mv -f "\$JOURNAL_TMP" "\$JOURNAL"/);
});

test('source journal is settled before phase inspection or live recovery mutation', () => {
  const main = installer.slice(installer.indexOf('trap rollback_on_failure EXIT'));
  const settle = main.indexOf('settle_journal_update "$JOURNAL"');
  const phaseRead = main.indexOf("jq -er '.phase'");
  const firstMutation = main.indexOf('cp -a "$SITE" "$SITE_BUILD_CANDIDATE"');
  assert.ok(settle >= 0, 'source journal settle call must exist');
  assert.ok(phaseRead < 0 || settle < phaseRead, 'settle must precede source phase reads');
  assert.ok(firstMutation < 0 || settle < firstMutation, 'settle must precede live mutation');
});

test('journal CAS rejects self-signed business drift and non-JSON constants', () => {
  const writer = installer.match(/journal_update_cas\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY/)?.[1] ?? '';
  for (const required of [
    'reject_duplicate_keys',
    'reject_json_constant',
    'validate_business',
    'SOURCE_REQUIRED',
    'SOURCE_OPTIONAL',
    'transaction_journal',
    'semantic field delta drift',
    'MISSING = object()',
  ]) assert.ok(writer.includes(required), `strict journal parser missing ${required}`);
  assert.ok(writer.includes('for field in ("self_dev", "self_ino")'));
  assert.ok(writer.includes('update[field] <= 0'));
  assert.match(writer, /fullmatch\(r"\[a-f0-9\]\{64\}"/);
});

test('journal predecessor cleanup keeps a held descriptor and private dirfd through unlink', () => {
  const writer = installer.match(/journal_update_cas\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY/)?.[1] ?? '';
  const cleanup = writer.match(/def exact_unlink\([\s\S]*?\n\n/)?.[0] ?? '';
  for (const required of ['dir_fd=', 'os.fstat(descriptor)', 'os.unlink(', 'os.stat(']) {
    assert.ok(cleanup.includes(required), `held-FD cleanup missing ${required}`);
  }
  assert.ok(cleanup.indexOf('os.unlink(') < cleanup.lastIndexOf('os.fstat(descriptor)'));
});

test('writable-fd quiescence waits for a delayed tail before succeeding', {
  skip: !existsSync('/proc/self/fd'),
}, async () => {
  assert.ok(quiescencePython.includes('fdinfo'));
  const directory = mkdtempSync(resolve(tmpdir(), 'aifeeds-quiescence-'));
  const path = resolve(directory, 'active.log');
  writeFileSync(path, 'HEAD\n');
  const writer = openSync(path, 'a');
  try {
    const resultPromise = runQuiescence(path, 2);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 180));
    writeSync(writer, 'TAIL\n');
    closeSync(writer);
    const result = await resultPromise;
    assert.equal(result.code, 0, result.stderr);
    assert.match(readFileSync(path, 'utf8'), /TAIL/);
  } finally {
    try { closeSync(writer); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});

test('writable-fd quiescence times out without deleting an active inode', {
  skip: !existsSync('/proc/self/fd'),
}, async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'aifeeds-quiescence-timeout-'));
  const path = resolve(directory, 'active.log');
  writeFileSync(path, 'PRESERVE\n');
  const writer = openSync(path, 'a');
  try {
    const result = await runQuiescence(path, 0.25);
    assert.equal(result.code, 110);
    assert.match(result.stderr, /quiescence timeout/);
    assert.equal(readFileSync(path, 'utf8'), 'PRESERVE\n');
  } finally {
    closeSync(writer);
    rmSync(directory, { recursive: true, force: true });
  }
});
