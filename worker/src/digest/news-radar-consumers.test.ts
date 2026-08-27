import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('./selection', () => ({
  selectTopForSource: vi.fn(async () => [] as string[]),
}));

import type { Env } from '../index';
import { FEED_REGISTRY } from '../feeds/registry';
import { buildStagedDailyCodexPayload } from './codex-push';
import { buildDailyPageData } from './daily-page';
import {
  freezeNewsReviewBatch,
  getActiveNewsReviewBatch,
  getAppliedNewsReviewSelection,
  getPublishedNewsReviewSelection,
  type NewsReviewCandidate,
} from './news-review';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.resolve(here, '../../migrations');
const DATE = '2026-08-27';
const RADAR_IDS = [
  'generic-radar-source-id',
  'generic-radar-source-ref',
  'generic-radar-feed-id',
  'generic-radar-feed-key',
];
const FORMAL_ID = 'blog:openai:formal-news';

class SqliteD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  beforeFirst: ((sql: string) => void) | null = null;
  beforeBatch: (() => void) | null = null;

  constructor() {
    this.sqlite.exec(`CREATE TABLE items (
      id TEXT PRIMARY KEY, source_type TEXT, source_id TEXT, source_ref TEXT, title TEXT,
      content TEXT, content_translated TEXT, author TEXT, handle TEXT, url TEXT, media TEXT,
      published_at TEXT, scraped_at TEXT, is_relevant INTEGER, matched_by TEXT, lang TEXT,
      extra TEXT, deleted_at TEXT
    )`);
    this.sqlite.exec(`CREATE TABLE sources (
      id TEXT PRIMARY KEY, source_type TEXT NOT NULL, source_ref TEXT,
      name TEXT, config TEXT
    )`);
    this.sqlite.exec(`CREATE TABLE digest_pool (
      id INTEGER PRIMARY KEY AUTOINCREMENT, slot_key TEXT NOT NULL, source TEXT NOT NULL,
      density TEXT NOT NULL, item_ids TEXT NOT NULL, items_meta TEXT, generated_at INTEGER NOT NULL,
      UNIQUE(slot_key, source, density)
    )`);
    this.sqlite.exec(`CREATE TABLE daily_pages (date TEXT PRIMARY KEY)`);
    for (const migration of [
      '032-daily-news-review.sql',
      '033-manual-news-leads.sql',
      '034-manual-news-assessment-verifications.sql',
      '035-manual-news-assessment-generation-cycles.sql',
      '036-manual-news-assessment-generation-cycles-v2.sql',
      '037-manual-news-proof-key-ids.sql',
      '038-news-review-human-priority.sql',
      '040-daily-release-publications.sql',
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
      first: async <T>() => {
        this.beforeFirst?.(sql);
        return (statement.get(...bindings) as T | undefined) ?? null;
      },
      all: async <T>() => ({ results: statement.all(...bindings) as T[], success: true, meta: {} }),
      run: async () => {
        const result = statement.run(...bindings);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
    return prepared;
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>): Promise<unknown[]> {
    const hook = this.beforeBatch;
    this.beforeBatch = null;
    hook?.();
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

function candidate(itemId: string, score: number): NewsReviewCandidate {
  return {
    item_id: itemId,
    title: `${itemId} title`,
    summary: `${itemId} summary`,
    source: 'fixture',
    score,
    event_key: `${itemId}-event`,
  };
}

async function legacyRadarState(): Promise<{ env: Env; db: SqliteD1 }> {
  const db = new SqliteD1();
  opened.push(db);
  const env = {
    DB: db as unknown as D1Database,
    SITE_BASE: 'https://ai-feeds.test',
    API_BASE: 'https://api.ai-feeds.test',
    DAILY_NEWS_REVIEW_SECRET: 'radar-consumer-secret',
  } as Env;
  const openai = FEED_REGISTRY.find((feed) => feed.id === 'blog:openai')!;
  db.sqlite.prepare(
    `INSERT INTO sources (id, source_type, source_ref, name, config) VALUES (?, ?, ?, ?, ?)`,
  ).run(openai.id, openai.kind, openai.key, openai.name, JSON.stringify(openai));
  const rows = [
    [RADAR_IDS[0], 'weibo-hot-tech:legacy', null, {}],
    [RADAR_IDS[1], 'generic-source', 'weibo-hot-tech', {}],
    [RADAR_IDS[2], 'generic-source', null, { feed_id: 'blog:weibo-hot-tech' }],
    [RADAR_IDS[3], 'generic-source', null, { feed_key: 'weibo-hot-tech' }],
    [FORMAL_ID, 'openai:formal-news', null, {
      editorial_type: 'official', feed_id: 'blog:openai', feed_key: 'openai',
    }],
  ] as const;
  for (const [id, sourceId, sourceRef, extra] of rows) {
    db.sqlite.prepare(
      `INSERT INTO items (
        id, source_type, source_id, source_ref, title, content, content_translated,
        author, handle, url, media, published_at, scraped_at, is_relevant, extra
      ) VALUES (?, 'blog', ?, ?, ?, ?, ?, 'fixture', 'fixture', ?, NULL, ?, ?, 1, ?)`,
    ).run(
      id,
      sourceId,
      sourceRef,
      `${id} title`,
      `${id} content`,
      `${id} translated`,
      `https://example.com/${id}`,
      '2026-08-27T00:00:00.000Z',
      '2026-08-27T00:00:00.000Z',
      JSON.stringify(extra),
    );
  }
  const candidates = [...RADAR_IDS, FORMAL_ID].map((id, index) => candidate(id, 100 - index));
  const seedIds = [FORMAL_ID, ...Array.from({ length: 4 }, (_, index) => `blog:openai:legacy-seed-${index + 1}`)];
  for (const id of seedIds.slice(1)) {
    db.sqlite.prepare(
      `INSERT INTO items (
        id, source_type, source_id, source_ref, title, content, content_translated,
        author, handle, url, media, published_at, scraped_at, is_relevant, extra
      ) VALUES (?, 'blog', ?, NULL, ?, ?, ?, 'fixture', 'fixture', ?, NULL, ?, ?, 1, ?)`,
    ).run(
      id,
      id.slice('blog:'.length),
      `${id} title`,
      `${id} content`,
      `${id} translated`,
      `https://example.com/${id}`,
      '2026-08-27T00:00:00.000Z',
      '2026-08-27T00:00:00.000Z',
      JSON.stringify({ editorial_type: 'official', feed_id: 'blog:openai', feed_key: 'openai' }),
    );
  }
  const seedCandidates = seedIds.map((id, index) => candidate(id, 100 - index));
  const frozen = await freezeNewsReviewBatch(
    env, DATE, seedCandidates, seedCandidates.map((item) => item.item_id), 100,
  );
  db.sqlite.prepare(
    `UPDATE daily_news_review_batches
        SET candidate_ids=?, candidates_json=?, default_selected_ids=?, applied_selected_ids=?,
            selection_hash='legacy-generic-radar', human_reviewed=1
      WHERE review_date=? AND batch_id=?`,
  ).run(
    JSON.stringify(candidates.map((item) => item.item_id)),
    JSON.stringify(candidates),
    JSON.stringify(candidates.map((item) => item.item_id)),
    JSON.stringify(candidates.map((item) => item.item_id)),
    DATE,
    frozen.batch.batch_id,
  );
  return { env, db };
}

test('applied selection excludes generic legacy radar identified independently by every provenance field', async () => {
  const { env } = await legacyRadarState();

  await expect(getAppliedNewsReviewSelection(env, DATE)).resolves.toEqual([FORMAL_ID]);
  expect((await getActiveNewsReviewBatch(env, DATE))?.candidate_ids).toEqual([FORMAL_ID]);
});

test('daily page never renders generic legacy radar from an applied selection', async () => {
  const { env } = await legacyRadarState();

  const page = await buildDailyPageData(env, DATE);

  expect(page?.sections.find((section) => section.source === 'news')?.items.map((item) => item.item_id))
    .toEqual([FORMAL_ID]);
});

test('staged editorial payload never includes generic legacy radar from a frozen batch', async () => {
  const { env } = await legacyRadarState();

  const payload = await buildStagedDailyCodexPayload(env, 'editorial', { date: DATE });

  expect(payload.digest.sections.normal.flatMap((section) => section.items).map((item) => item.item_id))
    .toEqual([FORMAL_ID]);
});

test.each([
  ['source disabled', (db: SqliteD1) => {
    const config = JSON.parse(db.sqlite.prepare(`SELECT config FROM sources WHERE id='blog:openai'`).get()!.config as string);
    db.sqlite.prepare(`UPDATE sources SET config=? WHERE id='blog:openai'`).run(JSON.stringify({ ...config, enabled: false }));
  }],
  ['source changed to radar', (db: SqliteD1) => {
    const config = JSON.parse(db.sqlite.prepare(`SELECT config FROM sources WHERE id='blog:openai'`).get()!.config as string);
    db.sqlite.prepare(`UPDATE sources SET config=? WHERE id='blog:openai'`).run(JSON.stringify({ ...config, editorial_type: 'radar' }));
  }],
  ['item changed to radar', (db: SqliteD1) => {
    db.sqlite.prepare(`UPDATE items SET extra=json_set(extra, '$.editorial_type', 'radar') WHERE id=?`).run(FORMAL_ID);
  }],
  ['backing item removed', (db: SqliteD1) => {
    db.sqlite.prepare(`DELETE FROM items WHERE id=?`).run(FORMAL_ID);
  }],
] as const)('outward consumers fail closed when %s after the review was frozen', async (_name, mutate) => {
  const { env, db } = await legacyRadarState();
  mutate(db);

  await expect(getAppliedNewsReviewSelection(env, DATE)).resolves.toEqual([]);
  const page = await buildDailyPageData(env, DATE);
  expect(page?.sections.find((section) => section.source === 'news')?.items || []).toEqual([]);
  await expect(buildStagedDailyCodexPayload(env, 'editorial', { date: DATE }))
    .rejects.toThrow('empty_stage:editorial');
});

test('published projection binds the batch snapshot and item authorization in its final read', async () => {
  const { env, db } = await legacyRadarState();
  await getAppliedNewsReviewSelection(env, DATE);
  const active = await getActiveNewsReviewBatch(env, DATE);
  expect(active).not.toBeNull();
  let mutated = false;
  db.beforeFirst = (sql) => {
    if (mutated || !sql.includes('news_review:batch_formal_final_guard')) return;
    mutated = true;
    db.sqlite.prepare(
      `UPDATE daily_news_review_batches SET edit_revision=edit_revision+1 WHERE review_date=? AND batch_id=?`,
    ).run(DATE, active!.batch_id);
  };

  const published = await getPublishedNewsReviewSelection(env, DATE, active!);
  expect(mutated).toBe(true);
  expect(published).toEqual([]);
});

test('freeze authorization-to-write race is rejected by the formal-news insert CAS', async () => {
  const { env, db } = await legacyRadarState();
  const ids = Array.from({ length: 5 }, (_, index) => `blog:openai:cas-${index + 1}`);
  for (const id of ids) {
    db.sqlite.prepare(
      `INSERT INTO items (
        id,source_type,source_id,source_ref,title,content,content_translated,author,handle,url,
        published_at,scraped_at,is_relevant,extra
      ) VALUES (?,'blog',?,NULL,?,?,?,'fixture','fixture',?,'2026-08-27','2026-08-27',1,?)`,
    ).run(
      id, id.slice('blog:'.length), `${id} title`, `${id} content`, `${id} translated`,
      `https://example.com/${id}`,
      JSON.stringify({ editorial_type: 'official', feed_id: 'blog:openai', feed_key: 'openai' }),
    );
  }
  const next = ids.map((id, index) => candidate(id, 100 - index));
  db.beforeBatch = () => {
    const config = JSON.parse(db.sqlite.prepare(
      `SELECT config FROM sources WHERE id='blog:openai'`,
    ).get()!.config as string);
    db.sqlite.prepare(`UPDATE sources SET config=? WHERE id='blog:openai'`)
      .run(JSON.stringify({ ...config, enabled: false }));
  };

  await expect(freezeNewsReviewBatch(env, DATE, next, ids, 200))
    .rejects.toThrow('news_review_formal_authorization_stale');
  expect(db.sqlite.prepare(
    `SELECT COUNT(*) AS n FROM daily_news_review_batches WHERE candidate_ids=?`,
  ).get(JSON.stringify(ids))).toEqual({ n: 0 });
});
