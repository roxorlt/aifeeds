// 审核候选携带源站发布时间(2026-09-02)。
//
// 起因:审核页只有标题/摘要/来源/评分,owner 没法判断候选的新旧 ——
// 把北京时间凌晨发布的 Gemini 3.7 误当成旧闻。上游 selectNewsByScoreWithAudit 的 SELECT
// 一直取着 i.published_at,只是批次冻结序列化 candidates_json 时丢掉了。
//
// 本文件在真 SQLite + 真迁移上钉三件事:
//   ① 定时候选冻结出的 candidates_json 带 published_at(ISO 原值,不格式化不换算时区);
//   ② 源站没给发布时间时省略该字段(绝不用 scraped_at 冒充);
//   ③ 旧批次(没有该字段)读取不炸,且 sanitize 不会因此重排。

import { afterEach, expect, test } from 'vitest';

import { FEED_REGISTRY } from '../feeds/registry';
import {
  envWithDb,
  insertItem,
  insertSource,
  SqliteD1,
} from './selection-news-query.test-fixture';
import { freezeNewsReviewBatchFromPool } from './news-review';

const opened: SqliteD1[] = [];
afterEach(() => {
  while (opened.length) opened.pop()!.close();
});

const DATE = '2026-09-02';
const SCRAPED_AT = '2026-09-02T00:10:00.000Z';
const FEED_ID = 'blog:google';

function feedKey(): string {
  return FEED_REGISTRY.find((entry) => entry.id === FEED_ID)!.key;
}

interface PoolItem {
  slug: string;
  title: string;
  /** undefined = 源站没给发布时间(items.published_at 为 NULL)。 */
  publishedAt?: string;
}

/**
 * 造一个刚好能过 freezeNewsReviewBatchFromPool 前置门槛的 news 池
 * (候选 ≥5、默认选中 ≥5),并把 items 落成生产形状的合法官方信源条目。
 */
function installNewsPool(db: SqliteD1, items: readonly PoolItem[]): string[] {
  insertSource(db, FEED_ID);
  const key = feedKey();
  const ids: string[] = [];
  for (const [index, item] of items.entries()) {
    const sourceId = `${key}:${item.slug}`;
    const id = `blog:${sourceId}`;
    ids.push(id);
    insertItem(db, {
      id,
      sourceType: 'blog',
      sourceId,
      title: item.title,
      scrapedAt: SCRAPED_AT,
      // insertItem 的 publishedAt 缺省会回落到 scrapedAt;这里必须显式给 null,
      // 才能造出「源站没给发布时间」那一格。
      publishedAt: item.publishedAt ?? null,
      extra: {
        feed_id: FEED_ID,
        feed_key: key,
        editorial_type: 'official',
        title_zh: item.title,
        ai_summary_zh: `${item.title} 的中文摘要。`,
        source_company: 'Google',
        ai_category: 'model-release',
      },
    });
    db.sqlite.prepare('UPDATE items SET url = ? WHERE id = ?')
      .run(`https://blog.google/${item.slug}`, id);
    void index;
  }
  db.sqlite.prepare(
    `INSERT INTO digest_pool (slot_key, source, density, item_ids, items_meta, generated_at)
     VALUES (?, 'news', 'normal', ?, ?, 1)`,
  ).run(
    `${DATE}-08`,
    JSON.stringify(ids.slice(0, 5)),
    JSON.stringify({
      candidate_ids_after_exact_dedup: ids,
      candidates: ids.map((id, index) => ({
        rank: index + 1,
        id,
        title: items[index].title,
        title_zh: items[index].title,
        source_company: 'Google',
        adjusted_score: 100 - index,
        published_at: items[index].publishedAt ?? '',
      })),
    }),
  );
  return ids;
}

function poolOf(count: number, overrides: Partial<Record<number, PoolItem>> = {}): PoolItem[] {
  return Array.from({ length: count }, (_, index) => overrides[index] ?? {
    slug: `pool-${index + 1}`,
    title: `候选${index + 1}`,
    publishedAt: `2026-09-02T0${index}:30:00.000Z`,
  });
}

