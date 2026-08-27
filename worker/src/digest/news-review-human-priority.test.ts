// 人审优先（2026-08-19 事故回归测试）：owner 07:5x 在审核页提交重筛后，08:35 的
// daily-digest-rescore 自动重算冻结出新批次，把 applied_selected_ids 置空，
// 下游回落 digest_pool 自动排序并推了 r3，覆盖人审 r2。
//
// 这里跑真 SQLite + 真迁移，覆盖三件事：人审后自动冻结必须继承人审序列；
// 只允许剔除失效条目且补位追加在末尾；当日无人审时旧行为一字不变。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('./news-source-policy', () => ({
  formalNewsFinalGuardSqlPredicate: () => '1=1',
  formalNewsFinalGuardBindings: () => [],
  authorizeFormalNewsSet: vi.fn(async (_env: unknown, _date: string, ids: readonly string[]) => ({
    allowed_ids: ids.filter((id) => !id.startsWith('blog:weibo-hot-tech:')),
    decisions: ids.map((id) => ({
      item_id: id,
      allowed: !id.startsWith('blog:weibo-hot-tech:'),
      code: id.startsWith('blog:weibo-hot-tech:')
        ? 'DENY_LEGACY_RADAR_ITEM_ID'
        : 'ALLOW_SCHEDULED_FORMAL',
    })),
  })),
}));

import type { Env } from '../index';
import {
  createNewsReviewToken,
  freezeNewsReviewBatch,
  freezeNewsReviewBatchFromPool,
  getActiveNewsReviewBatch,
  getAppliedNewsReviewSelection,
  hasHumanReviewedNewsSelection,
  submitNewsReviewSelection,
  type NewsReviewCandidate,
} from './news-review';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.resolve(here, '../../migrations');
const DATE = '2026-08-19';
const SECRET = 'human-priority-secret';

class SqliteD1 {
  readonly sqlite = new DatabaseSync(':memory:');

  constructor() {
    this.sqlite.exec(`CREATE TABLE items (
      id TEXT PRIMARY KEY, source_type TEXT, source_id TEXT, source_ref TEXT, title TEXT,
      content TEXT, content_translated TEXT, author TEXT, url TEXT, published_at TEXT,
      scraped_at TEXT, is_relevant INTEGER, matched_by TEXT, lang TEXT, extra TEXT,
      deleted_at TEXT
    )`);
    this.sqlite.exec(`CREATE TABLE digest_pool (
      id INTEGER PRIMARY KEY AUTOINCREMENT, slot_key TEXT NOT NULL, source TEXT NOT NULL,
      density TEXT NOT NULL, item_ids TEXT NOT NULL, items_meta TEXT, generated_at INTEGER NOT NULL,
      UNIQUE(slot_key, source, density)
    )`);
    for (const migration of [
      '032-daily-news-review.sql',
      '033-manual-news-leads.sql',
      '034-manual-news-assessment-verifications.sql',
      '035-manual-news-assessment-generation-cycles.sql',
      '036-manual-news-assessment-generation-cycles-v2.sql',
      '037-manual-news-proof-key-ids.sql',
      '038-news-review-human-priority.sql',
    ]) {
      this.sqlite.exec(fs.readFileSync(path.join(migrations, migration), 'utf8'));
    }
  }

