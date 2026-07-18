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
import type { DailyVideoRow } from './digest/daily-video';
import { dailyVideoPublicationDate } from './digest/daily-page';
import {
  ARCHIVE_PAGE_SIZE,
  ARCHIVE_SOURCES,
  ARCHIVE_SOURCE_LABELS,
  ITEM_PAGE_ELIGIBILITY,
  archiveCanonicalPath,
  archiveCountQuery,
  archiveItemsQuery,
  archiveMonthsQuery,
  archiveSitemapGroupsQuery,
  parseItemArchivePath,
  type ArchiveItemRow,
  type ArchiveSource,
  type ItemArchiveRoute,
} from './seo/item-archive';

// 根目录单段 .txt 文件(robots.txt / llms.txt / <indexnow-key>.txt)。sitemap.xml 另判。
const ROOT_TXT_RE = /^\/[A-Za-z0-9._-]+\.txt$/;
// sitemap 分片:/sitemap-<source>.xml、/sitemap-<source>-<n>.xml(Task 6 分源分片,伺服由 handleSeoRoute 出)。
const SITEMAP_SHARD_RE = /^\/sitemap-[a-z0-9-]+\.xml$/;
// 日报深链:严格 YYYY-MM-DD 形状(真实性再由 isValidCalendarDate 校验,拦 2026-13-99)。
const DAILY_DATE_RE = /^\/daily\/(\d{4}-\d{2}-\d{2})$/;

// sitemap 分源分片(Task 6)。source 口径 = item_pages.source(DigestSource:x|gh|ph|hf-paper|news)。
// 单片上限 5 万(sitemaps.org 硬限);超则 /sitemap-<source>-2.xml、-3.xml 续片(page1 无后缀)。
const SITEMAP_SOURCES = ['x', 'gh', 'ph', 'hf-paper', 'news'] as const;
const SITEMAP_SHARD_SIZE = 50000;

// 解析 /sitemap-<source>.xml、/sitemap-<source>-<n>.xml(n≥2)→ { source, page }。
// 源名可含连字符(hf-paper),故按已知源集合逐一匹配,天然消解 hf-paper-2 的歧义(不会误拆为 hf-paper-2 源)。
// page1 只认无后缀形式(-1 视为非法,避免重复内容);未知源 / 非法后缀 → null(伺服层出 404)。
function parseSitemapShard(pathname: string): { source: string; page: number } | null {
  const m = pathname.match(/^\/sitemap-(.+)\.xml$/);
  if (!m) return null;
  const rest = m[1];
  for (const s of SITEMAP_SOURCES) {
    if (rest === s) return { source: s, page: 1 };
    const pm = rest.match(new RegExp(`^${s}-(\\d+)$`));
    if (pm) {
      const p = Number(pm[1]);
      if (p >= 2) return { source: s, page: p };
    }
  }
  return null;
}

// bot gate 豁免:上述全部公开路径跳过 UA 闸,确保搜索引擎 / AI 检索 / 训练爬虫可达(放行策略收口 robots.txt)。
// 无 env 参数(签名固定),故 indexnow key 文件按"根目录 .txt"整体豁免,真实 key 校验在 handleSeoRoute。
export function isSeoPath(pathname: string): boolean {
  if (pathname === '/daily' || pathname.startsWith('/daily/')) return true;
  if (pathname === '/archive' || pathname.startsWith('/archive/')) return true;
  // item SSR 静态页 /i/…（伺服由 seo/item-routes.ts handleItemRoute 出）。裸 /i 不放行。
  if (pathname.startsWith('/i/')) return true;
  if (pathname === '/sitemap.xml') return true;
  if (pathname === '/video-sitemap.xml') return true;
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
  lastmod?: string | null;
}

async function loadDailyPages(env: Env, limit?: number): Promise<DailyPageRow[]> {
  const sql =
    `SELECT date, title, item_count, generated_at, COALESCE(lastmod, generated_at) AS lastmod
       FROM daily_pages ORDER BY date DESC` +
    (limit ? ` LIMIT ${limit}` : '');
  const r = await env.DB.prepare(sql).all<DailyPageRow>();
  return r.results || [];
}

