import { describe, test, expect } from 'vitest';
import {
  isSourceLevelBrandLogo,
  migrateMediaForBlog,
  pickBodyHeroCover,
  runBlogCoverBodyHeroBackfill,
} from './media-r2';
import type { Env } from '../index';

// ── 共享内存 DB mock（Task 2：采用护栏 + 差异回填）──
// 手写解释以下 SQL：
//   - 采用护栏 COUNT：SELECT COUNT(*) AS n ... id != ? AND <src>=? AND cover LIKE ?
//   - migrateMediaForBlog loadItem：SELECT id, extra as extra_raw ... WHERE id=? AND source_type='blog'
//   - applyExtraPatch：UPDATE items SET extra = json_set(...) WHERE id=?
//   - bodyhero-backfill batch：SELECT id, extra FROM items WHERE <predicate> LIMIT ?
//   - bodyhero-backfill remaining：SELECT COUNT(*) AS c FROM items WHERE <predicate>
interface FakeItem {
  id: string;
  source_type: string;
  url?: string | null;
  extra: Record<string, unknown>;
}

// 派生 source key（与 SQL GENERIC_SRC_EXPR = COALESCE(feed_key, show_key, source_type) 对齐）。
function srcOf(it: FakeItem): string {
  return String(it.extra.feed_key || it.extra.show_key || it.source_type);
}
function coverOf(it: FakeItem): string {
  return String(it.extra.cover_image || '');
}

// bodyhero-backfill 谓词：blog + cover 空 + 被清簇（cleared_hash 置位）+ 未打 bodyhero 游标。
function bodyHeroActionable(it: FakeItem): boolean {
  return (
    it.source_type === 'blog' &&
    coverOf(it) === '' &&
    it.extra.cover_generic_cleared_hash != null &&
    it.extra.cover_bodyhero_backfilled_at == null
  );
}

function makeEnv(items: FakeItem[], hasR2 = true) {
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
          // bodyhero-backfill batch
          if (/SELECT id, extra FROM items/i.test(sql) && /LIMIT/i.test(sql)) {
            const limit = Number(bound[0]) || 1000;
            const rows = items
              .filter(bodyHeroActionable)
              .slice(0, limit)
              .map((it) => ({ id: it.id, extra: JSON.stringify(it.extra) }));
            return { results: rows as unknown as T[] };
          }
          return { results: [] as T[] };
        },
        async first<T>() {
          // 采用护栏 COUNT：id != ? AND <src>=? AND cover LIKE ?
          if (/COUNT\(\*\) AS n/i.test(sql)) {
            const excludeId = String(bound[0]);
            const src = String(bound[1]);
            const like = String(bound[2]); // '%/r/<key>'
            const suffix = like.startsWith('%') ? like.slice(1) : like;
            const n = items.filter(
              (it) =>
                it.source_type === 'blog' &&
                it.id !== excludeId &&
                srcOf(it) === src &&
                coverOf(it).endsWith(suffix),
            ).length;
            return { n } as unknown as T;
          }
          // bodyhero-backfill remaining
          if (/COUNT\(\*\) AS c/i.test(sql)) {
            const c = items.filter(bodyHeroActionable).length;
            return { c } as unknown as T;
          }
          // migrateMediaForBlog loadItem
          if (/SELECT id, extra as extra_raw FROM items/i.test(sql)) {
            const it = byId.get(String(bound[0]));
            if (!it) return null;
            return { id: it.id, extra_raw: JSON.stringify(it.extra) } as unknown as T;
          }
          return null;
        },
        async run() {
          updates.push({ sql, binds: bound });
          // applyExtraPatch / bodyhero-backfill UPDATE：末位 bind 是 id，前面依 json_set 路径顺序。
          if (/UPDATE items SET extra = json_set/i.test(sql) && /WHERE id = \?/i.test(sql)) {
            const id = String(bound[bound.length - 1]);
            const it = byId.get(id);
            if (it) {
              const paths = [...sql.matchAll(/'\$\.([a-zA-Z0-9_]+)'/g)].map((m) => m[1]);
              paths.forEach((p, i) => {
                const v = bound[i];
                if (v === '' && p === 'cover_image') delete it.extra.cover_image;
                else it.extra[p] = v;
              });
            }
          }
          return { success: true };
        },
      };
      return stmt;
    },
  };

  const env = { DB, READMES: hasR2 ? {} : undefined } as unknown as Env;
  return { env, updates };
}

