// 公开 SEO 伺服路由:/daily/* 日报深链 + 归档索引、robots.txt、sitemap.xml、llms.txt、
// IndexNow key 文件。设计文档:docs/plans/2026-07-06-daily-static-page-seo-design.md §4.5-§4.9
//
// isSeoPath(pathname)              —— bot UA gate 豁免判定(index.ts 里与 isBotGateExempt 并联)
// handleSeoRoute(request, env)     —— 命中返回 Response;非本模块路径返回 null → index.ts 继续后续匹配
//
// 关键约定:
// - 绝对 URL 一律 env.SITE_BASE(getBases),禁止取 request host(HK 中转会改写 Host,2026-06-08 事故)
// - 归档索引 / 404 / robots / sitemap / llms 全部零可执行 <script>;外部 title 字段一律 escapeHtml
// - 缓存头按设计 §4.5 表:日报页/归档/sitemap = 3600;robots/llms/indexnow-key = 86400

import type { Env } from './index';
import { getBases } from './digest/lib';
import { escapeHtml } from './digest/templates';

// 根目录单段 .txt 文件(robots.txt / llms.txt / <indexnow-key>.txt)。sitemap.xml 另判。
const ROOT_TXT_RE = /^\/[A-Za-z0-9._-]+\.txt$/;
// sitemap 分片:/sitemap-<source>.xml、/sitemap-<source>-<n>.xml(Task 6 分源分片,伺服由 handleSeoRoute 出)。
const SITEMAP_SHARD_RE = /^\/sitemap-[a-z0-9-]+\.xml$/;
// 日报深链:严格 YYYY-MM-DD 形状(真实性再由 isValidCalendarDate 校验,拦 2026-13-99)。
const DAILY_DATE_RE = /^\/daily\/(\d{4}-\d{2}-\d{2})$/;

// bot gate 豁免:上述全部公开路径跳过 UA 闸,确保搜索引擎 / AI 检索 / 训练爬虫可达(放行策略收口 robots.txt)。
// 无 env 参数(签名固定),故 indexnow key 文件按"根目录 .txt"整体豁免,真实 key 校验在 handleSeoRoute。
export function isSeoPath(pathname: string): boolean {
  if (pathname === '/daily' || pathname.startsWith('/daily/')) return true;
  // item SSR 静态页 /i/…（伺服由 seo/item-routes.ts handleItemRoute 出）。裸 /i 不放行。
  if (pathname.startsWith('/i/')) return true;
  if (pathname === '/sitemap.xml') return true;
  if (SITEMAP_SHARD_RE.test(pathname)) return true;
  if (ROOT_TXT_RE.test(pathname)) return true;
  return false;
}

// 严格日历日期校验:形状对但月/日越界(2026-13-99)→ false。用 UTC round-trip 拦 JS Date 溢出滚动。
function isValidCalendarDate(s: string): boolean {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const [, y, mo, d] = m;
  const dt = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return false;
  return (
    dt.getUTCFullYear() === Number(y) &&
    dt.getUTCMonth() + 1 === Number(mo) &&
    dt.getUTCDate() === Number(d)
  );
}

function html(body: string, status: number, maxAge: number | null): Response {
  const headers: Record<string, string> = { 'Content-Type': 'text/html; charset=utf-8' };
  headers['Cache-Control'] = maxAge === null ? 'no-store' : `public, max-age=${maxAge}`;
  return new Response(body, { status, headers });
}

function text(body: string, status: number, maxAge: number): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': `public, max-age=${maxAge}`,
    },
  });
}

function redirectArchive(env: Env): Response {
  const { siteBase } = getBases(env);
  return Response.redirect(`${siteBase}/daily/`, 302);
}

interface DailyPageRow {
  date: string;
  title: string;
  item_count: number;
  generated_at: string;
}

async function loadDailyPages(env: Env, limit?: number): Promise<DailyPageRow[]> {
  const sql =
    `SELECT date, title, item_count, generated_at FROM daily_pages ORDER BY date DESC` +
    (limit ? ` LIMIT ${limit}` : '');
  const r = await env.DB.prepare(sql).all<DailyPageRow>();
  return r.results || [];
}

