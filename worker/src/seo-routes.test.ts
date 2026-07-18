import { describe, test, expect } from 'vitest';
import { isSeoPath, handleSeoRoute } from './seo-routes';
import type { Env } from './index';

const SITE = 'https://ai-feeds.com';
const API = 'https://api.ai-feeds.com';

interface DailyPageRow {
  date: string;
  title: string;
  item_count: number;
  generated_at: string;
  lastmod?: string | null;
}

// 有序 daily_pages 行(测试传入即视为最终顺序;handler SQL 用 ORDER BY date DESC)。
// mock 支持 SQL 里的 LIMIT N 截断(llms.txt 最近 7 天)。
function makeDb(rows: DailyPageRow[]) {
  return {
    prepare(sql: string) {
      const stmt = {
        bind() {
          return stmt;
        },
        async all<T>() {
          if (/FROM daily_pages/i.test(sql)) {
            let out = [...rows];
            const m = sql.match(/LIMIT\s+(\d+)/i);
            if (m) out = out.slice(0, Number(m[1]));
            return { results: out as unknown as T[] };
          }
          return { results: [] as T[] };
        },
        async first<T>() {
          return null as T | null;
        },
        async run() {
          return { success: true };
        },
      };
      return stmt;
    },
  };
}

// R2 mock:store 命中返回 { body }(字符串直接喂 Response 即可),miss 返回 null。
function makeR2(store: Map<string, string> = new Map()) {
  return {
    store,
    async get(key: string) {
      if (store.has(key)) return { body: store.get(key)! };
      return null;
    },
  };
}

function makeEnv(over: Partial<Env> = {}, db: unknown = makeDb([]), r2: unknown = makeR2()): Env {
  return { SITE_BASE: SITE, API_BASE: API, DB: db, READMES: r2, ...over } as unknown as Env;
}

function req(path: string, method = 'GET'): Request {
  return new Request(`${API}${path}`, { method });
}

function mkRow(date: string, title = `AI 日报 ${date} · 主题 | AI Feeds`): DailyPageRow {
  return { date, title, item_count: 10, generated_at: `${date}T00:12:34.000Z` };
}

describe('isSeoPath', () => {
  test('日报深链 / 归档 / SEO 文件 → true', () => {
    expect(isSeoPath('/daily/2026-07-06')).toBe(true);
    expect(isSeoPath('/daily')).toBe(true);
    expect(isSeoPath('/daily/')).toBe(true);
    expect(isSeoPath('/daily/abc')).toBe(true);
    expect(isSeoPath('/robots.txt')).toBe(true);
    expect(isSeoPath('/sitemap.xml')).toBe(true);
    expect(isSeoPath('/video-sitemap.xml')).toBe(true);
    expect(isSeoPath('/llms.txt')).toBe(true);
    expect(isSeoPath('/abc123def.txt')).toBe(true); // indexnow key 文件(根目录 .txt)
    expect(isSeoPath('/archive/')).toBe(true);
    expect(isSeoPath('/archive/x/2026-07/2')).toBe(true);
    expect(isSeoPath('/sitemap-archive.xml')).toBe(true);
  });

  test('业务 / 鉴权路径 → false', () => {
    expect(isSeoPath('/api/items')).toBe(false);
    expect(isSeoPath('/')).toBe(false);
    expect(isSeoPath('/settings')).toBe(false);
    expect(isSeoPath('/dailyish')).toBe(false);
    expect(isSeoPath('/r/foo.txt')).toBe(false); // 非根目录 .txt
  });
});

interface ArchiveSeed {
  id: string;
  source: 'x' | 'gh' | 'ph' | 'hf-paper' | 'news';
  url_path: string;
  title: string;
  author?: string | null;
  published_at: string;
}

