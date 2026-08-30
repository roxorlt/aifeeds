import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildInventoryArtifacts,
  canonicalJson,
  derivePublicationCapacityActivationAuditId,
  runCli,
} from './build-publication-inventory.mjs';

const BASE_OPTIONS = Object.freeze({
  inventoryAtMs: 1_788_055_407_000,
  operator: 'codex-aifeeds-publication-recovery',
  commandVersion: 'aifeeds-r2-inventory-v1',
  activation: {
    actor: 'codex-aifeeds-publication-recovery',
    reason: 'Activate the audited legacy R2 publication baseline.',
    ticket_ref: 'AI-FEEDS-2026-08-30',
    now_ms: 1_788_055_407_000,
  },
  authoritativeBudgetSnapshot: {
    singleton_id: 1,
    namespace: 'daily-publications-v1',
    budget_bytes: 3_298_534_883_328,
    legacy_baseline_bytes: 0,
    reserved_bytes: 0,
    version: 0,
    state: 'uninitialized',
    legacy_inventory_digest: null,
    legacy_inventory_object_count: null,
    legacy_inventory_at_ms: null,
    updated_at_ms: 0,
  },
});

function object(key, size = 7, overrides = {}) {
  return {
    key,
    etag: createHash('md5').update(key).digest('hex'),
    last_modified: '2026-08-30T02:03:27.000Z',
    size,
    http_metadata: { contentType: 'application/octet-stream' },
    custom_metadata: {},
    storage_class: 'Standard',
    ...overrides,
  };
}

function response(result, overrides = {}) {
  return {
    success: true,
    errors: [],
    messages: [],
    result,
    ...overrides,
  };
}

function build(daily, video, options = {}) {
  return buildInventoryArtifacts({
    dailyResponse: response(daily),
    dailyVideoResponse: response(video),
    ...BASE_OPTIONS,
    ...options,
  });
}

test('canonicalJson sorts object properties by UTF-8 bytes and emits no whitespace', () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: true, b: null }, list: [2, '中'] }),
    '{"a":{"b":null,"y":true},"list":[2,"中"],"z":1}',
  );
  assert.equal(canonicalJson({ '\u{10000}': 2, '\uE000': 1 }), '{"":1,"𐀀":2}');
});

test('canonicalJson rejects every unpaired UTF-16 surrogate before sorting or hashing', () => {
  for (const malformed of ['\uD800', '\uDC00', `left\uD800right`, `left\uDC00right`]) {
    assert.throws(() => canonicalJson(malformed), /INVENTORY_CANONICAL_SURROGATE_INVALID/);
    assert.throws(
      () => canonicalJson({ [malformed]: 'value' }),
      /INVENTORY_CANONICAL_SURROGATE_INVALID/,
    );
  }
  assert.equal(canonicalJson('paired-\u{10000}'), '"paired-𐀀"');
});

test('builds a byte-stable manifest and object-set digest despite response ordering', () => {
  const daily = [object('daily/2026-08-30.html', 11), object('daily/2026-08-29.html', 5)];
  const video = [
    object('daily-video/2026-08-30/z.mp4', 13),
    object('daily-video/2026-08-30/a.vtt', 3),
  ];
  const first = build(daily, video);
  const second = build([...daily].reverse(), [...video].reverse());

  assert.equal(first.manifestCanonical, second.manifestCanonical);
  assert.equal(first.manifestCanonical.endsWith('\n'), true);
  assert.equal(first.objectSetCanonical.endsWith('\n'), true);
  assert.equal(first.manifestSha256, second.manifestSha256);
  assert.equal(first.objectSetSha256, second.objectSetSha256);
  assert.deepEqual(first.manifest.objects.map(({ key }) => key), [
    'daily-video/2026-08-30/a.vtt',
    'daily-video/2026-08-30/z.mp4',
    'daily/2026-08-29.html',
    'daily/2026-08-30.html',
  ]);
  assert.equal(first.manifest.object_count, 4);
  assert.equal(first.manifest.total_size_bytes, 32);
  assert.match(first.manifestSha256, /^[0-9a-f]{64}$/);
  assert.match(first.objectSetSha256, /^[0-9a-f]{64}$/);
});