test('定时候选冻结后带 published_at,ISO 原值透传', async () => {
  const db = new SqliteD1();
  opened.push(db);
  installNewsPool(db, poolOf(6));

  const frozen = await freezeNewsReviewBatchFromPool(envWithDb(db), DATE, Date.parse(SCRAPED_AT));

  expect(frozen.batch.candidates).toHaveLength(6);
  expect(frozen.batch.candidates.map((candidate) => candidate.published_at)).toEqual([
    '2026-09-02T00:30:00.000Z',
    '2026-09-02T01:30:00.000Z',
    '2026-09-02T02:30:00.000Z',
    '2026-09-02T03:30:00.000Z',
    '2026-09-02T04:30:00.000Z',
    '2026-09-02T05:30:00.000Z',
  ]);

  // 落库的 candidates_json 里就带着(消费端读的是这一份,不是内存对象)。
  const row = db.sqlite.prepare(
    'SELECT candidates_json FROM daily_news_review_batches WHERE batch_id = ?',
  ).get(frozen.batch.batch_id) as { candidates_json: string };
  const persisted = JSON.parse(row.candidates_json) as Array<Record<string, unknown>>;
  expect(persisted[0].published_at).toBe('2026-09-02T00:30:00.000Z');
  // 这就是本次改动要解决的场景:北京时间凌晨发布的新闻,审核页现在能看出它是「今天凌晨」。
  expect(String(persisted[0].published_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

test('源站没给发布时间时省略字段,绝不用 scraped_at 冒充', async () => {
  const db = new SqliteD1();
  opened.push(db);
  installNewsPool(db, poolOf(6, {
    2: { slug: 'pool-3', title: '候选3无发布时间' },
  }));

  const frozen = await freezeNewsReviewBatchFromPool(envWithDb(db), DATE, Date.parse(SCRAPED_AT));

  const missing = frozen.batch.candidates[2];
  expect(missing.item_id).toBe(`blog:${feedKey()}:pool-3`);
  // 字段整个不存在,而不是 null / 空串 / 用 scraped_at 顶上。
  expect('published_at' in missing).toBe(false);
  const row = db.sqlite.prepare(
    'SELECT candidates_json FROM daily_news_review_batches WHERE batch_id = ?',
  ).get(frozen.batch.batch_id) as { candidates_json: string };
  const persisted = JSON.parse(row.candidates_json) as Array<Record<string, unknown>>;
  expect(Object.keys(persisted[2])).not.toContain('published_at');
  expect(JSON.stringify(persisted[2])).not.toContain(SCRAPED_AT);
  // 其它有值的候选不受影响。
  expect(persisted[0].published_at).toBe('2026-09-02T00:30:00.000Z');
});

test('items 行没有 published_at 时回落到选品审计里的同名字段', async () => {
  const db = new SqliteD1();
  opened.push(db);
  const items = poolOf(6, { 1: { slug: 'pool-2', title: '候选2仅审计有时间' } });
  installNewsPool(db, items);
  // 审计里保留时间,items 行没有 —— 冻结应当用审计值补上。
  const poolRow = db.sqlite.prepare(
    "SELECT items_meta FROM digest_pool WHERE slot_key = ? AND source = 'news' AND density = 'normal'",
  ).get(`${DATE}-08`) as { items_meta: string };
  const meta = JSON.parse(poolRow.items_meta) as { candidates: Array<Record<string, unknown>> };
  meta.candidates[1].published_at = '2026-09-01T22:05:00.000Z';
  db.sqlite.prepare(
    "UPDATE digest_pool SET items_meta = ? WHERE slot_key = ? AND source = 'news' AND density = 'normal'",
  ).run(JSON.stringify(meta), `${DATE}-08`);

  const frozen = await freezeNewsReviewBatchFromPool(envWithDb(db), DATE, Date.parse(SCRAPED_AT));

  expect(frozen.batch.candidates[1].published_at).toBe('2026-09-01T22:05:00.000Z');
});

test('旧批次(candidates_json 没有该字段)读取不炸,字段为 undefined', async () => {
  const db = new SqliteD1();
  opened.push(db);
  installNewsPool(db, poolOf(6));
  const frozen = await freezeNewsReviewBatchFromPool(envWithDb(db), DATE, Date.parse(SCRAPED_AT));

  // 把落库的 candidates_json 改回改造前的形状(逐条删掉 published_at),模拟历史批次。
  const row = db.sqlite.prepare(
    'SELECT candidates_json FROM daily_news_review_batches WHERE batch_id = ?',
  ).get(frozen.batch.batch_id) as { candidates_json: string };
  const legacy = (JSON.parse(row.candidates_json) as Array<Record<string, unknown>>)
    .map(({ published_at: _dropped, ...rest }) => rest);
  db.sqlite.prepare('UPDATE daily_news_review_batches SET candidates_json = ? WHERE batch_id = ?')
    .run(JSON.stringify(legacy), frozen.batch.batch_id);

  const { getActiveNewsReviewBatch } = await import('./news-review');
  const reread = await getActiveNewsReviewBatch(envWithDb(db), DATE);

  expect(reread?.candidates).toHaveLength(6);
  expect(reread?.candidates[0].published_at).toBeUndefined();
  expect(reread?.candidates[0].item_id).toBe(`blog:${feedKey()}:pool-1`);
});

test('变异验证:序列化时丢掉 published_at,上面的断言全部落空', async () => {
  const db = new SqliteD1();
  opened.push(db);
  installNewsPool(db, poolOf(6));
  const frozen = await freezeNewsReviewBatchFromPool(envWithDb(db), DATE, Date.parse(SCRAPED_AT));

  // 变异体 = 改造前的序列化:候选字面量里不展开 published_at。
  const mutated = frozen.batch.candidates.map(({ published_at: _dropped, ...rest }) => rest);

  // 真实实现下每条都有值……
  expect(frozen.batch.candidates.every((candidate) => !!candidate.published_at)).toBe(true);
  // ……变异体下一条都没有,第一个用例的断言必红。
  expect(mutated.every((candidate) => !('published_at' in candidate))).toBe(true);
  expect(JSON.stringify(mutated)).not.toContain('published_at');
});