async function loadDailyVideos(env: Env): Promise<DailyVideoRow[]> {
  const result = await env.DB.prepare(
    `SELECT date, title, description, duration_seconds,
            mp4_key, mp4_sha256, mp4_size,
            poster_key, poster_sha256, poster_size,
            vtt_key, vtt_sha256, vtt_size,
            uploaded_at, updated_at
       FROM daily_videos ORDER BY date DESC`,
  ).all<DailyVideoRow>();
  return result.results || [];
}

function latestDailyPageModified(rows: DailyPageRow[]): string | null {
  return rows.reduce<string | null>((latest, row) => {
    const value = row.lastmod || row.generated_at;
    return !latest || value > latest ? value : latest;
  }, null);
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

interface ArchiveMonthRow {
  month: string;
  item_count: number;
}

interface ArchiveSitemapGroup extends ArchiveMonthRow {
  source: string;
  lastmod?: string | null;
}

function archive404(env: Env): Response {
  const { siteBase } = getBases(env);
  return html(
    `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>内容归档不存在 | AI Feeds</title>
</head>
<body><main><h1>内容归档不存在</h1><p><a href="${siteBase}/archive/">返回内容归档</a></p></main></body>
</html>`,
    404,
    null,
  );
}

function archiveShell(args: {
  siteBase: string;
  title: string;
  description: string;
  canonicalPath: string;
  h1: string;
  breadcrumb: Array<{ label: string; path: string }>;
  body: string;
}): Response {
  const { siteBase, title, description, canonicalPath, h1, breadcrumb, body } = args;
  const canonical = `${siteBase}${canonicalPath}`;
  const crumbs = breadcrumb
    .map(
      (entry) =>
        `<a href="${escapeHtml(`${siteBase}${entry.path}`)}">${escapeHtml(entry.label)}</a>`,
    )
    .join('<span aria-hidden="true">/</span>');
  const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${escapeHtml(canonical)}">
<style>
:root{--text:#171717;--sub:#737373;--link:#0284c7;--border:#e5e5e5;--bg:#fafafa}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);line-height:1.6;
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:800px;margin:0 auto;padding:24px 16px 48px}.brand a{color:var(--text);font-weight:700}
.breadcrumb{display:flex;gap:8px;flex-wrap:wrap;color:var(--sub);font-size:13px;margin:20px 0}
h1{font-size:24px;margin:0 0 8px}.lede{color:var(--sub);margin:0 0 24px}
.archive-list{list-style:none;padding:0;margin:0}.archive-item{padding:12px 0;border-bottom:1px solid var(--border)}
.archive-item a{font-weight:600}.meta{color:var(--sub);font-size:13px;margin-top:4px}
.source-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;padding:0;list-style:none}
.source-grid a{display:block;border:1px solid var(--border);border-radius:8px;padding:14px;background:#fff}
.pager{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:28px}
.page-numbers{display:flex;justify-content:center;gap:8px;flex-wrap:wrap}.page-numbers a,.page-numbers span{padding:2px 5px}
footer{display:flex;gap:16px;flex-wrap:wrap;margin-top:40px;padding-top:20px;border-top:1px solid var(--border);font-size:14px}
</style>
</head>
<body><div class="wrap">
<header><div class="brand"><a href="${siteBase}/">AI Feeds</a></div></header>
<nav class="breadcrumb" aria-label="面包屑">${crumbs}</nav>
<main><h1>${escapeHtml(h1)}</h1><p class="lede">${escapeHtml(description)}</p>${body}</main>
<footer><a href="${siteBase}/">进站看全部</a><a href="${siteBase}/daily/">历史日报</a><a href="${siteBase}/subscribe">订阅每日邮件</a></footer>
</div></body></html>`;
  return html(page, 200, 3600);
}

async function renderItemArchive(env: Env, route: ItemArchiveRoute): Promise<Response> {
  const { siteBase } = getBases(env);
  if (route.kind === 'index') {
    const links = ARCHIVE_SOURCES.map(
      (source) =>
        `<li><a href="${siteBase}/archive/${source}/">${escapeHtml(ARCHIVE_SOURCE_LABELS[source])}</a></li>`,
    ).join('');
    return archiveShell({
      siteBase,
      title: '内容归档 | AI Feeds',
      description: '按来源和月份浏览 AI Feeds 已发布的全部可索引内容。',
      canonicalPath: archiveCanonicalPath(route),
      h1: '内容归档',
      breadcrumb: [{ label: 'AI Feeds', path: '/' }, { label: '内容归档', path: '/archive/' }],
      body: `<ul class="source-grid">${links}</ul>`,
    });
  }

  const label = ARCHIVE_SOURCE_LABELS[route.source];
  if (route.kind === 'source') {
    const query = archiveMonthsQuery(route.source);
    const result = await env.DB.prepare(query.sql)
      .bind(...query.bindings)
      .all<ArchiveMonthRow>();
    const links = (result.results || [])
      .map(
        (row) =>
          `<li class="archive-item"><a href="${siteBase}/archive/${route.source}/${escapeHtml(row.month)}/">${escapeHtml(row.month)}</a><div class="meta">${Number(row.item_count)} 条内容</div></li>`,
      )
      .join('');
    return archiveShell({
      siteBase,
      title: `${label}归档 | AI Feeds`,
      description: `按月份浏览 AI Feeds 的${label}内容。`,
      canonicalPath: archiveCanonicalPath(route),
      h1: `${label}归档`,
      breadcrumb: [
        { label: 'AI Feeds', path: '/' },
        { label: '内容归档', path: '/archive/' },
        { label, path: archiveCanonicalPath(route) },
      ],
      body: links ? `<ul class="archive-list">${links}</ul>` : '<p>暂无内容。</p>',
    });
  }

  const countQuery = archiveCountQuery(route.source, route.month);
  const countRow = await env.DB.prepare(countQuery.sql)
    .bind(...countQuery.bindings)
    .first<{ item_count: number }>();
  const itemCount = Number(countRow?.item_count ?? 0);
  const totalPages = Math.ceil(itemCount / ARCHIVE_PAGE_SIZE);
  if (!itemCount || route.page > totalPages) return archive404(env);

  const itemQuery = archiveItemsQuery(route.source, route.month, route.page);
  const result = await env.DB.prepare(itemQuery.sql)
    .bind(...itemQuery.bindings)
    .all<ArchiveItemRow>();
  const rows = result.results || [];
  if (!rows.length) return archive404(env);

  const items = rows
    .map((row) => {
      const meta = [row.author, row.published_at ? dateOnly(row.published_at) : null]
        .filter(Boolean)
        .map((value) => escapeHtml(String(value)))
        .join(' · ');
      return `<li class="archive-item"><a href="${escapeHtml(`${siteBase}${row.url_path}`)}">${escapeHtml(row.title || row.id)}</a>${meta ? `<div class="meta">${meta}</div>` : ''}</li>`;
    })
    .join('');
  const monthPath = `/archive/${route.source}/${route.month}/`;
  const prev =
    route.page > 1
      ? `<a rel="prev" href="${siteBase}${route.page === 2 ? monthPath : `${monthPath}${route.page - 1}`}">← 上一页</a>`
      : '<span></span>';
  const next =
    route.page < totalPages
      ? `<a rel="next" href="${siteBase}${monthPath}${route.page + 1}">下一页 →</a>`
      : '<span></span>';
  const pageNumbers = Array.from({ length: totalPages }, (_, index) => index + 1)
    .map((page) => {
      if (page === route.page) return `<span aria-current="page">${page}</span>`;
      const path = page === 1 ? monthPath : `${monthPath}${page}`;
      return `<a href="${siteBase}${path}">${page}</a>`;
    })
    .join('');
  return archiveShell({
    siteBase,
    title: `${label} ${route.month}归档${route.page > 1 ? ` · 第 ${route.page} 页` : ''} | AI Feeds`,
    description: `浏览 ${route.month} 发布的${label}内容，第 ${route.page} 页，共 ${itemCount} 条。`,
    canonicalPath: archiveCanonicalPath(route),
    h1: `${label} · ${route.month}`,
    breadcrumb: [
      { label: 'AI Feeds', path: '/' },
      { label: '内容归档', path: '/archive/' },
      { label, path: `/archive/${route.source}/` },
      { label: route.month, path: monthPath },
    ],
    body: `<ul class="archive-list">${items}</ul><nav class="pager" aria-label="分页">${prev}<span class="page-numbers">${pageNumbers}</span>${next}</nav>`,
  });
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

// ── sitemap.xml(sitemap-index)──────────────────────────────────
// Task 6:3.2 万内容页 + 年增 5-7 万会破单文件 5 万上限,故 /sitemap.xml 改 sitemap-index。
// 列:日报片 /sitemap-daily.xml(含首页/归档/全部日报页)+ 五源各 /sitemap-<source>.xml(超 5 万续 -2 -3)。
// sitemapindex 只能容 <sitemap> 子节点(不能放 <url>),故首页/归档并入日报片的 <urlset>。
async function sitemapIndexResponse(env: Env): Promise<Response> {
  const { siteBase } = getBases(env);
  const daily = await loadDailyPages(env); // date DESC
  const latestDailyMod = latestDailyPageModified(daily);
  const dailyMod = latestDailyMod ? dateOnly(latestDailyMod) : null;
  const videos = await loadDailyVideos(env);
  const videoMod = videos.reduce<string | null>((latest, row) => {
    const value = row.updated_at || row.uploaded_at;
    return !latest || value > latest ? value : latest;
  }, null);

  const entries: string[] = [];
  entries.push(sitemapEntry(`${siteBase}/sitemap-daily.xml`, dailyMod));
  entries.push(sitemapEntry(`${siteBase}/sitemap-archive.xml`, null));
  entries.push(sitemapEntry(`${siteBase}/video-sitemap.xml`, videoMod ? dateOnly(videoMod) : null));

  // 各源仍符合内容门禁的 live 页计数 + 最新 generated_at，据此算续片数
  // (ceil(count/5万))，空源仍列 page1。JOIN items 防止陈旧 live 索引把已删除/去重/敏感项继续暴露。
  const countRes = await env.DB.prepare(
    `SELECT p.source, COUNT(DISTINCT p.url_path) AS c, MAX(p.generated_at) AS m
     FROM item_pages p
     JOIN items i ON i.id = p.item_id
     WHERE ${ITEM_PAGE_ELIGIBILITY}
     GROUP BY p.source`,
  ).all<{ source: string; c: number; m: string | null }>();
  const counts = new Map<string, { c: number; m: string | null }>();
  for (const r of countRes.results || []) counts.set(r.source, { c: Number(r.c), m: r.m });

  for (const s of SITEMAP_SOURCES) {
    const row = counts.get(s);
    const c = row ? row.c : 0;
    const mod = row && row.m ? dateOnly(row.m) : null;
    const shards = Math.max(1, Math.ceil(c / SITEMAP_SHARD_SIZE));
    for (let p = 1; p <= shards; p++) {
      const loc = p === 1 ? `${siteBase}/sitemap-${s}.xml` : `${siteBase}/sitemap-${s}-${p}.xml`;
      entries.push(sitemapEntry(loc, mod));
    }
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join('\n')}
</sitemapindex>
`;
  return xmlResponse(xml, 200);
}

function archiveSourceFromPageSource(source: string): ArchiveSource | null {
  if (source === 'hf-paper') return 'paper';
  return (ARCHIVE_SOURCES as readonly string[]).includes(source)
    ? (source as ArchiveSource)
    : null;
}

async function archiveSitemapResponse(env: Env): Promise<Response> {
  const { siteBase } = getBases(env);
  const query = archiveSitemapGroupsQuery();
  const result = await env.DB.prepare(query.sql)
    .bind(...query.bindings)
    .all<ArchiveSitemapGroup>();
  const groups = result.results || [];
  const latest = groups.reduce<string | null>((current, row) => {
    const value = row.lastmod || null;
    return value && (!current || value > current) ? value : current;
  }, null);
  const urls: string[] = [urlEntry(`${siteBase}/archive/`, dateOnly(latest || new Date().toISOString()), 'daily')];

  for (const source of ARCHIVE_SOURCES) {
    const sourceGroups = groups.filter((row) => archiveSourceFromPageSource(row.source) === source);
    const sourceLastmod = sourceGroups.reduce<string | null>((current, row) => {
      const value = row.lastmod || null;
      return value && (!current || value > current) ? value : current;
    }, null);
    urls.push(
      urlEntry(
        `${siteBase}/archive/${source}/`,
        dateOnly(sourceLastmod || latest || new Date().toISOString()),
        'weekly',
      ),
    );
  }

  for (const row of groups) {
    const source = archiveSourceFromPageSource(row.source);
    if (!source || !isValidArchiveGroup(row)) continue;
    const pages = Math.ceil(Number(row.item_count) / ARCHIVE_PAGE_SIZE);
    for (let page = 1; page <= pages; page++) {
      const route: ItemArchiveRoute = { kind: 'month', source, month: row.month, page };
      urls.push(
        urlEntry(
          `${siteBase}${archiveCanonicalPath(route)}`,
          dateOnly(row.lastmod || new Date().toISOString()),
          'weekly',
        ),
      );
    }
  }
  return urlsetResponse(urls);
}

function isValidArchiveGroup(row: ArchiveSitemapGroup): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(row.month) && Number(row.item_count) > 0;
}

