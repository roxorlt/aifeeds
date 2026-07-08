// 每日静态日报页(SEO P0)的数据构建 + 纯 HTML 渲染器。
// 设计文档:docs/plans/2026-07-06-daily-static-page-seo-design.md §4.1 / §5
//
// buildDailyPageData(env, date)  —— 每源同款评分选品(selection.ts)→ renderItem() → DailyPageData
// renderDailyPageHtml(data, env) —— 纯函数,输出完整静态 HTML(内联 CSS、零可执行 JS)
//
// 关键约定:
// - 绝对 URL 一律用 env.SITE_BASE / env.API_BASE 拼接,禁止取 request host(HK 中转会改写 Host)
// - 截断放在 build 层(selectTopForSource 已带 limit,这里再防御性 slice);渲染层按传入渲染
// - 零可执行 <script>:唯一的 <script> 是 JSON-LD 数据岛(application/ld+json,爬虫识别结构化数据
//   的标准载体,非可执行 JS),标题里的 </script> 已用 < 转义防越权

import type { Env } from '../index';
import { DIGEST_SOURCE_ORDER, DAILY_PAGE_PER_SOURCE_LIMIT, DAILY_PAGE_INTRO_MAX, type DigestSource } from './config';
import { selectTopForSource, type SelectTopOptions } from './selection';
import { renderItem, clampSentences, type RenderRow, type RenderedItem } from './render';
import { SOURCE_LABELS, escapeHtml } from './templates';
import { buildDigestSubjectFallback } from './subject';
import { getBases } from './lib';

// 日报页展示源与顺序:沿用 DIGEST_SOURCE_ORDER 剔除 clawhub(2026-06-21 退出订阅日报)。
export const DAILY_PAGE_SOURCES: DigestSource[] = DIGEST_SOURCE_ORDER.filter((s) => s !== 'clawhub');

export interface DailyPageSection {
  source: string;
  label: string;
  items: RenderedItem[];
}

export interface DailyPageData {
  date: string; // YYYY-MM-DD(BJT)
  subject: string; // 当日 LLM 主题,缺失时 fallback 文案
  sections: DailyPageSection[]; // news→ph→gh→hf-paper→x,空源已剔除
  prevDate: string | null; // daily_pages 中相邻已生成日期(date 之前最近一行)
  nextDate: string | null; // date 之后最近一行,通常 null → 渲染为指向 /daily/ 归档
}

// 一次拉齐渲染所需全字段(RenderRow)。与 daily-api / codex-push 的 fetchRows 同构。
async function fetchRows(env: Env, ids: string[]): Promise<Map<string, RenderRow>> {
  if (!ids.length) return new Map();
  const ph = ids.map(() => '?').join(',');
  const r = await env.DB.prepare(
    `SELECT id, title, content, content_translated, author, handle, url, media, extra
       FROM items WHERE id IN (${ph})`,
  )
    .bind(...ids)
    .all<RenderRow>();
  return new Map((r.results || []).map((row) => [row.id, row]));
}

// 当日主题:复用 digest_pool 的 _subject meta 行(8 点节点写入,slot_key = `${date}-08`)。
// 缺失时回落 buildDigestSubjectFallback(用页面 top 条目标题拼)——与 node-run 同款文案。
async function loadSubject(env: Env, date: string, sections: DailyPageSection[]): Promise<string> {
  const sk = `${date}-08`;
  let subject = '';
  try {
    const row = await env.DB.prepare(
      `SELECT items_meta FROM digest_pool WHERE slot_key = ? AND source = '_subject' AND density = 'meta'`,
    )
      .bind(sk)
      .first<{ items_meta: string | null }>();
    if (row?.items_meta) {
      const parsed = JSON.parse(row.items_meta) as { subject?: unknown };
      if (typeof parsed.subject === 'string') subject = parsed.subject.trim();
    }
  } catch {
    /* ignore — 回落 fallback */
  }
  if (subject) return subject;
  const titles = sections.flatMap((s) => s.items.slice(0, 3).map((it) => it.title));
  return buildDigestSubjectFallback(titles);
}

