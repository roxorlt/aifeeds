// worker/src/feeds/parse.ts
//
// Feed XML 拉取 + 解析（无 DOM 库，纯正则 / 轻量解析，风格对齐 hf-paper/ar5iv.ts
// 的 extractParagraphs 与 huodongxing parser-detail.ts）。
//
// - fetchFeedXml: native 与 rsshub 统一入口（§6.5），带浏览器 header + 20s timeout。
//   香港 host-rewrite 铁律：rsshub 基址只走 env.RSSHUB_BASE，不靠 request host。
// - parseFeed: RSS 2.0 + Atom（含 GitHub releases.atom）都解析，输出归一化 ParsedFeedItem[]。
//   封面走 §9.1 多源回退链 ①enclosure image →②media:content →③media:thumbnail
//   →④itunes:image →⑤channel image（⑥详情页 og:image 在 step3 抽取阶段补，不在此）。
//
// 设计文档：docs/plans/2026-06-09-ai-vendor-feeds-source-design.md §3 / §6.5 / §9.1

import type { FeedDef, ParsedFeedItem } from "./types";

const USER_AGENT =
  "Mozilla/5.0 (compatible; ai-feeds-bot/1.0; +https://ai-feeds.com)";
const FEED_FETCH_TIMEOUT_MS = 20_000;
/** 单 feed 单次最多归一化条数（防病态超长 feed 拖垮 stub INSERT）。 */
const MAX_ITEMS_PER_FEED = 80;

export interface FeedFetchEnv {
  RSSHUB_BASE?: string;
  RSSHUB_TOKEN?: string;
  WEIBO_COOKIES?: string;
}

export class WeiboCookieMissingError extends Error {
  readonly code = "WEIBO_COOKIE_MISSING";
  readonly status = 401;

  constructor(feedId: string) {
    super(`feed ${feedId} requires WEIBO_COOKIES`);
    this.name = "WeiboCookieMissingError";
  }
}

export class WeiboCookieInvalidError extends Error {
  readonly code = "WEIBO_COOKIE_INVALID";
  readonly status = 403;

  constructor(feedId: string, detail?: string) {
    super(`feed ${feedId} Weibo cookie invalid${detail ? `: ${detail}` : ""}`);
    this.name = "WeiboCookieInvalidError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchFeedXml — native 与 rsshub 统一入口
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchFeedXml(
  env: FeedFetchEnv,
  feed: FeedDef,
): Promise<string> {
  const isRss = feed.via === "rsshub";
  if (isRss && !env.RSSHUB_BASE) {
    throw new Error(`feed ${feed.id} via=rsshub but RSSHUB_BASE empty`);
  }
  let url: string;
  if (isRss) {
    const base = (env.RSSHUB_BASE || "").replace(/\/+$/, "");
    const route = feed.feed_url.replace(/^\/+/, "");
    url = `${base}/${route}`;
  } else {
    url = feed.feed_url;
  }

  const headers = buildFeedFetchHeaders(env, feed);

  const r = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS),
  });
  if (feed.needs_weibo_cookie && (r.status === 401 || r.status === 403)) {
    const body = await r.text().catch(() => "");
    throw new WeiboCookieInvalidError(feed.id, body.slice(0, 200));
  }
  if (!r.ok) throw new Error(`feed ${feed.id} HTTP ${r.status}`);
  return r.text();
}

export function buildFeedFetchHeaders(
  env: Pick<FeedFetchEnv, "RSSHUB_TOKEN" | "WEIBO_COOKIES">,
  feed: FeedDef,
): Record<string, string> {
  const isRss = feed.via === "rsshub";
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept:
      "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
    "Cache-Control": "no-cache",
  };
  if (isRss && env.RSSHUB_TOKEN) headers["X-RSSHub-Token"] = env.RSSHUB_TOKEN;
  if (feed.needs_weibo_cookie) {
    const cookie = env.WEIBO_COOKIES?.trim();
    if (!cookie) throw new WeiboCookieMissingError(feed.id);
    headers["X-Weibo-Cookie"] = cookie;
  }
  return headers;
}