// ═══════════════ 层 1：采用护栏 isSourceLevelBrandLogo ═══════════════
describe('isSourceLevelBrandLogo（同源 ≥3 条共用同图 → 判品牌 logo）', () => {
  test('同 source 4 条已用同一 hash 作 cover → 第 5 条判为品牌 logo', async () => {
    const items: FakeItem[] = [1, 2, 3, 4].map((i) => ({
      id: `blog:qbitai:${i}`,
      source_type: 'blog',
      extra: { feed_key: 'qbitai', cover_image: '/r/blog/logo.png' },
    }));
    const { env } = makeEnv(items);
    const hit = await isSourceLevelBrandLogo(env, 'blog:qbitai:5', 'qbitai', '/r/blog/logo.png');
    expect(hit).toBe(true);
  });

  test('同 source 仅 2 条 → 不判（仍采用）', async () => {
    const items: FakeItem[] = [1, 2].map((i) => ({
      id: `blog:qbitai:${i}`,
      source_type: 'blog',
      extra: { feed_key: 'qbitai', cover_image: '/r/blog/logo.png' },
    }));
    const { env } = makeEnv(items);
    const hit = await isSourceLevelBrandLogo(env, 'blog:qbitai:3', 'qbitai', '/r/blog/logo.png');
    expect(hit).toBe(false);
  });

  test('不同 source 同图不合簇（各源独立计数）', async () => {
    // aiera 2 条 + openai 2 条共用同一 hash，但按 source 分别计数都 <3。
    const items: FakeItem[] = [
      { id: 'blog:aiera:1', source_type: 'blog', extra: { feed_key: 'aiera', cover_image: '/r/blog/same.jpg' } },
      { id: 'blog:aiera:2', source_type: 'blog', extra: { feed_key: 'aiera', cover_image: '/r/blog/same.jpg' } },
      { id: 'blog:openai:1', source_type: 'blog', extra: { feed_key: 'openai', cover_image: '/r/blog/same.jpg' } },
      { id: 'blog:openai:2', source_type: 'blog', extra: { feed_key: 'openai', cover_image: '/r/blog/same.jpg' } },
    ];
    const { env } = makeEnv(items);
    const hit = await isSourceLevelBrandLogo(env, 'blog:aiera:3', 'aiera', '/r/blog/same.jpg');
    expect(hit).toBe(false);
  });

  test('Verge 回归：og 每篇不同 → COUNT 恒 0 → 不误判（锁 PR #163）', async () => {
    const items: FakeItem[] = [
      { id: 'blog:the-verge:1', source_type: 'blog', extra: { feed_key: 'the-verge', cover_image: '/r/blog/heroA.jpg' } },
      { id: 'blog:the-verge:2', source_type: 'blog', extra: { feed_key: 'the-verge', cover_image: '/r/blog/heroB.jpg' } },
      { id: 'blog:the-verge:3', source_type: 'blog', extra: { feed_key: 'the-verge', cover_image: '/r/blog/heroC.jpg' } },
    ];
    const { env } = makeEnv(items);
    const hit = await isSourceLevelBrandLogo(env, 'blog:the-verge:4', 'the-verge', '/r/blog/heroD.jpg');
    expect(hit).toBe(false);
  });

  test('绝对 api 域形态 cover 也计入（coverR2Key 归一）', async () => {
    const items: FakeItem[] = [1, 2, 3].map((i) => ({
      id: `blog:jiqizhixin:${i}`,
      source_type: 'blog',
      extra: { feed_key: 'jiqizhixin', cover_image: `https://api.ai-feeds.com/r/blog/jzx.png` },
    }));
    const { env } = makeEnv(items);
    // 新条采用的是相对形态，仍应命中同一 R2 key。
    const hit = await isSourceLevelBrandLogo(env, 'blog:jiqizhixin:9', 'jiqizhixin', '/r/blog/jzx.png');
    expect(hit).toBe(true);
  });
});

