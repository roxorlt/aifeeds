import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// 选品在编排层整体 mock —— 让 buildDailyPageData 走真实 fetchRows/subject/adjacency + 真实渲染,
// 仅把「选哪些 id」这一步换成 fixture,精确验证 R2 落盘 / D1 UPSERT / 前日重渲染 / IndexNow 容错。
vi.mock('./selection', () => ({
  selectTopForSource: vi.fn(async () => [] as string[]),
}));

const publicationMocks = vi.hoisted(() => ({
  sequence: 0,
  reservations: new Map<string, any>(),
  currentByDate: new Map<string, any>(),
  htmlByDate: new Map<string, string>(),
  finalAuthorization: vi.fn(async (..._args: any[]) => undefined),
  releaseSetAuthorization: vi.fn(async (..._args: any[]) => undefined),
  strictCurrentLoader: vi.fn(async (..._args: any[]) => null as any),
  pageRebuildCurrentLoader: vi.fn(async (..._args: any[]) => null as any),
}));

vi.mock('./news-source-policy', () => ({
  authorizeFormalNewsSet: vi.fn(async (_env: unknown, date: string, ids: string[]) => ({
    allowed_ids: [...ids], decisions: ids.map((item_id) => ({ item_id, allowed: true })),
    final_guard: { registry_json: '[]', expected_json: '[]', review_date: date },
  })),
}));

vi.mock('./publication-storage', () => ({
  reserveAppendOnlyPublication: vi.fn(async (_env: unknown, input: any) => {
    const publication_id = (++publicationMocks.sequence).toString(16).padStart(64, '0');
    const manifest_digest = publication_id;
    const reservation = {
      reservation_token: publication_id,
      publication_id,
      publication_date: input.publication_date,
      publication_type: input.publication_type,
      slot_no: 1,
      business_revision_id: input.business_revision_id,
      attempt_key: publication_id,
      manifest: {
        manifest_digest,
        objects: [{ r2_key: `daily/versions/${publication_id}/page.html` }],
      },
    };
    publicationMocks.reservations.set(publication_id, { input, reservation });
    return { status: 'reserved', reservation };
  }),
}));

vi.mock('./publication-release', () => ({
  loadCurrentDailyReleaseForBuild: publicationMocks.strictCurrentLoader,
  loadCurrentDailyReleaseForPageRebuild: publicationMocks.pageRebuildCurrentLoader,
  listAuthorizedDailyReleaseSummaries: vi.fn(async () =>
    [...publicationMocks.currentByDate.values()].map((release: any) => ({
      date: release.head.date,
      release_generation: release.head.release_generation,
      promoted_at_ms: release.head.promoted_at_ms,
      title: String(release.page_metadata?.title || ''),
      item_count: Number(release.page_metadata?.item_count || 0),
      video: release.video || null,
    }))),
  materializeAppendOnlyPublication: vi.fn(async (env: any, reservation: any, bytes: any) => {
    const html = new TextDecoder().decode(bytes.html);
    publicationMocks.htmlByDate.set(reservation.publication_date, html);
    env.READMES?.puts?.push({ key: reservation.manifest.objects[0].r2_key });
    env.READMES?.store?.set(reservation.manifest.objects[0].r2_key, html);
  }),
  promoteDailyRelease: vi.fn(async (_env: unknown, publicationId: string) => {
    const record = publicationMocks.reservations.get(publicationId);
    const input = record.input;
    const binding = input.release_binding;
    const head = {
      date: input.publication_date,
      release_generation: Number(binding.base_release_generation || 0) + 1,
      page_publication_id: publicationId,
      video_publication_id: binding.bound_video_publication_id || null,
      video_mode: binding.video_mode,
      page_manifest_digest: record.reservation.manifest.manifest_digest,
      video_manifest_digest: binding.bound_video_digest || null,
      promoted_at_ms: 1,
    };
    const previous = publicationMocks.currentByDate.get(input.publication_date);
    publicationMocks.currentByDate.set(input.publication_date, {
      head, page_metadata: input.metadata, video: previous?.video || null,
    });
    return { ...head, status: 'published' };
  }),
  assertCurrentDailyReleaseAuthorization: publicationMocks.finalAuthorization,
  assertCurrentDailyReleaseSetAuthorization: publicationMocks.releaseSetAuthorization,
  projectAuthorizedDailyPageCompatibility: vi.fn(async (env: any, expected: any, projection: any) => {
    await publicationMocks.finalAuthorization(env, expected.date, expected);
    await env.DB.prepare(`INSERT INTO daily_pages(date,title,item_count,generated_at,lastmod)
      VALUES(?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET title=excluded.title`)
      .bind(expected.date, projection.title, projection.item_count, projection.generated_at, projection.lastmod)
      .run();
  }),
}));

