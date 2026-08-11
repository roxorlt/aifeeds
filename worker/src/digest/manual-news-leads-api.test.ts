import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./manual-news-leads-store', () => ({
  confirmManualNewsLeadCandidate: vi.fn(),
  getManualNewsLead: vi.fn(),
  listManualNewsLeads: vi.fn(),
  retryManualNewsLead: vi.fn(),
  submitManualNewsLead: vi.fn(),
  getManualNewsLeadCandidateState: vi.fn(),
}));
vi.mock('./manual-news-leads-runtime', () => ({ processManualNewsLeadWithEnv: vi.fn(async () => undefined) }));

import { handleManualNewsLeadsApi } from './manual-news-leads-api';
import {
  confirmManualNewsLeadCandidate,
  getManualNewsLead,
  listManualNewsLeads,
  retryManualNewsLead,
  submitManualNewsLead,
  getManualNewsLeadCandidateState,
} from './manual-news-leads-store';
import { processManualNewsLeadWithEnv } from './manual-news-leads-runtime';

const record = {
  id: 'ml-20260811-abc123def456', review_date: '2026-08-11', input_type: 'text',
  input_text: 'Anthropic 输出水印', input_url: '', note: '', status: 'submitted', version: 1,
  error_code: null, error_message: null, assessment: null, evidence: [], confirmed_batch_id: null, confirmed_at: null,
  created_at: 1, updated_at: 1,
};

function env(overrides: Record<string, unknown> = {}) {
  return {
    DAILY_NEWS_REVIEW_SECRET: 'shared-secret',
    DAILY_NEWS_REVIEW_ENABLED: '1',
    ...overrides,
  } as never;
}

