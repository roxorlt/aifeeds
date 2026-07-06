// worker/src/feeds/extract.ts
//
// 纯函数（URL 规范化 + 同步 SHA-256 哈希，可独立单测）+ step3 正文抓取阶梯（§6.4）。
//
// - canonicalize / idHashOf / urlHashOf：身份与跨源去重键的确定性计算。
//   idHashOf=feed 内 PK（基于 guid）；urlHashOf=跨源精确去重键（基于 canonical_url）。
//   ⚠️ 签名同步返回（fetch 层在循环里算复合 id），故用纯 JS SHA-256，不走 async crypto.subtle。
// - extractFullText：§6.4 四级阶梯（①RSS 自带全文 →②静态抽取 →③无头[v1 不接] →④降级摘要）。
//   per-origin 串行 + jitter 防 WAF（§6.4）；相对 URL 按 feed.site_base/canonical 解析为绝对；
//   永不 throw，失败优雅降级。
//
// 设计文档：docs/plans/2026-06-09-ai-vendor-feeds-source-design.md §5.6 / §6.4 / §9.2

import type { Env } from "../index";
import type { FeedBodyAsset, FeedBodyMeta, FeedDef, FetchStrategy } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// canonicalize — §5.6
// ─────────────────────────────────────────────────────────────────────────────

/** 追踪参数黑名单（精确名或 utm_ 前缀）。 */
function isTrackingParam(k: string): boolean {
  const key = k.toLowerCase();
  if (key.startsWith("utm_")) return true;
  return new Set([
    "ref",
    "ref_src",
    "fbclid",
    "gclid",
    "mc_cid",
    "mc_eid",
    "spm",
    "source",
    "igshid",
    "yclid",
    "_hsenc",
    "_hsmi",
  ]).has(key);
}

/**
 * 规范化 URL：小写 scheme/host、去默认端口、去 fragment、剔除追踪参数、
 * 剩余 query 按 key 排序、折叠 //、去 trailing slash。解析失败原样返回（best-effort）。
 */
