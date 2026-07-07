import { describe, test, expect } from 'vitest';
import {
  isSourceLevelBrandLogo,
  migrateMediaForBlog,
  pickBodyHeroCover,
  runBlogCoverBodyHeroBackfill,
} from './media-r2';
import { isNoCoverSource } from './cover-heuristics';
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

// bodyhero-backfill 谓词：blog + cover 空 + 被清簇（cleared_hash 置位）+ 未打 bodyhero 游标
// + 非 no-cover 源（Fix B：noCoverSourcesSqlExclusion 把 jiqizhixin 等排除出批）。
function bodyHeroActionable(it: FakeItem): boolean {
  return (
    it.source_type === 'blog' &&
    coverOf(it) === '' &&
    it.extra.cover_generic_cleared_hash != null &&
    it.extra.cover_bodyhero_backfilled_at == null &&
    !isNoCoverSource(srcOf(it))
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
          // 采用护栏聚合（Fix 2 后一次查两计数）：
          //   SUM(cover LIKE ?) AS n, SUM(cleared_hash = ?) AS cleared
          //   ... id != ? AND <src>=?   binds=[likePattern, r2Key, itemId, srcVal]
          if (/AS cleared/i.test(sql)) {
            const like = String(bound[0]); // '%/r/<key>'
            const clearedKey = String(bound[1]); // 归一 R2 key
            const excludeId = String(bound[2]);
            const src = String(bound[3]);
            const suffix = like.startsWith('%') ? like.slice(1) : like;
            const same = items.filter(
              (it) =>
                it.source_type === 'blog' &&
                it.id !== excludeId &&
                srcOf(it) === src,
            );
            const n = same.filter((it) => coverOf(it).endsWith(suffix)).length;
            const cleared = same.filter(
              (it) => String(it.extra.cover_generic_cleared_hash || '') === clearedKey,
            ).length;
            return { n, cleared } as unknown as T;
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

  // ── Fix 2（Important 2）：持久化 logo hash 拒绝，关掉清簇后的再泄漏窗口 ──
  test('持久拒绝：源曾清过该 logo hash（cover_generic_cleared_hash）→ 即便 live COUNT<3 仍判 logo', async () => {
    const items: FakeItem[] = [
      // 曾被清的一篇：cover 已空，但 cleared_hash 记录了这张站点 logo
      { id: 'blog:qbitai:cleared', source_type: 'blog', extra: { feed_key: 'qbitai', cover_generic_cleared_hash: 'blog/qlogo.png' } },
      // 清簇后又冒出的第 1 篇仍用 logo（live COUNT 仅 1，不足 3）
      { id: 'blog:qbitai:1', source_type: 'blog', extra: { feed_key: 'qbitai', cover_image: '/r/blog/qlogo.png' } },
    ];
    const { env } = makeEnv(items);
    const hit = await isSourceLevelBrandLogo(env, 'blog:qbitai:new', 'qbitai', '/r/blog/qlogo.png');
    expect(hit).toBe(true); // cleared 集合命中，不再等第 3 篇自愈
  });

  test('新源从未清过 + COUNT<3 → 不误伤（正常采用）', async () => {
    const items: FakeItem[] = [
      { id: 'blog:newsrc:1', source_type: 'blog', extra: { feed_key: 'newsrc', cover_image: '/r/blog/pic.jpg' } },
      { id: 'blog:newsrc:2', source_type: 'blog', extra: { feed_key: 'newsrc', cover_image: '/r/blog/pic.jpg' } },
    ];
    const { env } = makeEnv(items);
    const hit = await isSourceLevelBrandLogo(env, 'blog:newsrc:3', 'newsrc', '/r/blog/pic.jpg');
    expect(hit).toBe(false); // COUNT=2 且无 cleared 记录 → 不判
  });

  test('cleared_hash 是别的 hash（非本 og）→ 不误判', async () => {
    const items: FakeItem[] = [
      { id: 'blog:qbitai:cleared', source_type: 'blog', extra: { feed_key: 'qbitai', cover_generic_cleared_hash: 'blog/other.png' } },
    ];
    const { env } = makeEnv(items);
    const hit = await isSourceLevelBrandLogo(env, 'blog:qbitai:new', 'qbitai', '/r/blog/qlogo.png');
    expect(hit).toBe(false); // 归一 key 不同 → 不命中持久拒绝集合
  });
});

// ═══════════════ 层 1/2：migrateMediaForBlog 统计护栏集成（护栏撤销采用）═══════════════
// 注：本组 target 的 og url 一律用**不含关键词**的干净 url（如 post-cover.png），以便越过 Fix A
// 的层 0 关键词黑名单、真正命中层 1/2 的统计簇 / 持久 hash 护栏（迁出的 R2 key 才是 qlogo.png）。
// 生产中 qbitai 的 og 文件名字面含 'logo' → 恒被层 0 拦（见下方 Fix A 组），到不了这里；本组
// 模拟「og 文件名不含关键词、但同一图被 ≥3 篇复用」的另一类源，锁统计护栏不回归。
describe('migrateMediaForBlog 采用护栏集成', () => {
  test('og 迁 R2 后同源 ≥3 条共用同一 hash → 撤销采用，cover 落空 + 记 cleared_hash', async () => {
    const siblings: FakeItem[] = [1, 2, 3].map((i) => ({
      id: `blog:qbitai:s${i}`,
      source_type: 'blog',
      extra: { feed_key: 'qbitai', cover_image: '/r/blog/qlogo.png' },
    }));
    const target: FakeItem = {
      id: 'blog:qbitai:new',
      source_type: 'blog',
      extra: { feed_key: 'qbitai', cover_image: 'https://qbitai.com/2026/07/post-cover.png', body: { source: 'rss_full', extracted_at: 'x', assets: [] } },
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

  // ── Fix 1（Important 1）：护栏命中后 live 就地从正文 assets 回落 hero ──
  test('护栏命中 + 正文有合格 R2 hero → live 就地采用 body hero（不等 backfill）', async () => {
    const siblings: FakeItem[] = [1, 2, 3].map((i) => ({
      id: `blog:qbitai:s${i}`,
      source_type: 'blog',
      extra: { feed_key: 'qbitai', cover_image: '/r/blog/qlogo.png' },
    }));
    const target: FakeItem = {
      id: 'blog:qbitai:new',
      source_type: 'blog',
      extra: {
        feed_key: 'qbitai',
        cover_image: 'https://qbitai.com/2026/07/post-cover.png',
        body: {
          source: 'rss_full',
          extracted_at: 'x',
          assets: [
            // 已迁 R2 的正文合格配图（url 为 /r/ 形态 → 迁移循环幂等跳过，测试不触发真 fetch）
            { url: '/r/blog/hero.webp', r2_url: '/r/blog/hero.webp', kind: 'image', role: 'inline', width: 1200, height: 675 },
          ],
        },
      },
    };
    const { env } = makeEnv([...siblings, target]);
    await migrateMediaForBlog(env, 'blog:qbitai:new', {
      migrateCover: async () => '/r/blog/qlogo.png', // og 迁出 = 站点 logo
    });
    expect(target.extra.cover_image).toBe('/r/blog/hero.webp');            // 就地回落正文 hero
    expect(target.extra.cover_generic_cleared_hash).toBe('blog/qlogo.png'); // 仍记 logo hash（供持久拒绝 + Fix C）
    expect(target.extra.cover_brandlogo_guarded_at).toBeTruthy();
  });

  test('护栏命中 + 正文只有黑名单/不合格图 → 清空走 monogram', async () => {
    const siblings: FakeItem[] = [1, 2, 3].map((i) => ({
      id: `blog:qbitai:s${i}`,
      source_type: 'blog',
      extra: { feed_key: 'qbitai', cover_image: '/r/blog/qlogo.png' },
    }));
    const target: FakeItem = {
      id: 'blog:qbitai:new',
      source_type: 'blog',
      extra: {
        feed_key: 'qbitai',
        cover_image: 'https://qbitai.com/2026/07/post-cover.png',
        body: {
          source: 'rss_full',
          extracted_at: 'x',
          assets: [
            { url: '/r/blog/qrcode.png', r2_url: '/r/blog/qrcode.png', kind: 'image', role: 'inline', width: 600, height: 600 },
          ],
        },
      },
    };
    const { env } = makeEnv([...siblings, target]);
    await migrateMediaForBlog(env, 'blog:qbitai:new', {
      migrateCover: async () => '/r/blog/qlogo.png',
    });
    expect(target.extra.cover_image).toBeUndefined();                      // 无合格 hero → 空 → monogram
    expect(target.extra.cover_generic_cleared_hash).toBe('blog/qlogo.png');
    expect(target.extra.cover_brandlogo_guarded_at).toBeTruthy();
  });

  test('持久拒绝集成：同源曾清过该 logo hash → 新文 og 同 hash 即撤销（live COUNT 仅 1）', async () => {
    const cleared: FakeItem = {
      id: 'blog:qbitai:cleared',
      source_type: 'blog',
      extra: { feed_key: 'qbitai', cover_generic_cleared_hash: 'blog/qlogo.png' },
    };
    const target: FakeItem = {
      id: 'blog:qbitai:new2',
      source_type: 'blog',
      extra: { feed_key: 'qbitai', cover_image: 'https://qbitai.com/2026/07/post-cover.png', body: { source: 'rss_full', extracted_at: 'x', assets: [] } },
    };
    const { env } = makeEnv([cleared, target]);
    await migrateMediaForBlog(env, 'blog:qbitai:new2', {
      migrateCover: async () => '/r/blog/qlogo.png',
    });
    expect(target.extra.cover_image).toBeUndefined();                      // 持久拒绝命中 → 撤销采用
    expect(target.extra.cover_brandlogo_guarded_at).toBeTruthy();
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

  // 用 aiera 代表「被清簇后图荒」的普通源（jiqizhixin 现已被 Fix B no-cover 谓词整体排除，
  // 见下方 Fix B 专项测试；此处锁的是「非 no-cover 源图荒时保持空 + 推游标」的通用回落行为）。
  test('cover 空 + cleared_hash 置位 + 图荒 → 保持空，推游标（普通源场景）', async () => {
    const items: FakeItem[] = [
      {
        id: 'blog:aiera:1',
        source_type: 'blog',
        extra: { feed_key: 'aiera', cover_generic_cleared_hash: 'blog/generic.png', body: { assets: [] } },
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

  // ── Fix B：no-cover 源（jiqizhixin）排除出 bodyhero-backfill 批 ──
  test('jiqizhixin（no-cover 源）即便有合格 body hero → 不进批、不采用', async () => {
    const items: FakeItem[] = [
      {
        id: 'blog:jiqizhixin:1',
        source_type: 'blog',
        extra: {
          feed_key: 'jiqizhixin',
          cover_generic_cleared_hash: 'blog/jzx.png',
          body: { assets: [{ url: 'https://j.com/hero.webp', r2_url: '/r/blog/hero.webp', kind: 'image', role: 'inline', width: 1200, height: 675 }] },
        },
      },
      // qbitai 同形态对照：不在 no-cover 名单 → 正常进批采用 body hero
      {
        id: 'blog:qbitai:1',
        source_type: 'blog',
        extra: {
          feed_key: 'qbitai',
          cover_generic_cleared_hash: 'blog/qlogo.png',
          body: { assets: [{ url: 'https://q.com/hero.webp', r2_url: '/r/blog/qhero.webp', kind: 'image', role: 'inline', width: 1200, height: 675 }] },
        },
      },
    ];
    const { env } = makeEnv(items);
    const res = await runBlogCoverBodyHeroBackfill(env, { limit: 20, dry: false });
    expect(res.scanned).toBe(1);                                  // 只扫到 qbitai，jiqizhixin 被谓词排除
    expect(res.adopted).toBe(1);
    expect(items[0].extra.cover_image).toBeUndefined();           // jiqizhixin 恒空
    expect(items[0].extra.cover_bodyhero_backfilled_at).toBeUndefined(); // 未处理
    expect(items[1].extra.cover_image).toBe('/r/blog/qhero.webp'); // qbitai 正常采用
  });
});

// ═══════════════ Fix A：采用路径层 0 关键词黑名单（原始 og URL）═══════════════
// og:image 被采用为封面**之前**（迁移前，原始 URL 关键词信息还在）对原始 og URL 跑 COVER_BLACKLIST，
// 命中即不迁 R2、不采用，改走正文 hero / monogram。三层防御最早的一层，闭合统计护栏「新源前 2 篇泄漏」窗口。
describe('migrateMediaForBlog 层 0 关键词黑名单（Fix A）', () => {
  test("og URL 含 'logo'（qbitai-logo-1.png 形态）+ 正文有真 hero → 不迁 og、就地回落正文 hero", async () => {
    let migrateCoverCalls = 0;
    const target: FakeItem = {
      id: 'blog:qbitai:kw1',
      source_type: 'blog',
      extra: {
        feed_key: 'qbitai',
        cover_image: 'https://www.qbitai.com/wp-content/uploads/imgs/qbitai-logo-1.png',
        body: {
          source: 'rss_full',
          extracted_at: 'x',
          assets: [
            { url: '/r/blog/hero.webp', r2_url: '/r/blog/hero.webp', kind: 'image', role: 'inline', width: 1280, height: 680 },
          ],
        },
      },
    };
    const { env } = makeEnv([target]);
    await migrateMediaForBlog(env, 'blog:qbitai:kw1', {
      migrateCover: async () => {
        migrateCoverCalls++;
        return '/r/blog/should-not-happen.png';
      },
    });
    expect(migrateCoverCalls).toBe(0);                             // og 不迁 R2（省得白迁 logo）
    expect(target.extra.cover_image).toBe('/r/blog/hero.webp');   // 就地回落正文 hero
    expect(target.extra.cover_keyword_blacklisted_at).toBeTruthy();
    expect(target.extra.cover_brandlogo_guarded_at).toBeUndefined(); // 未走统计护栏（层 0 先拦）
    expect(target.extra.cover_generic_cleared_hash).toBeUndefined();
  });

  test("og URL 含 'logo' + 正文图荒 → cover 清空走 monogram", async () => {
    let migrateCoverCalls = 0;
    const target: FakeItem = {
      id: 'blog:qbitai:kw2',
      source_type: 'blog',
      extra: {
        feed_key: 'qbitai',
        cover_image: 'https://www.qbitai.com/wp-content/uploads/imgs/qbitai-logo-1.png',
        body: { source: 'rss_full', extracted_at: 'x', assets: [] },
      },
    };
    const { env } = makeEnv([target]);
    await migrateMediaForBlog(env, 'blog:qbitai:kw2', {
      migrateCover: async () => { migrateCoverCalls++; return '/r/blog/x.png'; },
    });
    expect(migrateCoverCalls).toBe(0);
    expect(target.extra.cover_image).toBeUndefined();             // 清空 → monogram
    expect(target.extra.cover_keyword_blacklisted_at).toBeTruthy();
  });

  test("og URL 含 'qrcode' → 同拦（不迁、走 monogram）", async () => {
    let migrateCoverCalls = 0;
    const target: FakeItem = {
      id: 'blog:src:kw3',
      source_type: 'blog',
      extra: {
        feed_key: 'somesrc',
        cover_image: 'https://s.com/footer_qrcode_QbitAI_1.jpg',
        body: { source: 'rss_full', extracted_at: 'x', assets: [] },
      },
    };
    const { env } = makeEnv([target]);
    await migrateMediaForBlog(env, 'blog:src:kw3', {
      migrateCover: async () => { migrateCoverCalls++; return '/r/blog/x.png'; },
    });
    expect(migrateCoverCalls).toBe(0);
    expect(target.extra.cover_image).toBeUndefined();
    expect(target.extra.cover_keyword_blacklisted_at).toBeTruthy();
  });

  test("og URL 含 'avatar' → 同拦", async () => {
    let migrateCoverCalls = 0;
    const target: FakeItem = {
      id: 'blog:src:kw4',
      source_type: 'blog',
      extra: {
        feed_key: 'somesrc',
        cover_image: 'https://s.com/author-avatar-2x.png',
        body: { source: 'rss_full', extracted_at: 'x', assets: [] },
      },
    };
    const { env } = makeEnv([target]);
    await migrateMediaForBlog(env, 'blog:src:kw4', {
      migrateCover: async () => { migrateCoverCalls++; return '/r/blog/x.png'; },
    });
    expect(migrateCoverCalls).toBe(0);
    expect(target.extra.cover_keyword_blacklisted_at).toBeTruthy();
  });

  // ── 回归锁：干净 og（Verge 真 hero）→ 层 0 放行、正常采用 ──
  test('回归锁：og URL 干净（Verge 真 hero）→ 正常迁移采用，无关键词 marker', async () => {
    let migrateCoverCalls = 0;
    const target: FakeItem = {
      id: 'blog:the-verge:kw',
      source_type: 'blog',
      extra: {
        feed_key: 'the-verge',
        cover_image: 'https://platform.theverge.com/wp-content/uploads/sites/2/2026/07/hero.jpg',
        body: { source: 'rss_full', extracted_at: 'x', assets: [] },
      },
    };
    const { env } = makeEnv([target]);
    const res = await migrateMediaForBlog(env, 'blog:the-verge:kw', {
      migrateCover: async () => { migrateCoverCalls++; return '/r/blog/uniquehero.jpg'; },
    });
    expect(migrateCoverCalls).toBe(1);                            // 干净 og → 正常迁移
    expect(res.migrated).toBe(1);
    expect(target.extra.cover_image).toBe('/r/blog/uniquehero.jpg');
    expect(target.extra.cover_keyword_blacklisted_at).toBeUndefined();
    expect(target.extra.cover_brandlogo_guarded_at).toBeUndefined();
  });
});

// ═══════════════ Fix B：源级 no-cover 名单（jiqizhixin）═══════════════
// 名单内源一律不采用任何封面：og 不采、正文 hero 不回退、cover_image 恒空走 monogram。
describe('migrateMediaForBlog 源级 no-cover（Fix B）', () => {
  test('jiqizhixin 有 og + 正文有图 → cover 仍恒空（og 不采、正文 hero 不回退）', async () => {
    let migrateCoverCalls = 0;
    const target: FakeItem = {
      id: 'blog:jiqizhixin:nc1',
      source_type: 'blog',
      extra: {
        feed_key: 'jiqizhixin',
        cover_image: 'https://image.jiqizhixin.com/uploads/og-brand.png',
        body: {
          source: 'rss_full',
          extracted_at: 'x',
          assets: [
            // 即便正文有合格 R2 图，no-cover 源也不回落作封面
            { url: '/r/blog/jzx-inline.webp', r2_url: '/r/blog/jzx-inline.webp', kind: 'image', role: 'inline', width: 1200, height: 675 },
          ],
        },
      },
    };
    const { env } = makeEnv([target]);
    await migrateMediaForBlog(env, 'blog:jiqizhixin:nc1', {
      migrateCover: async () => { migrateCoverCalls++; return '/r/blog/jzx-og.png'; },
    });
    expect(migrateCoverCalls).toBe(0);                            // og 不迁、不采
    expect(target.extra.cover_image).toBeUndefined();            // cover 恒空
    expect(target.extra.cover_nocover_source_at).toBeTruthy();
    expect(target.extra.cover_brandlogo_guarded_at).toBeUndefined();
    expect(target.extra.cover_keyword_blacklisted_at).toBeUndefined();
  });

  test('qbitai 不在 no-cover 名单 → 正常走护栏路径（统计簇撤销采用）', async () => {
    const siblings: FakeItem[] = [1, 2, 3].map((i) => ({
      id: `blog:qbitai:s${i}`,
      source_type: 'blog',
      extra: { feed_key: 'qbitai', cover_image: '/r/blog/qlogo.png' },
    }));
    const target: FakeItem = {
      id: 'blog:qbitai:nc',
      source_type: 'blog',
      // og 干净（越过层 0），靠统计簇（层 1）撤销 → 证明 qbitai 未被 no-cover 短路
      extra: { feed_key: 'qbitai', cover_image: 'https://qbitai.com/2026/07/post-cover.png', body: { source: 'rss_full', extracted_at: 'x', assets: [] } },
    };
    const { env } = makeEnv([...siblings, target]);
    await migrateMediaForBlog(env, 'blog:qbitai:nc', {
      migrateCover: async () => '/r/blog/qlogo.png',
    });
    expect(target.extra.cover_generic_cleared_hash).toBe('blog/qlogo.png'); // 走了统计护栏
    expect(target.extra.cover_brandlogo_guarded_at).toBeTruthy();
    expect(target.extra.cover_nocover_source_at).toBeUndefined();           // 非 no-cover 路径
  });
});
