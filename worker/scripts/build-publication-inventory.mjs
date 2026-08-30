#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const SCHEMA_VERSION = 1;
const NAMESPACE = 'daily-publications-v1';
const BUCKET_NAME = 'xlist-readme-assets';
const PREFIXES = Object.freeze(['daily/', 'daily-video/']);
const ACTIVATION_AUDIT_ID_DOMAIN = 'aifeeds-publication-capacity-activation-request-v1\0';
const SENSITIVE_NAME = /(?:^|[_-])(?:api[_-]?key|token|secret|password|authorization|cookie|credential|private[_-]?key)(?:$|[_-])/i;
const SENSITIVE_VALUE = /(?:\bBearer\s+|\bAKIA[0-9A-Z]{16}\b|\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_]{12,}\b|(?:api[_-]?key|token|secret|password)\s*[=:])/i;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function fail(code, detail = '') {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function hasUnpairedUtf16Surrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertPairedUtf16(value, code = 'INVENTORY_CANONICAL_SURROGATE_INVALID') {
  if (hasUnpairedUtf16Surrogate(value)) fail(code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string') assertPairedUtf16(value);
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail('INVENTORY_CANONICAL_NUMBER_INVALID');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isPlainObject(value)) fail('INVENTORY_CANONICAL_VALUE_INVALID');
  const keys = Object.keys(value);
  keys.forEach((key) => assertPairedUtf16(key));
  keys.sort(byteCompare);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function safeText(value, code, maximumBytes = 256) {
  if (typeof value !== 'string' || value.length === 0 || CONTROL_CHARACTER.test(value)
    || hasUnpairedUtf16Surrogate(value) || Buffer.byteLength(value, 'utf8') > maximumBytes) fail(code);
  return value;
}

function inspectPublicMetadata(value, path = 'metadata', depth = 0) {
  if (depth > 8) fail('INVENTORY_SENSITIVE_METADATA', `${path} exceeds depth limit`);
  if (value === null) return;
  if (typeof value === 'string') {
    if (CONTROL_CHARACTER.test(value) || hasUnpairedUtf16Surrogate(value) || SENSITIVE_VALUE.test(value)) {
      fail('INVENTORY_SENSITIVE_METADATA', path);
    }
    return;
  }
  if (!isPlainObject(value)) fail('INVENTORY_SENSITIVE_METADATA', `${path} is not plain JSON`);
  for (const [key, entry] of Object.entries(value)) {
    if (!key || CONTROL_CHARACTER.test(key) || hasUnpairedUtf16Surrogate(key) || SENSITIVE_NAME.test(key)) {
      fail('INVENTORY_SENSITIVE_METADATA', `${path}.${key}`);
    }
    inspectPublicMetadata(entry, `${path}.${key}`, depth + 1);
  }
}

function metadataField(raw, field) {
  const code = `INVENTORY_OBJECT_${field.toUpperCase()}_INVALID`;
  if (!Object.prototype.hasOwnProperty.call(raw, field)) fail(code);
  const value = raw[field];
  if (value === null) return null;
  if (!isPlainObject(value)) fail(code);
  for (const entry of Object.values(value)) {
    if (typeof entry !== 'string') fail(code);
  }
  inspectPublicMetadata(value, `object.${field}`);
  return value;
}

function normalizeObject(raw, expectedPrefix) {
  if (!isPlainObject(raw)) fail('INVENTORY_OBJECT_INVALID');
  const key = safeText(raw.key, 'INVENTORY_OBJECT_KEY_INVALID', 1024);
  if (!key.startsWith(expectedPrefix) || key.length === expectedPrefix.length
    || key.startsWith('/') || key.includes('\\') || key.includes('?') || key.includes('#')
    || key.split('/').includes('..') || SENSITIVE_VALUE.test(key)) {
    if (SENSITIVE_VALUE.test(key) || key.includes('?') || key.includes('#')) {
      fail('INVENTORY_SENSITIVE_METADATA', 'object.key');
    }
    fail('INVENTORY_OBJECT_PREFIX_INVALID', key);
  }
  const sizeBytes = safeInteger(raw.size, 'INVENTORY_OBJECT_SIZE_INVALID');
  const etag = safeText(raw.etag, 'INVENTORY_OBJECT_ETAG_INVALID', 256);
  const lastModified = safeText(raw.last_modified, 'INVENTORY_OBJECT_LAST_MODIFIED_INVALID', 64);
  const storageClass = safeText(raw.storage_class, 'INVENTORY_OBJECT_STORAGE_CLASS_INVALID', 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(lastModified)
    || Number.isNaN(Date.parse(lastModified))) fail('INVENTORY_OBJECT_LAST_MODIFIED_INVALID');

  const httpMetadata = metadataField(raw, 'http_metadata');
  const customMetadata = metadataField(raw, 'custom_metadata');
  inspectPublicMetadata({
    key,
    etag,
    last_modified: lastModified,
    storage_class: storageClass,
    http_metadata: httpMetadata,
    custom_metadata: customMetadata,
  }, 'object');

  return {
    prefix: expectedPrefix,
    key,
    size_bytes: sizeBytes,
    etag,
    last_modified: lastModified,
    storage_class: storageClass,
  };
}

function normalizeResponse(raw, expectedPrefix) {
  if (!isPlainObject(raw)) fail('INVENTORY_API_RESPONSE_INVALID', expectedPrefix);
  if (raw.success !== true) fail('INVENTORY_API_UNSUCCESSFUL', expectedPrefix);
  if (!Array.isArray(raw.errors) || raw.errors.length !== 0) {
    fail('INVENTORY_API_ERRORS_PRESENT', expectedPrefix);
  }
  if (!Array.isArray(raw.result)) fail('INVENTORY_API_RESULT_INVALID', expectedPrefix);
  const resultInfo = raw.result_info;
  if (resultInfo !== undefined && resultInfo !== null) {
    if (!isPlainObject(resultInfo)) fail('INVENTORY_API_RESULT_INFO_INVALID', expectedPrefix);
    if (resultInfo.is_truncated === true || resultInfo.has_more === true
      || (typeof resultInfo.cursor === 'string' && resultInfo.cursor.length > 0)) {
      fail('INVENTORY_API_TRUNCATED', expectedPrefix);
    }
  }
  return raw.result.map((entry) => normalizeObject(entry, expectedPrefix));
}

function validateActivationText(value, field) {
  const text = safeText(value, `INVENTORY_${field.toUpperCase()}_INVALID`, 256);
  if (SENSITIVE_VALUE.test(text)) fail('INVENTORY_SENSITIVE_METADATA', `activation.${field}`);
  return text;
}

function activationAuditIdentity(input) {
  const old = input.old_budget_snapshot;
  return JSON.stringify([
    1,
    input.legacy_baseline_bytes,
    input.inventory_digest,
    input.inventory_object_count,
    input.inventory_at_ms,
    input.actor,
    input.reason,
    input.ticket_ref,
    input.now_ms,
    [
      old.singleton_id,
      old.namespace,
      old.budget_bytes,
      old.legacy_baseline_bytes,
      old.reserved_bytes,
      old.version,
      old.state,
      old.legacy_inventory_digest,
      old.legacy_inventory_object_count,
      old.legacy_inventory_at_ms,
      old.updated_at_ms,
    ],
  ]);
}

export function derivePublicationCapacityActivationAuditId(input) {
  if (!isPlainObject(input) || !isPlainObject(input.old_budget_snapshot)) {
    fail('INVENTORY_ACTIVATION_IDENTITY_INVALID');
  }
  return sha256(`${ACTIVATION_AUDIT_ID_DOMAIN}${activationAuditIdentity(input)}`);
}

function validateAuthoritativeSnapshot(snapshot) {
  if (snapshot === undefined) return null;
  if (!isPlainObject(snapshot)) fail('INVENTORY_BUDGET_SNAPSHOT_INVALID');
  const exactKeys = [
    'budget_bytes',
    'legacy_baseline_bytes',
    'legacy_inventory_at_ms',
    'legacy_inventory_digest',
    'legacy_inventory_object_count',
    'namespace',
    'reserved_bytes',
    'singleton_id',
    'state',
    'updated_at_ms',
    'version',
  ].sort(byteCompare);
  if (byteCompare(Object.keys(snapshot).sort(byteCompare).join('\0'), exactKeys.join('\0')) !== 0) {
    fail('INVENTORY_BUDGET_SNAPSHOT_INVALID');
  }
  if (snapshot.singleton_id !== 1 || snapshot.namespace !== NAMESPACE
    || snapshot.state !== 'uninitialized' || snapshot.version !== 0
    || snapshot.legacy_baseline_bytes !== 0 || snapshot.reserved_bytes !== 0
    || snapshot.legacy_inventory_digest !== null
    || snapshot.legacy_inventory_object_count !== null
    || snapshot.legacy_inventory_at_ms !== null) fail('INVENTORY_BUDGET_SNAPSHOT_NOT_ACTIVATABLE');
  safeInteger(snapshot.budget_bytes, 'INVENTORY_BUDGET_SNAPSHOT_INVALID');
  safeInteger(snapshot.updated_at_ms, 'INVENTORY_BUDGET_SNAPSHOT_INVALID');
  return { ...snapshot };
}

export function buildInventoryArtifacts({
  dailyResponse,
  dailyVideoResponse,
  inventoryAtMs,
  operator,
  commandVersion,
  activation,
  authoritativeBudgetSnapshot,
}) {
  const inventoryAt = safeInteger(inventoryAtMs, 'INVENTORY_AT_MS_INVALID');
  const inventoryOperator = safeText(operator, 'INVENTORY_OPERATOR_INVALID', 256);
  const inventoryCommandVersion = safeText(commandVersion, 'INVENTORY_COMMAND_VERSION_INVALID', 256);
  if (!isPlainObject(activation)) fail('INVENTORY_ACTIVATION_INVALID');
  if (Object.prototype.hasOwnProperty.call(activation, 'audit_id')) {
    fail('INVENTORY_AUDIT_ID_MUST_BE_DERIVED');
  }
  const activationInputText = {
    actor: validateActivationText(activation.actor, 'actor'),
    reason: validateActivationText(activation.reason, 'reason'),
    ticket_ref: validateActivationText(activation.ticket_ref, 'ticket_ref'),
  };
  const nowMs = safeInteger(activation.now_ms, 'INVENTORY_NOW_MS_INVALID');
  const oldSnapshot = validateAuthoritativeSnapshot(authoritativeBudgetSnapshot);

  const objects = [
    ...normalizeResponse(dailyResponse, PREFIXES[0]),
    ...normalizeResponse(dailyVideoResponse, PREFIXES[1]),
  ].sort((left, right) => byteCompare(left.key, right.key));
  for (let index = 1; index < objects.length; index += 1) {
    if (objects[index - 1].key === objects[index].key) fail('INVENTORY_DUPLICATE_KEY', objects[index].key);
  }
  let totalSizeBytes = 0;
  for (const entry of objects) {
    totalSizeBytes += entry.size_bytes;
    if (!Number.isSafeInteger(totalSizeBytes)) fail('INVENTORY_TOTAL_SIZE_INVALID');
  }

  const objectSet = {
    schema_version: SCHEMA_VERSION,
    namespace: NAMESPACE,
    bucket_name: BUCKET_NAME,
    prefixes: [...PREFIXES],
    objects,
  };
  // Canonical artifacts are POSIX text documents. The terminal LF is part of
  // the hashed byte contract and matches the sealed 2026-08-30 two-scan proof.
  const objectSetCanonical = `${canonicalJson(objectSet)}\n`;
  const objectSetSha256 = sha256(objectSetCanonical);
  const manifest = {
    schema_version: SCHEMA_VERSION,
    namespace: NAMESPACE,
    bucket_name: BUCKET_NAME,
    prefixes: [...PREFIXES],
    inventory_at_ms: inventoryAt,
    operator: inventoryOperator,
    command_version: inventoryCommandVersion,
    object_count: objects.length,
    total_size_bytes: totalSizeBytes,
    objects,
  };
  const manifestCanonical = `${canonicalJson(manifest)}\n`;
  const manifestSha256 = sha256(manifestCanonical);
  const envelope = {
    schema_version: SCHEMA_VERSION,
    kind: 'r2-publication-inventory-envelope',
    canonicalization: 'utf8-json-recursive-bytewise-key-sort-v1',
    object_set_sha256: objectSetSha256,
    manifest_sha256: manifestSha256,
    manifest,
  };
  const immutableActivationInput = {
    legacy_baseline_bytes: totalSizeBytes,
    inventory_digest: manifestSha256,
    inventory_object_count: objects.length,
    inventory_at_ms: inventoryAt,
    actor: activationInputText.actor,
    reason: activationInputText.reason,
    ticket_ref: activationInputText.ticket_ref,
    now_ms: nowMs,
    old_budget_snapshot: oldSnapshot,
  };
  const activationCommand = {
    schema_version: SCHEMA_VERSION,
    kind: 'publication-capacity-budget-activation-command',
    execution: 'disabled',
    invoke: 'activatePublicationCapacityBudget',
    precondition_status: oldSnapshot === null ? 'authoritative_read_required' : 'captured',
    required_authoritative_budget_snapshot: oldSnapshot,
    input: {
      audit_id: oldSnapshot === null
        ? null
        : derivePublicationCapacityActivationAuditId(immutableActivationInput),
      ...immutableActivationInput,
    },
  };

  return {
    objectSet,
    objectSetCanonical,
    objectSetSha256,
    manifest,
    manifestCanonical,
    manifestSha256,
    envelope,
    activationCommand,
  };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) fail('INVENTORY_CLI_ARGUMENT_INVALID');
    if (values.has(key)) fail('INVENTORY_CLI_ARGUMENT_DUPLICATE', key);
    values.set(key, value);
  }
  const required = [
    '--daily', '--daily-video', '--inventory-at-ms', '--operator', '--command-version',
    '--actor', '--reason', '--ticket-ref', '--now-ms', '--out-dir',
  ];
  for (const name of required) if (!values.has(name)) fail('INVENTORY_CLI_ARGUMENT_MISSING', name);
  const allowed = new Set([
    ...required,
    '--budget-snapshot',
    '--expected-object-set-sha256',
    '--verify-daily',
    '--verify-daily-video',
  ]);
  for (const name of values.keys()) if (!allowed.has(name)) fail('INVENTORY_CLI_ARGUMENT_UNKNOWN', name);
  if (values.has('--verify-daily') !== values.has('--verify-daily-video')) {
    fail('INVENTORY_CLI_EQUIVALENCE_PAIR_REQUIRED');
  }
  return values;
}

