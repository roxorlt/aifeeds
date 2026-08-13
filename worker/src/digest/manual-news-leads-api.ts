import type { Env } from '../index';
import {
  confirmManualNewsLeadCandidate,
  getManualNewsLead,
  getManualNewsLeadCandidateState,
  listManualNewsLeads,
  manualNewsLeadProcessingOwner,
  markManualNewsLeadEnqueueFailure,
  recoverStaleManualNewsLeads,
  retryManualNewsLead,
  submitManualNewsLead,
} from './manual-news-leads-store';
import { newsReviewSecret } from './news-review';
import {
  assertManualNewsEvidenceSet,
  isManualNewsVerificationSecretConfigured,
  type ManualNewsEvidence,
} from './manual-news-leads';
import type { ManualNewsLeadRecord, ManualNewsLeadSummary } from './manual-news-leads-pipeline';

const MAX_BODY_BYTES = 16 * 1024;
const BASE_PATH = '/api/digest/daily-news-leads';

type ManualNewsListInput = ManualNewsLeadSummary | ManualNewsLeadRecord;

function manualNewsLeadBase(lead: ManualNewsListInput) {
  return {
    id: lead.id,
    review_date: lead.review_date,
    input_type: lead.input_type,
    input_text: lead.input_text,
    input_url: lead.input_url,
    note: lead.note,
    status: lead.status,
    version: lead.version,
    error_code: lead.error_code,
    error_message: lead.error_message,
    processing_owner: lead.processing_owner,
    processing_attempt: lead.processing_attempt,
    processing_lease_until: lead.processing_lease_until,
    confirmed_batch_id: lead.confirmed_batch_id,
    confirmed_at: lead.confirmed_at,
    created_at: lead.created_at,
    updated_at: lead.updated_at,
  };
}

function manualNewsLeadSummary(lead: ManualNewsListInput) {
  return {
    ...manualNewsLeadBase(lead),
    evidence_count: 'evidence_count' in lead ? lead.evidence_count : lead.evidence.length,
  };
}

function manualNewsEvidenceDetail(item: ManualNewsEvidence) {
  return {
    id: item.id,
    url: item.url,
    source_type: item.source_type,
    publisher: item.publisher,
    published_at: item.published_at,
    retrieved_at: item.retrieved_at,
    title: item.title,
    excerpt: item.excerpt,
    reliable: item.reliable,
  };
}

function manualNewsLeadDetail(lead: ManualNewsLeadRecord) {
  assertManualNewsEvidenceSet(lead.evidence);
  return {
    ...manualNewsLeadBase(lead),
    ...(lead.assessment_generation ? { assessment_generation: lead.assessment_generation } : {}),
    ...(lead.provider_failure ? { provider_failure: lead.provider_failure } : {}),
    assessment: lead.assessment,
    evidence: lead.evidence.map(manualNewsEvidenceDetail),
  };
}

function scheduleLeadProcessing(
  env: Env,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  lead: { id: string; version: number; processing_owner: string | null },
): void {
  if (!env.MANUAL_NEWS_LEAD_WORKFLOW) throw new Error('manual_news_workflow_unavailable');
  const owner = manualNewsLeadProcessingOwner(lead.id, lead.version);
  if (lead.processing_owner !== owner) throw new Error('manual_news_processing_reservation_missing');
  const pending = Promise.resolve().then(() => env.MANUAL_NEWS_LEAD_WORKFLOW!.create({
    id: owner,
    params: { lead_id: lead.id, processing_owner: owner },
  })).then(() => undefined).catch(async (error) => {
    await markManualNewsLeadEnqueueFailure(env, lead.id, lead.version, owner, error);
  });
  ctx.waitUntil(pending);
}

function processingDependenciesAvailable(env: Env): boolean {
  return Boolean(
    env.MANUAL_NEWS_LEAD_WORKFLOW
    && env.MANUAL_NEWS_RESEARCH_ORIGIN
    && env.MANUAL_NEWS_RESEARCH_TOKEN
    && /^[a-f0-9]{64}$/.test(env.MANUAL_NEWS_RESEARCH_RESPONSE_SECRET || '')
    && env.DEEPSEEK_API_KEY
    && isManualNewsVerificationSecretConfigured(env.MANUAL_NEWS_VERIFICATION_SECRET),
  );
}

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
    },
  });
}

function requestErrorResponse(error: unknown): Response {
  const code = error instanceof Error ? error.message : 'internal_error';
  if (code === 'request_too_large') return response({ ok: false, error: code }, 413);
  if (code === 'idempotency_key_reused_with_different_payload') return response({ ok: false, error: code }, 409);
  if (['trusted_research_service_required', 'invalid_trusted_research_origin', 'invalid_trusted_research_token',
    'trusted_research_response_secret_required', 'no_deepseek_key']
    .includes(code)) return response({ ok: false, error: 'dependency_unavailable' }, 503);
  if (code === 'invalid_json' || code === 'invalid_review_date' || code === 'lead_input_required'
    || code.startsWith('unsafe_url:')) return response({ ok: false, error: code }, 400);
  console.error('[manual-news-leads-api] internal request failure', {
    error: error instanceof Error ? error.name : typeof error,
  });
  return response({ ok: false, error: 'internal_error' }, 500);
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

function authorized(request: Request, env: Env): boolean {
  const secret = newsReviewSecret(env);
  const header = request.headers.get('Authorization') || '';
  return !!secret && header.startsWith('Bearer ') && constantTimeEqual(header.slice(7), secret);
}

function validCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return parsed.getUTCFullYear() === Number(match[1])
    && parsed.getUTCMonth() === Number(match[2]) - 1
    && parsed.getUTCDate() === Number(match[3]);
}