function request(path: string, init: RequestInit = {}, auth = true): Request {
  return new Request(`https://api.example.test${path}`, {
    ...init,
    headers: {
      ...(auth ? { Authorization: 'Bearer shared-secret' } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
}

describe('manual daily news leads API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(submitManualNewsLead).mockResolvedValue({ lead: record, created: true } as never);
    vi.mocked(getManualNewsLead).mockResolvedValue(record as never);
    vi.mocked(listManualNewsLeads).mockResolvedValue([record] as never);
    vi.mocked(getManualNewsLeadCandidateState).mockResolvedValue({
      batch_id: 'nr-20260811-current000001', revision: 1,
    } as never);
    vi.mocked(retryManualNewsLead).mockResolvedValue({ ok: true, changed: true, lead: { ...record, status: 'validating', version: 2 } } as never);
    vi.mocked(confirmManualNewsLeadCandidate).mockResolvedValue({
      ok: true,
      lead: { ...record, status: 'recommended', version: 3, confirmed_batch_id: 'nr-20260811-abcdef123456' },
      batch: { batch_id: 'nr-20260811-abcdef123456', revision: 2, supersedes_revision: 1, current: true },
      rerender_enqueued: false,
    } as never);
  });

  test('requires the HK-to-CF bearer secret for every operation', async () => {
    const response = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads?date=2026-08-11', {}, false), env(), { waitUntil() {} } as never);
    expect(response.status).toBe(401);
    expect(listManualNewsLeads).not.toHaveBeenCalled();
  });

  test('submits a text-only lead idempotently and schedules processing out of band', async () => {
    const queued: Promise<unknown>[] = [];
    const response = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'submit-20260811-anthropic' },
      body: JSON.stringify({ date: '2026-08-11', text: 'Anthropic 输出水印', note: '核对范围' }),
    }), env(), { waitUntil(promise: Promise<unknown>) { queued.push(promise); } } as never);
    const payload = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(202);
    expect(payload).toMatchObject({ ok: true, created: true, lead: { id: record.id, status: 'submitted' } });
    expect(submitManualNewsLead).toHaveBeenCalledWith(expect.anything(), {
      date: '2026-08-11', text: 'Anthropic 输出水印', url: undefined, note: '核对范围',
    }, 'submit-20260811-anthropic', expect.any(Number));
    expect(processManualNewsLeadWithEnv).toHaveBeenCalledWith(expect.anything(), record.id);
    expect(queued).toHaveLength(1);
  });

  test('uses the durable lead workflow when its binding is configured', async () => {
    const create = vi.fn(async () => ({ id: 'manual-news-lead-workflow-instance' }));
    const queued: Promise<unknown>[] = [];
    const response = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'submit-20260811-workflow' },
      body: JSON.stringify({ date: '2026-08-11', url: 'https://example.com/news' }),
    }), env({ MANUAL_NEWS_LEAD_WORKFLOW: { create } }), {
      waitUntil(promise: Promise<unknown>) { queued.push(promise); },
    } as never);

    expect(response.status).toBe(202);
    expect(create).toHaveBeenCalledWith({
      id: `manual-news-${record.id}-v${record.version}`,
      params: { lead_id: record.id },
    });
    expect(processManualNewsLeadWithEnv).not.toHaveBeenCalled();
    expect(queued).toHaveLength(1);
  });

  test('falls back to request-lifetime processing if workflow instance creation fails', async () => {
    const create = vi.fn(async () => { throw new Error('workflow unavailable'); });
    const queued: Promise<unknown>[] = [];
    const response = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'submit-20260811-fallback' },
      body: JSON.stringify({ date: '2026-08-11', text: '待核验线索' }),
    }), env({ MANUAL_NEWS_LEAD_WORKFLOW: { create } }), {
      waitUntil(promise: Promise<unknown>) { queued.push(promise); },
    } as never);
    await Promise.all(queued);

    expect(response.status).toBe(202);
    expect(processManualNewsLeadWithEnv).toHaveBeenCalledWith(expect.anything(), record.id);
  });

  test('lists date-scoped status and returns a single lead with evidence details', async () => {
    const listResponse = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads?date=2026-08-11'), env(), { waitUntil() {} } as never);
    expect(listResponse.status).toBe(200);
    expect(listManualNewsLeads).toHaveBeenCalledWith(expect.anything(), '2026-08-11');
    await expect(listResponse.clone().json()).resolves.toMatchObject({ candidate_batch: { revision: 1 } });

    const detailResponse = await handleManualNewsLeadsApi(request(`/api/digest/daily-news-leads/${record.id}`), env(), { waitUntil() {} } as never);
    expect(detailResponse.status).toBe(200);
    expect(getManualNewsLead).toHaveBeenCalledWith(expect.anything(), record.id);
  });

  test('retry requires expected_version and an idempotency key, then schedules a new processing pass', async () => {
    const queued: Promise<unknown>[] = [];
    const response = await handleManualNewsLeadsApi(request(`/api/digest/daily-news-leads/${record.id}/retry`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'retry-1' },
      body: JSON.stringify({ expected_version: 1 }),
    }), env(), { waitUntil(promise: Promise<unknown>) { queued.push(promise); } } as never);
    expect(response.status).toBe(202);
    expect(retryManualNewsLead).toHaveBeenCalledWith(expect.anything(), record.id, 1, 'retry-1', expect.any(Number));
    expect(queued).toHaveLength(1);
  });

  test('confirm creates only a superseding candidate revision and never starts downstream rendering', async () => {
    const response = await handleManualNewsLeadsApi(request(`/api/digest/daily-news-leads/${record.id}/confirm-candidate`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'confirm-1' },
      body: JSON.stringify({ expected_version: 2, expected_batch_revision: 1 }),
    }), env(), { waitUntil() {} } as never);
    const payload = await response.json<Record<string, unknown>>();
    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, rerender_enqueued: false, batch: { revision: 2, current: true } });
    expect(confirmManualNewsLeadCandidate).toHaveBeenCalledWith(expect.anything(), record.id, 2, 1, 'confirm-1', expect.any(Number));
    expect(processManualNewsLeadWithEnv).not.toHaveBeenCalled();
  });

  test('preserves optimistic version conflicts and validates mutation headers locally', async () => {
    vi.mocked(retryManualNewsLead).mockResolvedValue({ ok: false, status: 409, error: 'lead_version_conflict', lead: record } as never);
    const conflict = await handleManualNewsLeadsApi(request(`/api/digest/daily-news-leads/${record.id}/retry`, {
      method: 'POST', headers: { 'Idempotency-Key': 'retry-conflict' }, body: JSON.stringify({ expected_version: 0 }),
    }), env(), { waitUntil() {} } as never);
    expect(conflict.status).toBe(409);

    const missingKey = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads', {
      method: 'POST', body: JSON.stringify({ date: '2026-08-11', url: 'https://example.com/news' }),
    }), env(), { waitUntil() {} } as never);
    expect(missingKey.status).toBe(400);
    expect(submitManualNewsLead).not.toHaveBeenCalled();
  });
});
