import { beforeEach, describe, expect, test, vi } from 'vitest';

const previousCandidates = Array.from({ length: 10 }, (_, index) => ({
  item_id: `news-${index + 1}`, title: `新闻${index + 1}`, summary: '摘要', source: '来源', score: 100 - index,
  event_key: `event-${index + 1}`,
}));
const activeBatch = {
  review_date: '2026-08-11', batch_id: 'nr-20260811-oldoldoldold', candidate_ids: previousCandidates.map((item) => item.item_id),
  candidates: previousCandidates, default_selected_ids: ['news-1', 'news-2', 'news-3', 'news-4', 'news-5'],
  applied_selected_ids: null, selection_hash: null, edit_revision: 0, publish_status: 'not_requested',
  publish_error: null, published_at: null, notified_at: 1, notification_hash: 'old',
  auto_repaired_from_batch: null, auto_repaired_invalid_ids: [], superseded_by: null,
  batch_revision: 1, supersedes_batch_id: null, revision_origin: 'scheduled_freeze', created_at: 1, expires_at: 9,
};

let insertedBatch: any = null;
vi.mock('./news-review', () => ({
  buildNewsReviewBatchId: vi.fn(async () => 'nr-20260811-newnewnewnew'),
  createNewsReviewToken: vi.fn(async () => 'review-token'),
  getActiveNewsReviewBatch: vi.fn(async () => activeBatch),
  getPublishedNewsReviewSelection: vi.fn(async () => ['news-2', 'news-1', 'news-5']),
  getNewsReviewBatch: vi.fn(async () => insertedBatch),
  newsReviewExpiresAt: vi.fn(() => 999),
  newsReviewSecret: vi.fn(() => 'secret'),
}));

import { confirmManualNewsLeadCandidate } from './manual-news-leads-store';
import { getActiveNewsReviewBatch, newsReviewExpiresAt } from './news-review';