// ─────────────────────────────────────────────────────────────────────────────
// parseFeed — 按 format 选分支
// ─────────────────────────────────────────────────────────────────────────────

export function parseFeed(xml: string, feed: FeedDef): ParsedFeedItem[] {
  const fmt = feed.format || "rss";
  // github-releases 本质是 Atom（<entry> + release notes 当 <content>），走 atom 分支。
  if (fmt === "atom" || fmt === "github-releases") return parseAtom(xml);
  return parseRss(xml);
}

// ─────────────────────────────────────────────────────────────────────────────
// RSS 2.0
// ─────────────────────────────────────────────────────────────────────────────

function parseRss(xml: string): ParsedFeedItem[] {
  const channelHead = sliceBefore(xml, /<item[\s>]/i);
  const channelImage = pickChannelImage(channelHead);

  const out: ParsedFeedItem[] = [];
  const itemRe = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null && out.length < MAX_ITEMS_PER_FEED) {
    const block = m[1];
    const link = tagInner(block, "link") || "";
    const guid = tagInner(block, "guid") || link;
    if (!guid && !link) continue;

    const contentHtml =
      tagInner(block, "content:encoded") || tagInner(block, "description");
    const summary = htmlToText(
      tagInner(block, "description") || tagInner(block, "content:encoded") || "",
    );

    const encType = tagAttr(block, "enclosure", "type");
    const encUrl = tagAttr(block, "enclosure", "url");
    const isAudio = /^audio\//i.test(encType || "");

    const item: ParsedFeedItem = {
      guid: guid.trim(),
      link: link.trim(),
      title: htmlToText(tagInner(block, "title") || ""),
      content_html: contentHtml || undefined,
      summary: summary || undefined,
      published_at: parseDate(
        tagInner(block, "pubDate") ||
          tagInner(block, "dc:date") ||
          tagInner(block, "published"),
      ),
      author: htmlToText(
        tagInner(block, "dc:creator") ||
          tagInner(block, "author") ||
          tagInner(block, "itunes:author") ||
          "",
      ) || undefined,
      cover_url: pickItemCover(block, encUrl, encType, channelImage),
      tags: collectTags(block),
    };

    // podcast 音频 enclosure（不迁 R2，前端 <audio> 直吃）
    if (isAudio && encUrl) {
      item.enclosure_url = encUrl;
      item.enclosure_type = encType || undefined;
      const len = tagAttr(block, "enclosure", "length");
      const bytes = len ? parseInt(len, 10) : NaN;
      if (Number.isFinite(bytes)) item.enclosure_bytes = bytes;
    }

    const dur = parseDuration(tagInner(block, "itunes:duration"));
    if (dur !== undefined) item.duration_sec = dur;

    const epNo = tagInner(block, "itunes:episode");
    if (epNo && /^\d+$/.test(epNo.trim())) item.episode_no = parseInt(epNo, 10);
    const epType = tagInner(block, "itunes:episodeType");
    if (epType) item.episode_type = epType.trim();

    const transUrl = tagAttr(block, "podcast:transcript", "url");
    if (transUrl) {
      item.transcript_url = transUrl;
      item.transcript_type =
        tagAttr(block, "podcast:transcript", "type") || undefined;
    }

    // podcast:person(Podcasting 2.0 结构化讲话人,2026-06-12 海报增信息量)。
    // 部分 feed 才有(Transistor 系覆盖好,megaphone/简单 RSS 无);role 缺省按 host。
    // 跨集主持人多重复,去重 + 截断防海报溢出。每集嘉宾多藏标题/shownotes(LLM 另议)。
    const persons = allTagsWithAttrs(block, "podcast:person");
    if (persons.length > 0) {
      const hosts: string[] = [];
      const guests: string[] = [];
      for (const p of persons) {
        const name = stripTags(p.inner).trim();
        if (!name) continue;
        const role = (p.attrs.match(/\brole\s*=\s*"([^"]*)"/i)?.[1] || "host").toLowerCase();
        if (role.includes("guest")) {
          if (!guests.includes(name)) guests.push(name);
        } else if (!hosts.includes(name)) hosts.push(name);
      }
      if (hosts.length > 0) item.hosts = hosts.slice(0, 4);
      if (guests.length > 0) item.guests = guests.slice(0, 4);
    }

    out.push(item);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Atom（含 GitHub releases.atom）
// ─────────────────────────────────────────────────────────────────────────────

function parseAtom(xml: string): ParsedFeedItem[] {
  const head = sliceBefore(xml, /<entry[\s>]/i);
  const channelImage =
    tagInner(head, "logo") ||
    tagInner(head, "icon") ||
    tagAttr(head, "itunes:image", "href") ||
    undefined;

  const out: ParsedFeedItem[] = [];
  const entryRe = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null && out.length < MAX_ITEMS_PER_FEED) {
    const block = m[1];
    const link = atomLink(block);
    const guid = tagInner(block, "id") || link;
    if (!guid && !link) continue;

    const contentHtml =
      tagInner(block, "content") || tagInner(block, "summary");
    const summary = htmlToText(
      tagInner(block, "summary") || tagInner(block, "content") || "",
    );

    const item: ParsedFeedItem = {
      guid: guid.trim(),
      link: link.trim(),
      title: htmlToText(tagInner(block, "title") || ""),
      content_html: contentHtml || undefined,
      summary: summary || undefined,
      published_at: parseDate(
        tagInner(block, "published") || tagInner(block, "updated"),
      ),
      author: htmlToText(atomAuthor(block) || "") || undefined,
      cover_url: pickItemCover(block, undefined, undefined, channelImage),
      tags: collectAtomCategories(block),
    };
    out.push(item);
  }
  return out;
}