test('valid Unicode object keys remain byte-stable when both responses are reversed', () => {
  const daily = [object('daily/\u{10000}.html'), object('daily/\uE000.html')];
  const video = [object('daily-video/\u{10000}.mp4'), object('daily-video/\uE000.vtt')];
  const forward = build(daily, video);
  const reversed = build([...daily].reverse(), [...video].reverse());

  assert.equal(forward.objectSetCanonical, reversed.objectSetCanonical);
  assert.equal(forward.objectSetSha256, reversed.objectSetSha256);
  assert.equal(forward.manifestCanonical, reversed.manifestCanonical);
  assert.equal(forward.manifestSha256, reversed.manifestSha256);
});

test('the activation input exactly matches the Worker helper contract and manifest baseline', () => {
  const built = build([object('daily/2026-08-30.html', 11)], [object('daily-video/2026-08-30/a.mp4', 13)]);

  assert.deepEqual(Object.keys(built.activationCommand.input).sort(), [
    'actor',
    'audit_id',
    'inventory_at_ms',
    'inventory_digest',
    'inventory_object_count',
    'legacy_baseline_bytes',
    'now_ms',
    'old_budget_snapshot',
    'reason',
    'ticket_ref',
  ]);
  assert.equal(built.activationCommand.input.legacy_baseline_bytes, built.manifest.total_size_bytes);
  assert.equal(built.activationCommand.input.inventory_object_count, built.manifest.object_count);
  assert.equal(built.activationCommand.input.inventory_at_ms, built.manifest.inventory_at_ms);
  assert.equal(built.activationCommand.input.inventory_digest, built.manifestSha256);
  assert.deepEqual(
    built.activationCommand.input.old_budget_snapshot,
    BASE_OPTIONS.authoritativeBudgetSnapshot,
  );
  const { audit_id: auditId, ...immutableInput } = built.activationCommand.input;
  assert.equal(auditId, derivePublicationCapacityActivationAuditId(immutableInput));
  assert.equal(built.activationCommand.execution, 'disabled');
  assert.equal(built.activationCommand.invoke, 'activatePublicationCapacityBudget');
  assert.deepEqual(built.activationCommand.required_authoritative_budget_snapshot, {
    singleton_id: 1,
    namespace: 'daily-publications-v1',
    budget_bytes: 3_298_534_883_328,
    state: 'uninitialized',
    version: 0,
    legacy_baseline_bytes: 0,
    reserved_bytes: 0,
    legacy_inventory_digest: null,
    legacy_inventory_object_count: null,
    legacy_inventory_at_ms: null,
    updated_at_ms: 0,
  });
  assert.equal(built.activationCommand.precondition_status, 'captured');
  assert.equal('sql' in built.activationCommand, false);
  assert.equal('batch' in built.activationCommand, false);
  assert.equal(JSON.stringify(built.activationCommand).match(/secret|token/i), null);
});

test('builder derives a deterministic domain-separated request ID from the complete immutable input', () => {
  const activation = { ...BASE_OPTIONS.activation };
  const first = build(
    [object('daily/2026-08-30.html', 11)],
    [object('daily-video/2026-08-30/a.mp4', 13)],
    { activation },
  );
  const repeated = build(
    [object('daily/2026-08-30.html', 11)],
    [object('daily-video/2026-08-30/a.mp4', 13)],
    { activation },
  );
  const updatedAtDrift = build(
    [object('daily/2026-08-30.html', 11)],
    [object('daily-video/2026-08-30/a.mp4', 13)],
    {
      activation,
      authoritativeBudgetSnapshot: {
        ...BASE_OPTIONS.authoritativeBudgetSnapshot,
        updated_at_ms: BASE_OPTIONS.authoritativeBudgetSnapshot.updated_at_ms + 1,
      },
    },
  );

  assert.match(first.activationCommand.input.audit_id, /^[0-9a-f]{64}$/);
  assert.equal(first.activationCommand.input.audit_id, repeated.activationCommand.input.audit_id);
  assert.notEqual(first.activationCommand.input.audit_id, updatedAtDrift.activationCommand.input.audit_id);
  assert.equal(derivePublicationCapacityActivationAuditId({
    legacy_baseline_bytes: 1_000,
    inventory_digest: 'a'.repeat(64),
    inventory_object_count: 3,
    inventory_at_ms: 10,
    actor: 'test-operator',
    reason: 'audited fixture',
    ticket_ref: 'TEST-42',
    now_ms: 10,
    old_budget_snapshot: {
      singleton_id: 1,
      namespace: 'daily-publications-v1',
      budget_bytes: 10_000,
      legacy_baseline_bytes: 0,
      reserved_bytes: 0,
      version: 0,
      state: 'uninitialized',
      legacy_inventory_digest: null,
      legacy_inventory_object_count: null,
      legacy_inventory_at_ms: null,
      updated_at_ms: 0,
    },
  }), 'a3b98a025115034292fce1077e3957eb5f8bad7bbb5fcfdebb0eaa28a88f7aa6');
});

