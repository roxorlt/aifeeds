// 活动行列表页 (listing) HTML parser。
//
// 输入：fetch /events?tag=AI&city=X&orderby=o&page=N 返回的整页 HTML。
// 输出：EventCard[]（按 DOM 顺序），以及 isLastPage（遇 hd-empty-list 为 true）。
//
// 站点 SSR 静态 HTML，每页 ~12 条卡片，包在 .search-tab-content-item-mesh 块里。
// design doc §2.4 字段映射。
//
// Worker V8 isolate 无 jsdom，纯正则解析。HTML 实体最终在赋值前用 decodeEntities() 清。

export interface OrganizerInfo {
  name: string;
  slug: string | null;            // 自定义子域名识别符（"sanbanhui"），仅含子域名形式 URL 才有
  org_id: string | null;          // 数字 organizer ID（"210638518296"），仅 /org/<id> 形式 URL 才有
  url: string;                     // 完整 https URL（站点返回相对路径已补前缀）
  avatar_url: string;
  fans: number | null;
  is_certified_company: boolean;
  is_vip_gold: boolean;
}

export interface EventCard {
  event_id: string;                // 站点原始数字 ID（如 "5859894940100"）
  title: string;
  thumbnail: string;
  time_raw: string;                // "05/21 周四 14:30" / "明天 14:00" / "后天 10:00"
  location_raw: string;            // "北京朝阳" / "线上活动"
  is_online: boolean;              // location_raw === "线上活动"
  city: string;                    // 抓取时的权威城市（参数 ?city= 透传），始终非空
  district: string | null;         // 从 location_raw 减 city 前缀；不匹配时为 location_raw 全部
  organizer: OrganizerInfo;
}

export interface ListingParseResult {
  cards: EventCard[];
  isLastPage: boolean;             // 遇 hd-empty-list 为 true
}

// ─── Helpers ──────────────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // numeric decimal entities: &#183; → · / &#8230; → … 等中文站常见
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    // numeric hex entities: &#x00b7; etc
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => {
      const code = parseInt(n, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });
}

function clean(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 把 organizer URL 标准化成完整 absolute URL。
 *   "/org/210638518296"                  → "https://www.huodongxing.com/org/210638518296"
 *   "https://oceanai.huodongxing.com"    → 原样
 */
function normalizeOrgUrl(rawUrl: string): string {
  if (!rawUrl) return '';
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl;
  if (rawUrl.startsWith('/')) return `https://www.huodongxing.com${rawUrl}`;
  return rawUrl;
}

/**
 * 从 organizer URL 抽 custom 子域名 slug。
 *   https://sanbanhui.huodongxing.com → "sanbanhui"
 *   其他形式（/org/<id>、主域名等）→ null
 */
function extractOrganizerSlug(url: string): string | null {
  const m = url.match(/^https?:\/\/([a-z0-9_-]+)\.huodongxing\.com(?:\/|$)/i);
  if (!m) return null;
  const slug = m[1].toLowerCase();
  if (slug === 'www') return null;
  return slug;
}

/**
 * 从 organizer URL 抽 numeric organizer ID。
 *   /org/210638518296                                  → "210638518296"
 *   https://www.huodongxing.com/org/210638518296       → "210638518296"
 *   https://oceanai.huodongxing.com                    → null（custom 域名不带 ID）
 */
function extractOrganizerId(url: string): string | null {
  const m = url.match(/\/org\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * 拆 location_raw → city + district + is_online。
 *
 * authoritativeCity 是抓取时已知的城市名（来自 ?city= query 参数），权威可靠。
 * 站点列表里事件 location_raw 字段格式不一致（"北京朝阳" / "广东深圳" / "深圳南山"
 * 等都有出现），用前 2 字猜会把"广东"识别成 city。所以拿权威 city 覆盖。
 *
 * 规则：
 *   - "线上活动" → is_online=true, city=authoritativeCity（线上活动用 city 兜底归类）, district=null
 *   - 以 authoritativeCity 开头 → city=authoritativeCity, district = location_raw 去前缀
 *     例 "北京朝阳" + city="北京" → district="朝阳"
 *   - 不以 authoritativeCity 开头 → city=authoritativeCity（保权威）, district = location_raw 全部
 *     例 "广东深圳" + city="深圳" → district="广东深圳"（异常 fallback，前端按 city chip 筛仍准确）
 */
function parseLocation(
  raw: string,
  authoritativeCity: string,
): {
  is_online: boolean;
  city: string;
  district: string | null;
} {
  const trimmed = raw.trim();
  if (trimmed === '线上活动') {
    return { is_online: true, city: authoritativeCity, district: null };
  }
  if (trimmed.length === 0) {
    return { is_online: false, city: authoritativeCity, district: null };
  }
  if (trimmed.startsWith(authoritativeCity)) {
    const district = trimmed.slice(authoritativeCity.length).trim() || null;
    return { is_online: false, city: authoritativeCity, district };
  }
  // location_raw 不以 authoritativeCity 开头（异常 fallback）：保留原文作 district 兜底
  return { is_online: false, city: authoritativeCity, district: trimmed };
}

/**
 * 切分整页 HTML 为单个 card block 数组。
 * 用 .search-tab-content-item-mesh marker 起点 + 下一个 marker / 终止 marker 作终点。
 */
function splitCards(html: string): string[] {
  const startRe = /<div\s+class="search-tab-content-item-mesh"/g;
  const stops = [
    /<div\s+class="hd-empty-list"/,
    /<\/section>/,
  ];
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(html)) !== null) starts.push(m.index);
  if (starts.length === 0) return [];

  const cards: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const begin = starts[i];
    // end = 下一个 card 起点 或最近的终止 marker
    let end = i + 1 < starts.length ? starts[i + 1] : html.length;
    for (const stopRe of stops) {
      const stopIdx = html.slice(begin).search(stopRe);
      if (stopIdx > 0) end = Math.min(end, begin + stopIdx);
    }
    cards.push(html.slice(begin, end));
  }
  return cards;
}

