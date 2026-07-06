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

describe('handleSeoRoute /sitemap.xml', () => {
  test('条目数 = 行数 + 2 且 XML 前缀合法', async () => {
    const rows = [mkRow('2026-07-06'), mkRow('2026-07-05'), mkRow('2026-07-04')];
    const resp = await handleSeoRoute(req('/sitemap.xml'), makeEnv({}, makeDb(rows)));
    expect(resp!.status).toBe(200);
    expect(resp!.headers.get('Content-Type')).toContain('xml');
    expect(resp!.headers.get('Cache-Control')).toBe('public, max-age=3600');
    const xml = await resp!.text();
    expect(xml.startsWith('<?xml')).toBe(true);
    expect((xml.match(/<loc>/g) || []).length).toBe(rows.length + 2);
    expect(xml).toContain(`<loc>${SITE}/</loc>`);
    expect(xml).toContain(`<loc>${SITE}/daily/</loc>`);
    expect(xml).toContain(`<loc>${SITE}/daily/2026-07-06</loc>`);
    // lastmod 用 generated_at 日期部分
    expect(xml).toContain('<lastmod>2026-07-06</lastmod>');
  });

  test('空表 → 仅 / 与 /daily/ 两条', async () => {
    const resp = await handleSeoRoute(req('/sitemap.xml'), makeEnv({}, makeDb([])));
    const xml = await resp!.text();
    expect((xml.match(/<loc>/g) || []).length).toBe(2);
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
