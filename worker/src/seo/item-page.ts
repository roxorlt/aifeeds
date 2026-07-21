// item SSR 单页渲染器(纯函数)。设计文档 2026-07-08-item-ssr-pages-design.md §5。
//
// renderItemPageHtml(row, env, related?) —— 单条 items 行 → 完整 SSR HTML:
//   1. composite id 的 source_type 前缀 → DigestSource 反映射(selection.SOURCE_TYPE 取反)
//   2. renderItem() 拿 RenderedItem(title/summary_full/cover/intro/deep_link/author/url)
//   3. 组 JSON-LD @graph(Article + BreadcrumbList + Organization,单数据岛)
//   4. 套公共 SEO 骨架 renderSeoPageShell()(head/canonical/OG/内联 CSS/零可执行 script)
//
// 关键约定:
// - 绝对 URL 一律 env.SITE_BASE / env.API_BASE(getBases),禁取 request host(HK 中转改写 Host)
// - self-canonical = ${SITE_BASE}${itemPagePath(id)}(/i/…);「打开互动版」CTA 走 SPA 深链
//   ${SITE_BASE}${deepLinkPath(id)}(/t/ /g/ /ph/ …),两者独立不复用
// - 相关内链走 /i/ 静态页(itemPagePath),不是 SPA 深链;related 空则不渲染该区
// - 零可执行 <script>:唯一 <script> 是 JSON-LD 数据岛(骨架 jsonLdSafe 转义 `<`);外部文本 escapeHtml

import type { Env } from '../index';
import type { DigestSource } from '../digest/config';
import { renderSeoPageShell } from '../digest/daily-page';
import {
  renderItem,
  clampSentences,
  itemPagePath,
  deepLinkPath,
  type RenderRow,
  type RenderedItem,
} from '../digest/render';
import { SOURCE_LABELS, escapeHtml } from '../digest/templates';
import { renderItemBody, itemIndexableText, ITEM_BODY_STYLE } from './item-body';
import {
  defaultItemPageProfile,
  type ItemPageProfile,
} from '../cc-mirror/profile';
import { buildCcReviewText } from '../cc-mirror/review-text';

// meta description 截断上限(纯文本前 ~150 字,按句)。
const ITEM_DESC_MAX = 150;

// SELECT * FROM items 才有、RenderRow 类型未声明的列(运行期存在),按需读取。
type ItemPageRow = RenderRow & {
  published_at?: string | null;
  scraped_at?: string | null;
  source_type?: string | null;
};

// composite id 的 source_type 前缀 → DigestSource(反向于 selection.SOURCE_TYPE)。
// blog/podcast 同归 news;出页 5 类之外(clawhub/huodongxing/未知)→ null(路由层已 gate)。
function digestSourceForId(itemId: string): DigestSource | null {
  const idx = itemId.indexOf(':');
  const st = idx >= 0 ? itemId.slice(0, idx) : itemId;
  switch (st) {
    case 'x_list':
      return 'x';
    case 'github':
      return 'gh';
    case 'product_hunt':
      return 'ph';
    case 'hf_paper':
      return 'hf-paper';
    case 'blog':
    case 'podcast':
      return 'news';
    case 'clawhub':
      return 'clawhub';
    default:
      return null;
  }
}

// 展示用日期:ISO(2026-07-01T08:00:00Z)取日期部分;取不到日期形状则原样返回。
function displayDate(raw: string): string {
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : raw;
}

