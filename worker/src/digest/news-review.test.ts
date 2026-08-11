import { describe, expect, test } from 'vitest';

import {
  buildNewsReviewNotification,
  buildNewsReviewBatchId,
  createNewsReviewToken,
  freezeNewsReviewBatchFromPool,
  getAppliedNewsReviewSelection,
  getPublishedNewsReviewSelection,
  repairInvalidNewsReviewSelection,
  validateNewsReviewSelection,
  verifyNewsReviewToken,
} from './news-review';

const candidates = Array.from({ length: 10 }, (_, index) => ({
  item_id: `news-${index + 1}`,
  title: `候选新闻 ${index + 1}`,
  summary: `候选新闻 ${index + 1} 摘要`,
  source: index % 2 ? '机器之心' : '量子位',
  score: 100 - index,
}));

describe('daily news review contract', () => {
  test('batch id is stable for an immutable snapshot and changes when order or copy changes', async () => {
    const first = await buildNewsReviewBatchId('2026-07-30', candidates);
    const identical = await buildNewsReviewBatchId('2026-07-30', structuredClone(candidates));
    const reordered = await buildNewsReviewBatchId('2026-07-30', [candidates[1], candidates[0], ...candidates.slice(2)]);
    const corrected = await buildNewsReviewBatchId('2026-07-30', [
      { ...candidates[0], summary: '事实修正后的摘要' },
      ...candidates.slice(1),
    ]);

    expect(first).toMatch(/^nr-20260730-[a-f0-9]{12}$/);
    expect(identical).toBe(first);
    expect(reordered).not.toBe(first);
    expect(corrected).not.toBe(first);
  });

  test('signed token is bound to date and batch and expires at BJT day end', async () => {
    const secret = 'review-secret-for-test';
    const batchId = await buildNewsReviewBatchId('2026-07-30', candidates);
    const token = await createNewsReviewToken(secret, '2026-07-30', batchId);

    await expect(verifyNewsReviewToken(secret, '2026-07-30', batchId, token, Date.parse('2026-07-30T15:59:59Z')))
      .resolves.toEqual({ ok: true, expired: false });
    await expect(verifyNewsReviewToken(secret, '2026-07-31', batchId, token, Date.parse('2026-07-30T15:00:00Z')))
      .resolves.toEqual({ ok: false, expired: false });
    await expect(verifyNewsReviewToken(secret, '2026-07-30', `${batchId}-other`, token, Date.parse('2026-07-30T15:00:00Z')))
      .resolves.toEqual({ ok: false, expired: false });
    await expect(verifyNewsReviewToken(secret, '2026-07-30', batchId, token, Date.parse('2026-07-30T16:00:00Z')))
      .resolves.toEqual({ ok: false, expired: true });
  });

  test('selection accepts one to five unique candidate item ids and preserves submitted order', () => {
    const ids = candidates.map((candidate) => candidate.item_id);
    expect(validateNewsReviewSelection(['news-4'], ids)).toEqual({
      ok: true,
      selected_ids: ['news-4'],
    });
    expect(validateNewsReviewSelection(ids.slice(3, 6), ids)).toEqual({
      ok: true,
      selected_ids: ['news-4', 'news-5', 'news-6'],
    });
    expect(validateNewsReviewSelection(ids.slice(3, 8), ids)).toEqual({
      ok: true,
      selected_ids: ['news-4', 'news-5', 'news-6', 'news-7', 'news-8'],
    });
    expect(validateNewsReviewSelection([], ids)).toMatchObject({ ok: false, error: 'selection_must_have_one_to_five' });
    expect(validateNewsReviewSelection(ids.slice(0, 6), ids)).toMatchObject({ ok: false, error: 'selection_must_have_one_to_five' });
    expect(validateNewsReviewSelection([''], ids)).toMatchObject({ ok: false, error: 'selection_contains_unknown_item' });
    expect(validateNewsReviewSelection(['news-1', 'news-2', 'news-2'], ids))
      .toMatchObject({ ok: false, error: 'selection_must_be_unique' });
    expect(validateNewsReviewSelection(['news-1', 'unknown'], ids))
      .toMatchObject({ ok: false, error: 'selection_contains_unknown_item' });
  });

  test('applied production selection may contain fewer than five reviewed items', async () => {
    const env = {
      DB: {
        prepare() {
          const stmt = {
            bind() { return stmt; },
            async first<T>() {
              return { applied_selected_ids: JSON.stringify(['news-6', 'news-2', 'news-7']) } as T;
            },
          };
          return stmt;
        },
      },
    } as never;

    await expect(getAppliedNewsReviewSelection(env, '2026-07-30'))
      .resolves.toEqual(['news-6', 'news-2', 'news-7']);
  });

  test('applied selection keeps the rollout fallback when review tables are not migrated yet', async () => {
    const env = {
      DB: {
        prepare() {
          throw new Error('D1_ERROR: no such table: daily_news_review_batches');
        },
      },
    } as never;

    await expect(getAppliedNewsReviewSelection(env, '2026-07-30')).resolves.toBeNull();
  });

  test('notification lists all candidates and binds the immutable date and batch link', () => {
    const message = buildNewsReviewNotification(
      '2026-07-30',
      'nr-20260730-abc123abc123',
      'signed-token',
      candidates,
    );
    expect(message.title).toBe('AI Feeds 07-30 行业要闻候选');
    expect(message.body).toContain('1. 候选新闻 1');
    expect(message.body).toContain('10. 候选新闻 10');
    expect(message.body).toContain('量子位 · 100分');
    expect(message.body).toContain('review_date=2026-07-30');
    expect(message.body).toContain('review_batch=nr-20260730-abc123abc123');
    expect(message.body).toContain('review_token=signed-token');
    expect(message.body).toContain('#news-review');
  });

  test('pool snapshot keeps calibrated defaults and ignores an unverified legacy manual lead', async () => {
    const auditCandidates = candidates.map((candidate, index) => ({
      rank: index + 1,
      id: candidate.item_id,
      title: `Original ${index + 1}`,
      title_zh: candidate.title,
      source_company: candidate.source,
      adjusted_score: candidate.score,
    }));
    const pool = {
      item_ids: JSON.stringify(candidates.slice(0, 5).map((candidate) => candidate.item_id)),
      items_meta: JSON.stringify({
        candidate_ids_after_exact_dedup: candidates.map((candidate) => candidate.item_id),
        candidates: auditCandidates,
      }),
    };
    const rows = new Map(candidates.map((candidate) => [candidate.item_id, {
      id: candidate.item_id,
      source_ref: candidate.item_id === 'news-10' ? 'manual_lead' : null,
      title: candidate.title,
      content: candidate.summary,
      content_translated: candidate.summary,
      url: `https://example.com/${candidate.item_id}`,
      extra: JSON.stringify({ title_zh: candidate.title, ai_summary_zh: candidate.summary }),
    }]));
    const inserted: Array<{ sql: string; binds: unknown[] }> = [];
    const manualAssessment = {
      title: 'Anthropic披露部分Claude输出的水印与来源标记',
      summary: '官方文档将范围限定为受支持的模型与产品。',
      event_key: 'anthropic-output-provenance-2026-08',
      score: 82,
    };
    let saved: Record<string, unknown> | null = null;
    const env = {
      DAILY_NEWS_REVIEW_SECRET: 'secret',
      DB: {
        prepare(sql: string) {
          let binds: unknown[] = [];
          const stmt = {
            bind(...values: unknown[]) { binds = values; return stmt; },
            async first<T>() {
              if (/news_review:candidate_generation_read/i.test(sql)) return { generation: 0 } as T;
              if (/FROM digest_pool/i.test(sql)) return pool as T;
              if (/FROM daily_news_review_batches/i.test(sql) && /batch_id = \?/i.test(sql)) return saved as T | null;
              return null as T | null;
            },
            async all<T>() {
              if (/FROM items/i.test(sql)) return { results: binds.map((id) => rows.get(String(id))) as T[] };
              if (/FROM manual_news_leads/i.test(sql)) return { results: [{
                id: 'ml-20260730-abc123def456', input_url: 'https://support.claude.com/example',
                assessment_json: JSON.stringify(manualAssessment), publisher: 'Anthropic',
              }] as T[] };
              return { results: [] as T[] };
            },
            async run() {
              inserted.push({ sql, binds });
              if (/INSERT INTO daily_news_review_batches/i.test(sql)) {
                saved = {
                  review_date: binds[0], batch_id: binds[1], candidate_ids: binds[2], candidates_json: binds[3],
                  default_selected_ids: binds[4], applied_selected_ids: binds[5], selection_hash: binds[6],
                  edit_revision: binds[7], publish_status: binds[8], publish_error: null, published_at: null,
                  notified_at: null, notification_hash: null, superseded_by: null,
                  auto_repaired_from_batch: binds[9], auto_repaired_invalid_ids: binds[10],
                  created_at: binds[11], expires_at: binds[12], batch_revision: binds[13],
                  supersedes_batch_id: binds[14], revision_origin: 'scheduled_freeze', lineage_id: binds[15],
                  is_current: binds[16], candidate_generation: binds[17],
                };
              }
              return { success: true };
            },
          };
          return stmt;
        },
        async batch(statements: Array<{ run(): Promise<unknown> }>) {
          return Promise.all(statements.map((statement) => statement.run()));
        },
      },
    } as never;

    const result = await freezeNewsReviewBatchFromPool(env, '2026-07-30', Date.parse('2026-07-30T00:00:00Z'));

    expect(result.created).toBe(true);
    expect(result.batch.candidate_ids).toEqual(candidates.slice(0, 9).map((candidate) => candidate.item_id));
    expect(result.batch.default_selected_ids).toEqual(candidates.slice(0, 5).map((candidate) => candidate.item_id));
    expect(result.batch.candidates[0]).toMatchObject({
      title: '候选新闻 1', summary: '候选新闻 1 摘要', source: '量子位', score: 100,
    });
    expect(inserted.some((entry) => /INSERT INTO daily_news_review_batches/i.test(entry.sql))).toBe(true);
    expect(inserted.some((entry) => /UPDATE manual_news_leads SET confirmed_batch_id/i.test(entry.sql))).toBe(false);
  });

  test('a new batch compares against the previous production defaults when no human choice exists', async () => {
    const previousIds = ['old-1', 'old-2', 'old-3', 'old-4', 'old-5'];
    const current = {
      review_date: '2026-07-30',
      batch_id: 'nr-20260730-abcdef123456',
      default_selected_ids: ['new-1', 'new-2', 'new-3', 'new-4', 'new-5'],
    } as never;
    const env = {
      DB: {
        prepare(sql: string) {
          const stmt = {
            bind() { return stmt; },
            async first<T>() {
              if (/applied_selected_ids IS NOT NULL/i.test(sql)) return null as T | null;
              if (/superseded_by = \?/i.test(sql)) {
                return { default_selected_ids: JSON.stringify(previousIds) } as T;
              }
              return null as T | null;
            },
          };
          return stmt;
        },
      },
    } as never;

    await expect(getPublishedNewsReviewSelection(env, '2026-07-30', current)).resolves.toEqual(previousIds);
  });

  test('a corrected batch automatically removes an invalid selected item and fills from ranking order', () => {
    expect(repairInvalidNewsReviewSelection(
      ['news-9', 'news-2', 'deleted-news', 'news-1', 'news-5'],
      ['news-1', 'news-2', 'news-3', 'news-4', 'news-5', 'news-6', 'news-7', 'news-8', 'news-9', 'news-10'],
    )).toEqual({
      required: true,
      invalid_ids: ['deleted-news'],
      selected_ids: ['news-9', 'news-2', 'news-1', 'news-5', 'news-3'],
    });
    expect(repairInvalidNewsReviewSelection(
      ['news-5', 'news-4', 'news-3', 'news-2', 'news-1'],
      ['news-1', 'news-2', 'news-3', 'news-4', 'news-5'],
    )).toEqual({ required: false, invalid_ids: [], selected_ids: ['news-5', 'news-4', 'news-3', 'news-2', 'news-1'] });
    expect(repairInvalidNewsReviewSelection(
      ['news-9', 'deleted-news', 'news-2'],
      ['news-1', 'news-2', 'news-3', 'news-4', 'news-5', 'news-6', 'news-7', 'news-8', 'news-9', 'news-10'],
    )).toEqual({
      required: true,
      invalid_ids: ['deleted-news'],
      selected_ids: ['news-9', 'news-2', 'news-1'],
    });
  });
});
