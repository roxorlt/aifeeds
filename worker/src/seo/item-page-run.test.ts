import { describe, test, expect, vi, afterEach } from 'vitest';

import {
  generateItemPage,
  markItemPageGone,
  backfillItemPages,
} from './item-page-run';
import { syncItemPageOnEnrichDone } from './item-page-hook';
import { itemPageR2Key, itemPagePath } from '../digest/render';
import type { Env } from '../index';
import { isCnSensitive } from './item-page-policy';

const SITE = 'https://ai-feeds.com';
const API = 'https://api.ai-feeds.com';
const sensitiveExtra = JSON.stringify({
  cn_sensitive: 1,
  workflow_completed_at: '2026-07-20T00:00:00Z',
});

// ── 有状态 D1 mock：items（数组）+ item_pages（Map，存在性即回填游标）──
// 覆盖 5 类 SQL：fetchItemRow(SELECT * WHERE id=?)、related(id != ?)、backfill 选取(NOT EXISTS .all)、
// backfill 计数(COUNT .first)、item_pages upsert/gone(.run)。
interface ItemSeed {
  id: string;
  source_type: string;
  is_relevant?: number;
  deleted_at?: string | null;
  published_at?: string | null;
  scraped_at?: string | null;
  title?: string | null;
  content?: string | null;
  content_translated?: string | null;
  author?: string | null;
  handle?: string | null;
  url?: string | null;
  media?: string | null;
  extra?: string | null;
}
interface PageRow {
  item_id: string;
  source: string;
  url_path: string;
  generated_at: string;
  status: string;
}

function fullRow(s: ItemSeed): Record<string, unknown> {
  return {
    id: s.id,
    source_type: s.source_type,
    is_relevant: s.is_relevant ?? 1,
    deleted_at: s.deleted_at ?? null,
    published_at:
      Object.prototype.hasOwnProperty.call(s, 'published_at')
        ? s.published_at
        : '2026-07-01T00:00:00Z',
    scraped_at: s.scraped_at ?? '2026-07-01T00:00:00Z',
    title: s.title ?? `标题 ${s.id}`,
    content: s.content ?? `body ${s.id}`,
    content_translated: s.content_translated ?? `正文 ${s.id}`,
    author: s.author ?? '作者',
    handle: s.handle ?? '@u',
    url: s.url ?? `https://example.com/${encodeURIComponent(s.id)}`,
    media: s.media ?? null,
    extra: s.extra ?? JSON.stringify({ ai_summary: '摘要', title_zh: '中文标题', ai_summary_zh: '新闻摘要', summary_zh: '论文摘要' }),
  };
}

