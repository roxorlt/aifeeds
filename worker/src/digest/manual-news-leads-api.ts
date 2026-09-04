import type { Env } from '../index';
import {
  manualNewsResponseKeyring,
  manualNewsVerificationKeyring,
} from '../security/manual-news-keyring';
import {
  assertManualNewsLeadCandidate,
  confirmManualNewsLeadCandidate,
  getManualNewsCandidateAuthorization,
  getManualNewsLead,
  getManualNewsLeadCandidateState,
  listManualNewsLeads,
  manualNewsLeadProcessingOwner,
  markManualNewsLeadEnqueueFailure,
  recoverStaleManualNewsLeads,
  listManualNewsCandidateAuthorizations,
  retryManualNewsLead,
  submitManualNewsLead,
  vouchManualNewsLeadCandidate,
  type ManualNewsCandidateAuthorizationView,
} from './manual-news-leads-store';
import { newsReviewSecret } from './news-review';
import {
  MANUAL_NEWS_SOURCE_SUPPORT_POLICY,
  type ManualNewsEvidence,
} from './manual-news-leads';
import type { ManualNewsLeadRecord, ManualNewsLeadSummary } from './manual-news-leads-pipeline';
import { isTweetEvidenceAudit } from '../security/safe-url-fetch';

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

const UNAUTHORIZED_CANDIDATE_VIEW: ManualNewsCandidateAuthorizationView = {
  candidate_authorization: null, vouch: null,
};

function manualNewsLeadSummary(
  lead: ManualNewsListInput,
  authorization: ManualNewsCandidateAuthorizationView = UNAUTHORIZED_CANDIDATE_VIEW,
) {
  return {
    ...manualNewsLeadBase(lead),
    evidence_count: 'evidence_count' in lead ? lead.evidence_count : lead.evidence.length,
    ...authorization,
  };
}

export function manualNewsEvidenceDetail(item: ManualNewsEvidence) {
  // 证据种类从已持久化的 fetch_audit 派生,不新增持久化字段:
  // 推文证据的 audit 形状与网页直抓完全不同(kind='tweet_api',无 hops/IP),
  // 呈现层据此把「推文证据」与「网页证据」分开,而不是让 owner 从 URL 里猜。
  const tweet = isTweetEvidenceAudit(item.fetch_audit);
  // 官方账号推文(白名单命中,2026-09-03)与普通推文分开标注:前者与官网公告同级,
  // owner 在证据列表里要一眼看出来。
  const officialAccount = tweet && item.reliable && item.source_type === 'official_primary';
  return {
    id: item.id,
    url: item.url,
    source_type: item.source_type,
    evidence_kind: tweet ? 'tweet_api' : 'web',
    source_label: tweet
      ? (officialAccount ? 'X/Twitter 官方账号推文（ScrapeBadger）' : 'X/Twitter 推文（ScrapeBadger）')
      : '网页',
    publisher: item.publisher,
    published_at: item.published_at,
    retrieved_at: item.retrieved_at,
    title: item.title,
    excerpt: item.excerpt,
    reliable: item.reliable,
  };
}

async function manualNewsLeadDetail(env: Env, lead: ManualNewsLeadRecord) {
  return {
    response_profile: 'manual_news_lead_detail_v1' as const,
    schema_version: 1 as const,
    ...manualNewsLeadBase(lead),
    ...await getManualNewsCandidateAuthorization(env, lead.id),
    ...(lead.assessment_generation ? { assessment_generation: lead.assessment_generation } : {}),
    ...(lead.provider_failure ? { provider_failure: lead.provider_failure } : {}),
    assessment: lead.assessment,
    evidence: lead.evidence.slice(0, 8).filter((item) => {
      const codePoints = Array.from(item.excerpt).length;
      return codePoints > 0 && codePoints <= 3_000
        && new TextEncoder().encode(item.excerpt).byteLength <= 12_000;
    }).map(manualNewsEvidenceDetail),
  };
}

