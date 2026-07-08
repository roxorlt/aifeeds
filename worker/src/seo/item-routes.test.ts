import { describe, test, expect, vi } from 'vitest';

import { handleItemRoute } from './item-routes';
import { isSeoPath } from '../seo-routes';
import { itemPageR2Key } from '../digest/render';
import type { Env } from '../index';
import type { RenderRow } from '../digest/render';
import type { ItemPageRunResult } from './item-page-run';

const SITE = 'https://ai-feeds.com';
const API = 'https://api.ai-feeds.com';

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
  return {
    prepare(sql: string) {
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
  });

  test('/i/ph/:slug slug 无匹配行 → 404', async () => {
    const db = makeDb({ phByPattern: {} });
    const res = await handleItemRoute(req('/i/ph/nope'), makeEnv(db, makeR2()));
    expect(res!.status).toBe(404);
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
