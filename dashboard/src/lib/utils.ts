import type { Item, ItemExtra } from "../types";

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
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

// pbs.twimg.com / abs.twimg.com / video.twimg.com are blocked on CN networks.
// Route them through our own worker proxy to restore image loading.
const PROXY_HOSTS = new Set(["pbs.twimg.com", "abs.twimg.com", "video.twimg.com"]);
const PROXY_BASE =
  import.meta.env.VITE_API_BASE || "https://api.ai-feeds.com";

export function proxyImg(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (PROXY_HOSTS.has(u.hostname)) {
      return `${PROXY_BASE}/img?url=${encodeURIComponent(url)}`;
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
