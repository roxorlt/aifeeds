import { beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('./manual-news-leads-store', () => ({
  assertManualNewsLeadCandidate: vi.fn(),
  beginOwnerAssertedEntry: vi.fn(),
  listStaleManualLeadContentEntries: vi.fn(async () => []),
  confirmManualNewsLeadCandidate: vi.fn(),
  vouchManualNewsLeadCandidate: vi.fn(),
  getManualNewsCandidateAuthorization: vi.fn(),
  listManualNewsCandidateAuthorizations: vi.fn(),
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
vi.mock('./manual-lead-enrichment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./manual-lead-enrichment')>()),
  runManualLeadEnrichment: vi.fn(async () => 'written' as const),
}));
vi.mock('./manual-lead-content-entry', () => ({
  recoverManualLeadContentEntry: vi.fn(async () => ({ pooled: true, stage: 'done', detail: '' })),
}));

import { handleManualNewsLeadsApi } from './manual-news-leads-api';
import {
  assertManualNewsLeadCandidate,
  beginOwnerAssertedEntry,
  listStaleManualLeadContentEntries,
  confirmManualNewsLeadCandidate,
  vouchManualNewsLeadCandidate,
  getManualNewsCandidateAuthorization,
  listManualNewsCandidateAuthorizations,
  getManualNewsLead,
  listManualNewsLeads,
  retryManualNewsLead,
  submitManualNewsLead,
  getManualNewsLeadCandidateState,
  markManualNewsLeadEnqueueFailure,
  recoverStaleManualNewsLeads,
} from './manual-news-leads-store';
import { processManualNewsLeadWithEnv } from './manual-news-leads-runtime';
import { runManualLeadEnrichment } from './manual-lead-enrichment';
import { recoverManualLeadContentEntry } from './manual-lead-content-entry';

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
    vi.mocked(getManualNewsCandidateAuthorization).mockResolvedValue({
      candidate_authorization: null, vouch: null,
    } as never);
    vi.mocked(listManualNewsCandidateAuthorizations).mockResolvedValue(new Map() as never);
    vi.mocked(vouchManualNewsLeadCandidate).mockResolvedValue({
      ok: true, changed: true, lead: record, batch: null,
      pending_initial_freeze: true, rerender_enqueued: false,
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

describe('manual daily news leads API · owner vouch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getManualNewsLead).mockResolvedValue(record as never);
    vi.mocked(listManualNewsLeads).mockResolvedValue([record] as never);
    vi.mocked(recoverStaleManualNewsLeads).mockResolvedValue([] as never);
    vi.mocked(getManualNewsLeadCandidateState).mockResolvedValue({
      batch_id: 'nr-20260811-current000001', revision: 1,
    } as never);
    vi.mocked(getManualNewsCandidateAuthorization).mockResolvedValue({
      candidate_authorization: null, vouch: null,
    } as never);
    vi.mocked(listManualNewsCandidateAuthorizations).mockResolvedValue(new Map() as never);
    vi.mocked(vouchManualNewsLeadCandidate).mockResolvedValue({
      ok: true, changed: true, lead: { ...record, status: 'needs_review', confirmed_at: 100 },
      batch: null, pending_initial_freeze: true, rerender_enqueued: false,
    } as never);
  });

  test('routes the vouch mutation with the statement and its own idempotency key', async () => {
    const response = await handleManualNewsLeadsApi(request(
      `/api/digest/daily-news-leads/${record.id}/vouch-candidate`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'vouch-1' },
        body: JSON.stringify({
          expected_version: 4, expected_batch_revision: 1, statement: 'OpenAI 发布 GPT-6 并向用户开放。',
        }),
      },
    ), env(), { waitUntil() {} } as never);

    const payload = await response.json<Record<string, unknown>>();
    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true, rerender_enqueued: false, pending_initial_freeze: true, batch: null,
    });
    expect(payload.lead).toMatchObject({
      response_profile: 'manual_news_lead_detail_v1', schema_version: 1,
    });
    expect(vouchManualNewsLeadCandidate).toHaveBeenCalledWith(
      expect.anything(), record.id, 4, 1, 'OpenAI 发布 GPT-6 并向用户开放。', 'vouch-1',
      expect.any(Number),
    );
    expect(confirmManualNewsLeadCandidate).not.toHaveBeenCalled();
    expect(processManualNewsLeadWithEnv).not.toHaveBeenCalled();
  });

  test('passes store validation failures through with their status', async () => {
    vi.mocked(vouchManualNewsLeadCandidate).mockResolvedValueOnce({
      ok: false, status: 400, error: 'invalid_vouch_statement',
    } as never);
    const invalid = await handleManualNewsLeadsApi(request(
      `/api/digest/daily-news-leads/${record.id}/vouch-candidate`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'vouch-invalid' },
        body: JSON.stringify({ expected_version: 4, expected_batch_revision: 1, statement: '短' }),
      },
    ), env(), { waitUntil() {} } as never);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ ok: false, status: 400, error: 'invalid_vouch_statement' });

    vi.mocked(vouchManualNewsLeadCandidate).mockResolvedValueOnce({
      ok: false, status: 409, error: 'lead_not_vouchable', lead: record,
    } as never);
    const conflict = await handleManualNewsLeadsApi(request(
      `/api/digest/daily-news-leads/${record.id}/vouch-candidate`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'vouch-conflict' },
        body: JSON.stringify({
          expected_version: 4, expected_batch_revision: 1, statement: 'OpenAI 发布 GPT-6 并向用户开放。',
        }),
      },
    ), env(), { waitUntil() {} } as never);
    expect(conflict.status).toBe(409);
    expect(await conflict.json<{ error: string }>()).toMatchObject({ error: 'lead_not_vouchable' });
  });

  test('rejects a vouch without an idempotency key or with a bad expected batch revision', async () => {
    const missingKey = await handleManualNewsLeadsApi(request(
      `/api/digest/daily-news-leads/${record.id}/vouch-candidate`,
      {
        method: 'POST',
        body: JSON.stringify({
          expected_version: 4, expected_batch_revision: 1, statement: 'OpenAI 发布 GPT-6 并向用户开放。',
        }),
      },
    ), env(), { waitUntil() {} } as never);
    expect(missingKey.status).toBe(400);

    const badRevision = await handleManualNewsLeadsApi(request(
      `/api/digest/daily-news-leads/${record.id}/vouch-candidate`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'vouch-bad-revision' },
        body: JSON.stringify({
          expected_version: 4, statement: 'OpenAI 发布 GPT-6 并向用户开放。',
        }),
      },
    ), env(), { waitUntil() {} } as never);
    expect(badRevision.status).toBe(400);
    expect(await badRevision.json()).toEqual({ ok: false, error: 'invalid_expected_batch_revision' });
    expect(vouchManualNewsLeadCandidate).not.toHaveBeenCalled();
  });

  test('exposes candidate_authorization and the vouch statement on summaries and details', async () => {
    vi.mocked(listManualNewsCandidateAuthorizations).mockResolvedValueOnce(new Map([
      [record.id, {
        candidate_authorization: 'owner_vouched_v1',
        vouch: { statement: 'OpenAI 发布 GPT-6 并向用户开放。', vouched_at: 100 },
      }],
    ]) as never);
    vi.mocked(getManualNewsCandidateAuthorization).mockResolvedValueOnce({
      candidate_authorization: 'owner_vouched_v1',
      vouch: { statement: 'OpenAI 发布 GPT-6 并向用户开放。', vouched_at: 100 },
    } as never);

    const list = await handleManualNewsLeadsApi(
      request('/api/digest/daily-news-leads?date=2026-08-11'), env(), { waitUntil() {} } as never,
    );
    const listPayload = await list.json<{ leads: Array<Record<string, unknown>> }>();
    expect(listPayload.leads[0]).toMatchObject({
      candidate_authorization: 'owner_vouched_v1',
      vouch: { statement: 'OpenAI 发布 GPT-6 并向用户开放。', vouched_at: 100 },
    });
    expect(Object.keys(listPayload.leads[0]).sort())
      .toEqual([...apiContract.list.lead_fields].sort());

    const detail = await handleManualNewsLeadsApi(
      request(`/api/digest/daily-news-leads/${record.id}`), env(), { waitUntil() {} } as never,
    );
    const detailPayload = await detail.json<{ lead: Record<string, unknown> }>();
    expect(detailPayload.lead).toMatchObject({
      candidate_authorization: 'owner_vouched_v1',
      vouch: { statement: 'OpenAI 发布 GPT-6 并向用户开放。', vouched_at: 100 },
    });
    expect(Object.keys(detailPayload.lead)).toEqual(expect.arrayContaining(
      apiContract.detail.lead_required_fields,
    ));
  });

  test('keeps the published client contract in step with the vouch route and fields', () => {
    expect(apiContract.list.lead_fields).toEqual(expect.arrayContaining([
      'candidate_authorization', 'vouch',
    ]));
    expect(apiContract.detail.lead_required_fields).toEqual(expect.arrayContaining([
      'candidate_authorization', 'vouch',
    ]));
    expect((apiContract as unknown as { mutations: { routes: string[] } }).mutations.routes)
      .toEqual(['submit', 'retry', 'confirm-candidate', 'vouch-candidate']);
  });
});

