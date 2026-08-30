import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    ctx: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock('./publication-capacity-outbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./publication-capacity-outbox')>();
  return { ...actual, activatePublicationCapacityBudget: vi.fn() };
});

import worker from '../index';
import {
  activatePublicationCapacityBudget,
  derivePublicationCapacityActivationAuditId,
} from './publication-capacity-outbox';
import {
  handlePublicationCapacityActivation,
  PUBLICATION_CAPACITY_ACTIVATION_BODY_MAX_BYTES,
} from './publication-capacity-activation-api';

const PATH = 'https://api.ai-feeds.com/api/ops/publication-capacity/activate';
const TOKEN = 'controlled-ops-token';
const IMMUTABLE_INPUT = {
  legacy_baseline_bytes: 740_834_456,
  inventory_digest: '5e9ca8c182f7109abc7093f5706d34c118024b21fe1f005eed0f91eb02f1cdee',
  inventory_object_count: 298,
  inventory_at_ms: 1_788_056_520_000,
  actor: 'codex-aifeeds-publication-recovery',
  reason: 'Activate the audited legacy R2 publication baseline.',
  ticket_ref: 'aifeeds-publication-recovery-2026-08-30',
  now_ms: 1_788_056_520_000,
  old_budget_snapshot: {
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
};
const INPUT = {
  audit_id: await derivePublicationCapacityActivationAuditId(IMMUTABLE_INPUT as never),
  ...IMMUTABLE_INPUT,
};
const BODY = {
  schema_version: 1,
  action: 'activate_publication_capacity_budget',
  input: INPUT,
};

function env(): { DB: D1Database; INGEST_TOKEN: string } {
  return { DB: { prepare: vi.fn() } as never, INGEST_TOKEN: TOKEN };
}

function request(
  body: BodyInit | null = JSON.stringify(BODY),
  headers: Record<string, string> = {},
  method = 'POST',
) {
  return new Request(PATH, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8',
      'Idempotency-Key': INPUT.audit_id,
      'User-Agent': 'aifeeds-publication-operator/1.0',
      ...headers,
    },
    ...(body === null ? {} : { body }),
  });
}

async function payload(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(activatePublicationCapacityBudget).mockResolvedValue({
    status: 'activated', epoch: 1, budget_version: 1,
  });
});