export function canonicalize(raw: string): string {
  const input = (raw || "").trim();
  if (!input) return "";
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return input;
  }
  const scheme = u.protocol.toLowerCase();
  const host = u.hostname.toLowerCase();
  let port = u.port;
  if (
    (scheme === "http:" && port === "80") ||
    (scheme === "https:" && port === "443")
  ) {
    port = "";
  }
  const params = [...u.searchParams.entries()].filter(
    ([k]) => !isTrackingParam(k),
  );
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  const sp = new URLSearchParams();
  for (const [k, v] of params) sp.append(k, v);
  const q = sp.toString();

  let path = u.pathname.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (!path) path = "/";

  const authority = port ? `${host}:${port}` : host;
  return `${scheme}//${authority}${path}${q ? `?${q}` : ""}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 同步 SHA-256（纯 JS，UTF-8 字节）— 给 idHashOf / urlHashOf 用
// ─────────────────────────────────────────────────────────────────────────────

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function ror(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** 标准 SHA-256，返回 64-hex 串。输入按 UTF-8 编码。 */
export function sha256hex(message: string): string {
  const bytes = new TextEncoder().encode(message);
  const l = bytes.length;
  const bitLen = l * 8;
  const withOne = l + 1;
  const k = (56 - (withOne % 64) + 64) % 64;
  const total = withOne + k + 8;
  const m = new Uint8Array(total);
  m.set(bytes);
  m[l] = 0x80;
  const dv = new DataView(m.buffer);
  // 64-bit big-endian 长度（本量级 bitLen < 2^32，高位字为 0）
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(total - 4, bitLen >>> 0);

  let h0 = 0x6a09e667,
    h1 = 0xbb67ae85,
    h2 = 0x3c6ef372,
    h3 = 0xa54ff53a,
    h4 = 0x510e527f,
    h5 = 0x9b05688c,
    h6 = 0x1f83d9ab,
    h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = ror(w[i - 15], 7) ^ ror(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = ror(w[i - 2], 17) ^ ror(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4,
      f = h5,
      g = h6,
      h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ror(e, 6) ^ ror(e, 11) ^ ror(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) | 0;
      const S0 = ror(a, 2) ^ ror(a, 13) ^ ror(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  return (
    hex8(h0) +
    hex8(h1) +
    hex8(h2) +
    hex8(h3) +
    hex8(h4) +
    hex8(h5) +
    hex8(h6) +
    hex8(h7)
  );
}

function hex8(x: number): string {
  return (x >>> 0).toString(16).padStart(8, "0");
}

/** feed 内稳定身份（PK）：sha256hex(guid).slice(0,16)。 */
export function idHashOf(guid: string): string {
  return sha256hex(guid).slice(0, 16);
}

/** 跨源精确去重键：sha256hex(canonicalUrl).slice(0,16)。 */
export function urlHashOf(canonicalUrl: string): string {
  return sha256hex(canonicalUrl).slice(0, 16);
}

// ─────────────────────────────────────────────────────────────────────────────
// per-origin 串行 + jitter（§6.4 防 WAF）
// ─────────────────────────────────────────────────────────────────────────────

const PER_ORIGIN_MIN_GAP_MS = 1500;
const JITTER_BASE_MS = 800;
const JITTER_SPREAD_MS = 1500;
const PAGE_FETCH_TIMEOUT_MS = 20_000;

const originChain = new Map<string, Promise<unknown>>();
const originLastAt = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const PAGE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

function pageHeaders(referer?: string): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": PAGE_UA,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Sec-Ch-Ua":
      '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"macOS"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": referer ? "same-origin" : "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  };
  if (referer) h["Referer"] = referer;
  return h;
}

/** 同 origin 串行 + 间隔门控 + jitter 的 fetch（拿 HTML 文本，永不 throw）。 */
export async function throttledFetchText(url: string): Promise<string | null> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  const prev = originChain.get(origin) || Promise.resolve();
  const run = prev.then(async () => {
    const last = originLastAt.get(origin) || 0;
    const gap = Date.now() - last;
    if (gap < PER_ORIGIN_MIN_GAP_MS) await sleep(PER_ORIGIN_MIN_GAP_MS - gap);
    await sleep(JITTER_BASE_MS + Math.random() * JITTER_SPREAD_MS);
    try {
      const r = await fetch(url, {
        headers: pageHeaders(),
        signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS),
        redirect: "follow",
      });
      if (!r.ok) {
        console.warn(`[feeds:extract] ${url} HTTP ${r.status}`);
        return null;
      }
      const body = await r.text();
      return body;
    } catch (e) {
      console.warn(`[feeds:extract] ${url} fetch fail`, e);
      return null;
    } finally {
      originLastAt.set(origin, Date.now());
    }
  });
  // 链路无论成败都续上，避免一个失败永久卡住同 origin 队列
  originChain.set(
    origin,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

// ─────────────────────────────────────────────────────────────────────────────
// extractFullText — §6.4 阶梯
// ─────────────────────────────────────────────────────────────────────────────

const MIN_BODY_CHARS = 400;
const MIN_FULL_TEXT_CHARS = 800;

/** 详情页 og: / JSON-LD 元数据(page-scrape 源补 title / cover / 发布时间用)。 */
export interface PageMeta {
  title?: string;
  cover?: string;
  published_at?: string;
}

/** 找 property/name === key 的 <meta> 的 content。 */
function metaContent(html: string, key: string): string | undefined {
  const re = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  const target = key.toLowerCase();
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const prop = (attrIn(tag, "property") || attrIn(tag, "name") || "").toLowerCase();
    if (prop === target) {
      const content = attrIn(tag, "content");
      if (content) return content;
    }
  }
  return undefined;
}

/**
 * 从详情页 HTML 抽标准化元数据。优先 og:(近乎通用、干净);标题退化到 <title>(去站名后缀)
 * 或 <h1>;发布时间退化到 JSON-LD datePublished / <time datetime>。
 */
export function extractPageMeta(html: string, baseUrl: string): PageMeta {
  const meta: PageMeta = {};

  // 标题:og:title → twitter:title → <title> → 首个 <h1>
  let title = metaContent(html, "og:title") || metaContent(html, "twitter:title");
  if (!title) {
    const t = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    if (t) title = inlineText(t[1]);
  }
  if (!title) {
    const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1) title = inlineText(h1[1]);
  }
  if (title) {
    // 去站名后缀("标题 | Site" / "标题 · Site"):og:title 也常带(如 AI21 "... | AI21")。
    // 仅吃 | 和 ·(不吃 -,避免误伤连字符标题),且后缀 ≤40 字,降低误伤正文含 | 的概率。
    title = title.replace(/\s*[|·]\s*[^|·]{1,40}$/, "").trim() || title.trim();
    meta.title = title.trim();
  }

  // 封面
  const cover = metaContent(html, "og:image") || metaContent(html, "twitter:image");
  if (cover) {
    const abs = resolveUrl(cover, baseUrl);
    if (abs) meta.cover = abs;
  }

  // 发布时间:多来源取第一个能规整成 ISO 的。JSON-LD datePublished 最规范(优先);
  // article:published_time 有的站是非 ISO 怪格式(如 Databricks "Tue, 06/16/2026 - 12:45")。
  const jm = html.match(/"datePublished"\s*:\s*"([^"]+)"/);
  const tm = html.match(/<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i);
  const dateCandidates = [
    jm ? jm[1] : undefined,
    metaContent(html, "article:published_time"),
    metaContent(html, "datePublished"),
    tm ? tm[1] : undefined,
  ];
  for (const c of dateCandidates) {
    const iso = toIsoDate(c);
    if (iso) {
      meta.published_at = iso;
      break;
    }
  }

  return meta;
}

/**
 * 由 fetchStrategy + 详情页 meta 决定要落库的 SQL 片段（Fix 1，2026-07-06）。
 *
 * 封面（og:image）**放开到全部 blog 源**：历史上只有 page-scrape 才采用 res.meta.cover，
 * native 源（如 The Verge）把抓到的 og:image 算出来又丢掉，导致下游回退到「正文首图」
 * （常是作者署名头像）。现改为任意策略只要有 meta.cover 就采用。
 *   - 幂等：`COALESCE(NULLIF(cover_image, ''), ?)` —— 已有合格 cover_image 不覆盖；
 *     空串（此前被质量门/sweep 清成 ''）也视为无封面，允许 og:image 补上。
 * title / published_at 仍**仅 page-scrape 采用**：page-scrape 的 stub 只有 slug 占位标题，
 *   靠 og:title 补真标题；native 源标题来自 RSS 权威，不动。
 *
 * 返回可直接拼进 `UPDATE items SET ${sets.join(', ')} WHERE id = ?` 的 sets/binds
 * （path 均来自固定字面量，无注入；value 走 bind）。meta 缺失或无可采字段 → 空。
 */
export function buildBlogPageMetaPatch(
  fetchStrategy: FetchStrategy,
  meta: PageMeta | undefined,
): { sets: string[]; binds: unknown[] } {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (!meta) return { sets, binds };

  // 封面：全部 blog 源都采用 og:image（幂等，不覆盖已有合格 cover_image）。
  if (meta.cover) {
    sets.push(
      "extra = json_set(coalesce(extra,'{}'), '$.cover_image', COALESCE(NULLIF(json_extract(extra,'$.cover_image'), ''), ?))",
    );
    binds.push(meta.cover);
  }

  // title / published_at 仅 page-scrape 采用（native 用 RSS 标题/时间）。
  if (fetchStrategy === 'page-scrape') {
    if (meta.title) {
      sets.push('title = ?');
      binds.push(meta.title.slice(0, 300));
    }
    if (meta.published_at) {
      sets.push("published_at = COALESCE(NULLIF(published_at, ''), ?)");
      binds.push(meta.published_at);
    }
  }

  return { sets, binds };
}

/** 把各种日期串规整成 ISO8601;已是 ISO 原样(纯日期补时间),否则试 Date 解析,非法返回 undefined。 */
function toIsoDate(s?: string): string | undefined {
  if (!s) return undefined;
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}|$)/.test(t)) {
    return t.length === 10 ? `${t}T00:00:00Z` : t;
  }
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export async function extractFullText(
  env: Env,
  input: {
    canonicalUrl: string;
    feed: FeedDef;
    fetchStrategy: FetchStrategy;
    rssContentHtml?: string;
  },
): Promise<{
  body_markdown: string;
  assets: FeedBodyAsset[];
  source: FeedBodyMeta["source"];
  meta?: PageMeta;
}> {
  void env; // v1 无需 env（无头渲染留 Phase 3 才需 BROWSER / RENDER_TOKEN）
  const { canonicalUrl, feed, fetchStrategy, rssContentHtml } = input;
  const baseUrl = feed.site_base || canonicalUrl;

  // ① RSS 自带全文够（≥800 字 + 句末标点）→ 直接用，0 网络
  if (rssContentHtml && isFullEnough(rssContentHtml)) {
    const { markdown, assets } = htmlToMarkdown(rssContentHtml, baseUrl);
    if (markdown.length >= MIN_BODY_CHARS) {
      return { body_markdown: markdown, assets, source: "rss_full" };
    }
  }

  // ② 服务端静态抽取（native / page-scrape）。③无头 v1 不接（headless 留 Phase 3）。
  let pageMeta: PageMeta | undefined;
  if (fetchStrategy === "native" || fetchStrategy === "page-scrape") {
    try {
      const html = await throttledFetchText(canonicalUrl);
      if (html && !isChallengeOrShell(html)) {
        // 详情页 og: / JSON-LD 元数据：page-scrape 源 stub 只有 slug 占位标题，靠这个补真标题/封面/日期
        pageMeta = extractPageMeta(html, baseUrl);
        const region = isolateMainRegion(html);
        if (region) {
          const { markdown, assets } = htmlToMarkdown(region, baseUrl);
          if (markdown.length >= MIN_BODY_CHARS) {
            return { body_markdown: markdown, assets, source: "static_extract", meta: pageMeta };
          }
        }
        const nextHtml = extractNextDataHtml(html);
        if (nextHtml) {
          const { markdown, assets } = htmlToMarkdown(nextHtml, baseUrl);
          if (markdown.length >= MIN_BODY_CHARS) {
            return { body_markdown: markdown, assets, source: "static_extract", meta: pageMeta };
          }
        }
        // 段落兜底（抄 ar5iv extractParagraphs 风格）
        const paras = extractParagraphs(html);
        const joined = paras.join("\n\n");
        if (joined.length >= MIN_BODY_CHARS) {
          return {
            body_markdown: joined,
            assets: collectAssetsFromHtml(html, baseUrl),
            source: "static_extract",
            meta: pageMeta,
          };
        }
      }
    } catch (e) {
      console.warn(`[feeds:extract] static extract degraded ${canonicalUrl}`, e);
    }
  }

  // ④ 优雅降级：用 RSS 摘要 HTML 转 markdown（抓不到全文也能上 feed）；已抓到的 meta 一并带上
  if (rssContentHtml) {
    const { markdown, assets } = htmlToMarkdown(rssContentHtml, baseUrl);
    return { body_markdown: markdown, assets, source: "rss_summary_fallback", meta: pageMeta };
  }
  return { body_markdown: "", assets: [], source: "rss_summary_fallback", meta: pageMeta };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML → markdown（无 DOM 库；保留结构 + 收集媒体资产，相对 URL 解析为绝对）
// ─────────────────────────────────────────────────────────────────────────────

function htmlToMarkdown(
  rawHtml: string,
  baseUrl: string,
): { markdown: string; assets: FeedBodyAsset[] } {
  let html = stripCdata(rawHtml);
  const assets = collectAssetsFromHtml(html, baseUrl);

  // 去掉非正文块
  html = html.replace(
    /<(script|style|noscript|svg|iframe|form|nav|footer|header)\b[\s\S]*?<\/\1>/gi,
    " ",
  );
  html = html.replace(/<!--[\s\S]*?-->/g, " ");

  // img → markdown（解析绝对 URL）
  html = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = resolveUrl(attrIn(tag, "src") || attrIn(tag, "data-src") || "", baseUrl);
    if (!src) return "";
    const alt = attrIn(tag, "alt") || "";
    return `\n\n![${alt}](${src})\n\n`;
  });

  // pre/code 先处理（内部一字不动）
  html = html.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, t) => {
    const code = decodeEntities(stripTags(t)).replace(/\n{3,}/g, "\n\n");
    return `\n\n\`\`\`\n${code.trim()}\n\`\`\`\n\n`;
  });
  html = html.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, t) => {
    return `\`${decodeEntities(stripTags(t)).trim()}\``;
  });

  // 标题
  html = html.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lv, t) => {
    const text = inlineText(t);
    return text ? `\n\n${"#".repeat(Number(lv))} ${text}\n\n` : "\n\n";
  });

  // 引用
  html = html.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t) => {
    const text = inlineText(t);
    return text ? `\n\n> ${text.replace(/\n+/g, "\n> ")}\n\n` : "\n\n";
  });

  // 链接
  html = html.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (tag, t) => {
    const href = resolveUrl(attrIn(tag, "href") || "", baseUrl);
    const text = inlineText(t);
    return href ? `[${text}](${href})` : text;
  });

  // 列表项
  html = html.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `\n- ${inlineText(t)}`);
  html = html.replace(/<\/(ul|ol)>/gi, "\n\n");

  // 强调（紧贴 CJK 的 flanking 在两端补空格）
  html = html.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => ` **${inlineText(t)}** `);
  html = html.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => ` *${inlineText(t)}* `);

  // 段落 / 换行 / 分割线
  html = html.replace(/<br\s*\/?>(?!\n)/gi, "\n");
  html = html.replace(/<\/p>/gi, "\n\n").replace(/<p\b[^>]*>/gi, "");
  html = html.replace(/<hr\b[^>]*>/gi, "\n\n---\n\n");

  // 剩余标签清掉
  html = html.replace(/<[^>]+>/g, " ");

  let md = decodeEntities(html);
  md = md
    .replace(/[ \t]+/g, " ")
    .replace(/ +\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { markdown: md, assets };
}

