import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./news-review', () => ({
  createNewsReviewToken: vi.fn(async () => 'newer-token'),
  getActiveNewsReviewBatch: vi.fn(),
  getAppliedNewsReviewSelection: vi.fn(),
  getPublishedNewsReviewSelection: vi.fn(),
  getNewsReviewBatch: vi.fn(),
  markNewsReviewPublished: vi.fn(),
  newsReviewSecret: vi.fn((env) => env.DAILY_NEWS_REVIEW_SECRET || ''),
  sanitizeCurrentNewsReviewBatch: vi.fn(),
  submitNewsReviewSelection: vi.fn(),
  verifyNewsReviewTokenSignature: vi.fn(async () => true),
}));
vi.mock('./codex-push', () => ({
  getDailyStageState: vi.fn(),
  pushDailyStageToCodex: vi.fn(),
}));
vi.mock('./daily-page-run', () => ({ generateDailyPage: vi.fn() }));

import { handleDailyNewsReviewApi } from './news-review-api';
import {
  getActiveNewsReviewBatch,
  getAppliedNewsReviewSelection,
  getPublishedNewsReviewSelection,
  getNewsReviewBatch,
  markNewsReviewPublished,
  sanitizeCurrentNewsReviewBatch,
  submitNewsReviewSelection,
} from './news-review';
import { getDailyStageState, pushDailyStageToCodex } from './codex-push';
import { generateDailyPage } from './daily-page-run';

const batch = {
  review_date: '2026-07-30',
  batch_id: 'nr-20260730-abcdef123456',
  candidate_ids: Array.from({ length: 10 }, (_, index) => `news-${index + 1}`),
  candidates: Array.from({ length: 10 }, (_, index) => ({
    item_id: `news-${index + 1}`, title: `标题${index + 1}`, summary: `摘要${index + 1}`, source: '来源', score: 10 - index,
  })),
  default_selected_ids: ['news-1', 'news-2', 'news-3', 'news-4', 'news-5'],
  applied_selected_ids: null,
  selection_hash: null,
  edit_revision: 0,
  publish_status: 'not_requested',
  publish_error: null,
  published_at: null,
  notified_at: 1,
  notification_hash: 'nr-20260730-abcdef123456',
  superseded_by: null,
  created_at: 1,
  expires_at: Date.parse('2026-07-30T16:00:00Z'),
} as const;

function env() {
  return { DAILY_NEWS_REVIEW_SECRET: 'shared-secret' } as never;
}

