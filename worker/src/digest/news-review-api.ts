import type { Env } from '../index';
import {
  createNewsReviewToken,
  authorizeNewsReviewBatchSnapshot,
  getActiveNewsReviewBatch,
  getPublishedNewsReviewSelection,
  getNewsReviewBatch,
  markNewsReviewPending,
  markNewsReviewPublished,
  newsReviewSecret,
  sanitizeCurrentNewsReviewBatch,
  submitNewsReviewSelection,
  verifyNewsReviewTokenSignature,
} from './news-review';
import { buildStagedDailyCodexPayload, getDailyStageState, pushDailyStageToCodex } from './codex-push';
import { generateDailyPage } from './daily-page-run';
import { bjtDateStr } from './lib';

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

function isManualCandidate(candidate: {
  item_id: string;
  origin?: string;
  lead_id?: string;
}): boolean {
  return candidate.origin === 'manual_lead'
    || !!candidate.lead_id
    || candidate.item_id.startsWith('blog:manual:')
    || candidate.item_id.startsWith('manual-news:');
}

function containsManualCandidate(batch: { candidates: Parameters<typeof isManualCandidate>[0][] }): boolean {
  return batch.candidates.some(isManualCandidate);
}

function finalizeBindsEditorialTarget(
  finalize: Awaited<ReturnType<typeof getDailyStageState>>,
  editorial: Awaited<ReturnType<typeof getDailyStageState>>,
): boolean {
  const reference = finalize?.final_manifest?.stage_revisions.editorial;
  return !!reference && !!editorial
    && reference.revision === editorial.revision
    && reference.content_hash === editorial.content_hash;
}

function editorialBindsActiveReview(
  editorial: Awaited<ReturnType<typeof getDailyStageState>>,
  batch: Awaited<ReturnType<typeof getActiveNewsReviewBatch>>,
): boolean {
  const snapshot = editorial?.snapshot?.meta?.news_review;
  const selectedIds = batch?.applied_selected_ids;
  return !!snapshot && !!batch?.selection_hash && !!selectedIds
    && snapshot.batch_id === batch.batch_id
    && snapshot.selection_hash === batch.selection_hash
    && snapshot.selected_ids.length === selectedIds.length
    && snapshot.selected_ids.every((id, index) => id === selectedIds[index]);
}

export async function reconcileDailyNewsReviewPublication(
  env: Env,
  date: string,
  now = Date.now(),
): Promise<Record<string, unknown>> {
  if (date !== bjtDateStr(now)) return { ok: true, skipped: 'stale_date' };
  const existing = await getActiveNewsReviewBatch(env, date);
  if (!existing?.applied_selected_ids?.length || !existing.selection_hash) {
    return { ok: true, skipped: 'no_pending_review' };
  }
  if (existing.publish_status === 'published') return { ok: true, skipped: 'already_published' };
  const failPending = async (stage: string, error: string) => {
    const concise = error.slice(0, 500);
    await markNewsReviewPending(env, date, existing.batch_id, existing.selection_hash!, concise);
    return { ok: false, stage, error: concise };
  };
  let stage = 'sanitize';
  try {
    const sanitized = await sanitizeCurrentNewsReviewBatch(env, date, now);
    const batch = sanitized.batch;
    if (batch.batch_id !== existing.batch_id || batch.selection_hash !== existing.selection_hash
      || !batch.applied_selected_ids?.length) {
      return { ok: true, skipped: 'review_superseded' };
    }
    stage = 'editorial';
    const editorial = await pushDailyStageToCodex(env, 'editorial', date, { origin: 'review' });
    if (!editorial.ok) {
      return failPending('editorial', editorial.error || editorial.skipped || 'editorial_push_failed');
    }
    stage = 'papers';
    const papers = await getDailyStageState(env, date, 'papers');
    if (!papers?.pushed_at) return { ok: true, pending: 'papers', editorial };
    stage = 'finalize';
    const finalize = await pushDailyStageToCodex(env, 'finalize', date, { origin: 'review' });
    if (!finalize.ok) {
      return failPending('finalize', finalize.error || finalize.skipped || 'finalize_push_failed');
    }
    stage = 'daily_page';
    await generateDailyPage(env, date);
    stage = 'publish';
    await markNewsReviewPublished(env, date, batch.batch_id, batch.selection_hash!);
    return { ok: true, published: true, editorial, finalize };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failPending(stage, message);
  }
}