// 相邻已生成日期:prevDate = 严格早于 date 的最近一行;nextDate = 严格晚于 date 的最近一行。
async function loadAdjacentDates(env: Env, date: string): Promise<{ prevDate: string | null; nextDate: string | null }> {
  const prev = await env.DB.prepare(
    `SELECT date FROM daily_pages WHERE date < ? ORDER BY date DESC LIMIT 1`,
  )
    .bind(date)
    .first<{ date: string }>();
  const next = await env.DB.prepare(
    `SELECT date FROM daily_pages WHERE date > ? ORDER BY date ASC LIMIT 1`,
  )
    .bind(date)
    .first<{ date: string }>();
  return { prevDate: prev?.date ?? null, nextDate: next?.date ?? null };
}

// opts.anchorToDate=true 时把 date 作为选品候选窗口的锚点(回填历史日期用),默认 false
// (8 点当日主路径 = 调用时刻 top N,与改动前逐字节一致)。见 selection.ts asOfDate。
export async function buildDailyPageData(
  env: Env,
  date: string,
  opts: { anchorToDate?: boolean } = {},
): Promise<DailyPageData | null> {
  const { apiBase } = getBases(env);
  const sections: DailyPageSection[] = [];

  for (const source of DAILY_PAGE_SOURCES) {
    // 每源选品选项:
    // - anchorToDate(回填历史日期)→ 传 asOfDate 把候选窗锚到该日,选品结果对应历史当日。
    // - news 源:当日自然路径沿用邮件 Phase 1 的跨天事件去重(strictCrossDayEventDedup),
    //   剔除近几日已在日报里出现过的同一事件(与邮件 node-run.ts:167-175 同款传参)。
    //   但该去重依赖「已推送账本」——fetchPreviousPushedNewsCandidates 读 digest_pool 且以
    //   「今日 BJT 0 点」为边界(锚的是当下),对回填历史日期(anchorToDate)语义不成立,
    //   会拿今天之前的账本去 dedup 历史某日的候选 → 因此仅当日自然路径启用,锚定路径不传。
    const selectOpts: SelectTopOptions = {};
    if (opts.anchorToDate) selectOpts.asOfDate = date;
    else if (source === 'news') selectOpts.strictCrossDayEventDedup = true;
    const selected = await selectTopForSource(env, source, DAILY_PAGE_PER_SOURCE_LIMIT, selectOpts);
    // 防御性截断:选品函数已带 limit,天然 ≤20;这里再 slice 一次,渲染层不做保护。
    const ids = selected.slice(0, DAILY_PAGE_PER_SOURCE_LIMIT);
    if (!ids.length) continue;
    const rows = await fetchRows(env, ids);
    const items: RenderedItem[] = [];
    ids.forEach((id, i) => {
      const row = rows.get(id);
      if (!row) return;
      // 静态日报页无 JS 兜底 → 开 news 封面质量门(拒外链 cover / 二维码 / 低质 R2 图);
      // 同时开 extendedIntro,让非 news 源(ph/gh/hf/x)也产出 intro=每源最优加长字段供扩展摘要段展示。
      items.push(renderItem(source, row, i + 1, apiBase, { newsCoverQualityGate: true, extendedIntro: true }));
    });
    if (!items.length) continue;
    sections.push({ source, label: SOURCE_LABELS[source] || source, items });
  }

  if (!sections.length) return null; // 五源全空 → 调用方跳过生成

  const subject = await loadSubject(env, date, sections);
  const { prevDate, nextDate } = await loadAdjacentDates(env, date);
  return { date, subject, sections, prevDate, nextDate };
}

// ── HTML 渲染(纯函数)──

// 品牌色对齐 docs/design-handoff.md:文字 neutral-900、链接 sky-600、分割线 neutral-200。
// 系统字体栈(静态页零外链资产),移动优先单列。
const PAGE_STYLE = `
:root{--text:#171717;--body:#525252;--sub:#737373;--link:#0284c7;--border:#e5e5e5;--bg:#fafafa;--card:#fff}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);line-height:1.65;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei","Hiragino Sans GB",sans-serif;
  font-size:16px}
a{color:var(--link);text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:720px;margin:0 auto;padding:20px 16px 48px}
header{border-bottom:1px solid var(--border);padding-bottom:16px;margin-bottom:8px}
.brand{font-size:18px;font-weight:700;color:var(--text)}
.brand a{color:var(--text)}
.date{color:var(--sub);font-size:14px;margin-top:4px}
.nav{margin-top:12px;font-size:14px;display:flex;gap:16px;flex-wrap:wrap;align-items:center}
.subscribe-btn{margin-left:auto;flex:none;white-space:nowrap;background:var(--link);color:#fff;
  padding:6px 14px;border-radius:6px;font-weight:600}
.subscribe-btn:hover{background:#0369a1;text-decoration:none;color:#fff}
section{margin-top:28px}
h2{font-size:16px;font-weight:700;color:var(--text);margin:0 0 4px;
  border-left:3px solid var(--link);padding-left:10px}
article{padding:16px 0;border-bottom:1px solid var(--border)}
h3{font-size:17px;font-weight:600;line-height:1.5;margin:0 0 8px}
.summary{color:var(--body);font-size:15px;margin:8px 0}
.summary-full{color:var(--body);font-size:14px;line-height:1.75;margin:6px 0 0}
.cover{display:block;width:100%;max-width:100%;height:auto;border-radius:8px;margin:10px 0;border:1px solid var(--border)}
.meta{color:var(--sub);font-size:13px;display:flex;gap:12px;flex-wrap:wrap;align-items:center}
footer{margin-top:40px;padding-top:20px;border-top:1px solid var(--border);
  color:var(--sub);font-size:14px;display:flex;gap:16px;flex-wrap:wrap}
`.trim();

