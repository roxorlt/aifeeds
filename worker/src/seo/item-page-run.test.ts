import { describe, test, expect } from 'vitest';

import { generateItemPage, markItemPageGone, backfillItemPages } from './item-page-run';
import { itemPageR2Key, itemPagePath } from '../digest/render';
import type { Env } from '../index';

const SITE = 'https://ai-feeds.com';
const API = 'https://api.ai-feeds.com';

// ── 有状态 D1 mock：items（数组）+ item_pages（Map，存在性即回填游标）──
// 覆盖 5 类 SQL：fetchItemRow(SELECT * WHERE id=?)、related(id != ?)、backfill 选取(NOT EXISTS .all)、
// backfill 计数(COUNT .first)、item_pages upsert/gone(.run)。
interface ItemSeed {
  id: string;
  source_type: string;
  is_relevant?: number;
  published_at?: string;
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
    published_at: s.published_at ?? '2026-07-01T00:00:00Z',
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

  // extra.dedup_of 非空 → dedup 次源，模拟 SQL `json_extract(extra,'$.dedup_of') IS NULL` 的排除。
  const isDeduped = (r: Record<string, unknown>): boolean => {
    try {
      const d = r.extra ? (JSON.parse(String(r.extra)) as { dedup_of?: unknown }).dedup_of : null;
      return d != null && d !== '';
    } catch {
      return false;
    }
  };

  // 非 force：候选 = relevant 非 dedup 且尚未生成（存在性游标）。
  // force（传 cutoff）：候选 = relevant 非 dedup 且「无本轮已重灌页」——即无页 OR 页 generated_at < cutoff。
  //   重灌把 generated_at 推到 >= cutoff → 该行退出候选（cutoff 全程固定 → 单调收敛）。
  const pendingFor = (sts: string[], cutoff?: string): Array<Record<string, unknown>> =>
    items
      .filter((r) => {
        if (!sts.includes(String(r.source_type))) return false;
        if (Number(r.is_relevant) !== 1) return false;
        if (isDeduped(r)) return false;
        const p = pages.get(String(r.id));
        if (cutoff == null) return !p; // 非 force：未生成才是候选
        return !p || String(p.generated_at) < cutoff; // force：无页 OR 页早于本轮 cutoff
      })
      .sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)));

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
          if (/COUNT\(\*\)/i.test(sql)) {
            if (/generated_at >= \?/i.test(sql)) {
              // force 计数：binds = [...sts, cutoff]
              const cutoff = String(binds[binds.length - 1]);
              const sts = binds.slice(0, binds.length - 1).map(String);
              return { n: pendingFor(sts, cutoff).length } as T;
            }
            const sts = binds.map(String);
            return { n: pendingFor(sts).length } as T;
          }
          return null as T | null;
        },
        async all<T>() {
          if (/id != \?/i.test(sql)) {
            // related：binds = [...sourceTypes, mainId]；SQL 含 dedup_of IS NULL → 排 dedup 次源。
            const mainId = String(binds[binds.length - 1]);
            const sts = binds.slice(0, binds.length - 1).map(String);
            const res = items
              .filter(
                (r) =>
                  sts.includes(String(r.source_type)) &&
                  String(r.id) !== mainId &&
                  Number(r.is_relevant) === 1 &&
                  !isDeduped(r),
              )
              .sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))
              .slice(0, 6);
            return { results: res as unknown as T[] };
          }
          if (/generated_at >= \?/i.test(sql)) {
            // force 选取：binds = [...sourceTypes, cutoff, limit]
            const limit = Number(binds[binds.length - 1]);
            const cutoff = String(binds[binds.length - 2]);
            const sts = binds.slice(0, binds.length - 2).map(String);
            const res = pendingFor(sts, cutoff).slice(0, limit).map((r) => ({ id: r.id }));
            return { results: res as unknown as T[] };
          }
          if (/NOT EXISTS/i.test(sql)) {
            // backfill 选取（非 force）：binds = [...sourceTypes, limit]
            const limit = Number(binds[binds.length - 1]);
            const sts = binds.slice(0, binds.length - 1).map(String);
            const res = pendingFor(sts).slice(0, limit).map((r) => ({ id: r.id }));
            return { results: res as unknown as T[] };
          }
          return { results: [] as T[] };
        },
        async run() {
          runs.push({ sql, binds });
          if (/INSERT INTO item_pages/i.test(sql)) {
            const [item_id, source, url_path, generated_at] = binds as [string, string, string, string];
            pages.set(item_id, { item_id, source, url_path, generated_at, status: 'live' });
          } else if (/UPDATE item_pages SET status/i.test(sql)) {
            const p = pages.get(String(binds[0]));
            if (p) p.status = 'gone';
          }
          return { success: true };
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

// 预置一条存量 item_pages 行（模拟 prod 已用旧渲染器生成的薄页），带指定 generated_at。
const seedPage = (db: ReturnType<typeof makeDb>, id: string, source: string, generated_at: string): void => {
  db._pages.set(id, { item_id: id, source, url_path: itemPagePath(id) ?? `/i/${id}`, generated_at, status: 'live' });
};

describe('generateItemPage', () => {
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
    await generateItemPage(makeEnv(db, r2), main);
    const html = r2.store.get(itemPageR2Key(main)!)!;
    expect(html).toContain(itemPagePath(rel)!); // 同源相关内链指 /i/
    expect(html).not.toContain('/i/gh/a/b'); // 异源不混入
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
    await generateItemPage(makeEnv(db, r2), main);
    const html = r2.store.get(itemPageR2Key(main)!)!;
    expect(html).toContain(itemPagePath(rel)!); // 正常同源进 related
    expect(html).not.toContain(itemPagePath(dup)!); // dedup 次源被排除
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
