import { describe, expect, test } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import {
  ARCHIVE_PAGE_SIZE,
  MAX_ARCHIVE_PAGE,
  archiveCanonicalPath,
  archiveCountQuery,
  archiveItemsQuery,
  archiveMonthsQuery,
  archiveSitemapGroupsQuery,
  parseItemArchivePath,
} from './item-archive';
import {
  ITEM_CN_NOT_SENSITIVE_SQL,
  ITEM_NOT_DEDUPED_SQL,
} from './item-page-policy';

describe('parseItemArchivePath', () => {
  test('只接受 index、已知 source、真实月份与有上限的正整数 page', () => {
    expect(parseItemArchivePath('/archive/')).toEqual({ kind: 'index' });
    expect(parseItemArchivePath('/archive/x/')).toEqual({ kind: 'source', source: 'x' });
    expect(parseItemArchivePath('/archive/gh/2026-07/')).toEqual({
      kind: 'month',
      source: 'gh',
      month: '2026-07',
      page: 1,
    });
    expect(parseItemArchivePath('/archive/paper/2024-02/9')).toEqual({
      kind: 'month',
      source: 'paper',
      month: '2024-02',
      page: 9,
    });
    expect(parseItemArchivePath(`/archive/news/2026-01/${MAX_ARCHIVE_PAGE}`)).toEqual({
      kind: 'month',
      source: 'news',
      month: '2026-01',
      page: MAX_ARCHIVE_PAGE,
    });

    for (const path of [
      '/archive/unknown/',
      '/archive/hf-paper/',
      '/archive/x/2026-00/',
      '/archive/x/2026-13/',
      '/archive/x/0000-01/',
      '/archive/x/2026-1/',
      '/archive/x/2026-01/0',
      '/archive/x/2026-01/-1',
      '/archive/x/2026-01/1.5',
      `/archive/x/2026-01/${MAX_ARCHIVE_PAGE + 1}`,
      '/archive/x/2026-01/2/extra',
    ]) {
      expect(parseItemArchivePath(path), path).toBeNull();
    }
  });

  test('无尾斜杠也解析为同一逻辑页面，交给 canonical 收敛', () => {
    expect(parseItemArchivePath('/archive')).toEqual({ kind: 'index' });
    expect(parseItemArchivePath('/archive/ph')).toEqual({ kind: 'source', source: 'ph' });
    expect(parseItemArchivePath('/archive/news/2026-07')).toEqual({
      kind: 'month',
      source: 'news',
      month: '2026-07',
      page: 1,
    });
  });
});

describe('archiveCanonicalPath', () => {
  test('page 1 不产生重复 /1，page 2+ 保留页码', () => {
    expect(archiveCanonicalPath({ kind: 'index' })).toBe('/archive/');
    expect(archiveCanonicalPath({ kind: 'source', source: 'x' })).toBe('/archive/x/');
    expect(
      archiveCanonicalPath({ kind: 'month', source: 'ph', month: '2026-07', page: 1 }),
    ).toBe('/archive/ph/2026-07/');
    expect(
      archiveCanonicalPath({ kind: 'month', source: 'ph', month: '2026-07', page: 2 }),
    ).toBe('/archive/ph/2026-07/2');
  });
});

