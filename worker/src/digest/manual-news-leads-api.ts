import type { Env } from '../index';
import {
  confirmManualNewsLeadCandidate,
  getManualNewsLead,
  getManualNewsLeadCandidateState,
  listManualNewsLeads,
  retryManualNewsLead,
  submitManualNewsLead,
} from './manual-news-leads-store';
import { processManualNewsLeadWithEnv } from './manual-news-leads-runtime';
import { newsReviewSecret } from './news-review';

const MAX_BODY_BYTES = 16 * 1024;
const BASE_PATH = '/api/digest/daily-news-leads';

function scheduleLeadProcessing(
  env: Env,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  lead: { id: string; version: number },
): void {
  const pending = env.MANUAL_NEWS_LEAD_WORKFLOW
    ? env.MANUAL_NEWS_LEAD_WORKFLOW.create({
        id: `manual-news-${lead.id}-v${lead.version}`,
        params: { lead_id: lead.id },
      }).then(() => undefined).catch(() => processManualNewsLeadWithEnv(env, lead.id))
    : processManualNewsLeadWithEnv(env, lead.id);
  ctx.waitUntil(pending);
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
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_json');
  return parsed as Record<string, unknown>;
}

export async function handleManualNewsLeadsApi(
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
      const [leads, candidateBatch] = await Promise.all([
        listManualNewsLeads(env, date),
        getManualNewsLeadCandidateState(env, date),
      ]);
      return response({ ok: true, date, leads, candidate_batch: candidateBatch });
    }
    if (request.method !== 'POST') return response({ ok: false, error: 'method_not_allowed' }, 405);
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
      const code = error instanceof Error ? error.message : 'invalid_request';
      return response({ ok: false, error: code }, code === 'request_too_large' ? 413 : 400);
    }
  }

  const match = /^\/(ml-\d{8}-[a-f0-9]{12})(?:\/(retry|confirm-candidate))?$/.exec(suffix);
  if (!match) return response({ ok: false, error: 'not_found' }, 404);
  const [, leadId, action] = match;
  if (!action) {
    if (request.method !== 'GET') return response({ ok: false, error: 'method_not_allowed' }, 405);
    const lead = await getManualNewsLead(env, leadId);
    return lead ? response({ ok: true, lead }) : response({ ok: false, error: 'manual_news_lead_not_found' }, 404);
  }
  if (request.method !== 'POST') return response({ ok: false, error: 'method_not_allowed' }, 405);
  const key = idempotencyKey(request);
  if (!key) return response({ ok: false, error: 'invalid_idempotency_key' }, 400);
  let body: Record<string, unknown>;
  try {
    body = await jsonBody(request);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'invalid_json';
    return response({ ok: false, error: code }, code === 'request_too_large' ? 413 : 400);
  }
  const expectedVersion = Number(body.expected_version);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return response({ ok: false, error: 'invalid_expected_version' }, 400);
  }
  if (action === 'retry') {
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