function idempotencyKey(request: Request): string | null {
  const key = (request.headers.get('Idempotency-Key') || '').trim();
  return /^[A-Za-z0-9._:-]{6,128}$/.test(key) ? key : null;
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_BODY_BYTES) throw new Error('request_too_large');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error('request_too_large');
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { throw new Error('invalid_json'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_json');
  return parsed as Record<string, unknown>;
}

async function handleManualNewsLeadsApiInternal(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  now = Date.now(),
): Promise<Response> {
  if (!authorized(request, env)) return response({ ok: false, error: 'unauthorized' }, 401);
  if (env.DAILY_NEWS_REVIEW_ENABLED !== undefined && env.DAILY_NEWS_REVIEW_ENABLED !== '1') {
    return response({ ok: false, error: 'news_review_disabled' }, 503);
  }
  const url = new URL(request.url);
  const suffix = url.pathname.slice(BASE_PATH.length);
  if (!url.pathname.startsWith(BASE_PATH) || (suffix && !suffix.startsWith('/'))) {
    return response({ ok: false, error: 'not_found' }, 404);
  }

  if (!suffix) {
    if (request.method === 'GET') {
      const date = url.searchParams.get('date') || '';
      if (!validCalendarDate(date)) return response({ ok: false, error: 'invalid_review_date' }, 400);
      const recovered = processingDependenciesAvailable(env)
        ? await recoverStaleManualNewsLeads(env, date, now)
        : [];
      for (const lead of recovered) scheduleLeadProcessing(env, ctx, lead);
      const [leads, candidateBatch] = await Promise.all([
        listManualNewsLeads(env, date),
        getManualNewsLeadCandidateState(env, date),
      ]);
      return response({
        ok: true, date, leads: leads.slice(0, 50).map(manualNewsLeadSummary), candidate_batch: candidateBatch,
      });
    }
    if (request.method !== 'POST') return response({ ok: false, error: 'method_not_allowed' }, 405);
    if (!processingDependenciesAvailable(env)) return response({ ok: false, error: 'dependency_unavailable' }, 503);
    const key = idempotencyKey(request);
    if (!key) return response({ ok: false, error: 'invalid_idempotency_key' }, 400);
    try {
      const body = await jsonBody(request);
      const result = await submitManualNewsLead(env, {
        date: body.date,
        text: body.text,
        url: body.url,
        note: body.note,
      }, key, now);
      if (result.created) scheduleLeadProcessing(env, ctx, result.lead);
      return response({ ok: true, ...result }, result.created ? 202 : 200);
    } catch (error) {
      return requestErrorResponse(error);
    }
  }

  const match = /^\/(ml-\d{8}-[a-f0-9]{12})(?:\/(retry|confirm-candidate))?$/.exec(suffix);
  if (!match) return response({ ok: false, error: 'not_found' }, 404);
  const [, leadId, action] = match;
  if (!action) {
    if (request.method !== 'GET') return response({ ok: false, error: 'method_not_allowed' }, 405);
    const lead = await getManualNewsLead(env, leadId);
    return lead
      ? response({ ok: true, lead: manualNewsLeadDetail(lead) })
      : response({ ok: false, error: 'manual_news_lead_not_found' }, 404);
  }
  if (request.method !== 'POST') return response({ ok: false, error: 'method_not_allowed' }, 405);
  const key = idempotencyKey(request);
  if (!key) return response({ ok: false, error: 'invalid_idempotency_key' }, 400);
  let body: Record<string, unknown>;
  try {
    body = await jsonBody(request);
  } catch (error) {
    return requestErrorResponse(error);
  }
  const expectedVersion = Number(body.expected_version);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return response({ ok: false, error: 'invalid_expected_version' }, 400);
  }
  if (action === 'retry') {
    if (!processingDependenciesAvailable(env)) return response({ ok: false, error: 'dependency_unavailable' }, 503);
    const result = await retryManualNewsLead(env, leadId, expectedVersion, key, now);
    if (!result.ok) return response(result, result.status);
    if (result.changed) scheduleLeadProcessing(env, ctx, result.lead);
    return response(result, result.changed ? 202 : 200);
  }
  const expectedBatchRevision = Number(body.expected_batch_revision);
  if (!Number.isInteger(expectedBatchRevision) || expectedBatchRevision < 0) {
    return response({ ok: false, error: 'invalid_expected_batch_revision' }, 400);
  }
  const result = await confirmManualNewsLeadCandidate(
    env, leadId, expectedVersion, expectedBatchRevision, key, now,
  );
  return result.ok ? response(result) : response(result, result.status);
}

export async function handleManualNewsLeadsApi(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  now = Date.now(),
): Promise<Response> {
  try {
    return await handleManualNewsLeadsApiInternal(request, env, ctx, now);
  } catch (error) {
    return requestErrorResponse(error);
  }
}
