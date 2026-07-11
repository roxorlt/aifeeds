import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const configPath = resolve(here, 'aifeeds-performance-log.conf');
const operationsPath = resolve(root, 'docs/operations.md');
const config = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
const operations = readFileSync(operationsPath, 'utf8');

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
    /access_log\s+\/var\/log\/nginx\/aifeeds-performance\.jsonl\s+aifeeds_performance\s+if=\$aifeeds_performance_loggable;/,
  );
  assert.doesNotMatch(config, /\bproxy_set_header\b/);
  assert.doesNotMatch(config, /\$(?:request_uri|args|query_string|http_cookie|http_authorization)\b/i);
  assert.doesNotMatch(config, /origin.secret|phone|email/i);
  assert.ok(config.includes('"uri":"$aifeeds_safe_uri"'));
  assert.ok(!config.includes('"uri":"$uri"'), 'raw URI must never be written directly');
});

test('safe URI map redacts permanent share tokens without hiding fixed routes', () => {
  assert.equal(safeUriFor('/s/permanent_share_token'), '/s/:token');
  assert.equal(safeUriFor('/s/encoded/token'), '/s/:token');
  assert.equal(safeUriFor('/api/share/poster/permanent_share_token'), '/api/share/poster/:token');
  assert.equal(safeUriFor('/api/share/poster/encoded/token'), '/api/share/poster/:token');
  assert.equal(safeUriFor('/api/admin/share/permanent_share_token'), '/api/admin/share/:token');
  assert.equal(safeUriFor('/api/admin/share/poster-cleanup'), '/api/admin/share/poster-cleanup');
  assert.equal(safeUriFor('/api/items'), '/api/items');
});

test('runbook scopes installation to aifeeds sites and documents safe join and staging limits', () => {
  const runbook = performanceRunbook();
  assert.ok(runbook, 'performance log runbook markers must exist');

  for (const required of [
    '本次提交仅版本化',
    'staging.ai-feeds.com',
    'staging-api.ai-feeds.com',
    '不经过香港 VPS',
    '~/.ssh/aifeeds-hk.pem',
    '/etc/nginx/conf.d/aifeeds-performance-log.conf',
    '/etc/nginx/sites-available/aifeeds.conf',
    'access_log /var/log/nginx/aifeeds-performance.jsonl aifeeds_performance if=$aifeeds_performance_loggable;',
    'proxy_set_header X-Request-Id $request_id;',
    'X-Request-Id',
    'Worker',
    'jq -e',
    'deploy/nginx/check-nginx-request-id.py',
    '/usr/local/sbin/aifeeds-check-nginx-request-id',
    '"$CHECKER" "$SITE"',
    'perf_probe',
    'X-Aifeeds-Perf-Probe',
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
    '/etc/logrotate.d/aifeeds-performance',
    'daily',
    'rotate 14',
    'delaycompress',
    'create 0640 www-data adm',
    'sharedscripts',
    'kill -USR1',
    '/run/nginx.pid',
    'test ! -e "$LOG"',
    'editor "$ROTATE"',
    'aifeeds.conf.bak-perf-',
    'rm -f /etc/nginx/conf.d/aifeeds-performance-log.conf',
    'rm -f /usr/local/sbin/aifeeds-check-nginx-request-id',
    'cp "$BACKUP" /etc/nginx/sites-available/aifeeds.conf',
  ]) {
    assert.ok(runbook.includes(required), `rotation/rollback missing ${required}`);
  }
});
