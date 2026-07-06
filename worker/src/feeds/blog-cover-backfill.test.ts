import { describe, test, expect } from 'vitest';
import {
  runBlogCoverOgBackfill,
  runBlogCoverGenericSweep,
} from './media-r2';
import type { Env } from '../index';

// ── 共享内存 DB mock:解释 blog-cover 两个 mode 的 SQL ──
interface FakeItem {
  id: string;
  source_type: string;
  url?: string | null;
  extra: Record<string, unknown>;
}

// 派生 source key(与 SQL 的 COALESCE(feed_key, show_key, source_type) 对齐)
function srcOf(it: FakeItem): string {
  return String(
    it.extra.feed_key || it.extra.show_key || it.source_type,
  );
}
function coverOf(it: FakeItem): string {
  return String(it.extra.cover_image || '');
}
function isR2(u: string): boolean {
  return u.startsWith('/r/') || /^https?:\/\/[^/]+\/r\//i.test(u);
}

// backfill 谓词:blog + cover 空 + 未打 og 游标 + 有 url
function backfillActionable(it: FakeItem): boolean {
  return (
    it.source_type === 'blog' &&
    coverOf(it) === '' &&
    !it.extra.cover_og_backfilled_at &&
    !!String(it.url || '').trim()
  );
}

function makeEnv(items: FakeItem[]) {
  const updates: Array<{ sql: string; binds: unknown[] }> = [];
  const byId = new Map(items.map((it) => [it.id, it]));

  const DB = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...b: unknown[]) {
          bound = b;
          return stmt;
        },
        async all<T>() {
          // backfill batch
          if (/SELECT id, url, extra FROM items/i.test(sql)) {
            const limit = Number(bound[0]) || 1000;
            const rows = items
              .filter(backfillActionable)
              .slice(0, limit)
              .map((it) => ({ id: it.id, url: it.url, extra: JSON.stringify(it.extra) }));
            return { results: rows as unknown as T[] };
          }
          // generic-sweep 聚合(GROUP BY src, cover HAVING n>=?)
          if (/GROUP BY/i.test(sql) && /HAVING/i.test(sql)) {
            const minCount = Number(bound[0]) || 3;
            const limit = Number(bound[1]) || 1000;
            const buckets = new Map<string, { src: string; cover: string; n: number }>();
            for (const it of items) {
              if (!['blog', 'podcast'].includes(it.source_type)) continue;
              const cov = coverOf(it);
              if (!cov || !isR2(cov)) continue;
              const src = srcOf(it);
              const k = `${src} ${cov}`;
              const b = buckets.get(k) || { src, cover: cov, n: 0 };
              b.n++;
              buckets.set(k, b);
            }
            const rows = [...buckets.values()]
              .filter((b) => b.n >= minCount)
              .sort((a, b) => b.n - a.n)
              .slice(0, limit)
              .map((b) => ({ src: b.src, cover: b.cover, n: b.n }));
            return { results: rows as unknown as T[] };
          }
          return { results: [] as T[] };
        },
        async first<T>() {
          if (/COUNT\(\*\)/i.test(sql)) {
            const c = items.filter(backfillActionable).length;
            return { c } as unknown as T;
          }
          return null;
        },
        async run() {
          updates.push({ sql, binds: bound });
          // backfill 写:最后一个 bind 是 id
          if (/WHERE id = \?/i.test(sql)) {
            const id = String(bound[bound.length - 1]);
            const it = byId.get(id);
            if (it) {
              if (/'\$\.cover_image', \?/i.test(sql)) {
                // adopted:cover_image = bound[0]
                it.extra.cover_image = String(bound[0]);
              }
              it.extra.cover_og_backfilled_at = 'done';
            }
          }
          // generic-sweep 清簇:WHERE cover=? AND src=?
          if (/json_extract\(extra,'\$\.cover_image'\) = \?/i.test(sql) || /cover_image'\) = \?/i.test(sql)) {
            const cover = String(bound[1]);
            const src = String(bound[2]);
            for (const it of items) {
              if (coverOf(it) === cover && srcOf(it) === src) {
                delete it.extra.cover_image;
                it.extra.cover_generic_cleared_at = String(bound[0]);
                delete it.extra.cover_og_backfilled_at;
              }
            }
          }
          return { success: true };
        },
      };
      return stmt;
    },
  };

  const env = { DB } as unknown as Env;
  return { env, updates };
}

