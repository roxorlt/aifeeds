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
  ]) {
    assert.ok(config.includes(variable), `missing ${variable}`);
  }

  assert.match(config, /map\s+\$host\s+\$aifeeds_performance_loggable\s*\{/);
  assert.match(config, /default\s+0;/);
  for (const host of ['ai-feeds.com', 'api.ai-feeds.com', 'fonts.ai-feeds.com']) {
    assert.match(config, new RegExp(`\\b${host.replaceAll('.', '\\.') }\\s+1;`));
  }
  assert.match(
    config,
    /access_log\s+\/var\/log\/nginx\/aifeeds-performance\.jsonl\s+aifeeds_performance\s+if=\$aifeeds_performance_loggable;/,
  );
  assert.doesNotMatch(config, /\bproxy_set_header\b/);
  assert.doesNotMatch(config, /\$(?:request_uri|args|query_string|http_cookie|http_authorization)\b/i);
  assert.doesNotMatch(config, /origin.secret|phone|email/i);
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
  ]) {
    assert.ok(runbook.includes(required), `runbook missing ${required}`);
  }

  assert.doesNotMatch(runbook, /nginx\s+-T/);
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
    'cp "$BACKUP" /etc/nginx/sites-available/aifeeds.conf',
  ]) {
    assert.ok(runbook.includes(required), `rotation/rollback missing ${required}`);
  }
});