test('blocks the command until an exact authoritative old snapshot is supplied', () => {
  const built = build(
    [object('daily/2026-08-30.html', 11)],
    [object('daily-video/2026-08-30/a.mp4', 13)],
    { authoritativeBudgetSnapshot: undefined },
  );

  assert.equal(built.activationCommand.execution, 'disabled');
  assert.equal(built.activationCommand.precondition_status, 'authoritative_read_required');
  assert.equal(built.activationCommand.input.audit_id, null);
  assert.equal(built.activationCommand.required_authoritative_budget_snapshot, null);
  assert.equal(built.activationCommand.input.old_budget_snapshot, null);
});

test('rejects duplicate keys across prefixes', () => {
  const duplicated = object('daily/2026-08-30.html');
  assert.throws(
    () => build([duplicated, { ...duplicated }], []),
    /INVENTORY_DUPLICATE_KEY/,
  );
});

for (const field of ['key', 'size', 'etag', 'last_modified', 'storage_class']) {
  test(`rejects a missing required object field: ${field}`, () => {
    const invalid = object('daily/2026-08-30.html');
    delete invalid[field];
    assert.throws(() => build([invalid], []), new RegExp(`INVENTORY_OBJECT_${field.toUpperCase()}_INVALID`));
  });
}

test('requires both metadata fields, accepts explicit null, and rejects invalid metadata types', () => {
  for (const field of ['http_metadata', 'custom_metadata']) {
    const missing = object(`daily/missing-${field}.html`);
    delete missing[field];
    assert.throws(
      () => build([missing], []),
      new RegExp(`INVENTORY_OBJECT_${field.toUpperCase()}_INVALID`),
    );

    for (const invalid of [true, 7, 'metadata', [], { nested: [] }]) {
      assert.throws(
        () => build([object(`daily/invalid-${field}.html`, 1, { [field]: invalid })], []),
        new RegExp(`INVENTORY_OBJECT_${field.toUpperCase()}_INVALID|INVENTORY_SENSITIVE_METADATA`),
      );
    }
  }

  assert.doesNotThrow(() => build([
    object('daily/explicit-null.html', 1, { http_metadata: null, custom_metadata: null }),
  ], []));
});

test('rejects an object outside the response-specific prefix', () => {
  assert.throws(
    () => build([object('daily-video/2026-08-30/a.mp4')], []),
    /INVENTORY_OBJECT_PREFIX_INVALID/,
  );
  assert.throws(
    () => build([], [object('daily/2026-08-30.html')]),
    /INVENTORY_OBJECT_PREFIX_INVALID/,
  );
});

test('rejects unsuccessful, errored, or truncated API responses', () => {
  assert.throws(
    () => buildInventoryArtifacts({
      dailyResponse: response([], { success: false }),
      dailyVideoResponse: response([]),
      ...BASE_OPTIONS,
    }),
    /INVENTORY_API_UNSUCCESSFUL/,
  );
  assert.throws(
    () => buildInventoryArtifacts({
      dailyResponse: response([], { errors: [{ code: 1, message: 'no' }] }),
      dailyVideoResponse: response([]),
      ...BASE_OPTIONS,
    }),
    /INVENTORY_API_ERRORS_PRESENT/,
  );
  assert.throws(
    () => buildInventoryArtifacts({
      dailyResponse: response([], { result_info: { is_truncated: true, cursor: 'next' } }),
      dailyVideoResponse: response([]),
      ...BASE_OPTIONS,
    }),
    /INVENTORY_API_TRUNCATED/,
  );
});