/** 收集正文媒体（img / 直链 video），相对 URL 解析为绝对，去重 + 上限。 */
function collectAssetsFromHtml(html: string, baseUrl: string): FeedBodyAsset[] {
  const out: FeedBodyAsset[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const src = resolveUrl(
      attrIn(m[0], "src") || attrIn(m[0], "data-src") || "",
      baseUrl,
    );
    if (src && /^https?:/i.test(src) && !seen.has(src)) {
      seen.add(src);
      out.push({ url: src, kind: "image", role: "inline" });
    }
    if (out.length >= 30) break;
  }
  for (const m of html.matchAll(/<video\b[^>]*>([\s\S]*?)<\/video>/gi)) {
    let src = attrIn(m[0], "src");
    if (!src) {
      const s = m[1].match(/<source\b[^>]*>/i);
      if (s) src = attrIn(s[0], "src");
    }
    const abs = resolveUrl(src || "", baseUrl);
    if (abs && /\.(mp4|webm|mov)(\?|$)/i.test(abs) && !seen.has(abs)) {
      seen.add(abs);
      out.push({ url: abs, kind: "video", role: "inline" });
    }
  }
  return out.slice(0, 30);
}

/** <article>/<main> 主区隔离（取最长的一段）。 */
function isolateMainRegion(html: string): string | null {
  let best: string | null = null;
  for (const re of [
    /<article\b[^>]*>([\s\S]*?)<\/article>/gi,
    /<main\b[^>]*>([\s\S]*?)<\/main>/gi,
  ]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      if (!best || m[1].length > best.length) best = m[1];
    }
    if (best) return best;
  }
  return null;
}