  prepare(sql: string) {
    let bindings: SQLInputValue[] = [];
    const statement = this.sqlite.prepare(sql);
    const prepared = {
      bind: (...values: unknown[]) => {
        bindings = values as SQLInputValue[];
        return prepared;
      },
      first: async <T>() => (statement.get(...bindings) as T | undefined) ?? null,
      all: async <T>() => ({ results: statement.all(...bindings) as T[], success: true, meta: {} }),
      run: async () => {
        const result = statement.run(...bindings);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
    return prepared;
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>): Promise<unknown[]> {
    this.sqlite.exec('BEGIN');
    try {
      const results: unknown[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void { this.sqlite.close(); }
}

const opened: SqliteD1[] = [];
afterEach(() => {
  while (opened.length) opened.pop()!.close();
});

function state() {
  const db = new SqliteD1();
  opened.push(db);
  const env = { DB: db as unknown as D1Database, DAILY_NEWS_REVIEW_SECRET: SECRET } as Env;
  return { db, env };
}

function scheduled(prefix: string, count: number, scoreBase = 100): NewsReviewCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    item_id: `${prefix}-${index + 1}`,
    title: `${prefix} 新闻 ${index + 1}`,
    summary: `${prefix} 新闻 ${index + 1} 摘要`,
    source: '量子位',
    score: scoreBase - index,
    event_key: `${prefix}-event-${index + 1}`,
  }));
}

async function humanSubmit(env: Env, selectedIds: string[], now: number) {
  const active = (await getActiveNewsReviewBatch(env, DATE))!;
  const token = await createNewsReviewToken(SECRET, DATE, active.batch_id);
  return submitNewsReviewSelection(env, {
    date: DATE, batch_id: active.batch_id, token, selected_ids: selectedIds,
  }, now);
}

describe('human review beats automatic ranking', () => {
  test('an automatic re-freeze inherits the human sequence instead of the fresh auto ranking', async () => {
    const { env } = state();
    const morning = scheduled('auto', 8);
    await freezeNewsReviewBatch(env, DATE, morning, morning.slice(0, 5).map((item) => item.item_id), 100);

    const submitted = await humanSubmit(env, ['auto-7', 'auto-2', 'auto-5'], 110);
    expect(submitted).toMatchObject({ ok: true, changed: true });
    expect((await getActiveNewsReviewBatch(env, DATE))?.human_reviewed).toBe(true);

    // 08:35 daily-digest-rescore：候选重打分 + 新增条目 + 全新的自动 Top5。
    const rescored = [
      ...morning.map((candidate) => ({
        ...candidate,
        title: `${candidate.title}（重评分）`,
        score: Number(candidate.score) - 7,
      })),
      ...scheduled('fresh', 2, 120),
    ];
    const refrozen = await freezeNewsReviewBatch(
      env, DATE, rescored, ['fresh-1', 'auto-3', 'auto-1', 'auto-4', 'auto-2'], 200,
    );

    expect(refrozen.batch.batch_revision).toBe(2);
    expect(refrozen.auto_repaired).toBe(false);
    expect(refrozen.batch.human_reviewed).toBe(true);
    // 人审的条目集合与相对顺序原样保留，自动排序只影响 default_selected_ids。
    expect(refrozen.batch.applied_selected_ids).toEqual(['auto-7', 'auto-2', 'auto-5']);
    expect(refrozen.batch.default_selected_ids).toEqual(['fresh-1', 'auto-3', 'auto-1', 'auto-4', 'auto-2']);
    expect(refrozen.batch.edit_revision).toBe(1);
    // 这是下游 payload / 邮件 / 日报页真正消费的那条读路径。
    await expect(getAppliedNewsReviewSelection(env, DATE)).resolves.toEqual(['auto-7', 'auto-2', 'auto-5']);
    await expect(hasHumanReviewedNewsSelection(env, DATE)).resolves.toBe(true);
  });

  test('the pool-driven rescore entry point keeps the human sequence as the production selection', async () => {
    const { db, env } = state();
    const morning = scheduled('auto', 8);
    await freezeNewsReviewBatch(env, DATE, morning, morning.slice(0, 5).map((item) => item.item_id), 100);
    await humanSubmit(env, ['auto-6', 'auto-1', 'auto-8'], 110);

    const rescoredIds = ['auto-3', 'auto-1', 'auto-4', 'auto-2', 'auto-5', 'auto-6', 'auto-7', 'auto-8'];
    for (const id of rescoredIds) {
      db.sqlite.prepare('INSERT INTO items (id, title, content, url, extra) VALUES (?, ?, ?, ?, ?)')
        .run(id, `${id} 标题`, `${id} 正文`, `https://example.com/${id}`, '{}');
    }
    db.sqlite.prepare(`INSERT INTO digest_pool (slot_key, source, density, item_ids, items_meta, generated_at)
      VALUES (?, 'news', 'normal', ?, ?, 1)`).run(
      `${DATE}-08`,
      JSON.stringify(rescoredIds.slice(0, 5)),
      JSON.stringify({ candidate_ids_after_exact_dedup: rescoredIds }),
    );

    const refrozen = await freezeNewsReviewBatchFromPool(env, DATE, 300);

    expect(refrozen.batch.human_reviewed).toBe(true);
    expect(refrozen.batch.applied_selected_ids).toEqual(['auto-6', 'auto-1', 'auto-8']);
    await expect(getAppliedNewsReviewSelection(env, DATE)).resolves.toEqual(['auto-6', 'auto-1', 'auto-8']);
  });

  test('only invalid ids are dropped and the automatic backfill lands after the human sequence', async () => {
    const { db, env } = state();
    const morning = scheduled('auto', 8);
    await freezeNewsReviewBatch(env, DATE, morning, morning.slice(0, 5).map((item) => item.item_id), 100);
    await humanSubmit(env, ['auto-7', 'auto-2', 'auto-1', 'auto-4', 'auto-6'], 110);
    // 人审选中的某条随后失效（手工线索证明作废 / 条目被删），生产选择里留下一个
    // 不再属于候选池的 id —— 这正是 auto_repaired 分支的本意。
    const active = (await getActiveNewsReviewBatch(env, DATE))!;
    db.sqlite.prepare(`UPDATE daily_news_review_batches SET applied_selected_ids = ?
      WHERE review_date = ? AND batch_id = ?`).run(
      JSON.stringify(['auto-7', 'gone-9', 'auto-2', 'auto-1', 'auto-4']), DATE, active.batch_id,
    );

    const repaired = await freezeNewsReviewBatch(
      env, DATE, scheduled('auto', 8, 90), ['auto-3', 'auto-1', 'auto-2', 'auto-4', 'auto-5'], 200,
    );

    expect(repaired.auto_repaired).toBe(true);
    expect(repaired.auto_repaired_invalid_ids).toEqual(['gone-9']);
    expect(repaired.batch.human_reviewed).toBe(true);
    // 失效条目剔除，其余人审顺序不变，补位的自动条目只能追加在末尾。
    expect(repaired.batch.applied_selected_ids).toEqual([
      'auto-7', 'auto-2', 'auto-1', 'auto-4', 'auto-3',
    ]);
    expect(repaired.batch.publish_status).toBe('pending');
  });

  test('the last human submission wins and survives the next automatic freeze', async () => {
    const { env } = state();
    const morning = scheduled('auto', 8);
    await freezeNewsReviewBatch(env, DATE, morning, morning.slice(0, 5).map((item) => item.item_id), 100);

    await humanSubmit(env, ['auto-1', 'auto-2', 'auto-3'], 110);
    const second = await humanSubmit(env, ['auto-8', 'auto-4'], 120);
    expect(second).toMatchObject({ ok: true, changed: true });

    const refrozen = await freezeNewsReviewBatch(
      env, DATE, scheduled('auto', 8, 88), ['auto-5', 'auto-6', 'auto-7', 'auto-1', 'auto-2'], 200,
    );

    expect(refrozen.batch.applied_selected_ids).toEqual(['auto-8', 'auto-4']);
    await expect(getAppliedNewsReviewSelection(env, DATE)).resolves.toEqual(['auto-8', 'auto-4']);
  });

  test('an already frozen human selection is revalidated and drops a legacy radar identity', async () => {
    const { db, env } = state();
    const morning = scheduled('auto', 6);
    for (const candidate of morning) {
      db.sqlite.prepare(
        `INSERT INTO items (id, source_type, source_id, source_ref, title, content, url, extra)
         VALUES (?, 'blog', ?, NULL, ?, ?, ?, ?)`,
      ).run(
        candidate.item_id,
        candidate.item_id,
        candidate.title,
        candidate.summary,
        `https://example.com/${candidate.item_id}`,
        JSON.stringify({ feed_id: 'blog:qbitai', feed_key: 'qbitai', editorial_type: 'third-party-media' }),
      );
    }
    await freezeNewsReviewBatch(
      env,
      DATE,
      morning,
      morning.slice(0, 5).map((item) => item.item_id),
      100,
    );
    const active = (await getActiveNewsReviewBatch(env, DATE))!;
    const radarId = 'blog:weibo-hot-tech:legacy-radar';
    const historicalCandidates = morning.map((candidate, index) => index === 0
      ? { ...candidate, item_id: radarId, source: '微博' }
      : candidate);
    db.sqlite.prepare(
      `UPDATE daily_news_review_batches
          SET candidate_ids=?, candidates_json=?, default_selected_ids=?, applied_selected_ids=?,
              selection_hash='legacy-radar-snapshot', human_reviewed=1
        WHERE review_date=? AND batch_id=?`,
    ).run(
      JSON.stringify(historicalCandidates.map((candidate) => candidate.item_id)),
      JSON.stringify(historicalCandidates),
      JSON.stringify(historicalCandidates.slice(0, 5).map((candidate) => candidate.item_id)),
      JSON.stringify([radarId, 'auto-2']),
      DATE,
      active.batch_id,
    );

    await expect(getAppliedNewsReviewSelection(env, DATE)).resolves.toEqual(['auto-2']);
    expect((await getActiveNewsReviewBatch(env, DATE))?.candidate_ids)
      .not.toContain(radarId);
  });

  test('a day without any human review keeps the previous fully automatic behaviour', async () => {
    const { env } = state();
    const morning = scheduled('auto', 8);
    const first = await freezeNewsReviewBatch(
      env, DATE, morning, morning.slice(0, 5).map((item) => item.item_id), 100,
    );
    await expect(hasHumanReviewedNewsSelection(env, DATE)).resolves.toBe(false);

    const refrozen = await freezeNewsReviewBatch(
      env, DATE, scheduled('auto', 8, 70), ['auto-4', 'auto-3', 'auto-2', 'auto-1', 'auto-5'], 200,
    );

    expect(first.batch.applied_selected_ids).toBeNull();
    expect(refrozen.batch.batch_revision).toBe(2);
    expect(refrozen.batch.human_reviewed).toBe(false);
    expect(refrozen.batch.applied_selected_ids).toBeNull();
    expect(refrozen.batch.publish_status).toBe('not_requested');
    expect(refrozen.batch.default_selected_ids).toEqual(['auto-4', 'auto-3', 'auto-2', 'auto-1', 'auto-5']);
    await expect(getAppliedNewsReviewSelection(env, DATE)).resolves.toBeNull();
    await expect(hasHumanReviewedNewsSelection(env, DATE)).resolves.toBe(false);
  });
});