/** Atom <link>：优先 rel="alternate" 的 href，其次首个 href，再退化到 <link> 文本。 */
function atomLink(block: string): string {
  const links = block.match(/<link\b[^>]*>/gi) || [];
  let fallback = "";
  for (const l of links) {
    const href = attrIn(l, "href");
    if (!href) continue;
    const rel = (attrIn(l, "rel") || "alternate").toLowerCase();
    if (rel === "alternate") return href;
    if (!fallback) fallback = href;
  }
  if (fallback) return fallback;
  return tagInner(block, "link") || "";
}

/** Atom <author><name>X</name></author>。 */
function atomAuthor(block: string): string | undefined {
  const a = block.match(/<author(?:\s[^>]*)?>([\s\S]*?)<\/author>/i);
  if (!a) return undefined;
  return tagInner(a[1], "name");
}

// ─────────────────────────────────────────────────────────────────────────────
// 封面回退链（§9.1 ①-⑤；⑥og:image 在 step3 补）
// ─────────────────────────────────────────────────────────────────────────────

function pickItemCover(
  block: string,
  enclosureUrl: string | undefined,
  enclosureType: string | undefined,
  channelImage: string | undefined,
): string | undefined {
  // ① <enclosure type="image/*">
  if (enclosureUrl && /^image\//i.test(enclosureType || "")) return enclosureUrl;
  // ② <media:content medium="image" | type="image/*">
  const mc = pickMediaContentImage(block);
  if (mc) return mc;
  // ③ <media:thumbnail url="...">
  const mt = tagAttr(block, "media:thumbnail", "url");
  if (mt) return mt;
  // ④ <itunes:image href="...">（播客单集封面常在这）
  const it = tagAttr(block, "itunes:image", "href");
  if (it) return it;
  // ⑤ channel 级封面回退
  return channelImage || undefined;
}

/** 取首个图片型 <media:content>（medium=image / type 起始 image / url 是图片扩展名）。 */
function pickMediaContentImage(block: string): string | undefined {
  const tags = block.match(/<media:content\b[^>]*>/gi) || [];
  for (const t of tags) {
    const url = attrIn(t, "url");
    if (!url) continue;
    const medium = (attrIn(t, "medium") || "").toLowerCase();
    const type = (attrIn(t, "type") || "").toLowerCase();
    if (
      medium === "image" ||
      type.startsWith("image/") ||
      /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(url)
    ) {
      return url;
    }
  }
  return undefined;
}

/** RSS channel 封面：<image><url>...</url></image> 或 channel itunes:image。 */
function pickChannelImage(head: string): string | undefined {
  const imgBlock = head.match(/<image(?:\s[^>]*)?>([\s\S]*?)<\/image>/i);
  if (imgBlock) {
    const u = tagInner(imgBlock[1], "url");
    if (u) return u.trim();
  }
  const itunes = tagAttr(head, "itunes:image", "href");
  return itunes || undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// tags
// ─────────────────────────────────────────────────────────────────────────────

function collectTags(block: string): string[] | undefined {
  const out: string[] = [];
  const re = /<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null && out.length < 12) {
    const t = htmlToText(m[1]);
    if (t) out.push(t);
  }
  return out.length ? out : undefined;
}

function collectAtomCategories(block: string): string[] | undefined {
  const out: string[] = [];
  const tags = block.match(/<category\b[^>]*>/gi) || [];
  for (const t of tags) {
    const term = attrIn(t, "term") || attrIn(t, "label");
    if (term) out.push(decodeEntities(term));
    if (out.length >= 12) break;
  }
  return out.length ? out : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// 低层 XML / HTML 工具（无 DOM 库）
// ─────────────────────────────────────────────────────────────────────────────

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 取 <tag ...>inner</tag> 的 inner（CDATA 剥壳 + trim）。同名多次只取第一个。 */
function tagInner(block: string, tag: string): string | undefined {
  const re = new RegExp(
    `<${escapeRe(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeRe(tag)}>`,
    "i",
  );
  const m = block.match(re);
  if (!m) return undefined;
  return stripCdata(m[1]).trim();
}

/** 取所有同名标签的 { attrs(起始标签属性串), inner(内容) }（podcast:person 等多值）。 */
function allTagsWithAttrs(
  block: string,
  tag: string,
): Array<{ attrs: string; inner: string }> {
  const re = new RegExp(
    `<${escapeRe(tag)}((?:\\s[^>]*)?)>([\\s\\S]*?)</${escapeRe(tag)}>`,
    "gi",
  );
  const out: Array<{ attrs: string; inner: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    out.push({ attrs: m[1] || "", inner: stripCdata(m[2]) });
  }
  return out;
}

/** 从首个 <tag ...> 起始标签里取属性值（支持自闭合）。 */
function tagAttr(block: string, tag: string, attr: string): string | undefined {
  const tagRe = new RegExp(`<${escapeRe(tag)}\\b[^>]*?/?>`, "i");
  const tm = block.match(tagRe);
  if (!tm) return undefined;
  return attrIn(tm[0], attr);
}

/** 从一段起始标签字符串里取属性值（双引号 / 单引号都支持）。 */
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

/** HTML 片段 → 纯文本（喂 step1 廉价 gate 的 excerpt）。 */
function htmlToText(html: string): string {
  return decodeEntities(stripTags(stripCdata(html)))
    .replace(/\s+/g, " ")
    .trim();
}

/** 取 xml 中第一个 marker 之前的部分（channel 头，用于取频道级封面）。 */
function sliceBefore(xml: string, marker: RegExp): string {
  const m = xml.match(marker);
  if (m && m.index !== undefined) return xml.slice(0, m.index);
  return xml;
}

/** RFC822 / ISO 日期 → ISO8601；解析失败 undefined。 */
function parseDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const d = new Date(s.trim());
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** itunes:duration：纯秒 "3600" / "MM:SS" / "HH:MM:SS" → 秒。 */
function parseDuration(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const t = s.trim();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  if (!/^\d{1,2}(:\d{1,2}){1,2}$/.test(t)) return undefined;
  const parts = t.split(":").map((x) => parseInt(x, 10));
  if (parts.some((n) => Number.isNaN(n))) return undefined;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return sec;
}