async function writeExclusive(path, value) {
  await writeFile(path, value, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
}

export async function runCli(argv) {
  const args = parseArgs(argv);
  const [
    dailyResponse,
    dailyVideoResponse,
    authoritativeBudgetSnapshot,
    verifyDailyResponse,
    verifyDailyVideoResponse,
  ] = await Promise.all([
    readFile(args.get('--daily'), 'utf8').then(JSON.parse),
    readFile(args.get('--daily-video'), 'utf8').then(JSON.parse),
    args.has('--budget-snapshot')
      ? readFile(args.get('--budget-snapshot'), 'utf8').then(JSON.parse)
      : Promise.resolve(undefined),
    args.has('--verify-daily')
      ? readFile(args.get('--verify-daily'), 'utf8').then(JSON.parse)
      : Promise.resolve(undefined),
    args.has('--verify-daily-video')
      ? readFile(args.get('--verify-daily-video'), 'utf8').then(JSON.parse)
      : Promise.resolve(undefined),
  ]);
  const buildInput = {
    dailyResponse,
    dailyVideoResponse,
    inventoryAtMs: Number(args.get('--inventory-at-ms')),
    operator: args.get('--operator'),
    commandVersion: args.get('--command-version'),
    activation: {
      actor: args.get('--actor'),
      reason: args.get('--reason'),
      ticket_ref: args.get('--ticket-ref'),
      now_ms: Number(args.get('--now-ms')),
    },
    authoritativeBudgetSnapshot,
  };
  const built = buildInventoryArtifacts(buildInput);
  const expectedObjectSetSha256 = args.get('--expected-object-set-sha256');
  if (expectedObjectSetSha256 !== undefined && expectedObjectSetSha256 !== built.objectSetSha256) {
    fail('INVENTORY_OBJECT_SET_DIGEST_MISMATCH');
  }
  let equivalenceWitness;
  if (verifyDailyResponse !== undefined && verifyDailyVideoResponse !== undefined) {
    const verified = buildInventoryArtifacts({
      ...buildInput,
      dailyResponse: verifyDailyResponse,
      dailyVideoResponse: verifyDailyVideoResponse,
    });
    if (verified.objectSetCanonical !== built.objectSetCanonical
      || verified.objectSetSha256 !== built.objectSetSha256
      || verified.manifestCanonical !== built.manifestCanonical
      || verified.manifestSha256 !== built.manifestSha256) {
      fail('INVENTORY_EQUIVALENCE_MISMATCH');
    }
    equivalenceWitness = {
      schema_version: SCHEMA_VERSION,
      kind: 'independent-second-read',
      canonical_bytes_equal: true,
      object_set_sha256: verified.objectSetSha256,
    };
  }
  const outDir = resolve(args.get('--out-dir'));
  await mkdir(outDir, { recursive: false, mode: 0o755 });
  await Promise.all([
    writeExclusive(resolve(outDir, 'object-set.canonical.json'), built.objectSetCanonical),
    writeExclusive(resolve(outDir, 'inventory-manifest.canonical.json'), built.manifestCanonical),
    writeExclusive(resolve(outDir, 'inventory-envelope.json'), `${JSON.stringify({
      ...built.envelope,
      ...(equivalenceWitness ? { equivalence_witness: equivalenceWitness } : {}),
    }, null, 2)}\n`),
    writeExclusive(resolve(outDir, 'activation-command.json'), `${JSON.stringify(built.activationCommand, null, 2)}\n`),
  ]);
  return built;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  runCli(process.argv.slice(2)).then((built) => {
    process.stdout.write(`${JSON.stringify({
      object_count: built.manifest.object_count,
      total_size_bytes: built.manifest.total_size_bytes,
      object_set_sha256: built.objectSetSha256,
      manifest_sha256: built.manifestSha256,
      activation_precondition_status: built.activationCommand.precondition_status,
    })}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