// ═══════════════ 层 1：migrateMediaForBlog 集成（护栏撤销采用）═══════════════
describe('migrateMediaForBlog 采用护栏集成', () => {
  test('og logo 迁 R2 后同源 ≥3 条共用 → 撤销采用，cover 落空 + 记 cleared_hash', async () => {
    const siblings: FakeItem[] = [1, 2, 3].map((i) => ({
      id: `blog:qbitai:s${i}`,
      source_type: 'blog',
      extra: { feed_key: 'qbitai', cover_image: '/r/blog/qlogo.png' },
    }));
    const target: FakeItem = {
      id: 'blog:qbitai:new',
      source_type: 'blog',
      extra: { feed_key: 'qbitai', cover_image: 'https://qbitai.com/logo.png', body: { source: 'rss_full', extracted_at: 'x', assets: [] } },
    };
    const { env } = makeEnv([...siblings, target]);
    const res = await migrateMediaForBlog(env, 'blog:qbitai:new', {
      migrateCover: async () => '/r/blog/qlogo.png', // 迁出的 R2 key = 站点 logo
    });
    expect(res.migrated).toBe(1);
    expect(target.extra.cover_image).toBeUndefined();               // 撤销采用 → 空
    expect(target.extra.cover_generic_cleared_hash).toBe('blog/qlogo.png');
    expect(target.extra.cover_brandlogo_guarded_at).toBeTruthy();
    expect(target.extra.blog_media_r2_at).toBeTruthy();
  });

  test('同源仅 2 条共用 → 正常采用（不误伤）', async () => {
    const siblings: FakeItem[] = [1, 2].map((i) => ({
      id: `blog:small:s${i}`,
      source_type: 'blog',
      extra: { feed_key: 'small', cover_image: '/r/blog/pic.jpg' },
    }));
    const target: FakeItem = {
      id: 'blog:small:new',
      source_type: 'blog',
      extra: { feed_key: 'small', cover_image: 'https://x.com/pic.jpg', body: { source: 'rss_full', extracted_at: 'x', assets: [] } },
    };
    const { env } = makeEnv([...siblings, target]);
    await migrateMediaForBlog(env, 'blog:small:new', {
      migrateCover: async () => '/r/blog/pic.jpg',
    });
    expect(target.extra.cover_image).toBe('/r/blog/pic.jpg');
    expect(target.extra.cover_generic_cleared_hash).toBeUndefined();
    expect(target.extra.cover_brandlogo_guarded_at).toBeUndefined();
  });

  test('Verge 回归：og 唯一（无同源共用）→ 正常采用', async () => {
    const target: FakeItem = {
      id: 'blog:the-verge:new',
      source_type: 'blog',
      extra: { feed_key: 'the-verge', cover_image: 'https://platform.theverge.com/hero.jpg', body: { source: 'rss_full', extracted_at: 'x', assets: [] } },
    };
    const { env } = makeEnv([target]);
    await migrateMediaForBlog(env, 'blog:the-verge:new', {
      migrateCover: async () => '/r/blog/uniquehero.jpg',
    });
    expect(target.extra.cover_image).toBe('/r/blog/uniquehero.jpg');
    expect(target.extra.cover_brandlogo_guarded_at).toBeUndefined();
  });
});

// ═══════════════ 层 2：pickBodyHeroCover（正文 hero 选择）═══════════════
describe('pickBodyHeroCover', () => {
  test('body.assets 有合格 R2 图 → 返回第一张（过黑名单 + 尺寸门）', () => {
    const extra = {
      body: {
        assets: [
          { url: 'https://q.com/qrcode.png', r2_url: '/r/blog/qr.png', kind: 'image', role: 'inline', width: 600, height: 600 },
          { url: 'https://q.com/hero.webp', r2_url: '/r/blog/hero.webp', kind: 'image', role: 'inline', width: 1200, height: 675 },
        ],
      },
    };
    expect(pickBodyHeroCover(extra)).toBe('/r/blog/hero.webp'); // 跳过 qrcode（黑名单）
  });

  test('图荒（assets 空）→ 返回 null（jiqizhixin 场景，保持 monogram）', () => {
    expect(pickBodyHeroCover({ body: { assets: [] } })).toBeNull();
    expect(pickBodyHeroCover({})).toBeNull();
  });

  test('纯外链 asset（无 r2_url）不入选', () => {
    const extra = {
      body: { assets: [{ url: 'https://q.com/hero.webp', kind: 'image', role: 'inline', width: 1200, height: 675 }] },
    };
    expect(pickBodyHeroCover(extra)).toBeNull();
  });

  test('尺寸不达标（maxDim<240 / 比例越界）跳过', () => {
    const extra = {
      body: {
        assets: [
          { url: 'https://q.com/small.png', r2_url: '/r/blog/small.png', kind: 'image', role: 'inline', width: 120, height: 120 },
          { url: 'https://q.com/thin.png', r2_url: '/r/blog/thin.png', kind: 'image', role: 'inline', width: 1000, height: 100 },
        ],
      },
    };
    expect(pickBodyHeroCover(extra)).toBeNull();
  });

  test('排除与被清 logo 同 hash 的正文资产', () => {
    const extra = {
      body: {
        assets: [{ url: 'https://q.com/x.png', r2_url: '/r/blog/logo.png', kind: 'image', role: 'inline', width: 800, height: 600 }],
      },
    };
    expect(pickBodyHeroCover(extra, 'blog/logo.png')).toBeNull();
  });

  test('无尺寸元数据的合格 R2 图（webp 无法 probe）仍放行', () => {
    const extra = {
      body: { assets: [{ url: 'https://q.com/hero.webp', r2_url: '/r/blog/hero.webp', kind: 'image', role: 'inline' }] },
    };
    expect(pickBodyHeroCover(extra)).toBe('/r/blog/hero.webp');
  });
});

