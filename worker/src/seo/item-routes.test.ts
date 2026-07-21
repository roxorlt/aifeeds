import { describe, test, expect, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import { handleItemRoute } from './item-routes';
import { isSeoPath } from '../seo-routes';
import { itemPageR2Key } from '../digest/render';
import type { Env } from '../index';
import type { RenderRow } from '../digest/render';
import type { ItemPageRunResult } from './item-page-run';

const SITE = 'https://ai-feeds.com';
const API = 'https://api.ai-feeds.com';
const sensitiveExtra = JSON.stringify({
  cn_sensitive: 1,
  workflow_completed_at: '2026-07-20T00:00:00Z',
});

// ── 有状态 D1 mock：items（按 id / PH LIKE 查）+ item_pages（按 item_id 查 status）──
interface DbSeed {
  items?: Record<string, Partial<RenderRow> & { is_relevant?: number }>;
  pages?: Record<string, string>; // item_id → status
  phByPattern?: Record<string, { id: string }>; // LIKE pattern → 最新行 id
}
function makeDb(seed: DbSeed = {}) {
  const items = new Map(Object.entries(seed.items ?? {}));
  const pages = new Map(Object.entries(seed.pages ?? {}));
  const phByPattern = new Map(Object.entries(seed.phByPattern ?? {}));
  const queries: string[] = [];
  return {
    queries,
    prepare(sql: string) {
      queries.push(sql);
      let binds: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) {
          binds = a;
          return stmt;
        },
        async first<T>() {
          const key = String(binds[0]);
          if (/FROM item_pages/i.test(sql)) {
            const status = pages.get(key);
            return (status ? { status } : null) as T | null;
          }
          if (/FROM items/i.test(sql) && /LIKE/i.test(sql)) {
            return (phByPattern.get(key) ?? null) as T | null;
          }
          if (/FROM items/i.test(sql)) {
            const row = items.get(key);
            return (row ? { id: key, ...row } : null) as T | null;
          }
          return null as T | null;
        },
      };
      return stmt;
    },
  };
}

function makeR2(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const puts: string[] = [];
  return {
    store,
    puts,
    async get(key: string) {
      const v = store.get(key);
      return v == null ? null : { body: v };
    },
    async put(key: string, val: string) {
      store.set(key, String(val));
      puts.push(key);
    },
  };
}

function makeEnv(db: unknown, r2: unknown): Env {
  return { SITE_BASE: SITE, API_BASE: API, DB: db, READMES: r2 } as unknown as Env;
}

function sqliteD1(db: DatabaseSync) {
  return {
    prepare(sql: string) {
      let bindings: SQLInputValue[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          bindings = values as SQLInputValue[];
          return stmt;
        },
        async first<T>() {
          return (db.prepare(sql).get(...bindings) ?? null) as T | null;
        },
      };
      return stmt;
    },
  };
}

function req(path: string, method = 'GET'): Request {
  return new Request(`${SITE}${path}`, { method });
}

describe('isSeoPath（/i/ 与 sitemap 分片放行）', () => {
  test('/i/ 前缀与 sitemap-<source>.xml 命中；/api/ 不命中', () => {
    expect(isSeoPath('/i/x/1')).toBe(true);
    expect(isSeoPath('/i/gh/acme/tool')).toBe(true);
    expect(isSeoPath('/i/news/blog%3Ahash')).toBe(true);
    expect(isSeoPath('/sitemap-x.xml')).toBe(true);
    expect(isSeoPath('/sitemap-hf-paper.xml')).toBe(true);
    expect(isSeoPath('/sitemap-x-2.xml')).toBe(true);
    // 既有放行不回归
    expect(isSeoPath('/sitemap.xml')).toBe(true);
    expect(isSeoPath('/daily/2026-07-01')).toBe(true);
    // 非 SEO 路径仍不放行
    expect(isSeoPath('/api/x')).toBe(false);
    expect(isSeoPath('/i')).toBe(false);
    expect(isSeoPath('/sitemap-foo.json')).toBe(false); // 分片必须 .xml
    expect(isSeoPath('/sitemap-x.html')).toBe(false);
  });
});

