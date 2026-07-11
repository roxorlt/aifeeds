import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const checkerPath = resolve(here, 'nginx-capability.mjs');

async function loadChecker() {
  assert.ok(existsSync(checkerPath), 'pure nginx capability checker must exist');
  return import(pathToFileURL(checkerPath));
}

test('parses the nginx 1.24 package version without shelling out', async () => {
  const { parseNginxVersion } = await loadChecker();

  assert.deepEqual(parseNginxVersion('nginx version: nginx/1.24.0 (Ubuntu)'), {
    major: 1,
    minor: 24,
    patch: 0,
    version: '1.24.0',
  });
});

test('reports nginx 1.24 as unsafe for dynamic upstream resolve plus keepalive', async () => {
  const { assessNginxCapabilities } = await loadChecker();

  assert.deepEqual(assessNginxCapabilities('nginx version: nginx/1.24.0'), {
    detectedVersion: '1.24.0',
    minimumUpstreamResolveVersion: '1.27.3',
    safeDynamicUpstreamKeepalive: false,
    recommendedProxyStrategy: 'resolver+variable-proxy_pass',
  });
});

test('enables upstream server resolve plus keepalive from nginx 1.27.3', async () => {
  const { assessNginxCapabilities } = await loadChecker();

  for (const version of ['1.27.3', '1.27.4', '1.28.0', '2.0.0']) {
    const assessment = assessNginxCapabilities(`nginx version: nginx/${version}`);
    assert.equal(assessment.safeDynamicUpstreamKeepalive, true, version);
    assert.equal(assessment.recommendedProxyStrategy, 'upstream-resolve+keepalive', version);
  }
});

test('keeps every version below 1.27.3 on resolver plus variable proxy_pass', async () => {
  const { assessNginxCapabilities } = await loadChecker();

  for (const version of ['1.24.0', '1.26.3', '1.27.0', '1.27.2']) {
    const assessment = assessNginxCapabilities(`nginx/${version}`);
    assert.equal(assessment.safeDynamicUpstreamKeepalive, false, version);
    assert.equal(assessment.recommendedProxyStrategy, 'resolver+variable-proxy_pass', version);
  }
});

test('rejects missing or malformed nginx versions', async () => {
  const { parseNginxVersion } = await loadChecker();

  for (const value of ['', 'nginx version unknown', '1.27.3', null]) {
    assert.throws(() => parseNginxVersion(value), /nginx version/i);
  }
});