function makeDb(seed: ItemSeed[] = []) {
  const items = seed.map(fullRow);
  const pages = new Map<string, PageRow>();
  const runs: Array<{ sql: string; binds: unknown[] }> = [];

  // extra.dedup_of 非空 → dedup 次源，模拟共享 policy SQL 的排除口径。
  const isDeduped = (r: Record<string, unknown>): boolean => {
    try {
      const d = r.extra ? (JSON.parse(String(r.extra)) as { dedup_of?: unknown }).dedup_of : null;
      return d != null && d !== '';
    } catch {
      return false;
    }
  };

  const isSensitive = (r: Record<string, unknown>): boolean => {
    try {
      return r.extra
        ? (JSON.parse(String(r.extra)) as { cn_sensitive?: unknown }).cn_sensitive === 1
        : false;
    } catch {
      return false;
    }
  };

  // 非 force：候选 = relevant 非 dedup 且尚未生成（存在性游标）。
  // force（传 cutoff）：候选 = relevant 非 dedup 且「无本轮已重灌页」——即无页 OR 页 generated_at < cutoff。
  //   重灌把 generated_at 推到 >= cutoff → 该行退出候选（cutoff 全程固定 → 单调收敛）。
  const pendingFor = (
    sts: string[],
    cutoff?: string,
    excludeSensitive = false,
  ): Array<Record<string, unknown>> =>
    items
      .filter((r) => {
        if (!sts.includes(String(r.source_type))) return false;
        if (Number(r.is_relevant) !== 1) return false;
        if (isDeduped(r)) return false;
        if (excludeSensitive && isSensitive(r)) return false;
        const p = pages.get(String(r.id));
        if (cutoff == null) return !p; // 非 force：未生成才是候选
        return !p || String(p.generated_at) < cutoff; // force：无页 OR 页早于本轮 cutoff
      })
      .sort((a, b) => effectiveTime(b).localeCompare(effectiveTime(a)));

  const effectiveTime = (r: Record<string, unknown>): string =>
    String(r.published_at || r.scraped_at || '');

  const complianceViolations = (): Array<Record<string, unknown>> =>
    items
      .filter((r) => {
        const page = pages.get(String(r.id));
        return (
          page?.status === 'live' &&
          (isSensitive(r) ||
            Number(r.is_relevant) !== 1 ||
            r.deleted_at != null ||
            isDeduped(r))
        );
      })
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const db = {
    _items: items,
    _pages: pages,
    _runs: runs,
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) {
          binds = a;
          return stmt;
        },
        async first<T>() {
          if (/SELECT \* FROM items WHERE id = \?/i.test(sql)) {
            const row = items.find((r) => String(r.id) === String(binds[0]));
            return (row ?? null) as T | null;
          }
          if (/SELECT status FROM item_pages WHERE item_id = \?/i.test(sql)) {
            // generateItemPage 的「转入 live」现状预查：返回该行 {status} 或 null（无行）。
            // hook 判据 becameLive = 无行 OR status!='live'（gone 复活）。
            const p = pages.get(String(binds[0]));
            return (p ? { status: p.status } : null) as T | null;
          }
          if (/COUNT\(\*\)/i.test(sql)) {
            if (/JOIN items i ON i\.id = p\.item_id/i.test(sql)) {
              const violations = complianceViolations();
              const n = /LIMIT \?/i.test(sql)
                ? violations.slice(0, Number(binds[0])).length
                : violations.length;
              return { n } as T;
            }
            if (/generated_at >= \?/i.test(sql)) {
              // force 计数：binds = [...sts, cutoff]
              const cutoff = String(binds[binds.length - 1]);
              const sts = binds.slice(0, binds.length - 1).map(String);
              return { n: pendingFor(sts, cutoff, /cn_sensitive/i.test(sql)).length } as T;
            }
            const sts = binds.map(String);
            return { n: pendingFor(sts, undefined, /cn_sensitive/i.test(sql)).length } as T;
          }
          return null as T | null;
        },
        async all<T>() {
          if (/JOIN item_pages p ON p\.item_id = i\.id/i.test(sql) && /LIMIT 3/i.test(sql)) {
            // 稳定时间邻居：binds = [...sourceTypes, publishedAt, publishedAt, mainId]。
            const mainId = String(binds[binds.length - 1]);
            const publishedAt = String(binds[binds.length - 2]);
            const sts = binds.slice(0, binds.length - 3).map(String);
            const isNewer = />\s*\?/i.test(sql);
            const res = items
              .filter(
                (r) =>
                  sts.includes(String(r.source_type)) &&
                  String(r.id) !== mainId &&
                  Number(r.is_relevant) === 1 &&
                  !isDeduped(r) &&
                  (!/cn_sensitive/i.test(sql) || !isSensitive(r)) &&
                  pages.get(String(r.id))?.status === 'live' &&
                  (isNewer
                    ? effectiveTime(r) > publishedAt ||
                      (effectiveTime(r) === publishedAt && String(r.id) > mainId)
                    : effectiveTime(r) < publishedAt ||
                      (effectiveTime(r) === publishedAt && String(r.id) < mainId)),
              )
              .sort((a, b) => {
                const byTime = effectiveTime(a).localeCompare(effectiveTime(b));
                const byId = String(a.id).localeCompare(String(b.id));
                return isNewer ? byTime || byId : -(byTime || byId);
              })
              .slice(0, 3);
            return { results: res as unknown as T[] };
          }
          if (/generated_at >= \?/i.test(sql)) {
            // force 选取：binds = [...sourceTypes, cutoff, limit]
            const limit = Number(binds[binds.length - 1]);
            const cutoff = String(binds[binds.length - 2]);
            const sts = binds.slice(0, binds.length - 2).map(String);
            const res = pendingFor(sts, cutoff, /cn_sensitive/i.test(sql))
              .slice(0, limit)
              .map((r) => ({ id: r.id }));
            return { results: res as unknown as T[] };
          }
          if (/NOT EXISTS/i.test(sql)) {
            // backfill 选取（非 force）：binds = [...sourceTypes, limit]
            const limit = Number(binds[binds.length - 1]);
            const sts = binds.slice(0, binds.length - 1).map(String);
            const res = pendingFor(sts, undefined, /cn_sensitive/i.test(sql))
              .slice(0, limit)
              .map((r) => ({ id: r.id }));
            return { results: res as unknown as T[] };
          }
          return { results: [] as T[] };
        },
        async run() {
          runs.push({ sql, binds });
          let changes = 0;
          if (/INSERT INTO item_pages/i.test(sql)) {
            const [item_id, source, url_path, generated_at] = binds as [string, string, string, string];
            pages.set(item_id, { item_id, source, url_path, generated_at, status: 'live' });
            changes = 1;
          } else if (/UPDATE\s+item_pages\s+SET\s+status\s*=\s*'gone'/i.test(sql)) {
            if (/SELECT p\.item_id/i.test(sql)) {
              const limit = Number(binds[0]);
              for (const row of complianceViolations().slice(0, limit)) {
                const page = pages.get(String(row.id));
                if (page?.status === 'live') {
                  page.status = 'gone';
                  changes++;
                }
              }
            } else {
              const page = pages.get(String(binds[0]));
              if (page) {
                page.status = 'gone';
                changes = 1;
              }
            }
          }
          return { success: true, meta: { changes } };
        },
      };
      return stmt;
    },
  };
  return db;
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

const insertRuns = (db: ReturnType<typeof makeDb>): number =>
  db._runs.filter((r) => /INSERT INTO item_pages/i.test(r.sql)).length;

// 预置一条存量 item_pages 行（模拟 prod 已生成的页），带指定 generated_at 与 status（默认 live）。
// status='gone' 用于模拟「此前判不相关下架」→ 后续复活场景。
const seedPage = (
  db: ReturnType<typeof makeDb>,
  id: string,
  source: string,
  generated_at: string,
  status = 'live',
): void => {
  db._pages.set(id, { item_id: id, source, url_path: itemPagePath(id) ?? `/i/${id}`, generated_at, status });
};

describe('isCnSensitive', () => {
  test('只把数值 1 判为敏感；null、缺字段、malformed JSON 均 fail-safe 为 false', () => {
    expect(isCnSensitive(sensitiveExtra)).toBe(true);
    expect(isCnSensitive(JSON.stringify({ cn_sensitive: 0 }))).toBe(false);
    expect(isCnSensitive(JSON.stringify({ cn_sensitive: '1' }))).toBe(false);
    expect(isCnSensitive('{}')).toBe(false);
    expect(isCnSensitive('{malformed')).toBe(false);
    expect(isCnSensitive(null)).toBe(false);
    expect(isCnSensitive(undefined)).toBe(false);
  });
});