for (const invalidSize of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '7']) {
  test(`rejects invalid object size ${String(invalidSize)}`, () => {
    assert.throws(
      () => build([object('daily/2026-08-30.html', invalidSize)], []),
      /INVENTORY_OBJECT_SIZE_INVALID/,
    );
  });
}

test('rejects total byte overflow even when individual sizes are safe', () => {
  assert.throws(
    () => build([
      object('daily/a', Number.MAX_SAFE_INTEGER),
      object('daily/b', 1),
    ], []),
    /INVENTORY_TOTAL_SIZE_INVALID/,
  );
});

test('rejects key or metadata that may expose credentials', () => {
  assert.throws(
    () => build([object('daily/export?token=abc')], []),
    /INVENTORY_SENSITIVE_METADATA/,
  );
  assert.throws(
    () => build([object('daily/safe.html', 1, {
      custom_metadata: { api_key: 'not-for-public-artifact' },
    })], []),
    /INVENTORY_SENSITIVE_METADATA/,
  );
});

test('rejects non-deterministic or incomplete manifest and audit parameters', () => {
  assert.throws(() => build([], [], { inventoryAtMs: -1 }), /INVENTORY_AT_MS_INVALID/);
  assert.throws(() => build([], [], { operator: '' }), /INVENTORY_OPERATOR_INVALID/);
  assert.throws(() => build([], [], { commandVersion: '' }), /INVENTORY_COMMAND_VERSION_INVALID/);
  assert.throws(() => build([], [], { activation: { ...BASE_OPTIONS.activation, actor: '' } }), /INVENTORY_ACTOR_INVALID/);
  assert.throws(() => build([], [], { activation: { ...BASE_OPTIONS.activation, audit_id: 'operator-supplied' } }), /INVENTORY_AUDIT_ID_MUST_BE_DERIVED/);
});

test('CLI writes a sealed non-executable packet only after the expected object-set digest matches', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'aifeeds-inventory-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dailyPath = join(root, 'daily.json');
  const videoPath = join(root, 'video.json');
  const outDir = join(root, 'packet');
  const dailyResponse = response([object('daily/2026-08-30.html', 11)]);
  const dailyVideoResponse = response([object('daily-video/2026-08-30/a.mp4', 13)]);
  await Promise.all([
    writeFile(dailyPath, JSON.stringify(dailyResponse)),
    writeFile(videoPath, JSON.stringify(dailyVideoResponse)),
  ]);
  const expected = buildInventoryArtifacts({
    dailyResponse,
    dailyVideoResponse,
    ...BASE_OPTIONS,
    authoritativeBudgetSnapshot: undefined,
  });

  await runCli([
    '--daily', dailyPath,
    '--daily-video', videoPath,
    '--inventory-at-ms', String(BASE_OPTIONS.inventoryAtMs),
    '--operator', BASE_OPTIONS.operator,
    '--command-version', BASE_OPTIONS.commandVersion,
    '--actor', BASE_OPTIONS.activation.actor,
    '--reason', BASE_OPTIONS.activation.reason,
    '--ticket-ref', BASE_OPTIONS.activation.ticket_ref,
    '--now-ms', String(BASE_OPTIONS.activation.now_ms),
    '--expected-object-set-sha256', expected.objectSetSha256,
    '--out-dir', outDir,
  ]);

  const [manifest, command] = await Promise.all([
    readFile(join(outDir, 'inventory-manifest.canonical.json'), 'utf8').then(JSON.parse),
    readFile(join(outDir, 'activation-command.json'), 'utf8').then(JSON.parse),
  ]);
  assert.equal(manifest.object_count, 2);
  assert.equal(manifest.total_size_bytes, 24);
  assert.equal(command.execution, 'disabled');
  assert.equal(command.precondition_status, 'authoritative_read_required');
});

