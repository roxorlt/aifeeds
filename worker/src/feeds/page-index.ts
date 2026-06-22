// worker/src/feeds/page-index.ts
//
// Phase 3「页面抓取」列表发现:没有 RSS 的厂商博客,从 sitemap 拿「最近 N 篇文章的
// URL + lastmod 日期」,产出与 parseFeed 同构的 ParsedFeedItem[]。文章真标题 / 封面 /
// 发布时间由 blog-pipeline step3(extractFullText + extractPageMeta 抽 og: 元数据)补全,
// 本模块只负责「发现」。
//
// 设计文档:docs/plans/2026-06-09-ai-vendor-feeds-source-design.md §3.3 / §6.4。
// 仅覆盖「sitemap 带 lastmod」的源(AI21 / Cohere);无 lastmod 的源(Databricks:sitemap
// 无 lastmod、无法按日期排序)需 HTML-index anchor 变体,留后续增量。

import type { FeedDef, ParsedFeedItem } from "./types";
import { throttledFetchText } from "./extract";

/** 每个 page-scrape 源的发现配置(按 feed.key 查)。 */
interface PageIndexConfig {
  /** sitemap URL(可为 sitemapindex,自动下钻一层)。 */
  sitemaps: string[];
  /** 判定某 URL 是不是「文章」(排除 category / author / tag / locale 变体 / 列表页)。 */
  isArticle: (url: string) => boolean;
  /** 取按 lastmod 倒序的最近 N 篇(冷启动再由 COLD_START_MAX 二次限深)。 */
  recentN: number;
}

const PAGE_INDEX: Record<string, PageIndexConfig> = {
  // AI21 Labs:WordPress 风 post-sitemap,只含文章 + 带 lastmod。
  ai21: {
    sitemaps: ["https://www.ai21.com/post-sitemap.xml"],
    isArticle: (u) =>
      /^https:\/\/www\.ai21\.com\/blog\/[^/]+\/?$/.test(u) &&
      !/\/blog\/(category|tag|author|page)\b/.test(u),
    recentN: 15,
  },
  // Cohere:扁平 sitemap,/blog/<slug> 带 lastmod;排除 locale 前缀变体(/ja/blog/ 等)+ authors/tag。
  cohere: {
    sitemaps: ["https://cohere.com/sitemap.xml"],
    isArticle: (u) =>
      /^https:\/\/cohere\.com\/blog\/[^/]+$/.test(u) &&
      !/\/blog\/(authors?|tag|category|page)\b/.test(u),
    recentN: 15,
  },
};

/** 是否已配置 page-scrape 发现(blog.ts 据此决定走 sitemap 还是 RSS)。 */
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

/** slug → 占位标题(非空即可喂 step1 gate;真标题由 step3 og:title 覆盖)。 */
function slugTitle(loc: string): string {
  try {
    const path = new URL(loc).pathname.replace(/\/+$/, "");
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

/**
 * Phase 3 sitemap 列表发现。产出 ParsedFeedItem[]:
 *   - guid / link = 文章绝对 URL
 *   - title       = slug 占位(step3 用 og:title 覆盖真标题)
 *   - published_at = sitemap lastmod(step3 可用 article:published_time 精修)
 */
export async function discoverPageIndex(feed: FeedDef): Promise<ParsedFeedItem[]> {
  const cfg = PAGE_INDEX[feed.key];
  if (!cfg) {
    console.warn(`[page-index] no config for ${feed.id}; skip`);
    return [];
  }

  // 1. 抓 sitemap(index 型下钻一层),收集所有 url 条目
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

  // 2. 过滤文章 + 去重 + 按 lastmod 倒序 + 取最近 N
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
    `[page-index] ${feed.id}: collected=${collected.length} articles=${articles.length}`,
  );

  return articles.map((u) => ({
    guid: u.loc,
    link: u.loc,
    title: slugTitle(u.loc),
    published_at: normalizeLastmod(u.lastmod),
  }));
}