// ── /daily/:date 伺服 ──────────────────────────────────────────
// 合法日期命中 R2 → 200 静态 HTML;miss → 简洁 404 页(含返回归档链接)。
async function serveDailyPage(env: Env, date: string): Promise<Response> {
  const { siteBase } = getBases(env);
  const obj = env.READMES ? await env.READMES.get(`daily/${date}.html`) : null;
  if (!obj) {
    const body = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>日报不存在 | AI Feeds</title>
<style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;background:#fafafa;color:#171717;line-height:1.65}.wrap{max-width:560px;margin:0 auto;padding:64px 20px;text-align:center}h1{font-size:20px}a{color:#0284c7;text-decoration:none}</style>
</head>
<body>
<div class="wrap">
<h1>这一天还没有日报</h1>
<p>该日期的 AI 日报暂未生成或不存在。</p>
<p><a href="${siteBase}/daily/">← 返回日报归档</a></p>
</div>
</body>
</html>`;
    return html(body, 404, null);
  }
  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

// ── /daily(/) 归档索引 ─────────────────────────────────────────
// 从 daily_pages 实时渲染,按月分组倒序。head 达日报页级别(lang / title / canonical / description)。
async function renderArchiveIndex(env: Env): Promise<Response> {
  const { siteBase } = getBases(env);
  const rows = await loadDailyPages(env); // 已 date DESC

  // 按 YYYY-MM 分组,保持倒序(rows 已 DESC,首次出现即最新月)。
  const groups: Array<{ month: string; items: DailyPageRow[] }> = [];
  const idx = new Map<string, number>();
  for (const row of rows) {
    const month = row.date.slice(0, 7);
    let gi = idx.get(month);
    if (gi === undefined) {
      gi = groups.length;
      idx.set(month, gi);
      groups.push({ month, items: [] });
    }
    groups[gi].items.push(row);
  }

  const desc = '按月归档的每日 AI 日报,汇总行业新闻、热门产品、开源项目、论文与 X 精选,中文摘要,每日更新。';
  const canonical = `${siteBase}/daily/`;

  const body: string[] = [];
  if (!groups.length) {
    body.push('<p class="empty">暂无日报。</p>');
  }
  for (const g of groups) {
    body.push(`<section><h2>${escapeHtml(g.month)}</h2><ul class="list">`);
    for (const it of g.items) {
      const label = `${escapeHtml(it.date)} · ${escapeHtml(it.title)}`;
      body.push(`<li><a href="${siteBase}/daily/${escapeHtml(it.date)}">${label}</a></li>`);
    }
    body.push('</ul></section>');
  }

  const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI 日报归档 | AI Feeds</title>
<meta name="description" content="${escapeHtml(desc)}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="AI 日报归档 | AI Feeds">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${canonical}">
<style>
:root{--text:#171717;--sub:#737373;--link:#0284c7;--border:#e5e5e5;--bg:#fafafa}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);line-height:1.65;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif;font-size:16px}
a{color:var(--link);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:720px;margin:0 auto;padding:20px 16px 48px}
header{border-bottom:1px solid var(--border);padding-bottom:16px;margin-bottom:8px}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:nowrap}
.brand{font-size:18px;font-weight:700}
.brand a{color:var(--text)}
.subscribe-btn{flex:none;white-space:nowrap;background:var(--link);color:#fff;
  padding:6px 14px;border-radius:6px;font-weight:600;font-size:14px}
.subscribe-btn:hover{background:#0369a1;text-decoration:none;color:#fff}
h1{font-size:22px;margin:16px 0 4px}
.lede{color:var(--sub);font-size:14px;margin:0}
section{margin-top:28px}
h2{font-size:16px;font-weight:700;border-left:3px solid var(--link);padding-left:10px;margin:0 0 8px}
.list{list-style:none;padding:0;margin:0}
.list li{padding:8px 0;border-bottom:1px solid var(--border);font-size:15px}
.empty{color:var(--sub)}
footer{margin-top:40px;padding-top:20px;border-top:1px solid var(--border);color:var(--sub);font-size:14px;display:flex;gap:16px;flex-wrap:wrap}
</style>
</head>
<body>
<div class="wrap">
<header>
<div class="top">
<div class="brand"><a href="${siteBase}/">AI Feeds</a></div>
<a href="${siteBase}/subscribe" class="subscribe-btn">订阅日报</a>
</div>
<h1>AI 日报归档</h1>
<p class="lede">${escapeHtml(desc)}</p>
</header>
<main>${body.join('')}</main>
<footer>
<a href="${siteBase}/">进站看全部</a>
<a href="${siteBase}/subscribe">订阅每日邮件</a>
</footer>
</div>
</body>
</html>`;
  return html(page, 200, 3600);
}

// ── robots.txt ─────────────────────────────────────────────────
// 决策 5 全放(含训练爬虫),仅屏蔽无收录价值/带鉴权路径。Sitemap 绝对 URL 走 SITE_BASE。
function robotsResponse(env: Env): Response {
  const { siteBase } = getBases(env);
  const body = `User-agent: *
Allow: /
Disallow: /api/
Disallow: /admin
Disallow: /settings
Disallow: /me/
Disallow: /unsubscribe

Sitemap: ${siteBase}/sitemap.xml
`;
  return text(body, 200, 86400);
}

// ── sitemap.xml ────────────────────────────────────────────────
// 条目:/ + /daily/ + 全部 daily_pages 行。lastmod 用 generated_at 日期部分;
// 首页/归档用表中最新 generated_at 日期(空表回落今日)。
async function sitemapResponse(env: Env): Promise<Response> {
  const { siteBase } = getBases(env);
  const rows = await loadDailyPages(env); // date DESC
  const latestMod = rows.length ? dateOnly(rows[0].generated_at) : dateOnly(new Date().toISOString());

  const urls: string[] = [];
  urls.push(urlEntry(`${siteBase}/`, latestMod, 'daily'));
  urls.push(urlEntry(`${siteBase}/daily/`, latestMod, 'daily'));
  for (const row of rows) {
    urls.push(urlEntry(`${siteBase}/daily/${row.date}`, dateOnly(row.generated_at), 'monthly'));
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;
  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

function dateOnly(iso: string): string {
  return String(iso).slice(0, 10);
}

function urlEntry(loc: string, lastmod: string, changefreq: string): string {
  return `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod><changefreq>${changefreq}</changefreq></url>`;
}

// ── llms.txt ───────────────────────────────────────────────────
// Markdown 纯文本:站点定位(中英各一行)+ 核心入口(归档 + 最近 7 天 + 订阅)+ 内容说明。
async function llmsResponse(env: Env): Promise<Response> {
  const { siteBase } = getBases(env);
  const rows = await loadDailyPages(env, 7); // 最近 7 天(date DESC LIMIT 7)

  const recent = rows.map((r) => `- [AI 日报 ${r.date}](${siteBase}/daily/${r.date})`).join('\n');
  const body = `# AI Feeds

AI Feeds 是一站式 AI 信息聚合看板,每日汇总五大来源的 AI 资讯并翻译为中文摘要。
AI Feeds is a one-stop AI news aggregator that curates and summarizes AI updates from five sources into Chinese digests daily.

## 核心入口

- [AI 日报归档](${siteBase}/daily/)
- [订阅每日邮件](${siteBase}/subscribe)

## 最近日报
${recent || '- 暂无'}

## 内容说明

- 来源:行业新闻、热门产品、开源项目、论文、X 精选(共五源)
- 每条内容含中文标题与摘要
- 每日北京时间 8:00 更新
`;
  return text(body, 200, 86400);
}

// ── IndexNow key 文件 ──────────────────────────────────────────
// 配置 INDEXNOW_KEY 且路径 = /<key>.txt → 返回 key 纯文本;否则(未配置 / key 不匹配)→ 404。
function indexNowResponse(env: Env, pathname: string): Response {
  if (env.INDEXNOW_KEY && pathname === `/${env.INDEXNOW_KEY}.txt`) {
    return text(env.INDEXNOW_KEY, 200, 86400);
  }
  // 未配置 / key 不匹配的根目录 .txt → 404,no-store(避免 key 后续配置时命中被 404 边缘缓存)
  return new Response('Not Found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function handleSeoRoute(request: Request, env: Env): Promise<Response | null> {
  const method = request.method;
  // 仅伺服 GET/HEAD;其它方法(POST 等)交还 index.ts 后续匹配 / 兜底 404。
  if (method !== 'GET' && method !== 'HEAD') return null;

  const url = new URL(request.url);
  const pathname = url.pathname;

  // /daily/:date(严格日期形状)→ R2 命中 200 / miss 404;形状对但越界日期落到下方 302。
  const dateMatch = pathname.match(DAILY_DATE_RE);
  if (dateMatch) {
    const date = dateMatch[1];
    if (isValidCalendarDate(date)) return serveDailyPage(env, date);
    return redirectArchive(env); // 2026-13-99 之类
  }

  // /daily 或 /daily/ → 归档索引
  if (pathname === '/daily' || pathname === '/daily/') return renderArchiveIndex(env);

  // /daily/<其它非法>(如 /daily/abc、/daily/2026-07)→ 302 归档
  if (pathname.startsWith('/daily/')) return redirectArchive(env);

  if (pathname === '/robots.txt') return robotsResponse(env);
  if (pathname === '/llms.txt') return llmsResponse(env);
  if (pathname === '/sitemap.xml') return sitemapResponse(env);

  // 其余根目录 .txt → IndexNow key 文件(命中返回 key;未配置/不匹配 404)
  if (ROOT_TXT_RE.test(pathname)) return indexNowResponse(env, pathname);

  return null; // 非本模块路径,index.ts 继续后续匹配
}
