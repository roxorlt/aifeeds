import { describe, expect, test, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    ctx: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { handleItems, type Env } from './index';

const sqlite = await import('node:sqlite').catch(() => null);
const sqliteTest = sqlite ? test : test.skip;

function projectionEnv(
  captured: string[],
  resultsForCall: Array<Array<Record<string, unknown>>> = [],
  capturedBinds: unknown[][] = [],
): Env {
  let call = 0;
  return {
    DB: {
      prepare(sql: string) {
        captured.push(sql);
        const result = resultsForCall[call++] ?? [];
        const statement = {
          bind: (...values: unknown[]) => {
            capturedBinds.push(values);
            return statement;
          },
          all: async () => ({
            results: result,
            meta: { timings: { sql_duration_ms: 1 } },
          }),
        };
        return statement;
      },
    },
  } as unknown as Env;
}

function expectNoWildcardProjection(sql: string): void {
  expect(sql).not.toMatch(/\bSELECT\s+(?:\w+\.)?\*/i);
  expect(sql).not.toMatch(/\bitems\.\*/i);
  expect(sql).toMatch(/\bAS\s+id\b/i);
  expect(sql).toMatch(/\bAS\s+extra\b/i);
}

describe('feed handlers use list-only projections', () => {
  test.each([
    'x_list',
    'blog,podcast',
    'hf_paper',
    'github',
    'product_hunt',
    'clawhub',
    'huodongxing',
  ])('%s primary query never selects the full item row', async (sourceType) => {
    const captured: string[] = [];
    const response = await handleItems(
      new Request(`https://api.ai-feeds.com/api/items?source_type=${sourceType}&limit=12`),
      projectionEnv(captured),
    );

    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expectNoWildcardProjection(captured[0]);
  });

  test.each(['constructor', '__proto__', 'future_source'])(
    'unknown source %s fails closed to an empty extra projection instead of throwing',
    async (sourceType) => {
      const captured: string[] = [];
      const response = await handleItems(
        new Request(`https://api.ai-feeds.com/api/items?source_type=${sourceType}&limit=12`),
        projectionEnv(captured),
      );

      expect(response.status).toBe(200);
      expect(captured).toHaveLength(1);
      expectNoWildcardProjection(captured[0]);
      expect(captured[0]).toContain('json_object() AS extra');
    },
  );

  test('a mixed source query never interpolates an unknown quoted value into SQL', async () => {
    const captured: string[] = [];
    const malicious = "future' THEN 1; DROP TABLE items; --";
    const url = new URL('https://api.ai-feeds.com/api/items');
    url.searchParams.set('source_type', `x_list,${malicious}`);
    url.searchParams.set('limit', '12');
    const response = await handleItems(new Request(url), projectionEnv(captured));

    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toContain(malicious);
    expect(captured[0]).toContain("'profile_image_url'");
  });

  test('thread-completion query also uses the X list projection', async () => {
    const captured: string[] = [];
    const root = {
      id: 'x_list:root',
      source_type: 'x_list',
      source_id: 'root',
      source_ref: 'fixture',
      title: null,
      content: 'root',
      content_translated: null,
      author: 'author',
      handle: 'author',
      url: 'https://x.com/author/status/root',
      media: '[]',
      metrics: '{}',
      published_at: '2026-07-11T00:00:00.000Z',
      scraped_at: '2026-07-11T00:00:00.000Z',
      is_relevant: 1,
      matched_by: 'fixture',
      lang: 'en',
      extra: JSON.stringify({ thread_root_id: 'root' }),
    };
    const response = await handleItems(
      new Request('https://api.ai-feeds.com/api/items?source_type=x_list&limit=12'),
      projectionEnv(captured, [[root], []]),
    );

    expect(response.status).toBe(200);
    expect(captured).toHaveLength(2);
    expectNoWildcardProjection(captured[0]);
    expectNoWildcardProjection(captured[1]);
  });

  test.each([
    {
      sourceType: 'github',
      cursor: '2026-07-10|3|github:octo/repo',
      pinned: 'github:pinned/repo',
      expectedPrefix: ['2026-07-10', '2026-07-10', 3, 3, 'github:octo/repo', 'github:pinned/repo'],
    },
    {
      sourceType: 'product_hunt',
      cursor: '2026-07-10|3|product_hunt:fixture',
      pinned: 'product_hunt:pinned',
      expectedPrefix: ['2026-07-10', '2026-07-10', 3, 3, 'product_hunt:fixture', 'product_hunt:pinned'],
    },
  ])('$sourceType binds cursor placeholders before the later pinned ORDER BY placeholder', async ({
    sourceType,
    cursor,
    pinned,
    expectedPrefix,
  }) => {
    const captured: string[] = [];
    const binds: unknown[][] = [];
    const url = new URL('https://api.ai-feeds.com/api/items');
    url.searchParams.set('source_type', sourceType);
    url.searchParams.set('cursor', cursor);
    url.searchParams.set('pinned', pinned);
    url.searchParams.set('limit', '12');

    const response = await handleItems(
      new Request(url),
      projectionEnv(captured, [], binds),
    );

    expect(response.status).toBe(200);
    expect(binds).toHaveLength(1);
    expect(binds[0].slice(0, expectedPrefix.length)).toEqual(expectedPrefix);
  });

  test('Huodongxing cursor serializes the exact COALESCE start key used by ORDER BY', async () => {
    const captured: string[] = [];
    const row = {
      id: 'huodongxing:no-time',
      source_type: 'huodongxing',
      source_id: 'no-time',
      source_ref: 'fixture',
      title: 'No time yet',
      content: '',
      content_translated: null,
      author: null,
      handle: null,
      url: 'https://example.com/event',
      media: '[]',
      metrics: '{}',
      published_at: '2026-07-11T00:00:00.000Z',
      scraped_at: '2026-07-11T00:00:00.000Z',
      is_relevant: 1,
      is_hot: 0,
      matched_by: 'fixture',
      lang: 'zh',
      extra: JSON.stringify({ detail_enriched_at: null }),
      _state: 1,
      _start_time: '9999',
    };
    const response = await handleItems(
      new Request('https://api.ai-feeds.com/api/items?source_type=huodongxing&limit=1'),
      projectionEnv(captured, [[row, { ...row, id: 'huodongxing:more' }]]),
    );
    const payload = await response.json() as { next_cursor: string | null };

    expect(captured[0]).toMatch(/AS _start_time/);
    expect(payload.next_cursor).toBe('1|9999|huodongxing:no-time');
  });

  test('ordinary list v2 cursor includes the untranslated ordering key and round-trips it', async () => {
    const firstSql: string[] = [];
    const row = {
      id: 'x_list:first',
      source_type: 'x_list',
      source_id: 'first',
      source_ref: 'fixture',
      title: null,
      content: 'English',
      content_translated: null,
      author: 'author',
      handle: 'author',
      url: 'https://x.com/author/status/first',
      media: '[]',
      metrics: '{}',
      published_at: '2026-07-11T01:00:00.000Z',
      scraped_at: '2026-07-11T02:00:00.000Z',
      is_relevant: 1,
      is_hot: 0,
      matched_by: 'fixture',
      lang: 'en',
      extra: '{}',
      _untranslated_rank: 1,
    };
    const firstResponse = await handleItems(
      new Request('https://api.ai-feeds.com/api/items?source_type=x_list&limit=1'),
      projectionEnv(firstSql, [[row, { ...row, id: 'x_list:more' }]]),
    );
    const firstPayload = await firstResponse.json() as { next_cursor: string };

    expect(firstSql[0]).toMatch(/AS _untranslated_rank/);
    expect(firstPayload.next_cursor).toBe(
      'v2|1|2026-07-11T02:00:00.000Z|x_list:first',
    );

    const secondSql: string[] = [];
    const secondBinds: unknown[][] = [];
    const secondUrl = new URL('https://api.ai-feeds.com/api/items');
    secondUrl.searchParams.set('source_type', 'x_list');
    secondUrl.searchParams.set('limit', '1');
    secondUrl.searchParams.set('cursor', firstPayload.next_cursor);
    const secondResponse = await handleItems(
      new Request(secondUrl),
      projectionEnv(secondSql, [], secondBinds),
    );

    expect(secondResponse.status).toBe(200);
    expect(secondBinds[0].slice(-6, -1)).toEqual([
      1,
      1,
      '2026-07-11T02:00:00.000Z',
      '2026-07-11T02:00:00.000Z',
      'x_list:first',
    ]);
  });

  test('news v2 cursor carries score, untranslated rank, time, id, and frozen rank time', async () => {
    const captured: string[] = [];
    const row = {
      id: 'blog:fixture',
      source_type: 'blog',
      source_id: 'fixture',
      source_ref: 'fixture',
      title: 'Article',
      content: 'Article',
      content_translated: null,
      author: 'Publisher',
      handle: null,
      url: 'https://example.com/article',
      media: '[]',
      metrics: '{}',
      published_at: '2026-07-11T01:00:00.000Z',
      scraped_at: '2026-07-11T02:00:00.000Z',
      is_relevant: 1,
      is_hot: 0,
      matched_by: 'fixture',
      lang: 'en',
      extra: '{}',
      _feed_rank_score: 42.5,
      _untranslated_rank: 1,
    };
    const response = await handleItems(
      new Request('https://api.ai-feeds.com/api/items?source_type=blog,podcast&limit=1'),
      projectionEnv(captured, [[row, { ...row, id: 'podcast:more' }]]),
    );
    const payload = await response.json() as { next_cursor: string };
    const parts = payload.next_cursor.split('|');

    expect(parts).toHaveLength(6);
    expect(parts.slice(0, 5)).toEqual([
      'v2',
      '42.5',
      '1',
      '2026-07-11T01:00:00.000Z',
      'blog:fixture',
    ]);
    expect(Number.isFinite(Date.parse(parts[5]))).toBe(true);

    const binds: unknown[][] = [];
    const next = new URL('https://api.ai-feeds.com/api/items');
    next.searchParams.set('source_type', 'blog,podcast');
    next.searchParams.set('limit', '1');
    next.searchParams.set('cursor', payload.next_cursor);
    const nextResponse = await handleItems(
      new Request(next),
      projectionEnv([], [], binds),
    );

    expect(nextResponse.status).toBe(200);
    expect(binds[0].slice(-8, -1)).toEqual([
      42.5,
      42.5,
      1,
      1,
      '2026-07-11T01:00:00.000Z',
      '2026-07-11T01:00:00.000Z',
      'blog:fixture',
    ]);
  });

  test.each([
    '2026-07-11T01:00:00Z',
    '2026-07-11T09:00:00+08:00',
  ])('news v2 cursor round-trips a stored RFC3339 item time: %s', async (publishedAt) => {
    const row = {
      id: 'blog:rfc3339-fixture',
      source_type: 'blog',
      source_id: 'rfc3339-fixture',
      source_ref: 'fixture',
      title: 'RFC3339 article',
      content: 'Article',
      content_translated: null,
      author: 'Publisher',
      handle: null,
      url: 'https://example.com/rfc3339-article',
      media: '[]',
      metrics: '{}',
      published_at: publishedAt,
      scraped_at: '2026-07-11T02:00:00.000Z',
      is_relevant: 1,
      is_hot: 0,
      matched_by: 'fixture',
      lang: 'en',
      extra: '{}',
      _feed_rank_score: 42.5,
      _untranslated_rank: 1,
    };
    const firstResponse = await handleItems(
      new Request('https://api.ai-feeds.com/api/items?source_type=blog,podcast&limit=1'),
      projectionEnv([], [[row, { ...row, id: 'podcast:more' }]]),
    );
    const firstPayload = await firstResponse.json() as { next_cursor: string };

    expect(firstPayload.next_cursor.split('|')[3]).toBe(publishedAt);

    const binds: unknown[][] = [];
    const next = new URL('https://api.ai-feeds.com/api/items');
    next.searchParams.set('source_type', 'blog,podcast');
    next.searchParams.set('cursor', firstPayload.next_cursor);
    const nextResponse = await handleItems(
      new Request(next),
      projectionEnv([], [], binds),
    );

    expect(nextResponse.status).toBe(200);
    expect(binds[0].slice(-4, -2)).toEqual([publishedAt, publishedAt]);
  });

  test('pre-v2 four-part feed cursor preserves its frozen rank clock and keyset', async () => {
    // dab085f^ emitted score|published_at|id|rank_time. This format can still
    // be present in a browser/session while the deployment rolls forward.
    const itemTime = '2026-07-11T01:00:00.000Z';
    const rankTime = '2026-07-12T02:03:04.005Z';
    const captured: string[] = [];
    const binds: unknown[][] = [];
    const url = new URL('https://api.ai-feeds.com/api/items');
    url.searchParams.set('source_type', 'blog,podcast');
    url.searchParams.set('cursor', `42.5|${itemTime}|blog:legacy-four|${rankTime}`);

    const response = await handleItems(
      new Request(url),
      projectionEnv(captured, [], binds),
    );

    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain(`julianday('${rankTime}')`);
    expect(binds[0].slice(-6, -1)).toEqual([
      42.5,
      42.5,
      itemTime,
      itemTime,
      'blog:legacy-four',
    ]);
  });

  test('hot v2 cursor freezes the score clock across pages', async () => {
    const captured: string[] = [];
    const row = {
      id: 'x_list:hot-boundary',
      source_type: 'x_list',
      source_id: 'hot-boundary',
      source_ref: 'fixture',
      title: null,
      content: 'Hot item',
      content_translated: null,
      author: 'author',
      handle: 'author',
      url: 'https://x.com/author/status/hot-boundary',
      media: '[]',
      metrics: '{"likes":100}',
      published_at: '2026-07-11T01:00:00.000Z',
      scraped_at: '2026-07-11T02:00:00.000Z',
      is_relevant: 1,
      is_hot: 1,
      matched_by: 'fixture',
      lang: 'en',
      extra: '{}',
      _hot_score: 9.25,
    };
    const firstResponse = await handleItems(
      new Request('https://api.ai-feeds.com/api/items?source_type=x_list&sort=hot&limit=1'),
      projectionEnv(captured, [[row, { ...row, id: 'x_list:more' }]]),
    );
    const firstPayload = await firstResponse.json() as { next_cursor: string };
    const parts = firstPayload.next_cursor.split('|');

    expect(parts.slice(0, 3)).toEqual(['v2h', '9.25', 'x_list:hot-boundary']);
    expect(Number.isFinite(Date.parse(parts[3]))).toBe(true);
    expect(captured[0]).toContain(`julianday('${parts[3]}')`);

    const nextSql: string[] = [];
    const nextBinds: unknown[][] = [];
    const nextUrl = new URL('https://api.ai-feeds.com/api/items');
    nextUrl.searchParams.set('source_type', 'x_list');
    nextUrl.searchParams.set('sort', 'hot');
    nextUrl.searchParams.set('limit', '1');
    nextUrl.searchParams.set('cursor', firstPayload.next_cursor);
    const nextResponse = await handleItems(
      new Request(nextUrl),
      projectionEnv(nextSql, [], nextBinds),
    );

    expect(nextResponse.status).toBe(200);
    expect(nextSql[0]).toContain(`julianday('${parts[3]}')`);
    expect(nextBinds[0].slice(-4, -1)).toEqual([9.25, 9.25, 'x_list:hot-boundary']);
  });

  sqliteTest('future timestamps keep a finite hot score and paginate without repeats', async () => {
    const { DatabaseSync } = sqlite!;
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY,
        source_type TEXT,
        source_id TEXT,
        source_ref TEXT,
        title TEXT,
        content TEXT,
        content_translated TEXT,
        author TEXT,
        handle TEXT,
        url TEXT,
        media TEXT,
        metrics TEXT,
        published_at TEXT,
        scraped_at TEXT,
        is_relevant INTEGER,
        is_hot INTEGER,
        matched_by TEXT,
        lang TEXT,
        extra TEXT,
        deleted_at TEXT
      );
      INSERT INTO items (
        id, source_type, source_id, source_ref, content, author, handle, url,
        media, metrics, published_at, scraped_at, is_relevant, is_hot,
        matched_by, lang, extra, deleted_at
      ) VALUES
        ('x_list:future-a', 'x_list', 'future-a', 'fixture', 'Future A', 'author', 'author',
         'https://x.com/author/status/future-a', '[]', '{"likes": 100}',
         '2099-01-01T03:00:00.000Z', '2099-01-01T03:00:00.000Z', 1, 1, 'fixture', 'en', '{}', NULL),
        ('x_list:future-b', 'x_list', 'future-b', 'fixture', 'Future B', 'author', 'author',
         'https://x.com/author/status/future-b', '[]', '{"likes": 100}',
         '2099-01-01T04:00:00.000Z', '2099-01-01T04:00:00.000Z', 1, 1, 'fixture', 'en', '{}', NULL);
    `);

    const env = {
      DB: {
        prepare(sqlText: string) {
          const statement = db.prepare(sqlText);
          return {
            bind(...values: unknown[]) {
              return {
                async all() {
                  return {
                    results: statement.all(
                      ...(values as Array<string | number | bigint | null>),
                    ) as Array<Record<string, unknown>>,
                    meta: { timings: { sql_duration_ms: 1 } },
                  };
                },
              };
            },
          };
        },
      },
    } as unknown as Env;

    try {
      const first = await handleItems(
        new Request('https://api.ai-feeds.com/api/items?source_type=x_list&sort=hot&limit=1'),
        env,
      );
      const firstPayload = await first.json() as {
        items: Array<{ id: string }>;
        next_cursor: string;
      };
      const score = Number.parseFloat(firstPayload.next_cursor.split('|')[1]);
      expect(Number.isFinite(score)).toBe(true);

      const nextUrl = new URL('https://api.ai-feeds.com/api/items');
      nextUrl.searchParams.set('source_type', 'x_list');
      nextUrl.searchParams.set('sort', 'hot');
      nextUrl.searchParams.set('limit', '1');
      nextUrl.searchParams.set('cursor', firstPayload.next_cursor);
      const second = await handleItems(new Request(nextUrl), env);
      const secondPayload = await second.json() as { items: Array<{ id: string }> };

      expect(secondPayload.items).toHaveLength(1);
      expect(secondPayload.items[0].id).not.toBe(firstPayload.items[0].id);
    } finally {
      db.close();
    }
  });

  test.each([
    'v2h|null|x_list:item|2026-07-11T00:00:00.000Z',
    'v2h||x_list:item|2026-07-11T00:00:00.000Z',
    'v2h|9.25||2026-07-11T00:00:00.000Z',
    'v2h|9.25|x_list:item|not-a-date',
  ])('invalid hot v2 cursor fails closed before querying D1: %s', async (cursor) => {
    const captured: string[] = [];
    const url = new URL('https://api.ai-feeds.com/api/items');
    url.searchParams.set('source_type', 'x_list');
    url.searchParams.set('sort', 'hot');
    url.searchParams.set('cursor', cursor);

    const response = await handleItems(new Request(url), projectionEnv(captured));
    const payload = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(payload.error).toBe('invalid_cursor');
    expect(captured).toHaveLength(0);
  });

  test.each([
    // Ordinary translated-priority ordering: v2 and in-flight legacy cursors.
    { label: 'ordinary empty cursor parameter', sourceType: 'x_list', sort: '', cursor: '' },
    { label: 'ordinary v2 missing rank', sourceType: 'x_list', sort: '', cursor: 'v2||2026-07-11T00:00:00.000Z|x_list:item' },
    { label: 'ordinary v2 partial rank', sourceType: 'x_list', sort: '', cursor: 'v2|1oops|2026-07-11T00:00:00.000Z|x_list:item' },
    { label: 'ordinary v2 out-of-domain rank', sourceType: 'x_list', sort: '', cursor: 'v2|2|2026-07-11T00:00:00.000Z|x_list:item' },
    { label: 'ordinary v2 invalid time', sourceType: 'x_list', sort: '', cursor: 'v2|1|not-a-date|x_list:item' },
    { label: 'ordinary v2 missing id', sourceType: 'x_list', sort: '', cursor: 'v2|1|2026-07-11T00:00:00.000Z|' },
    { label: 'ordinary v2 extra segment', sourceType: 'x_list', sort: '', cursor: 'v2|1|2026-07-11T00:00:00.000Z|x_list:item|extra' },
    { label: 'ordinary legacy invalid time', sourceType: 'x_list', sort: '', cursor: 'not-a-date|x_list:item' },
    { label: 'ordinary legacy parseable non-ISO time', sourceType: 'x_list', sort: '', cursor: '1|x_list:item' },
    { label: 'ordinary legacy impossible calendar time', sourceType: 'x_list', sort: '', cursor: '2026-02-30T00:00:00.000Z|x_list:item' },
    { label: 'ordinary legacy missing id', sourceType: 'x_list', sort: '', cursor: '2026-07-11T00:00:00.000Z|' },
    { label: 'ordinary legacy extra segment', sourceType: 'x_list', sort: '', cursor: '2026-07-11T00:00:00.000Z|x_list:item|extra' },

    // News feed ranking: v2 freezes its score clock; legacy remains readable.
    { label: 'feed v2 partial score', sourceType: 'blog,podcast', sort: '', cursor: 'v2|42oops|1|2026-07-11T00:00:00.000Z|blog:item|2026-07-12T00:00:00.000Z' },
    { label: 'feed v2 partial rank', sourceType: 'blog,podcast', sort: '', cursor: 'v2|42|1oops|2026-07-11T00:00:00.000Z|blog:item|2026-07-12T00:00:00.000Z' },
    { label: 'feed v2 out-of-domain rank', sourceType: 'blog,podcast', sort: '', cursor: 'v2|42|2|2026-07-11T00:00:00.000Z|blog:item|2026-07-12T00:00:00.000Z' },
    { label: 'feed v2 invalid item time', sourceType: 'blog,podcast', sort: '', cursor: 'v2|42|1|not-a-date|blog:item|2026-07-12T00:00:00.000Z' },
    { label: 'feed v2 missing id', sourceType: 'blog,podcast', sort: '', cursor: 'v2|42|1|2026-07-11T00:00:00.000Z||2026-07-12T00:00:00.000Z' },
    { label: 'feed v2 invalid rank time', sourceType: 'blog,podcast', sort: '', cursor: 'v2|42|1|2026-07-11T00:00:00.000Z|blog:item|not-a-date' },
    { label: 'feed v2 extra segment', sourceType: 'blog,podcast', sort: '', cursor: 'v2|42|1|2026-07-11T00:00:00.000Z|blog:item|2026-07-12T00:00:00.000Z|extra' },
    { label: 'feed legacy invalid score', sourceType: 'blog,podcast', sort: '', cursor: 'nope|2026-07-11T00:00:00.000Z|blog:item' },
    { label: 'feed legacy invalid time', sourceType: 'blog,podcast', sort: '', cursor: '42|not-a-date|blog:item' },
    { label: 'feed legacy parseable non-ISO time', sourceType: 'blog,podcast', sort: '', cursor: '42|0|blog:item' },
    { label: 'feed legacy missing id', sourceType: 'blog,podcast', sort: '', cursor: '42|2026-07-11T00:00:00.000Z|' },
    { label: 'feed legacy invalid optional rank time', sourceType: 'blog,podcast', sort: '', cursor: '42|2026-07-11T00:00:00.000Z|blog:item|2026-02-30T00:00:00.000Z' },
    { label: 'feed legacy fifth segment', sourceType: 'blog,podcast', sort: '', cursor: '42|2026-07-11T00:00:00.000Z|blog:item|2026-07-12T00:00:00.000Z|extra' },

    // Hot ordering: both frozen-clock v2h and legacy score/id cursors.
    { label: 'hot v2h partial score', sourceType: 'x_list', sort: 'hot', cursor: 'v2h|9oops|x_list:item|2026-07-12T00:00:00.000Z' },
    { label: 'hot v2h parseable non-ISO rank time', sourceType: 'x_list', sort: 'hot', cursor: 'v2h|9|x_list:item|1' },
    { label: 'hot v2h impossible calendar rank time', sourceType: 'x_list', sort: 'hot', cursor: 'v2h|9|x_list:item|2026-02-30T00:00:00.000Z' },
    { label: 'hot legacy invalid score', sourceType: 'x_list', sort: 'hot', cursor: 'nope|x_list:item' },
    { label: 'hot legacy missing id', sourceType: 'x_list', sort: 'hot', cursor: '9|' },
    { label: 'hot legacy extra segment', sourceType: 'x_list', sort: 'hot', cursor: '9|x_list:item|extra' },
  ])('$label fails closed before querying D1', async ({ sourceType, sort, cursor }) => {
    const captured: string[] = [];
    const url = new URL('https://api.ai-feeds.com/api/items');
    url.searchParams.set('source_type', sourceType);
    if (sort) url.searchParams.set('sort', sort);
    url.searchParams.set('cursor', cursor);

    const response = await handleItems(new Request(url), projectionEnv(captured));
    const payload = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(payload.error).toBe('invalid_cursor');
    expect(captured).toHaveLength(0);
  });

  test.each([
    {
      label: 'ordinary legacy',
      sourceType: 'x_list',
      sort: '',
      cursor: '2026-07-11T00:00:00.000Z|x_list:legacy',
      expectedTail: ['2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z', 'x_list:legacy'],
    },
    {
      label: 'feed-ranking legacy',
      sourceType: 'blog,podcast',
      sort: '',
      cursor: '42.5|2026-07-11T00:00:00.000Z|blog:legacy',
      expectedTail: [42.5, 42.5, '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z', 'blog:legacy'],
    },
    {
      label: 'hot legacy',
      sourceType: 'x_list',
      sort: 'hot',
      cursor: '9.25|x_list:legacy',
      expectedTail: [9.25, 9.25, 'x_list:legacy'],
    },
  ])('$label cursor remains readable and reaches its keyset query', async ({
    sourceType,
    sort,
    cursor,
    expectedTail,
  }) => {
    const captured: string[] = [];
    const binds: unknown[][] = [];
    const url = new URL('https://api.ai-feeds.com/api/items');
    url.searchParams.set('source_type', sourceType);
    if (sort) url.searchParams.set('sort', sort);
    url.searchParams.set('cursor', cursor);

    const response = await handleItems(
      new Request(url),
      projectionEnv(captured, [], binds),
    );

    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(binds).toHaveLength(1);
    expect(binds[0].slice(-(expectedTail.length + 1), -1)).toEqual(expectedTail);
  });

  test.each([
    {
      label: 'ordinary',
      sourceType: 'x_list',
      orderColumn: 'scraped_at',
      windowDays: 7,
      windowBindIndex: 1,
    },
    {
      label: 'feed-ranking',
      sourceType: 'blog,podcast',
      orderColumn: 'published_at',
      windowDays: 30,
      windowBindIndex: 2,
    },
  ])('$label request without a cursor keeps its default $windowDays-day SQL window', async ({
    sourceType,
    orderColumn,
    windowDays,
    windowBindIndex,
  }) => {
    const captured: string[] = [];
    const binds: unknown[][] = [];
    const before = Date.now();
    const response = await handleItems(
      new Request(`https://api.ai-feeds.com/api/items?source_type=${sourceType}`),
      projectionEnv(captured, [], binds),
    );
    const after = Date.now();

    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain(`${orderColumn} >= ?`);
    const actualWindow = Date.parse(String(binds[0][windowBindIndex]));
    expect(actualWindow).toBeGreaterThanOrEqual(before - windowDays * 86_400_000);
    expect(actualWindow).toBeLessThanOrEqual(after - windowDays * 86_400_000);
  });
});
