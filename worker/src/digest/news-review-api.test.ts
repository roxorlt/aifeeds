import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./news-review', () => ({
  createNewsReviewToken: vi.fn(async () => 'newer-token'),
  getActiveNewsReviewBatch: vi.fn(),
  getAppliedNewsReviewSelection: vi.fn(),
  getPublishedNewsReviewSelection: vi.fn(),
  getNewsReviewBatch: vi.fn(),
  markNewsReviewPublished: vi.fn(),
  newsReviewSecret: vi.fn((env) => env.DAILY_NEWS_REVIEW_SECRET || ''),
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