export async function handleDailyNewsReviewApi(
  request: Request,
  env: Env,
  now = Date.now(),
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response> {
  if (!authorized(request, env)) return response({ ok: false, error: 'unauthorized' }, 401);
  if (env.DAILY_NEWS_REVIEW_ENABLED !== undefined && env.DAILY_NEWS_REVIEW_ENABLED !== '1') {
    return response({ ok: false, error: 'news_review_disabled' }, 503);
  }
  const url = new URL(request.url);
  const date = url.searchParams.get('date') || '';
  const batchId = url.searchParams.get('batch') || '';
  const token = url.searchParams.get('token') || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return response({ ok: false, error: 'invalid_review_reference' }, 400);
  }
  if (request.method === 'GET' && !batchId && !token) {
    const existing = await getActiveNewsReviewBatch(env, date);
    if (!existing) return response({ ok: false, error: 'review_batch_not_found' }, 404);
    const active = (await sanitizeCurrentNewsReviewBatch(env, date, now)).batch;
    const activeToken = await createNewsReviewToken(newsReviewSecret(env), date, active.batch_id);
    return response({
      ok: true,
      date,
      batch_id: active.batch_id,
      review_url: reviewLink(date, active.batch_id, activeToken),
    });
  }
  if (!/^nr-\d{8}-[a-f0-9]{12}$/.test(batchId)) {
    return response({ ok: false, error: 'invalid_review_reference' }, 400);
  }
  if (!await verifyNewsReviewTokenSignature(newsReviewSecret(env), date, batchId, token)) {
    return response({ ok: false, error: 'invalid_review_token' }, 401);
  }

  if (request.method === 'GET') {
    const requestedBatch = await getNewsReviewBatch(env, date, batchId);
    if (!requestedBatch) return response({ ok: false, error: 'review_batch_not_found' }, 404);
    const sanitized = await sanitizeCurrentNewsReviewBatch(env, date, now);
    const active = sanitized.batch;
    const requestedIsActive = requestedBatch.is_current && requestedBatch.lineage_id === date;
    let batch = requestedIsActive ? active : requestedBatch;
    let authorizationDenied: Array<{ item_id: string; code: string }> = [];
    if (!requestedIsActive) {
      // Historical rows are immutable audit records, not permanent
      // capabilities. Project every historical identity through today's
      // registry/source/item/manual authorization without rewriting the row.
      const authorization = await authorizeNewsReviewBatchSnapshot(
        env, date, requestedBatch, requestedBatch.candidate_ids, 'historical_review_api',
      );
      const allowedIds = new Set(authorization.allowed_ids);
      const hiddenIds = new Set(requestedBatch.candidate_ids.filter((id) => !allowedIds.has(id)));
      authorizationDenied = authorization.decisions
        .filter((decision) => !decision.allowed)
        .map((decision) => ({ item_id: decision.item_id, code: decision.code }));
      batch = {
        ...requestedBatch,
        candidates: requestedBatch.candidates.filter((candidate) => !hiddenIds.has(candidate.item_id)),
        candidate_ids: requestedBatch.candidate_ids.filter((id) => !hiddenIds.has(id)),
        default_selected_ids: requestedBatch.default_selected_ids.filter((id) => !hiddenIds.has(id)),
        applied_selected_ids: requestedBatch.applied_selected_ids?.filter((id) => !hiddenIds.has(id)) ?? null,
        auto_repaired_invalid_ids: [...new Set([
          ...(requestedBatch.auto_repaired_invalid_ids || []),
          ...hiddenIds,
        ])],
      };
    }
    let [publishedSelectedIds, editorialState, finalizeState] = await Promise.all([
      getPublishedNewsReviewSelection(env, date, batch),
      batch.edit_revision > 0 && batch.applied_selected_ids?.length
        ? getDailyStageState(env, date, 'editorial')
        : Promise.resolve(null),
      batch.edit_revision > 0 && batch.applied_selected_ids?.length
        ? getDailyStageState(env, date, 'finalize')
        : Promise.resolve(null),
    ]);
    if (!requestedIsActive || !editorialBindsActiveReview(editorialState, active)) {
      editorialState = null;
      finalizeState = null;
    } else if (!finalizeBindsEditorialTarget(finalizeState, editorialState)) finalizeState = null;
    const authorizationBatch = requestedIsActive ? active : requestedBatch;
    const outwardAuthorization = await authorizeNewsReviewBatchSnapshot(
      env, date, authorizationBatch, authorizationBatch.candidate_ids, 'review_api_final_projection',
    );
    const outwardAllowed = new Set(outwardAuthorization.allowed_ids);
    const outwardHidden = new Set(batch.candidate_ids.filter((id) => !outwardAllowed.has(id)));
    if (outwardHidden.size) {
      batch = {
        ...batch,
        candidates: batch.candidates.filter((candidate) => !outwardHidden.has(candidate.item_id)),
        candidate_ids: batch.candidate_ids.filter((id) => !outwardHidden.has(id)),
        default_selected_ids: batch.default_selected_ids.filter((id) => !outwardHidden.has(id)),
        applied_selected_ids: batch.applied_selected_ids?.filter((id) => !outwardHidden.has(id)) ?? null,
        auto_repaired_invalid_ids: [...new Set([
          ...(batch.auto_repaired_invalid_ids || []),
          ...outwardHidden,
        ])],
      };
      publishedSelectedIds = publishedSelectedIds.filter((id) => outwardAllowed.has(id));
      const deniedById = new Map(authorizationDenied.map((entry) => [entry.item_id, entry]));
      for (const decision of outwardAuthorization.decisions) {
        if (!decision.allowed) deniedById.set(decision.item_id, {
          item_id: decision.item_id,
          code: decision.code,
        });
      }
      authorizationDenied = [...deniedById.values()];
    }
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
      candidate_revision: batch.batch_revision,
      supersedes_batch_id: batch.supersedes_batch_id,
      revision_origin: batch.revision_origin,
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
          finalize_revision: finalizeState?.revision || null,
          finalize_content_hash: finalizeState?.content_hash || '',
        }
        : null,
      auto_repaired_invalid_ids: batch.auto_repaired_invalid_ids,
      authorization_denied: authorizationDenied,
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

  const prePublish = await sanitizeCurrentNewsReviewBatch(env, date, now);
  if (prePublish.batch.batch_id !== submitted.batch.batch_id) {
    const selectedInvalid = submitted.selected_ids.some((id) => prePublish.dropped_ids.includes(id));
    return response({
      ok: false,
      error: selectedInvalid ? 'stale_candidate' : 'review_batch_superseded',
      batch_id: prePublish.batch.batch_id,
      candidate_revision: prePublish.batch.batch_revision,
    }, 409);
  }

  const selectionHash = submitted.batch.selection_hash;
  if (!selectionHash) return response({ ok: false, error: 'selection_hash_missing' }, 409);
  // Commit and prepare the deterministic editorial target before returning. Network delivery is owned by
  // durable reconciliation (waitUntil + five-minute scheduler), never by the browser request lifetime.
  const editorial = await buildStagedDailyCodexPayload(env, 'editorial', {
    date, persistRevision: true, origin: 'review',
  });
  await markNewsReviewPending(env, date, batchId, selectionHash);
  ctx?.waitUntil(
    reconcileDailyNewsReviewPublication(env, date, now)
      .catch((error) => console.error('[daily-news-review] immediate reconciliation failed', error)),
  );
  return response({
    ok: true,
    changed: submitted.changed,
    regenerated: true,
    selected_ids: submitted.selected_ids,
    editorial: {
      ok: true,
      stage: editorial.stage,
      revision: editorial.revision,
      content_hash: editorial.content_hash,
      render_key: editorial.render_key,
    },
    finalize: null,
    finalize_pending: true,
    generation_target: {
      review_revision: submitted.batch.edit_revision,
      editorial_revision: editorial.revision,
      editorial_content_hash: editorial.content_hash,
      finalize_revision: null,
      finalize_content_hash: '',
      codex_id: '',
    },
  }, 202);
}