import { generateDailyPage, backfillDailyPages, pingIndexNow } from './daily-page-run';
import { selectTopForSource } from './selection';
import type { Env } from '../index';
import type { DigestSource } from './config';
import type { RenderRow } from './render';
import type { DailyVideoRow } from './daily-video';

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
  lastmod?: string;
}

function makeStatefulDb(opts: { rowsById?: Map<string, RenderRow>; backfillDates?: string[]; video?: DailyVideoRow | null } = {}) {
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
          if (/FROM daily_videos/i.test(sql)) return (opts.video ?? null) as T | null;
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
            const [date, title, item_count, generated_at, lastmod] = binds as [string, string, number, string, string?];
            dailyPages.set(date, { date, title, item_count, generated_at, lastmod });
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
  return {
    SITE_BASE: SITE, API_BASE: API, DB: db, READMES: r2,
    DAILY_PUBLICATION_RESERVATION_ENABLED: '1',
    DAILY_PUBLICATION_PUT_ENABLED: '1',
    DAILY_PUBLICATION_PROMOTION_ENABLED: '1',
    ...over,
  } as unknown as Env;
}

describe('generateDailyPage', () => {
  beforeEach(() => {
    publicationMocks.sequence = 0;
    publicationMocks.reservations.clear();
    publicationMocks.currentByDate.clear();
    publicationMocks.htmlByDate.clear();
    publicationMocks.finalAuthorization.mockReset();
    publicationMocks.finalAuthorization.mockResolvedValue(undefined);
    publicationMocks.strictCurrentLoader.mockReset();
    publicationMocks.strictCurrentLoader.mockImplementation(async (_env: unknown, date: string) =>
      publicationMocks.currentByDate.get(date) || null);
    publicationMocks.pageRebuildCurrentLoader.mockReset();
    publicationMocks.pageRebuildCurrentLoader.mockImplementation(async (_env: unknown, date: string) =>
      publicationMocks.currentByDate.get(date) || null);
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
    expect(publicationMocks.htmlByDate.has('2026-07-04')).toBe(true);
    expect(db._dailyPages.get('2026-07-04')?.item_count).toBe(1);
    expect(db._dailyPages.get('2026-07-04')?.title).toContain('AI 日报 2026-07-04');
    expect(db._dailyPages.get('2026-07-04')?.lastmod).toBe(db._dailyPages.get('2026-07-04')?.generated_at);

    // 二次调用同日期:UPSERT 覆盖,不新增行
    await generateDailyPage(env, '2026-07-04');
    expect(db._dailyPages.size).toBe(1);
    expect(db._insertRuns.filter((r) => r.date === '2026-07-04').length).toBe(2); // 两次 UPSERT
  });

  test('page generation renders only the video bound by the current release head', async () => {
    setSelection({ x: ['x_list:1'] });
    const rowsById = new Map([['x_list:1', mkRow('x_list:1', 1)]]);
    const video: DailyVideoRow = {
      date: '2026-07-04', title: '视频标题', description: '视频描述', duration_seconds: 61,
      mp4_key: `daily-video/public/${'a'.repeat(64)}/mp4`, mp4_sha256: 'a', mp4_size: 10,
      poster_key: `daily-video/public/${'a'.repeat(64)}/poster`, poster_sha256: 'b', poster_size: 10,
      vtt_key: `daily-video/public/${'a'.repeat(64)}/vtt`, vtt_sha256: 'c', vtt_size: 10,
      uploaded_at: '2026-07-04T02:03:04.000Z', updated_at: '2026-07-04T02:03:04.000Z',
    };
    const db = makeStatefulDb({ rowsById, video });
    const r2 = makeR2();
    publicationMocks.currentByDate.set('2026-07-04', {
      head: {
        date: '2026-07-04', release_generation: 1,
        page_publication_id: 'p'.repeat(64), video_publication_id: 'a'.repeat(64),
        video_mode: 'joint_new', page_manifest_digest: 'q'.repeat(64),
        video_manifest_digest: 'v'.repeat(64), promoted_at_ms: 1,
      }, page_metadata: {}, video,
    });

    await generateDailyPage(makeEnv(db, r2), '2026-07-04');
    const html = publicationMocks.htmlByDate.get('2026-07-04')!;
    expect(html).toContain('<video controls playsinline preload="metadata"');
    expect(html).toContain(`${API}/r/${video.mp4_key}`);
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]);
    expect(ld['@graph'].find((node: any) => node['@type'] === 'VideoObject')).toMatchObject({
      name: '视频标题', duration: 'PT1M1S',
    });
  });

  test('stale outward authorization does not block the dedicated page rebuild baseline', async () => {
    setSelection({ x: ['x_list:1'] });
    const rowsById = new Map([['x_list:1', mkRow('x_list:1', 1)]]);
    const db = makeStatefulDb({ rowsById });
    const r2 = makeR2();
    publicationMocks.currentByDate.set('2026-07-04', {
      head: {
        date: '2026-07-04', release_generation: 2,
        page_publication_id: 'p'.repeat(64), video_publication_id: null,
        video_mode: 'none', page_manifest_digest: 'q'.repeat(64),
        video_manifest_digest: null, promoted_at_ms: 1,
      },
      page_metadata: { title: 'stale page' }, video: null,
    });
    publicationMocks.strictCurrentLoader.mockRejectedValue(
      new Error('PUBLICATION_FORMAL_AUTHORIZATION_STALE'),
    );

    await expect(generateDailyPage(makeEnv(db, r2), '2026-07-04'))
      .resolves.toMatchObject({ skipped: false, itemCount: 1 });
    expect(publicationMocks.pageRebuildCurrentLoader).toHaveBeenCalledTimes(1);
    expect(publicationMocks.strictCurrentLoader).not.toHaveBeenCalled();
  });

  test('存在前日 → 前日页面被重渲染,其 HTML 含指向本日的链接', async () => {
    setSelection({ x: ['x_list:1'] });
    const rowsById = new Map([['x_list:1', mkRow('x_list:1', 1)]]);
    const db = makeStatefulDb({ rowsById });
    const r2 = makeR2();
    const env = makeEnv(db, r2);

    // 先生成前一日 2026-07-03(此刻无后一日 → 归档链接)
    await generateDailyPage(env, '2026-07-03');
    expect(publicationMocks.htmlByDate.get('2026-07-03')).not.toContain('/daily/2026-07-04');

    // 再生成本日 2026-07-04 → 应重渲染 2026-07-03,令其「后一日」指向本日
    await generateDailyPage(env, '2026-07-04');
    const prevHtml = publicationMocks.htmlByDate.get('2026-07-03')!;
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
    expect(publicationMocks.htmlByDate.has('2026-07-04')).toBe(true);
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

  test('compatibility projection is denied when the shared final guard observes a current mutation', async () => {
    setSelection({ x: ['x_list:1'] });
    const rowsById = new Map([['x_list:1', mkRow('x_list:1', 1)]]);
    const db = makeStatefulDb({ rowsById });
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    publicationMocks.finalAuthorization.mockRejectedValueOnce(
      new Error('PUBLICATION_OUTWARD_AUTHORIZATION_STALE:source_or_manual_or_batch_mutated'),
    );

    await expect(generateDailyPage(makeEnv(db, makeR2(), { INDEXNOW_KEY: 'k' }), '2026-07-04'))
      .rejects.toThrow('PUBLICATION_OUTWARD_AUTHORIZATION_STALE');
    expect(db._dailyPages.has('2026-07-04')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('previous-day rebuild cannot leave a stale current release authorized for IndexNow', async () => {
    setSelection({ x: ['x_list:1'] });
    const rowsById = new Map([['x_list:1', mkRow('x_list:1', 1)]]);
    const db = makeStatefulDb({ rowsById });
    const r2 = makeR2();
    const env = makeEnv(db, r2, { INDEXNOW_KEY: 'k' });
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await generateDailyPage(env, '2026-07-03');
    publicationMocks.finalAuthorization.mockClear();
    fetchMock.mockClear();
    publicationMocks.finalAuthorization.mockImplementation(async () => {
      if (publicationMocks.finalAuthorization.mock.calls.length === 3) {
        throw new Error('PUBLICATION_OUTWARD_AUTHORIZATION_STALE:mutation_after_previous_day_rebuild');
      }
    });

    await expect(generateDailyPage(env, '2026-07-04'))
      .rejects.toThrow('PUBLICATION_OUTWARD_AUTHORIZATION_STALE');
    expect(fetchMock).not.toHaveBeenCalled();
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
    publicationMocks.sequence = 0;
    publicationMocks.reservations.clear();
    publicationMocks.currentByDate.clear();
    publicationMocks.htmlByDate.clear();
    publicationMocks.finalAuthorization.mockReset();
    publicationMocks.finalAuthorization.mockResolvedValue(undefined);
    publicationMocks.releaseSetAuthorization.mockReset();
    publicationMocks.releaseSetAuthorization.mockResolvedValue(undefined);
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
    expect(publicationMocks.htmlByDate.get('2026-07-01')).toContain(`${SITE}/daily/2026-07-02`);
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

  test('集合级最终授权捕获检查第二日时第一日的具体来源撤权,HTTP 为零', async () => {
    setSelection({ x: ['x_list:1'] });
    const rowsById = new Map([['x_list:1', mkRow('x_list:1', 1)]]);
    const dates = ['2026-07-01', '2026-07-02'];
    const sourceEnabled = new Map(dates.map((date) => [date, true]));
    publicationMocks.finalAuthorization.mockImplementation(async (_env, date: string, expected?: unknown) => {
      if (expected) return;
      if (date === dates[1]) sourceEnabled.set(dates[0], false);
      if (!sourceEnabled.get(date)) throw new Error(`source_disabled:${date}`);
    });
    publicationMocks.releaseSetAuthorization.mockImplementation(async (_env, guardedDates: string[]) => {
      const observed = new Map<string, boolean>();
      for (const date of guardedDates) {
        observed.set(date, Boolean(sourceEnabled.get(date)));
        if (date === dates[1]) sourceEnabled.set(dates[0], false);
      }
      if (guardedDates.some((date) => observed.get(date) !== sourceEnabled.get(date))) {
        throw new Error('PUBLICATION_OUTWARD_AUTHORIZATION_STALE:source_disabled');
      }
    });
    const env = makeEnv(
      makeStatefulDb({ rowsById, backfillDates: dates }), makeR2(), { INDEXNOW_KEY: 'k' },
    );
    const trace: string[] = [];
    const fetchMock = vi.fn(async () => {
      trace.push('http');
      return new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(backfillDailyPages(env)).rejects.toThrow(/AUTHORIZATION_STALE:source_disabled/);

    expect(sourceEnabled.get(dates[0])).toBe(false);
    expect(publicationMocks.releaseSetAuthorization).toHaveBeenCalledWith(env, dates);
    expect(trace).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('集合级最终授权绑定旧 head,检查第二日时第一日合法换代也不提交旧集合', async () => {
    setSelection({ x: ['x_list:1'] });
    const rowsById = new Map([['x_list:1', mkRow('x_list:1', 1)]]);
    const dates = ['2026-07-01', '2026-07-02'];
    const headGeneration = new Map(dates.map((date) => [date, 1]));
    publicationMocks.finalAuthorization.mockImplementation(async (_env, date: string, expected?: unknown) => {
      if (expected) return;
      if (date === dates[1]) headGeneration.set(dates[0], 2);
    });
    publicationMocks.releaseSetAuthorization.mockImplementation(async (_env, guardedDates: string[]) => {
      const observed = new Map<string, number>();
      for (const date of guardedDates) {
        observed.set(date, Number(headGeneration.get(date)));
        if (date === dates[1]) headGeneration.set(dates[0], 2);
      }
      if (guardedDates.some((date) => observed.get(date) !== headGeneration.get(date))) {
        throw new Error('PUBLICATION_OUTWARD_AUTHORIZATION_STALE:head_superseded');
      }
    });
    const env = makeEnv(
      makeStatefulDb({ rowsById, backfillDates: dates }), makeR2(), { INDEXNOW_KEY: 'k' },
    );
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(backfillDailyPages(env)).rejects.toThrow(/AUTHORIZATION_STALE:head_superseded/);

    expect(headGeneration.get(dates[0])).toBe(2);
    expect(publicationMocks.releaseSetAuthorization).toHaveBeenCalledWith(env, dates);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