// ─── Single-card field extractors ──────────────────────────────

function extractEventId(card: string): string | null {
  const m = card.match(/href="\/event\/(\d+)/);
  return m ? m[1] : null;
}

function extractTitle(card: string): string {
  // .item-title <span style="vertical-align: middle;">{title}</span>
  const m = card.match(
    /<a[^>]*class="[^"]*item-title[^"]*"[\s\S]*?<span[^>]*vertical-align[\s\S]*?>([^<]+)<\/span>/,
  );
  if (m) return clean(decodeEntities(m[1]));
  // fallback: .item-logo alt
  const alt = card.match(/<img[^>]*class="[^"]*item-logo[^"]*"[^>]*alt="([^"]*)"/);
  return alt ? clean(decodeEntities(alt[1])) : '';
}

function extractThumbnail(card: string): string {
  const m = card.match(/<img[^>]*class="[^"]*item-logo[^"]*"[^>]*src="([^"]+)"/);
  return m ? decodeEntities(m[1]) : '';
}

function extractTimeRaw(card: string): string {
  // .item-dress .flex > <p>{time}</p>
  const m = card.match(/<div[^>]*class="[^"]*item-dress[^"]*"[\s\S]*?<p>([\s\S]*?)<\/p>/);
  return m ? clean(decodeEntities(m[1])) : '';
}

function extractLocationRaw(card: string): string {
  const m = card.match(
    /<span[^>]*class="[^"]*item-dress-pp[^"]*"[^>]*>([\s\S]*?)<\/span>/,
  );
  return m ? clean(decodeEntities(m[1])) : '';
}

function extractOrganizer(card: string): OrganizerInfo {
  // 外层 organizer 链接：<a class="flex" href="https://X.huodongxing.com" ...>
  // hover-model 副本是 <a class="huan-aa" ...>，class 不同所以不会误抓
  const urlMatch = card.match(
    /<a\s+class="flex"\s+href="([^"]+)"[^>]*>[\s\S]*?<img\s+class=['"]user-logo[^'"]*['"][^>]*src="([^"]+)"/,
  );
  const url = urlMatch ? normalizeOrgUrl(decodeEntities(urlMatch[1])) : '';
  const avatarUrl = urlMatch ? decodeEntities(urlMatch[2]) : '';

  // organizer name: <p class="user-name">{name}</p>
  const nameMatch = card.match(/<p[^>]*class="[^"]*user-name[^"]*"[^>]*>([\s\S]*?)<\/p>/);
  const name = nameMatch ? clean(decodeEntities(nameMatch[1])) : '';

  // 粉丝数 — <span class="follows">粉丝  17899 </span>
  const fansMatch = card.match(
    /<span[^>]*class="[^"]*follows[^"]*"[^>]*>[\s\S]*?(\d[\d,]*)\s*<\/span>/,
  );
  const fans = fansMatch ? parseInt(fansMatch[1].replace(/,/g, ''), 10) : null;

  // 认证标 — <img class="attestation-sign attestation-company" .../>
  const isCertifiedCompany = /class="[^"]*\battestation-company\b/.test(card);
  const isVipGold = /class="[^"]*\bvip-gold\b/.test(card);

  return {
    name,
    slug: extractOrganizerSlug(url),
    org_id: extractOrganizerId(url),
    url,
    avatar_url: avatarUrl,
    fans: Number.isFinite(fans as number) ? fans : null,
    is_certified_company: isCertifiedCompany,
    is_vip_gold: isVipGold,
  };
}

// ─── Public API ───────────────────────────────────────────────

/**
 * Parse a listing page HTML into structured cards + last-page signal.
 *
 * @param html the raw HTML body from /events?... fetch
 * @param authoritativeCity 抓取时的城市参数（如 "北京"），权威可靠，用于 EventCard.city
 *        + district 解析。location_raw 自身格式不稳（"广东深圳" / "深圳南山" 都见过），
 *        不能用前 2 字猜。
 * @returns { cards, isLastPage }
 */
export function parseListing(html: string, authoritativeCity: string): ListingParseResult {
  const isLastPage = /<div\s+class="hd-empty-list"/.test(html);
  const cardBlocks = splitCards(html);
  const cards: EventCard[] = [];

  for (const block of cardBlocks) {
    const eventId = extractEventId(block);
    if (!eventId) continue;
    const locationRaw = extractLocationRaw(block);
    const { is_online, city, district } = parseLocation(locationRaw, authoritativeCity);
    cards.push({
      event_id: eventId,
      title: extractTitle(block),
      thumbnail: extractThumbnail(block),
      time_raw: extractTimeRaw(block),
      location_raw: locationRaw,
      is_online,
      city,
      district,
      organizer: extractOrganizer(block),
    });
  }

  return { cards, isLastPage };
}
