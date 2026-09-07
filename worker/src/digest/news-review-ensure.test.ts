import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./news-review', () => ({
  authorizeNewsReviewBatchSnapshot: vi.fn(async (
    _env: unknown, _date: string, _batch: unknown, ids: readonly string[],
  ) => ({
    allowed_ids: [...ids],
    decisions: ids.map((id) => ({ item_id: id, allowed: true, code: 'ALLOW_SCHEDULED_FORMAL' })),
  })),
  createNewsReviewToken: vi.fn(async () => 'ensure-token'),
  freezeNewsReviewBatchFromPool: vi.fn(),
  newsReviewPoolShortfallCount: vi.fn((error: unknown) => {
    const count = (error as { candidate_count?: number } | null)?.candidate_count;
    return typeof count === 'number' ? count : null;
  }),
  getActiveNewsReviewBatch: vi.fn(),
  getPublishedNewsReviewSelection: vi.fn(async () => []),
  getNewsReviewBatch: vi.fn(),
  markNewsReviewPending: vi.fn(),
  markNewsReviewPublished: vi.fn(),
  newsReviewSecret: vi.fn((env: { DAILY_NEWS_REVIEW_SECRET?: string }) => env.DAILY_NEWS_REVIEW_SECRET || ''),
  sanitizeCurrentNewsReviewBatch: vi.fn(),
  submitNewsReviewSelection: vi.fn(),
  verifyNewsReviewTokenSignature: vi.fn(async () => true),
}));
vi.mock('./pool-rebuild', () => ({ rebuildDigestPoolSource: vi.fn() }));
vi.mock('./codex-push', () => ({
  buildStagedDailyCodexPayload: vi.fn(),
  getDailyStageState: vi.fn(async () => null),
  pushDailyStageToCodex: vi.fn(),
}));
vi.mock('./daily-page-run', () => ({ generateDailyPage: vi.fn() }));

import { handleDailyNewsReviewApi } from './news-review-api';
import { freezeNewsReviewBatchFromPool, sanitizeCurrentNewsReviewBatch } from './news-review';
import { rebuildDigestPoolSource } from './pool-rebuild';
import { bjtDateStr } from './lib';

// 北京时间 2026-09-07 早 06:30 —— 07:50 定时冻结之前，owner 打开审核页的那个时刻。
const NOW = Date.parse('2026-09-06T22:30:00.000Z');
const TODAY = bjtDateStr(NOW);

function batchFor(date: string) {
  const ids = Array.from({ length: 10 }, (_, index) => `news-${index + 1}`);
  return {
    review_date: date,
    batch_id: 'nr-20260907-abcdef123456',
    candidate_ids: ids,
    candidates: ids.map((id, index) => ({
      item_id: id, title: `标题${index + 1}`, summary: `摘要${index + 1}`, source: '来源', score: 10 - index,
    })),
    default_selected_ids: ids.slice(0, 5),
    applied_selected_ids: null,
    selection_hash: null,
    edit_revision: 0,
    publish_status: 'not_requested',
    publish_error: null,
    published_at: null,
    notified_at: 1,
    notification_hash: 'nr-20260907-abcdef123456',
    auto_repaired_invalid_ids: [],
    superseded_by: null,
    human_reviewed: false,
    batch_revision: 1,
    supersedes_batch_id: null,
    revision_origin: 'scheduled_freeze',
    lineage_id: date,
    is_current: true,
    candidate_generation: 1,
    created_at: 1,
    expires_at: NOW + 86_400_000,
  };
}

interface KvPut { key: string; value: string; options?: { expirationTtl?: number } }

function makeEnv(seeded: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seeded));
  const puts: KvPut[] = [];
  const env = {
    DAILY_NEWS_REVIEW_SECRET: 'shared-secret',
    AUTH_KV: {
      async get(key: string) { return store.get(key) ?? null; },
      async put(key: string, value: string, options?: { expirationTtl?: number }) {
        puts.push({ key, value, options });
        store.set(key, value);
      },
    },
  } as never;
  return { env, puts, store };
}

function resolveRequest(date: string, ensure: boolean) {
  const url = new URL('https://api.example.test/api/digest/daily-news-review');
  url.searchParams.set('date', date);
  if (ensure) url.searchParams.set('ensure', '1');
  return new Request(url.toString(), {
    method: 'GET',
    headers: { Authorization: 'Bearer shared-secret' },
  });
}

function missingBatchOnce() {
  vi.mocked(sanitizeCurrentNewsReviewBatch).mockImplementation(async () => {
    throw new Error('news_review_batch_not_found');
  });
}