const OG_HTML = '<html><head><meta property="og:image" content="https://cdn/real-hero.jpg"></head><body>x</body></html>';
const NO_OG_HTML = '<html><head><title>x</title></head><body>y</body></html>';

// ═══════════════ Fix 3: blog-cover-og-backfill ═══════════════
describe('runBlogCoverOgBackfill', () => {
  test('og:image 存在 + 迁移成功 → adopted,cover 写入,游标推进', async () => {
    const items: FakeItem[] = [
      { id: 'blog:the-verge:a', source_type: 'blog', url: 'https://theverge.com/a', extra: { feed_key: 'the-verge' } },
    ];
    const { env, updates } = makeEnv(items);
    const res = await runBlogCoverOgBackfill(env, { limit: 15, dry: false }, {
      fetchHtml: async () => OG_HTML,
      migrateCover: async () => '/r/blog/hero-r2.jpg',
    });
    expect(res.scanned).toBe(1);
    expect(res.adopted).toBe(1);
    expect(res.skipped).toBe(0);
    expect(res.remaining).toBe(0);
    expect(items[0].extra.cover_image).toBe('/r/blog/hero-r2.jpg');
    expect(items[0].extra.cover_og_backfilled_at).toBe('done');
    expect(updates.length).toBe(1);
  });

  test('页面抓不到(fetchHtml=null)→ skipped,游标仍推进,cover 保持空', async () => {
    const items: FakeItem[] = [
      { id: 'blog:x:b', source_type: 'blog', url: 'https://x.com/b', extra: { feed_key: 'x' } },
    ];
    const { env } = makeEnv(items);
    const res = await runBlogCoverOgBackfill(env, { limit: 15, dry: false }, {
      fetchHtml: async () => null,
      migrateCover: async () => '/r/blog/nope.jpg',
    });
    expect(res.adopted).toBe(0);
    expect(res.skipped).toBe(1);
    expect(items[0].extra.cover_image).toBeUndefined();
    expect(items[0].extra.cover_og_backfilled_at).toBe('done'); // 游标推进,不再重扫
  });

  test('页面无 og:image → skipped,保持 monogram 兜底', async () => {
    const items: FakeItem[] = [
      { id: 'blog:x:c', source_type: 'blog', url: 'https://x.com/c', extra: { feed_key: 'x' } },
    ];
    const { env } = makeEnv(items);
    const res = await runBlogCoverOgBackfill(env, { limit: 15, dry: false }, {
      fetchHtml: async () => NO_OG_HTML,
      migrateCover: async () => '/r/blog/x.jpg',
    });
    expect(res.skipped).toBe(1);
    expect(res.adopted).toBe(0);
  });

  test('og:image 存在但质量门/迁移失败(migrateCover=null)→ skipped', async () => {
    const items: FakeItem[] = [
      { id: 'blog:x:d', source_type: 'blog', url: 'https://x.com/d', extra: { feed_key: 'x' } },
    ];
    const { env } = makeEnv(items);
    const res = await runBlogCoverOgBackfill(env, { limit: 15, dry: false }, {
      fetchHtml: async () => OG_HTML,
      migrateCover: async () => null,
    });
    expect(res.skipped).toBe(1);
    expect(res.adopted).toBe(0);
    expect(items[0].extra.cover_image).toBeUndefined();
    expect(items[0].extra.cover_og_backfilled_at).toBe('done');
  });

  test('dry=1 → 零写(无 UPDATE),但统计 og 命中', async () => {
    const items: FakeItem[] = [
      { id: 'blog:v:e', source_type: 'blog', url: 'https://v.com/e', extra: { feed_key: 'v' } },
      { id: 'blog:v:f', source_type: 'blog', url: 'https://v.com/f', extra: { feed_key: 'v' } },
    ];
    const { env, updates } = makeEnv(items);
    const res = await runBlogCoverOgBackfill(env, { limit: 15, dry: true }, {
      fetchHtml: async () => OG_HTML,
      migrateCover: async () => '/r/blog/z.jpg',
    });
    expect(updates.length).toBe(0);
    expect(res.adopted).toBe(2); // og 命中 = 候选采用
    expect(items[0].extra.cover_image).toBeUndefined(); // 未写
    expect(items[0].extra.cover_og_backfilled_at).toBeUndefined();
  });

  test('非 blog / 已有 cover / 已打游标 → 不进批', async () => {
    const items: FakeItem[] = [
      { id: 'pod:p', source_type: 'podcast', url: 'https://p.com', extra: {} }, // 非 blog
      { id: 'blog:has', source_type: 'blog', url: 'https://h.com', extra: { cover_image: '/r/blog/x.jpg' } }, // 已有 cover
      { id: 'blog:done', source_type: 'blog', url: 'https://d.com', extra: { cover_og_backfilled_at: 'done' } }, // 已处理
      { id: 'blog:nourl', source_type: 'blog', url: '', extra: {} }, // 无 url
    ];
    const { env } = makeEnv(items);
    const res = await runBlogCoverOgBackfill(env, { limit: 15, dry: false }, {
      fetchHtml: async () => OG_HTML,
      migrateCover: async () => '/r/blog/x.jpg',
    });
    expect(res.scanned).toBe(0);
  });
});