describe('handleItemRoute', () => {
  test('非 /i/ 路径 → null（穿透后续路由）', async () => {
    const env = makeEnv(makeDb(), makeR2());
    expect(await handleItemRoute(req('/api/items'), env)).toBeNull();
    expect(await handleItemRoute(req('/daily/2026-07-01'), env)).toBeNull();
    expect(await handleItemRoute(req('/'), env)).toBeNull();
  });

  test('非 GET/HEAD 的 /i/ → null（交回 index 兜底）', async () => {
    const env = makeEnv(makeDb(), makeR2());
    expect(await handleItemRoute(req('/i/x/1', 'POST'), env)).toBeNull();
  });

  test('live + R2 命中 → 200 + text/html + max-age=3600', async () => {
    const id = 'x_list:123';
    const key = itemPageR2Key(id)!;
    const db = makeDb({
      items: { [id]: { is_relevant: 1, content_translated: '正文' } },
      pages: { [id]: 'live' },
    });
    const r2 = makeR2({ [key]: '<!doctype html><title>HIT</title>' });
    const res = await handleItemRoute(req('/i/x/123'), makeEnv(db, r2));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res!.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect(await res!.text()).toContain('HIT');
  });

  test('live 但 R2 miss 且 relevant → 调 generateItemPage 兜底后 200', async () => {
    const id = 'gh_owner_repo';
    const composite = 'github:acme/tool';
    const key = itemPageR2Key(composite)!;
    const db = makeDb({
      items: { [composite]: { is_relevant: 1 } },
      pages: { [composite]: 'live' },
    });
    const r2 = makeR2(); // 空 → 首次 get miss
    // mock generateItemPage：模拟真实写入 R2（Task 4 行为），返回非 skipped
    const generate = vi.fn(async (_env: Env, cid: string): Promise<ItemPageRunResult> => {
      await r2.put(key, '<!doctype html><title>GEN</title>');
      return { itemId: cid, skipped: false };
    });
    const res = await handleItemRoute(req('/i/gh/acme/tool'), makeEnv(db, r2), generate);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][1]).toBe(composite);
    expect(res!.status).toBe(200);
    expect(await res!.text()).toContain('GEN');
    void id;
  });

  test('status=gone → 410 + noindex + no-store', async () => {
    const id = 'x_list:9';
    const db = makeDb({
      items: { [id]: { is_relevant: 1 } },
      pages: { [id]: 'gone' },
    });
    const r2 = makeR2();
    const res = await handleItemRoute(req('/i/x/9'), makeEnv(db, r2));
    expect(res!.status).toBe(410);
    expect(res!.headers.get('Cache-Control')).toBe('no-store');
    expect(await res!.text()).toContain('name="robots" content="noindex"');
  });

  test('item is_relevant=0 → 410 + noindex（即便无 item_pages 行）', async () => {
    const id = 'x_list:8';
    const db = makeDb({ items: { [id]: { is_relevant: 0 } } });
    const r2 = makeR2();
    const res = await handleItemRoute(req('/i/x/8'), makeEnv(db, r2));
    expect(res!.status).toBe(410);
    expect(await res!.text()).toContain('noindex');
  });

  test('cn_sensitive=1 → 即使 live 且 R2 有旧快照也返回 410 + noindex + no-store', async () => {
    const id = 'blog:sensitive';
    const key = itemPageR2Key(id)!;
    const db = makeDb({
      items: { [id]: { is_relevant: 1, extra: sensitiveExtra } },
      pages: { [id]: 'live' },
    });
    const r2 = makeR2({ [key]: '<!doctype html><title>旧敏感快照</title>' });
    const generate = vi.fn();

    const res = await handleItemRoute(
      req(`/i/news/${encodeURIComponent(id)}`),
      makeEnv(db, r2),
      generate,
    );

    expect(res!.status).toBe(410);
    expect(res!.headers.get('Cache-Control')).toContain('no-store');
    expect(res!.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(await res!.text()).toContain('name="robots" content="noindex"');
    expect(generate).not.toHaveBeenCalled();
  });

  test('id 无对应 item → 404（含返回首页链接）', async () => {
    const db = makeDb({});
    const r2 = makeR2();
    const res = await handleItemRoute(req('/i/x/404'), makeEnv(db, r2));
    expect(res!.status).toBe(404);
    expect(res!.headers.get('Cache-Control')).toBe('no-store');
    expect(await res!.text()).toContain(`href="${SITE}/"`);
  });

  test('未知 source 段 → 404', async () => {
    const res = await handleItemRoute(req('/i/foo/1'), makeEnv(makeDb(), makeR2()));
    expect(res!.status).toBe(404);
  });

  test('/i/ph/:slug → 反解该 slug 最新 product_hunt 行并伺服', async () => {
    const latest = 'product_hunt:coolslug:2026-07-08';
    const key = itemPageR2Key(latest)!;
    const db = makeDb({
      items: { [latest]: { is_relevant: 1, title: 'Cool Product' } },
      pages: { [latest]: 'live' },
      phByPattern: { 'product_hunt:coolslug:%': { id: latest } },
    });
    const r2 = makeR2({ [key]: '<!doctype html><title>PH-LATEST</title>' });
    const res = await handleItemRoute(req('/i/ph/coolslug'), makeEnv(db, r2));
    expect(res!.status).toBe(200);
    expect(await res!.text()).toContain('PH-LATEST');
    expect(db.queries.find((sql) => /FROM items/i.test(sql) && /LIKE/i.test(sql))).toMatch(
      /ORDER BY\s+CASE WHEN p\.status = 'live' THEN 0 ELSE 1 END ASC,\s*COALESCE\(NULLIF\(i\.published_at,\s*''\),\s*i\.scraped_at\)\s+DESC,\s*i\.id\s+DESC/i,
    );
  });

  test('PH canonical 解析与归档共用 eligible/live-or-missing 候选集和 effective time 排序', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
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
    const insertItem = sqlite.prepare(`
      INSERT INTO items (
        id, source_type, published_at, scraped_at, is_relevant, deleted_at, extra
      ) VALUES (?, 'product_hunt', ?, ?, ?, NULL, ?)
    `);
    const insertPage = sqlite.prepare(`
      INSERT INTO item_pages (item_id, source, url_path, generated_at, status)
      VALUES (?, 'ph', ?, ?, ?)
    `);
    const seed = (
      id: string,
      publishedAt: string | null,
      scrapedAt: string,
      relevant: number,
      status: 'live' | 'gone' | 'missing',
    ) => {
      const slug = id.split(':')[1];
      insertItem.run(id, publishedAt, scrapedAt, relevant, '{"cn_sensitive":0}');
      if (status !== 'missing') insertPage.run(id, `/i/ph/${slug}`, scrapedAt, status);
    };

    seed(
      'product_hunt:eligible-fallback:2026-05-01',
      '2026-05-01T07:00:00Z',
      '2026-05-01T07:00:00Z',
      1,
      'live',
    );
    seed(
      'product_hunt:eligible-fallback:2026-06-01',
      '2026-06-01T07:00:00Z',
      '2026-06-01T07:00:00Z',
      0,
      'live',
    );
    seed(
      'product_hunt:gone-fallback:2026-05-01',
      '2026-05-01T07:00:00Z',
      '2026-05-01T07:00:00Z',
      1,
      'live',
    );
    seed(
      'product_hunt:gone-fallback:2026-06-01',
      '2026-06-01T07:00:00Z',
      '2026-06-01T07:00:00Z',
      1,
      'gone',
    );
    seed(
      'product_hunt:null-time:2026-05-01',
      '2026-05-01T07:00:00Z',
      '2026-05-01T07:00:00Z',
      1,
      'live',
    );
    seed(
      'product_hunt:null-time:2026-06-01',
      null,
      '2026-06-01T07:00:00Z',
      1,
      'live',
    );
    seed(
      'product_hunt:missing-fallback:2026-05-01',
      '2026-05-01T07:00:00Z',
      '2026-05-01T07:00:00Z',
      1,
      'live',
    );
    seed(
      'product_hunt:missing-fallback:2026-06-01',
      '2026-06-01T07:00:00Z',
      '2026-06-01T07:00:00Z',
      1,
      'missing',
    );
    seed(
      'product_hunt:missing-only:2026-06-01',
      '2026-06-01T07:00:00Z',
      '2026-06-01T07:00:00Z',
      1,
      'missing',
    );

    const r2 = makeR2({
      [itemPageR2Key('product_hunt:eligible-fallback:2026-05-01')!]: 'ELIGIBLE-OLD',
      [itemPageR2Key('product_hunt:gone-fallback:2026-05-01')!]: 'GONE-OLD',
      [itemPageR2Key('product_hunt:null-time:2026-06-01')!]: 'NULL-TIME-NEW',
      [itemPageR2Key('product_hunt:missing-fallback:2026-05-01')!]: 'MISSING-OLD',
    });
    const env = makeEnv(sqliteD1(sqlite), r2);

    expect(await (await handleItemRoute(req('/i/ph/eligible-fallback'), env))!.text()).toContain(
      'ELIGIBLE-OLD',
    );
    expect(await (await handleItemRoute(req('/i/ph/gone-fallback'), env))!.text()).toContain(
      'GONE-OLD',
    );
    expect(await (await handleItemRoute(req('/i/ph/null-time'), env))!.text()).toContain(
      'NULL-TIME-NEW',
    );
    expect(await (await handleItemRoute(req('/i/ph/missing-fallback'), env))!.text()).toContain(
      'MISSING-OLD',
    );
    const missingOnlyId = 'product_hunt:missing-only:2026-06-01';
    const generate = vi.fn(async (_env: Env, id: string): Promise<ItemPageRunResult> => {
      await r2.put(itemPageR2Key(id)!, 'MISSING-ONLY-GENERATED');
      return { itemId: id, skipped: false };
    });
    const missingOnly = await handleItemRoute(req('/i/ph/missing-only'), env, generate);
    expect(generate).toHaveBeenCalledWith(env, missingOnlyId);
    expect(await missingOnly!.text()).toContain('MISSING-ONLY-GENERATED');
    sqlite.close();
  });

  test('/i/ph/:slug slug 无匹配行 → 404', async () => {
    const db = makeDb({ phByPattern: {} });
    const res = await handleItemRoute(req('/i/ph/nope'), makeEnv(db, makeR2()));
    expect(res!.status).toBe(404);
  });

  test('/i/ph/:slug 含 LIKE 通配符（%25→%）→ 404，不进 D1 LIKE（I1）', async () => {
    // 若不校验 slug，`%` 会作 LIKE 通配符匹配全部 PH 行 → 返回最新 200（可缓存）。
    const latest = 'product_hunt:whatever:2026-07-08';
    const key = itemPageR2Key(latest)!;
    const db = makeDb({
      items: { [latest]: { is_relevant: 1 } },
      pages: { [latest]: 'live' },
      // mock 里 LIKE 命中 %-pattern（等价真实 LIKE 全表命中）；白名单必须在此之前拦掉。
      phByPattern: { 'product_hunt:%:%': { id: latest } },
    });
    const r2 = makeR2({ [key]: '<!doctype html><title>LEAK</title>' });
    const res = await handleItemRoute(req('/i/ph/%25'), makeEnv(db, r2));
    expect(res!.status).toBe(404);
  });

  test('/i/ph/:slug 含连字符的合法 slug → 正常反解命中（I1 不误伤）', async () => {
    const latest = 'product_hunt:cool-tool:2026-07-08';
    const key = itemPageR2Key(latest)!;
    const db = makeDb({
      items: { [latest]: { is_relevant: 1 } },
      pages: { [latest]: 'live' },
      phByPattern: { 'product_hunt:cool-tool:%': { id: latest } },
    });
    const r2 = makeR2({ [key]: '<!doctype html><title>HYPHEN-OK</title>' });
    const res = await handleItemRoute(req('/i/ph/cool-tool'), makeEnv(db, r2));
    expect(res!.status).toBe(200);
    expect(await res!.text()).toContain('HYPHEN-OK');
  });

  test('HEAD 在 R2 miss 时不触发按需生成（M2 零写副作用）→ 404', async () => {
    const composite = 'github:acme/tool';
    const db = makeDb({
      items: { [composite]: { is_relevant: 1 } },
      pages: { [composite]: 'live' },
    });
    const r2 = makeR2(); // 空 → R2 miss
    const generate = vi.fn(async (_env: Env, cid: string): Promise<ItemPageRunResult> => {
      await r2.put(itemPageR2Key(composite)!, '<!doctype html><title>GEN</title>');
      return { itemId: cid, skipped: false };
    });
    const res = await handleItemRoute(req('/i/gh/acme/tool', 'HEAD'), makeEnv(db, r2), generate);
    expect(generate).not.toHaveBeenCalled(); // HEAD 不触发写副作用
    expect(res!.status).toBe(404);
    expect(r2.puts.length).toBe(0);
  });

  test('/i/news/<enc composite id> → 反解回整 composite id 伺服', async () => {
    const composite = 'blog:abc123';
    const key = itemPageR2Key(composite)!;
    const db = makeDb({
      items: { [composite]: { is_relevant: 1 } },
      pages: { [composite]: 'live' },
    });
    const r2 = makeR2({ [key]: '<!doctype html><title>NEWS</title>' });
    const res = await handleItemRoute(req(`/i/news/${encodeURIComponent(composite)}`), makeEnv(db, r2));
    expect(res!.status).toBe(200);
    expect(await res!.text()).toContain('NEWS');
  });
});
