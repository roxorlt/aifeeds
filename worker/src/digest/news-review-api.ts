import type { Env } from '../index';
import {
  createNewsReviewToken,
  getActiveNewsReviewBatch,
  getPublishedNewsReviewSelection,
  getNewsReviewBatch,
  markNewsReviewPublished,
  newsReviewSecret,
  submitNewsReviewSelection,
  verifyNewsReviewTokenSignature,
} from './news-review';
import { getDailyStageState, pushDailyStageToCodex } from './codex-push';
import { generateDailyPage } from './daily-page-run';

const MAX_REVIEW_BODY_BYTES = 8 * 1024;

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

function reviewLink(date: string, batch: string, token: string): string {
  const url = new URL('https://ai-feeds.cc/aifeeds/latest/');
  url.searchParams.set('review_date', date);
  url.searchParams.set('review_batch', batch);
  url.searchParams.set('review_token', token);
  url.hash = 'news-review';
  return url.toString();
}

export async function handleDailyNewsReviewApi(
  request: Request,
  env: Env,
  now = Date.now(),
): Promise<Response> {
  if (!authorized(request, env)) return response({ ok: false, error: 'unauthorized' }, 401);
  if (env.DAILY_NEWS_REVIEW_ENABLED !== undefined && env.DAILY_NEWS_REVIEW_ENABLED !== '1') {
    return response({ ok: false, error: 'news_review_disabled' }, 503);
  }
  const url = new URL(request.url);
  const date = url.searchParams.get('date') || '';
  const batchId = url.searchParams.get('batch') || '';
  const token = url.searchParams.get('token') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^nr-\d{8}-[a-f0-9]{12}$/.test(batchId)) {
    return response({ ok: false, error: 'invalid_review_reference' }, 400);
  }
  if (!await verifyNewsReviewTokenSignature(newsReviewSecret(env), date, batchId, token)) {
    return response({ ok: false, error: 'invalid_review_token' }, 401);
  }

  if (request.method === 'GET') {
    const [batch, active] = await Promise.all([
      getNewsReviewBatch(env, date, batchId),
      getActiveNewsReviewBatch(env, date),
    ]);
    if (!batch) return response({ ok: false, error: 'review_batch_not_found' }, 404);
    const [publishedSelectedIds, editorialState] = await Promise.all([
      getPublishedNewsReviewSelection(env, date, batch),
      batch.edit_revision > 0 && batch.applied_selected_ids?.length
        ? getDailyStageState(env, date, 'editorial')
        : Promise.resolve(null),
    ]);
    const expired = now >= batch.expires_at;
    const superseded = !!batch.superseded_by;
    let newerBatch: { batch_id: string; review_url: string } | null = null;
    if (superseded && active && active.batch_id !== batch.batch_id) {
      const newerToken = await createNewsReviewToken(newsReviewSecret(env), date, active.batch_id);
      newerBatch = { batch_id: active.batch_id, review_url: reviewLink(date, active.batch_id, newerToken) };
    }
    return response({
      ok: true,
      date,
      batch_id: batch.batch_id,
      candidates: batch.candidates,
      default_selected_ids: batch.default_selected_ids,
      batch_selected_ids: batch.applied_selected_ids || batch.default_selected_ids,
      published_selected_ids: publishedSelectedIds,
      edit_revision: batch.edit_revision,
      publish_status: batch.publish_status,
      publish_error: batch.publish_error,
      generation_target: batch.edit_revision > 0 && batch.applied_selected_ids?.length
        ? {
          review_revision: batch.edit_revision,
          editorial_revision: editorialState?.revision || null,
          editorial_content_hash: editorialState?.content_hash || '',
        }
        : null,
      auto_repaired_invalid_ids: batch.auto_repaired_invalid_ids,
      expires_at: new Date(batch.expires_at).toISOString(),
      expired,
      superseded,
      read_only: expired || superseded,
      newer_batch: newerBatch,
    });
  }

  if (request.method !== 'POST') return response({ ok: false, error: 'method_not_allowed' }, 405);
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > MAX_REVIEW_BODY_BYTES) return response({ ok: false, error: 'request_too_large' }, 413);
  let body: { selected_ids?: unknown };
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_REVIEW_BODY_BYTES) {
      return response({ ok: false, error: 'request_too_large' }, 413);
    }
    body = JSON.parse(text) as { selected_ids?: unknown };
  } catch {
    return response({ ok: false, error: 'invalid_json' }, 400);
  }
  const submitted = await submitNewsReviewSelection(env, {
    date,
    batch_id: batchId,
    token,
    selected_ids: body.selected_ids,
  }, now);
  if (!submitted.ok) return response(submitted, submitted.status);
  if (!submitted.changed && !submitted.retry_publish) {
    return response({ ok: true, changed: false, regenerated: false, selected_ids: submitted.selected_ids });
  }

  const selectionHash = submitted.batch.selection_hash;
  if (!selectionHash) return response({ ok: false, error: 'selection_hash_missing' }, 409);
  const editorial = await pushDailyStageToCodex(env, 'editorial', date);
  if (!editorial.ok) {
    const error = editorial.error || editorial.skipped || 'editorial_push_failed';
    await markNewsReviewPublished(env, date, batchId, selectionHash, error);
    return response({ ok: false, error, stage: 'editorial' }, 502);
  }

  const papers = await getDailyStageState(env, date, 'papers');
  let finalize: Awaited<ReturnType<typeof pushDailyStageToCodex>> | null = null;
  if (papers?.pushed_at) {
    finalize = await pushDailyStageToCodex(env, 'finalize', date);
    if (!finalize.ok) {
      const error = finalize.error || finalize.skipped || 'finalize_push_failed';
      await markNewsReviewPublished(env, date, batchId, selectionHash, error);
      return response({ ok: false, error, stage: 'finalize', editorial }, 502);
    }
    await generateDailyPage(env, date);
  }
  await markNewsReviewPublished(env, date, batchId, selectionHash);
  return response({
    ok: true,
    changed: submitted.changed,
    regenerated: true,
    selected_ids: submitted.selected_ids,
    editorial,
    finalize,
    finalize_pending: !papers?.pushed_at,
    generation_target: {
      review_revision: submitted.batch.edit_revision,
      editorial_revision: editorial.revision || null,
      editorial_content_hash: editorial.content_hash || '',
      finalize_revision: finalize?.revision || null,
      codex_id: finalize?.codex_id || editorial.codex_id || '',
    },
  }, papers?.pushed_at ? 200 : 202);
}
