import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';

import type { Env } from '../index';
import { FEED_REGISTRY } from '../feeds/registry';
import * as policy from './news-source-policy';

class SqliteD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  readonly preparedSql: string[] = [];
  beforeAll: ((sql: string) => void) | null = null;

  constructor() {
    this.sqlite.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_id TEXT,
        source_ref TEXT,
        title TEXT,
        content TEXT,
        content_translated TEXT,
        author TEXT,
        url TEXT,
        published_at TEXT,
        extra TEXT,
        deleted_at TEXT
      );
      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_ref TEXT,
        name TEXT,
        config TEXT
      );
      CREATE TABLE manual_news_leads (
        id TEXT PRIMARY KEY,
        review_date TEXT NOT NULL,
        status TEXT NOT NULL,
        confirmed_at INTEGER,
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE manual_news_event_assessments (
        lead_id TEXT, assessment_version INTEGER, assessment_json TEXT,
        PRIMARY KEY (lead_id, assessment_version)
      );
      CREATE TABLE manual_news_assessment_verifications (
        verification_id TEXT PRIMARY KEY, lead_id TEXT, assessment_version INTEGER,
        policy_version TEXT, verification_key_id TEXT, canonical_digest TEXT,
        hmac_sha256 TEXT, verification_json TEXT, processing_owner TEXT,
        processing_attempt INTEGER, creation_nonce TEXT, invalidation_nonce TEXT,
        status TEXT, reason TEXT, created_at INTEGER, invalidated_at INTEGER
      );
    `);
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
      all: async <T>() => {
        this.beforeAll?.(sql);
        return { results: statement.all(...bindings) as T[], success: true, meta: {} };
      },
      run: async () => {
        const result = statement.run(...bindings);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
    return prepared;
  }

  close(): void { this.sqlite.close(); }
}

const opened: SqliteD1[] = [];
afterEach(() => {
  while (opened.length) opened.pop()!.close();
});

function envWithDb(db: SqliteD1): Env {
  return { DB: db as unknown as D1Database } as Env;
}

function sourceConfig(feedId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const feed = FEED_REGISTRY.find((entry) => entry.id === feedId);
  if (!feed) throw new Error(`fixture feed missing: ${feedId}`);
  return { ...feed, ...overrides };
}

function insertSource(db: SqliteD1, feedId: string, overrides: Record<string, unknown> = {}): void {
  const feed = FEED_REGISTRY.find((entry) => entry.id === feedId)!;
  db.sqlite.prepare(
    'INSERT INTO sources (id, source_type, source_ref, name, config) VALUES (?, ?, ?, ?, ?)',
  ).run(feed.id, feed.kind, feed.key, feed.name, JSON.stringify(sourceConfig(feedId, overrides)));
}

function insertItem(
  db: SqliteD1,
  input: {
    id: string;
    sourceType: string;
    sourceId: string | null;
    sourceRef?: string | null;
    extra: unknown;
    deletedAt?: string | null;
  },
): void {
  const extra = typeof input.extra === 'string' ? input.extra : JSON.stringify(input.extra);
  db.sqlite.prepare(
    `INSERT INTO items (id, source_type, source_id, source_ref, extra, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.sourceType,
    input.sourceId,
    input.sourceRef ?? null,
    extra,
    input.deletedAt ?? null,
  );
}

async function authorize(db: SqliteD1, ids: string[]) {
  const fn = (policy as unknown as {
    authorizeFormalNewsSet?: (
      env: Env,
      reviewDate: string,
      candidates: readonly string[],
      purpose: string,
    ) => Promise<{ allowed_ids: string[]; decisions: Array<{ item_id: string; code: string; allowed: boolean }> }>;
  }).authorizeFormalNewsSet;
  expect(fn, 'canonical authorizeFormalNewsSet export').toBeTypeOf('function');
  return fn!(envWithDb(db), '2026-08-27', ids, 'test');
}

