// worker/src/feeds/page-index.ts
//
// Phase 3「页面抓取」列表发现:没有 RSS(或 RSS 已坏)的厂商博客,发现「最近 N 篇文章的
// URL + 日期」,产出与 parseFeed 同构的 ParsedFeedItem[]。真标题 / 封面 / 发布时间由
// blog-pipeline step3(extractFullText + extractPageMeta 抽 og:)补全,本模块只负责「发现」。
//
// 两种发现方式(按源配置 method 分派):
//   - sitemap     站点 sitemap 带 <lastmod>(AI21 / Cohere)。最稳。
//   - html-index  扒首页/归档页 HTML 的文章 anchor(Databricks:date 靠详情页 og;
//                 美团:date 在 URL /YYYY/MM/DD/ 里)。sitemap 无 lastmod / 无 sitemap 时用。
//
// 设计文档:docs/plans/2026-06-09-ai-vendor-feeds-source-design.md §3.3 / §6.4。

import type { FeedDef, ParsedFeedItem } from "./types";
import { throttledFetchText } from "./extract";

interface SitemapCfg {
  method: "sitemap";
  /** sitemap URL(可为 sitemapindex,自动下钻一层)。 */
  sitemaps: string[];
  /** 判定某 URL 是不是「文章」(排除 category / author / tag / locale 变体)。 */
  isArticle: (url: string) => boolean;
  recentN: number;
}
interface HtmlIndexCfg {
  method: "html-index";
  /** 列表页 URL(首页 / 归档页;可多个,合并去重)。 */
  indexUrls: string[];
  /** 判定 anchor 绝对 URL 是不是「文章」。 */
  isArticle: (url: string) => boolean;
  /** 从文章 URL 抽发布日期(如美团 /YYYY/MM/DD/);无则 step3 用 og: 补。 */
  dateFromUrl?: (url: string) => string | undefined;
  recentN: number;
}
type PageIndexConfig = SitemapCfg | HtmlIndexCfg;

/** 美团 URL /2026/06/18/slug.html → 2026-06-18T00:00:00Z。 */
function meituanDateFromUrl(url: string): string | undefined {
  const m = url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  return m ? `${m[1]}-${m[2]}-${m[3]}T00:00:00Z` : undefined;
}

const PAGE_INDEX: Record<string, PageIndexConfig> = {
  // Anthropic: 官方无 RSS；从官方 sitemap 仅保留 /news/<slug>，详情页由 blog pipeline 抽取。
  anthropic: {
    method: "sitemap",
    sitemaps: ["https://www.anthropic.com/sitemap.xml"],
    isArticle: (u) => /^https:\/\/www\.anthropic\.com\/news\/[^/?#]+\/?$/.test(u),
    recentN: 20,
  },
  // AI21 Labs:WordPress 风 post-sitemap,只含文章 + 带 lastmod。
  ai21: {
    method: "sitemap",
    sitemaps: ["https://www.ai21.com/post-sitemap.xml"],
    isArticle: (u) =>
      /^https:\/\/www\.ai21\.com\/blog\/[^/]+\/?$/.test(u) &&
      !/\/blog\/(category|tag|author|page)\b/.test(u),
    recentN: 15,
  },
  // Cohere:扁平 sitemap,/blog/<slug> 带 lastmod;排除 locale 前缀变体 + authors/tag。
  cohere: {
    method: "sitemap",
    sitemaps: ["https://cohere.com/sitemap.xml"],
    isArticle: (u) =>
      /^https:\/\/cohere\.com\/blog\/[^/]+$/.test(u) &&
      !/\/blog\/(authors?|tag|category|page)\b/.test(u),
    recentN: 15,
  },
  // Databricks:sitemap 无 lastmod → 扒首页 anchor(文档顺序≈最新在前),date 靠详情页 og。
  databricks: {
    method: "html-index",
    indexUrls: ["https://www.databricks.com/blog"],
    isArticle: (u) =>
      /^https:\/\/www\.databricks\.com\/blog\/[^/]+$/.test(u) &&
      !/\/blog\/(category|authors?|tag)$/.test(u),
    recentN: 15,
  },
  // MiniMax(minimax.io/news):Next.js app-router,server 端只渲染最新数篇 /news/<slug> anchor
  //（其余在 JS 里）。取这几篇最新即可(新文章滚动进"最新"菜单);date/标题靠详情页 og(ISO datePublished)。
  minimax: {
    method: "html-index",
    indexUrls: ["https://www.minimax.io/news"],
    isArticle: (u) => /^https:\/\/www\.minimax\.io\/news\/[a-z0-9-]+$/.test(u),
    recentN: 12,
  },
  // 美团技术团队:原 RSS(/feed/)已 301 迁走且停更 → 扒首页 + 归档页;date 在 URL /YYYY/MM/DD/。
  "meituan-tech": {
    method: "html-index",
    indexUrls: ["https://tech.meituan.com/", "https://tech.meituan.com/history.html"],
    isArticle: (u) =>
      /^https:\/\/tech\.meituan\.com\/\d{4}\/\d{2}\/\d{2}\/[^/]+\.html$/.test(u),
    dateFromUrl: meituanDateFromUrl,
    recentN: 15,
  },
};

/** 是否已配置 page-scrape 发现(blog.ts 据此决定走列表发现还是 RSS)。 */
export function hasPageIndexConfig(feedKey: string): boolean {
  return feedKey in PAGE_INDEX;
}

const SITEMAP_FETCH_MAX = 6; // sitemapindex 下钻时最多抓的子 sitemap 数(防爆)

/** 从 block 取首个 <name>..</name> 内容(单行 XML 鲁棒)。 */
function tagInner(block: string, name: string): string | null {
  const m = block.match(
    new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"),
  );
  return m ? m[1].trim() : null;
}

/** 解析 sitemap XML → 子 sitemap 列表(index 型) + url 条目(url 型)。 */
function parseSitemap(xml: string): {
  childSitemaps: string[];
  urls: Array<{ loc: string; lastmod?: string }>;
} {
  const childSitemaps: string[] = [];
  const urls: Array<{ loc: string; lastmod?: string }> = [];
  let m: RegExpExecArray | null;

  const smRe = /<sitemap\b[\s\S]*?<\/sitemap>/gi;
  while ((m = smRe.exec(xml)) !== null) {
    const loc = tagInner(m[0], "loc");
    if (loc) childSitemaps.push(loc);
  }
  const urlRe = /<url\b[\s\S]*?<\/url>/gi;
  while ((m = urlRe.exec(xml)) !== null) {
    const loc = tagInner(m[0], "loc");
    if (!loc) continue;
    urls.push({ loc, lastmod: tagInner(m[0], "lastmod") || undefined });
  }
  return { childSitemaps, urls };
}

/** 抽 HTML 里所有 <a href> 的绝对 URL(按 base 解析,去重)。 */
function extractAnchorUrls(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let abs: string;
    try {
      abs = new URL(m[1].trim(), baseUrl).toString();
    } catch {
      continue;
    }
    if (!seen.has(abs)) {
      seen.add(abs);
      out.push(abs);
    }
  }
  return out;
}