export function renderItemPageHtml(
  row: RenderRow,
  env: Env,
  related: RenderedItem[] = [],
  suppliedProfile?: ItemPageProfile,
): string {
  const profile = suppliedProfile ?? defaultItemPageProfile(env);
  const {
    siteBase,
    interactiveBase,
    apiBase,
    brandName,
    titleSuffix,
    ccVariant,
    archiveBase,
    archiveHasSourcePages,
    defaultOgImage,
  } = profile;
  const r = row as ItemPageRow;
  // 出页 5 类之外理论上被路由层拦掉;兜底给 news 分支避免崩(不影响正常 5 源)。
  const source = digestSourceForId(row.id) ?? 'news';

  // 静态页无 JS 兜底 → 开 news 封面质量门 + extendedIntro(非 news 源也产出「最优加长字段」译文摘录)。
  const item = renderItem(source, row, 1, apiBase, { newsCoverQualityGate: true, extendedIntro: true });

  const path = itemPagePath(row.id);
  const canonical = `${siteBase}${path ?? '/'}`;
  const deepUrl = ccVariant
    ? `${interactiveBase}${deepLinkPath(row.id)}?utm_source=cc&utm_medium=mirror&utm_campaign=cn_seo`
    : `${interactiveBase}${deepLinkPath(row.id)}`;
  const ctaLabel = ccVariant ? '打开 AI Feeds 完整版' : '打开互动版';
  const label = SOURCE_LABELS[source] || source;
  const pageTitle = `${item.title} | ${titleSuffix}`;
  const cover = item.cover || defaultOgImage;

  const summaryFull = item.summary_full || item.summary || '';
  const description = clampSentences(summaryFull, ITEM_DESC_MAX);
  const datePublished = (r.published_at || r.scraped_at || '').trim();
  const archiveSource = source === 'hf-paper' ? 'paper' : source;
  const sourceArchiveUrl = archiveHasSourcePages
    ? `${archiveBase}/${archiveSource}/`
    : `${archiveBase}/`;
  const archiveMonth = datePublished.match(/^(\d{4}-(?:0[1-9]|1[0-2]))/)?.[1] || null;
  const monthArchiveUrl = archiveHasSourcePages && archiveMonth
    ? `${sourceArchiveUrl}${archiveMonth}/`
    : null;

  // 分源混合正文:gh/hf/ph/x 全文,blog/podcast 摘要+分析+短摘录(见 item-body.ts)。净化后零可执行 script。
  const bodyContent = renderItemBody(source, row, env);

  // JSON-LD articleBody:可安全索引纯文本。全文源用正文派生,blog/podcast 只用我们的摘要+分析(不照译全文)。
  const articleBody = ccVariant
    ? (() => {
        const reviewed = buildCcReviewText(row, env);
        return reviewed.renderError ? '' : reviewed.text;
      })()
    : itemIndexableText(source, row, env);

  // ── JSON-LD @graph:Article + BreadcrumbList(首页→源频道→本条) + Organization ──
  const article: Record<string, unknown> = {
    '@type': 'Article',
    headline: item.title,
    description,
    inLanguage: 'zh-CN',
    mainEntityOfPage: canonical,
    image: cover,
    ...(articleBody ? { articleBody } : {}),
    ...(datePublished ? { datePublished } : {}),
    ...(item.author ? { author: { '@type': 'Person', name: item.author } } : {}),
  };
  const breadcrumb = {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: brandName, item: `${siteBase}/` },
      { '@type': 'ListItem', position: 2, name: label, item: sourceArchiveUrl },
      { '@type': 'ListItem', position: 3, name: item.title, item: canonical },
    ],
  };
  const organization = {
    '@type': 'Organization',
    name: brandName,
    url: `${siteBase}/`,
  };
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [article, breadcrumb, organization],
  };

  // ── body(自带 .wrap 容器,复用日报页样式类)──
  const metaBits: string[] = [`<span>${escapeHtml(label)}</span>`];
  if (item.author) metaBits.push(`<span>${escapeHtml(item.author)}</span>`);
  if (datePublished) metaBits.push(`<span>${escapeHtml(displayDate(datePublished))}</span>`);
  if (item.url) {
    metaBits.push(`<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener nofollow">原文</a>`);
  }

  const relLinks = related
    .map((it) => {
      const p = itemPagePath(it.item_id);
      return p ? `<article><h3><a href="${escapeHtml(`${siteBase}${p}`)}">${escapeHtml(it.title)}</a></h3></article>` : '';
    })
    .filter(Boolean);
  const relatedHtml = relLinks.length ? `<section><h2>相关内容</h2>${relLinks.join('')}</section>` : '';

  const coverHtml = item.cover
    ? `<img class="cover" src="${escapeHtml(item.cover)}" alt="${escapeHtml(item.title)}" loading="lazy">`
    : '';
  const archiveLinks = `<nav class="nav" aria-label="内容归档"><a href="${escapeHtml(sourceArchiveUrl)}">${escapeHtml(label)}归档</a>${monthArchiveUrl ? `<a href="${escapeHtml(monthArchiveUrl)}">${escapeHtml(archiveMonth!)}归档</a>` : ''}</nav>`;

  const footerHtml = ccVariant
    ? `<footer>
<a href="${siteBase}/">首页</a>
<a href="${siteBase}/privacy.html">隐私政策</a>
<a href="${siteBase}/terms.html">服务条款</a>
<a href="${siteBase}/contact.html">联系我们</a>
<a href="mailto:support@ai-feeds.cc">support@ai-feeds.cc</a>
<a href="https://beian.mps.gov.cn/#/query/webSearch?code=11010802048455" target="_blank" rel="noopener noreferrer">京公网安备11010802048455号</a>
<a href="https://beian.miit.gov.cn/#/Integrated/index" target="_blank" rel="noopener noreferrer">京ICP备2025123594号-2</a>
</footer>`
    : `<footer>
<a href="${siteBase}/subscribe">订阅每日邮件</a>
<a href="${siteBase}/">进站看全部</a>
<a href="${siteBase}/daily/">历史日报</a>
<a href="${siteBase}/archive/">内容归档</a>
</footer>`;

  const bodyHtml = `<style>${ITEM_BODY_STYLE}</style>
<div class="wrap">
<header>
<div class="brand"><a href="${siteBase}/">${escapeHtml(brandName)}</a></div>
<div class="date">${escapeHtml(label)}</div>
${archiveLinks}
</header>
<main>
<article>
<h1 style="font-size:22px;font-weight:700;line-height:1.4;margin:12px 0 10px">${escapeHtml(item.title)}</h1>
${coverHtml}
${bodyContent}
<div class="meta">${metaBits.join('')}</div>
<p><a class="subscribe-btn" style="display:inline-block" href="${escapeHtml(deepUrl)}">${ctaLabel}</a></p>
</article>
${relatedHtml}
</main>
${footerHtml}
</div>`;

  return renderSeoPageShell({
    lang: 'zh-CN',
    title: pageTitle,
    description,
    canonical,
    ogImage: cover,
    ogType: 'article',
    jsonLd,
    bodyHtml,
  });
}
