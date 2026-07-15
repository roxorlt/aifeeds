// digest 渲染共享纯函数:把 items 行按源转成对外 JSON 条目(rank + cover + 中文 title/summary)。
// 供 daily-api 实时渲染用。逻辑与 deliver.ts toDigestItem 对齐(clawhub 用 summary_translated);
// cover 取值对齐前端流内卡片:ph=媒体logo / gh=owner头像 / hf=社交缩略图 / x=推文附图 / clawhub=无。
// (deliver.ts 暂保留自己的私有副本,不在本次重构,避免动邮件链路。)

import type { DigestSource } from './config';
import { stripLabelPrefix } from '../feeds/classify-translate';
import { COVER_BLACKLIST, passesCoverSizeGate, isNoCoverSource } from '../feeds/cover-heuristics';
import { isSkippableInlineImage, normalizeImageAlias } from '../feeds/editorial-image';

export { isSkippableInlineImage } from '../feeds/editorial-image';

export interface RenderRow {
  id: string;
  title: string | null;
  content: string | null;
  content_translated: string | null;
  author: string | null;
  handle: string | null;
  url: string | null;
  media: string | null; // JSON string
  extra: string | null; // JSON string
}

export interface MediaAsset {
  type: 'image' | 'video';
  url: string; // 图片 URL,或视频播放源(mp4 / youtube 链接);相对路径已拼 apiBase
  poster?: string; // 视频封面帧(已拼 apiBase)
}

export interface RenderedItem {
  rank: number; // 该源热度排名(1-based)
  item_id: string;
  source: DigestSource;
  title: string;
  summary: string; // 截断到 ~180,跟邮件一致
  summary_full: string; // 完整(静态页可用更长)
  url: string;
  deep_link: string; // 站内抽屉深链
  author: string;
  cover: string | null; // 流内封面(通常 = media 第一张实质图);相对路径已拼 apiBase,无则 null
  logo: string | null; // 品牌 logo/icon(PH 产品图标;其他源多为 null)
  media: MediaAsset[]; // 详情页所有图片+视频(尽可能多;logo 不含在内;无媒体为 [])
  duration_sec?: number; // 播客单集时长(秒);仅 podcast(行业新闻板块)有,blog/其他源省略
  guests?: string[]; // 播客本集嘉宾名(LLM 抽取);仅 podcast 且抽到嘉宾时有
  intro?: string; // 内容简介:图文新闻→excerpt_zh / 播客→shownotes_zh(比一句话 summary 更完整);仅行业新闻有
  timeline?: Array<{ ts: string; topic: string; speaker?: string; point: string }>; // 话题脉络:仅有原生时间戳文字稿的 podcast 有
}

