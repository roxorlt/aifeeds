import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const artifactRoot = new URL(
  '../../docs/operations/2026-08-30-publication-inventory/',
  import.meta.url,
);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('the sealed 2026-08-30 inventory preserves the independently observed totals and object set', async () => {
  const [objectSetCanonical, manifestCanonical, envelopeText] = await Promise.all([
    readFile(new URL('object-set.canonical.json', artifactRoot), 'utf8'),
    readFile(new URL('inventory-manifest.canonical.json', artifactRoot), 'utf8'),
    readFile(new URL('inventory-envelope.json', artifactRoot), 'utf8'),
  ]);
  const envelope = JSON.parse(envelopeText);
  const manifest = JSON.parse(manifestCanonical);

  assert.equal(sha256(objectSetCanonical), '8e673930948cabb60720d6f7708294f6c1d4f5724d4d36f11130db5773fb3191');
  assert.equal(sha256(manifestCanonical), '5e9ca8c182f7109abc7093f5706d34c118024b21fe1f005eed0f91eb02f1cdee');
  assert.equal(envelope.object_set_sha256, sha256(objectSetCanonical));
  assert.equal(envelope.manifest_sha256, sha256(manifestCanonical));
  assert.deepEqual(envelope.manifest, manifest);
  assert.equal(manifest.object_count, 298);
  assert.equal(manifest.total_size_bytes, 740_834_456);
  assert.equal(manifest.inventory_at_ms, 1_788_056_520_000);
  assert.equal(manifest.objects.filter(({ prefix }) => prefix === 'daily/').length, 88);
  assert.equal(manifest.objects.filter(({ prefix }) => prefix === 'daily-video/').length, 210);
});

test('the sealed envelope records canonical equivalence of fresh reads A and B', async () => {
  const envelope = JSON.parse(await readFile(new URL('inventory-envelope.json', artifactRoot), 'utf8'));

  assert.deepEqual(envelope.equivalence_witness, {
    schema_version: 1,
    kind: 'independent-second-read',
    canonical_bytes_equal: true,
    object_set_sha256: '8e673930948cabb60720d6f7708294f6c1d4f5724d4d36f11130db5773fb3191',
  });
});

test('the archived activation command is fail-closed and matches the sealed manifest', async () => {
  const [manifestText, commandText] = await Promise.all([
    readFile(new URL('inventory-manifest.canonical.json', artifactRoot), 'utf8'),
    readFile(new URL('activation-command.json', artifactRoot), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText);
  const command = JSON.parse(commandText);

  assert.equal(command.execution, 'disabled');
  assert.equal(command.precondition_status, 'authoritative_read_required');
  assert.equal(command.required_authoritative_budget_snapshot, null);
  assert.equal(command.invoke, 'activatePublicationCapacityBudget');
  assert.equal(command.input.inventory_digest, sha256(manifestText));
  assert.equal(command.input.inventory_object_count, manifest.object_count);
  assert.equal(command.input.legacy_baseline_bytes, manifest.total_size_bytes);
  assert.equal(command.input.inventory_at_ms, manifest.inventory_at_ms);
  assert.equal(command.input.audit_id, null);
  assert.equal(command.input.old_budget_snapshot, null);
  assert.equal('sql' in command, false);
  assert.equal('batch' in command, false);
});
