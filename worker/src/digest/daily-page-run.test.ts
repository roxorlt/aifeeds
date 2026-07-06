import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// 选品在编排层整体 mock —— 让 buildDailyPageData 走真实 fetchRows/subject/adjacency + 真实渲染,
// 仅把「选哪些 id」这一步换成 fixture,精确验证 R2 落盘 / D1 UPSERT / 前日重渲染 / IndexNow 容错。
vi.mock('./selection', () => ({
  selectTopForSource: vi.fn(async () => [] as string[]),
}));

import { generateDailyPage, backfillDailyPages, pingIndexNow } from './daily-page-run';
import { selectTopForSource } from './selection';
import type { Env } from '../index';
import type { DigestSource } from './config';
import type { RenderRow } from './render';

const SITE = 'https://ai-feeds.com';
const API = 'https://api.ai-feeds.com';

function mkRow(id: string, i: number): RenderRow {
  return {
    id,
    title: `标题 ${i}`,
    content: `body ${i}`,
    content_translated: `正文 ${i}`,
    author: `作者${i}`,
    handle: `@u${i}`,
    url: `https://example.com/${i}`,
    media: null,
    extra: JSON.stringify({ ai_summary: `摘要${i}`, title_zh: `中文标题${i}`, ai_summary_zh: `新闻摘要${i}`, summary_zh: `论文摘要${i}` }),
  };
}

function setSelection(map: Partial<Record<DigestSource, string[]>>) {
  vi.mocked(selectTopForSource).mockImplementation(async (_env, source: DigestSource) => map[source] ?? []);
}

// ── 有状态 D1 mock:daily_pages 行随 INSERT 落库,相邻日期查询实时反映(验证前日 nextDate 链) ──
interface DailyPageRow {
  date: string;
  title: string;
  item_count: number;
  generated_at: string;
}

function makeStatefulDb(opts: { rowsById?: Map<string, RenderRow>; backfillDates?: string[] } = {}) {
  const rowsById = opts.rowsById ?? new Map<string, RenderRow>();
  const dailyPages = new Map<string, DailyPageRow>();
  const insertRuns: Array<{ date: string }> = [];
  const db = {
    _dailyPages: dailyPages,
    _insertRuns: insertRuns,
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) {
          binds = a;
          return stmt;
        },
        async all<T>() {
          if (/FROM digest_pool/i.test(sql) && /DISTINCT/i.test(sql)) {
            return { results: (opts.backfillDates ?? []).map((d) => ({ date: d })) as unknown as T[] };
          }
          if (/FROM items/i.test(sql)) {
            const res = binds.map((id) => rowsById.get(String(id))).filter((r): r is RenderRow => !!r);
            return { results: res as unknown as T[] };
          }
          return { results: [] as T[] };
        },
        async first<T>() {
          if (/_subject/.test(sql)) return null as T | null; // 触发 fallback subject
          if (/daily_pages/i.test(sql)) {
            const target = String(binds[0]);
            const dates = [...dailyPages.keys()].sort();
            if (/date <\s*\?/.test(sql)) {
              const prev = dates.filter((d) => d < target).pop();
              return (prev ? { date: prev } : null) as T | null;
            }
            if (/date >\s*\?/.test(sql)) {
              const next = dates.filter((d) => d > target)[0];
              return (next ? { date: next } : null) as T | null;
            }
          }
          return null as T | null;
        },
        async run() {
          if (/INSERT INTO daily_pages/i.test(sql)) {
            const [date, title, item_count, generated_at] = binds as [string, string, number, string];
            dailyPages.set(date, { date, title, item_count, generated_at });
            insertRuns.push({ date });
          }
          return { success: true };
        },
      };
      return stmt;
    },
  };
  return db;
}

function makeR2() {
  const store = new Map<string, string>();
  const puts: Array<{ key: string }> = [];
  return {
    store,
    puts,
    async put(key: string, value: string) {
      store.set(key, String(value));
      puts.push({ key });
    },
  };
}

function makeEnv(db: unknown, r2: unknown, over: Partial<Env> = {}): Env {
  return { SITE_BASE: SITE, API_BASE: API, DB: db, READMES: r2, ...over } as unknown as Env;
}