function request(method: string, body?: unknown, auth = true) {
  return new Request('https://api.example.test/api/digest/daily-news-review?date=2026-07-30&batch=nr-20260730-abcdef123456&token=capability', {
    method,
    headers: {
      ...(auth ? { Authorization: 'Bearer shared-secret' } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function currentBatchRequest(auth = true) {
  return new Request('https://api.example.test/api/digest/daily-news-review?date=2026-07-30', {
    method: 'GET',
    headers: auth ? { Authorization: 'Bearer shared-secret' } : {},
  });
}

describe('daily news review API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getNewsReviewBatch).mockResolvedValue(batch as never);
    vi.mocked(getActiveNewsReviewBatch).mockResolvedValue(batch as never);
    vi.mocked(getAppliedNewsReviewSelection).mockResolvedValue(null);
    vi.mocked(getPublishedNewsReviewSelection).mockResolvedValue(batch.default_selected_ids as never);
    vi.mocked(sanitizeCurrentNewsReviewBatch).mockResolvedValue({
      batch, changed: false, dropped_ids: [],
    } as never);
    vi.mocked(pushDailyStageToCodex).mockResolvedValue({ ok: true } as never);
    vi.mocked(generateDailyPage).mockResolvedValue({} as never);
  });

  test('rejects requests that do not carry the HK-to-CF bearer secret', async () => {
    const response = await handleDailyNewsReviewApi(request('GET', undefined, false), env());
    expect(response.status).toBe(401);
    expect(getNewsReviewBatch).not.toHaveBeenCalled();
  });

  test('GET returns the immutable batch and effective production selection', async () => {
    const reviewedBatch = {
      ...batch,
      applied_selected_ids: ['news-6', 'news-2', 'news-7'],
      edit_revision: 2,
      publish_status: 'published',
    };
    vi.mocked(getNewsReviewBatch).mockResolvedValue(reviewedBatch as never);
    vi.mocked(sanitizeCurrentNewsReviewBatch).mockResolvedValue({
      batch: reviewedBatch, changed: false, dropped_ids: [],
    } as never);
    vi.mocked(getPublishedNewsReviewSelection).mockResolvedValue(reviewedBatch.applied_selected_ids);
    vi.mocked(getDailyStageState).mockResolvedValue({
      stage: 'editorial', revision: 7, content_hash: `sha256:${'a'.repeat(64)}`, pushed_at: 123,
    } as never);
    const response = await handleDailyNewsReviewApi(request('GET'), env(), Date.parse('2026-07-30T08:00:00Z'));
    const payload = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(200);
    expect(payload.read_only).toBe(false);
    expect(payload.candidates).toHaveLength(10);
    expect(payload.published_selected_ids).toEqual(['news-6', 'news-2', 'news-7']);
    expect(payload.generation_target).toEqual({
      review_revision: 2,
      editorial_revision: 7,
      editorial_content_hash: `sha256:${'a'.repeat(64)}`,
    });
  });

  test('GET returns a newly sanitized immutable revision without exposing an invalid manual snapshot', async () => {
    const manual = {
      item_id: 'blog:manual:ml-invalid', title: '失效线索', summary: '失效摘要',
      source: '手工', score: 90, origin: 'manual_lead', lead_id: 'ml-invalid',
    };
    const requested = {
      ...batch,
      candidates: [...batch.candidates.slice(0, 9), manual],
      candidate_ids: [...batch.candidate_ids.slice(0, 9), manual.item_id],
      batch_revision: 2,
      lineage_id: '2026-07-30',
      is_current: true,
    };
    const refreshed = {
      ...requested,
      batch_id: 'nr-20260730-fedcba654321',
      candidates: requested.candidates.filter((candidate) => candidate.item_id !== manual.item_id),
      candidate_ids: requested.candidate_ids.filter((id) => id !== manual.item_id),
      batch_revision: 3,
      supersedes_batch_id: requested.batch_id,
    };
    vi.mocked(getNewsReviewBatch).mockResolvedValue(requested as never);
    vi.mocked(sanitizeCurrentNewsReviewBatch).mockResolvedValue({
      batch: refreshed, changed: true, dropped_ids: [manual.item_id],
    } as never);
    vi.mocked(getPublishedNewsReviewSelection).mockResolvedValue(refreshed.default_selected_ids as never);

    const response = await handleDailyNewsReviewApi(request('GET'), env(), Date.parse('2026-07-30T08:00:00Z'));
    const payload = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(200);
    expect(payload.batch_id).toBe(refreshed.batch_id);
    expect(payload.candidate_revision).toBe(3);
    expect(payload.candidates).not.toEqual(expect.arrayContaining([expect.objectContaining({ lead_id: 'ml-invalid' })]));
  });

  test('GET never exposes a manual snapshot from a superseded revision', async () => {
    const manual = {
      item_id: 'blog:manual:ml-stale-history', title: '历史线索', summary: '历史摘要',
      source: '手工', score: 90, origin: 'manual_lead', lead_id: 'ml-stale-history',
    };
    const requested = {
      ...batch,
      candidates: [...batch.candidates.slice(0, 9), manual],
      candidate_ids: [...batch.candidate_ids.slice(0, 9), manual.item_id],
      superseded_by: 'nr-20260730-fedcba654321',
      batch_revision: 2,
      lineage_id: '2026-07-30',
      is_current: false,
    };
    const refreshed = {
      ...batch,
      batch_id: 'nr-20260730-fedcba654321',
      batch_revision: 3,
      lineage_id: '2026-07-30',
      is_current: true,
    };
    vi.mocked(getNewsReviewBatch).mockResolvedValue(requested as never);
    vi.mocked(sanitizeCurrentNewsReviewBatch).mockResolvedValue({
      batch: refreshed, changed: false, dropped_ids: [],
    } as never);

    const response = await handleDailyNewsReviewApi(request('GET'), env(), Date.parse('2026-07-30T08:00:00Z'));
    const payload = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(200);
    expect(payload.batch_id).toBe(requested.batch_id);
    expect(payload.superseded).toBe(true);
    expect(payload.read_only).toBe(true);
    expect(payload.newer_batch).toEqual(expect.objectContaining({ batch_id: refreshed.batch_id }));
    expect(payload.candidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ lead_id: 'ml-stale-history' }),
    ]));
  });

  test('authenticated HK may resolve the active review link without a PushDeer capability', async () => {
    const response = await handleDailyNewsReviewApi(currentBatchRequest(), env(), Date.parse('2026-07-30T08:00:00Z'));
    const payload = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      date: '2026-07-30',
      batch_id: batch.batch_id,
    });
    expect(payload.review_url).toBe(
      `https://ai-feeds.cc/aifeeds/latest/?review_date=2026-07-30&review_batch=${batch.batch_id}&review_token=newer-token#news-review`,
    );
    expect(getActiveNewsReviewBatch).toHaveBeenCalledWith(expect.anything(), '2026-07-30');
  });

  test('changed submission pushes editorial and finalizes only when papers are ready', async () => {
    const changedBatch = {
      ...batch,
      applied_selected_ids: ['news-6', 'news-2', 'news-7', 'news-1', 'news-5'],
      selection_hash: 'selection-hash',
      edit_revision: 1,
      publish_status: 'pending',
    };
    vi.mocked(submitNewsReviewSelection).mockResolvedValue({
      ok: true, changed: true, retry_publish: true, batch: changedBatch, selected_ids: changedBatch.applied_selected_ids,
    } as never);
    vi.mocked(getDailyStageState).mockResolvedValue({ stage: 'papers', revision: 3, pushed_at: 123 } as never);
    vi.mocked(pushDailyStageToCodex).mockImplementation(async (_env, stage) => ({
      ok: true,
      stage,
      revision: stage === 'editorial' ? 7 : 4,
      content_hash: `sha256:${stage === 'editorial' ? 'a' : 'b'}`.padEnd(71, stage === 'editorial' ? 'a' : 'b'),
      codex_id: 'daily-20260730',
    }) as never);

    const response = await handleDailyNewsReviewApi(request('POST', {
      selected_ids: changedBatch.applied_selected_ids,
    }), env(), Date.parse('2026-07-30T08:00:00Z'));

    expect(response.status).toBe(200);
    expect(vi.mocked(pushDailyStageToCodex).mock.calls.map((call) => call[1])).toEqual(['editorial', 'finalize']);
    expect(generateDailyPage).toHaveBeenCalledWith(expect.anything(), '2026-07-30');
    expect(markNewsReviewPublished).toHaveBeenCalledWith(
      expect.anything(), '2026-07-30', batch.batch_id, 'selection-hash',
    );
    await expect(response.clone().json()).resolves.toMatchObject({
      generation_target: {
        review_revision: 1,
        editorial_revision: 7,
        finalize_revision: 4,
        codex_id: 'daily-20260730',
      },
    });
  });

  test('revalidates the selected batch immediately before downstream generation', async () => {
    const manualId = 'blog:manual:ml-finalize-stale';
    const changedBatch = {
      ...batch,
      candidate_ids: [...batch.candidate_ids.slice(0, 9), manualId],
      candidates: [...batch.candidates.slice(0, 9), {
        item_id: manualId, title: 'manual', summary: 'manual', source: 'manual', score: 80,
        origin: 'manual_lead', lead_id: 'ml-finalize-stale',
      }],
      applied_selected_ids: [manualId, 'news-1'],
      selection_hash: 'selection-hash', edit_revision: 1, publish_status: 'pending',
    };
    const refreshed = {
      ...changedBatch,
      batch_id: 'nr-20260730-111111111111',
      candidate_ids: changedBatch.candidate_ids.filter((id) => id !== manualId),
      candidates: changedBatch.candidates.filter((candidate) => candidate.item_id !== manualId),
      applied_selected_ids: ['news-1'],
    };
    vi.mocked(submitNewsReviewSelection).mockResolvedValue({
      ok: true, changed: true, retry_publish: true, batch: changedBatch,
      selected_ids: changedBatch.applied_selected_ids,
    } as never);
    vi.mocked(sanitizeCurrentNewsReviewBatch).mockResolvedValue({
      batch: refreshed, changed: true, dropped_ids: [manualId],
    } as never);

    const response = await handleDailyNewsReviewApi(request('POST', {
      selected_ids: changedBatch.applied_selected_ids,
    }), env(), Date.parse('2026-07-30T08:00:00Z'));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: 'stale_candidate' });
    expect(pushDailyStageToCodex).not.toHaveBeenCalled();
  });

  test('same default selection is a no-op and never regenerates downstream assets', async () => {
    vi.mocked(submitNewsReviewSelection).mockResolvedValue({
      ok: true, changed: false, retry_publish: false, batch, selected_ids: batch.default_selected_ids,
    } as never);

    const response = await handleDailyNewsReviewApi(request('POST', {
      selected_ids: batch.default_selected_ids,
    }), env(), Date.parse('2026-07-30T08:00:00Z'));
    const payload = await response.json<{ changed: boolean }>();

    expect(response.status).toBe(200);
    expect(payload.changed).toBe(false);
    expect(pushDailyStageToCodex).not.toHaveBeenCalled();
    expect(generateDailyPage).not.toHaveBeenCalled();
  });
});