function makeArchiveDb(seed: ArchiveSeed[]) {
  return {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          binds = values;
          return stmt;
        },
        async all<T>() {
          if (/FROM daily_pages/i.test(sql) || /FROM daily_videos/i.test(sql)) {
            return { results: [] as T[] };
          }
          if (/FROM item_pages WHERE status = 'live' GROUP BY source/i.test(sql)) {
            const counts = new Map<string, number>();
            for (const row of seed) counts.set(row.source, (counts.get(row.source) || 0) + 1);
            return {
              results: [...counts].map(([source, c]) => ({
                source,
                c,
                m: '2026-07-17T00:00:00Z',
              })) as T[],
            };
          }
          if (/GROUP BY (?:p\.)?source,\s*month/i.test(sql)) {
            const groups = new Map<string, { source: string; month: string; item_count: number }>();
            for (const row of seed) {
              const month = row.published_at.slice(0, 7);
              const key = `${row.source}:${month}`;
              const group = groups.get(key) || { source: row.source, month, item_count: 0 };
              group.item_count++;
              groups.set(key, group);
            }
            return { results: [...groups.values()] as T[] };
          }
          if (/GROUP BY month/i.test(sql)) {
            const source = String(binds[0]);
            const counts = new Map<string, number>();
            for (const row of seed.filter((entry) => entry.source === source)) {
              const month = row.published_at.slice(0, 7);
              counts.set(month, (counts.get(month) || 0) + 1);
            }
            return {
              results: [...counts]
                .sort(([a], [b]) => b.localeCompare(a))
                .map(([month, item_count]) => ({ month, item_count })) as T[],
            };
          }
          if (/JOIN item_pages p ON p\.item_id = i\.id/i.test(sql)) {
            const [source, month, limit, offset] = binds as [string, string, number, number];
            const rows = seed
              .filter((row) => row.source === source && row.published_at.startsWith(month))
              .sort(
                (a, b) =>
                  b.published_at.localeCompare(a.published_at) || b.id.localeCompare(a.id),
              )
              .slice(offset, offset + limit);
            return { results: rows as T[] };
          }
          return { results: [] as T[] };
        },
        async first<T>() {
          if (/SELECT COUNT\(\*\) AS item_count/i.test(sql)) {
            const [source, month] = binds.map(String);
            return {
              item_count: seed.filter(
                (row) => row.source === source && row.published_at.startsWith(month),
              ).length,
            } as T;
          }
          return null as T | null;
        },
        async run() {
          return { success: true };
        },
      };
      return stmt;
    },
  };
}

function archiveRows(count: number): ArchiveSeed[] {
  return Array.from({ length: count }, (_, index) => {
    const n = String(index + 1).padStart(3, '0');
    return {
      id: `x_list:${n}`,
      source: 'x',
      url_path: `/i/x/${n}`,
      title: `归档条目 ${n}`,
      author: `作者 ${n}`,
      published_at: `2026-07-${String((index % 28) + 1).padStart(2, '0')}T08:00:00Z`,
    };
  });
}

describe('handleSeoRoute 内容归档', () => {
  test('/archive/ 是可抓取 SSR index，含唯一 h1、self canonical 与五个源普通链接', async () => {
    const resp = await handleSeoRoute(req('/archive/'), makeEnv({}, makeArchiveDb(archiveRows(2))));
    expect(resp!.status).toBe(200);
    const body = await resp!.text();
    expect((body.match(/<h1[\s>]/g) || []).length).toBe(1);
    expect(body).toContain(`<link rel="canonical" href="${SITE}/archive/">`);
    for (const source of ['x', 'gh', 'ph', 'paper', 'news']) {
      expect(body).toContain(`<a href="${SITE}/archive/${source}/"`);
    }
  });

  test('source 页面列出月份；month 分页只使用 url_path，page 1 不产生 canonical /1', async () => {
    const db = makeArchiveDb(archiveRows(101));
    const sourceResp = await handleSeoRoute(req('/archive/x/'), makeEnv({}, db));
    expect(sourceResp!.status).toBe(200);
    expect(await sourceResp!.text()).toContain(`<a href="${SITE}/archive/x/2026-07/"`);

    const first = await handleSeoRoute(req('/archive/x/2026-07/'), makeEnv({}, db));
    expect(first!.status).toBe(200);
    const firstBody = await first!.text();
    expect(firstBody).toContain(`<link rel="canonical" href="${SITE}/archive/x/2026-07/">`);
    expect(firstBody).not.toContain('/archive/x/2026-07/1"');
    expect(firstBody).toContain(`href="${SITE}/i/x/`);
    expect(firstBody).toContain(`<a rel="next" href="${SITE}/archive/x/2026-07/2">`);

    const second = await handleSeoRoute(req('/archive/x/2026-07/2'), makeEnv({}, db));
    expect(second!.status).toBe(200);
    const secondBody = await second!.text();
    expect(secondBody).toContain(
      `<link rel="canonical" href="${SITE}/archive/x/2026-07/2">`,
    );
    expect(secondBody).toContain(`<a rel="prev" href="${SITE}/archive/x/2026-07/">`);
    expect((secondBody.match(/class="archive-item"/g) || []).length).toBe(1);
  });

  test('月归档第一页直接链接所有分页，使任意 item 的 crawl depth 不随页数线性增长', async () => {
    const db = makeArchiveDb(archiveRows(301));
    const first = await handleSeoRoute(req('/archive/x/2026-07/'), makeEnv({}, db));
    const body = await first!.text();
    for (const page of [2, 3, 4]) {
      expect(body).toContain(`href="${SITE}/archive/x/2026-07/${page}"`);
    }
  });

  test('空月与越界页返回 noindex 404，非法 source/month/page 也不落 SPA', async () => {
    const db = makeArchiveDb(archiveRows(1));
    for (const path of [
      '/archive/x/2026-06/',
      '/archive/x/2026-07/2',
      '/archive/nope/',
      '/archive/x/2026-13/',
      '/archive/x/2026-07/0',
    ]) {
      const resp = await handleSeoRoute(req(path), makeEnv({}, db));
      expect(resp, path).not.toBeNull();
      expect(resp!.status, path).toBe(404);
      expect(await resp!.text(), path).toContain('name="robots" content="noindex"');
    }
  });

  test('sitemap index 引用独立 archive sitemap；archive sitemap 枚举 index/source/month/page', async () => {
    const db = makeArchiveDb(archiveRows(101));
    const indexResp = await handleSeoRoute(req('/sitemap.xml'), makeEnv({}, db));
    expect(await indexResp!.text()).toContain(`${SITE}/sitemap-archive.xml`);

    const archiveResp = await handleSeoRoute(req('/sitemap-archive.xml'), makeEnv({}, db));
    expect(archiveResp!.status).toBe(200);
    const xml = await archiveResp!.text();
    for (const path of ['/archive/', '/archive/x/', '/archive/x/2026-07/', '/archive/x/2026-07/2']) {
      expect(xml).toContain(`${SITE}${path}`);
    }
  });
});