describe('generateDailyPage', () => {
  beforeEach(() => {
    vi.mocked(selectTopForSource).mockReset();
    vi.mocked(selectTopForSource).mockResolvedValue([]);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('选品为空 → skipped,R2/D1 零调用', async () => {
    setSelection({});
    const db = makeStatefulDb();
    const r2 = makeR2();
    const res = await generateDailyPage(makeEnv(db, r2), '2026-07-06');
    expect(res.skipped).toBe(true);
    expect(res.itemCount).toBe(0);
    expect(r2.puts.length).toBe(0);
    expect(db._insertRuns.length).toBe(0);
  });

  test('正常路径 → R2 key 正确 + daily_pages UPSERT;同日二次调用不新增行', async () => {
    setSelection({ x: ['x_list:1'] });
    const rowsById = new Map([['x_list:1', mkRow('x_list:1', 1)]]);
    const db = makeStatefulDb({ rowsById });
    const r2 = makeR2();
    const env = makeEnv(db, r2); // 无 INDEXNOW_KEY → 不触发 ping

    const res = await generateDailyPage(env, '2026-07-04');
    expect(res.skipped).toBe(false);
    expect(res.itemCount).toBe(1);
    expect(r2.store.has('daily/2026-07-04.html')).toBe(true);
    expect(db._dailyPages.get('2026-07-04')?.item_count).toBe(1);
    expect(db._dailyPages.get('2026-07-04')?.title).toContain('AI 日报 2026-07-04');

    // 二次调用同日期:UPSERT 覆盖,不新增行
    await generateDailyPage(env, '2026-07-04');
    expect(db._dailyPages.size).toBe(1);
    expect(db._insertRuns.filter((r) => r.date === '2026-07-04').length).toBe(2); // 两次 UPSERT
  });

  test('存在前日 → 前日页面被重渲染,其 HTML 含指向本日的链接', async () => {
    setSelection({ x: ['x_list:1'] });
    const rowsById = new Map([['x_list:1', mkRow('x_list:1', 1)]]);
    const db = makeStatefulDb({ rowsById });
    const r2 = makeR2();
    const env = makeEnv(db, r2);

    // 先生成前一日 2026-07-03(此刻无后一日 → 归档链接)
    await generateDailyPage(env, '2026-07-03');
    expect(r2.store.get('daily/2026-07-03.html')).not.toContain('/daily/2026-07-04');

    // 再生成本日 2026-07-04 → 应重渲染 2026-07-03,令其「后一日」指向本日
    await generateDailyPage(env, '2026-07-04');
    const prevHtml = r2.store.get('daily/2026-07-03.html')!;
    expect(prevHtml).toContain(`${SITE}/daily/2026-07-04`);
    expect(db._dailyPages.has('2026-07-03')).toBe(true);
    expect(db._dailyPages.has('2026-07-04')).toBe(true);
  });

  test('dry:true → 不落盘,返回 itemCount', async () => {
    setSelection({ x: ['x_list:1', 'x_list:2'] });
    const rowsById = new Map([
      ['x_list:1', mkRow('x_list:1', 1)],
      ['x_list:2', mkRow('x_list:2', 2)],
    ]);
    const db = makeStatefulDb({ rowsById });
    const r2 = makeR2();
    const res = await generateDailyPage(makeEnv(db, r2), '2026-07-04', { dry: true });
    expect(res.skipped).toBe(false);
    expect(res.itemCount).toBe(2);
    expect(r2.puts.length).toBe(0);
    expect(db._insertRuns.length).toBe(0);
  });

  test('pingIndexNow 抛错不冒泡到 generateDailyPage 返回值', async () => {
    setSelection({ x: ['x_list:1'] });
    const rowsById = new Map([['x_list:1', mkRow('x_list:1', 1)]]);
    const db = makeStatefulDb({ rowsById });
    const r2 = makeR2();
    const env = makeEnv(db, r2, { INDEXNOW_KEY: 'test-key' });
    // fetch 直接抛(网络错)——不应冒泡
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    const res = await generateDailyPage(env, '2026-07-04');
    expect(res.skipped).toBe(false);
    expect(res.itemCount).toBe(1);
    // 页面仍正常落盘(ping 失败不影响主流程)
    expect(r2.store.has('daily/2026-07-04.html')).toBe(true);
  });

  test('配置 INDEXNOW_KEY 且成功时,ping 当日页/归档/sitemap 三个 URL', async () => {
    setSelection({ x: ['x_list:1'] });
    const rowsById = new Map([['x_list:1', mkRow('x_list:1', 1)]]);
    const db = makeStatefulDb({ rowsById });
    const r2 = makeR2();
    const env = makeEnv(db, r2, { INDEXNOW_KEY: 'k' });
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await generateDailyPage(env, '2026-07-04');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(endpoint).toBe('https://api.indexnow.org/indexnow');
    const body = JSON.parse(String(init.body));
    expect(body.host).toBe('ai-feeds.com');
    expect(body.key).toBe('k');
    expect(body.urlList).toEqual([
      `${SITE}/daily/2026-07-04`,
      `${SITE}/daily/`,
      `${SITE}/sitemap.xml`,
    ]);
  });
});

describe('pingIndexNow', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('未配置 INDEXNOW_KEY → 静默跳过,不 fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await pingIndexNow({ SITE_BASE: SITE } as unknown as Env, [`${SITE}/daily/2026-07-04`]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('非 2xx 不抛错(内部 console.error)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 403 })));
    await expect(
      pingIndexNow({ SITE_BASE: SITE, INDEXNOW_KEY: 'k' } as unknown as Env, [`${SITE}/x`]),
    ).resolves.toBeUndefined();
  });

  test('fetch 抛错不冒泡', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom'); }));
    await expect(
      pingIndexNow({ SITE_BASE: SITE, INDEXNOW_KEY: 'k' } as unknown as Env, [`${SITE}/x`]),
    ).resolves.toBeUndefined();
  });
});

