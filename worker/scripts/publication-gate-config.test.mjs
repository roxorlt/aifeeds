import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const GATES = Object.freeze([
  'PUBLICATION_CAPACITY_WARNING_DRAIN_ENABLED',
  'PUBLICATION_CAPACITY_WARNING_PRODUCER_ENABLED',
  'DAILY_PUBLICATION_RESERVATION_ENABLED',
  'DAILY_PUBLICATION_PUT_ENABLED',
  'DAILY_PUBLICATION_PROMOTION_ENABLED',
]);

function tableValues(source, wantedTable) {
  let table = '';
  const values = new Map();
  for (const rawLine of source.split('\n')) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    const tableMatch = line.match(/^\[([^\]]+)\]$/);
    if (tableMatch) {
      table = tableMatch[1];
      continue;
    }
    if (table !== wantedTable) continue;
    const valueMatch = line.match(/^([A-Z0-9_]+)\s*=\s*"([^"]*)"$/);
    if (valueMatch) values.set(valueMatch[1], valueMatch[2]);
  }
  return values;
}

test('bootstrap production config keeps every publication gate explicitly disabled', async () => {
  const source = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const production = tableValues(source, 'vars');

  for (const gate of GATES) assert.equal(production.get(gate), '0', gate);
  const positions = GATES.map((gate) => source.indexOf(`${gate} = "0"`));
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
});

test('staging does not inherit or enable production publication gates', async () => {
  const source = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const staging = tableValues(source, 'env.staging.vars');

  for (const gate of GATES) assert.equal(staging.has(gate), false, gate);
});

test('runbook and package scripts enforce bootstrap then cumulative live rollout then follow-up config PR', async () => {
  const [runbook, packageJson] = await Promise.all([
    readFile(new URL('../../docs/operations/2026-08-30-publication-inventory/README.md', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);
  const scripts = packageJson.scripts;
  const expected = {
    'deploy:publication:bootstrap': 'wrangler deploy',
    'deploy:publication:drain': `wrangler deploy ${GATES.map((gate, index) => `--var ${gate}:${index === 0 ? 1 : 0}`).join(' ')}`,
    'deploy:publication:producer': `wrangler deploy ${GATES.map((gate, index) => `--var ${gate}:${index <= 1 ? 1 : 0}`).join(' ')}`,
    'deploy:publication:reservation': `wrangler deploy ${GATES.map((gate, index) => `--var ${gate}:${index <= 2 ? 1 : 0}`).join(' ')}`,
    'deploy:publication:put': `wrangler deploy ${GATES.map((gate, index) => `--var ${gate}:${index <= 3 ? 1 : 0}`).join(' ')}`,
    'deploy:publication:promotion': `wrangler deploy ${GATES.map((gate) => `--var ${gate}:1`).join(' ')}`,
  };
  for (const [name, command] of Object.entries(expected)) {
    assert.equal(scripts[name], command, name);
    assert.match(runbook, new RegExp(`npm --prefix worker run ${name.replaceAll(':', '\\:')}`));
  }
  assert.match(runbook, /Phase 1[^\n]*bootstrap commit/i);
  assert.match(runbook, /Phase 2[^\n]*authoritative activation and cumulative live rollout/i);
  assert.match(runbook, /Phase 3[^\n]*independent follow-up config commit\/PR/i);
  assert.match(runbook, /never edit wrangler\.toml\s+between live rollout\s+steps/i);
  assert.match(runbook, /current bootstrap candidate[^\n]*must keep all five gates at "0"/i);
});