describe('handleSeoRoute /daily/:date', () => {
  test('合法日期 R2 命中 → 200 + text/html + Cache-Control 3600', async () => {
    const r2 = makeR2(new Map([['daily/2026-07-06.html', '<!doctype html><title>x</title>']]));
    const resp = await handleSeoRoute(req('/daily/2026-07-06'), makeEnv({}, makeDb([]), r2));
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(200);
    expect(resp!.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(resp!.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect(await resp!.text()).toContain('<!doctype html>');
  });

  test('合法日期 R2 miss → 404 HTML 含返回 /daily/ 链接', async () => {
    const resp = await handleSeoRoute(req('/daily/2026-07-06'), makeEnv({}, makeDb([]), makeR2()));
    expect(resp!.status).toBe(404);
    expect(resp!.headers.get('Content-Type')).toContain('text/html');
    const body = await resp!.text();
    expect(body).toContain('/daily/');
  });

  test('非法日期 /daily/2026-13-99 → 302 Location 绝对归档 URL', async () => {
    const resp = await handleSeoRoute(req('/daily/2026-13-99'), makeEnv());
    expect(resp!.status).toBe(302);
    expect(resp!.headers.get('Location')).toBe(`${SITE}/daily/`);
  });

  test('非日期 /daily/abc → 302 归档', async () => {
    const resp = await handleSeoRoute(req('/daily/abc'), makeEnv());
    expect(resp!.status).toBe(302);
    expect(resp!.headers.get('Location')).toBe(`${SITE}/daily/`);
  });
});

describe('handleSeoRoute 归档索引 /daily(/)', () => {
  test('/daily/ → 200 归档页,head 齐全 + 按月分组 + title 转义', async () => {
    const rows = [mkRow('2026-07-06'), mkRow('2026-07-01'), mkRow('2026-06-30', 'AI 日报 <script> 注入 | x')];
    const resp = await handleSeoRoute(req('/daily/'), makeEnv({}, makeDb(rows)));
    expect(resp!.status).toBe(200);
    expect(resp!.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(resp!.headers.get('Cache-Control')).toBe('public, max-age=3600');
    const html = await resp!.text();
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('<title>AI 日报归档 | AI Feeds</title>');
    expect(html).toContain(`<link rel="canonical" href="${SITE}/daily/">`);
    expect(html).toContain('name="description"');
    // 月份分组(倒序):2026-07 在 2026-06 之前
    expect(html.indexOf('2026-07')).toBeLessThan(html.indexOf('2026-06'));
    // 外部 title 字段 HTML 转义
    expect(html).not.toContain('<script> 注入');
    expect(html).toContain('&lt;script&gt;');
    // 零可执行 script
    expect(html).not.toMatch(/<script(?![^>]*application\/ld\+json)/i);
  });

  test('/daily(无斜杠) → 也走归档索引 200', async () => {
    const resp = await handleSeoRoute(req('/daily'), makeEnv({}, makeDb([mkRow('2026-07-06')])));
    expect(resp!.status).toBe(200);
    expect(await resp!.text()).toContain('AI 日报归档');
  });

  test('空表 → 归档页仍 200', async () => {
    const resp = await handleSeoRoute(req('/daily/'), makeEnv({}, makeDb([])));
    expect(resp!.status).toBe(200);
  });

  test('归档页 header 含显著「订阅」按钮(subscribe-btn + 绝对 URL)', async () => {
    const resp = await handleSeoRoute(req('/daily/'), makeEnv({}, makeDb([mkRow('2026-07-06')])));
    const html = await resp!.text();
    expect(html).toContain('class="subscribe-btn"');
    expect(html).toContain(`<a href="${SITE}/subscribe" class="subscribe-btn">订阅日报</a>`);
    const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
    expect(header).toContain('subscribe-btn');
  });
});

describe('handleSeoRoute /robots.txt', () => {
  test('含 Sitemap 行 + 5 条 Disallow + Cache 86400', async () => {
    const resp = await handleSeoRoute(req('/robots.txt'), makeEnv());
    expect(resp!.status).toBe(200);
    expect(resp!.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(resp!.headers.get('Cache-Control')).toBe('public, max-age=86400');
    const body = await resp!.text();
    expect(body).toContain(`Sitemap: ${SITE}/sitemap.xml`);
    for (const d of ['/api/', '/admin', '/settings', '/me/', '/unsubscribe']) {
      expect(body).toContain(`Disallow: ${d}`);
    }
    expect((body.match(/^Disallow: /gm) || []).length).toBe(5);
  });
});

// sitemap 分片 mock：同时支持 daily_pages 与 item_pages（COUNT GROUP BY + 分页 SELECT）。
// counts 传入时直接决定 GROUP BY 结果（模拟 >5 万而无需真造 5 万行）；否则从 items 数组统计。
interface ItemPageRow {
  item_id?: string;
  source: string;
  url_path: string;
  generated_at: string;
  status?: string;
  is_relevant?: number;
  deleted_at?: string | null;
  dedup_of?: string | null;
  cn_sensitive?: number;
}
interface VideoRow {
  date: string;
  title: string;
  description: string;
  duration_seconds: number;
  mp4_key: string;
  poster_key: string;
  uploaded_at: string;
  updated_at: string;
}
function makeSitemapDb({
  daily = [],
  items = [],
  videos = [],
  counts = null,
}: {
  daily?: DailyPageRow[];
  items?: ItemPageRow[];
  videos?: VideoRow[];
  counts?: Record<string, number> | null;
}) {
  const sitemapEligible = (it: ItemPageRow): boolean =>
    (it.status || 'live') === 'live' &&
    (it.is_relevant ?? 1) === 1 &&
    (it.deleted_at ?? null) == null &&
    (it.dedup_of ?? null) == null &&
    (it.cn_sensitive ?? 0) !== 1;
  const queryAppliesEligibility = (sql: string): boolean =>
    /\bitems\s+i\b/i.test(sql) &&
    /\bitem_pages\s+p\b/i.test(sql) &&
    /i\.is_relevant\s*=\s*1/i.test(sql) &&
    /i\.deleted_at\s+IS\s+NULL/i.test(sql) &&
    /dedup_of/i.test(sql) &&
    /cn_sensitive/i.test(sql);
  const queryUsesCanonicalRows = (sql: string): boolean =>
    /COUNT\(\s*DISTINCT\s+p\.url_path\s*\)/i.test(sql) ||
    /GROUP BY\s+p\.url_path/i.test(sql);
  const rowsForQuery = (sql: string): ItemPageRow[] => {
    const eligibleRows = queryAppliesEligibility(sql) ? items.filter(sitemapEligible) : items;
    if (!queryUsesCanonicalRows(sql)) return eligibleRows;
    const latestByPath = new Map<string, ItemPageRow>();
    for (const item of eligibleRows) {
      const key = `${item.source}\0${item.url_path}`;
      const current = latestByPath.get(key);
      if (
        !current ||
        item.generated_at > current.generated_at ||
        (item.generated_at === current.generated_at &&
          String(item.item_id || '') > String(current.item_id || ''))
      ) {
        latestByPath.set(key, item);
      }
    }
    return [...latestByPath.values()];
  };
  return {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async all<T>() {
          if (/FROM daily_videos/i.test(sql)) {
            return { results: [...videos] as unknown as T[] };
          }
          if (/GROUP BY (?:p\.)?source/i.test(sql)) {
            const map = new Map<string, { source: string; c: number; m: string }>();
            if (counts) {
              for (const [source, c] of Object.entries(counts)) {
                map.set(source, { source, c, m: '2026-07-06T09:00:00.000Z' });
              }
            } else {
              for (const it of rowsForQuery(sql)) {
                if ((it.status || 'live') !== 'live') continue;
                if (queryAppliesEligibility(sql) && !sitemapEligible(it)) continue;
                const e = map.get(it.source) || { source: it.source, c: 0, m: '' };
                e.c += 1;
                if (it.generated_at > e.m) e.m = it.generated_at;
                map.set(it.source, e);
              }
            }
            return { results: [...map.values()] as unknown as T[] };
          }
          if (/item_pages/i.test(sql)) {
            const [source, limit, offset] = binds as [string, number, number];
            let rows = rowsForQuery(sql)
              .filter((it) => it.source === source && (it.status || 'live') === 'live')
              .filter((it) => !queryAppliesEligibility(sql) || sitemapEligible(it))
              .sort((a, b) => (a.generated_at < b.generated_at ? 1 : -1));
            const off = Number(offset) || 0;
            const lim = limit == null ? rows.length : Number(limit);
            rows = rows.slice(off, off + lim);
            return {
              results: rows.map((r) => ({
                url_path: r.url_path,
                generated_at: r.generated_at,
              })) as unknown as T[],
            };
          }
          if (/FROM daily_pages/i.test(sql)) {
            let out = [...daily];
            const m = sql.match(/LIMIT\s+(\d+)/i);
            if (m) out = out.slice(0, Number(m[1]));
            return { results: out as unknown as T[] };
          }
          return { results: [] as T[] };
        },
        async first<T>() {
          return null as T | null;
        },
        async run() {
          return { success: true };
        },
      };
      return stmt;
    },
  };
}

function mkItem(
  source: string,
  url_path: string,
  generated_at = '2026-07-06T00:00:00.000Z',
  status = 'live',
): ItemPageRow {
  return { source, url_path, generated_at, status };
}

describe('handleSeoRoute /sitemap.xml (sitemap-index)', () => {
  test('合法 <sitemapindex>：列日报片 + 五源分片，无 <url> 条目', async () => {
    const resp = await handleSeoRoute(
      req('/sitemap.xml'),
      makeEnv({}, makeSitemapDb({ daily: [mkRow('2026-07-06')] })),
    );
    expect(resp!.status).toBe(200);
    expect(resp!.headers.get('Content-Type')).toContain('xml');
    expect(resp!.headers.get('Cache-Control')).toBe('public, max-age=3600');
    const xml = await resp!.text();
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml).toContain('<sitemapindex');
    expect(xml).toContain(`<loc>${SITE}/sitemap-daily.xml</loc>`);
    expect(xml).toContain(`<loc>${SITE}/video-sitemap.xml</loc>`);
    for (const s of ['x', 'gh', 'ph', 'hf-paper', 'news']) {
      expect(xml).toContain(`<loc>${SITE}/sitemap-${s}.xml</loc>`);
    }
    // index 只含 <sitemap> 条目，不得混入 <url>
    expect(xml).not.toContain('<url>');
    // 日报片 lastmod 用最新 generated_at 日期
    expect(xml).toContain('<lastmod>2026-07-06</lastmod>');
  });

  test('>5 万自动续片：某源大计数 → index 列出 -2 -3，未超源仅 page1', async () => {
    const resp = await handleSeoRoute(
      req('/sitemap.xml'),
      makeEnv({}, makeSitemapDb({ counts: { x: 120001 } })),
    );
    const xml = await resp!.text();
    expect(xml).toContain(`<loc>${SITE}/sitemap-x.xml</loc>`);
    expect(xml).toContain(`<loc>${SITE}/sitemap-x-2.xml</loc>`);
    expect(xml).toContain(`<loc>${SITE}/sitemap-x-3.xml</loc>`);
    expect(xml).not.toContain('sitemap-x-4.xml'); // 120001 → 恰 3 片
    expect(xml).not.toContain('sitemap-gh-2.xml'); // 其它源 count 0 → 仅 page1
  });

  test('回填旧日报视频时以所有日报中最大的 lastmod 更新日报 sitemap 条目', async () => {
    const newestDate = mkRow('2026-07-14');
    const backfilledOldDate = { ...mkRow('2026-06-20'), lastmod: '2026-07-15T09:10:11.000Z' };
    const resp = await handleSeoRoute(
      req('/sitemap.xml'),
      makeEnv({}, makeSitemapDb({ daily: [newestDate, backfilledOldDate] })),
    );
    const xml = await resp!.text();
    const dailyEntry = xml.slice(xml.indexOf(`${SITE}/sitemap-daily.xml`) - 60, xml.indexOf(`${SITE}/sitemap-daily.xml`) + 160);
    expect(dailyEntry).toContain('<lastmod>2026-07-15</lastmod>');
  });
});

describe('handleSeoRoute /video-sitemap.xml', () => {
  test('emits escaped Google video entries with landing/content/poster/publication/duration fields', async () => {
    const video: VideoRow = {
      date: '2026-07-14',
      title: 'AI & <模型> "日报"',
      description: 'A & B < C > D',
      duration_seconds: 125.25,
      mp4_key: 'daily-video/2026-07-14/a&b.mp4',
      poster_key: 'daily-video/2026-07-14/poster.jpg',
      uploaded_at: '2026-07-14T08:09:10.000Z',
      updated_at: '2026-07-14T09:10:11.000Z',
    };
    const resp = await handleSeoRoute(
      req('/video-sitemap.xml'),
      makeEnv({}, makeSitemapDb({ videos: [video] })),
    );
    expect(resp!.status).toBe(200);
    expect(resp!.headers.get('Content-Type')).toContain('application/xml');
    const xml = await resp!.text();
    expect(xml).toContain('xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"');
    expect(xml).toContain(`<loc>${SITE}/daily/2026-07-14</loc>`);
    expect(xml).toContain(`<video:thumbnail_loc>${API}/r/${video.poster_key}</video:thumbnail_loc>`);
    expect(xml).toContain('<video:title>AI &amp; &lt;模型&gt; &quot;日报&quot;</video:title>');
    expect(xml).toContain('<video:description>A &amp; B &lt; C &gt; D</video:description>');
    expect(xml).toContain(`<video:content_loc>${API}/r/daily-video/2026-07-14/a&amp;b.mp4</video:content_loc>`);
    expect(xml).toContain('<video:publication_date>2026-07-14T08:00:00+08:00</video:publication_date>');
    expect(xml).toContain('<video:duration>125</video:duration>');
  });

  test('description is truncated to 2048 characters before XML escaping', async () => {
    const description = `${'长'.repeat(2047)}&<尾`;
    const video: VideoRow = {
      date: '2026-07-14', title: '长描述', description, duration_seconds: 60,
      mp4_key: 'daily-video/2026-07-14/a.mp4',
      poster_key: 'daily-video/2026-07-14/b.jpg',
      uploaded_at: '2026-07-20T00:00:00.000Z',
      updated_at: '2026-07-20T00:00:00.000Z',
    };
    const resp = await handleSeoRoute(
      req('/video-sitemap.xml'),
      makeEnv({}, makeSitemapDb({ videos: [video] })),
    );
    const xml = await resp!.text();
    expect(xml).toContain(`<video:description>${'长'.repeat(2047)}&amp;</video:description>`);
    expect(xml).not.toContain('&lt;尾');
  });

  test('empty table still returns a valid namespaced urlset', async () => {
    const resp = await handleSeoRoute(req('/video-sitemap.xml'), makeEnv({}, makeSitemapDb({})));
    const xml = await resp!.text();
    expect(resp!.status).toBe(200);
    expect(xml).toContain('<urlset');
    expect(xml).not.toContain('<url>');
  });
});

describe('handleSeoRoute /sitemap-daily.xml (日报片回归)', () => {
  test('含 / 与 /daily/ 与全部日报页 URL（旧 sitemap 内容不丢）', async () => {
    const rows = [mkRow('2026-07-06'), mkRow('2026-07-05'), mkRow('2026-07-04')];
    const resp = await handleSeoRoute(
      req('/sitemap-daily.xml'),
      makeEnv({}, makeSitemapDb({ daily: rows })),
    );
    expect(resp!.status).toBe(200);
    expect(resp!.headers.get('Content-Type')).toContain('xml');
    expect(resp!.headers.get('Cache-Control')).toBe('public, max-age=3600');
    const xml = await resp!.text();
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml).toContain('<urlset');
    expect((xml.match(/<loc>/g) || []).length).toBe(rows.length + 2);
    expect(xml).toContain(`<loc>${SITE}/</loc>`);
    expect(xml).toContain(`<loc>${SITE}/daily/</loc>`);
    expect(xml).toContain(`<loc>${SITE}/daily/2026-07-06</loc>`);
    expect(xml).toContain('<lastmod>2026-07-06</lastmod>');
  });

  test('video publish lastmod overrides the original generated_at', async () => {
    const row = { ...mkRow('2026-07-06'), lastmod: '2026-07-14T09:10:11.000Z' };
    const resp = await handleSeoRoute(
      req('/sitemap-daily.xml'),
      makeEnv({}, makeSitemapDb({ daily: [row] })),
    );
    const xml = await resp!.text();
    expect(xml).toContain(`<loc>${SITE}/daily/2026-07-06</loc><lastmod>2026-07-14</lastmod>`);
  });

  test('首页和归档 lastmod 使用所有日报中的最大值而不是日期最新一行', async () => {
    const rows = [
      mkRow('2026-07-14'),
      { ...mkRow('2026-06-20'), lastmod: '2026-07-15T09:10:11.000Z' },
    ];
    const resp = await handleSeoRoute(
      req('/sitemap-daily.xml'),
      makeEnv({}, makeSitemapDb({ daily: rows })),
    );
    const xml = await resp!.text();
    expect(xml).toContain(`<loc>${SITE}/</loc><lastmod>2026-07-15</lastmod>`);
    expect(xml).toContain(`<loc>${SITE}/daily/</loc><lastmod>2026-07-15</lastmod>`);
  });

  test('空表 → 仅 / 与 /daily/ 两条', async () => {
    const resp = await handleSeoRoute(
      req('/sitemap-daily.xml'),
      makeEnv({}, makeSitemapDb({ daily: [] })),
    );
    const xml = await resp!.text();
    expect((xml.match(/<loc>/g) || []).length).toBe(2);
  });
});