test('CLI digest mismatch fails before creating an output directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'aifeeds-inventory-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dailyPath = join(root, 'daily.json');
  const videoPath = join(root, 'video.json');
  const outDir = join(root, 'packet');
  await Promise.all([
    writeFile(dailyPath, JSON.stringify(response([object('daily/2026-08-30.html')]))),
    writeFile(videoPath, JSON.stringify(response([object('daily-video/2026-08-30/a.mp4')]))),
  ]);

  await assert.rejects(
    runCli([
      '--daily', dailyPath,
      '--daily-video', videoPath,
      '--inventory-at-ms', String(BASE_OPTIONS.inventoryAtMs),
      '--operator', BASE_OPTIONS.operator,
      '--command-version', BASE_OPTIONS.commandVersion,
      '--actor', BASE_OPTIONS.activation.actor,
      '--reason', BASE_OPTIONS.activation.reason,
      '--ticket-ref', BASE_OPTIONS.activation.ticket_ref,
      '--now-ms', String(BASE_OPTIONS.activation.now_ms),
      '--expected-object-set-sha256', '0'.repeat(64),
      '--out-dir', outDir,
    ]),
    /INVENTORY_OBJECT_SET_DIGEST_MISMATCH/,
  );
  await assert.rejects(readFile(outDir), /ENOENT/);
});

test('CLI seals an independent second-read canonical equivalence witness', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'aifeeds-inventory-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dailyPath = join(root, 'daily-a.json');
  const videoPath = join(root, 'video-a.json');
  const verifyDailyPath = join(root, 'daily-b.json');
  const verifyVideoPath = join(root, 'video-b.json');
  const outDir = join(root, 'packet');
  const daily = [object('daily/b.html', 4), object('daily/a.html', 3)];
  const video = [object('daily-video/b.mp4', 6), object('daily-video/a.vtt', 2)];
  await Promise.all([
    writeFile(dailyPath, JSON.stringify(response(daily))),
    writeFile(videoPath, JSON.stringify(response(video))),
    writeFile(verifyDailyPath, JSON.stringify(response([...daily].reverse()))),
    writeFile(verifyVideoPath, JSON.stringify(response([...video].reverse()))),
  ]);
  const expected = build(daily, video, { authoritativeBudgetSnapshot: undefined });

  await runCli([
    '--daily', dailyPath,
    '--daily-video', videoPath,
    '--verify-daily', verifyDailyPath,
    '--verify-daily-video', verifyVideoPath,
    '--inventory-at-ms', String(BASE_OPTIONS.inventoryAtMs),
    '--operator', BASE_OPTIONS.operator,
    '--command-version', BASE_OPTIONS.commandVersion,
    '--actor', BASE_OPTIONS.activation.actor,
    '--reason', BASE_OPTIONS.activation.reason,
    '--ticket-ref', BASE_OPTIONS.activation.ticket_ref,
    '--now-ms', String(BASE_OPTIONS.activation.now_ms),
    '--expected-object-set-sha256', expected.objectSetSha256,
    '--out-dir', outDir,
  ]);

  const envelope = JSON.parse(await readFile(join(outDir, 'inventory-envelope.json'), 'utf8'));
  assert.deepEqual(envelope.equivalence_witness, {
    schema_version: 1,
    kind: 'independent-second-read',
    canonical_bytes_equal: true,
    object_set_sha256: expected.objectSetSha256,
  });
});

test('CLI rejects a second read with any object drift before writing output', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'aifeeds-inventory-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = ['daily-a.json', 'video-a.json', 'daily-b.json', 'video-b.json'].map((name) => join(root, name));
  await Promise.all([
    writeFile(paths[0], JSON.stringify(response([object('daily/a.html', 3)]))),
    writeFile(paths[1], JSON.stringify(response([object('daily-video/a.mp4', 6)]))),
    writeFile(paths[2], JSON.stringify(response([object('daily/a.html', 4)]))),
    writeFile(paths[3], JSON.stringify(response([object('daily-video/a.mp4', 6)]))),
  ]);
  const outDir = join(root, 'packet');

  await assert.rejects(runCli([
    '--daily', paths[0],
    '--daily-video', paths[1],
    '--verify-daily', paths[2],
    '--verify-daily-video', paths[3],
    '--inventory-at-ms', String(BASE_OPTIONS.inventoryAtMs),
    '--operator', BASE_OPTIONS.operator,
    '--command-version', BASE_OPTIONS.commandVersion,
    '--actor', BASE_OPTIONS.activation.actor,
    '--reason', BASE_OPTIONS.activation.reason,
    '--ticket-ref', BASE_OPTIONS.activation.ticket_ref,
    '--now-ms', String(BASE_OPTIONS.activation.now_ms),
    '--out-dir', outDir,
  ]), /INVENTORY_EQUIVALENCE_MISMATCH/);
  await assert.rejects(readFile(outDir), /ENOENT/);
});
