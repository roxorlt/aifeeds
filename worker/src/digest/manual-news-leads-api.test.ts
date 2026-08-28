import { beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('./manual-news-leads-store', () => ({
  confirmManualNewsLeadCandidate: vi.fn(),
  getManualNewsLead: vi.fn(),
  listManualNewsLeads: vi.fn(),
  retryManualNewsLead: vi.fn(),
  submitManualNewsLead: vi.fn(),
  getManualNewsLeadCandidateState: vi.fn(),
  manualNewsLeadProcessingOwner: (id: string, version: number) => `manual-news-${id}-v${version}`,
  markManualNewsLeadEnqueueFailure: vi.fn(),
  recoverStaleManualNewsLeads: vi.fn(),
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
  markManualNewsLeadEnqueueFailure,
  recoverStaleManualNewsLeads,
} from './manual-news-leads-store';
import { processManualNewsLeadWithEnv } from './manual-news-leads-runtime';

const record = {
  id: 'ml-20260811-abc123def456', review_date: '2026-08-11', input_type: 'text',
  input_text: 'Anthropic 输出水印', input_url: '', note: '', status: 'submitted', version: 1,
  error_code: null, error_message: null, assessment: null, evidence: [], confirmed_batch_id: null, confirmed_at: null,
  processing_owner: 'manual-news-ml-20260811-abc123def456-v1',
  processing_attempt: 0, processing_lease_until: 360001,
  created_at: 1, updated_at: 1,
};

const boundedDetailEvidence = Array.from({ length: 8 }, (_, index) => ({
  id: `ev-detail-${index + 1}`,
  url: `https://example.com/detail-${index + 1}`,
  source_type: 'independent_media',
  publisher: 'example.com',
  published_at: null,
  retrieved_at: 1,
  title: `Evidence ${index + 1}`,
  excerpt: '😀'.repeat(3_000),
  claims_supported: ['😀'.repeat(3_000)],
  reliable: true,
  fetch_audit: { final_url: `https://example.com/detail-${index + 1}` },
  body: 'COMPLETE-BODY-TAIL-SENTINEL',
}));

const legacyMutationRecord = {
  ...record,
  evidence: [{
    ...boundedDetailEvidence[0],
    excerpt: 'Bounded persisted excerpt.',
    claims_supported: ['COMPLETE-BODY-TAIL-SENTINEL'],
    fetch_audit: { final_url: boundedDetailEvidence[0].url, legacy_tail: 'COMPLETE-BODY-TAIL-SENTINEL' },
  }],
  complete_body: 'COMPLETE-BODY-TAIL-SENTINEL',
};

const workflowCreate = vi.fn(async () => ({ id: 'manual-news-lead-workflow-instance' }));
const apiContractPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../workflows/aifeeds-daily/fixtures/manual-news-leads-api-v1-contract.json',
);
const apiContract = JSON.parse(readFileSync(apiContractPath, 'utf8')) as {
  list: { top_level_fields: string[]; lead_fields: string[] };
  detail: { top_level_fields: string[]; lead_required_fields: string[]; evidence_fields: string[] };
};

function env(overrides: Record<string, unknown> = {}) {
  return {
    DAILY_NEWS_REVIEW_SECRET: 'shared-secret',
    DAILY_NEWS_REVIEW_ENABLED: '1',
    MANUAL_NEWS_LEAD_WORKFLOW: { create: workflowCreate },
    MANUAL_NEWS_RESEARCH_ORIGIN: 'https://research-gateway.example',
    MANUAL_NEWS_RESEARCH_TOKEN: 'test-research-token',
    MANUAL_NEWS_RESEARCH_RESPONSE_SECRET: '11'.repeat(32),
    MANUAL_NEWS_RESEARCH_RESPONSE_KEY_ID: 'response-key-2026-08-11',
    DEEPSEEK_API_KEY: 'test-deepseek-key',
    MANUAL_NEWS_VERIFICATION_SECRET: 'a'.repeat(64),
    MANUAL_NEWS_VERIFICATION_KEY_ID: 'verification-key-2026-08-11',
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
  test('publishes the machine-readable HK client contract fixture', () => {
    expect(existsSync(apiContractPath)).toBe(true);
    const contract = JSON.parse(readFileSync(apiContractPath, 'utf8')) as Record<string, any>;
    expect(contract).toMatchObject({
      contract: 'manual_news_leads_api_v1',
      list: { response_profile: 'manual_news_leads_summary_v1', schema_version: 1 },
      detail: { response_profile: 'manual_news_lead_detail_v1', schema_version: 1 },
      mutations: { lead_profile: 'manual_news_lead_detail_v1' },
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    workflowCreate.mockResolvedValue({ id: 'manual-news-lead-workflow-instance' });
    vi.mocked(recoverStaleManualNewsLeads).mockResolvedValue([] as never);
    vi.mocked(markManualNewsLeadEnqueueFailure).mockResolvedValue(true as never);
    vi.mocked(submitManualNewsLead).mockResolvedValue({ lead: record, created: true } as never);
    vi.mocked(getManualNewsLead).mockResolvedValue(record as never);
    vi.mocked(listManualNewsLeads).mockResolvedValue([record] as never);
    vi.mocked(getManualNewsLeadCandidateState).mockResolvedValue({
      batch_id: 'nr-20260811-current000001', revision: 1,
    } as never);
    vi.mocked(retryManualNewsLead).mockResolvedValue({
      ok: true,
      changed: true,
      lead: {
        ...record,
        status: 'validating',
        version: 2,
        processing_owner: `manual-news-${record.id}-v2`,
      },
    } as never);
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
    expect(workflowCreate).toHaveBeenCalledWith({
      id: `manual-news-${record.id}-v${record.version}`,
      params: {
        lead_id: record.id,
        processing_owner: `manual-news-${record.id}-v${record.version}`,
      },
    });
    expect(processManualNewsLeadWithEnv).not.toHaveBeenCalled();
    expect(queued).toHaveLength(1);
  });

  test('passes the exact source-support authorization marker and rejects every other marker', async () => {
    const accepted = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'submit-source-support' },
      body: JSON.stringify({
        date: '2026-08-11',
        text: 'Anthropic 开放研究预览 MHS',
        candidate_authorization: 'source_support_v1',
      }),
    }), env(), { waitUntil() {} } as never);

    expect(accepted.status).toBe(202);
    expect(submitManualNewsLead).toHaveBeenCalledWith(expect.anything(), {
      date: '2026-08-11',
      text: 'Anthropic 开放研究预览 MHS',
      url: undefined,
      note: undefined,
      candidate_authorization: 'source_support_v1',
    }, 'submit-source-support', expect.any(Number));

    vi.mocked(submitManualNewsLead).mockClear();
    const rejected = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'submit-unknown-authorization' },
      body: JSON.stringify({
        date: '2026-08-11',
        text: 'Anthropic 开放研究预览 MHS',
        candidate_authorization: 'source_support_v2',
      }),
    }), env(), { waitUntil() {} } as never);

    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toEqual({
      ok: false,
      error: 'invalid_candidate_authorization',
    });
    expect(submitManualNewsLead).not.toHaveBeenCalled();
  });

  test('uses one bounded lead DTO for submit replay and retry/confirm success or conflict', async () => {
    const cases = [
      {
        name: 'submit replay',
        prepare: () => vi.mocked(submitManualNewsLead).mockResolvedValueOnce({
          lead: legacyMutationRecord, created: false,
        } as never),
        path: '/api/digest/daily-news-leads',
        init: {
          method: 'POST', headers: { 'Idempotency-Key': 'submit-bounded-replay' },
          body: JSON.stringify({ date: '2026-08-11', text: 'Anthropic 输出水印' }),
        },
        status: 200,
      },
      {
        name: 'retry success',
        prepare: () => vi.mocked(retryManualNewsLead).mockResolvedValueOnce({
          ok: true, changed: true,
          lead: {
            ...legacyMutationRecord, version: 2, status: 'validating',
            processing_owner: `manual-news-${record.id}-v2`,
          },
        } as never),
        path: `/api/digest/daily-news-leads/${record.id}/retry`,
        init: {
          method: 'POST', headers: { 'Idempotency-Key': 'retry-bounded-success' },
          body: JSON.stringify({ expected_version: 1 }),
        },
        status: 202,
      },
      {
        name: 'retry conflict',
        prepare: () => vi.mocked(retryManualNewsLead).mockResolvedValueOnce({
          ok: false, status: 409, error: 'lead_version_conflict', lead: legacyMutationRecord,
        } as never),
        path: `/api/digest/daily-news-leads/${record.id}/retry`,
        init: {
          method: 'POST', headers: { 'Idempotency-Key': 'retry-bounded-conflict' },
          body: JSON.stringify({ expected_version: 0 }),
        },
        status: 409,
      },
      {
        name: 'confirm success',
        prepare: () => vi.mocked(confirmManualNewsLeadCandidate).mockResolvedValueOnce({
          ok: true, changed: true, lead: { ...legacyMutationRecord, status: 'recommended' },
          batch: null, pending_initial_freeze: true, rerender_enqueued: false,
        } as never),
        path: `/api/digest/daily-news-leads/${record.id}/confirm-candidate`,
        init: {
          method: 'POST', headers: { 'Idempotency-Key': 'confirm-bounded-success' },
          body: JSON.stringify({ expected_version: 1, expected_batch_revision: 0 }),
        },
        status: 200,
      },
      {
        name: 'confirm conflict',
        prepare: () => vi.mocked(confirmManualNewsLeadCandidate).mockResolvedValueOnce({
          ok: false, status: 409, error: 'lead_version_conflict', lead: legacyMutationRecord,
        } as never),
        path: `/api/digest/daily-news-leads/${record.id}/confirm-candidate`,
        init: {
          method: 'POST', headers: { 'Idempotency-Key': 'confirm-bounded-conflict' },
          body: JSON.stringify({ expected_version: 0, expected_batch_revision: 0 }),
        },
        status: 409,
      },
    ];

    for (const scenario of cases) {
      scenario.prepare();
      const result = await handleManualNewsLeadsApi(
        request(scenario.path, scenario.init), env(), { waitUntil() {} } as never,
      );
      const payload = await result.json<{ lead: { evidence: Array<Record<string, unknown>> } }>();
      expect(result.status, scenario.name).toBe(scenario.status);
      expect(payload.lead, scenario.name).toMatchObject({
        response_profile: 'manual_news_lead_detail_v1', schema_version: 1,
      });
      expect(payload.lead.evidence, scenario.name).toEqual([expect.objectContaining({
        excerpt: 'Bounded persisted excerpt.',
      })]);
      expect(JSON.stringify(payload), scenario.name).not.toContain('COMPLETE-BODY-TAIL-SENTINEL');
      expect(JSON.stringify(payload), scenario.name).not.toContain('claims_supported');
      expect(JSON.stringify(payload), scenario.name).not.toContain('fetch_audit');
    }
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
      params: {
        lead_id: record.id,
        processing_owner: `manual-news-${record.id}-v${record.version}`,
      },
    });
    expect(processManualNewsLeadWithEnv).not.toHaveBeenCalled();
    expect(queued).toHaveLength(1);
  });

  test('marks enqueue failure durably and never falls back to request-lifetime processing', async () => {
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
    expect(markManualNewsLeadEnqueueFailure).toHaveBeenCalledWith(
      expect.anything(),
      record.id,
      record.version,
      `manual-news-${record.id}-v${record.version}`,
      expect.any(Error),
    );
    expect(processManualNewsLeadWithEnv).not.toHaveBeenCalled();
  });

  test('keeps the workbench list bounded and fetches one bounded detail on demand', async () => {
    const detailRecord = {
      ...record,
      evidence: boundedDetailEvidence,
      complete_body: 'COMPLETE-BODY-TAIL-SENTINEL',
    };
    vi.mocked(listManualNewsLeads).mockResolvedValueOnce(Array.from(
      { length: 51 }, (_, index) => ({ ...detailRecord, id: `${record.id}-${index}` }),
    ) as never);
    vi.mocked(getManualNewsLead).mockResolvedValueOnce(detailRecord as never);
    const listResponse = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads?date=2026-08-11'), env(), { waitUntil() {} } as never);
    expect(listResponse.status).toBe(200);
    expect(listManualNewsLeads).toHaveBeenCalledWith(expect.anything(), '2026-08-11');
    const listPayload = await listResponse.clone().json<{
      leads: Array<Record<string, unknown>>;
      candidate_batch: { revision: number };
    }>();
    expect(listPayload.candidate_batch).toMatchObject({ revision: 1 });
    expect(listPayload).toMatchObject({
      response_profile: 'manual_news_leads_summary_v1', schema_version: 1,
    });
    expect(listPayload.leads).toHaveLength(50);
    expect(Object.keys(listPayload).sort()).toEqual([...apiContract.list.top_level_fields].sort());
    expect(Object.keys(listPayload.leads[0]).sort()).toEqual([...apiContract.list.lead_fields].sort());
    expect(listPayload.leads[0]).toMatchObject({ status: record.status, evidence_count: 8 });
    expect(listPayload.leads[0]).not.toHaveProperty('evidence');
    expect(listPayload.leads[0]).not.toHaveProperty('assessment');
    expect(JSON.stringify(listPayload)).not.toContain('COMPLETE-BODY-TAIL-SENTINEL');

    const detailResponse = await handleManualNewsLeadsApi(request(`/api/digest/daily-news-leads/${record.id}`), env(), { waitUntil() {} } as never);
    expect(detailResponse.status).toBe(200);
    expect(getManualNewsLead).toHaveBeenCalledWith(expect.anything(), record.id);
    const detailPayload = await detailResponse.clone().json<{
      lead: { evidence: Array<Record<string, unknown>> };
    }>();
    expect(detailPayload.lead).toMatchObject({
      response_profile: 'manual_news_lead_detail_v1', schema_version: 1,
    });
    expect(detailPayload.lead.evidence).toHaveLength(8);
    expect(Object.keys(detailPayload).sort()).toEqual([...apiContract.detail.top_level_fields].sort());
    expect(Object.keys(detailPayload.lead)).toEqual(expect.arrayContaining(
      apiContract.detail.lead_required_fields,
    ));
    for (const evidence of detailPayload.lead.evidence) {
      expect(Object.keys(evidence).sort()).toEqual([...apiContract.detail.evidence_fields].sort());
      expect(Array.from(String(evidence.excerpt))).toHaveLength(3_000);
      expect(new TextEncoder().encode(String(evidence.excerpt)).byteLength).toBe(12_000);
      expect(evidence).not.toHaveProperty('body');
      expect(evidence).not.toHaveProperty('claims_supported');
      expect(evidence).not.toHaveProperty('fetch_audit');
    }
    expect(JSON.stringify(detailPayload)).not.toContain('COMPLETE-BODY-TAIL-SENTINEL');
  });

  test.each(['assessment', 'verification'] as const)(
    'exposes only the stable %s JSON parse failure on authorized list and detail GETs',
    async (stage) => {
      const failed = {
        ...record,
        status: 'needs_review',
        error_code: stage === 'assessment' ? 'assessment_validation_failed' : 'fact_verification_failed',
        error_message: `manual_news_provider_error:${stage}:provider_json_parse_fail`,
      };
      vi.mocked(listManualNewsLeads).mockResolvedValueOnce([failed] as never);
      vi.mocked(getManualNewsLead).mockResolvedValueOnce(failed as never);

      const listResponse = await handleManualNewsLeadsApi(
        request('/api/digest/daily-news-leads?date=2026-08-11'), env(), { waitUntil() {} } as never,
      );
      const detailResponse = await handleManualNewsLeadsApi(
        request(`/api/digest/daily-news-leads/${record.id}`), env(), { waitUntil() {} } as never,
      );

      await expect(listResponse.json()).resolves.toMatchObject({
        leads: [{ error_message: `manual_news_provider_error:${stage}:provider_json_parse_fail` }],
      });
      await expect(detailResponse.json()).resolves.toMatchObject({
        lead: { error_message: `manual_news_provider_error:${stage}:provider_json_parse_fail` },
      });
    },
  );

  test('returns only bounded provider diagnostics on an authorized error payload', async () => {
    const failed = {
      ...record,
      status: 'failed',
      error_code: 'processing_retry_exhausted',
      error_message: 'manual_news_provider_error:assessment:provider_output_exhausted',
      provider_failure: {
        stage: 'assessment', provider_error_code: 'provider_output_exhausted',
        request_id: `${record.id}:p6:assessment:1`,
        system_chars: 4_083, user_chars: 6_086, evidence_count: 1, attempt: 6,
        provider_diagnostics: {
          finish_reason: 'length', content_chars: 0, reasoning_chars: 3_500,
          usage: { prompt_tokens: 1_200, completion_tokens: 3_500, total_tokens: 4_700, reasoning_tokens: 3_500 },
        },
      },
    };
    vi.mocked(getManualNewsLead).mockResolvedValueOnce(failed as never);

    const result = await handleManualNewsLeadsApi(
      request(`/api/digest/daily-news-leads/${record.id}`), env(), { waitUntil() {} } as never,
    );
    const payload = await result.json<Record<string, unknown>>();

    expect(payload).toMatchObject({ lead: { provider_failure: failed.provider_failure } });
    expect(JSON.stringify(payload)).not.toContain('reasoning_content');
    expect(JSON.stringify(payload)).not.toContain('PRIVATE');
  });

  test('returns only bounded assessment validation codes and schema paths on authorized GETs', async () => {
    const failed = {
      ...record,
      status: 'needs_review',
      error_code: 'assessment_validation_failed',
      error_message: 'non_atomic_editorial_predicate',
      assessment_generation: {
        assessment_generation_attempts: 2,
        assessment_first_validation_code: 'non_atomic_source_object',
        assessment_first_validation_path: 'source_facts[0].atomic_fact.object',
        assessment_last_validation_code: 'non_atomic_editorial_predicate',
        assessment_last_validation_path: 'editorial_projection.title.atomic_fact.predicate',
        assessment_regeneration_trigger_code: 'non_atomic_source_object',
        assessment_regeneration_trigger_path: 'source_facts[0].atomic_fact.object',
      },
    };
    vi.mocked(getManualNewsLead).mockResolvedValueOnce(failed as never);

    const result = await handleManualNewsLeadsApi(
      request(`/api/digest/daily-news-leads/${record.id}`), env(), { waitUntil() {} } as never,
    );
    const payload = await result.json<Record<string, unknown>>();

    expect(payload).toMatchObject({ lead: { assessment_generation: failed.assessment_generation } });
    expect(JSON.stringify(payload)).not.toContain('because of security concerns');
    expect(JSON.stringify(payload)).not.toContain('MODEL_RAW');
  });

  test('fails closed when the durable workflow binding is unavailable', async () => {
    const unavailableEnv = env({ MANUAL_NEWS_LEAD_WORKFLOW: undefined });
    const response = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads', {
      method: 'POST', headers: { 'Idempotency-Key': 'submit-no-workflow' },
      body: JSON.stringify({ date: '2026-08-11', text: '线索' }),
    }), unavailableEnv, { waitUntil() {} } as never);

    expect(response.status).toBe(503);
    expect(submitManualNewsLead).not.toHaveBeenCalled();
  });

  test('fails closed before submit when research or model dependencies are unavailable', async () => {
    for (const overrides of [
      { MANUAL_NEWS_RESEARCH_ORIGIN: undefined },
      { MANUAL_NEWS_RESEARCH_TOKEN: undefined },
      { MANUAL_NEWS_RESEARCH_RESPONSE_SECRET: undefined },
      { MANUAL_NEWS_RESEARCH_RESPONSE_SECRET: 'too-short' },
      { MANUAL_NEWS_RESEARCH_RESPONSE_SECRET: 'A'.repeat(64) },
      { MANUAL_NEWS_RESEARCH_RESPONSE_KEY_ID: undefined },
      { MANUAL_NEWS_RESEARCH_RESPONSE_KEY_ID: 'UPPERCASE' },
      { MANUAL_NEWS_RESEARCH_RESPONSE_KEYRING_JSON: '{malformed' },
      { DEEPSEEK_API_KEY: undefined },
      { MANUAL_NEWS_VERIFICATION_SECRET: undefined },
      { MANUAL_NEWS_VERIFICATION_SECRET: 'too-short' },
      { MANUAL_NEWS_VERIFICATION_SECRET: 'A'.repeat(64) },
      { MANUAL_NEWS_VERIFICATION_KEY_ID: undefined },
      { MANUAL_NEWS_VERIFICATION_KEY_ID: 'UPPERCASE' },
      { MANUAL_NEWS_VERIFICATION_KEYRING_JSON: '{malformed' },
    ]) {
      const response = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads', {
        method: 'POST', headers: { 'Idempotency-Key': 'submit-missing-dependency' },
        body: JSON.stringify({ date: '2026-08-11', text: '线索' }),
      }), env(overrides), { waitUntil() {} } as never);
      expect(response.status).toBe(503);
    }
    expect(submitManualNewsLead).not.toHaveBeenCalled();
  });

  test('keeps GET readable while hiding assessment handling behind a missing verification secret', async () => {
    const response = await handleManualNewsLeadsApi(
      request('/api/digest/daily-news-leads?date=2026-08-11'),
      env({ MANUAL_NEWS_VERIFICATION_SECRET: undefined }),
      { waitUntil() {} } as never,
    );

    expect(response.status).toBe(200);
    expect(listManualNewsLeads).toHaveBeenCalled();
    expect(recoverStaleManualNewsLeads).not.toHaveBeenCalled();
  });

  test('fails closed before retry when the verification secret is absent or malformed', async () => {
    for (const verificationSecret of [undefined, 'too-short', 'A'.repeat(64)]) {
      const response = await handleManualNewsLeadsApi(
        request(`/api/digest/daily-news-leads/${record.id}/retry`, {
          method: 'POST', headers: { 'Idempotency-Key': 'retry-invalid-verification-secret' },
          body: JSON.stringify({ expected_version: 1 }),
        }),
        env({ MANUAL_NEWS_VERIFICATION_SECRET: verificationSecret }),
        { waitUntil() {} } as never,
      );
      expect(response.status).toBe(503);
    }
    expect(retryManualNewsLead).not.toHaveBeenCalled();
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

  test('retry replay after later workflow transitions returns 200 without scheduling again', async () => {
    vi.mocked(retryManualNewsLead).mockResolvedValueOnce({
      ok: true,
      changed: false,
      lead: {
        ...record,
        status: 'researching',
        version: 9,
        processing_owner: `manual-news-${record.id}-v8`,
      },
    } as never);
    const queued: Promise<unknown>[] = [];

    const response = await handleManualNewsLeadsApi(request(`/api/digest/daily-news-leads/${record.id}/retry`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'retry-original-v7' },
      body: JSON.stringify({ expected_version: 7 }),
    }), env(), { waitUntil(promise: Promise<unknown>) { queued.push(promise); } } as never);

    expect(response.status).toBe(200);
    await expect(response.clone().json()).resolves.toMatchObject({ ok: true, changed: false, lead: { version: 9 } });
    expect(workflowCreate).not.toHaveBeenCalled();
    expect(queued).toHaveLength(0);
  });

  test('concurrent same-key retry responses enqueue only the changed winner', async () => {
    const winner = {
      ...record,
      status: 'validating',
      version: 8,
      processing_owner: `manual-news-${record.id}-v8`,
    };
    vi.mocked(retryManualNewsLead)
      .mockResolvedValueOnce({ ok: true, changed: true, lead: winner } as never)
      .mockResolvedValueOnce({ ok: true, changed: false, lead: winner } as never);
    const queued: Promise<unknown>[] = [];
    const makeRequest = () => handleManualNewsLeadsApi(request(
      `/api/digest/daily-news-leads/${record.id}/retry`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'retry-concurrent-v7' },
        body: JSON.stringify({ expected_version: 7 }),
      },
    ), env(), { waitUntil(promise: Promise<unknown>) { queued.push(promise); } } as never);

    const responses = await Promise.all([makeRequest(), makeRequest()]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 202]);
    expect(workflowCreate).toHaveBeenCalledTimes(1);
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

  test('maps idempotency conflicts, validation, dependency, and internal errors without leaking raw exceptions', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(submitManualNewsLead).mockRejectedValueOnce(new Error('idempotency_key_reused_with_different_payload'));
    const conflict = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads', {
      method: 'POST', headers: { 'Idempotency-Key': 'submit-conflict' },
      body: JSON.stringify({ date: '2026-08-11', text: 'edited' }),
    }), env(), { waitUntil() {} } as never);
    expect(conflict.status).toBe(409);
    await expect(conflict.clone().json()).resolves.toEqual({ ok: false, error: 'idempotency_key_reused_with_different_payload' });

    vi.mocked(submitManualNewsLead).mockRejectedValueOnce(new Error('trusted_research_service_required'));
    const unavailable = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads', {
      method: 'POST', headers: { 'Idempotency-Key': 'submit-dependency' },
      body: JSON.stringify({ date: '2026-08-11', text: 'dependency' }),
    }), env(), { waitUntil() {} } as never);
    expect(unavailable.status).toBe(503);

    vi.mocked(submitManualNewsLead).mockRejectedValueOnce(new Error('D1 SQL leaked table and token=SENTINEL'));
    const internal = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads', {
      method: 'POST', headers: { 'Idempotency-Key': 'submit-internal' },
      body: JSON.stringify({ date: '2026-08-11', text: 'internal' }),
    }), env(), { waitUntil() {} } as never);
    expect(internal.status).toBe(500);
    await expect(internal.clone().json()).resolves.toEqual({ ok: false, error: 'internal_error' });
    expect(await internal.clone().text()).not.toContain('SENTINEL');
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('SENTINEL');
  });

  test('maps malformed and oversized bodies to client errors and catches internal failures on read routes', async () => {
    const malformed = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads', {
      method: 'POST', headers: { 'Idempotency-Key': 'submit-malformed' }, body: '{bad-json',
    }), env(), { waitUntil() {} } as never);
    expect(malformed.status).toBe(400);
    await expect(malformed.clone().json()).resolves.toEqual({ ok: false, error: 'invalid_json' });

    const oversized = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads', {
      method: 'POST', headers: { 'Idempotency-Key': 'submit-oversize', 'Content-Length': '20000' },
      body: JSON.stringify({ date: '2026-08-11', text: 'lead' }),
    }), env(), { waitUntil() {} } as never);
    expect(oversized.status).toBe(413);

    vi.mocked(listManualNewsLeads).mockRejectedValueOnce(new Error('D1 token=SENTINEL-READ'));
    const internal = await handleManualNewsLeadsApi(
      request('/api/digest/daily-news-leads?date=2026-08-11'), env(), { waitUntil() {} } as never,
    );
    expect(internal.status).toBe(500);
    expect(await internal.text()).not.toContain('SENTINEL-READ');
  });
});
