import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./news-review', () => ({
  authorizeNewsReviewBatchSnapshot: vi.fn(async (
    env: unknown, date: string, _batch: unknown, ids: readonly string[], purpose: string,
  ) => {
    const policy = await import('./news-source-policy');
    return policy.authorizeFormalNewsSet(env as never, date, ids, purpose);
  }),
  createNewsReviewToken: vi.fn(async () => 'newer-token'),
  getActiveNewsReviewBatch: vi.fn(),
  getAppliedNewsReviewSelection: vi.fn(),
  getPublishedNewsReviewSelection: vi.fn(),
  getNewsReviewBatch: vi.fn(),
  markNewsReviewPending: vi.fn(),
  markNewsReviewPublished: vi.fn(),
  newsReviewSecret: vi.fn((env) => env.DAILY_NEWS_REVIEW_SECRET || ''),
  sanitizeCurrentNewsReviewBatch: vi.fn(),
  submitNewsReviewSelection: vi.fn(),
  verifyNewsReviewTokenSignature: vi.fn(async () => true),
}));
vi.mock('./codex-push', () => ({
  buildStagedDailyCodexPayload: vi.fn(),
  getDailyStageState: vi.fn(),
  pushDailyStageToCodex: vi.fn(),
}));
vi.mock('./daily-page-run', () => ({ generateDailyPage: vi.fn() }));
vi.mock('./news-source-policy', () => ({ authorizeFormalNewsSet: vi.fn() }));