describe('daily news review ensure=1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  test('builds today\'s batch on the spot, rebuilding only the news source with no LLM pass', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    let frozen = false;
    vi.mocked(sanitizeCurrentNewsReviewBatch).mockImplementation(async () => {
      if (!frozen) throw new Error('news_review_batch_not_found');
      return { batch: batchFor(TODAY), changed: false, dropped_ids: [] } as never;
    });
    vi.mocked(freezeNewsReviewBatchFromPool).mockImplementation(async () => {
      frozen = true;
      return { batch: batchFor(TODAY), created: true } as never;
    });
    const { env, puts } = makeEnv();

    const response = await handleDailyNewsReviewApi(resolveRequest(TODAY, true), env, NOW);

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, date: TODAY, batch_id: 'nr-20260907-abcdef123456' });
    expect((body.candidates as unknown[])).toHaveLength(10);
    // 只重建 news 一个源，且关掉编辑校准 —— 全量快照会串行跑 5 个源各调一次 DeepSeek Pro。
    expect(rebuildDigestPoolSource).toHaveBeenCalledTimes(1);
    expect(rebuildDigestPoolSource).toHaveBeenCalledWith(env, `${TODAY}-08`, 'news', {
      editorialReview: false,
    });
    expect(freezeNewsReviewBatchFromPool).toHaveBeenCalledWith(env, TODAY, NOW);
    expect(upstream).not.toHaveBeenCalled();
    // 节流键写进 KV，TTL 60 秒。
    expect(puts).toEqual([{
      key: `lock:news-pool-rebuild:${TODAY}`,
      value: String(NOW),
      options: { expirationTtl: 60 },
    }]);
  });

  test('emits ensure timing probes for the rebuild and the freeze', async () => {
    let frozen = false;
    vi.mocked(sanitizeCurrentNewsReviewBatch).mockImplementation(async () => {
      if (!frozen) throw new Error('news_review_batch_not_found');
      return { batch: batchFor(TODAY), changed: false, dropped_ids: [] } as never;
    });
    vi.mocked(freezeNewsReviewBatchFromPool).mockImplementation(async () => {
      frozen = true;
      return { batch: batchFor(TODAY), created: true } as never;
    });
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      logs.push(String(message));
    });
    try {
      const { env } = makeEnv();
      await handleDailyNewsReviewApi(resolveRequest(TODAY, true), env, NOW);
    } finally {
      spy.mockRestore();
    }
    for (const step of ['ensure.lock', 'ensure.pool_rebuild', 'ensure.freeze', 'ensure.resolve.sanitize']) {
      expect(logs.some((line) => line.startsWith(`[news-review-timing] ${step} `))).toBe(true);
    }
  });

  test('does nothing when today already has an active batch', async () => {
    vi.mocked(sanitizeCurrentNewsReviewBatch).mockResolvedValue({
      batch: batchFor(TODAY), changed: false, dropped_ids: [],
    } as never);
    const { env, puts } = makeEnv();

    const response = await handleDailyNewsReviewApi(resolveRequest(TODAY, true), env, NOW);

    expect(response.status).toBe(200);
    expect(rebuildDigestPoolSource).not.toHaveBeenCalled();
    expect(freezeNewsReviewBatchFromPool).not.toHaveBeenCalled();
    expect(puts).toEqual([]);
  });

  test('ignores ensure for any date other than the current Beijing day', async () => {
    missingBatchOnce();
    const { env } = makeEnv();

    const response = await handleDailyNewsReviewApi(resolveRequest('2026-09-05', true), env, NOW);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: 'review_batch_not_found' });
    expect(rebuildDigestPoolSource).not.toHaveBeenCalled();
    expect(freezeNewsReviewBatchFromPool).not.toHaveBeenCalled();
  });

  test('keeps the plain resolve path at 404 when ensure is not requested', async () => {
    missingBatchOnce();
    const { env } = makeEnv();

    const response = await handleDailyNewsReviewApi(resolveRequest(TODAY, false), env, NOW);

    expect(response.status).toBe(404);
    expect(rebuildDigestPoolSource).not.toHaveBeenCalled();
  });

  test('answers 202 while another request already holds the throttle key', async () => {
    missingBatchOnce();
    const { env, puts } = makeEnv({ [`lock:news-pool-rebuild:${TODAY}`]: '1' });

    const response = await handleDailyNewsReviewApi(resolveRequest(TODAY, true), env, NOW);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: false, error: 'ensure_in_progress' });
    expect(rebuildDigestPoolSource).not.toHaveBeenCalled();
    expect(freezeNewsReviewBatchFromPool).not.toHaveBeenCalled();
    expect(puts).toEqual([]);
  });

  test('reports the real candidate count when the pool is short of five', async () => {
    missingBatchOnce();
    const shortfall = Object.assign(new Error('news_review_pool_has_fewer_than_five'), {
      candidate_count: 3,
    });
    vi.mocked(freezeNewsReviewBatchFromPool).mockRejectedValue(shortfall);
    const { env } = makeEnv();

    const response = await handleDailyNewsReviewApi(resolveRequest(TODAY, true), env, NOW);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false, error: 'candidates_insufficient', count: 3,
    });
  });

  test('reports zero candidates when the rebuilt pool row is missing entirely', async () => {
    missingBatchOnce();
    vi.mocked(freezeNewsReviewBatchFromPool).mockRejectedValue(
      Object.assign(new Error('news_review_pool_missing'), { candidate_count: 0 }),
    );
    const { env } = makeEnv();

    const response = await handleDailyNewsReviewApi(resolveRequest(TODAY, true), env, NOW);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      ok: false, error: 'candidates_insufficient', count: 0,
    });
  });

  test('lets unrelated freeze failures surface instead of masking them as insufficient candidates', async () => {
    missingBatchOnce();
    vi.mocked(freezeNewsReviewBatchFromPool).mockRejectedValue(
      new Error('news_review_formal_authorization_stale'),
    );
    const { env } = makeEnv();

    await expect(handleDailyNewsReviewApi(resolveRequest(TODAY, true), env, NOW))
      .rejects.toThrow('news_review_formal_authorization_stale');
  });
});