export function cleanText(s: string): string {
  return (s || '').replace(/[#*`>_~]/g, '').replace(/\s+/g, ' ').trim();
}

export function clampSentences(s: string, maxLen = 180): string {
  const clean = cleanText(s);
  if (clean.length <= maxLen) return clean;
  const slice = clean.slice(0, maxLen);
  const lastPunct = Math.max(
    slice.lastIndexOf('。'),
    slice.lastIndexOf('！'),
    slice.lastIndexOf('？'),
    slice.lastIndexOf('；'),
  );
  return lastPunct > maxLen * 0.5 ? slice.slice(0, lastPunct + 1) : slice + '…';
}

export function deepLinkPath(itemId: string): string {
  const idx = itemId.indexOf(':');
  if (idx < 0) return '/';
  const st = itemId.slice(0, idx);
  const sid = itemId.slice(idx + 1);
  switch (st) {
    case 'x_list':
      return `/t/${encodeURIComponent(sid)}`;
    case 'github': {
      const [o, r] = sid.split('/');
      return o && r ? `/g/${encodeURIComponent(o)}/${encodeURIComponent(r)}` : '/';
    }
    case 'product_hunt': {
      const [slug, date] = sid.split(':');
      return slug && date ? `/ph/${encodeURIComponent(slug)}/${encodeURIComponent(date)}` : '/';
    }
    case 'clawhub':
      return `/c/${encodeURIComponent(sid)}`;
    case 'hf_paper':
      return `/h/${encodeURIComponent(sid)}`;
    case 'blog':
    case 'podcast':
      // 行业新闻(blog/podcast):/o/<完整 composite id>,对齐 dashboard parseDeepLinkFromPath
      return `/o/${encodeURIComponent(itemId)}`;
    default:
      return '/';
  }
}

// ─── item SSR 静态页 URL 映射（/i/…；deepLinkPath 是 SPA 抽屉深链，两者独立不复用）──────
// 出页的 5 类源段。clawhub / huodongxing / 未知源不出独立静态页。
export const ITEM_URL_SOURCES = ['x', 'gh', 'ph', 'paper', 'news'] as const;
export type ItemUrlSource = (typeof ITEM_URL_SOURCES)[number];

// items.source_type → item 页 URL 段（反向于 selection.ts 的 SOURCE_TYPE）。
// 出页 5 类返回对应段；clawhub / huodongxing / 未知 → null（不出静态页）。
export function sourceTypeToUrlSource(sourceType: string): ItemUrlSource | null {
  switch (sourceType) {
    case 'x_list':
      return 'x';
    case 'github':
      return 'gh';
    case 'product_hunt':
      return 'ph';
    case 'hf_paper':
      return 'paper';
    case 'blog':
    case 'podcast':
      return 'news';
    default:
      return null;
  }
}

// composite id（`${source_type}:${source_id}`）→ item 静态页路径 /i/…，不可出页返回 null。
//   x_list:123            -> /i/x/123
//   github:owner/repo     -> /i/gh/owner/repo
//   product_hunt:slug:D   -> /i/ph/slug        （丢弃末尾 :date）
//   hf_paper:2501.1       -> /i/paper/2501.1   （URL 段用 paper，不是 hf-paper）
//   blog:… | podcast:…    -> /i/news/<url-safe(整 composite id)>
//   clawhub / huodongxing / 未知 -> null
export function itemPagePath(itemId: string): string | null {
  const idx = itemId.indexOf(':');
  if (idx < 0) return null;
  const st = itemId.slice(0, idx);
  const sid = itemId.slice(idx + 1);
  switch (st) {
    case 'x_list':
      return sid ? `/i/x/${encodeURIComponent(sid)}` : null;
    case 'github': {
      const [o, r] = sid.split('/');
      return o && r ? `/i/gh/${encodeURIComponent(o)}/${encodeURIComponent(r)}` : null;
    }
    case 'product_hunt': {
      // composite id 末尾带 :date，静态页 URL 只保留 slug（丢 date）。
      const slug = sid.split(':')[0];
      return slug ? `/i/ph/${encodeURIComponent(slug)}` : null;
    }
    case 'hf_paper':
      return sid ? `/i/paper/${encodeURIComponent(sid)}` : null;
    case 'blog':
    case 'podcast':
      // 行业新闻：整 composite id 做 url-safe 编码（对齐 deepLinkPath /o/ 的整 id 语义）。
      return `/i/news/${encodeURIComponent(itemId)}`;
    default:
      return null;
  }
}

// composite id → item 静态页 R2 key（`items/<urlSource>/<url-safe composite id>.html`）。
// 与 itemPagePath 同源 gate：不可出页（clawhub / huodongxing / 未知）返回 null。
// Task 3 伺服层读、Task 4 生成层写，共用此函数确保 R2 key 不漂移。
//   <source> 段用 URL source（x/gh/ph/paper/news），与 url_path 前缀一致；
//   <id-safe> = 整 composite id 的 encodeURIComponent（`:` `/` 等一律转义，落单段 key）。
//   product_hunt:slug:date 用整 id（含 date）编码 —— 伺服层先把 /i/ph/slug 反解为最新 composite id 再算 key。
export function itemPageR2Key(itemId: string): string | null {
  const idx = itemId.indexOf(':');
  if (idx < 0) return null;
  const urlSource = sourceTypeToUrlSource(itemId.slice(0, idx));
  if (!urlSource) return null;
  return `items/${urlSource}/${encodeURIComponent(itemId)}.html`;
}

function ghRepoName(itemId: string): string {
  const idx = itemId.indexOf(':');
  const sid = idx >= 0 ? itemId.slice(idx + 1) : itemId;
  const slash = sid.lastIndexOf('/');
  return slash >= 0 ? sid.slice(slash + 1) : sid;
}

function ghOwner(itemId: string): string {
  const idx = itemId.indexOf(':');
  const sid = idx >= 0 ? itemId.slice(idx + 1) : itemId;
  return sid.split('/')[0] || '';
}

function safeParse(s: string | null): Record<string, unknown> {
  try {
    return JSON.parse(s || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

// GH README excerpt 抽所有非 badge 图(<img>/![]()),按出现顺序去重 + 拼 abs URL。
// cover 取第一张,media 取全部。跳过 .svg 和 shields 类 badge;/r/ 拼 apiBase,相对路径拼 raw.githubusercontent。
function resolveReadmeImages(readme: string, owner: string, repo: string, branch: string, apiBase: string): string[] {
  const raw: string[] = [];
  let m: RegExpExecArray | null;
  const mdRe = /!\[[^\]]*\]\(([^)\s]+)/g;
  while ((m = mdRe.exec(readme)) !== null) raw.push(m[1]);
  const htmlRe = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
  while ((m = htmlRe.exec(readme)) !== null) raw.push(m[1]);
  const isBadge = (u: string): boolean =>
    /\.svg(\?|$)/i.test(u) || /(shields\.io|badgen\.net|badge\.fury|forthebadge|img\.shields)/i.test(u);
  const base = `https://raw.githubusercontent.com/${owner}/${repo}/${branch || 'main'}`;
  const resolve = (u: string): string => {
    if (/^(https?:|data:|blob:)/i.test(u)) return u;
    if (u.startsWith('/r/')) return `${apiBase}${u}`;
    return u.startsWith('/') ? `${base}${u}` : `${base}/${u.replace(/^\.\//, '')}`;
  };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of raw) {
    if (isBadge(u)) continue;
    const r = resolve(u);
    if (!seen.has(r)) {
      seen.add(r);
      out.push(r);
    }
  }
  return out;
}

// renderItem 可选项。默认全 false,保证 daily-api / codex-push 路径逐字节不变;
// 仅 SEO 静态日报页(daily-page.ts)开启 newsCoverQualityGate。
export interface RenderOptions {
  // news 源封面质量门:拒外链 cover_image、回退只认 R2 正文图、黑名单 + 尺寸过滤。
  // 静态日报页无 JS 兜底(不能像前端卡片那样 onError/onLoad reject),故在渲染层挡。
  newsCoverQualityGate?: boolean;
  // 静态日报页 SEO 扩展摘要:为「非 news 源」(hf/gh/ph/x)也填充 intro = 每源最优加长字段。
  // 默认关 → codex-push / daily-api 的 renderItem 输出逐字节不变(它们不传此项,非 news 源无 intro)。
  // news 源 intro 始终为 excerpt_zh/shownotes_zh,与本开关无关(见 renderItem intro 分支)。
  extendedIntro?: boolean;
}

// 站内 R2 反代 URL 判定:相对 `/r/` 前缀,或 api 域绝对形式(`<apiBase>/r/...`)。
// 第三方域名里的 `/r/` 不算(必须是本站 apiBase),避免误放外链。
function isInternalR2(u: string | null | undefined, apiBase: string): boolean {
  if (!u) return false;
  if (u.startsWith('/r/')) return true;
  return !!apiBase && u.startsWith(`${apiBase}/r/`);
}

// news 封面垃圾 URL 黑名单 + 尺寸门统一到 feeds/cover-heuristics.ts（COVER_BLACKLIST /
// passesCoverSizeGate），与 media-r2.ts pickBodyHeroCover 共用同一口径，消除复制漂移（Minor，2026-07-06）。

interface CoverCandidate { r2: string; orig: string; width?: number; height?: number }

// news 正文图封面候选:只收「有 R2 形态可用」的 asset(用 r2_url,绝不用原始外链 url)+
// 已迁移为 /r/ 的 body_markdown inline 图。外链态一律不入选(症状 1 挂图根源)。
function bodyCoverCandidates(ex: Record<string, unknown>, apiBase: string): CoverCandidate[] {
  const out: CoverCandidate[] = [];
  const seen = new Set<string>();
  const blockedAliases = newsBlockedImageAliases(ex);
  const push = (r2: string, orig: string, width?: number, height?: number) => {
    if (
      !r2
      || seen.has(r2)
      || isNewsImageBlocked(r2, blockedAliases)
      || isNewsImageBlocked(orig, blockedAliases)
    ) return;
    seen.add(r2);
    out.push({ r2, orig: orig || r2, width, height });
  };
  const body = ex.body;
  if (body && typeof body === 'object') {
    const assets = (body as { assets?: unknown }).assets;
    if (Array.isArray(assets)) {
      for (const asset of assets) {
        if (!asset || typeof asset !== 'object') continue;
        const a = asset as { url?: unknown; r2_url?: unknown; kind?: unknown; width?: unknown; height?: unknown };
        if (a.kind && a.kind !== 'image') continue; // 跳视频/非图
        const orig = typeof a.url === 'string' ? a.url : '';
        const r2raw = typeof a.r2_url === 'string' ? a.r2_url : '';
        const r2 = isInternalR2(r2raw, apiBase) ? r2raw : isInternalR2(orig, apiBase) ? orig : '';
        if (!r2) continue; // 纯外链 asset → 不当封面
        const width = typeof a.width === 'number' ? a.width : undefined;
        const height = typeof a.height === 'number' ? a.height : undefined;
        push(r2, orig, width, height);
      }
    }
  }
  // body_markdown 内嵌图:仅收已迁 R2 的(外链态跳过);无尺寸元数据,靠黑名单放行。
  for (const field of ['body_markdown_zh', 'body_markdown', 'excerpt_zh', 'excerpt']) {
    const value = typeof ex[field] === 'string' ? (ex[field] as string) : '';
    for (const u of inlineImageUrls(value)) {
      if (isInternalR2(u, apiBase)) push(u, u);
    }
  }
  return out;
}

// news 封面质量门(仅日报静态页启用):R2 cover_image 直采,否则回退过滤后的 R2 正文图。
function pickNewsCoverGated(ex: Record<string, unknown>, apiBase: string): string | null {
  const abs = (u: string): string => (u.startsWith('http') ? u : `${apiBase}${u}`);
  const blockedAliases = newsBlockedImageAliases(ex);
  // 0. 源级 no-cover 短路(Fix 2,2026-07-07):NO_COVER_SOURCES 名单内源在任何数据形态下都不出封面
  //    —— 与 cover-heuristics 同口径的 srcKey(feed_key,退化 show_key/'blog')。是数据层三点之外的
  //    渲染层纵深:哪怕数据里意外残留 cover_image / 正文图,daily 页也硬约束为 monogram 兜底。
  const srcKey = String(ex.feed_key || (ex as { show_key?: string }).show_key || 'blog');
  if (isNoCoverSource(srcKey)) return null;
  // 1. cover_image 仅当站内 R2 反代形态才直采(外链态视为无效,进回退链)。
  const cov = String((ex.cover_image as string) || '').trim();
  if (cov && isInternalR2(cov, apiBase) && !isNewsImageBlocked(cov, blockedAliases)) return abs(cov);
  // 2. 回退:按顺序取第一张通过黑名单 + 尺寸门的 R2 正文图。
  for (const c of bodyCoverCandidates(ex, apiBase)) {
    if (COVER_BLACKLIST.test(c.orig) || COVER_BLACKLIST.test(c.r2)) continue;
    // 与前端卡片缩略图 qualityGate 同参:maxDim≥240 且 0.5≤ar≤2（共享 passesCoverSizeGate）。
    if (!passesCoverSizeGate(c.width, c.height)) continue;
    return abs(c.r2);
  }
  // 3. 全部不过 → 无封面(渲染层不出 <img>,与站内抽屉一致的纯文字降级)。
  return null;
}

// 封面图(对齐前端流内卡片 + 用户规则:gh/hf/ph 取真图,x 仅推文附图,clawhub 不取头像)
function pickCover(
  source: DigestSource,
  row: RenderRow,
  ex: Record<string, unknown>,
  apiBase: string,
  opts: RenderOptions = {},
): string | null {
  const abs = (u: string | null | undefined): string | null =>
    !u ? null : u.startsWith('http') ? u : `${apiBase}${u}`;
  let media: unknown = null;
  try {
    media = JSON.parse(row.media || 'null');
  } catch {
    /* ignore */
  }
  const imgs = Array.isArray(media)
    ? (media as Array<Record<string, unknown>>).filter((m) => m && m.type === 'image' && m.url)
    : [];
  switch (source) {
    case 'ph': {
      // 流内卡片封面 = 第一张非 logo 的 image(产品截图/hero shot),否则 video poster;
      // logo 只是头部 40×40 小图标,不当封面。对齐前端 PhCard.selectPhCover + share/handlers。
      const shot = imgs.find((m) => m.role !== 'logo');
      if (shot) return abs(shot.url as string);
      const vids = Array.isArray(media)
        ? (media as Array<Record<string, unknown>>).filter((m) => m && m.type === 'video')
        : [];
      for (const v of vids) {
        const poster = (v.poster as string) || (v.url as string); // PH video.url 即缩略图
        if (poster) return abs(poster);
      }
      return null;
    }
    case 'gh': {
      // 流内封面 = README 第一张真图(hero/截图),无则 null;owner 头像不当封面
      const readme = typeof ex.readme_excerpt === 'string' ? (ex.readme_excerpt as string) : '';
      if (!readme) return null;
      return resolveReadmeImages(readme, ghOwner(row.id), ghRepoName(row.id), (ex.default_branch as string) || 'main', apiBase)[0] || null;
    }
    case 'hf-paper': {
      if (imgs.length) return abs(imgs[0].url as string);
      const fig = ex.figure_image as Record<string, unknown> | undefined;
      if (fig && typeof fig === 'object' && fig.r2_url) return abs(fig.r2_url as string);
      return null;
    }
    case 'x': {
      // 推文附图;有 video 用 poster(X video.url 是 mp4 流,不能当图);都没有 null(不用作者头像)
      if (imgs.length) return abs(imgs[0].url as string);
      const vids = Array.isArray(media)
        ? (media as Array<Record<string, unknown>>).filter((m) => m && m.type === 'video')
        : [];
      for (const v of vids) {
        if (v.poster) return abs(v.poster as string);
      }
      return null;
    }
    case 'clawhub':
      return null; // 不用作者头像
    case 'news': {
      // 日报静态页(newsCoverQualityGate)走质量门:拒外链 cover、回退只认 R2 正文图 + 黑名单/尺寸过滤。
      if (opts.newsCoverQualityGate) return pickNewsCoverGated(ex, apiBase);
      // 默认路径(daily-api / codex-push)保持原逻辑,逐字节不变:
      // 封面 = extra.cover_image,否则 media 第一张图,再否则正文 assets 第一张图。
      const blockedAliases = newsBlockedImageAliases(ex);
      const cov = (ex.cover_image as string) || '';
      if (cov && !isNewsImageBlocked(cov, blockedAliases)) return abs(cov);
      const cleanMediaImage = imgs.find(
        (img) => !isNewsImageBlocked(String(img.url || ''), blockedAliases),
      );
      if (cleanMediaImage) return abs(cleanMediaImage.url as string);
      const bodyImg = bodyImageAssets(ex)[0];
      return bodyImg ? abs(bodyImg.url) : null;
    }
    default:
      return null;
  }
}

// 品牌 logo/icon 独立字段。目前仅 PH 有产品 logo(media role=logo);其他源无产品 logo → null。
function pickLogo(source: DigestSource, row: RenderRow, apiBase: string): string | null {
  if (source !== 'ph') return null;
  let media: unknown = null;
  try {
    media = JSON.parse(row.media || 'null');
  } catch {
    /* ignore */
  }
  if (!Array.isArray(media)) return null;
  const logo = (media as Array<Record<string, unknown>>).find(
    (m) => m && m.type === 'image' && m.role === 'logo' && m.url,
  );
  if (!logo) return null;
  const u = logo.url as string;
  return u.startsWith('http') ? u : `${apiBase}${u}`;
}

// 详情页所有图片+视频(尽可能多)。logo 不进 media(单独字段);按 url 去重。
function buildMedia(source: DigestSource, row: RenderRow, ex: Record<string, unknown>, apiBase: string): MediaAsset[] {
  const abs = (u: string | null | undefined): string => (!u ? '' : u.startsWith('http') ? u : `${apiBase}${u}`);
  let media: unknown = null;
  try {
    media = JSON.parse(row.media || 'null');
  } catch {
    /* ignore */
  }
  const arr = Array.isArray(media) ? (media as Array<Record<string, unknown>>) : [];
  const out: MediaAsset[] = [];
  switch (source) {
    case 'ph':
      for (const m of arr) {
        if (m.role === 'logo') continue; // logo 单独字段
        if (m.type === 'image' && m.url) out.push({ type: 'image', url: abs(m.url as string) });
        else if (m.type === 'video') {
          // PH video:url 是缩略图(jpeg),videoUrl 是 youtube 播放链接
          out.push({ type: 'video', url: (m.videoUrl as string) || abs(m.url as string), poster: abs(m.url as string) });
        }
      }
      break;
    case 'gh': {
      const readme = typeof ex.readme_excerpt === 'string' ? (ex.readme_excerpt as string) : '';
      if (readme) {
        for (const u of resolveReadmeImages(readme, ghOwner(row.id), ghRepoName(row.id), (ex.default_branch as string) || 'main', apiBase)) {
          out.push({ type: 'image', url: u });
        }
      }
      break;
    }
    case 'hf-paper': {
      for (const m of arr) if (m.type === 'image' && m.url) out.push({ type: 'image', url: abs(m.url as string) });
      const fig = ex.figure_image as Record<string, unknown> | undefined;
      if (fig && typeof fig === 'object') {
        const fu = (fig.r2_url as string) || (fig.raw_url as string);
        if (fu) out.push({ type: 'image', url: abs(fu) });
      }
      break;
    }
    case 'x':
      for (const m of arr) {
        if (m.type === 'image' && m.url) out.push({ type: 'image', url: abs(m.url as string) });
        else if (m.type === 'video') {
          // X video:url 是 mp4 流,poster 是缩略图
          const v: MediaAsset = { type: 'video', url: abs(m.url as string) };
          if (m.poster) v.poster = abs(m.poster as string);
          out.push(v);
        }
      }
      break;
    case 'clawhub':
      break; // skill 无媒体
    case 'news': {
      // 行业新闻:博客/播客正文图片(及视频)
      const blockedAliases = newsBlockedImageAliases(ex);
      for (const m of arr) {
        if (
          m.type === 'image'
          && m.url
          && !isNewsImageBlocked(String(m.url), blockedAliases)
        ) out.push({ type: 'image', url: abs(m.url as string) });
        else if (m.type === 'video' && m.url) {
          const v: MediaAsset = { type: 'video', url: abs(m.url as string) };
          if (m.poster) v.poster = abs(m.poster as string);
          out.push(v);
        }
      }
      for (const m of bodyImageAssets(ex)) {
        out.push({ type: 'image', url: abs(m.url) });
      }
      break;
    }
  }
  const seen = new Set<string>();
  return out.filter((a) => {
    const k = `${a.url}|${a.poster || ''}`;
    if (seen.has(k) || !a.url) return false;
    seen.add(k);
    return true;
  });
}

function bodyImageAssets(ex: Record<string, unknown>): Array<{ url: string }> {
  const out: Array<{ url: string }> = [];
  const seen = new Set<string>();
  const blockedAliases = newsBlockedImageAliases(ex);
  const add = (url: string) => {
    const u = String(url || '').trim();
    if (!u || seen.has(u) || isNewsImageBlocked(u, blockedAliases)) return;
    seen.add(u);
    out.push({ url: u });
  };
  const body = ex.body;
  if (body && typeof body === 'object') {
    const assets = (body as { assets?: unknown }).assets;
    if (Array.isArray(assets)) {
      for (const asset of assets) {
        if (
          !!asset
          && typeof asset === 'object'
          && typeof (asset as { url?: unknown }).url === 'string'
          && ((asset as { kind?: unknown }).kind === 'image' || !(asset as { kind?: unknown }).kind)
        ) {
          add((asset as { url: string }).url);
        }
      }
    }
  }
  for (const field of ['body_markdown_zh', 'body_markdown', 'excerpt_zh', 'excerpt']) {
    const value = typeof ex[field] === 'string' ? (ex[field] as string) : '';
    for (const url of inlineImageUrls(value)) add(url);
  }
  return out;
}

// 原始作者头像迁进 R2 后，/r/<hash> 已不再带 author_profile/BLURPLE 字样；通过 body.assets
// 里的原始 URL → r2_url 对应关系，把两种地址一起加入拒绝集合，防历史脏数据继续进日报。
function newsBlockedImageAliases(ex: Record<string, unknown>): Set<string> {
  const blocked = new Set<string>();
  const add = (url: string) => {
    const value = String(url || '').trim();
    if (!value) return;
    blocked.add(value);
    const normalized = normalizeImageAlias(value);
    if (normalized) blocked.add(normalized);
  };
  const persisted = ex.editorial_image_blocked_urls;
  if (Array.isArray(persisted)) {
    for (const url of persisted) if (typeof url === 'string') add(url);
  }
  const body = ex.body;
  if (!body || typeof body !== 'object') return blocked;
  const assets = (body as { assets?: unknown }).assets;
  if (!Array.isArray(assets)) return blocked;
  for (const asset of assets) {
    if (!asset || typeof asset !== 'object') continue;
    const original = String((asset as { url?: unknown }).url || '').trim();
    if (!original || !isSkippableInlineImage(original)) continue;
    add(original);
    const r2 = String((asset as { r2_url?: unknown }).r2_url || '').trim();
    add(r2);
  }
  return blocked;
}

function isNewsImageBlocked(url: string, blockedAliases: ReadonlySet<string>): boolean {
  const value = String(url || '').trim();
  if (!value) return true;
  return isSkippableInlineImage(value)
    || blockedAliases.has(value)
    || blockedAliases.has(normalizeImageAlias(value));
}

function inlineImageUrls(text: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const htmlRe = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
  while ((m = htmlRe.exec(text)) !== null) out.push(htmlDecode(m[1]));
  const mdRe = /!\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  while ((m = mdRe.exec(text)) !== null) out.push(htmlDecode(m[1]));
  return out;
}

function htmlDecode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// 每源「最优加长字段」(静态日报页 SEO 扩展摘要用;news 源不走此处,由下方 excerpt_zh/shownotes_zh 分支处理)。
// 与 CLAUDE.md「每源最优加长字段」调查结论一致:gh=ai_summary / hf=summary_zh / ph=description_zh(回退 ai_summary) / x=content_translated。
function pickExtendedIntro(source: DigestSource, row: RenderRow, ex: Record<string, unknown>): string {
  switch (source) {
    case 'hf-paper':
      return String((ex.summary_zh as string) || (ex.ai_summary_zh as string) || '');
    case 'gh':
      return String((ex.ai_summary as string) || '');
    case 'ph':
      // Task 3 产出 description_zh(英文长描述的中文译文);缺失回退短的 ai_summary。
      return String((ex.description_zh as string) || (ex.ai_summary as string) || '');
    case 'x':
      return String(row.content_translated || row.content || '');
    default:
      return '';
  }
}

export function renderItem(source: DigestSource, row: RenderRow, rank: number, apiBase: string, opts: RenderOptions = {}): RenderedItem {
  const ex = safeParse(row.extra);
  const ct = row.content_translated || '';
  const body = ct || row.content || '';
  let title: string;
  let summary: string;
  switch (source) {
    case 'gh':
      title = ghRepoName(row.id);
      summary = (ex.ai_summary as string) || ct;
      break;
    case 'ph':
      title = row.title || '';
      summary = (ex.ai_summary as string) || ct;
      break;
    case 'hf-paper': // 标题=原始论文标题译文(title_zh),对齐前端 HfPaperCard;摘要=详细中文摘要
      title = (ex.title_zh as string) || row.title || '';
      summary = (ex.summary_zh as string) || (ex.ai_summary_zh as string) || '';
      break;
    case 'x':
      title = (ex.ai_summary as string) || body.slice(0, 60);
      summary = ct || row.content || '';
      break;
    case 'clawhub':
      title = row.title || '';
      summary = (ex.summary_translated as string) || (ex.summary_en as string) || ct;
      break;
    case 'news': // 行业新闻(blog/podcast):中文标题 title_zh + 一句话中文摘要 ai_summary_zh
      // 标题剥栏目/推广标签前缀([AINews] 等),存量老标题也即时生效
      title = stripLabelPrefix((ex.title_zh as string) || row.title || '');
      summary = (ex.ai_summary_zh as string) || ct;
      break;
    default:
      title = row.title || body.slice(0, 60);
      summary = body;
  }
  // 播客专属:单集时长 + 本集嘉宾(blog / 其他源没有 → 省略,不进 JSON)
  const durationSec = typeof ex.duration_sec === 'number' && ex.duration_sec > 0 ? ex.duration_sec : undefined;
  const guests = Array.isArray(ex.guests)
    ? (ex.guests as unknown[]).filter((g): g is string => typeof g === 'string' && g.trim() !== '')
    : [];
  // 行业新闻专属:内容简介(图文→excerpt_zh / 播客→shownotes_zh)+ 话题脉络(有原生时间戳文字稿的播客)
  let intro: string | undefined;
  let timeline: RenderedItem['timeline'];
  if (source === 'news') {
    // 真播客 extra 有 show_key;无音频文字项改判 blog 后 extra 是 feed_key、无 show_key。
    // 不用 id 前缀(`podcast:`)判断 —— 改判项保留 podcast: 前缀作来源痕迹(不断分享链/防重),
    // 但内容是图文,应读 excerpt_zh 走博客渲染,故按 extra 形状(show_key 有无)区分。
    const isPod = !!ex.show_key;
    const introRaw = String((isPod ? ex.shownotes_zh : ex.excerpt_zh) || '').trim();
    if (introRaw) intro = clampSentences(introRaw, 800);
    if (isPod && Array.isArray(ex.timeline) && ex.timeline.length) {
      timeline = ex.timeline as RenderedItem['timeline'];
    }
  } else if (opts.extendedIntro) {
    // 静态日报页 SEO 专用:非 news 源也产出「每源最优加长字段」作扩展摘要。
    // 仅 daily-page 传 extendedIntro → codex-push / daily-api 不传 → 它们非 news 源仍无 intro,输出零回归。
    const introRaw = pickExtendedIntro(source, row, ex).trim();
    if (introRaw) intro = clampSentences(introRaw, 800);
  }
  return {
    rank,
    item_id: row.id,
    source,
    title: cleanText(title || '(无标题)').slice(0, 120),
    summary: clampSentences(summary),
    summary_full: cleanText(summary),
    url: row.url || '',
    deep_link: deepLinkPath(row.id),
    author: row.author || row.handle || '',
    cover: pickCover(source, row, ex, apiBase, opts),
    logo: pickLogo(source, row, apiBase),
    media: buildMedia(source, row, ex, apiBase),
    ...(durationSec ? { duration_sec: durationSec } : {}),
    ...(guests.length ? { guests } : {}),
    ...(intro ? { intro } : {}),
    ...(timeline && timeline.length ? { timeline } : {}),
  };
}