describe('publication capacity activation operations API', () => {
  test.each([
    ['missing', ''],
    ['wrong', 'Bearer wrong-token'],
    ['wrong scheme', `Basic ${TOKEN}`],
  ])('fails closed for %s authorization without reading the body', async (_label, authorization) => {
    const response = await handlePublicationCapacityActivation(request('{not json', {
      Authorization: authorization,
    }), env());

    expect(response.status).toBe(401);
    const bodyText = await response.text();
    expect(JSON.parse(bodyText)).toEqual({ ok: false, error: 'unauthorized' });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(bodyText).not.toContain(TOKEN);
    expect(activatePublicationCapacityBudget).not.toHaveBeenCalled();
  });

  test('authenticates before method handling and accepts POST only', async () => {
    const unauthorized = await handlePublicationCapacityActivation(request(null, {
      Authorization: '',
    }, 'GET'), env());
    expect(unauthorized.status).toBe(401);

    const response = await handlePublicationCapacityActivation(request(null, {}, 'GET'), env());
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
    expect(activatePublicationCapacityBudget).not.toHaveBeenCalled();
  });

  test('rejects non-JSON, malformed JSON, declared oversize, and streamed oversize bodies', async () => {
    const nonJson = await handlePublicationCapacityActivation(request('{}', {
      'Content-Type': 'text/plain',
    }), env());
    expect(nonJson.status).toBe(415);

    const malformed = await handlePublicationCapacityActivation(request('{bad json'), env());
    expect(malformed.status).toBe(400);
    expect(await payload(malformed)).toEqual({ ok: false, error: 'invalid_json' });

    const declared = await handlePublicationCapacityActivation(request('{}', {
      'Content-Length': String(PUBLICATION_CAPACITY_ACTIVATION_BODY_MAX_BYTES + 1),
    }), env());
    expect(declared.status).toBe(413);

    const streamed = await handlePublicationCapacityActivation(request(
      'x'.repeat(PUBLICATION_CAPACITY_ACTIVATION_BODY_MAX_BYTES + 1),
    ), env());
    expect(streamed.status).toBe(413);
    expect(activatePublicationCapacityBudget).not.toHaveBeenCalled();
  });

  test('rejects extra or missing schema fields and a mismatched idempotency key', async () => {
    const extra = await handlePublicationCapacityActivation(request(JSON.stringify({
      ...BODY, unexpected: true,
    })), env());
    expect(extra.status).toBe(400);
    expect(await payload(extra)).toEqual({ ok: false, error: 'invalid_schema' });

    const missingSnapshot = await handlePublicationCapacityActivation(request(JSON.stringify({
      ...BODY,
      input: Object.fromEntries(Object.entries(INPUT).filter(([key]) => key !== 'old_budget_snapshot')),
    })), env());
    expect(missingSnapshot.status).toBe(400);

    const mismatchedKey = await handlePublicationCapacityActivation(request(JSON.stringify(BODY), {
      'Idempotency-Key': 'different-audit-id',
    }), env());
    expect(mismatchedKey.status).toBe(400);
    expect(activatePublicationCapacityBudget).not.toHaveBeenCalled();
  });

  test('calls the unique helper once with the complete captured snapshot and returns a minimal result', async () => {
    const targetEnv = env();
    const response = await handlePublicationCapacityActivation(request(), targetEnv);

    expect(response.status).toBe(200);
    expect(await payload(response)).toEqual({
      ok: true, status: 'activated', epoch: 1, budget_version: 1,
    });
    expect(activatePublicationCapacityBudget).toHaveBeenCalledTimes(1);
    expect(activatePublicationCapacityBudget).toHaveBeenCalledWith(
      { DB: targetEnv.DB },
      INPUT,
    );
  });

  test('maps stale authoritative state to a minimal conflict without leaking helper details', async () => {
    vi.mocked(activatePublicationCapacityBudget)
      .mockRejectedValue(new Error('PUBLICATION_CAPACITY_ACTIVATION_STALE: internal details'));

    const response = await handlePublicationCapacityActivation(request(), env());
    expect(response.status).toBe(409);
    const bodyText = await response.text();
    expect(JSON.parse(bodyText)).toEqual({ ok: false, error: 'activation_conflict' });
    expect(bodyText).not.toContain('internal details');
  });

  test('index route reaches the operations handler and therefore the unique helper', async () => {
    vi.mocked(activatePublicationCapacityBudget).mockResolvedValue({
      status: 'replayed', epoch: 1, budget_version: 1,
    });
    const targetEnv = env();

    const response = await worker.fetch(request(), targetEnv as never, {
      waitUntil: vi.fn(), passThroughOnException: vi.fn(),
    } as never);

    expect(response.status).toBe(200);
    expect(await payload(response)).toEqual({
      ok: true, status: 'replayed', epoch: 1, budget_version: 1,
    });
    expect(activatePublicationCapacityBudget).toHaveBeenCalledTimes(1);
  });

  test('index route does not let the global CORS preflight bypass operations authentication', async () => {
    const targetEnv = env();
    const response = await worker.fetch(request(null, { Authorization: '' }, 'OPTIONS'), targetEnv as never, {
      waitUntil: vi.fn(), passThroughOnException: vi.fn(),
    } as never);

    expect(response.status).toBe(401);
    expect(await payload(response)).toEqual({ ok: false, error: 'unauthorized' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(activatePublicationCapacityBudget).not.toHaveBeenCalled();
  });
});