describe('backfillDailyPages', () => {
  beforeEach(() => {
    vi.mocked(selectTopForSource).mockReset();
    vi.mocked(selectTopForSource).mockResolvedValue([]);
  });
  afterEach(() => vi.unstubAllGlobals());

  test('遍历 digest_pool 历史日期升序逐日生成,结束一次性批量 ping', async () => {
    setSelection({ x: ['x_list:1'] });
    const rowsById = new Map([['x_list:1', mkRow('x_list:1', 1)]]);
    const db = makeStatefulDb({ rowsById, backfillDates: ['2026-07-01', '2026-07-02'] });
    const r2 = makeR2();
    const env = makeEnv(db, r2, { INDEXNOW_KEY: 'k' });
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const results = await backfillDailyPages(env);
    expect(results.map((r) => r.date)).toEqual(['2026-07-01', '2026-07-02']);
    expect(results.every((r) => !r.skipped)).toBe(true);
    expect(db._dailyPages.has('2026-07-01')).toBe(true);
    expect(db._dailyPages.has('2026-07-02')).toBe(true);

    // 每日 skipIndexNow → 全程只在收尾 ping 一次
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.urlList).toContain(`${SITE}/daily/2026-07-01`);
    expect(body.urlList).toContain(`${SITE}/daily/2026-07-02`);
    expect(body.urlList).toContain(`${SITE}/sitemap.xml`);

    // 升序回填天然链式互链:2026-07-01 页被 07-02 生成时重渲染 → 后一日指向 07-02
    expect(r2.store.get('daily/2026-07-01.html')).toContain(`${SITE}/daily/2026-07-02`);
  });

  test('dry:true → 只返回日期清单,不落盘不 ping', async () => {
    setSelection({ x: ['x_list:1'] });
    const rowsById = new Map([['x_list:1', mkRow('x_list:1', 1)]]);
    const db = makeStatefulDb({ rowsById, backfillDates: ['2026-07-01', '2026-07-02'] });
    const r2 = makeR2();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const results = await backfillDailyPages(makeEnv(db, r2, { INDEXNOW_KEY: 'k' }), { dry: true });
    expect(results.length).toBe(2);
    expect(r2.puts.length).toBe(0);
    expect(db._insertRuns.length).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