/**
 * __NEXT_DATA__ / inline JSON brace-walker（抄 huodongxing parser-detail.ts 风格）。
 * 从结构里挖最长的 HTML-ish 字符串当正文候选（Phase 3 SSR 站通用兜底；v1 极少命中）。
 */
function extractNextDataHtml(html: string): string | null {
  const obj = extractScriptJson(html);
  if (!obj) return null;
  let best = "";
  const visit = (node: unknown, depth: number) => {
    if (depth > 8 || best.length > 20000) return;
    if (typeof node === "string") {
      if (node.length > best.length && /<(p|div|h[1-6]|article)\b/i.test(node)) {
        best = node;
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const v of node) visit(v, depth + 1);
    } else if (node && typeof node === "object") {
      for (const v of Object.values(node)) visit(v, depth + 1);
    }
  };
  try {
    visit(obj, 0);
  } catch {
    return null;
  }
  return best.length >= MIN_BODY_CHARS ? best : null;
}

/** 找 __NEXT_DATA__ script 的 JSON 并 parse（brace-counting walker 容错）。 */
function extractScriptJson(html: string): unknown | null {
  const tag = html.match(
    /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!tag) return null;
  const raw = tag[1].trim();
  try {
    return JSON.parse(raw);
  } catch {
    // brace-walk 从第一个 { 起扣完整对象
    const start = raw.indexOf("{");
    if (start < 0) return null;
    let depth = 0,
      inStr = false,
      esc = false;
    for (let i = start; i < raw.length; i++) {
      const c = raw[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(raw.slice(start, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }
}

/** <p> 段落抽取（抄 ar5iv.ts extractParagraphs；strip tags、≥40 字、上限 200 段）。 */
function extractParagraphs(html: string): string[] {
  const out: string[] = [];
  const re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 200) {
    const text = inlineText(m[1]);
    if (text.length > 40) out.push(text);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 反爬 / SPA 空壳判定（§6.4）
// ─────────────────────────────────────────────────────────────────────────────

function isChallengeOrShell(html: string): boolean {
  if (/cf-browser-verification|Just a moment\.\.\.|Attention Required|Checking your browser/i.test(html)) {
    return true;
  }
  // SPA 空壳：正文太薄 + 含挂载根节点
  const textLen = stripTags(html).replace(/\s+/g, " ").trim().length;
  if (textLen < 2000 && /(id="root"|id="__next"|id="app")/i.test(html)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// 共享低层工具
// ─────────────────────────────────────────────────────────────────────────────

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function attrIn(tag: string, attr: string): string | undefined {
  const dq = tag.match(new RegExp(`${escapeRe(attr)}\\s*=\\s*"([^"]*)"`, "i"));
  if (dq) return decodeEntities(dq[1].trim());
  const sq = tag.match(new RegExp(`${escapeRe(attr)}\\s*=\\s*'([^']*)'`, "i"));
  if (sq) return decodeEntities(sq[1].trim());
  return undefined;
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ");
}

function inlineText(t: string): string {
  return decodeEntities(stripTags(t)).replace(/\s+/g, " ").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => {
      const code = parseInt(n, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });
}

/** 相对 URL 按 base 解析为绝对；data:/mailto:/javascript: 等丢弃；非法返回 ""。 */
function resolveUrl(href: string, baseUrl: string): string {
  const h = (href || "").trim();
  if (!h) return "";
  if (/^(data:|mailto:|javascript:|tel:|#)/i.test(h)) return "";
  try {
    return new URL(h, baseUrl).toString();
  } catch {
    return "";
  }
}

/** 正文是否「自带全文够」：纯文本 ≥800 字且句末有标点。 */
function isFullEnough(html: string): boolean {
  const text = decodeEntities(stripTags(stripCdata(html)))
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < MIN_FULL_TEXT_CHARS) return false;
  return /[.!?。！？”’"')）】]\s*$/.test(text);
}