// ═══════════════ Fix 2a: blog-cover-generic-sweep ═══════════════
describe('runBlogCoverGenericSweep', () => {
  test('同源 3+ 同 hash 判簇并清空;2 条不判', async () => {
    const items: FakeItem[] = [
      // 簇 A:the-verge 头像 3 条(命中阈值)
      { id: 'blog:the-verge:1', source_type: 'blog', extra: { feed_key: 'the-verge', cover_image: '/r/blog/4e19.jpg', blog_media_r2_at: 'x' } },
      { id: 'blog:the-verge:2', source_type: 'blog', extra: { feed_key: 'the-verge', cover_image: '/r/blog/4e19.jpg', blog_media_r2_at: 'x' } },
      { id: 'blog:the-verge:3', source_type: 'blog', extra: { feed_key: 'the-verge', cover_image: '/r/blog/4e19.jpg', blog_media_r2_at: 'x' } },
      // 簇 B:the-verge 另一头像 2 条(不足阈值,保留)
      { id: 'blog:the-verge:4', source_type: 'blog', extra: { feed_key: 'the-verge', cover_image: '/r/blog/611e.jpg', blog_media_r2_at: 'x' } },
      { id: 'blog:the-verge:5', source_type: 'blog', extra: { feed_key: 'the-verge', cover_image: '/r/blog/611e.jpg', blog_media_r2_at: 'x' } },
    ];
    const { env } = makeEnv(items);
    const res = await runBlogCoverGenericSweep(env, { minCount: 3, limit: 50, dry: false });
    expect(res.clustersCleared).toBe(1);
    expect(res.itemsCleared).toBe(3);
    // 簇 A 三条被清
    expect(items[0].extra.cover_image).toBeUndefined();
    expect(items[2].extra.cover_image).toBeUndefined();
    // 簇 B 两条保留
    expect(items[3].extra.cover_image).toBe('/r/blog/611e.jpg');
  });

  test('清簇后 og 游标被清除(便于 Fix 3 回填)', async () => {
    const items: FakeItem[] = [
      { id: 'blog:q:1', source_type: 'blog', extra: { feed_key: 'qbitai', cover_image: '/r/blog/8fba.jpg', blog_media_r2_at: 'x', cover_og_backfilled_at: 'old' } },
      { id: 'blog:q:2', source_type: 'blog', extra: { feed_key: 'qbitai', cover_image: '/r/blog/8fba.jpg', blog_media_r2_at: 'x' } },
      { id: 'blog:q:3', source_type: 'blog', extra: { feed_key: 'qbitai', cover_image: '/r/blog/8fba.jpg', blog_media_r2_at: 'x' } },
    ];
    const { env } = makeEnv(items);
    await runBlogCoverGenericSweep(env, { minCount: 3, limit: 50, dry: false });
    expect(items[0].extra.cover_og_backfilled_at).toBeUndefined();
    expect(items[0].extra.cover_generic_cleared_at).toBeTruthy();
  });

  test('跨源不合簇:两源各自 2 条同 hash 不判(源内独立计数)', async () => {
    const items: FakeItem[] = [
      { id: 'blog:a:1', source_type: 'blog', extra: { feed_key: 'aiera', cover_image: '/r/blog/same.jpg', blog_media_r2_at: 'x' } },
      { id: 'blog:a:2', source_type: 'blog', extra: { feed_key: 'aiera', cover_image: '/r/blog/same.jpg', blog_media_r2_at: 'x' } },
      { id: 'blog:b:1', source_type: 'blog', extra: { feed_key: 'openai', cover_image: '/r/blog/same.jpg', blog_media_r2_at: 'x' } },
      { id: 'blog:b:2', source_type: 'blog', extra: { feed_key: 'openai', cover_image: '/r/blog/same.jpg', blog_media_r2_at: 'x' } },
    ];
    const { env } = makeEnv(items);
    const res = await runBlogCoverGenericSweep(env, { minCount: 3, limit: 50, dry: false });
    expect(res.clustersCleared).toBe(0);
  });

  test('dry=1 → 列簇明细但零写', async () => {
    const items: FakeItem[] = [
      { id: 'blog:q:1', source_type: 'blog', extra: { feed_key: 'qbitai', cover_image: '/r/blog/8fba.jpg', blog_media_r2_at: 'x' } },
      { id: 'blog:q:2', source_type: 'blog', extra: { feed_key: 'qbitai', cover_image: '/r/blog/8fba.jpg', blog_media_r2_at: 'x' } },
      { id: 'blog:q:3', source_type: 'blog', extra: { feed_key: 'qbitai', cover_image: '/r/blog/8fba.jpg', blog_media_r2_at: 'x' } },
    ];
    const { env, updates } = makeEnv(items);
    const res = await runBlogCoverGenericSweep(env, { minCount: 3, limit: 50, dry: true });
    expect(res.clusters.length).toBe(1);
    expect(res.clusters[0]).toMatchObject({ src: 'qbitai', cover: '/r/blog/8fba.jpg', count: 3 });
    expect(res.clustersCleared).toBe(0);
    expect(updates.length).toBe(0);
    expect(items[0].extra.cover_image).toBe('/r/blog/8fba.jpg'); // 未清
  });

  test('外链态 cover 不计入簇(只统计 R2 形态)', async () => {
    const items: FakeItem[] = [
      { id: 'blog:e:1', source_type: 'blog', extra: { feed_key: 'x', cover_image: 'https://cdn/a.jpg' } },
      { id: 'blog:e:2', source_type: 'blog', extra: { feed_key: 'x', cover_image: 'https://cdn/a.jpg' } },
      { id: 'blog:e:3', source_type: 'blog', extra: { feed_key: 'x', cover_image: 'https://cdn/a.jpg' } },
    ];
    const { env } = makeEnv(items);
    const res = await runBlogCoverGenericSweep(env, { minCount: 3, limit: 50, dry: true });
    expect(res.clusters.length).toBe(0);
  });
});