describe('archiveItemsQuery', () => {
  test('每页固定 100，offset 由 page 单调推进，paper 映射 item_pages 的 hf-paper', () => {
    expect(ARCHIVE_PAGE_SIZE).toBe(100);
    const first = archiveItemsQuery('paper', '2026-07', 1);
    const third = archiveItemsQuery('paper', '2026-07', 3);

    expect(first.bindings).toEqual(['hf-paper', '2026-07', 100, 0]);
    expect(third.bindings).toEqual(['hf-paper', '2026-07', 100, 200]);
  });

  test('复用 live/relevant/deleted/dedup/cn-sensitive gate，并稳定按有效时间 + id 排序', () => {
    const { sql } = archiveItemsQuery('x', '2026-07', 2);

    expect(sql).toMatch(/JOIN\s+item_pages\s+p\s+ON\s+p\.item_id\s*=\s*i\.id/i);
    expect(sql).toMatch(/p\.status\s*=\s*'live'/i);
    expect(sql).toMatch(/i\.is_relevant\s*=\s*1/i);
    expect(sql).toMatch(/i\.deleted_at\s+IS\s+NULL/i);
    expect(sql).toContain(ITEM_NOT_DEDUPED_SQL);
    expect(sql).toContain(ITEM_CN_NOT_SENSITIVE_SQL);
    expect(sql).toContain("COALESCE(NULLIF(i.published_at, ''), i.scraped_at) AS published_at");
    expect(sql).toMatch(/WHERE\s+p\.source\s*=\s*\?\s+AND/i);
    expect(sql).toMatch(
      /ORDER BY\s+COALESCE\(NULLIF\(i\.published_at,\s*''\),\s*i\.scraped_at\)\s+DESC,\s*i\.id\s+DESC/i,
    );
    expect(archiveItemsQuery('ph', '2026-07', 1).sql).toMatch(
      /ORDER BY\s+published_at\s+DESC,\s*id\s+DESC/i,
    );
  });

  test('列表链接只从 item_pages.url_path 取，不在查询层重拼 URL', () => {
    const { sql } = archiveItemsQuery('news', '2026-07', 1);

    expect(sql).toMatch(/SELECT[\s\S]*p\.url_path/i);
    expect(sql).not.toMatch(/['"]\/i\//);
  });
});

describe('archive effective time', () => {
  test('无 published_at 的历史项统一回退 scraped_at，月份列表、计数与 sitemap 不会漏项', () => {
    const effectiveTime = "COALESCE(NULLIF(i.published_at, ''), i.scraped_at)";
    const queries = [
      archiveItemsQuery('gh', '2026-05', 1).sql,
      archiveMonthsQuery('gh').sql,
      archiveCountQuery('gh', '2026-05').sql,
      archiveSitemapGroupsQuery().sql,
    ];

    for (const sql of queries) {
      expect(sql).toContain(effectiveTime);
    }
    expect(archiveMonthsQuery('gh').sql).toContain(
      `${effectiveTime} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-*'`,
    );
    expect(archiveMonthsQuery('ph').sql).toContain(
      "published_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-*'",
    );
    expect(archiveSitemapGroupsQuery().sql).toContain('substr(published_at, 1, 7) AS month');
  });
});

describe('archive canonical rows', () => {
  test('同一 canonical 的历史 PH 行只归入最新代表记录所在月份，列表、计数和 sitemap 口径一致', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        title TEXT,
        author TEXT,
        published_at TEXT,
        scraped_at TEXT NOT NULL,
        is_relevant INTEGER NOT NULL,
        deleted_at TEXT,
        extra TEXT NOT NULL
      );
      CREATE TABLE item_pages (
        item_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        url_path TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `);

    const insertItem = db.prepare(`
      INSERT INTO items (
        id, source_type, title, author, published_at, scraped_at, is_relevant, deleted_at, extra
      ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, '{}')
    `);
    const insertPage = db.prepare(`
      INSERT INTO item_pages (item_id, source, url_path, generated_at, status)
      VALUES (?, ?, ?, ?, 'live')
    `);
    const seed = (
      id: string,
      source: string,
      urlPath: string,
      publishedAt: string,
      generatedAt = publishedAt,
    ) => {
      const sourceType = source === 'ph' ? 'product_hunt' : 'x_list';
      insertItem.run(id, sourceType, id, 'tester', publishedAt, publishedAt);
      insertPage.run(id, source, urlPath, generatedAt);
    };

    seed(
      'product_hunt:repeat:2026-05-11',
      'ph',
      '/i/ph/repeat',
      '2026-05-11T07:00:00Z',
    );
    seed(
      'product_hunt:repeat:2026-06-12',
      'ph',
      '/i/ph/repeat',
      '2026-06-12T07:00:00Z',
    );
    seed('product_hunt:unique:2026-07-01', 'ph', '/i/ph/unique', '2026-07-01T07:00:00Z');
    seed('x_list:1', 'x', '/i/x/1', '2026-07-02T07:00:00Z');

    const all = <T>(query: { sql: string; bindings: unknown[] }): T[] =>
      db
        .prepare(query.sql)
        .all(...(query.bindings as SQLInputValue[])) as T[];
    const first = <T>(query: { sql: string; bindings: unknown[] }): T | undefined =>
      db
        .prepare(query.sql)
        .get(...(query.bindings as SQLInputValue[])) as T | undefined;

    expect(all(archiveItemsQuery('ph', '2026-05', 1))).toEqual([]);
    expect(
      all<{ id: string }>(archiveItemsQuery('ph', '2026-06', 1)).map((row) => row.id),
    ).toEqual(['product_hunt:repeat:2026-06-12']);

    expect(all<{ month: string; item_count: number }>(archiveMonthsQuery('ph'))).toEqual([
      { month: '2026-07', item_count: 1 },
      { month: '2026-06', item_count: 1 },
    ]);
    expect(first<{ item_count: number }>(archiveCountQuery('ph', '2026-05'))?.item_count).toBe(0);
    expect(first<{ item_count: number }>(archiveCountQuery('ph', '2026-06'))?.item_count).toBe(1);

    const sitemapGroups = all<{
      source: string;
      month: string;
      item_count: number;
    }>(archiveSitemapGroupsQuery());
    expect(sitemapGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'ph', month: '2026-06', item_count: 1 }),
        expect.objectContaining({ source: 'ph', month: '2026-07', item_count: 1 }),
        expect.objectContaining({ source: 'x', month: '2026-07', item_count: 1 }),
      ]),
    );
    expect(sitemapGroups).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'ph', month: '2026-05' })]),
    );

    db.close();
  });
});