// ── /sitemap-daily.xml(日报片)──────────────────────────────────
// 旧 /sitemap.xml 内容整体搬来:/ + /daily/ + 全部 daily_pages 行。
async function dailySitemapResponse(env: Env): Promise<Response> {
  const { siteBase } = getBases(env);
  const rows = await loadDailyPages(env); // date DESC
  const latestDailyMod = latestDailyPageModified(rows);
  const latestMod = latestDailyMod ? dateOnly(latestDailyMod) : dateOnly(new Date().toISOString());

  const urls: string[] = [];
  urls.push(urlEntry(`${siteBase}/`, latestMod, 'daily'));
  urls.push(urlEntry(`${siteBase}/daily/`, latestMod, 'daily'));
  for (const row of rows) {
    urls.push(urlEntry(`${siteBase}/daily/${row.date}`, dateOnly(row.lastmod || row.generated_at), 'monthly'));
  }
  return urlsetResponse(urls);
}

// ── /video-sitemap.xml ─────────────────────────────────────────
// Google video sitemap:landing page 是日报页，媒体/封面走 API /r/（已支持 Range）。
async function videoSitemapResponse(env: Env): Promise<Response> {
  const { apiBase, siteBase } = getBases(env);
  const rows = await loadDailyVideos(env);
  const urls = rows.map((row) => {
    const duration = Math.max(1, Math.min(28800, Math.round(Number(row.duration_seconds))));
    return `  <url>
    <loc>${xmlEscape(`${siteBase}/daily/${row.date}`)}</loc>
    <video:video>
      <video:thumbnail_loc>${xmlEscape(`${apiBase}/r/${row.poster_key}`)}</video:thumbnail_loc>
      <video:title>${xmlEscape(row.title)}</video:title>
      <video:description>${xmlEscape(truncateUnicode(row.description, 2048))}</video:description>
      <video:content_loc>${xmlEscape(`${apiBase}/r/${row.mp4_key}`)}</video:content_loc>
      <video:publication_date>${xmlEscape(dailyVideoPublicationDate(row.date))}</video:publication_date>
      <video:duration>${duration}</video:duration>
    </video:video>
  </url>`;
  });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">
${urls.join('\n')}
</urlset>
`;
  return xmlResponse(xml, 200);
}

// ── /sitemap-<source>.xml(内容片)───────────────────────────────
// 该源 item_pages(status=live 且关联 item 仍符合内容门禁)的 url_path，
// 按 generated_at DESC 分页(page-1 → OFFSET)。
// lastmod = generated_at 日期部分;绝对 URL = SITE_BASE + url_path(url_path 存相对 /i/…)。
async function sourceSitemapResponse(env: Env, source: string, page: number): Promise<Response> {
  const { siteBase } = getBases(env);
  const offset = (page - 1) * SITEMAP_SHARD_SIZE;
  const r = await env.DB.prepare(
    `SELECT p.url_path, MAX(p.generated_at) AS generated_at
     FROM item_pages p
     JOIN items i ON i.id = p.item_id
     WHERE p.source = ? AND ${ITEM_PAGE_ELIGIBILITY}
     GROUP BY p.url_path
     ORDER BY generated_at DESC, p.url_path ASC LIMIT ? OFFSET ?`,
  )
    .bind(source, SITEMAP_SHARD_SIZE, offset)
    .all<{ url_path: string; generated_at: string }>();
  const rows = r.results || [];
  const urls = rows.map((row) =>
    urlEntry(`${siteBase}${row.url_path}`, dateOnly(row.generated_at), 'monthly'),
  );
  return urlsetResponse(urls);
}

function urlsetResponse(urls: string[]): Response {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;
  return xmlResponse(xml, 200);
}

function xmlResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': status === 200 ? 'public, max-age=3600' : 'no-store',
    },
  });
}

function dateOnly(iso: string): string {
  return String(iso).slice(0, 10);
}

function xmlEscape(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncateUnicode(value: string, maxChars: number): string {
  return Array.from(value).slice(0, maxChars).join('');
}

function urlEntry(loc: string, lastmod: string, changefreq: string): string {
  return `  <url><loc>${xmlEscape(loc)}</loc><lastmod>${xmlEscape(lastmod)}</lastmod><changefreq>${xmlEscape(changefreq)}</changefreq></url>`;
}

function sitemapEntry(loc: string, lastmod: string | null): string {
  return lastmod
    ? `  <sitemap><loc>${xmlEscape(loc)}</loc><lastmod>${xmlEscape(lastmod)}</lastmod></sitemap>`
    : `  <sitemap><loc>${xmlEscape(loc)}</loc></sitemap>`;
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

  if (pathname === '/archive' || pathname.startsWith('/archive/')) {
    const route = parseItemArchivePath(pathname);
    return route ? renderItemArchive(env, route) : archive404(env);
  }

  if (pathname === '/robots.txt') return robotsResponse(env);
  if (pathname === '/llms.txt') return llmsResponse(env);
  if (pathname === '/sitemap.xml') return sitemapIndexResponse(env);
  if (pathname === '/video-sitemap.xml') return videoSitemapResponse(env);
  if (pathname === '/sitemap-archive.xml') return archiveSitemapResponse(env);
  // 日报片(须在通用分片正则前判,daily 也匹配 SITEMAP_SHARD_RE)。
  if (pathname === '/sitemap-daily.xml') return dailySitemapResponse(env);
  // /sitemap-<source>.xml、/sitemap-<source>-<n>.xml → 内容片;未知源/非法后缀 → 404 xml。
  if (SITEMAP_SHARD_RE.test(pathname)) {
    const shard = parseSitemapShard(pathname);
    if (shard) return sourceSitemapResponse(env, shard.source, shard.page);
    return xmlResponse('<?xml version="1.0" encoding="UTF-8"?>\n<error>Not Found</error>\n', 404);
  }

  // 其余根目录 .txt → IndexNow key 文件(命中返回 key;未配置/不匹配 404)
  if (ROOT_TXT_RE.test(pathname)) return indexNowResponse(env, pathname);

  return null; // 非本模块路径,index.ts 继续后续匹配
}