import { handleDailyNewsReviewApi, reconcileDailyNewsReviewPublication } from './news-review-api';
import {
  getActiveNewsReviewBatch,
  getAppliedNewsReviewSelection,
  getPublishedNewsReviewSelection,
  getNewsReviewBatch,
  markNewsReviewPending,
  markNewsReviewPublished,
  sanitizeCurrentNewsReviewBatch,
  submitNewsReviewSelection,
} from './news-review';
import { buildStagedDailyCodexPayload, getDailyStageState, pushDailyStageToCodex } from './codex-push';
import { generateDailyPage } from './daily-page-run';
import { authorizeFormalNewsSet } from './news-source-policy';

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
  human_reviewed: false,
  batch_revision: 1,
  supersedes_batch_id: null,
  revision_origin: 'scheduled_freeze',
  lineage_id: '2026-07-30',
  is_current: true,
  candidate_generation: 1,
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
    vi.mocked(buildStagedDailyCodexPayload).mockResolvedValue({
      protocol_version: 2, date: '2026-07-30', density: 'normal', batch_id: 'daily-2026-07-30-normal',
      stage: 'editorial', revision: 7, content_hash: `sha256:${'a'.repeat(64)}`,
      render_key: 'daily-2026-07-30-normal-editorial-r7-aaaaaaaa', expected_stages: [], title: '',
      source: 'cloudflare-daily-staged', origin: 'review', digest: { meta: {}, sections: { normal: [] } },
      final_manifest: null,
    } as never);
    vi.mocked(generateDailyPage).mockResolvedValue({} as never);
    vi.mocked(authorizeFormalNewsSet).mockImplementation(async (_env, _date, ids) => ({
      allowed_ids: [...ids],
      decisions: ids.map((id) => ({ item_id: id, allowed: true, code: 'ALLOW_SCHEDULED_FORMAL' as const })),
    }));
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
      selection_hash: 'selection-hash-current',
      edit_revision: 2,
      publish_status: 'published',
    };
    vi.mocked(getNewsReviewBatch).mockResolvedValue(reviewedBatch as never);
    vi.mocked(getActiveNewsReviewBatch).mockResolvedValue(reviewedBatch as never);
    vi.mocked(sanitizeCurrentNewsReviewBatch).mockResolvedValue({
      batch: reviewedBatch, changed: false, dropped_ids: [],
    } as never);
    vi.mocked(getPublishedNewsReviewSelection).mockResolvedValue(reviewedBatch.applied_selected_ids);
    vi.mocked(getDailyStageState).mockResolvedValue({
      stage: 'editorial', revision: 7, content_hash: `sha256:${'a'.repeat(64)}`, pushed_at: 123,
      snapshot: {
        meta: {
          news_review: {
            batch_id: reviewedBatch.batch_id,
            selection_hash: reviewedBatch.selection_hash,
            selected_ids: reviewedBatch.applied_selected_ids,
          },
        },
      },
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
      finalize_revision: null,
      finalize_content_hash: '',
    });
  });

  test('GET exposes a finalize target only when its manifest binds the current editorial target', async () => {
    const reviewedBatch = {
      ...batch, applied_selected_ids: ['news-1'], selection_hash: 'selection-hash', edit_revision: 3,
    };
    vi.mocked(getNewsReviewBatch).mockResolvedValue(reviewedBatch as never);
    vi.mocked(getActiveNewsReviewBatch).mockResolvedValue(reviewedBatch as never);
    vi.mocked(sanitizeCurrentNewsReviewBatch).mockResolvedValue({ batch: reviewedBatch, changed: false, dropped_ids: [] } as never);
    vi.mocked(getDailyStageState).mockImplementation(async (_env, _date, stage) => stage === 'editorial'
      ? {
        stage, revision: 4, content_hash: `sha256:${'a'.repeat(64)}`, pushed_at: 1,
        snapshot: {
          meta: { news_review: {
            batch_id: reviewedBatch.batch_id,
            selection_hash: reviewedBatch.selection_hash,
            selected_ids: reviewedBatch.applied_selected_ids,
          } },
        },
      } as never
      : {
        stage, revision: 2, content_hash: `sha256:${'b'.repeat(64)}`, pushed_at: 2,
        final_manifest: {
          stage_revisions: {
            foundation: { revision: 1, content_hash: `sha256:${'c'.repeat(64)}` },
            editorial: { revision: 4, content_hash: `sha256:${'a'.repeat(64)}` },
            papers: { revision: 1, content_hash: `sha256:${'d'.repeat(64)}` },
          },
          section_order: [], items: [], manifest_hash: `sha256:${'e'.repeat(64)}`,
        },
      } as never);

    const bound = await handleDailyNewsReviewApi(request('GET'), env(), Date.parse('2026-07-30T08:00:00Z'));
    await expect(bound.json()).resolves.toMatchObject({
      generation_target: {
        editorial_revision: 4,
        finalize_revision: 2,
        finalize_content_hash: `sha256:${'b'.repeat(64)}`,
      },
    });

    vi.mocked(getDailyStageState).mockImplementation(async (_env, _date, stage) => stage === 'editorial'
      ? {
        stage, revision: 5, content_hash: `sha256:${'f'.repeat(64)}`, pushed_at: 3,
        snapshot: {
          meta: { news_review: {
            batch_id: reviewedBatch.batch_id,
            selection_hash: reviewedBatch.selection_hash,
            selected_ids: reviewedBatch.applied_selected_ids,
          } },
        },
      } as never
      : {
        stage, revision: 2, content_hash: `sha256:${'b'.repeat(64)}`, pushed_at: 2,
        final_manifest: {
          stage_revisions: { editorial: { revision: 4, content_hash: `sha256:${'a'.repeat(64)}` } },
        },
      } as never);
    const stale = await handleDailyNewsReviewApi(request('GET'), env(), Date.parse('2026-07-30T08:00:00Z'));
    await expect(stale.json()).resolves.toMatchObject({
      generation_target: { editorial_revision: 5, finalize_revision: null, finalize_content_hash: '' },
    });
  });

  test('DRD-001 GET hides old persisted editorial and finalize during the new-selection crash window', async () => {
    const pending = {
      ...batch,
      applied_selected_ids: ['news-6', 'news-2', 'news-7'],
      selection_hash: 'selection-hash-new',
      edit_revision: 3,
      publish_status: 'pending',
    };
    vi.mocked(getNewsReviewBatch).mockResolvedValue(pending as never);
    vi.mocked(getActiveNewsReviewBatch).mockResolvedValue(pending as never);
    vi.mocked(sanitizeCurrentNewsReviewBatch).mockResolvedValue({
      batch: pending, changed: false, dropped_ids: [],
    } as never);
    vi.mocked(getDailyStageState).mockImplementation(async (_env, _date, stage) => stage === 'editorial'
      ? {
        stage, revision: 4, content_hash: `sha256:${'a'.repeat(64)}`, pushed_at: 1,
        snapshot: {
          meta: { news_review: {
            batch_id: pending.batch_id,
            selection_hash: 'selection-hash-old',
            selected_ids: ['news-1', 'news-2'],
          } },
        },
      } as never
      : {
        stage, revision: 2, content_hash: `sha256:${'b'.repeat(64)}`, pushed_at: 2,
        final_manifest: {
          stage_revisions: { editorial: { revision: 4, content_hash: `sha256:${'a'.repeat(64)}` } },
        },
      } as never);

    const response = await handleDailyNewsReviewApi(
      request('GET'), env(), Date.parse('2026-07-30T08:00:00Z'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      generation_target: {
        review_revision: 3,
        editorial_revision: null,
        editorial_content_hash: '',
        finalize_revision: null,
        finalize_content_hash: '',
      },
    });
  });

  test('GET round-trips automatic ten plus three manual candidates without truncation', async () => {
    const manuals = Array.from({ length: 3 }, (_, index) => ({
      item_id: `blog:manual:ml-${index + 1}`,
      title: `人工候选${index + 1}`,
      summary: '人工核验摘要',
      source: '机器之心',
      score: 90 - index,
      event_key: `manual-event-${index + 1}`,
      origin: 'manual_lead' as const,
      lead_id: `ml-${index + 1}`,
    }));
    const expanded = {
      ...batch,
      candidate_ids: [...batch.candidate_ids, ...manuals.map((item) => item.item_id)],
      candidates: [...batch.candidates, ...manuals],
      batch_revision: 4,
      lineage_id: batch.review_date,
      is_current: true,
    };
    vi.mocked(getNewsReviewBatch).mockResolvedValue(expanded as never);
    vi.mocked(getActiveNewsReviewBatch).mockResolvedValue(expanded as never);
    vi.mocked(sanitizeCurrentNewsReviewBatch).mockResolvedValue({
      batch: expanded, changed: false, dropped_ids: [],
    } as never);

    const response = await handleDailyNewsReviewApi(
      request('GET'), env(), Date.parse('2026-07-30T08:00:00Z'),
    );
    const payload = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(200);
    expect(payload.candidates).toHaveLength(13);
    expect((payload.candidates as Array<{ item_id: string }>).map((item) => item.item_id))
      .toEqual(expanded.candidate_ids);
    expect(payload.default_selected_ids).toEqual(batch.default_selected_ids);
  });

  test('active review response performs a final current projection and fails closed after mutation', async () => {
    vi.mocked(authorizeFormalNewsSet).mockImplementation(async (_env, _date, ids, purpose) => ({
      allowed_ids: purpose === 'review_api_final_projection'
        ? ids.filter((id) => id !== 'news-2')
        : [...ids],
      decisions: ids.map((id) => id === 'news-2' && purpose === 'review_api_final_projection'
        ? { item_id: id, allowed: false, code: 'DENY_SOURCE_DISABLED' as const }
        : { item_id: id, allowed: true, code: 'ALLOW_SCHEDULED_FORMAL' as const }),
    }));

    const response = await handleDailyNewsReviewApi(
      request('GET'), env(), Date.parse('2026-07-30T08:00:00Z'),
    );
    const payload = await response.json<Record<string, unknown>>();

    expect((payload.candidates as Array<{ item_id: string }>).map((candidate) => candidate.item_id))
      .not.toContain('news-2');
    expect(payload.default_selected_ids).not.toContain('news-2');
    expect(payload.published_selected_ids).not.toContain('news-2');
    expect(payload.authorization_denied).toContainEqual({ item_id: 'news-2', code: 'DENY_SOURCE_DISABLED' });
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
    vi.mocked(authorizeFormalNewsSet).mockImplementation(async (_env, _date, ids) => ({
      allowed_ids: ids.filter((id) => id !== manual.item_id),
      decisions: ids.map((id) => id === manual.item_id
        ? { item_id: id, allowed: false, code: 'DENY_UNVERIFIED_MANUAL' as const }
        : { item_id: id, allowed: true, code: 'ALLOW_SCHEDULED_FORMAL' as const }),
    }));

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

  test('historical GET preserves the immutable row but projects current source/item authorization with reasons', async () => {
    const requested = {
      ...batch,
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
    vi.mocked(sanitizeCurrentNewsReviewBatch).mockResolvedValue({ batch: refreshed, changed: false, dropped_ids: [] } as never);
    vi.mocked(authorizeFormalNewsSet).mockImplementation(async (_env, _date, ids) => ({
      allowed_ids: ids.filter((id) => id !== 'news-2'),
      decisions: ids.map((id) => id === 'news-2'
        ? { item_id: id, allowed: false, code: 'DENY_SOURCE_DISABLED' as const }
        : { item_id: id, allowed: true, code: 'ALLOW_SCHEDULED_FORMAL' as const }),
    }));

    const response = await handleDailyNewsReviewApi(request('GET'), env(), Date.parse('2026-07-30T08:00:00Z'));
    const payload = await response.json<Record<string, unknown>>();

    expect((payload.candidates as Array<{ item_id: string }>).map((candidate) => candidate.item_id)).not.toContain('news-2');
    expect(payload.default_selected_ids).not.toContain('news-2');
    expect(payload.batch_selected_ids).not.toContain('news-2');
    expect(payload.authorization_denied).toEqual([{ item_id: 'news-2', code: 'DENY_SOURCE_DISABLED' }]);
    expect(requested.candidate_ids).toContain('news-2');
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

  test('R02 changed submission durably prepares editorial, schedules reconciliation, and returns 202', async () => {
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
    let scheduled: Promise<unknown> | null = null;
    const ctx = { waitUntil(task: Promise<unknown>) { scheduled = task; } };

    const response = await handleDailyNewsReviewApi(request('POST', {
      selected_ids: changedBatch.applied_selected_ids,
    }), env(), Date.parse('2026-07-30T08:00:00Z'), ctx as never);

    expect(response.status).toBe(202);
    expect(buildStagedDailyCodexPayload).toHaveBeenCalledWith(expect.anything(), 'editorial', {
      date: '2026-07-30', persistRevision: true, origin: 'review',
    });
    expect(markNewsReviewPending).toHaveBeenCalledWith(
      expect.anything(), '2026-07-30', batch.batch_id, 'selection-hash',
    );
    expect(scheduled).not.toBeNull();
    await expect(response.clone().json()).resolves.toMatchObject({
      generation_target: {
        review_revision: 1,
        editorial_revision: 7,
        editorial_content_hash: `sha256:${'a'.repeat(64)}`,
        finalize_revision: null,
      },
    });
  });

  test('POST leaves downstream proof revalidation to durable reconciliation', async () => {
    const changedBatch = {
      ...batch,
      applied_selected_ids: ['news-6', 'news-2'],
      selection_hash: 'selection-hash-stale-finalize',
      edit_revision: 1,
      publish_status: 'pending',
    };
    vi.mocked(submitNewsReviewSelection).mockResolvedValue({
      ok: true, changed: true, retry_publish: true, batch: changedBatch,
      selected_ids: changedBatch.applied_selected_ids,
    } as never);
    vi.mocked(sanitizeCurrentNewsReviewBatch).mockResolvedValue({
      batch: changedBatch, changed: false, dropped_ids: [],
    } as never);
    const response = await handleDailyNewsReviewApi(request('POST', {
      selected_ids: changedBatch.applied_selected_ids,
    }), env(), Date.parse('2026-07-30T08:00:00Z'));

    expect(response.status).toBe(202);
    expect(markNewsReviewPending).toHaveBeenCalledWith(
      expect.anything(), '2026-07-30', batch.batch_id, 'selection-hash-stale-finalize',
    );
    expect(pushDailyStageToCodex).not.toHaveBeenCalled();
    expect(generateDailyPage).not.toHaveBeenCalled();
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

  test('R12 unchanged explicit retry re-arms pending reconciliation without changing review revision', async () => {
    const retryBatch = {
      ...batch, applied_selected_ids: batch.default_selected_ids, selection_hash: 'selection-hash',
      edit_revision: 3, publish_status: 'pending', publish_error: 'network: lost response',
    };
    vi.mocked(submitNewsReviewSelection).mockResolvedValue({
      ok: true, changed: false, retry_publish: true, batch: retryBatch,
      selected_ids: retryBatch.applied_selected_ids,
    } as never);
    vi.mocked(sanitizeCurrentNewsReviewBatch).mockResolvedValue({ batch: retryBatch, changed: false, dropped_ids: [] } as never);
    let scheduled: Promise<unknown> | null = null;
    const response = await handleDailyNewsReviewApi(request('POST', {
      selected_ids: retryBatch.applied_selected_ids,
    }), env(), Date.parse('2026-07-30T08:00:00Z'), {
      waitUntil(task: Promise<unknown>) { scheduled = task; },
    } as never);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ changed: false, generation_target: { review_revision: 3 } });
    expect(markNewsReviewPending).toHaveBeenCalledWith(
      expect.anything(), '2026-07-30', retryBatch.batch_id, retryBatch.selection_hash,
    );
    expect(scheduled).not.toBeNull();
  });

  test('R01 R06 reconciler replays editorial but waits for papers acknowledgement before finalize', async () => {
    const pending = {
      ...batch, applied_selected_ids: batch.default_selected_ids, selection_hash: 'selection-hash',
      edit_revision: 3, publish_status: 'pending',
    };
    vi.mocked(getActiveNewsReviewBatch).mockResolvedValue(pending as never);
    vi.mocked(sanitizeCurrentNewsReviewBatch).mockResolvedValue({ batch: pending, changed: false, dropped_ids: [] } as never);
    vi.mocked(pushDailyStageToCodex).mockResolvedValue({
      ok: true, stage: 'editorial', revision: 4, content_hash: `sha256:${'a'.repeat(64)}`,
    } as never);
    vi.mocked(getDailyStageState).mockResolvedValue(null);

    const result = await reconcileDailyNewsReviewPublication(
      env(), '2026-07-30', Date.parse('2026-07-30T08:00:00Z'),
    );

    expect(result).toMatchObject({ ok: true, pending: 'papers' });
    expect(pushDailyStageToCodex).toHaveBeenCalledTimes(1);
    expect(pushDailyStageToCodex).toHaveBeenCalledWith(expect.anything(), 'editorial', '2026-07-30', { origin: 'review' });
    expect(markNewsReviewPublished).not.toHaveBeenCalled();
  });

  test('R07 exact deterministic reconciliation converges through finalize and marks only the exact batch published', async () => {
    const pending = {
      ...batch, applied_selected_ids: batch.default_selected_ids, selection_hash: 'selection-hash',
      edit_revision: 3, publish_status: 'pending',
    };
    vi.mocked(getActiveNewsReviewBatch).mockResolvedValue(pending as never);
    vi.mocked(sanitizeCurrentNewsReviewBatch).mockResolvedValue({ batch: pending, changed: false, dropped_ids: [] } as never);
    vi.mocked(getDailyStageState).mockResolvedValue({ stage: 'papers', revision: 1, pushed_at: 123 } as never);
    vi.mocked(pushDailyStageToCodex).mockImplementation(async (_env, stage) => ({
      ok: true, stage, revision: stage === 'editorial' ? 4 : 2,
      content_hash: `sha256:${(stage === 'editorial' ? 'a' : 'b').repeat(64)}`,
    }) as never);

    const result = await reconcileDailyNewsReviewPublication(
      env(), '2026-07-30', Date.parse('2026-07-30T08:00:00Z'),
    );

    expect(result).toMatchObject({ ok: true, published: true, finalize: { revision: 2 } });
    expect(vi.mocked(pushDailyStageToCodex).mock.calls.map((call) => call[1])).toEqual(['editorial', 'finalize']);
    expect(generateDailyPage).toHaveBeenCalledWith(expect.anything(), '2026-07-30');
    expect(markNewsReviewPublished).toHaveBeenCalledWith(
      expect.anything(), '2026-07-30', pending.batch_id, pending.selection_hash,
    );
  });

  test('DRD-003 sanitization exceptions persist a bounded secret-safe error for the exact pending batch', async () => {
    const pending = {
      ...batch, applied_selected_ids: batch.default_selected_ids, selection_hash: 'selection-hash',
      edit_revision: 3, publish_status: 'pending',
    };
    vi.mocked(getActiveNewsReviewBatch).mockResolvedValue(pending as never);
    const secretSentinel = 'shared-secret';
    const bearerSentinel = 'exception-bearer-sentinel';
    vi.mocked(sanitizeCurrentNewsReviewBatch).mockRejectedValue(new Error(
      `sanitize exploded Bearer ${bearerSentinel} ${secretSentinel} `
      + `https://url-user:url-pass@example.test/private?token=query-sentinel ${'x'.repeat(700)}`,
    ));

    const result = await reconcileDailyNewsReviewPublication(
      env(), '2026-07-30', Date.parse('2026-07-30T08:00:00Z'),
    );

    expect(result).toMatchObject({ ok: false, stage: 'sanitize' });
    expect(markNewsReviewPending).toHaveBeenCalledTimes(1);
    const call = vi.mocked(markNewsReviewPending).mock.calls[0];
    expect(call.slice(1, 4)).toEqual(['2026-07-30', pending.batch_id, pending.selection_hash]);
    expect(String(call[4])).toContain('sanitize exploded');
    expect(String(call[4]).length).toBeLessThanOrEqual(500);
    for (const sentinel of [secretSentinel, bearerSentinel, 'url-user', 'url-pass', 'query-sentinel', 'example.test']) {
      expect(JSON.stringify({ result, persisted: call[4] })).not.toContain(sentinel);
    }
    expect(markNewsReviewPublished).not.toHaveBeenCalled();
  });

  test('DRD-003 HK HTTP body is removed before the exact batch is marked pending', async () => {
    const pending = {
      ...batch, applied_selected_ids: batch.default_selected_ids, selection_hash: 'selection-hash',
      edit_revision: 3, publish_status: 'pending',
    };
    const bodySentinel = 'hk-body-sentinel-19c0de';
    vi.mocked(getActiveNewsReviewBatch).mockResolvedValue(pending as never);
    vi.mocked(sanitizeCurrentNewsReviewBatch).mockResolvedValue({ batch: pending, changed: false, dropped_ids: [] } as never);
    vi.mocked(pushDailyStageToCodex).mockResolvedValue({
      ok: false, stage: 'editorial', error: `http_503: ${bodySentinel} Bearer hk-body-token`,
    } as never);

    const result = await reconcileDailyNewsReviewPublication(
      env(), '2026-07-30', Date.parse('2026-07-30T08:00:00Z'),
    );
    const persisted = String(vi.mocked(markNewsReviewPending).mock.calls[0]?.[4] || '');

    expect(result).toMatchObject({ ok: false, stage: 'editorial', error: expect.stringContaining('http_503') });
    expect(JSON.stringify({ result, persisted })).not.toContain(bodySentinel);
    expect(JSON.stringify({ result, persisted })).not.toContain('hk-body-token');
  });

  test('DRD-003 GET redacts legacy persisted delivery details before returning them', async () => {
    const bodySentinel = 'legacy-hk-body-sentinel-880a5e';
    const reviewedBatch = {
      ...batch, applied_selected_ids: ['news-1'], selection_hash: 'selection-hash', edit_revision: 3,
      publish_status: 'pending',
      publish_error: `http_502: ${bodySentinel} Bearer legacy-token shared-secret `
        + 'https://url-user:url-pass@example.test/private?token=query-sentinel',
    };
    vi.mocked(getNewsReviewBatch).mockResolvedValue(reviewedBatch as never);
    vi.mocked(getActiveNewsReviewBatch).mockResolvedValue(reviewedBatch as never);
    vi.mocked(sanitizeCurrentNewsReviewBatch).mockResolvedValue({ batch: reviewedBatch, changed: false, dropped_ids: [] } as never);

    const response = await handleDailyNewsReviewApi(request('GET'), env(), Date.parse('2026-07-30T08:00:00Z'));
    const payload = await response.json<Record<string, unknown>>();
    const exposed = JSON.stringify(payload);

    expect(response.status).toBe(200);
    expect(payload.publish_error).toEqual(expect.stringContaining('http_502'));
    for (const sentinel of [
      bodySentinel, 'legacy-token', 'shared-secret', 'url-user', 'url-pass', 'query-sentinel', 'example.test',
    ]) expect(exposed).not.toContain(sentinel);
  });

  test('DRD-003 papers lookup exceptions persist a bounded error for the exact pending batch', async () => {
    const pending = {
      ...batch, applied_selected_ids: batch.default_selected_ids, selection_hash: 'selection-hash',
      edit_revision: 3, publish_status: 'pending',
    };
    vi.mocked(getActiveNewsReviewBatch).mockResolvedValue(pending as never);
    vi.mocked(sanitizeCurrentNewsReviewBatch).mockResolvedValue({ batch: pending, changed: false, dropped_ids: [] } as never);
    vi.mocked(pushDailyStageToCodex).mockResolvedValue({
      ok: true, stage: 'editorial', revision: 4, content_hash: `sha256:${'a'.repeat(64)}`,
    } as never);
    vi.mocked(getDailyStageState).mockRejectedValue(new Error(`papers lookup exploded ${'y'.repeat(700)}`));

    const result = await reconcileDailyNewsReviewPublication(
      env(), '2026-07-30', Date.parse('2026-07-30T08:00:00Z'),
    );

    expect(result).toMatchObject({ ok: false, stage: 'papers' });
    expect(markNewsReviewPending).toHaveBeenCalledTimes(1);
    const call = vi.mocked(markNewsReviewPending).mock.calls[0];
    expect(call.slice(1, 4)).toEqual(['2026-07-30', pending.batch_id, pending.selection_hash]);
    expect(String(call[4])).toContain('papers lookup exploded');
    expect(String(call[4])).toHaveLength(500);
    expect(markNewsReviewPublished).not.toHaveBeenCalled();
  });

  test('G03 reconciler is bounded to the current BJT date', async () => {
    const result = await reconcileDailyNewsReviewPublication(
      env(), '2026-07-29', Date.parse('2026-07-30T08:00:00Z'),
    );
    expect(result).toEqual({ ok: true, skipped: 'stale_date' });
    expect(pushDailyStageToCodex).not.toHaveBeenCalled();
    expect(generateDailyPage).not.toHaveBeenCalled();
  });

  test('G04 reconciliation guard failure stays pending and records a concise error', async () => {
    const pending = {
      ...batch, applied_selected_ids: batch.default_selected_ids, selection_hash: 'selection-hash',
      edit_revision: 3, publish_status: 'pending',
    };
    vi.mocked(getActiveNewsReviewBatch).mockResolvedValue(pending as never);
    vi.mocked(sanitizeCurrentNewsReviewBatch).mockResolvedValue({ batch: pending, changed: false, dropped_ids: [] } as never);
    vi.mocked(pushDailyStageToCodex).mockResolvedValue({ ok: false, stage: 'editorial', error: 'formal_guard_failed' } as never);

    const result = await reconcileDailyNewsReviewPublication(
      env(), '2026-07-30', Date.parse('2026-07-30T08:00:00Z'),
    );

    expect(result).toMatchObject({ ok: false, stage: 'editorial', error: 'formal_guard_failed' });
    expect(markNewsReviewPending).toHaveBeenCalledWith(
      expect.anything(), '2026-07-30', pending.batch_id, pending.selection_hash, 'formal_guard_failed',
    );
    expect(markNewsReviewPublished).not.toHaveBeenCalled();
  });
});