describe('manual daily news leads API · owner asserted direct entry', () => {
  // 一步录入 2026-09-05 起拆成两步：提交只建线索行(202)，内容加工与随后的签名入池都在
  // 后台跑。候选的标题与摘要要由模型从抓回的正文写出来，而它们进的是被签名覆盖的投影
  // —— 签名之前就得确定，所以入池只能等加工跑完。
  const entryLead = {
    ...record, status: 'needs_review', version: 1, confirmed_at: null,
    input_text: 'OpenAI发布Astra', input_url: 'https://openai.com/astra/', note: '早报',
    content_progress: {
      stage: 'submitted', detail: '', material_tier: 'none', deadline_at: 120_100,
    },
  };

  function collectingCtx() {
    const queued: Promise<unknown>[] = [];
    return { queued, ctx: { waitUntil(promise: Promise<unknown>) { queued.push(promise); } } as never };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listStaleManualLeadContentEntries).mockResolvedValue([] as never);
    vi.mocked(getManualNewsLead).mockResolvedValue(entryLead as never);
    vi.mocked(getManualNewsCandidateAuthorization).mockResolvedValue({
      candidate_authorization: null, vouch: null,
    } as never);
    vi.mocked(beginOwnerAssertedEntry).mockResolvedValue({
      ok: true, created: true, lead: entryLead,
    } as never);
    vi.mocked(recoverManualLeadContentEntry).mockResolvedValue({
      pooled: true, stage: 'done', detail: '',
    } as never);
  });

  test('提交只建线索行并立刻返回 202，整轮加工派给 workflow', async () => {
    const { queued, ctx } = collectingCtx();
    const response = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'asserted-1' },
      body: JSON.stringify({
        date: '2026-08-11', text: 'OpenAI发布Astra', owner_asserted: true,
        statement: 'OpenAI发布Astra', note: '早报', url: 'https://openai.com/astra/',
        expected_batch_revision: 3,
      }),
    }), env(), ctx);

    expect(response.status).toBe(202);
    expect(await response.json<Record<string, unknown>>()).toMatchObject({ ok: true, created: true });
    expect(beginOwnerAssertedEntry).toHaveBeenCalledWith(expect.anything(), {
      date: '2026-08-11', text: 'OpenAI发布Astra', url: 'https://openai.com/astra/', note: '早报',
      statement: 'OpenAI发布Astra',
    }, 'asserted-1', expect.any(Number));
    // 入池那一步这时候还没发生 —— API 这一层根本不再引用它，它在 workflow 的最后一步。
    expect(assertManualNewsLeadCandidate).not.toHaveBeenCalled();
    expect(submitManualNewsLead).not.toHaveBeenCalled();
    expect(queued).toHaveLength(1);
    await expect(queued[0]).resolves.toBeUndefined();
    // 派发是一次亚秒级 RPC，可以挂 waitUntil；加工本身一两分钟，挂上去必被回收。
    expect(workflowCreate).toHaveBeenCalledWith({
      // 实例 id 与取证那条路（manual-news-…）分开，两条路共用一个绑定也不撞车。
      id: 'content-ml-20260811-abc123def456',
      params: {
        kind: 'manual_lead_content_entry',
        id: entryLead.id,
        review_date: '2026-08-11',
        input_url: 'https://openai.com/astra/',
        input_text: 'OpenAI发布Astra',
        note: '早报',
        // 后台那一半靠这个键找回同一行续做，两侧必须是同一个值。
        submit_idempotency_key: 'asserted-1',
        submitted_at: expect.any(Number),
      },
    });
  });

  test('卡片要读的加工进度出现在详情里', async () => {
    const response = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'asserted-progress' },
      body: JSON.stringify({ date: '2026-08-11', text: 'OpenAI发布Astra', owner_asserted: true }),
    }), env(), collectingCtx().ctx);

    expect((await response.json<{ lead: Record<string, unknown> }>()).lead).toMatchObject({
      response_profile: 'manual_news_lead_detail_v1',
      content_progress: {
        stage: 'submitted', detail: '', material_tier: 'none', deadline_at: 120_100,
      },
    });
  });

  test('expected_batch_revision 不再往下传：加工跑完再读当前批次版本才是入池该用的口径', async () => {
    await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'asserted-2' },
      body: JSON.stringify({
        date: '2026-08-11', text: 'OpenAI发布Astra', owner_asserted: true,
        expected_batch_revision: 7,
      }),
    }), env(), collectingCtx().ctx);

    expect(beginOwnerAssertedEntry).toHaveBeenCalledWith(expect.anything(), {
      date: '2026-08-11', text: 'OpenAI发布Astra', url: undefined, note: undefined,
    }, 'asserted-2', expect.any(Number));
  });

  test('同一个幂等键重放时回 200，也不再派发第二轮加工', async () => {
    vi.mocked(beginOwnerAssertedEntry).mockResolvedValueOnce({
      ok: true, created: false, lead: entryLead,
    } as never);
    const { queued, ctx } = collectingCtx();
    const response = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'asserted-replay' },
      body: JSON.stringify({ date: '2026-08-11', text: 'OpenAI发布Astra', owner_asserted: true }),
    }), env(), ctx);

    expect(response.status).toBe(200);
    expect(queued).toHaveLength(0);
    expect(workflowCreate).not.toHaveBeenCalled();
  });

  test('建行本身被拒时按 store 给的状态码回，也不派发加工', async () => {
    vi.mocked(beginOwnerAssertedEntry).mockResolvedValueOnce({
      ok: false, status: 400, error: 'invalid_vouch_statement',
    } as never);
    const response = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'asserted-invalid' },
      body: JSON.stringify({ date: '2026-08-11', text: '。。。。。。', owner_asserted: true }),
    }), env(), collectingCtx().ctx);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, status: 400, error: 'invalid_vouch_statement' });
    expect(workflowCreate).not.toHaveBeenCalled();
  });

  test('派发 workflow 失败伤不到已经返回的 202', async () => {
    workflowCreate.mockRejectedValueOnce(new Error('boom') as never);
    const { queued, ctx } = collectingCtx();
    const response = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'asserted-async-boom' },
      body: JSON.stringify({ date: '2026-08-11', text: 'OpenAI发布Astra', owner_asserted: true }),
    }), env(), ctx);

    expect(response.status).toBe(202);
    // 挂上去的那个 promise 自己把异常吃掉，不会变成 worker 的 unhandled rejection。
    await expect(queued[0]).resolves.toBeUndefined();
  });

  test('派发那一刻同步抛异常时同样只影响加工，不影响 202', async () => {
    workflowCreate.mockImplementationOnce(() => {
      throw new Error('workflow binding blew up synchronously');
    });
    const response = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'asserted-sync-boom' },
      body: JSON.stringify({ date: '2026-08-11', text: 'OpenAI发布Astra', owner_asserted: true }),
    }), env(), collectingCtx().ctx);
    expect(response.status).toBe(202);
  });

  test('waitUntil 自己抛异常时也不影响 202', async () => {
    const response = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'asserted-waituntil' },
      body: JSON.stringify({ date: '2026-08-11', text: 'OpenAI发布Astra', owner_asserted: true }),
    }), env(), { waitUntil() { throw new Error('waitUntil unavailable'); } } as never);
    expect(response.status).toBe(202);
  });

  test('rejects a non-boolean owner_asserted instead of silently taking the normal path', async () => {
    const response = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'asserted-bad' },
      body: JSON.stringify({ date: '2026-08-11', text: 'OpenAI发布Astra', owner_asserted: 'yes' }),
    }), env(), collectingCtx().ctx);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: 'invalid_owner_asserted' });
    expect(beginOwnerAssertedEntry).not.toHaveBeenCalled();
    expect(submitManualNewsLead).not.toHaveBeenCalled();
  });

  test('owner_asserted:false keeps the normal research submission path', async () => {
    vi.mocked(submitManualNewsLead).mockResolvedValue({ created: true, lead: record } as never);
    const response = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'asserted-false' },
      body: JSON.stringify({ date: '2026-08-11', text: 'OpenAI发布Astra', owner_asserted: false }),
    }), env(), collectingCtx().ctx);

    expect(response.status).toBe(202);
    expect(submitManualNewsLead).toHaveBeenCalled();
    expect(beginOwnerAssertedEntry).not.toHaveBeenCalled();
  });

  // workflow 绑定缺失时提交仍然要成功：线索先落进库，随后由过期兜底补入池。
  test('取证链路整个挂掉时照样能提交 —— 这条通道存在的理由就是这个', async () => {
    const response = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'asserted-no-deps' },
      body: JSON.stringify({ date: '2026-08-11', text: 'OpenAI发布Astra', owner_asserted: true }),
    }), env({
      MANUAL_NEWS_LEAD_WORKFLOW: undefined, MANUAL_NEWS_RESEARCH_ORIGIN: undefined,
      MANUAL_NEWS_RESEARCH_TOKEN: undefined, DEEPSEEK_API_KEY: undefined,
    }), collectingCtx().ctx);

    expect(response.status).toBe(202);
    expect(beginOwnerAssertedEntry).toHaveBeenCalled();
  });

  test('503s when the signing keys themselves are unavailable', async () => {
    const response = await handleManualNewsLeadsApi(request('/api/digest/daily-news-leads', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'asserted-no-keys' },
      body: JSON.stringify({ date: '2026-08-11', text: 'OpenAI发布Astra', owner_asserted: true }),
    }), env({ MANUAL_NEWS_VERIFICATION_SECRET: undefined }), collectingCtx().ctx);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'dependency_unavailable' });
    expect(beginOwnerAssertedEntry).not.toHaveBeenCalled();
  });

  // 整条 workflow 都没了时才轮到这条兜底。它**直接补入池**，不再从头重跑整轮 ——
  // 重跑只会跟仍在跑的 workflow 抢，还可能把卡片的阶段来回拨（规格第 10.1 节）。
  test('列表 GET 顺手把加工没了下文的线索直接补入池，不重跑加工', async () => {
    vi.mocked(listStaleManualLeadContentEntries).mockResolvedValueOnce([{
      id: 'ml-20260811-stale0000000', input_url: '', input_text: '一句线索', note: '',
      submit_idempotency_key: 'stale-key', review_date: '2026-08-11',
    }] as never);
    vi.mocked(listManualNewsLeads).mockResolvedValue([] as never);
    vi.mocked(getManualNewsLeadCandidateState).mockResolvedValue({} as never);
    vi.mocked(listManualNewsCandidateAuthorizations).mockResolvedValue(new Map() as never);
    const { queued, ctx } = collectingCtx();

    const response = await handleManualNewsLeadsApi(
      request('/api/digest/daily-news-leads?date=2026-08-11'), env(), ctx,
    );

    expect(response.status).toBe(200);
    expect(recoverManualLeadContentEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 'ml-20260811-stale0000000', submit_idempotency_key: 'stale-key',
      }),
      expect.any(Number),
    );
    // 兜底不再派 workflow，也不再重跑加工。
    expect(workflowCreate).not.toHaveBeenCalled();
    await expect(Promise.all(queued)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 补录线索的正文补充（enrichment，2026-09-04）
//
// 最重要的不变量：入池永远不能被补充阻塞或连坐。所以这一组的每一条都在问同一个问题 ——
// 补充这边出任何事，owner 那次确认是不是照样成功返回。
// ---------------------------------------------------------------------------
describe('manual daily news leads API · lead enrichment', () => {
  const assertedZeroEvidence = {
    ...record, status: 'needs_review', confirmed_at: 100, evidence: [],
    input_text: 'OpenAI发布Astra', input_url: 'https://openai.com/astra/',
  };

  function collectingCtx() {
    const queued: Promise<unknown>[] = [];
    return { queued, ctx: { waitUntil(promise: Promise<unknown>) { queued.push(promise); } } as never };
  }

  async function vouchEntry(ctx: unknown, key = 'enrich-vouch-x') {
    return handleManualNewsLeadsApi(request(
      `/api/digest/daily-news-leads/${record.id}/vouch-candidate`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify({
          expected_version: 4, expected_batch_revision: 1, statement: 'OpenAI发布Astra',
        }),
      },
    ), env(), ctx as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runManualLeadEnrichment).mockResolvedValue('written' as never);
    vi.mocked(listStaleManualLeadContentEntries).mockResolvedValue([] as never);
    vi.mocked(getManualNewsLead).mockResolvedValue(assertedZeroEvidence as never);
    vi.mocked(getManualNewsCandidateAuthorization).mockResolvedValue({
      candidate_authorization: 'owner_asserted_v1', vouch: null,
    } as never);
    vi.mocked(vouchManualNewsLeadCandidate).mockResolvedValue({
      ok: true, changed: true, lead: assertedZeroEvidence,
      batch: null, pending_initial_freeze: true, rerender_enqueued: false,
    } as never);
  });

  test('担保之后带着线索的链接与文字去补素材,不让确认等它', async () => {
    const { queued, ctx } = collectingCtx();
    const response = await vouchEntry(ctx, 'enrich-vouch-material');

    expect(response.status).toBe(200);
    expect(runManualLeadEnrichment).toHaveBeenCalledWith(
      expect.anything(),
      {
        leadId: assertedZeroEvidence.id,
        itemId: `blog:manual:${assertedZeroEvidence.id}`,
        url: 'https://openai.com/astra/',
        text: 'OpenAI发布Astra',
        // 审核日期一路传到网关：搜索那一路少了它，网关算检索区间时直接抛
        // Invalid time value，keyed 搜索每次都挂（2026-09-05 规格第 7 节）。
        date: '2026-08-11',
      },
      expect.objectContaining({ fetchPlainText: expect.any(Function), compress: expect.any(Function) }),
    );
    // 挂在 waitUntil 上,不在响应路径里。
    expect(queued).toHaveLength(1);
    await expect(queued[0]).resolves.toBeUndefined();
  });

  test('线索没有链接时 url 传 null,让取材走搜索那条路', async () => {
    vi.mocked(vouchManualNewsLeadCandidate).mockResolvedValueOnce({
      ok: true, changed: true, lead: { ...assertedZeroEvidence, input_url: '' },
      batch: null, pending_initial_freeze: true, rerender_enqueued: false,
    } as never);
    await vouchEntry(collectingCtx().ctx, 'enrich-vouch-nourl');
    expect(runManualLeadEnrichment).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ url: null }), expect.anything(),
    );
  });

  test('补充抛异常时担保仍然成功返回 200', async () => {
    vi.mocked(runManualLeadEnrichment).mockRejectedValueOnce(new Error('gateway exploded') as never);
    const { queued, ctx } = collectingCtx();
    const response = await vouchEntry(ctx, 'enrich-vouch-async-boom');

    expect(response.status).toBe(200);
    expect(await response.json<Record<string, unknown>>()).toMatchObject({ ok: true, changed: true });
    // 挂上去的那个 promise 自己把异常吃掉,不会变成 worker 的 unhandled rejection。
    await expect(queued[0]).resolves.toBeUndefined();
  });

  test('补充在派发那一刻同步抛异常时,担保同样成功返回', async () => {
    vi.mocked(runManualLeadEnrichment).mockImplementationOnce(() => {
      throw new Error('adapters blew up synchronously');
    });
    const response = await vouchEntry(collectingCtx().ctx, 'enrich-vouch-sync-boom');
    expect(response.status).toBe(200);
    expect(await response.json<Record<string, unknown>>()).toMatchObject({ ok: true });
  });

  test('waitUntil 自己抛异常时担保也不受影响', async () => {
    const response = await vouchEntry({
      waitUntil() { throw new Error('waitUntil unavailable'); },
    }, 'enrich-vouch-waituntil');
    expect(response.status).toBe(200);
    expect(await response.json<Record<string, unknown>>()).toMatchObject({ ok: true });
  });

  test('担保失败时不补素材', async () => {
    // 409 也会带回线索本身(store 的既有形状),所以这里只有 ok 那道判断能挡住派发。
    vi.mocked(vouchManualNewsLeadCandidate).mockResolvedValueOnce({
      ok: false, status: 409, error: 'candidate_batch_revision_conflict', lead: assertedZeroEvidence,
    } as never);
    const response = await vouchEntry(collectingCtx().ctx, 'enrich-vouch-conflict');
    expect(response.status).toBe(409);
    expect(runManualLeadEnrichment).not.toHaveBeenCalled();
  });

  test('零证据担保成功后补素材', async () => {
    await handleManualNewsLeadsApi(request(
      `/api/digest/daily-news-leads/${record.id}/vouch-candidate`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'enrich-vouch-1' },
        body: JSON.stringify({
          expected_version: 4, expected_batch_revision: 1, statement: 'OpenAI发布Astra',
        }),
      },
    ), env(), collectingCtx().ctx);
    expect(runManualLeadEnrichment).toHaveBeenCalledTimes(1);
  });

  test('已有签名证据的线索不触发 —— 它的摘要本来就是核验过的正文', async () => {
    vi.mocked(vouchManualNewsLeadCandidate).mockResolvedValueOnce({
      ok: true, changed: true,
      lead: { ...assertedZeroEvidence, evidence: [{ id: 'ev-1' }] },
      batch: null, pending_initial_freeze: true, rerender_enqueued: false,
    } as never);
    await handleManualNewsLeadsApi(request(
      `/api/digest/daily-news-leads/${record.id}/vouch-candidate`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'enrich-vouch-2' },
        body: JSON.stringify({
          expected_version: 4, expected_batch_revision: 1, statement: 'OpenAI发布Astra',
        }),
      },
    ), env(), collectingCtx().ctx);
    expect(runManualLeadEnrichment).not.toHaveBeenCalled();
  });

  test('确认（confirm-candidate）那条路不触发', async () => {
    vi.mocked(confirmManualNewsLeadCandidate).mockResolvedValue({
      ok: true, lead: assertedZeroEvidence,
      batch: { batch_id: 'nr-20260811-abcdef123456', revision: 2, supersedes_revision: 1, current: true },
      rerender_enqueued: false,
    } as never);
    await handleManualNewsLeadsApi(request(
      `/api/digest/daily-news-leads/${record.id}/confirm-candidate`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'enrich-confirm-1' },
        body: JSON.stringify({ expected_version: 4, expected_batch_revision: 1 }),
      },
    ), env(), collectingCtx().ctx);
    expect(runManualLeadEnrichment).not.toHaveBeenCalled();
  });
});