// ═══════════════ 层 2：runBlogCoverBodyHeroBackfill（差异回填）═══════════════
describe('runBlogCoverBodyHeroBackfill', () => {
  test('cover 空 + cleared_hash 置位 + 有合格 body hero → 采用 body hero', async () => {
    const items: FakeItem[] = [
      {
        id: 'blog:qbitai:1',
        source_type: 'blog',
        extra: {
          feed_key: 'qbitai',
          cover_generic_cleared_hash: 'blog/qlogo.png',
          body: { assets: [{ url: 'https://q.com/hero.webp', r2_url: '/r/blog/hero.webp', kind: 'image', role: 'inline', width: 1200, height: 675 }] },
        },
      },
    ];
    const { env } = makeEnv(items);
    const res = await runBlogCoverBodyHeroBackfill(env, { limit: 20, dry: false });
    expect(res.scanned).toBe(1);
    expect(res.adopted).toBe(1);
    expect(res.remaining).toBe(0);
    expect(items[0].extra.cover_image).toBe('/r/blog/hero.webp');
    expect(items[0].extra.cover_bodyhero_backfilled_at).toBeTruthy();
  });

  test('cover 空 + cleared_hash 置位 + 图荒 → 保持空，推游标（jiqizhixin 场景）', async () => {
    const items: FakeItem[] = [
      {
        id: 'blog:jiqizhixin:1',
        source_type: 'blog',
        extra: { feed_key: 'jiqizhixin', cover_generic_cleared_hash: 'blog/jzx.png', body: { assets: [] } },
      },
    ];
    const { env } = makeEnv(items);
    const res = await runBlogCoverBodyHeroBackfill(env, { limit: 20, dry: false });
    expect(res.adopted).toBe(0);
    expect(res.skipped).toBe(1);
    expect(items[0].extra.cover_image).toBeUndefined();
    expect(items[0].extra.cover_bodyhero_backfilled_at).toBeTruthy(); // 游标推进，不再重扫
  });

  test('dry=1 → 零写但统计命中', async () => {
    const items: FakeItem[] = [
      {
        id: 'blog:qbitai:1',
        source_type: 'blog',
        extra: {
          feed_key: 'qbitai',
          cover_generic_cleared_hash: 'blog/qlogo.png',
          body: { assets: [{ url: 'https://q.com/hero.webp', r2_url: '/r/blog/hero.webp', kind: 'image', role: 'inline', width: 1200, height: 675 }] },
        },
      },
    ];
    const { env, updates } = makeEnv(items);
    const res = await runBlogCoverBodyHeroBackfill(env, { limit: 20, dry: true });
    expect(updates.length).toBe(0);
    expect(res.adopted).toBe(1);
    expect(items[0].extra.cover_image).toBeUndefined();
    expect(items[0].extra.cover_bodyhero_backfilled_at).toBeUndefined();
  });

  test('未被清簇（无 cleared_hash）/ 已有 cover / 已打游标 → 不进批', async () => {
    const items: FakeItem[] = [
      { id: 'blog:never-swept', source_type: 'blog', extra: { feed_key: 'q', body: { assets: [{ url: 'a', r2_url: '/r/blog/a.jpg', kind: 'image', role: 'inline', width: 800, height: 600 }] } } },
      { id: 'blog:has-cover', source_type: 'blog', extra: { feed_key: 'q', cover_image: '/r/blog/x.jpg', cover_generic_cleared_hash: 'blog/y.jpg' } },
      { id: 'blog:done', source_type: 'blog', extra: { feed_key: 'q', cover_generic_cleared_hash: 'blog/y.jpg', cover_bodyhero_backfilled_at: 'done' } },
    ];
    const { env } = makeEnv(items);
    const res = await runBlogCoverBodyHeroBackfill(env, { limit: 20, dry: false });
    expect(res.scanned).toBe(0);
  });
});