describe('handleSeoRoute /sitemap-<source>.xml (内容片)', () => {
  test('/sitemap-x.xml 条目数 = live(source=x) 计数，gone 不入、异源不混入', async () => {
    const items = [
      mkItem('x', '/i/x/1'),
      mkItem('x', '/i/x/2'),
      mkItem('x', '/i/x/3', '2026-07-05T00:00:00.000Z', 'gone'),
      mkItem('gh', '/i/gh/a/b'),
    ];
    const resp = await handleSeoRoute(req('/sitemap-x.xml'), makeEnv({}, makeSitemapDb({ items })));
    expect(resp!.status).toBe(200);
    expect(resp!.headers.get('Content-Type')).toContain('xml');
    expect(resp!.headers.get('Cache-Control')).toBe('public, max-age=3600');
    const xml = await resp!.text();
    expect(xml).toContain('<urlset');
    expect((xml.match(/<loc>/g) || []).length).toBe(2);
    expect(xml).toContain(`<loc>${SITE}/i/x/1</loc>`);
    expect(xml).toContain(`<loc>${SITE}/i/x/2</loc>`);
    expect(xml).not.toContain('/i/x/3'); // gone 排除
    expect(xml).not.toContain('/i/gh/'); // 异源不混入
    expect(xml).toContain('<lastmod>2026-07-06</lastmod>');
  });

  test('已 live 但不再符合内容门禁的陈旧页面不进入内容 sitemap', async () => {
    const items: ItemPageRow[] = [
      { ...mkItem('news', '/i/news/eligible'), item_id: 'blog:eligible' },
      {
        ...mkItem('news', '/i/news/sensitive'),
        item_id: 'blog:sensitive',
        cn_sensitive: 1,
      },
      {
        ...mkItem('news', '/i/news/dedup'),
        item_id: 'blog:dedup',
        dedup_of: 'blog:eligible',
      },
      {
        ...mkItem('news', '/i/news/deleted'),
        item_id: 'blog:deleted',
        deleted_at: '2026-07-16T00:00:00Z',
      },
      {
        ...mkItem('news', '/i/news/irrelevant'),
        item_id: 'blog:irrelevant',
        is_relevant: 0,
      },
    ];

    const resp = await handleSeoRoute(
      req('/sitemap-news.xml'),
      makeEnv({}, makeSitemapDb({ items })),
    );
    const xml = await resp!.text();
    expect((xml.match(/<loc>/g) || []).length).toBe(1);
    expect(xml).toContain(`${SITE}/i/news/eligible`);
    expect(xml).not.toContain('/i/news/sensitive');
    expect(xml).not.toContain('/i/news/dedup');
    expect(xml).not.toContain('/i/news/deleted');
    expect(xml).not.toContain('/i/news/irrelevant');
  });

  test('/sitemap-hf-paper.xml（源名含连字符）正确分片', async () => {
    const items = [mkItem('hf-paper', '/i/paper/2501.1'), mkItem('hf-paper', '/i/paper/2502.2')];
    const resp = await handleSeoRoute(
      req('/sitemap-hf-paper.xml'),
      makeEnv({}, makeSitemapDb({ items })),
    );
    expect(resp!.status).toBe(200);
    const xml = await resp!.text();
    expect((xml.match(/<loc>/g) || []).length).toBe(2);
    expect(xml).toContain(`<loc>${SITE}/i/paper/2501.1</loc>`);
    expect(xml).toContain(`<loc>${SITE}/i/paper/2502.2</loc>`);
  });

  test('同一 PH canonical 的多日期记录只输出最新代表行一次', async () => {
    const items: ItemPageRow[] = [
      {
        ...mkItem('ph', '/i/ph/repeat', '2026-05-11T07:00:00Z'),
        item_id: 'product_hunt:repeat:2026-05-11',
      },
      {
        ...mkItem('ph', '/i/ph/repeat', '2026-06-12T07:00:00Z'),
        item_id: 'product_hunt:repeat:2026-06-12',
      },
      {
        ...mkItem('ph', '/i/ph/repeat', '2026-07-13T07:00:00Z'),
        item_id: 'product_hunt:repeat:2026-07-13',
        cn_sensitive: 1,
      },
    ];
    const resp = await handleSeoRoute(
      req('/sitemap-ph.xml'),
      makeEnv({}, makeSitemapDb({ items })),
    );
    const xml = await resp!.text();

    expect((xml.match(new RegExp(`<loc>${SITE}/i/ph/repeat</loc>`, 'g')) || []).length).toBe(1);
    expect(xml).toContain('<lastmod>2026-06-12</lastmod>');
  });

  test('sitemap index 先按 canonical URL 去重再统计分片', async () => {
    const db = {
      prepare(sql: string) {
        const stmt = {
          bind() {
            return stmt;
          },
          async all<T>() {
            if (/GROUP BY p\.source/i.test(sql)) {
              expect(sql).toMatch(/COUNT\(\s*DISTINCT\s+p\.url_path\s*\)/i);
              return {
                results: [{ source: 'ph', c: 1, m: '2026-06-12T07:00:00Z' }] as T[],
              };
            }
            return { results: [] as T[] };
          },
          async first<T>() {
            return null as T | null;
          },
          async run() {
            return { success: true };
          },
        };
        return stmt;
      },
    };
    const resp = await handleSeoRoute(req('/sitemap.xml'), makeEnv({}, db));
    expect(resp!.status).toBe(200);
  });

  test('续片路径 /sitemap-x-2.xml 走第 2 页（OFFSET 生效，越界返回空 urlset）', async () => {
    const items = [mkItem('x', '/i/x/1'), mkItem('x', '/i/x/2')];
    const resp = await handleSeoRoute(
      req('/sitemap-x-2.xml'),
      makeEnv({}, makeSitemapDb({ items })),
    );
    expect(resp!.status).toBe(200);
    const xml = await resp!.text();
    expect(xml).toContain('<urlset');
    expect((xml.match(/<loc>/g) || []).length).toBe(0);
  });

  test('未知源 /sitemap-foo.xml → 404', async () => {
    const resp = await handleSeoRoute(req('/sitemap-foo.xml'), makeEnv({}, makeSitemapDb({})));
    expect(resp!.status).toBe(404);
  });

  test('非法续片 /sitemap-x-1.xml（page1 应为无后缀）→ 404', async () => {
    const resp = await handleSeoRoute(req('/sitemap-x-1.xml'), makeEnv({}, makeSitemapDb({})));
    expect(resp!.status).toBe(404);
  });
});

