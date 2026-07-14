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
  });

  test('业务 / 鉴权路径 → false', () => {
    expect(isSeoPath('/api/items')).toBe(false);
    expect(isSeoPath('/')).toBe(false);
    expect(isSeoPath('/settings')).toBe(false);
    expect(isSeoPath('/dailyish')).toBe(false);
    expect(isSeoPath('/r/foo.txt')).toBe(false); // 非根目录 .txt
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
  source: string;
  url_path: string;
  generated_at: string;
  status?: string;
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
          if (/GROUP BY source/i.test(sql)) {
            const map = new Map<string, { source: string; c: number; m: string }>();
            if (counts) {
              for (const [source, c] of Object.entries(counts)) {
                map.set(source, { source, c, m: '2026-07-06T09:00:00.000Z' });
              }
            } else {
              for (const it of items) {
                if ((it.status || 'live') !== 'live') continue;
                const e = map.get(it.source) || { source: it.source, c: 0, m: '' };
                e.c += 1;
                if (it.generated_at > e.m) e.m = it.generated_at;
                map.set(it.source, e);
              }
            }
            return { results: [...map.values()] as unknown as T[] };
          }
          if (/FROM item_pages/i.test(sql)) {
            const [source, limit, offset] = binds as [string, number, number];
            let rows = items
              .filter((it) => it.source === source && (it.status || 'live') === 'live')
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