describe('canonical formal-news authorization', () => {
  test('explicit item radar is the highest deny even for manual-looking identity', () => {
    expect(policy.isRadarNewsItemIdentity({
      id: 'blog:manual:lead-1',
      sourceId: 'manual:lead-1',
      sourceRef: 'manual_lead',
      extra: { editorial_type: 'radar', manual_lead: { lead_id: 'lead-1' } },
    })).toBe(true);
  });

  test('builds one canonical registry JSON bind containing the full production registry', () => {
    const build = (policy as unknown as { buildFormalNewsRegistryJson?: () => string })
      .buildFormalNewsRegistryJson;
    const cte = (policy as unknown as { FORMAL_NEWS_REGISTRY_CTE?: string }).FORMAL_NEWS_REGISTRY_CTE;

    expect(build).toBeTypeOf('function');
    const rows = JSON.parse(build!()) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(FEED_REGISTRY.length);
    expect(Object.keys(rows[0] || {})).toEqual(['editorial_type', 'enabled', 'id', 'key', 'kind']);
    expect(rows.map((row) => row.id)).toEqual([...rows.map((row) => row.id)].sort());
    expect(cte?.match(/\?/g)).toHaveLength(1);
    expect(cte).toContain('json_each(?)');
  });

  test('allows only exact current and evidence-backed historical producer shapes', async () => {
    const db = new SqliteD1(); opened.push(db);
    insertSource(db, 'blog:openai');
    insertSource(db, 'podcast:latent-space');
    insertItem(db, {
      id: 'blog:openai:article-1', sourceType: 'blog', sourceId: 'openai:article-1',
      extra: { feed_id: 'blog:openai', feed_key: 'openai', editorial_type: 'official' },
    });
    insertItem(db, {
      id: 'podcast:latent-space:episode-1', sourceType: 'podcast', sourceId: 'latent-space:episode-1',
      extra: { feed_id: 'podcast:latent-space', show_key: 'latent-space' },
    });
    insertItem(db, {
      id: 'podcast:latent-space:post-1', sourceType: 'blog', sourceId: 'latent-space:post-1',
      extra: { feed_id: 'podcast:latent-space', feed_key: 'latent-space' },
    });

    const ids = ['blog:openai:article-1', 'podcast:latent-space:episode-1', 'podcast:latent-space:post-1'];
    const result = await authorize(db, ids);
    expect(result.allowed_ids).toEqual(ids);
    expect(result.decisions.map((entry) => entry.code)).toEqual([
      'ALLOW_SCHEDULED_FORMAL', 'ALLOW_SCHEDULED_FORMAL', 'ALLOW_SCHEDULED_FORMAL',
    ]);
    const finalStatements = db.preparedSql.filter((sql) =>
      sql.includes('formal_news:final_guard_single_snapshot'));
    expect(finalStatements).toHaveLength(1);
    expect(finalStatements[0].match(/\?/g)).toHaveLength(3);
    expect(db.preparedSql.some((sql) => sql.includes('formal_news:final_guard_scheduled_join'))).toBe(false);
  });

  test('fails closed for missing item, malformed identity, missing source, and source mismatch', async () => {
    const db = new SqliteD1(); opened.push(db);
    insertItem(db, {
      id: 'blog:openai:malformed', sourceType: 'blog', sourceId: 'openai:malformed', extra: '{',
    });
    insertItem(db, {
      id: 'blog:openai:no-source', sourceType: 'blog', sourceId: 'openai:no-source',
      extra: { feed_id: 'blog:openai', feed_key: 'openai', editorial_type: 'official' },
    });
    insertSource(db, 'blog:google', { key: 'spoofed' });
    insertItem(db, {
      id: 'blog:google:mismatch', sourceType: 'blog', sourceId: 'google:mismatch',
      extra: { feed_id: 'blog:google', feed_key: 'google', editorial_type: 'official' },
    });

    const result = await authorize(db, [
      'missing', 'blog:openai:malformed', 'blog:openai:no-source', 'blog:google:mismatch',
    ]);
    expect(result.allowed_ids).toEqual([]);
    expect(result.decisions.map((entry) => entry.code)).toEqual([
      'DENY_MISSING_ITEM',
      'DENY_MALFORMED_ITEM_IDENTITY',
      'DENY_NO_SOURCE_ROW',
      'DENY_SOURCE_MISMATCH',
    ]);
  });

  test('classifies typed-null and invalid editorial identity fields as malformed before provenance lookup', async () => {
    const db = new SqliteD1(); opened.push(db);
    insertSource(db, 'blog:openai');
    insertItem(db, {
      id: 'blog:openai:null-feed', sourceType: 'blog', sourceId: 'openai:null-feed',
      extra: { feed_id: null, feed_key: 'openai', editorial_type: 'official' },
    });
    insertItem(db, {
      id: 'blog:openai:null-key', sourceType: 'blog', sourceId: 'openai:null-key',
      extra: { feed_id: 'blog:openai', feed_key: null, editorial_type: 'official' },
    });
    insertItem(db, {
      id: 'blog:openai:bad-editorial', sourceType: 'blog', sourceId: 'openai:bad-editorial',
      extra: { feed_id: 'blog:openai', feed_key: 'openai', editorial_type: 'sponsored' },
    });

    const result = await authorize(db, [
      'blog:openai:null-feed', 'blog:openai:null-key', 'blog:openai:bad-editorial',
    ]);
    expect(result.allowed_ids).toEqual([]);
    expect(result.decisions.map((entry) => entry.code)).toEqual([
      'DENY_MALFORMED_ITEM_IDENTITY',
      'DENY_MALFORMED_ITEM_IDENTITY',
      'DENY_MALFORMED_ITEM_IDENTITY',
    ]);
  });

  test('denies source radar or disabled regardless of item official claim', async () => {
    const db = new SqliteD1(); opened.push(db);
    insertSource(db, 'blog:weibo-hot-tech');
    insertItem(db, {
      id: 'blog:weibo-hot-tech:topic', sourceType: 'blog', sourceId: 'weibo-hot-tech:topic',
      extra: { feed_id: 'blog:weibo-hot-tech', feed_key: 'weibo-hot-tech', editorial_type: 'official' },
    });
    insertSource(db, 'blog:openai', { enabled: false });
    insertItem(db, {
      id: 'blog:openai:disabled', sourceType: 'blog', sourceId: 'openai:disabled',
      extra: { feed_id: 'blog:openai', feed_key: 'openai', editorial_type: 'official' },
    });

    const result = await authorize(db, ['blog:weibo-hot-tech:topic', 'blog:openai:disabled']);
    expect(result.allowed_ids).toEqual([]);
    expect(result.decisions.map((entry) => entry.code)).toEqual([
      'DENY_SOURCE_RADAR', 'DENY_SOURCE_DISABLED',
    ]);
  });

  test.each([
    ['item explicit radar', (db: SqliteD1) => db.sqlite.prepare(
      `UPDATE items SET extra=json_set(extra, '$.editorial_type', 'radar') WHERE id='blog:openai:race'`,
    ).run()],
    ['item feed identity', (db: SqliteD1) => db.sqlite.prepare(
      `UPDATE items SET extra=json_set(extra, '$.feed_id', 'blog:google') WHERE id='blog:openai:race'`,
    ).run()],
    ['source disabled', (db: SqliteD1) => db.sqlite.prepare(
      `UPDATE sources SET config=json_set(config, '$.enabled', json('false')) WHERE id='blog:openai'`,
    ).run()],
    ['source mirror mismatch', (db: SqliteD1) => db.sqlite.prepare(
      `UPDATE sources SET source_ref='openai-spoofed' WHERE id='blog:openai'`,
    ).run()],
    ['backing deleted', (db: SqliteD1) => db.sqlite.prepare(
      `DELETE FROM items WHERE id='blog:openai:race'`,
    ).run()],
  ])('final guard rejects %s mutation after early authorization', async (_label, mutate) => {
    const db = new SqliteD1(); opened.push(db);
    insertSource(db, 'blog:openai');
    insertItem(db, {
      id: 'blog:openai:race', sourceType: 'blog', sourceId: 'openai:race',
      extra: { feed_id: 'blog:openai', feed_key: 'openai', editorial_type: 'official' },
    });
    let mutated = false;
    db.beforeAll = (sql) => {
      if (mutated || !sql.includes('formal_news:final_guard')) return;
      mutated = true;
      mutate(db);
    };

    const result = await authorize(db, ['blog:openai:race']);
    expect(mutated).toBe(true);
    expect(result.allowed_ids).toEqual([]);
    expect(result.decisions[0]?.code).not.toBe('ALLOW_SCHEDULED_FORMAL');
  });

  test('executes the full scheduled predicate with one registry bind in real SQLite', () => {
    const db = new SqliteD1(); opened.push(db);
    insertSource(db, 'blog:openai');
    insertSource(db, 'blog:weibo-hot-tech');
    insertItem(db, {
      id: 'blog:openai:sql-formal', sourceType: 'blog', sourceId: 'openai:sql-formal',
      extra: { feed_id: 'blog:openai', feed_key: 'openai', editorial_type: 'official' },
    });
    insertItem(db, {
      id: 'blog:weibo-hot-tech:sql-radar', sourceType: 'blog', sourceId: 'weibo-hot-tech:sql-radar',
      extra: { feed_id: 'blog:weibo-hot-tech', feed_key: 'weibo-hot-tech', editorial_type: 'radar' },
    });
    insertItem(db, {
      id: 'blog:openai:sql-malformed', sourceType: 'blog', sourceId: 'openai:sql-malformed', extra: '{',
    });
    const predicate = (policy as unknown as {
      formalNewsScheduledSqlPredicate?: (itemAlias: string, registryAlias: string, sourceAlias: string) => string;
    }).formalNewsScheduledSqlPredicate;
    expect(predicate).toBeTypeOf('function');
    const sql = `WITH ${policy.FORMAL_NEWS_REGISTRY_CTE}
      SELECT i.id FROM items i
      JOIN registry r ON r.id=json_extract(
        CASE WHEN i.extra IS NOT NULL AND json_valid(i.extra)=1 THEN i.extra ELSE '{}' END,
        '$.feed_id')
      JOIN sources s ON s.id=r.id
      WHERE ${predicate!('i', 'r', 's')}
      ORDER BY i.id`;
    expect(sql.match(/\?/g)).toHaveLength(1);
    const rows = db.sqlite.prepare(sql).all(policy.buildFormalNewsRegistryJson()) as Array<{ id: string }>;
    expect(rows.map((row) => row.id)).toEqual(['blog:openai:sql-formal']);
  });
});