async function manualNewsMutationResult<T extends { lead?: ManualNewsLeadRecord }>(
  env: Env,
  result: T,
) {
  return {
    ...result,
    ...(result.lead ? { lead: await manualNewsLeadDetail(env, result.lead) } : {}),
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

/**
 * owner 直接录入只需要签名密钥：搜索 / 取证 / 大模型全都不参与。
 * 取证链路挂掉正是这条通道存在的理由，不能跟着一起 503。
 */
function signingKeysAvailable(env: Env): boolean {
  try {
    manualNewsResponseKeyring(env);
    manualNewsVerificationKeyring(env);
    return true;
  } catch {
    return false;
  }
}

function processingDependenciesAvailable(env: Env): boolean {
  if (!(
    env.MANUAL_NEWS_LEAD_WORKFLOW
    && env.MANUAL_NEWS_RESEARCH_ORIGIN
    && env.MANUAL_NEWS_RESEARCH_TOKEN
    && env.DEEPSEEK_API_KEY
  )) return false;
  try {
    manualNewsResponseKeyring(env);
    manualNewsVerificationKeyring(env);
    return true;
  } catch {
    return false;
  }
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
    || code === 'invalid_candidate_authorization' || code === 'invalid_owner_asserted'
    || code === 'invalid_vouch_statement'
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
      const [leads, candidateBatch, authorizations] = await Promise.all([
        listManualNewsLeads(env, date),
        getManualNewsLeadCandidateState(env, date),
        listManualNewsCandidateAuthorizations(env, date),
      ]);
      return response({
        ok: true,
        response_profile: 'manual_news_leads_summary_v1',
        schema_version: 1,
        date,
        leads: leads.slice(0, 50).map((lead) => manualNewsLeadSummary(lead, authorizations.get(lead.id))),
        candidate_batch: candidateBatch,
      });
    }
    if (request.method !== 'POST') return response({ ok: false, error: 'method_not_allowed' }, 405);
    const key = idempotencyKey(request);
    if (!key) return response({ ok: false, error: 'invalid_idempotency_key' }, 400);
    try {
      const body = await jsonBody(request);
      if ('owner_asserted' in body && typeof body.owner_asserted !== 'boolean') {
        throw new Error('invalid_owner_asserted');
      }
      if (body.owner_asserted === true) {
        // owner 直接录入：不派发 Workflow、不做任何取证，一步入池，所以是 200 不是 202。
        if (!signingKeysAvailable(env)) return response({ ok: false, error: 'dependency_unavailable' }, 503);
        const asserted = await assertManualNewsLeadCandidate(env, {
          date: body.date,
          text: body.text,
          url: body.url,
          note: body.note,
          ...('statement' in body ? { statement: body.statement } : {}),
          ...('expected_batch_revision' in body
            ? { expected_batch_revision: body.expected_batch_revision }
            : {}),
        }, key, now);
        return response(
          await manualNewsMutationResult(env, asserted),
          asserted.ok ? 200 : asserted.status,
        );
      }
      if (!processingDependenciesAvailable(env)) {
        return response({ ok: false, error: 'dependency_unavailable' }, 503);
      }
      if ('candidate_authorization' in body
        && body.candidate_authorization !== MANUAL_NEWS_SOURCE_SUPPORT_POLICY) {
        throw new Error('invalid_candidate_authorization');
      }
      const result = await submitManualNewsLead(env, {
        date: body.date,
        text: body.text,
        url: body.url,
        note: body.note,
        ...('candidate_authorization' in body
          ? { candidate_authorization: body.candidate_authorization }
          : {}),
      }, key, now);
      if (result.created) scheduleLeadProcessing(env, ctx, result.lead);
      return response({
        ok: true, created: result.created, lead: await manualNewsLeadDetail(env, result.lead),
      }, result.created ? 202 : 200);
    } catch (error) {
      return requestErrorResponse(error);
    }
  }

  const match = /^\/(ml-\d{8}-[a-f0-9]{12})(?:\/(retry|confirm-candidate|vouch-candidate))?$/.exec(suffix);
  if (!match) return response({ ok: false, error: 'not_found' }, 404);
  const [, leadId, action] = match;
  if (!action) {
    if (request.method !== 'GET') return response({ ok: false, error: 'method_not_allowed' }, 405);
    const lead = await getManualNewsLead(env, leadId);
    return lead
      ? response({ ok: true, lead: await manualNewsLeadDetail(env, lead) })
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
    if (!result.ok) return response(await manualNewsMutationResult(env, result), result.status);
    if (result.changed) scheduleLeadProcessing(env, ctx, result.lead);
    return response(await manualNewsMutationResult(env, result), result.changed ? 202 : 200);
  }
  const expectedBatchRevision = Number(body.expected_batch_revision);
  if (!Number.isInteger(expectedBatchRevision) || expectedBatchRevision < 0) {
    return response({ ok: false, error: 'invalid_expected_batch_revision' }, 400);
  }
  const result = action === 'vouch-candidate'
    ? await vouchManualNewsLeadCandidate(
      env, leadId, expectedVersion, expectedBatchRevision, body.statement, key, now,
    )
    : await confirmManualNewsLeadCandidate(
      env, leadId, expectedVersion, expectedBatchRevision, key, now,
    );
  return result.ok
    ? response(await manualNewsMutationResult(env, result))
    : response(await manualNewsMutationResult(env, result), result.status);
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