function fakeConfirmationEnv() {
  const assessment = {
    title: 'Anthropic披露部分Claude输出的水印与来源标记',
    summary: '官方文档将范围限定为受支持的模型与产品。',
    event_key: 'anthropic-output-provenance-2026-08', event_type: 'product_documentation',
    material_update: false, score: 82, recommendation: 'recommended',
    occurred_at: '2026-08-10T00:00:00.000Z', uncertainties: [],
    claims: [{ text: '范围受限。', evidence_ids: ['ev-1'] }], matched_event_key: null,
    evidence_tier: 'official_primary', duplicate_scope: null, matched_lead_id: null,
  };
  const row: Record<string, any> = {
    id: 'ml-20260811-abc123def456', review_date: '2026-08-11', input_type: 'url', input_text: '',
    input_url: 'https://support.claude.com/example', note: '', status: 'recommended', version: 7,
    error_code: null, error_message: null, submit_idempotency_key: 'submit',
    last_mutation_kind: null, last_mutation_idempotency_key: null,
    confirmed_batch_id: null, confirmed_at: null, created_at: 1, updated_at: 1,
  };
  const evidence = {
    evidence_id: 'ev-1', url: row.input_url, source_type: 'official_help', publisher: 'Anthropic',
    published_at: null, retrieved_at: 2, title: 'Documentation', excerpt: 'Supported outputs only.',
    claims_supported_json: JSON.stringify(['Supported outputs only.']), reliable: 1,
  };
  const prepared: any[] = [];
  const db = {
    prepare(sql: string) {
      let binds: any[] = [];
      const stmt = {
        sql,
        get binds() { return binds; },
        bind(...values: any[]) { binds = values; return stmt; },
        async first() {
          if (sql.includes('manual_lead:by_id')) return { ...row };
          if (sql.includes('manual_assessment:latest')) return { assessment_json: JSON.stringify(assessment) };
          return null;
        },
        async all() {
          if (sql.includes('manual_evidence:list')) return { results: [evidence] };
          return { results: [] };
        },
        async run() { return { success: true, meta: { changes: 1 } }; },
      };
      prepared.push(stmt);
      return stmt;
    },
    async batch(statements: any[]) {
      const batchStmt = statements.find((stmt: any) => stmt.sql.includes('manual_lead:confirm_batch'));
      const confirmStmt = statements.find((stmt: any) => stmt.sql.includes('manual_lead:confirm */'));
      const prefreezeStmt = statements.find((stmt: any) => stmt.sql.includes('manual_lead:confirm_prefreeze'));
      const expectedVersion = batchStmt ? confirmStmt.binds[5] : prefreezeStmt.binds[4];
      if (row.version === expectedVersion && batchStmt) {
        const candidates = JSON.parse(batchStmt.binds[3]);
        insertedBatch = {
          ...activeBatch,
          batch_id: batchStmt.binds[1], candidate_ids: JSON.parse(batchStmt.binds[2]), candidates,
          default_selected_ids: JSON.parse(batchStmt.binds[4]), batch_revision: batchStmt.binds[7],
          supersedes_batch_id: batchStmt.binds[8], revision_origin: 'manual_lead',
        };
        row.version += 1;
        row.confirmed_batch_id = confirmStmt.binds[0];
        row.confirmed_at = confirmStmt.binds[1];
        row.last_mutation_kind = 'confirm';
        row.last_mutation_idempotency_key = confirmStmt.binds[2];
      } else if (row.version === expectedVersion && prefreezeStmt) {
        row.version += 1;
        row.confirmed_at = prefreezeStmt.binds[0];
        row.last_mutation_kind = 'confirm';
        row.last_mutation_idempotency_key = prefreezeStmt.binds[1];
      }
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };
  return { env: { DB: db, DAILY_NEWS_REVIEW_SECRET: 'secret' } as never, row, prepared };
}

describe('manual lead candidate confirmation', () => {
  beforeEach(() => {
    insertedBatch = null;
    vi.mocked(newsReviewExpiresAt).mockReturnValue(999);
  });

  test('atomically supersedes V1 with a capped V2 while preserving current published Top selection', async () => {
    const memory = fakeConfirmationEnv();
    const result = await confirmManualNewsLeadCandidate(
      memory.env, memory.row.id, 7, 1, 'confirm-key-1', 100,
    );

    expect(result).toMatchObject({
      ok: true, changed: true, rerender_enqueued: false, pending_initial_freeze: false,
      batch: { batch_id: 'nr-20260811-newnewnewnew', revision: 2, supersedes_revision: 1, current: true },
    });
    expect(insertedBatch.candidates).toHaveLength(10);
    expect(insertedBatch.candidates.at(-1)).toMatchObject({
      item_id: `blog:manual:${memory.row.id}`, origin: 'manual_lead', lead_id: memory.row.id,
    });
    expect(insertedBatch.candidates.some((item: any) => item.item_id === 'news-10')).toBe(false);
    expect(insertedBatch.default_selected_ids).toEqual(['news-2', 'news-1', 'news-5']);
    expect(insertedBatch.applied_selected_ids).toBeNull();
  });

  test('replays the same confirmation key without another mutation and rejects a second confirmation', async () => {
    const memory = fakeConfirmationEnv();
    const first = await confirmManualNewsLeadCandidate(memory.env, memory.row.id, 7, 1, 'confirm-key-1', 100);
    expect(first.ok).toBe(true);
    const repeated = await confirmManualNewsLeadCandidate(memory.env, memory.row.id, 7, 1, 'confirm-key-1', 200);
    expect(repeated).toMatchObject({ ok: true, changed: false, rerender_enqueued: false });
    const conflict = await confirmManualNewsLeadCandidate(memory.env, memory.row.id, 7, 1, 'confirm-key-2', 300);
    expect(conflict).toMatchObject({ ok: false, status: 409, error: 'lead_already_confirmed', lead: { version: 8 } });
  });

  test('persists a pre-freeze confirmed lead as a candidate item without selecting or rendering it', async () => {
    vi.mocked(getActiveNewsReviewBatch).mockResolvedValueOnce(null);
    const memory = fakeConfirmationEnv();

    const result = await confirmManualNewsLeadCandidate(
      memory.env, memory.row.id, 7, 0, 'confirm-prefreeze', 100,
    );

    expect(result).toMatchObject({
      ok: true, changed: true, pending_initial_freeze: true, batch: null, rerender_enqueued: false,
      lead: { confirmed_at: 100 },
    });
    const itemStatement = memory.prepared.find((statement) => statement.sql.includes('manual_lead:confirm_item'));
    expect(itemStatement?.sql).toMatch(/NOT EXISTS \(SELECT 1 FROM daily_news_review_batches/);
    expect(memory.prepared.some((statement) => statement.sql.includes('manual_lead:confirm_batch'))).toBe(false);
    expect(memory.prepared.some((statement) => statement.sql.includes('manual_lead:supersede_batch'))).toBe(false);
    expect(memory.prepared.some((statement) => statement.sql.includes('manual_lead:activate_batch'))).toBe(false);

    const second = await confirmManualNewsLeadCandidate(
      memory.env, memory.row.id, 8, 0, 'different-confirm-key', 200,
    );
    expect(second).toMatchObject({ ok: false, status: 409, error: 'lead_already_confirmed' });
  });

  test('rejects a stale expected candidate revision before creating another batch', async () => {
    const memory = fakeConfirmationEnv();
    const result = await confirmManualNewsLeadCandidate(
      memory.env, memory.row.id, 7, 0, 'confirm-stale-batch', 100,
    );
    expect(result).toMatchObject({ ok: false, status: 409, error: 'candidate_batch_revision_conflict' });
    expect(insertedBatch).toBeNull();
  });

  test('rejects confirmation after the date-scoped review window expires', async () => {
    vi.mocked(newsReviewExpiresAt).mockReturnValueOnce(99);
    const memory = fakeConfirmationEnv();
    const result = await confirmManualNewsLeadCandidate(
      memory.env, memory.row.id, 7, 1, 'confirm-after-expiry', 100,
    );

    expect(result).toMatchObject({ ok: false, status: 409, error: 'review_expired' });
    expect(insertedBatch).toBeNull();
  });
});
