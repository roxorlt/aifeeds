import type { Env } from '../index';
import {
  activatePublicationCapacityBudget,
  type ActivatePublicationCapacityBudgetInput,
} from './publication-capacity-outbox';

export const PUBLICATION_CAPACITY_ACTIVATION_PATH = '/api/ops/publication-capacity/activate';
export const PUBLICATION_CAPACITY_ACTIVATION_BODY_MAX_BYTES = 16 * 1024;

const ENVELOPE_KEYS = ['action', 'input', 'schema_version'] as const;
const INPUT_KEYS = [
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
] as const;
const SNAPSHOT_KEYS = [
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
] as const;

class RequestFailure extends Error {
  constructor(
    readonly status: number,
    readonly responseCode: string,
  ) {
    super(responseCode);
  }
}

function response(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function authorized(request: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  const authorization = request.headers.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ')) return false;
  return constantTimeEqual(authorization.slice(7), expected);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function hasStrictInputShape(value: unknown): value is ActivatePublicationCapacityBudgetInput {
  if (!isRecord(value) || !hasExactKeys(value, INPUT_KEYS)) return false;
  const snapshot = value.old_budget_snapshot;
  if (!isRecord(snapshot) || !hasExactKeys(snapshot, SNAPSHOT_KEYS)) return false;
  if (!['audit_id', 'inventory_digest', 'actor', 'reason', 'ticket_ref']
    .every((key) => typeof value[key] === 'string')) return false;
  if (!['legacy_baseline_bytes', 'inventory_object_count', 'inventory_at_ms', 'now_ms']
    .every((key) => isSafeInteger(value[key]))) return false;
  if (!['singleton_id', 'budget_bytes', 'legacy_baseline_bytes', 'reserved_bytes', 'version', 'updated_at_ms']
    .every((key) => isSafeInteger(snapshot[key]))) return false;
  return typeof snapshot.namespace === 'string'
    && typeof snapshot.state === 'string'
    && snapshot.legacy_inventory_digest === null
    && snapshot.legacy_inventory_object_count === null
    && snapshot.legacy_inventory_at_ms === null;
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declaredValue = request.headers.get('Content-Length');
  if (declaredValue !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(declaredValue)) {
      throw new RequestFailure(400, 'invalid_request');
    }
    const declared = Number(declaredValue);
    if (!Number.isSafeInteger(declared) || declared > PUBLICATION_CAPACITY_ACTIVATION_BODY_MAX_BYTES) {
      throw new RequestFailure(413, 'payload_too_large');
    }
  }
  if (!request.body) throw new RequestFailure(400, 'invalid_json');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > PUBLICATION_CAPACITY_ACTIVATION_BODY_MAX_BYTES) {
      await reader.cancel();
      throw new RequestFailure(413, 'payload_too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new RequestFailure(400, 'invalid_json');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RequestFailure(400, 'invalid_json');
  }
}

function parseEnvelope(value: unknown, idempotencyKey: string | null): ActivatePublicationCapacityBudgetInput {
  if (!isRecord(value) || !hasExactKeys(value, ENVELOPE_KEYS)
    || value.schema_version !== 1 || value.action !== 'activate_publication_capacity_budget'
    || !hasStrictInputShape(value.input)) {
    throw new RequestFailure(400, 'invalid_schema');
  }
  if (!idempotencyKey || idempotencyKey !== value.input.audit_id) {
    throw new RequestFailure(400, 'invalid_idempotency_key');
  }
  return value.input;
}

function helperFailure(error: unknown): Response {
  const code = error instanceof Error ? error.message.split(':', 1)[0] : '';
  if (code === 'PUBLICATION_CAPACITY_ACTIVATION_STALE'
    || code === 'PUBLICATION_CAPACITY_ACTIVATION_CAS_FAILED') {
    return response({ ok: false, error: 'activation_conflict' }, 409);
  }
  if (code.endsWith('_INVALID') || code.startsWith('CAPACITY_PRODUCER_INVALID_')) {
    return response({ ok: false, error: 'invalid_schema' }, 400);
  }
  return response({ ok: false, error: 'activation_unavailable' }, 503);
}

export async function handlePublicationCapacityActivation(
  request: Request,
  env: Pick<Env, 'DB' | 'INGEST_TOKEN'>,
): Promise<Response> {
  if (!authorized(request, env.INGEST_TOKEN)) {
    return response({ ok: false, error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
  }
  if (request.method !== 'POST') {
    return response({ ok: false, error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  }
  const contentType = (request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return response({ ok: false, error: 'unsupported_media_type' }, 415);
  }

  let input: ActivatePublicationCapacityBudgetInput;
  try {
    input = parseEnvelope(await readBoundedJson(request), request.headers.get('Idempotency-Key'));
  } catch (error) {
    if (error instanceof RequestFailure) {
      return response({ ok: false, error: error.responseCode }, error.status);
    }
    return response({ ok: false, error: 'invalid_request' }, 400);
  }

  try {
    const result = await activatePublicationCapacityBudget({ DB: env.DB }, input);
    return response({ ok: true, ...result }, 200);
  } catch (error) {
    return helperFailure(error);
  }
}