// JSON-LD 安全内联:< 转义 `<` 防 </script> 越权,同时保持合法 JSON(解析后还原为 `<`)。
function jsonLdSafe(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

// ── 公共 SEO 页骨架(日报页 + item 单页共用)───────────────────────────────────────
// head(title/description/canonical/OG/单 JSON-LD 数据岛/内联 CSS)+ <html> 外壳。
// bodyHtml 为 <body> 内的完整内容(调用方自带 .wrap 容器)。零可执行 <script>:唯一 <script>
// 是 application/ld+json 数据岛(jsonLdSafe 已把 `<` 转义防 </script> 越权)。
// PAGE_STYLE / jsonLdSafe 未改动 → 日报页调用后输出对既有实现逐字节不变(纯重构)。
// og:url 与 canonical 同值(self-canonical);og:image 缺省(undefined)时整行省略。
export function renderSeoPageShell(opts: {
  lang: 'zh-CN';
  title: string;
  description: string;
  canonical: string;
  ogImage?: string;
  ogType: 'website' | 'article';
  jsonLd: object;
  bodyHtml: string;
}): string {
  const { lang, title, description, canonical, ogImage, ogType, jsonLd, bodyHtml } = opts;
  const ogImageLine = ogImage ? `<meta property="og:image" content="${escapeHtml(ogImage)}">\n` : '';
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="${ogType}">
<meta property="og:url" content="${canonical}">
${ogImageLine}<script type="application/ld+json">${jsonLdSafe(jsonLd)}</script>
<style>${PAGE_STYLE}</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

// 扩展摘要文本:每源最优加长字段(item.intro)按句 clamp 到 DAILY_PAGE_INTRO_MAX。
// intro 为空 → 返回 ''(调用方据此不渲染空段)。
function extendedSummary(item: RenderedItem): string {
  return item.intro ? clampSentences(item.intro, DAILY_PAGE_INTRO_MAX) : '';
}

// 每条 item 供爬虫抓取的描述文本:优先扩展摘要,否则回退一句话 summary。
function seoDescription(item: RenderedItem): string {
  return extendedSummary(item) || clampSentences(item.summary_full || item.summary || '');
}

// 前缀重叠判定:规范化(去尾部省略号 `…` + trim)后,一句话 summary 是否为扩展摘要的逐字前缀。
// 同源(hf 两者 summary_zh / x 两者 content_translated / gh 都 ai_summary / ph 缺 description_zh 回退 ai_summary)
// 时,扩展摘要开头 = 一句话 summary(仅 clamp 长度不同,相等亦算前缀)→ true。
// 异源(blog: summary vs excerpt_zh / podcast: vs shownotes_zh / ph: vs description_zh)内容不同 → false。
function isPrefixOverlap(oneLiner: string, extended: string): boolean {
  const norm = (s: string): string => s.replace(/…+$/, '').trim();
  const a = norm(oneLiner);
  const b = norm(extended);
  return a.length > 0 && b.length > 0 && b.startsWith(a);
}

function renderArticle(item: RenderedItem, siteBase: string): string {
  const deepUrl = `${siteBase}${item.deep_link}`;
  const oneLiner = clampSentences(item.summary_full || item.summary || '');
  const extended = extendedSummary(item);
  const parts: string[] = [];
  parts.push(`<article>`);
  parts.push(`<h3><a href="${escapeHtml(deepUrl)}">${escapeHtml(item.title)}</a></h3>`);
  if (item.cover) {
    parts.push(`<img class="cover" src="${escapeHtml(item.cover)}" alt="${escapeHtml(item.title)}" loading="lazy">`);
  }
  if (extended && isPrefixOverlap(oneLiner, extended)) {
    // 同源前缀:一句话 summary 只是扩展摘要的截断前缀 → collapse 成一段,取更长的扩展 500 版,
    // 占据一句话 summary 的位置/样式层级(.summary),避免开头 ~180 字逐字重复,SEO 文字量还更多。
    parts.push(`<p class="summary">${escapeHtml(extended)}</p>`);
  } else {
    // 异源(内容不同)或无扩展摘要:保留一句话 summary;有扩展且确非前缀重叠 → 再补扩展段供 SEO 抓取。
    if (oneLiner) parts.push(`<p class="summary">${escapeHtml(oneLiner)}</p>`);
    if (extended) parts.push(`<p class="summary-full">${escapeHtml(extended)}</p>`);
  }
  const meta: string[] = [];
  if (item.author) meta.push(`<span>${escapeHtml(item.author)}</span>`);
  if (item.url) {
    meta.push(`<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">原文</a>`);
  }
  if (meta.length) parts.push(`<div class="meta">${meta.join('')}</div>`);
  parts.push(`</article>`);
  return parts.join('');
}

export function renderDailyPageHtml(data: DailyPageData, env: Env): string {
  const { siteBase } = getBases(env);
  const dailyBase = `${siteBase}/daily`;
  const pageUrl = `${dailyBase}/${data.date}`;
  const title = `AI 日报 ${data.date} · ${data.subject} | AI Feeds`;
  const desc = data.subject;

  // og:image = 首条有 cover 的 item;兜底站点默认图。
  let ogImage = `${siteBase}/og-default.png`;
  for (const sec of data.sections) {
    const found = sec.items.find((it) => it.cover);
    if (found?.cover) {
      ogImage = found.cover;
      break;
    }
  }

  // JSON-LD:CollectionPage + ItemList(每条 name=标题、url=深链、description=加长摘要供爬虫抓取)。
  const itemListElement = data.sections
    .flatMap((sec) => sec.items)
    .map((it, i) => {
      const description = seoDescription(it);
      return {
        '@type': 'ListItem',
        position: i + 1,
        name: it.title,
        url: `${siteBase}${it.deep_link}`,
        ...(description ? { description } : {}),
      };
    });
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    description: desc,
    url: pageUrl,
    inLanguage: 'zh-CN',
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: itemListElement.length,
      itemListElement,
    },
  };

  // header 前后日导航:前一日缺则隐藏;后一日缺(次日未生成)先指向归档 /daily/。
  const nav: string[] = [];
  if (data.prevDate) nav.push(`<a href="${dailyBase}/${data.prevDate}">前一日</a>`);
  nav.push(`<a href="${dailyBase}/">全部日报</a>`);
  nav.push(`<a href="${data.nextDate ? `${dailyBase}/${data.nextDate}` : `${dailyBase}/`}">后一日</a>`);
  // 显著「订阅」按钮:品牌色实心,移动端不换行(white-space:nowrap + flex:none),margin-left:auto 靠右。
  nav.push(`<a href="${siteBase}/subscribe" class="subscribe-btn">订阅日报</a>`);

  const sectionsHtml = data.sections
    .map((sec) => {
      const articles = sec.items.map((it) => renderArticle(it, siteBase)).join('');
      return `<section><h2>${escapeHtml(sec.label)}</h2>${articles}</section>`;
    })
    .join('');

  const bodyHtml = `<div class="wrap">
<header>
<div class="brand"><a href="${siteBase}/">AI Feeds</a></div>
<div class="date">AI 日报 · ${escapeHtml(data.date)}</div>
<nav class="nav">${nav.join('')}</nav>
</header>
<main>${sectionsHtml}</main>
<footer>
<a href="${siteBase}/subscribe">订阅每日邮件</a>
<a href="${siteBase}/">进站看全部</a>
<a href="${dailyBase}/">历史日报</a>
</footer>
</div>`;

  return renderSeoPageShell({
    lang: 'zh-CN',
    title,
    description: desc,
    canonical: pageUrl,
    ogImage,
    ogType: 'article',
    jsonLd,
    bodyHtml,
  });
}
