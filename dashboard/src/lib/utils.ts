import type { Item, ItemExtra } from "../types";

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

// 像 timeAgo，但超过 30 天直接显示 mm-dd（commit 这种"大于一个月"语义不强的字段更友好）
export function timeAgoOrDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const normalized = iso.includes("T") ? iso : iso.replace(" ", "T");
  const withTz = /Z$|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const date = new Date(withTz);
  if (isNaN(date.getTime())) return iso;
  const diff = Date.now() - date.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  // 超过 30 天直接 mm-dd（北京时区）
  const bjt = new Date(date.getTime() + (date.getTimezoneOffset() + 480) * 60 * 1000);
  return `${String(bjt.getMonth() + 1).padStart(2, "0")}-${String(bjt.getDate()).padStart(2, "0")}`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  // D1 stores scraped_at as UTC naive string (e.g. "2026-04-21 09:31:22").
  // Without a timezone suffix, new Date() parses as local time — on UTC+8
  // that would shift UTC 09:31 to 01:31, producing "8 小时前" for a fresh row.
  // Force UTC by appending Z.
  const normalized = iso.includes("T") ? iso : iso.replace(" ", "T");
  const withTz = /Z$|[+-]\d{2}:?\d{2}$/.test(normalized)
    ? normalized
    : `${normalized}Z`;
  const date = new Date(withTz);
  if (isNaN(date.getTime())) return iso;
  const diff = Date.now() - date.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo} 个月前`;
  return `${Math.floor(mo / 12)} 年前`;
}

export function formatNumber(n: number | undefined | null): string {
  if (n === undefined || n === null) return "";
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

// en-US compact: 1.2k / 142k / 1.2M (used for GitHub stars/forks/watchers
// since the rest of GitHub UI uses this convention worldwide).
export function formatCompact(n: number | undefined | null): string {
  if (n === undefined || n === null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// 1 → "1st", 2 → "2nd", 3 → "3rd", 4 → "4th", ..., 11 → "11th", 21 → "21st"
export function ordinal(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "";
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

// Hosts that need worker /img proxy to load reliably on CN networks:
//   - pbs.twimg.com / abs.twimg.com / video.twimg.com: GFW blocks
//   - avatars.githubusercontent.com: GH 头像国内访问偶发慢/302 重定向到 camo
//   - cdn-*.huggingface.co + huggingface.co: CN 网络对 HF 偶发慢,
//     R2 mirror 之外的直链(HF social-thumbnail / identicon)需要反代加速
//   - arxiv.org: arxiv html/pdf 全文内嵌图直链(figures、equation 渲染等)
// BE 2026-05-19: worker /img ALLOWED_IMG_HOSTS 已支持以上域,FE 同步扩 allowlist
const PROXY_HOSTS = new Set([
  "pbs.twimg.com",
  "abs.twimg.com",
  "video.twimg.com",
  "avatars.githubusercontent.com",
  "cdn-avatars.huggingface.co",
  "cdn-thumbnails.huggingface.co",
  "cdn-uploads.huggingface.co",
  "huggingface.co",
  "arxiv.org",
  // 2026-05-19 PM #4 X 推文嵌外链卡片 OG 图 — BE 已加 worker ALLOWED_IMG_HOSTS (#87)
  "opengraph.githubassets.com",      // X 嵌 GH 仓库 / issue 链接卡
  "og.luma.com",                      // X 嵌 Luma 活动链接卡
  "jf.x.com",                         // Twitter media inflight gateway
]);
const PROXY_BASE =
  import.meta.env.VITE_API_BASE || "https://api.ai-feeds.com";

// width: 物理像素 hint。worker 后端走 CF cdn-cgi/image 缩到该宽度，
// 高度按比例。GH 头像 460×460 jpeg 实测：?w=80 → 2.5KB（省 91%）/
// ?w=400 → 18KB（省 37%）/ 不传 → passthrough 原图。
// 物理像素而非 CSS 像素：所有 DPR 共享同一 CF cache entry，命中率最高。
// 调用方按场景档位传：头像 80 / 卡片缩略图 400 / 详情大图 800。
// video.twimg.com 不要传 width（worker /img 会 short-circuit 跳过 cf.image）。
// force: 默认只对 PROXY_HOSTS allowlist 域名走代理（GFW / 不稳定源用）；
// LinkCard 等 og:image 任意外链场景传 force=true，让所有域都走 cf.image
// + R2 缓存（避免 CN 网络直拉外链慢导致滑动卡顿）。
export function proxyImg(
  url: string | null | undefined,
  width?: number,
  opts: { force?: boolean } = {},
): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (opts.force || PROXY_HOSTS.has(u.hostname)) {
      const params = new URLSearchParams({ url });
      if (width && u.hostname !== "video.twimg.com") {
        params.set("w", String(width));
      }
      return `${PROXY_BASE}/img?${params.toString()}`;
    }
  } catch {
    // malformed URL — leave as-is and let <img> onError handle it
  }
  return url;
}

export function parseJsonField<T>(field: unknown): T | null {
  if (!field) return null;
  if (typeof field === "string") {
    try {
      return JSON.parse(field) as T;
    } catch {
      return null;
    }
  }
  return field as T;
}

// last-seen storage: per-feed boundary (scraped_at string) marking the newest
// item the user has seen. Used to render the "上次看到这里" waistband.
const LAST_SEEN_PREFIX = "xlist:last_seen:";

export function getLastSeen(sourceType: string): string | null {
  try {
    return localStorage.getItem(LAST_SEEN_PREFIX + sourceType);
  } catch {
    return null;
  }
}

export function setLastSeen(sourceType: string, scrapedAt: string): void {
  try {
    const prev = localStorage.getItem(LAST_SEEN_PREFIX + sourceType);
    // Only write forward — never move the boundary backward.
    if (!prev || scrapedAt > prev) {
      localStorage.setItem(LAST_SEEN_PREFIX + sourceType, scrapedAt);
    }
  } catch {
    // ignore — localStorage may be disabled
  }
}

// seen-ids LRU: used by hot-sort mode to filter out already-seen items so
// both pull-down and pull-up surface "unseen hottest". Stored as newest-first
// array with a size cap and TTL. TTL matches hot window + slack — stale ids
// outside the hot window don't affect filtering anyway, but keeping them
// capped bounds localStorage usage.
const SEEN_IDS_PREFIX = "xlist:seen_ids:";
const SEEN_IDS_MAX = 500;
const SEEN_IDS_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

interface SeenEntry {
  id: string;
  at: number;
}

export function getSeenIds(sourceType: string): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_IDS_PREFIX + sourceType);
    if (!raw) return new Set();
    const entries: SeenEntry[] = JSON.parse(raw);
    const cutoff = Date.now() - SEEN_IDS_TTL_MS;
    return new Set(entries.filter((e) => e.at >= cutoff).map((e) => e.id));
  } catch {
    return new Set();
  }
}

export function markSeen(sourceType: string, ids: string[]): void {
  if (ids.length === 0) return;
  try {
    const key = SEEN_IDS_PREFIX + sourceType;
    const raw = localStorage.getItem(key);
    const existing: SeenEntry[] = raw ? JSON.parse(raw) : [];
    const cutoff = Date.now() - SEEN_IDS_TTL_MS;
    const now = Date.now();
    // Drop expired + dedup (new ids win by pushing to front).
    const fresh = new Map<string, number>();
    for (const e of existing) if (e.at >= cutoff) fresh.set(e.id, e.at);
    for (const id of ids) fresh.set(id, now);
    // Most-recent-first, cap to MAX.
    const combined = Array.from(fresh, ([id, at]) => ({ id, at }))
      .sort((a, b) => b.at - a.at)
      .slice(0, SEEN_IDS_MAX);
    localStorage.setItem(key, JSON.stringify(combined));
  } catch {
    // ignore
  }
}

export function rowMaxScrapedAt(row: FeedRow): string {
  if (row.kind === "single") return row.item.scraped_at;
  // Thread row: any item in the thread being "new" makes the whole thread new.
  return row.items.reduce(
    (max, i) => (i.scraped_at > max ? i.scraped_at : max),
    "",
  );
}

export type FeedRow =
  | { kind: "single"; item: Item }
  | { kind: "thread"; rootId: string; items: Item[] };

// Group items belonging to the same thread_root_id into a ThreadRow.
// Preserves feed order (each thread takes its newest-scraped position).
// Thread internal order: published_at ascending (timeline order).
export function groupByThread(items: Item[]): FeedRow[] {
  const byRoot = new Map<string, Item[]>();
  const tokens: string[] = [];
  const seen = new Set<string>();

  const threadRoot = (item: Item): string | null => {
    const extra = parseJsonField<ItemExtra>(item.extra);
    return extra?.thread_root_id || null;
  };

  for (const it of items) {
    const root = threadRoot(it);
    if (root) {
      if (!byRoot.has(root)) byRoot.set(root, []);
      byRoot.get(root)!.push(it);
      if (!seen.has(root)) {
        seen.add(root);
        tokens.push(`T:${root}`);
      }
    } else {
      tokens.push(`S:${it.id}`);
    }
  }

  const byId = new Map(items.map((i) => [i.id, i]));
  const rows: FeedRow[] = [];
  for (const tok of tokens) {
    if (tok[0] === "T") {
      const root = tok.slice(2);
      const group = byRoot.get(root)!;
      if (group.length === 1) {
        rows.push({ kind: "single", item: group[0] });
      } else {
        // Sort by published_at asc, then source_id asc as tiebreaker.
        // Needed because published_at precision is only seconds — thread
        // tweets posted in the same second would otherwise come out in
        // arbitrary order. source_id (snowflake) is monotonic.
        const sorted = [...group].sort((a, b) => {
          const ta = a.published_at || a.scraped_at;
          const tb = b.published_at || b.scraped_at;
          const timeCmp = ta.localeCompare(tb);
          if (timeCmp !== 0) return timeCmp;
          return a.source_id.localeCompare(b.source_id);
        });
        rows.push({ kind: "thread", rootId: root, items: sorted });
      }
    } else {
      const id = tok.slice(2);
      const it = byId.get(id);
      if (it) rows.push({ kind: "single", item: it });
    }
  }
  return rows;
}