describe('handleSeoRoute /llms.txt', () => {
  test('mock 10 行 → 只出最近 7 条日报链接 + Cache 86400', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => {
      const d = `2026-07-${String(20 - i).padStart(2, '0')}`;
      return mkRow(d);
    });
    const resp = await handleSeoRoute(req('/llms.txt'), makeEnv({}, makeDb(rows)));
    expect(resp!.status).toBe(200);
    expect(resp!.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(resp!.headers.get('Cache-Control')).toBe('public, max-age=86400');
    const body = await resp!.text();
    const dailyLinks = body.match(/\/daily\/\d{4}-\d{2}-\d{2}/g) || [];
    expect(dailyLinks.length).toBe(7);
    expect(body).toContain(`${SITE}/daily/`); // 归档入口
  });
});

describe('handleSeoRoute IndexNow key 文件', () => {
  test('配置 INDEXNOW_KEY 且路径匹配 → 200 key 纯文本', async () => {
    const key = 'abc123def456';
    const resp = await handleSeoRoute(req(`/${key}.txt`), makeEnv({ INDEXNOW_KEY: key }));
    expect(resp!.status).toBe(200);
    expect(resp!.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(resp!.headers.get('Cache-Control')).toBe('public, max-age=86400');
    expect((await resp!.text()).trim()).toBe(key);
  });

  test('未配置 INDEXNOW_KEY → .txt 请求 404', async () => {
    const resp = await handleSeoRoute(req('/abc123def456.txt'), makeEnv());
    expect(resp!.status).toBe(404);
  });

  test('配置 key 但路径不匹配 → 404', async () => {
    const resp = await handleSeoRoute(req('/wrongkey.txt'), makeEnv({ INDEXNOW_KEY: 'realkey' }));
    expect(resp!.status).toBe(404);
  });
});

describe('handleSeoRoute 非本模块路径', () => {
  test('/api/items → null(继续后续匹配)', async () => {
    expect(await handleSeoRoute(req('/api/items'), makeEnv())).toBeNull();
  });
  test('POST /daily/2026-07-06 → null(非 GET/HEAD)', async () => {
    expect(await handleSeoRoute(req('/daily/2026-07-06', 'POST'), makeEnv())).toBeNull();
  });
});