describe('generateItemPage', () => {
  test('is_relevant=1 + cn_sensitive=1 → skipped(cn-sensitive) 且 R2/D1 零写', async () => {
    const id = 'blog:sensitive';
    const db = makeDb([{ id, source_type: 'blog', is_relevant: 1, extra: sensitiveExtra }]);
    const r2 = makeR2();

    const res = await generateItemPage(makeEnv(db, r2), id);

    expect(res).toEqual({ itemId: id, skipped: true, reason: 'cn-sensitive' });
    expect(r2.puts).toEqual([]);
    expect(insertRuns(db)).toBe(0);
  });

  test('is_relevant=1 → R2 put(key=itemPageR2Key) + item_pages upsert(live, url_path)', async () => {
    const id = 'x_list:123';
    const db = makeDb([{ id, source_type: 'x_list', is_relevant: 1 }]);
    const r2 = makeR2();
    const res = await generateItemPage(makeEnv(db, r2), id);
    expect(res.skipped).toBe(false);
    // R2 key 必须 == itemPageR2Key(id)（与 Task 3 伺服读对齐）
    const key = itemPageR2Key(id)!;
    expect(r2.puts).toEqual([key]);
    expect(r2.store.has(key)).toBe(true);
    // item_pages upsert：source=DigestSource 口径 'x'，url_path=itemPagePath，status=live
    const page = db._pages.get(id)!;
    expect(page.source).toBe('x');
    expect(page.url_path).toBe(itemPagePath(id));
    expect(page.status).toBe('live');
    expect(page.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('各源 R2 key 均 == itemPageR2Key（gh/ph/hf/news 对齐伺服）', async () => {
    const cases = [
      { id: 'github:acme/tool', st: 'github', src: 'gh' },
      { id: 'product_hunt:coolslug:2026-07-08', st: 'product_hunt', src: 'ph' },
      { id: 'hf_paper:2501.12345', st: 'hf_paper', src: 'hf-paper' },
      { id: 'blog:abc123', st: 'blog', src: 'news' },
      { id: 'podcast:xyz789', st: 'podcast', src: 'news' },
    ];
    for (const c of cases) {
      const db = makeDb([{ id: c.id, source_type: c.st, is_relevant: 1 }]);
      const r2 = makeR2();
      const res = await generateItemPage(makeEnv(db, r2), c.id);
      expect(res.skipped).toBe(false);
      expect(r2.puts).toEqual([itemPageR2Key(c.id)!]);
      expect(db._pages.get(c.id)!.source).toBe(c.src);
      expect(db._pages.get(c.id)!.url_path).toBe(itemPagePath(c.id));
    }
  });

  test('is_relevant=0 → skipped 零写', async () => {
    const id = 'x_list:8';
    const db = makeDb([{ id, source_type: 'x_list', is_relevant: 0 }]);
    const r2 = makeR2();
    const res = await generateItemPage(makeEnv(db, r2), id);
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('not-relevant');
    expect(r2.puts.length).toBe(0);
    expect(insertRuns(db)).toBe(0);
  });

  test('clawhub（源∉五源）→ skipped 零写', async () => {
    const id = 'clawhub:some-skill';
    const db = makeDb([{ id, source_type: 'clawhub', is_relevant: 1 }]);
    const r2 = makeR2();
    const res = await generateItemPage(makeEnv(db, r2), id);
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('unsupported-source');
    expect(r2.puts.length).toBe(0);
    expect(insertRuns(db)).toBe(0);
    // 契约自证：itemPageR2Key 对 clawhub 返回 null（与生成层 gate 同源）
    expect(itemPageR2Key(id)).toBeNull();
  });

  test('dedup 次源（is_relevant=1 + extra.dedup_of 非空）→ skipped(dedup-suppressed) 零写 R2/D1', async () => {
    const id = 'x_list:dup';
    const db = makeDb([
      { id, source_type: 'x_list', is_relevant: 1, extra: JSON.stringify({ dedup_of: 'x_list:incumbent' }) },
    ]);
    const r2 = makeR2();
    const res = await generateItemPage(makeEnv(db, r2), id);
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('dedup-suppressed');
    expect(r2.puts.length).toBe(0);
    expect(insertRuns(db)).toBe(0);
  });

  test('正常项（extra.dedup_of 为 null / 缺失）→ 照常生成', async () => {
    const nullDup = 'x_list:a';
    const noKey = 'x_list:b';
    const db = makeDb([
      { id: nullDup, source_type: 'x_list', is_relevant: 1, extra: JSON.stringify({ dedup_of: null }) },
      { id: noKey, source_type: 'x_list', is_relevant: 1, extra: JSON.stringify({ ai_summary: '摘要' }) },
    ]);
    const r2 = makeR2();
    expect((await generateItemPage(makeEnv(db, r2), nullDup)).skipped).toBe(false);
    expect((await generateItemPage(makeEnv(db, r2), noKey)).skipped).toBe(false);
    expect(db._pages.has(nullDup)).toBe(true);
    expect(db._pages.has(noKey)).toBe(true);
  });

  test('id 无对应 item → skipped(not-found) 零写', async () => {
    const db = makeDb([]);
    const r2 = makeR2();
    const res = await generateItemPage(makeEnv(db, r2), 'x_list:404');
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('not-found');
    expect(r2.puts.length).toBe(0);
    expect(insertRuns(db)).toBe(0);
  });

  test('同 id 二次生成不新增 item_pages 行（幂等 upsert）', async () => {
    const id = 'x_list:1';
    const db = makeDb([{ id, source_type: 'x_list', is_relevant: 1 }]);
    const r2 = makeR2();
    const env = makeEnv(db, r2);
    await generateItemPage(env, id);
    await generateItemPage(env, id);
    expect(db._pages.size).toBe(1); // upsert 覆盖，不新增行
    expect(insertRuns(db)).toBe(2); // 两次都执行 UPSERT
    expect(r2.puts.length).toBe(2); // R2 覆盖同 key
    expect(r2.store.size).toBe(1);
  });

  test('dry:true → skipped:false 但零写（不调 R2/D1 写）', async () => {
    const id = 'x_list:1';
    const db = makeDb([{ id, source_type: 'x_list', is_relevant: 1 }]);
    const r2 = makeR2();
    const res = await generateItemPage(makeEnv(db, r2), id, { dry: true });
    expect(res.skipped).toBe(false);
    expect(res.reason).toBe('dry');
    expect(r2.puts.length).toBe(0);
    expect(insertRuns(db)).toBe(0);
  });

  test('相关内链：同源 relevant 条目进 related，HTML 含其 /i/ 链接', async () => {
    const main = 'x_list:1';
    const rel = 'x_list:2';
    const db = makeDb([
      { id: main, source_type: 'x_list', is_relevant: 1, published_at: '2026-07-02T00:00:00Z' },
      { id: rel, source_type: 'x_list', is_relevant: 1, published_at: '2026-07-01T00:00:00Z' },
      { id: 'github:a/b', source_type: 'github', is_relevant: 1 }, // 异源，不应进 related
    ]);
    const r2 = makeR2();
    seedPage(db, rel, 'x', '2026-07-03T00:00:00Z');
    await generateItemPage(makeEnv(db, r2), main);
    const html = r2.store.get(itemPageR2Key(main)!)!;
    expect(html).toContain(itemPagePath(rel)!); // 同源相关内链指 /i/
    expect(html).not.toContain('/i/gh/a/b'); // 异源不混入
  });

  test('published_at 缺失时用 scraped_at 织入稳定邻居并生成月份归档链接', async () => {
    const main = 'github:acme/main';
    const rel = 'github:acme/older';
    const db = makeDb([
      {
        id: main,
        source_type: 'github',
        is_relevant: 1,
        published_at: null,
        scraped_at: '2026-05-20T00:00:00Z',
      },
      {
        id: rel,
        source_type: 'github',
        is_relevant: 1,
        published_at: null,
        scraped_at: '2026-05-19T00:00:00Z',
      },
    ]);
    const r2 = makeR2();
    seedPage(db, rel, 'gh', '2026-07-03T00:00:00Z');

    await generateItemPage(makeEnv(db, r2), main);
    const html = r2.store.get(itemPageR2Key(main)!)!;

    expect(html).toContain(itemPagePath(rel)!);
    expect(html).toContain('https://ai-feeds.com/archive/gh/2026-05/');
  });

  test('相关内链排除 dedup 次源（I2）：同源 dedup 行不进 related', async () => {
    const main = 'x_list:1';
    const rel = 'x_list:2';
    const dup = 'x_list:3';
    const db = makeDb([
      { id: main, source_type: 'x_list', is_relevant: 1, published_at: '2026-07-03T00:00:00Z' },
      { id: rel, source_type: 'x_list', is_relevant: 1, published_at: '2026-07-02T00:00:00Z' },
      // 同源 relevant 但 dedup 次源 → 不应织进相关内链
      {
        id: dup,
        source_type: 'x_list',
        is_relevant: 1,
        published_at: '2026-07-01T00:00:00Z',
        extra: JSON.stringify({ dedup_of: main }),
      },
    ]);
    const r2 = makeR2();
    seedPage(db, rel, 'x', '2026-07-04T00:00:00Z');
    seedPage(db, dup, 'x', '2026-07-04T00:00:00Z');
    await generateItemPage(makeEnv(db, r2), main);
    const html = r2.store.get(itemPageR2Key(main)!)!;
    expect(html).toContain(itemPagePath(rel)!); // 正常同源进 related
    expect(html).not.toContain(itemPagePath(dup)!); // dedup 次源被排除
  });

  test('相关内链排除 cn_sensitive=1 的 news item', async () => {
    const main = 'blog:main';
    const eligible = 'blog:eligible';
    const sensitive = 'blog:sensitive';
    const db = makeDb([
      { id: main, source_type: 'blog', published_at: '2026-07-03T00:00:00Z' },
      { id: eligible, source_type: 'blog', published_at: '2026-07-02T00:00:00Z' },
      {
        id: sensitive,
        source_type: 'blog',
        published_at: '2026-07-01T00:00:00Z',
        extra: sensitiveExtra,
      },
    ]);
    seedPage(db, eligible, 'news', '2026-07-04T00:00:00Z');
    seedPage(db, sensitive, 'news', '2026-07-04T00:00:00Z');
    const r2 = makeR2();

    await generateItemPage(makeEnv(db, r2), main);

    const html = r2.store.get(itemPageR2Key(main)!)!;
    expect(html).toContain(itemPagePath(eligible)!);
    expect(html).not.toContain(itemPagePath(sensitive)!);
  });

  test('相关内链使用当前项前后各 3 个稳定时间邻居，而不是全站最新 5 条', async () => {
    const main = 'x_list:main';
    const candidates = [
      ['x_list:newest-far', '2026-07-14T00:00:00Z'],
      ['x_list:new-3', '2026-07-13T00:00:00Z'],
      ['x_list:new-2', '2026-07-12T00:00:00Z'],
      ['x_list:new-1', '2026-07-11T00:00:00Z'],
      ['x_list:old-1', '2026-07-09T00:00:00Z'],
      ['x_list:old-2', '2026-07-08T00:00:00Z'],
      ['x_list:old-3', '2026-07-07T00:00:00Z'],
      ['x_list:oldest-far', '2026-07-06T00:00:00Z'],
    ] as const;
    const db = makeDb([
      { id: main, source_type: 'x_list', is_relevant: 1, published_at: '2026-07-10T00:00:00Z' },
      ...candidates.map(([id, published_at]) => ({
        id,
        source_type: 'x_list',
        is_relevant: 1,
        published_at,
      })),
    ]);
    for (const [id] of candidates) {
      seedPage(db, id, 'x', '2026-07-15T00:00:00Z');
    }

    const r2 = makeR2();
    await generateItemPage(makeEnv(db, r2), main);
    const html = r2.store.get(itemPageR2Key(main)!)!;

    for (const id of ['x_list:new-3', 'x_list:new-2', 'x_list:new-1', 'x_list:old-1', 'x_list:old-2', 'x_list:old-3']) {
      expect(html, id).toContain(itemPagePath(id)!);
    }
    expect(html).not.toContain(itemPagePath('x_list:newest-far')!);
    expect(html).not.toContain(itemPagePath('x_list:oldest-far')!);
  });
});

describe('generateItemPage force', () => {
  test('force=true：已有 item_pages 行仍重渲染（R2 覆盖 + generated_at 刷新）', async () => {
    const id = 'github:acme/tool';
    const db = makeDb([{ id, source_type: 'github', is_relevant: 1 }]);
    const r2 = makeR2();
    const env = makeEnv(db, r2);
    // 存量薄页：旧 generated_at + R2 无内容（模拟旧渲染器留下的行）
    seedPage(db, id, 'gh', '2026-07-01T00:00:00.000Z');
    const res = await generateItemPage(env, id, { force: true });
    expect(res.skipped).toBe(false);
    // R2 覆盖（重新 put）
    expect(r2.puts).toEqual([itemPageR2Key(id)!]);
    expect(r2.store.has(itemPageR2Key(id)!)).toBe(true);
    // generated_at 刷新（不再是旧值），status 仍 live
    const page = db._pages.get(id)!;
    expect(page.generated_at).not.toBe('2026-07-01T00:00:00.000Z');
    expect(page.generated_at > '2026-07-01T00:00:00.000Z').toBe(true);
    expect(page.status).toBe('live');
  });

  test('force=true 不绕过 dedup 门（C1）：dedup 次源仍 skipped(dedup-suppressed) 零写', async () => {
    const id = 'x_list:dup';
    const db = makeDb([
      { id, source_type: 'x_list', is_relevant: 1, extra: JSON.stringify({ dedup_of: 'x_list:incumbent' }) },
    ]);
    const r2 = makeR2();
    const res = await generateItemPage(makeEnv(db, r2), id, { force: true });
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('dedup-suppressed');
    expect(r2.puts.length).toBe(0);
    expect(insertRuns(db)).toBe(0);
  });

  test('force=true 不绕过 is_relevant 门：is_relevant≠1 仍 skipped(not-relevant) 零写', async () => {
    const id = 'x_list:8';
    const db = makeDb([{ id, source_type: 'x_list', is_relevant: 0 }]);
    const r2 = makeR2();
    const res = await generateItemPage(makeEnv(db, r2), id, { force: true });
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('not-relevant');
    expect(r2.puts.length).toBe(0);
    expect(insertRuns(db)).toBe(0);
  });
});

describe('markItemPageGone', () => {
  test('把 item_pages.status 置 gone', async () => {
    const id = 'x_list:1';
    const db = makeDb([{ id, source_type: 'x_list', is_relevant: 1 }]);
    const r2 = makeR2();
    const env = makeEnv(db, r2);
    await generateItemPage(env, id);
    expect(db._pages.get(id)!.status).toBe('live');
    await markItemPageGone(env, id);
    expect(db._pages.get(id)!.status).toBe('gone');
  });
});

describe('backfillItemPages', () => {
  test('backfill 不选择 cn_sensitive=1，也不把它计入 remaining', async () => {
    const db = makeDb([
      { id: 'blog:eligible', source_type: 'blog', extra: JSON.stringify({ cn_sensitive: 0 }) },
      { id: 'blog:sensitive', source_type: 'blog', extra: sensitiveExtra },
    ]);
    const r2 = makeR2();

    const res = await backfillItemPages(makeEnv(db, r2), 'news');

    expect(res).toEqual({ scanned: 1, generated: 1, remaining: 0 });
    expect(db._pages.has('blog:eligible')).toBe(true);
    expect(db._pages.has('blog:sensitive')).toBe(false);
  });

  test('分源谓词：source=x 只选 x_list 且 relevant 且未生成', async () => {
    const db = makeDb([
      { id: 'x_list:1', source_type: 'x_list', is_relevant: 1 },
      { id: 'x_list:2', source_type: 'x_list', is_relevant: 0 }, // 非 relevant 排除
      { id: 'github:a/b', source_type: 'github', is_relevant: 1 }, // 异源排除
    ]);
    const r2 = makeR2();
    const res = await backfillItemPages(makeEnv(db, r2), 'x');
    expect(res.scanned).toBe(1);
    expect(res.generated).toBe(1);
    expect(res.remaining).toBe(0);
    expect(db._pages.has('x_list:1')).toBe(true);
    expect(db._pages.has('github:a/b')).toBe(false); // 未碰异源
  });

  test('backfill 排 dedup（C1）：dedup 次源不入选 + 不计入 remaining', async () => {
    const db = makeDb([
      { id: 'x_list:1', source_type: 'x_list', is_relevant: 1 },
      // dedup 次源：relevant 但 extra.dedup_of 非空 → 不入选、不算待办
      {
        id: 'x_list:dup',
        source_type: 'x_list',
        is_relevant: 1,
        extra: JSON.stringify({ dedup_of: 'x_list:1' }),
      },
    ]);
    const r2 = makeR2();
    const res = await backfillItemPages(makeEnv(db, r2), 'x');
    expect(res.scanned).toBe(1); // 只选正常项
    expect(res.generated).toBe(1);
    expect(res.remaining).toBe(0); // dedup 次源不再永远算待办
    expect(db._pages.has('x_list:1')).toBe(true);
    expect(db._pages.has('x_list:dup')).toBe(false); // dedup 次源零写
  });

  test('news 谓词覆盖 blog + podcast', async () => {
    const db = makeDb([
      { id: 'blog:a', source_type: 'blog', is_relevant: 1 },
      { id: 'podcast:b', source_type: 'podcast', is_relevant: 1 },
      { id: 'x_list:1', source_type: 'x_list', is_relevant: 1 }, // 非 news
    ]);
    const r2 = makeR2();
    const res = await backfillItemPages(makeEnv(db, r2), 'news');
    expect(res.scanned).toBe(2);
    expect(res.generated).toBe(2);
    expect(db._pages.has('blog:a')).toBe(true);
    expect(db._pages.has('podcast:b')).toBe(true);
    expect(db._pages.has('x_list:1')).toBe(false);
  });

  test('游标单调 + remaining 递减：存在性即游标，分批到 0', async () => {
    const db = makeDb([
      { id: 'x_list:1', source_type: 'x_list', is_relevant: 1, published_at: '2026-07-03T00:00:00Z' },
      { id: 'x_list:2', source_type: 'x_list', is_relevant: 1, published_at: '2026-07-02T00:00:00Z' },
      { id: 'x_list:3', source_type: 'x_list', is_relevant: 1, published_at: '2026-07-01T00:00:00Z' },
    ]);
    const r2 = makeR2();
    const env = makeEnv(db, r2);
    const r1 = await backfillItemPages(env, 'x', { limit: 2 });
    expect(r1.scanned).toBe(2);
    expect(r1.generated).toBe(2);
    expect(r1.remaining).toBe(1);
    const r2res = await backfillItemPages(env, 'x', { limit: 2 });
    expect(r2res.scanned).toBe(1); // 上批已入 item_pages，退出谓词生效
    expect(r2res.generated).toBe(1);
    expect(r2res.remaining).toBe(0); // 单调递减到 0
    const r3 = await backfillItemPages(env, 'x', { limit: 2 });
    expect(r3.scanned).toBe(0); // 收敛，无重复生成
    expect(r3.remaining).toBe(0);
    expect(db._pages.size).toBe(3);
  });

  test('dry:true → 零写，remaining 不推进（游标不动）', async () => {
    const db = makeDb([
      { id: 'x_list:1', source_type: 'x_list', is_relevant: 1 },
      { id: 'x_list:2', source_type: 'x_list', is_relevant: 1 },
    ]);
    const r2 = makeR2();
    const res = await backfillItemPages(makeEnv(db, r2), 'x', { dry: true });
    expect(res.scanned).toBe(2);
    expect(res.generated).toBe(2); // would-generate 计数
    expect(res.remaining).toBe(2); // 未写 → 游标不动
    expect(r2.puts.length).toBe(0);
    expect(insertRuns(db)).toBe(0);
    expect(db._pages.size).toBe(0);
  });
});

describe('reconcileItemPageCompliance', () => {
  test('dry 零写；实跑按 limit 将违规 live 页置 gone 并返回 remaining', async () => {
    const ids = {
      sensitive: 'blog:sensitive',
      irrelevant: 'blog:irrelevant',
      deleted: 'blog:deleted',
      dedup: 'blog:dedup',
      eligible: 'blog:eligible',
    };
    const db = makeDb([
      { id: ids.sensitive, source_type: 'blog', extra: sensitiveExtra },
      { id: ids.irrelevant, source_type: 'blog', is_relevant: 0 },
      { id: ids.deleted, source_type: 'blog', deleted_at: '2026-07-20T00:00:00Z' },
      {
        id: ids.dedup,
        source_type: 'blog',
        extra: JSON.stringify({ dedup_of: ids.eligible }),
      },
      { id: ids.eligible, source_type: 'blog' },
    ]);
    for (const id of Object.values(ids)) {
      seedPage(db, id, 'news', '2026-07-19T00:00:00Z');
    }
    const mod = await import('./item-page-run');
    const reconcile = (
      mod as typeof mod & {
        reconcileItemPageCompliance?: (
          env: Env,
          opts?: { limit?: number; dry?: boolean },
        ) => Promise<{ scanned: number; markedGone: number; remaining: number }>;
      }
    ).reconcileItemPageCompliance;
    expect(typeof reconcile).toBe('function');
    if (!reconcile) return;

    const dry = await reconcile(makeEnv(db, makeR2()), { limit: 2, dry: true });
    expect(dry).toEqual({ scanned: 2, markedGone: 0, remaining: 4 });
    expect([...db._pages.values()].filter((page) => page.status === 'gone')).toHaveLength(0);

    const first = await reconcile(makeEnv(db, makeR2()), { limit: 2 });
    expect(first).toEqual({ scanned: 2, markedGone: 2, remaining: 2 });
    const second = await reconcile(makeEnv(db, makeR2()), { limit: 100 });
    expect(second).toEqual({ scanned: 2, markedGone: 2, remaining: 0 });
    expect(db._pages.get(ids.eligible)?.status).toBe('live');
  });
});

describe('backfillItemPages force', () => {
  test('force=true 选全部 relevant 非 dedup（含已生成薄页 → 重灌覆盖 R2 + 刷新 generated_at）', async () => {
    const thin = 'x_list:1'; // 存量薄页
    const fresh = 'x_list:2'; // 从未生成
    const db = makeDb([
      { id: thin, source_type: 'x_list', is_relevant: 1, published_at: '2026-07-02T00:00:00Z' },
      { id: fresh, source_type: 'x_list', is_relevant: 1, published_at: '2026-07-01T00:00:00Z' },
    ]);
    const r2 = makeR2();
    const env = makeEnv(db, r2);
    seedPage(db, thin, 'x', '2026-07-01T00:00:00.000Z'); // 旧渲染器留下的薄页行
    const res = await backfillItemPages(env, 'x', { force: true });
    expect(res.scanned).toBe(2); // 含已生成的 thin —— 谓词去掉 NOT EXISTS
    expect(res.generated).toBe(2);
    expect(res.remaining).toBe(0);
    // thin 被重灌：R2 覆盖 + generated_at 刷新（不再是旧值）
    expect(r2.store.has(itemPageR2Key(thin)!)).toBe(true);
    expect(db._pages.get(thin)!.generated_at).not.toBe('2026-07-01T00:00:00.000Z');
    expect(db._pages.get(fresh)!.status).toBe('live');
    // force 回填返回 campaign cutoff 供续跑续传（HTTP 层重入用）
    expect(typeof res.cutoff).toBe('string');
  });

  test('非 force（回归锁）：已有 item_pages 行被 NOT EXISTS 跳过，只选未生成、不返回 cutoff', async () => {
    const thin = 'x_list:1';
    const fresh = 'x_list:2';
    const db = makeDb([
      { id: thin, source_type: 'x_list', is_relevant: 1, published_at: '2026-07-02T00:00:00Z' },
      { id: fresh, source_type: 'x_list', is_relevant: 1, published_at: '2026-07-01T00:00:00Z' },
    ]);
    const r2 = makeR2();
    const env = makeEnv(db, r2);
    seedPage(db, thin, 'x', '2026-07-01T00:00:00.000Z');
    const res = await backfillItemPages(env, 'x'); // force 缺省
    expect(res.scanned).toBe(1); // 只有 fresh
    expect(res.generated).toBe(1);
    expect(res.remaining).toBe(0);
    expect(db._pages.get(thin)!.generated_at).toBe('2026-07-01T00:00:00.000Z'); // 未触碰
    expect(r2.store.has(itemPageR2Key(thin)!)).toBe(false); // thin 未重灌
    expect(res.cutoff).toBeUndefined(); // 非 force 返回结构零回归（无 cutoff 字段）
  });

  test('force=true 仍排 dedup（C1 在 force 下生效）：dedup 次源不入选、不重灌、不计 remaining', async () => {
    const main = 'x_list:1';
    const dup = 'x_list:dup';
    const db = makeDb([
      { id: main, source_type: 'x_list', is_relevant: 1 },
      { id: dup, source_type: 'x_list', is_relevant: 1, extra: JSON.stringify({ dedup_of: main }) },
    ]);
    const r2 = makeR2();
    const res = await backfillItemPages(makeEnv(db, r2), 'x', { force: true });
    expect(res.scanned).toBe(1); // 只 main
    expect(res.generated).toBe(1);
    expect(res.remaining).toBe(0);
    expect(db._pages.has(main)).toBe(true);
    expect(db._pages.has(dup)).toBe(false); // dedup 次源零写
  });

  test('force=true 仍排非 relevant（is_relevant 门在 force 下生效）', async () => {
    const db = makeDb([
      { id: 'x_list:1', source_type: 'x_list', is_relevant: 1 },
      { id: 'x_list:2', source_type: 'x_list', is_relevant: 0 }, // 非 relevant 不入选
    ]);
    const r2 = makeR2();
    const res = await backfillItemPages(makeEnv(db, r2), 'x', { force: true });
    expect(res.scanned).toBe(1);
    expect(res.generated).toBe(1);
    expect(db._pages.has('x_list:1')).toBe(true);
    expect(db._pages.has('x_list:2')).toBe(false);
  });

  test('force 可重入不无限循环：cutoff 固定 → 重灌行退出候选 → 单调收敛到 0', async () => {
    const db = makeDb([
      { id: 'x_list:1', source_type: 'x_list', is_relevant: 1, published_at: '2026-07-03T00:00:00Z' },
      { id: 'x_list:2', source_type: 'x_list', is_relevant: 1, published_at: '2026-07-02T00:00:00Z' },
      { id: 'x_list:3', source_type: 'x_list', is_relevant: 1, published_at: '2026-07-01T00:00:00Z' },
    ]);
    const r2 = makeR2();
    const env = makeEnv(db, r2);
    // 三条全为 prod 存量薄页（旧 generated_at）
    seedPage(db, 'x_list:1', 'x', '2026-07-01T00:00:00.000Z');
    seedPage(db, 'x_list:2', 'x', '2026-07-01T00:00:00.000Z');
    seedPage(db, 'x_list:3', 'x', '2026-07-01T00:00:00.000Z');

    const r1 = await backfillItemPages(env, 'x', { limit: 2, force: true });
    expect(r1.scanned).toBe(2);
    expect(r1.generated).toBe(2);
    expect(r1.remaining).toBe(1);
    const cutoff = r1.cutoff!;
    expect(typeof cutoff).toBe('string');

    // 续跑传回同一 campaign cutoff → 已重灌两行 generated_at>=cutoff → 退出候选
    const r2res = await backfillItemPages(env, 'x', { limit: 2, force: true, cutoff });
    expect(r2res.scanned).toBe(1); // 仅剩第 3 条
    expect(r2res.generated).toBe(1);
    expect(r2res.remaining).toBe(0);

    // 再续跑 → 收敛，无重复重灌（防无限循环）
    const r3 = await backfillItemPages(env, 'x', { limit: 2, force: true, cutoff });
    expect(r3.scanned).toBe(0);
    expect(r3.remaining).toBe(0);
    expect(db._pages.size).toBe(3);
  });

  test('force dry:true → 零写，游标不动（重灌不落盘，remaining 保持全量）', async () => {
    const db = makeDb([
      { id: 'x_list:1', source_type: 'x_list', is_relevant: 1 },
      { id: 'x_list:2', source_type: 'x_list', is_relevant: 1 },
    ]);
    const r2 = makeR2();
    const env = makeEnv(db, r2);
    seedPage(db, 'x_list:1', 'x', '2026-07-01T00:00:00.000Z'); // 一条已有薄页
    const res = await backfillItemPages(env, 'x', { dry: true, force: true });
    expect(res.scanned).toBe(2); // force 选全部（含已生成 thin）
    expect(res.generated).toBe(2); // would-regenerate 计数
    expect(res.remaining).toBe(2); // dry 未写 → generated_at 不推进 → 游标不动
    expect(r2.puts.length).toBe(0);
    expect(insertRuns(db)).toBe(0);
    expect(db._pages.get('x_list:1')!.generated_at).toBe('2026-07-01T00:00:00.000Z'); // dry 不触碰
  });
});

// becameLive 布尔（UPSERT 前查 item_pages 现状）：供 enrich hook 判「本次是否转入 live」→ 决定是否 ping。
// 判据 = 无行（首次） OR status!='live'（gone 复活）。status 仅两值 live/gone，故 !='live' 即 gone。
describe('generateItemPage becameLive（转入 live 判定）', () => {
  test('首次生成（item_pages 无该行）→ becameLive=true', async () => {
    const id = 'x_list:new';
    const db = makeDb([{ id, source_type: 'x_list', is_relevant: 1 }]);
    const res = await generateItemPage(makeEnv(db, makeR2()), id);
    expect(res.skipped).toBe(false);
    expect(res.becameLive).toBe(true);
  });

  test('已 live 行再生成（re-enrich / metrics 刷新 / 重译）→ becameLive=false', async () => {
    const id = 'x_list:1';
    const db = makeDb([{ id, source_type: 'x_list', is_relevant: 1 }]);
    const env = makeEnv(db, makeR2());
    expect((await generateItemPage(env, id)).becameLive).toBe(true); // 首次
    const second = await generateItemPage(env, id);
    expect(second.skipped).toBe(false);
    expect(second.becameLive).toBe(false); // 已 live，不重推
  });

  test('已有行 status=gone → becameLive=true（复活：此前 410，必须重新通知搜索引擎）', async () => {
    const id = 'github:acme/tool';
    const db = makeDb([{ id, source_type: 'github', is_relevant: 1 }]);
    seedPage(db, id, 'gh', '2026-07-01T00:00:00.000Z', 'gone'); // 预置 gone 行
    const res = await generateItemPage(makeEnv(db, makeR2()), id);
    expect(res.skipped).toBe(false);
    expect(res.becameLive).toBe(true);
  });

  test('force 重灌已 live 行 → becameLive=false（存量重灌不误判为转入 live）', async () => {
    const id = 'github:acme/tool';
    const db = makeDb([{ id, source_type: 'github', is_relevant: 1 }]);
    seedPage(db, id, 'gh', '2026-07-01T00:00:00.000Z', 'live');
    const res = await generateItemPage(makeEnv(db, makeR2()), id, { force: true });
    expect(res.skipped).toBe(false);
    expect(res.becameLive).toBe(false);
  });

  test('force 重灌 gone 行 → becameLive=true（复活判据优先于 force）', async () => {
    const id = 'github:acme/tool';
    const db = makeDb([{ id, source_type: 'github', is_relevant: 1 }]);
    seedPage(db, id, 'gh', '2026-07-01T00:00:00.000Z', 'gone');
    const res = await generateItemPage(makeEnv(db, makeR2()), id, { force: true });
    expect(res.becameLive).toBe(true);
  });

  test('skipped（not-relevant）→ becameLive 不置（undefined，hook 视作不 ping）', async () => {
    const db = makeDb([{ id: 'x_list:8', source_type: 'x_list', is_relevant: 0 }]);
    const res = await generateItemPage(makeEnv(db, makeR2()), 'x_list:8');
    expect(res.skipped).toBe(true);
    expect(res.becameLive).toBeUndefined();
  });
});

// backfill 一律不 ping IndexNow —— 锁死「force 全量重灌不重推 3.2 万已收录 URL」的头号风险。
// ping 只在 enrich hook 层（item-page-hook.ts），backfill/generateItemPage 本体绝不发起 IndexNow HTTP。
// 本组用全局 fetch spy 兜底：backfill（含 force）全程零 fetch → 未来若有人误把 ping 接进本体，此断言即刻变红。
describe('backfill 一律不 ping IndexNow（锁死 force 重灌不重推存量）', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('普通回填首次生成页也不 ping（存量首建靠 sitemap 收录，不走 IndexNow）', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const db = makeDb([
      { id: 'x_list:1', source_type: 'x_list', is_relevant: 1 },
      { id: 'x_list:2', source_type: 'x_list', is_relevant: 1 },
    ]);
    const res = await backfillItemPages(makeEnv(db, makeR2()), 'x', { limit: 100 });
    expect(res.generated).toBe(2); // 两条都首次生成（becameLive=true），但 backfill 路径不 ping
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('force=1 重灌存量薄页（3.2 万重灌的关键风险路径）→ 全程零 fetch', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const db = makeDb([
      { id: 'x_list:1', source_type: 'x_list', is_relevant: 1, published_at: '2026-07-03T00:00:00Z' },
      { id: 'x_list:2', source_type: 'x_list', is_relevant: 1, published_at: '2026-07-02T00:00:00Z' },
    ]);
    const env = makeEnv(db, makeR2());
    // 预置存量薄页（模拟 prod 已生成的 3.2 万），旧 generated_at → force 全部重灌（覆盖写）。
    seedPage(db, 'x_list:1', 'x', '2026-07-01T00:00:00.000Z');
    seedPage(db, 'x_list:2', 'x', '2026-07-01T00:00:00.000Z');
    const forced = await backfillItemPages(env, 'x', { limit: 100, force: true });
    expect(forced.generated).toBe(2); // 两条已存在（=已收录）页被重灌
    // 关键锁：重灌已收录页全程零 HTTP → 绝不向 IndexNow 重推 3.2 万 URL。
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// 端到端：enrich hook（syncItemPageOnEnrichDone，真身）→ generateItemPage（真身）→ pingIndexNow（真身，
// 仅 mock 全局 fetch）。用真实 item_pages 状态驱动，锁死「首次 / 复活 ping，re-enrich 不 ping」的完整链路。
// 本文件不 vi.mock('./item-page-run')，故 hook 调的是真 generateItemPage（对状态化 makeDb 生效）。
describe('端到端 hook → generateItemPage → pingIndexNow（真链路，mock fetch）', () => {
  afterEach(() => vi.unstubAllGlobals());

  // 带 INDEXNOW_KEY 的 env（makeEnv 不含 key，否则 pingIndexNow 静默跳过）。
  const pingEnv = (db: unknown, r2: unknown): Env =>
    ({ SITE_BASE: SITE, API_BASE: API, INDEXNOW_KEY: 'inx-test-key', DB: db, READMES: r2 }) as unknown as Env;
  const stubFetch = (): ReturnType<typeof vi.fn> => {
    const f = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', f);
    return f;
  };
  const inxCalls = (f: ReturnType<typeof vi.fn>) =>
    f.mock.calls.filter(([u]) => String(u).includes('api.indexnow.org'));

  test('无行 + relevant=true（首次收录）→ ping 一次，urlList=[SITE+itemPagePath]', async () => {
    const id = 'github:acme/tool';
    const db = makeDb([{ id, source_type: 'github', is_relevant: 1 }]);
    const r2 = makeR2();
    const f = stubFetch();
    await syncItemPageOnEnrichDone(pingEnv(db, r2), id, true);
    expect(db._pages.get(id)!.status).toBe('live'); // 生成后置 live
    const calls = inxCalls(f);
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String((calls[0][1] as RequestInit).body));
    expect(body.urlList).toEqual([`${SITE}${itemPagePath(id)}`]);
  });

  test('已有行 status=gone + relevant=true（复活）→ ping 一次（此前 410，必须重新通知）', async () => {
    const id = 'github:acme/tool';
    const db = makeDb([{ id, source_type: 'github', is_relevant: 1 }]);
    const r2 = makeR2();
    seedPage(db, id, 'gh', '2026-07-01T00:00:00.000Z', 'gone'); // 此前判不相关下架 → gone
    const f = stubFetch();
    await syncItemPageOnEnrichDone(pingEnv(db, r2), id, true);
    expect(db._pages.get(id)!.status).toBe('live'); // 复活为 live
    expect(inxCalls(f)).toHaveLength(1); // 复活重新 ping
  });

  test('已有行 status=live + relevant=true（re-enrich 回归锁）→ 不 ping', async () => {
    const id = 'github:acme/tool';
    const db = makeDb([{ id, source_type: 'github', is_relevant: 1 }]);
    const r2 = makeR2();
    seedPage(db, id, 'gh', '2026-07-01T00:00:00.000Z', 'live'); // 已收录
    const f = stubFetch();
    await syncItemPageOnEnrichDone(pingEnv(db, r2), id, true);
    expect(inxCalls(f)).toHaveLength(0); // 已 live，不重推
  });

  test('relevant=false → 下架 gone，不 ping', async () => {
    const id = 'github:acme/tool';
    const db = makeDb([{ id, source_type: 'github', is_relevant: 1 }]);
    const r2 = makeR2();
    seedPage(db, id, 'gh', '2026-07-01T00:00:00.000Z', 'live');
    const f = stubFetch();
    await syncItemPageOnEnrichDone(pingEnv(db, r2), id, false);
    expect(db._pages.get(id)!.status).toBe('gone');
    expect(inxCalls(f)).toHaveLength(0);
  });
});