/** slug → 占位标题(非空即可喂 step1 gate;真标题由 step3 og:title 覆盖)。 */
function slugTitle(loc: string): string {
  try {
    const path = new URL(loc).pathname.replace(/\.html?$/, "").replace(/\/+$/, "");
    const slug = path.split("/").pop() || "";
    return slug.replace(/[-_]+/g, " ").trim();
  } catch {
    return "";
  }
}

/** lastmod → ISO8601(纯日期补 T00:00:00Z;已是 ISO 原样)。 */
function normalizeLastmod(lastmod?: string): string | undefined {
  if (!lastmod) return undefined;
  const s = lastmod.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00Z`;
  return s;
}

async function discoverViaSitemap(cfg: SitemapCfg): Promise<Array<{ loc: string; lastmod?: string }>> {
  const collected: Array<{ loc: string; lastmod?: string }> = [];
  for (const smUrl of cfg.sitemaps) {
    const xml = await throttledFetchText(smUrl);
    if (!xml) continue;
    const parsed = parseSitemap(xml);
    if (parsed.urls.length > 0) {
      collected.push(...parsed.urls);
    } else if (parsed.childSitemaps.length > 0) {
      for (const child of parsed.childSitemaps.slice(0, SITEMAP_FETCH_MAX)) {
        const cxml = await throttledFetchText(child);
        if (cxml) collected.push(...parseSitemap(cxml).urls);
      }
    }
  }
  return collected;
}

async function discoverViaHtmlIndex(cfg: HtmlIndexCfg): Promise<Array<{ loc: string; lastmod?: string }>> {
  const collected: Array<{ loc: string; lastmod?: string }> = [];
  for (const indexUrl of cfg.indexUrls) {
    const html = await throttledFetchText(indexUrl);
    if (!html) continue;
    for (const loc of extractAnchorUrls(html, indexUrl)) {
      collected.push({ loc, lastmod: cfg.dateFromUrl?.(loc) });
    }
  }
  return collected;
}

/**
 * Phase 3 列表发现(sitemap / html-index)。产出 ParsedFeedItem[]:
 *   guid/link=文章 URL;title=slug 占位(step3 og:title 覆盖);published_at=lastmod / URL 日期(step3 og 精修)。
 */
export async function discoverPageIndex(feed: FeedDef): Promise<ParsedFeedItem[]> {
  const cfg = PAGE_INDEX[feed.key];
  if (!cfg) {
    console.warn(`[page-index] no config for ${feed.id}; skip`);
    return [];
  }

  const collected =
    cfg.method === "sitemap"
      ? await discoverViaSitemap(cfg)
      : await discoverViaHtmlIndex(cfg);

  // 过滤文章 + 去重 + 按日期倒序(无日期项 stable sort 保留文档顺序)+ 取最近 N
  const seen = new Set<string>();
  const articles = collected
    .filter((u) => {
      if (!cfg.isArticle(u.loc) || seen.has(u.loc)) return false;
      seen.add(u.loc);
      return true;
    })
    .sort((a, b) => (b.lastmod || "").localeCompare(a.lastmod || ""))
    .slice(0, cfg.recentN);

  console.log(
    `[page-index] ${feed.id}: method=${cfg.method} collected=${collected.length} articles=${articles.length}`,
  );

  return articles.map((u) => ({
    guid: u.loc,
    link: u.loc,
    title: slugTitle(u.loc),
    published_at: normalizeLastmod(u.lastmod),
  }));
}
