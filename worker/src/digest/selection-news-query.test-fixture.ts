// 行业要闻选品查询的共用测试夹具:真 SQLite(node:sqlite)+ 真迁移(schema.sql + migrations/*.sql),
// 供「授权行为不回退矩阵」与「D1 热点查询预算守护」两个测试文件复用。
//
// 为什么必须用真迁移而不是手写精简表:9/2 事故的直接机制是「规划器在生产那套索引里挑错了索引」,
// 只有把生产索引集合原样建出来,EXPLAIN QUERY PLAN 的断言才有意义。

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Env } from '../index';
import { FEED_REGISTRY } from '../feeds/registry';
import type { FeedDef } from '../feeds/types';

const here = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(here, '../..');

// 002-items-tier.sql 故意不在列:schema.sql 已经含它的 tier/next_refresh_at 列与
// idx_items_next_refresh / idx_items_deleted 两条索引,重复执行会因 duplicate column 报错。
// 032 是 033 的前置(daily_news_review_batches)。
const MIGRATIONS = [
  '016-ops-pool-tables.sql',
  '017-x-list-cursor.sql',
  '018-subscriptions.sql',
  '020-feed-order-index.sql',
  '022-blog-podcast.sql',
  '028-feed-list-query-indexes.sql',
  '032-daily-news-review.sql',
  '033-manual-news-leads.sql',
  '034-manual-news-assessment-verifications.sql',
  '035-manual-news-assessment-generation-cycles.sql',
  '036-manual-news-assessment-generation-cycles-v2.sql',
  '037-manual-news-proof-key-ids.sql',
  '038-news-review-human-priority.sql',
];

/** 真 SQLite 上的最小 D1 兼容层(prepare/bind/all/first/run),与 worker 里 env.DB 的用法一一对应。 */
export class SqliteD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  readonly preparedSql: string[] = [];

  constructor() {
    this.sqlite.exec(fs.readFileSync(path.join(workerRoot, 'schema.sql'), 'utf8'));
    for (const migration of MIGRATIONS) {
      this.sqlite.exec(fs.readFileSync(path.join(workerRoot, 'migrations', migration), 'utf8'));
    }
  }

  prepare(sql: string) {
    this.preparedSql.push(sql);
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

  /** D1 的 batch 语义:整批在一个事务里按序执行,任一条失败整批回滚。 */
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

  /** 直接跑 EXPLAIN QUERY PLAN,返回逐行 detail。 */
  plan(sql: string, ...binds: unknown[]): string[] {
    return (this.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(binds as SQLInputValue[])) as Array<{ detail: string }>)
      .map((row) => row.detail);
  }

  itemIndexNames(): string[] {
    return (this.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='items' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name);
  }

  close(): void { this.sqlite.close(); }
}

export function envWithDb(db: SqliteD1): Env {
  return { DB: db as unknown as D1Database } as Env;
}

export function feed(feedId: string): FeedDef {
  const found = FEED_REGISTRY.find((entry) => entry.id === feedId);
  if (!found) throw new Error(`fixture feed missing: ${feedId}`);
  return found;
}

/** 按 registry 真值写入一条 sources 行(config 即 FeedDef 本身,与生产 source-pipeline 落库形状一致)。 */
export function insertSource(
  db: SqliteD1,
  feedId: string,
  overrides: Record<string, unknown> = {},
): void {
  const def = feed(feedId);
  db.sqlite.prepare(
    'INSERT INTO sources (id, source_type, source_ref, name, config) VALUES (?, ?, ?, ?, ?)',
  ).run(
    def.id,
    String(overrides.sourceTypeColumn ?? def.kind),
    String(overrides.sourceRefColumn ?? def.key),
    def.name,
    overrides.config === undefined
      ? JSON.stringify({ ...def, ...(overrides.configPatch as Record<string, unknown> | undefined) })
      : (overrides.config as string | null),
  );
}

export interface ItemInput {
  id: string;
  sourceType: string;
  sourceId: string | null;
  sourceRef?: string | null;
  title?: string | null;
  extra: unknown;
  scrapedAt: string;
  publishedAt?: string | null;
  isRelevant?: number | null;
  deletedAt?: number | null;
  content?: string | null;
  contentTranslated?: string | null;
}

export function insertItem(db: SqliteD1, input: ItemInput): void {
  db.sqlite.prepare(
    `INSERT INTO items (id, source_type, source_id, source_ref, title, content, content_translated,
       published_at, scraped_at, is_relevant, extra, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.sourceType,
    input.sourceId,
    input.sourceRef ?? null,
    input.title ?? 'fixture title',
    input.content ?? 'fixture body',
    input.contentTranslated ?? null,
    // 同 isRelevant:`??` 会把显式传入的 null(源站没给发布时间)顶成 scrapedAt,
    // 「无 published_at」那一格就永远测不到。
    input.publishedAt === undefined ? input.scrapedAt : input.publishedAt,
    input.scrapedAt,
    // `?? 1` 会把显式传入的 null(未判定)也顶成 1,矩阵里「is_relevant 为 NULL」那格就测不到了。
    input.isRelevant === undefined ? 1 : input.isRelevant,
    typeof input.extra === 'string' ? input.extra : JSON.stringify(input.extra),
    input.deletedAt ?? null,
  );
}

/** 生产形状的合法正式信源 item extra(可用 overrides 制造各种"该被拒"的变体)。 */
export function scheduledExtra(feedId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const def = feed(feedId);
  const base: Record<string, unknown> = {
    feed_id: def.id,
    editorial_type: def.editorial_type,
    ai_category: 'model-release',
    ai_summary_zh: '夹具中文摘要,保证 selectable。',
    source_company: def.name,
  };
  if (def.kind === 'podcast') base.show_key = def.key;
  else base.feed_key = def.key;
  return { ...base, ...overrides };
}

/** 按 registry 形状构造一条合法 item(id / source_id 必须与 registry key 严格对应)。 */
export function scheduledItem(
  feedId: string,
  slug: string,
  scrapedAt: string,
  overrides: Partial<ItemInput> & { extraPatch?: Record<string, unknown> } = {},
): ItemInput {
  const def = feed(feedId);
  const sourceId = `${def.key}:${slug}`;
  const { extraPatch, ...rest } = overrides;
  return {
    id: `${def.kind}:${sourceId}`,
    sourceType: def.kind,
    sourceId,
    scrapedAt,
    // 标题默认带 slug:事件折叠(foldNewsEventsForDigest)按标题词元合并同事件,
    // 夹具里若所有条目同名会被折成一条,掩盖掉真正要测的放行/拒绝差异。
    title: `${def.key} ${slug}`,
    extra: scheduledExtra(feedId, extraPatch),
    ...rest,
  };
}
