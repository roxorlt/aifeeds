// Enrich module: pull missing quote_of / link_card / metrics for items in D1
// by calling cdn.syndication.twimg.com (same API react-tweet uses).
// Replaces the local Python enrich_from_syndication.py for cloud-side runs.

export interface EnrichEnv {
  DB: D1Database;
  DEEPSEEK_API_KEY?: string;
}

const SYNDICATION_URL = "https://cdn.syndication.twimg.com/tweet-result";
const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Referer: "https://platform.twitter.com/",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

// ─── Token algorithm (react-tweet original) ────────────────────
function getToken(tid: string): string {
  const n = (Number(tid) / 1e15) * Math.PI;
  return n.toString(36).replace(/(0+|\.)/g, "");
}

// ─── API fetch with retries ────────────────────────────────────
export interface FetchResult {
  data?: Record<string, unknown>;
  notFound?: boolean;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchTweet(
  tid: string,
  maxRetries = 5,
): Promise<FetchResult | null> {
  const token = getToken(tid);
  const url = `${SYNDICATION_URL}?id=${tid}&lang=en&token=${token}`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(url, {
        headers: HEADERS,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (resp.status === 404) {
        return { notFound: true };
      }
      if (resp.status === 429) {
        const wait = Math.min(2 ** attempt * 1000, 32000);
        console.log(
          `tweet_id=${tid} attempt=${attempt} HTTP 429 backoff=${wait}ms`,
        );
        await sleep(wait);
        continue;
      }
      if (resp.status >= 500) {
        const wait = Math.min(2 ** attempt * 1000, 16000);
        console.log(
          `tweet_id=${tid} attempt=${attempt} HTTP ${resp.status} backoff=${wait}ms`,
        );
        await sleep(wait);
        continue;
      }
      if (!resp.ok) {
        console.error(
          `tweet_id=${tid} HTTP ${resp.status} permanent`,
        );
        return null;
      }
      const data = await resp.json<Record<string, unknown>>();
      if (attempt > 1) {
        console.log(`tweet_id=${tid} SUCCESS after ${attempt} attempts`);
      }
      return { data };
    } catch (e) {
      const wait = Math.min(2 ** attempt * 1000, 16000);
      const name = e instanceof Error ? e.name : "unknown";
      console.log(
        `tweet_id=${tid} attempt=${attempt} NETWORK_ERROR ${name} backoff=${wait}ms`,
      );
      await sleep(wait);
    }
  }
  console.error(`tweet_id=${tid} EXHAUSTED ${maxRetries} retries`);
  return null;
}

// ─── API response → our JSON shapes ────────────────────────────
function normalizeMediaUrl(url: string): string {
  if (!url) return url;
  if (url.includes("?")) {
    if (url.includes("name=")) {
      return url.replace(/name=\w+/, "name=medium");
    }
    return url + "&name=medium";
  }
  return url + "?format=jpg&name=medium";
}

interface QuoteOf {
  id: string | null;
  author: string | null;
  handle: string | null;
  content: string | null;
  profile_image_url: string | null;
  is_verified: number;
  media: Array<{ type: string; url: string; width?: number; height?: number }>;
  published_at: string | null;
  content_translated?: string | null;
}

export function apiToQuoteOf(qt: Record<string, unknown>): QuoteOf {
  const user = (qt.user as Record<string, unknown>) || {};
  const mediaDetails = (qt.mediaDetails as Array<Record<string, unknown>>) || [];
  const media: QuoteOf["media"] = [];
  for (const m of mediaDetails) {
    const rawUrl = (m.media_url_https as string) || "";
    if (!rawUrl) continue;
    const oi = (m.original_info as Record<string, unknown>) || {};
    media.push({
      type:
        m.type === "photo"
          ? "image"
          : ((m.type as string) || "image"),
      url: normalizeMediaUrl(rawUrl),
      width: oi.width as number | undefined,
      height: oi.height as number | undefined,
    });
  }
  const verified =
    (user.verified as boolean) || (user.is_blue_verified as boolean);
  return {
    id: (qt.id_str as string) || null,
    author: (user.name as string) || null,
    handle: (user.screen_name as string) || null,
    content: (qt.text as string) || null,
    profile_image_url: (user.profile_image_url_https as string) || null,
    is_verified: verified ? 1 : 0,
    media,
    published_at: (qt.created_at as string) || null,
  };
}

export interface LinkCard {
  url: string | null;
  display_url: string | null;
  title: string | null;
  description: string | null;
  domain: string | null;
  image_url: string | null;
  title_translated?: string | null;
  description_translated?: string | null;
}

export function apiToLinkCard(data: Record<string, unknown>): LinkCard | null {
  const card = data.card as Record<string, unknown> | undefined;
  if (!card) return null;
  const bv =
    (card.binding_values as Record<string, Record<string, unknown>>) || {};

  const val = (key: string): string | null => {
    const v = bv[key];
    if (!v) return null;
    return (v.string_value as string) || null;
  };
  const img = (key: string): string | null => {
    const v = bv[key];
    if (!v) return null;
    const iv = v.image_value as Record<string, unknown> | undefined;
    return iv ? ((iv.url as string) || null) : null;
  };

  const title = val("title");
  const description = val("description");
  if (!title && !description) return null;

  const imageUrl =
    img("thumbnail_image_large") ||
    img("photo_image_full_size_large") ||
    img("summary_photo_image_large") ||
    img("thumbnail_image_original");

  const displayUrl = val("vanity_url");
  const entities = data.entities as Record<string, unknown> | undefined;
  const urls = (entities?.urls as Array<Record<string, unknown>>) || [];
  let expandedUrl: string | null = null;
  if (urls.length > 0) {
    expandedUrl =
      (urls[0].expanded_url as string) ||
      (urls[0].url as string) ||
      null;
  }
  if (!expandedUrl) {
    expandedUrl = (card.url as string) || null;
  }

  return {
    url: expandedUrl,
    display_url: displayUrl,
    title,
    description,
    domain: val("domain"),
    image_url: imageUrl,
  };
}

export interface Metrics {
  replies?: number;
  retweets?: number;
  likes?: number;
  views?: number;
  bookmarks?: number;
}

export function apiToMetrics(data: Record<string, unknown>): Metrics {
  return {
    replies: (data.conversation_count as number) ?? undefined,
    retweets: (data.retweet_count as number) ?? undefined,
    likes: (data.favorite_count as number) ?? undefined,
    bookmarks: (data.bookmark_count as number) ?? undefined,
  };
}

// ─── 单 item on-demand refresh（drawer 打开时调用） ─────────────
// PR6.6 lazy-enrich-on-drawer：不是 cron 全表轮询，而是用户点开抽屉时立即刷新这一条。
// 三源策略：
//   - x_list：syndication API 拉 metrics + quote_of + link_card（1-3s）
//   - github：GitHub REST API 拉 stars/forks/watchers/issues/PRs/contributors（<1s）
//   - product_hunt：留到下次 PR（CF Browser binding 5-10s）
//
// 节流：KV 存 last_refreshed_at，60s 内同 item 只刷一次（短到允许"关掉再开"，
// 长到避免单条疯狂刷）。
// 失败：返回旧数据 + 不写 KV（下次能重试）。

const REFRESH_THROTTLE_KEY_PREFIX = 'item-refresh-throttle:';
const REFRESH_THROTTLE_TTL = 60; // 60s — 短到允许"关掉再开"看到新数据，长到避免单条疯狂刷

export interface SingleItemRefreshResult {
  refreshed: boolean;
  source_type: string;
  reason?: 'throttled' | 'unsupported_source' | 'item_not_found' | 'fetch_failed' | 'success';
  metrics?: Metrics | Record<string, number | string | null>;
}

// 去掉 undefined 字段（JSON.stringify 也会 drop，但 spread 时 undefined 还是会
// 覆盖前面对象的同名字段 — 显式过滤一下避免误操作）
function prunedNonUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k in o) {
    if (o[k] !== undefined) out[k] = o[k];
  }
  return out;
}

export async function refreshSingleItem(
  env: EnrichEnv & { AUTH_KV?: KVNamespace; GITHUB_TOKEN?: string },
  itemId: string,
): Promise<SingleItemRefreshResult> {
  // 1. throttle check（KV，5min 内不重刷）
  if (env.AUTH_KV) {
    const ttlKey = REFRESH_THROTTLE_KEY_PREFIX + itemId;
    const last = await env.AUTH_KV.get(ttlKey);
    if (last) {
      return { refreshed: false, source_type: 'unknown', reason: 'throttled' };
    }
  }

  // 2. 查 item，识别 source_type + source_id
  const item = await env.DB.prepare(
    `SELECT id, source_type, source_id FROM items WHERE id = ?`,
  ).bind(itemId).first<{ id: string; source_type: string; source_id: string }>();
  if (!item) {
    return { refreshed: false, source_type: 'unknown', reason: 'item_not_found' };
  }

  // 3. 按 source_type 分发（目前只 X 走 syndication）
  if (item.source_type === 'x_list') {
    const r = await fetchTweet(item.source_id);
    if (!r || r.notFound || !r.data) {
      return { refreshed: false, source_type: 'x_list', reason: 'fetch_failed' };
    }
    // ⚠️ X syndication 当前已不返 retweet_count / view_count（平台隐私收紧）
    // apiToMetrics 这两个字段是 undefined，JSON.stringify 后 drop 掉，导致直接
    // UPDATE 会清掉 D1 里旧的 retweets / views 数据 → 永远显示「—」
    // 修：merge 旧 metrics，仅覆盖 syndication 实际返回的字段
    const newPart = apiToMetrics(r.data);
    const oldRow = await env.DB.prepare(
      `SELECT metrics FROM items WHERE id = ?`,
    ).bind(item.id).first<{ metrics: string | null }>();
    let oldMetrics: Record<string, number | undefined> = {};
    if (oldRow?.metrics) {
      try { oldMetrics = JSON.parse(oldRow.metrics) || {}; } catch { /* ignore */ }
    }
    const merged: Metrics = { ...oldMetrics, ...prunedNonUndefined(newPart as unknown as Record<string, unknown>) } as Metrics;
    await updateMetrics(env, item.id, merged);
    // 写 throttle key
    if (env.AUTH_KV) {
      await env.AUTH_KV.put(REFRESH_THROTTLE_KEY_PREFIX + itemId, String(Date.now()), {
        expirationTtl: REFRESH_THROTTLE_TTL,
      });
    }
    return { refreshed: true, source_type: 'x_list', reason: 'success', metrics: merged };
  }

  if (item.source_type === 'github') {
    const { refreshGithubItem } = await import('./github');
    const r = await refreshGithubItem(env, item.id, item.source_id);
    if (!r) {
      return { refreshed: false, source_type: 'github', reason: 'fetch_failed' };
    }
    if (env.AUTH_KV) {
      await env.AUTH_KV.put(REFRESH_THROTTLE_KEY_PREFIX + itemId, String(Date.now()), {
        expirationTtl: REFRESH_THROTTLE_TTL,
      });
    }
    return { refreshed: true, source_type: 'github', reason: 'success', metrics: r.metrics };
  }

  // PH 暂留下个 PR（需要 CF Browser binding）
  return { refreshed: false, source_type: item.source_type, reason: 'unsupported_source' };
}

// ─── State persistence via enrich_state table ──────────────────
export interface EnrichState {
  processed_ids: string[];
  failed_ids: string[];
  not_found_ids: string[];
  started_at: string;
  last_update: string | null;
  counts?: Record<string, number>;
}

export async function loadState(
  env: EnrichEnv,
  mode: string,
): Promise<EnrichState> {
  const row = await env.DB.prepare(
    "SELECT state FROM enrich_state WHERE mode = ?",
  )
    .bind(mode)
    .first<{ state: string }>();
  if (row?.state) {
    try {
      return JSON.parse(row.state) as EnrichState;
    } catch {
      // fall through to fresh state
    }
  }
  return {
    processed_ids: [],
    failed_ids: [],
    not_found_ids: [],
    started_at: new Date().toISOString(),
    last_update: null,
  };
}

export async function saveState(
  env: EnrichEnv,
  mode: string,
  state: EnrichState,
): Promise<void> {
  state.last_update = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO enrich_state (mode, state, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(mode) DO UPDATE SET
       state = excluded.state,
       updated_at = excluded.updated_at`,
  )
    .bind(mode, JSON.stringify(state), state.last_update)
    .run();
}

// ─── Candidate selection + patch write ─────────────────────────
interface CandidateRow {
  id: string;
  source_id: string;
  extra: string | null;
}

/** items.extra is JSON; candidates are is_relevant=1 items not yet enriched.
 *  enriched_at is written on every processed item (including empty results)
 *  so the SQL filter permanently excludes them on subsequent runs. The
 *  quote_of/link_card fallback handles pre-enriched_at items (pre-2026-04-20). */
async function selectBackfillCandidates(
  env: EnrichEnv,
  done: Set<string>,
  limit: number,
): Promise<CandidateRow[]> {
  const fetchBatch = Math.min(Math.max(limit * 2, 100), 1000);
  const rows = await env.DB.prepare(
    `SELECT id, source_id, extra
     FROM items
     WHERE source_type = 'x_list'
       AND is_relevant = 1
       AND (extra IS NULL
            OR (extra NOT LIKE '%"enriched_at"%'
                AND extra NOT LIKE '%"quote_of"%'
                AND extra NOT LIKE '%"link_card"%'))
     ORDER BY scraped_at DESC
     LIMIT ?`,
  )
    .bind(fetchBatch)
    .all<CandidateRow>();

  const out: CandidateRow[] = [];
  for (const r of rows.results) {
    if (!done.has(r.source_id)) {
      out.push(r);
      if (out.length >= limit) break;
    }
  }
  return out;
}

interface Patch {
  metrics?: Metrics;
  quote_of?: QuoteOf | null;
  quote_of_id?: string | null;
  link_card?: LinkCard | null;
  clearThreadRoot?: boolean;
  // PR-B: reply parent enrichment. reply_of_id is the canonical id field
  // (parallel to quote_of_id); reply_of is the full snapshot from
  // syndication's `parent` payload. reply_to_screen_name lets the UI render
  // "↩ 回复 @handle" even when the snapshot fetch is missing.
  reply_of_id?: string | null;
  reply_of?: QuoteOf | null;
  reply_to_screen_name?: string | null;
  // Sentinel that backfill-replies has examined this item (idempotent skip).
  reply_enriched?: boolean;
}

/** Apply patch to an item: merge into extra JSON + update metrics column. */
async function applyPatch(
  env: EnrichEnv,
  row: CandidateRow,
  patch: Patch,
): Promise<void> {
  let extra: Record<string, unknown> = {};
  if (row.extra) {
    try {
      // Legacy rows can store the literal string "null" (from
      // JSON.stringify(undefined ?? null) at ingest); parse yields null,
      // not an object. Guard against that + arrays.
      const parsed = JSON.parse(row.extra);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        extra = parsed as Record<string, unknown>;
      }
    } catch {
      extra = {};
    }
  }
  if (patch.quote_of !== undefined) extra.quote_of = patch.quote_of;
  if (patch.quote_of_id !== undefined) extra.quote_of_id = patch.quote_of_id;
  if (patch.link_card !== undefined) extra.link_card = patch.link_card;
  if (patch.clearThreadRoot) delete extra.thread_root_id;
  if (patch.reply_of !== undefined) extra.reply_of = patch.reply_of;
  if (patch.reply_of_id !== undefined) {
    extra.reply_of_id = patch.reply_of_id;
    // Mirror to legacy field for any downstream code still reading reply_to_id
    extra.reply_to_id = patch.reply_of_id;
  }
  if (patch.reply_to_screen_name !== undefined) {
    extra.reply_to_screen_name = patch.reply_to_screen_name;
  }
  if (patch.reply_enriched) {
    extra.reply_enriched_at = new Date().toISOString();
  }
  extra.enriched_at = new Date().toISOString();

  const updates: string[] = ["extra = ?"];
  const vals: unknown[] = [JSON.stringify(extra)];
  if (patch.metrics) {
    updates.push("metrics = ?");
    vals.push(JSON.stringify(patch.metrics));
  }
  vals.push(row.id);
  await env.DB.prepare(
    `UPDATE items SET ${updates.join(", ")} WHERE id = ?`,
  )
    .bind(...vals)
    .run();
}

// ─── Main runner: backfill-quotes mode ─────────────────────────
export interface RunResult {
  mode: string;
  processed: number;
  with_quote: number;
  with_card: number;
  empty: number;
  not_found: number;
  failed: number;
  elapsed_ms: number;
  remaining_hint?: number;
}

/** Run up to `limit` candidates. Sleeps `rateSleepMs` between calls.
 *  Designed to be called from a cron handler — caller decides frequency. */
export async function runBackfillQuotes(
  env: EnrichEnv,
  limit = 20,
  rateSleepMs = 400,
): Promise<RunResult> {
  const mode = "backfill-quotes";
  const t0 = Date.now();
  const state = await loadState(env, mode);
  const done = new Set<string>([
    ...state.processed_ids,
    ...state.not_found_ids,
  ]);

  const candidates = await selectBackfillCandidates(env, done, limit);
  const counts = {
    processed: 0,
    with_quote: 0,
    with_card: 0,
    empty: 0,
    not_found: 0,
    failed: 0,
  };

  for (const row of candidates) {
    const tid = row.source_id;
    const res = await fetchTweet(tid);
    if (res === null) {
      state.failed_ids.push(tid);
      counts.failed++;
    } else if (res.notFound) {
      state.not_found_ids.push(tid);
      counts.not_found++;
    } else if (res.data) {
      const qt = res.data.quoted_tweet as
        | Record<string, unknown>
        | undefined;
      const card = apiToLinkCard(res.data);
      const apiReplyTo = res.data.in_reply_to_status_id_str as
        | string
        | undefined;

      const patch: Patch = {};
      let gotAny = false;
      if (qt && qt.id_str) {
        patch.quote_of_id = qt.id_str as string;
        patch.quote_of = apiToQuoteOf(qt);
        counts.with_quote++;
        gotAny = true;
      }
      if (card) {
        patch.link_card = card;
        counts.with_card++;
        gotAny = true;
      }
      if (!apiReplyTo) {
        patch.clearThreadRoot = true;
      }
      if (!gotAny) counts.empty++;

      await applyPatch(env, row, patch);
      state.processed_ids.push(tid);
      counts.processed++;
    }

    if (rateSleepMs > 0) await sleep(rateSleepMs);

    // Save state every 25 items to survive cron timeout
    if (counts.processed % 25 === 0 && counts.processed > 0) {
      await saveState(env, mode, state);
    }
  }

  await saveState(env, mode, state);

  return {
    mode,
    processed: counts.processed,
    with_quote: counts.with_quote,
    with_card: counts.with_card,
    empty: counts.empty,
    not_found: counts.not_found,
    failed: counts.failed,
    elapsed_ms: Date.now() - t0,
    remaining_hint: Math.max(0, candidates.length - counts.processed),
  };
}

// ─── backfill-replies mode ─────────────────────────────────────
// PR-B: pull reply parent snapshot via syndication API's `parent` field.
// Parallel to backfill-quotes but covers ALL items (not just quote candidates),
// because the legacy scraper never captured reply_to_id — every existing item
// is potentially missing reply data. Ordered newest-first so recently-shared
// content gets fixed first.

async function selectReplyBackfillCandidates(
  env: EnrichEnv,
  done: Set<string>,
  limit: number,
): Promise<CandidateRow[]> {
  const fetchBatch = Math.min(Math.max(limit * 2, 100), 1000);
  const rows = await env.DB.prepare(
    `SELECT id, source_id, extra
     FROM items
     WHERE source_type = 'x_list'
       AND is_relevant = 1
       AND (extra IS NULL
            OR (extra NOT LIKE '%"reply_enriched_at"%'
                AND extra NOT LIKE '%"reply_of"%'))
     ORDER BY published_at DESC, id DESC
     LIMIT ?`,
  )
    .bind(fetchBatch)
    .all<CandidateRow>();

  const out: CandidateRow[] = [];
  for (const r of rows.results) {
    if (!done.has(r.source_id)) {
      out.push(r);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export async function runBackfillReplies(
  env: EnrichEnv,
  limit = 20,
  rateSleepMs = 400,
): Promise<RunResult> {
  const mode = "backfill-replies";
  const t0 = Date.now();
  const state = await loadState(env, mode);
  const done = new Set<string>([
    ...state.processed_ids,
    ...state.not_found_ids,
  ]);

  const candidates = await selectReplyBackfillCandidates(env, done, limit);
  const counts = {
    processed: 0,
    with_reply: 0,
    no_reply: 0,
    not_found: 0,
    failed: 0,
    // Reuse RunResult's existing fields below, mapped:
    //   with_quote → with_reply (we filled reply_of)
    //   with_card  → 0 (not relevant here)
    //   empty      → no_reply (item is not a reply)
  };

  for (const row of candidates) {
    const tid = row.source_id;
    const res = await fetchTweet(tid);
    if (res === null) {
      state.failed_ids.push(tid);
      counts.failed++;
    } else if (res.notFound) {
      state.not_found_ids.push(tid);
      counts.not_found++;
    } else if (res.data) {
      const apiReplyToId = res.data.in_reply_to_status_id_str as
        | string
        | undefined;
      const apiReplyToHandle = res.data.in_reply_to_screen_name as
        | string
        | undefined;
      const parent = res.data.parent as Record<string, unknown> | undefined;

      const patch: Patch = { reply_enriched: true };
      if (apiReplyToId) {
        patch.reply_of_id = apiReplyToId;
        patch.reply_to_screen_name = apiReplyToHandle ?? null;
        if (parent && parent.id_str) {
          patch.reply_of = apiToQuoteOf(parent);
        } else {
          // Parent suppressed (deleted/protected) — keep id+handle for the
          // "↩ 回复 @handle" placeholder, leave reply_of null.
          patch.reply_of = null;
        }
        counts.with_reply++;
      } else {
        // Confirmed not a reply. Still mark sentinel so we skip on rerun.
        counts.no_reply++;
      }

      try {
        await applyPatch(env, row, patch);
        state.processed_ids.push(tid);
        counts.processed++;
      } catch (e) {
        console.error(`[backfill-replies] applyPatch failed for ${tid}:`, e);
        state.failed_ids.push(tid);
        counts.failed++;
      }
    }

    if (rateSleepMs > 0) await sleep(rateSleepMs);

    if (counts.processed % 25 === 0 && counts.processed > 0) {
      await saveState(env, mode, state);
    }
  }

  await saveState(env, mode, state);

  return {
    mode,
    processed: counts.processed,
    with_quote: counts.with_reply,
    with_card: 0,
    empty: counts.no_reply,
    not_found: counts.not_found,
    failed: counts.failed,
    elapsed_ms: Date.now() - t0,
    remaining_hint: Math.max(0, candidates.length - counts.processed),
  };
}

// ─── reclassify-threads mode ───────────────────────────────────
// PR-B step 2: clear thread_root_id from items that are NOT part of a real
// self-thread. Definition of self-thread: a chain of same-author tweets where
// each member's reply_of_id points to either the root or another in-chain
// member by the same author. Anything else (Q&A reply trees with mixed
// authors, replies to non-list users, etc.) gets thread_root_id stripped so
// it renders as a standalone card instead of bundled.
//
// Idempotent. Run after backfill-replies completes coverage of all members.
// ALWAYS runs full sweep (one-shot) — no cron rotation. Trigger via
// /api/enrich/run?mode=reclassify-threads&dry_run=1 first to inspect.

interface ReclassifyResult {
  mode: "reclassify-threads";
  groups_total: number;
  groups_kept_intact: number;
  groups_partially_cleared: number;
  groups_fully_cleared: number;
  members_kept: number;
  members_cleared: number;
  members_skipped_unenriched: number;
  dry_run: boolean;
  elapsed_ms: number;
}

interface ThreadRow {
  id: string;
  source_id: string;
  handle: string | null;
  extra: string | null;
}

export async function runReclassifyThreads(
  env: EnrichEnv,
  dryRun = true,
): Promise<ReclassifyResult> {
  const t0 = Date.now();

  // Pull every item with thread_root_id set. ~6500 rows; small enough to
  // process in memory.
  const rows = await env.DB.prepare(
    `SELECT id, source_id, handle, extra
     FROM items
     WHERE source_type = 'x_list'
       AND extra ->> '$.thread_root_id' IS NOT NULL`,
  ).all<ThreadRow>();

  // Bucket by thread_root_id
  const groups = new Map<string, ThreadRow[]>();
  for (const r of rows.results) {
    const extra = r.extra ? (JSON.parse(r.extra) as Record<string, unknown>) : {};
    const root = extra.thread_root_id as string | undefined;
    if (!root) continue;
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(r);
  }

  let groupsKept = 0;
  let groupsPartial = 0;
  let groupsCleared = 0;
  let totalKept = 0;
  let totalCleared = 0;
  let totalSkipped = 0;

  const idsToClear: string[] = [];

  for (const [rootId, members] of groups) {
    // Index members by source_id for graph walk
    const bySourceId = new Map<string, ThreadRow>();
    for (const m of members) bySourceId.set(m.source_id, m);

    // Find the root member (its source_id == rootId, present in this group)
    const root = bySourceId.get(rootId);
    if (!root) {
      // Root not in our group (root not scraped) — fallback: keep largest
      // same-author connected component reachable via reply chains.
      // But conservatively just skip and clear all (we can't verify).
      for (const m of members) idsToClear.push(m.id);
      groupsCleared++;
      totalCleared += members.length;
      continue;
    }

    const rootHandle = root.handle;

    // BFS: anchor = root; iteratively pull members whose reply_of points to
    // an already-anchored same-author member.
    const anchored = new Set<string>([rootId]);
    let changed = true;
    let skippedThisGroup = 0;
    while (changed) {
      changed = false;
      for (const m of members) {
        if (anchored.has(m.source_id)) continue;
        const ex = m.extra ? (JSON.parse(m.extra) as Record<string, unknown>) : {};
        const replyEnriched = ex.reply_enriched_at as string | undefined;
        const replyTo = (ex.reply_of_id || ex.reply_to_id) as string | undefined;
        if (!replyEnriched) {
          // Not yet checked by backfill-replies. Don't decide yet.
          skippedThisGroup++;
          continue;
        }
        if (replyTo && anchored.has(replyTo) && m.handle === rootHandle) {
          anchored.add(m.source_id);
          changed = true;
        }
      }
    }

    let cleared = 0;
    for (const m of members) {
      if (!anchored.has(m.source_id)) {
        idsToClear.push(m.id);
        cleared++;
      }
    }

    if (cleared === 0) {
      groupsKept++;
      totalKept += members.length;
    } else if (cleared === members.length) {
      groupsCleared++;
      totalCleared += cleared;
    } else {
      groupsPartial++;
      totalKept += members.length - cleared;
      totalCleared += cleared;
    }
    totalSkipped += skippedThisGroup;
  }

  if (!dryRun && idsToClear.length > 0) {
    // Bulk update: clear thread_root_id from extra JSON. D1 doesn't support
    // arbitrary IN list size in one prepared statement reliably for huge
    // lists, so chunk.
    const CHUNK = 100;
    for (let i = 0; i < idsToClear.length; i += CHUNK) {
      const chunk = idsToClear.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      await env.DB.prepare(
        `UPDATE items
         SET extra = json_remove(extra, '$.thread_root_id')
         WHERE id IN (${placeholders})`,
      )
        .bind(...chunk)
        .run();
    }
  }

  return {
    mode: "reclassify-threads",
    groups_total: groups.size,
    groups_kept_intact: groupsKept,
    groups_partially_cleared: groupsPartial,
    groups_fully_cleared: groupsCleared,
    members_kept: totalKept,
    members_cleared: totalCleared,
    members_skipped_unenriched: totalSkipped,
    dry_run: dryRun,
    elapsed_ms: Date.now() - t0,
  };
}

// ─── refresh-metrics mode ──────────────────────────────────────
// Continuously refresh interaction metrics (likes/retweets/replies/bookmarks)
// for recent items. Unlike backfill-quotes which is one-shot per item,
// this mode cycles through candidates repeatedly.
//
// State semantics: processed_ids is a "this round" marker. When the round
// completes (all recent items processed), it resets to [] and starts over.

interface RefreshRow {
  id: string;
  source_id: string;
}

/** Select items published in the last N days, excluding those already
 *  processed in the current round.
 *
 *  Within the lookback window, prioritize rows where any of the four
 *  user-visible metric fields (likes/retweets/replies/views) is NULL —
 *  these show up as "—" on the dashboard. bookmarks is excluded from
 *  the completeness check because it's almost always null on X (only
 *  visible to logged-in viewers). */
async function selectRefreshCandidates(
  env: EnrichEnv,
  done: Set<string>,
  limit: number,
  lookbackDays: number,
): Promise<RefreshRow[]> {
  const cutoff = new Date(
    Date.now() - lookbackDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const fetchBatch = Math.min(Math.max(limit * 3, 100), 1000);
  const rows = await env.DB.prepare(
    `SELECT id, source_id,
            CASE
              WHEN metrics IS NULL OR metrics = '' OR metrics = '{}' THEN 1
              WHEN json_extract(metrics, '$.likes')    IS NULL
                OR json_extract(metrics, '$.retweets') IS NULL
                OR json_extract(metrics, '$.replies')  IS NULL
                OR json_extract(metrics, '$.views')    IS NULL THEN 1
              ELSE 0
            END AS is_incomplete
     FROM items
     WHERE source_type = 'x_list'
       AND is_relevant = 1
       AND published_at >= ?
     ORDER BY is_incomplete DESC, published_at DESC
     LIMIT ?`,
  )
    .bind(cutoff, fetchBatch)
    .all<RefreshRow>();

  const out: RefreshRow[] = [];
  for (const r of rows.results) {
    if (!done.has(r.source_id)) {
      out.push(r);
      if (out.length >= limit) break;
    }
  }
  return out;
}

async function updateMetrics(
  env: EnrichEnv,
  id: string,
  metrics: Metrics,
): Promise<void> {
  // M1.5: also append a snapshot so we can compute real Δ over time.
  // D1.batch() is atomic and runs both in one round-trip.
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("UPDATE items SET metrics = ? WHERE id = ?").bind(
      JSON.stringify(metrics),
      id,
    ),
    env.DB.prepare(
      "INSERT INTO metrics_snapshots " +
        "(item_id, captured_at, likes, retweets, replies, bookmarks, views) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      id,
      now,
      metrics.likes ?? null,
      metrics.retweets ?? null,
      metrics.replies ?? null,
      metrics.bookmarks ?? null,
      metrics.views ?? null,
    ),
  ]);
}

export interface RefreshResult {
  mode: string;
  processed: number;
  updated: number;
  not_found: number;
  failed: number;
  round_reset: boolean;
  elapsed_ms: number;
  remaining_hint: number;
}

/** Refresh metrics for up to `limit` recent items.
 *  lookbackDays: only consider items published within this window. */
export async function runRefreshMetrics(
  env: EnrichEnv,
  limit = 20,
  rateSleepMs = 400,
  lookbackDays = 14,
): Promise<RefreshResult> {
  const mode = "refresh-metrics";
  const t0 = Date.now();
  let state = await loadState(env, mode);
  let done = new Set<string>(state.processed_ids);
  let roundReset = false;

  let candidates = await selectRefreshCandidates(
    env,
    done,
    limit,
    lookbackDays,
  );

  // If round is complete (nothing left), reset and start over.
  if (candidates.length === 0 && state.processed_ids.length > 0) {
    state = {
      processed_ids: [],
      failed_ids: [],
      not_found_ids: [],
      started_at: new Date().toISOString(),
      last_update: null,
    };
    done = new Set<string>();
    roundReset = true;
    candidates = await selectRefreshCandidates(env, done, limit, lookbackDays);
  }

  const counts = { processed: 0, updated: 0, not_found: 0, failed: 0 };

  for (const row of candidates) {
    const tid = row.source_id;
    const res = await fetchTweet(tid);
    if (res === null) {
      state.failed_ids.push(tid);
      counts.failed++;
    } else if (res.notFound) {
      // Don't persist not-found here — item may come back (deleted-then-restored rare).
      // But skip this round.
      counts.not_found++;
      state.processed_ids.push(tid);
    } else if (res.data) {
      const m = apiToMetrics(res.data);
      const hasAny =
        m.replies !== undefined ||
        m.retweets !== undefined ||
        m.likes !== undefined ||
        m.bookmarks !== undefined;
      if (hasAny) {
        // ⚠️ syndication 当前不返 retweet_count / view_count（X 平台收紧）。
        // 直接 UPDATE 会把 metrics 整张表覆写，存在 DB 里 scraper DOM 抓
        // 到的 retweets / views 会被清成 null。merge 旧数据 + 仅覆盖
        // syndication 实际返回的字段。
        const oldRow = await env.DB.prepare(
          `SELECT metrics FROM items WHERE id = ?`,
        ).bind(row.id).first<{ metrics: string | null }>();
        let oldMetrics: Record<string, number | undefined> = {};
        if (oldRow?.metrics) {
          try { oldMetrics = JSON.parse(oldRow.metrics) || {}; } catch { /* ignore */ }
        }
        const merged: Metrics = {
          ...oldMetrics,
          ...prunedNonUndefined(m as unknown as Record<string, unknown>),
        } as Metrics;
        await updateMetrics(env, row.id, merged);
        counts.updated++;
      }
      state.processed_ids.push(tid);
      counts.processed++;
    }

    if (rateSleepMs > 0) await sleep(rateSleepMs);

    if (counts.processed % 25 === 0 && counts.processed > 0) {
      await saveState(env, mode, state);
    }
  }

  await saveState(env, mode, state);

  return {
    mode,
    processed: counts.processed,
    updated: counts.updated,
    not_found: counts.not_found,
    failed: counts.failed,
    round_reset: roundReset,
    elapsed_ms: Date.now() - t0,
    remaining_hint: Math.max(0, candidates.length - counts.processed),
  };
}

// ─── refresh-tiered mode (M4) ──────────────────────────────────
// Tier-aware replacement for runRefreshMetrics. Pulls items where
// next_refresh_at has elapsed and tier <= maxTier, computes Δlikes velocity
// from the latest metrics_snapshots row, recomputes tier (age + velocity
// dual), schedules next refresh, logs to refresh_log.
//
// Thresholds calibrated from M1 cumulative-average proxy (N=1369). Real Δ
// from snapshots typically 2-3x the proxy, so M5 will likely relax these.

const VEL_THRESHOLDS = {
  L1: 0.2,   // velocity >= 0.2 → L1 active (20min)
  L2: 0.08,  // velocity >= 0.08 → L2 active (60min)
  L3: 0.05,  // velocity >= 0.05 → L3 active (6h)
  L4: 0.04,  // velocity >= 0.04 → L4 active (3d)
} as const;

// [active_interval_sec, inactive_interval_sec] per tier; L0 has no
// velocity-split (always 10min), L5 never refreshes.
const TIER_INTERVAL_SEC: Record<number, [number, number] | [null, null]> = {
  0: [600, 600],          // 10m / 10m
  1: [1200, 2700],        // 20m / 45m
  2: [3600, 7200],        // 60m / 120m
  3: [21600, 86400],      // 6h  / 24h
  4: [259200, 604800],    // 3d  / 7d
  5: [null, null],        // never
};

function determineTier(
  ageSec: number,
  velocity: number,
): { tier: number; intervalSec: number | null } {
  const ageTier =
    ageSec < 3600 ? 0 :
    ageSec < 21600 ? 1 :
    ageSec < 86400 ? 2 :
    ageSec < 604800 ? 3 :
    ageSec < 1209600 ? 4 :
    5;

  if (ageTier === 5) return { tier: 5, intervalSec: null };

  // Lowest tier whose threshold velocity meets (5 = no upgrade)
  const velTier =
    velocity >= VEL_THRESHOLDS.L1 ? 1 :
    velocity >= VEL_THRESHOLDS.L2 ? 2 :
    velocity >= VEL_THRESHOLDS.L3 ? 3 :
    velocity >= VEL_THRESHOLDS.L4 ? 4 :
    5;

  // Take more aggressive (lower) tier; L0 reserved for fresh items only.
  let tier = Math.min(ageTier, velTier);
  if (ageTier > 0 && tier === 0) tier = 1;

  // Active threshold = velocity needed to keep this tier's "active" interval.
  const activeThreshold =
    tier === 0 ? 0 :
    tier === 1 ? VEL_THRESHOLDS.L1 :
    tier === 2 ? VEL_THRESHOLDS.L2 :
    tier === 3 ? VEL_THRESHOLDS.L3 :
    tier === 4 ? VEL_THRESHOLDS.L4 :
    Number.POSITIVE_INFINITY;

  const [active, inactive] = TIER_INTERVAL_SEC[tier];
  if (active === null) return { tier: 5, intervalSec: null };
  return {
    tier,
    intervalSec: velocity >= activeThreshold ? active : inactive,
  };
}

function computeVelocity(
  newLikes: number,
  prevLikes: number | null,
  prevCapturedAt: number | null,
  ageSec: number,
  nowSec: number,
): number {
  if (prevLikes !== null && prevCapturedAt !== null && nowSec > prevCapturedAt) {
    const dtMin = (nowSec - prevCapturedAt) / 60;
    if (dtMin > 0) return Math.max(0, (newLikes - prevLikes) / dtMin);
  }
  // Fallback: cumulative average (likes / age_minutes) — same proxy used in M3 backfill.
  const ageMin = ageSec / 60;
  if (ageMin <= 0 || newLikes <= 0) return 0;
  return newLikes / ageMin;
}

interface TierCandidateRow {
  id: string;
  source_id: string;
  published_at: string;
  tier: number;
  prev_likes: number | null;
  prev_captured_at: number | null;
}

async function selectTieredCandidates(
  env: EnrichEnv,
  limit: number,
  maxTier: number,
  nowSec: number,
): Promise<TierCandidateRow[]> {
  // Correlated subqueries on idx_snapshots_item_time → cheap.
  const rows = await env.DB.prepare(
    `SELECT i.id, i.source_id, i.published_at, i.tier,
       (SELECT likes FROM metrics_snapshots ms
        WHERE ms.item_id = i.id
        ORDER BY ms.captured_at DESC LIMIT 1) AS prev_likes,
       (SELECT captured_at FROM metrics_snapshots ms
        WHERE ms.item_id = i.id
        ORDER BY ms.captured_at DESC LIMIT 1) AS prev_captured_at
     FROM items i
     WHERE i.source_type = 'x_list'
       AND i.is_relevant = 1
       AND i.deleted_at IS NULL
       AND i.tier <= ?
       AND (i.next_refresh_at IS NULL OR i.next_refresh_at <= ?)
     ORDER BY i.tier ASC, i.next_refresh_at ASC
     LIMIT ?`,
  )
    .bind(maxTier, nowSec, limit)
    .all<TierCandidateRow>();
  return rows.results;
}

async function applyTieredUpdate(
  env: EnrichEnv,
  id: string,
  metrics: Metrics,
  tier: number,
  velocity: number,
  intervalSec: number | null,
  nowSec: number,
): Promise<void> {
  const nextRefreshAt = intervalSec === null ? null : nowSec + intervalSec;
  // 同 runRefreshMetrics：syndication 不返 retweets/views，直接覆写会清空
  // scraper DOM 抓到的旧值。读旧 metrics merge 后写回，仅覆盖本次实际收到的字段。
  const oldRow = await env.DB.prepare(
    `SELECT metrics FROM items WHERE id = ?`,
  ).bind(id).first<{ metrics: string | null }>();
  let oldMetrics: Record<string, number | undefined> = {};
  if (oldRow?.metrics) {
    try { oldMetrics = JSON.parse(oldRow.metrics) || {}; } catch { /* ignore */ }
  }
  const merged: Metrics = {
    ...oldMetrics,
    ...prunedNonUndefined(metrics as unknown as Record<string, unknown>),
  } as Metrics;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE items
       SET metrics = ?, tier = ?, last_velocity = ?, next_refresh_at = ?
       WHERE id = ?`,
    ).bind(JSON.stringify(merged), tier, velocity, nextRefreshAt, id),
    env.DB.prepare(
      `INSERT INTO metrics_snapshots
       (item_id, captured_at, likes, retweets, replies, bookmarks, views)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      nowSec,
      metrics.likes ?? null,
      metrics.retweets ?? null,
      metrics.replies ?? null,
      metrics.bookmarks ?? null,
      metrics.views ?? null,
    ),
  ]);
}

async function markDeleted(
  env: EnrichEnv,
  id: string,
  nowSec: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE items
     SET deleted_at = ?, next_refresh_at = NULL, tier = 5
     WHERE id = ?`,
  )
    .bind(nowSec, id)
    .run();
}

interface TierAgg {
  items: number;
  subreqs: number;
  errors: number;
}

async function logRefresh(
  env: EnrichEnv,
  byTier: Map<number, TierAgg>,
  durationMs: number,
  refreshedAt: number,
): Promise<void> {
  if (byTier.size === 0) return;
  const stmts = Array.from(byTier.entries()).map(([tier, agg]) =>
    env.DB.prepare(
      `INSERT INTO refresh_log
       (refreshed_at, tier, items_count, subrequests_used, duration_ms, errors)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(refreshedAt, tier, agg.items, agg.subreqs, durationMs, agg.errors),
  );
  if (stmts.length === 1) await stmts[0].run();
  else await env.DB.batch(stmts);
}

export interface TieredRefreshResult {
  mode: string;
  candidates: number;
  updated: number;
  not_found: number;
  failed: number;
  by_tier: Record<string, number>;
  elapsed_ms: number;
}

/** Tier-aware refresh entry point. Picks items with elapsed next_refresh_at
 *  (limited to tier <= maxTier), recomputes tier from age+velocity, writes
 *  metrics + tier + next_refresh_at + snapshot atomically. */
export async function runRefreshTiered(
  env: EnrichEnv,
  limit = 20,
  rateSleepMs = 400,
  maxTier = 4,
): Promise<TieredRefreshResult> {
  const t0 = Date.now();
  const nowSec = Math.floor(t0 / 1000);
  const candidates = await selectTieredCandidates(env, limit, maxTier, nowSec);

  const counts = { updated: 0, not_found: 0, failed: 0 };
  const byTier = new Map<number, TierAgg>();
  const tierCount: Record<string, number> = {};

  const bumpTier = (
    tier: number,
    items: number,
    subreqs: number,
    errors: number,
  ): void => {
    const agg = byTier.get(tier) || { items: 0, subreqs: 0, errors: 0 };
    agg.items += items;
    agg.subreqs += subreqs;
    agg.errors += errors;
    byTier.set(tier, agg);
  };

  for (const row of candidates) {
    const ageSec = Math.max(
      0,
      nowSec - Math.floor(new Date(row.published_at).getTime() / 1000),
    );
    const res = await fetchTweet(row.source_id);

    if (res === null) {
      counts.failed++;
      bumpTier(row.tier, 0, 1, 1);
      // Leave next_refresh_at unchanged so the next tick retries.
    } else if (res.notFound) {
      await markDeleted(env, row.id, nowSec);
      counts.not_found++;
      bumpTier(5, 1, 2, 0);
    } else if (res.data) {
      const m = apiToMetrics(res.data);
      const newLikes = m.likes ?? 0;
      const velocity = computeVelocity(
        newLikes,
        row.prev_likes,
        row.prev_captured_at,
        ageSec,
        nowSec,
      );
      const { tier, intervalSec } = determineTier(ageSec, velocity);
      await applyTieredUpdate(env, row.id, m, tier, velocity, intervalSec, nowSec);
      counts.updated++;
      tierCount[String(tier)] = (tierCount[String(tier)] || 0) + 1;
      bumpTier(tier, 1, 2, 0);
    }

    if (rateSleepMs > 0) await sleep(rateSleepMs);
  }

  await logRefresh(env, byTier, Date.now() - t0, nowSec);

  return {
    mode: 'refresh-tiered',
    candidates: candidates.length,
    updated: counts.updated,
    not_found: counts.not_found,
    failed: counts.failed,
    by_tier: tierCount,
    elapsed_ms: Date.now() - t0,
  };
}

// ─── cleanup mode (M5) ─────────────────────────────────────────
// Drops metrics_snapshots / refresh_log rows older than the retention
// window so D1 doesn't grow unbounded. Designed for daily cron use.

export interface CleanupResult {
  mode: string;
  cutoff_ts: number;
  snapshots_deleted: number;
  refresh_log_deleted: number;
  elapsed_ms: number;
}

export async function runCleanup(
  env: EnrichEnv,
  retentionDays = 30,
): Promise<CleanupResult> {
  const t0 = Date.now();
  const cutoffTs = Math.floor(Date.now() / 1000) - retentionDays * 86400;

  const [snapRes, logRes] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM metrics_snapshots WHERE captured_at < ?`).bind(cutoffTs),
    env.DB.prepare(`DELETE FROM refresh_log WHERE refreshed_at < ?`).bind(cutoffTs),
  ]);

  return {
    mode: "cleanup",
    cutoff_ts: cutoffTs,
    snapshots_deleted: snapRes.meta?.changes ?? 0,
    refresh_log_deleted: logRes.meta?.changes ?? 0,
    elapsed_ms: Date.now() - t0,
  };
}

// ─── fill-translations mode ────────────────────────────────────
// Fills missing translations on: items.content_translated,
// extra.quote_of.content_translated, extra.link_card.{title,description}_translated.
// Uses DeepSeek chat (OpenAI-compatible). SQL broadly selects candidates,
// then code filters to texts actually needing translation.

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";

const TRANSLATION_PROMPT_HEADER =
  "Translate each numbered tweet below from English to Chinese for an AI news feed.\n" +
  "Rules:\n" +
  "1. Keep proper nouns in English: person names, company names, product names, " +
  "model names (GPT-4, Claude, Gemini-cli, codex, Cursor, VS Code, etc.).\n" +
  "2. Keep these technical terms in English — do NOT translate even when used as verbs: " +
  "fork, branch, merge, rebase, commit, PR, repo, clone, push, pull, deploy, " +
  "pretrain, RLHF, prompt, embedding, RAG, LLM, API, SDK, CLI, IDE, CI/CD, OSS, MCP.\n" +
  "3. Chinese AI community conventions for these specific terms:\n" +
  "   - 'fine-tune' / 'fine-tuning' → '微调' (correct standard Chinese AI term)\n" +
  "   - 'agent' → '智能体' (NOT '代理', which means proxy/middleman in Chinese)\n" +
  "   - 'token' / 'tokens' → keep as 'token' or 'Token' (NEVER '令牌', which means OAuth token)\n" +
  "   - 'fork' as verb → 'fork' (NOT '分叉'): 'fork codex' → '去 fork codex'\n" +
  "   - 'PR' → 'PR' (NOT '拉取请求' or '合并请求')\n" +
  "4. Keep code, commands, file paths, URLs, and @handles verbatim.\n" +
  "5. Keep common English abbreviations: UI, UX, MVP, SaaS, B2B, OSS, etc.\n" +
  "6. Output natural colloquial Chinese (口语化), avoid stilted translations.\n" +
  "Reply ONLY with one line per tweet in the format  index:translated_text\n" +
  "No extra text.\n\n";

function cjkRatio(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let total = 0;
  for (const c of text) {
    if (/\s/.test(c)) continue;
    total++;
    const code = c.charCodeAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) cjk++;
  }
  return total === 0 ? 0 : cjk / total;
}

function isLikelyChinese(text: string): boolean {
  return !!text && cjkRatio(text) > 0.3;
}

/** Sanity check thresholds calibrated against 500-sample content translations
 *  (2026-04-20). p5 length_ratio=0.08; p25=0.31; p50=0.38. Threshold 0.15
 *  flags ~5% (below p5). CJK ratio <20% flags ~4.4%, >=99.9% flags ~4.2%. */
function sanityHit(original: string, translated: string): string | null {
  if (!translated || !original) return null;
  const ratio = translated.length / original.length;
  if (ratio < 0.15) return "too_short";
  if (ratio > 2.0) return "too_long";
  const cjk = cjkRatio(translated);
  if (cjk < 0.20) return "low_cjk";
  if (cjk >= 0.999) return "all_cjk";
  return null;
}

type TaskField =
  | "content"
  | "quote_of"
  | "link_card_title"
  | "link_card_desc";

interface TranslationTask {
  itemId: string;
  field: TaskField;
  text: string;
}

interface TranslationRow {
  id: string;
  source_id: string;
  content: string | null;
  lang: string | null;
  content_translated: string | null;
  extra: string | null;
}

async function selectTranslationCandidates(
  env: EnrichEnv,
  limit: number,
): Promise<TranslationRow[]> {
  const fetchBatch = Math.min(Math.max(limit * 3, 60), 300);
  // Use json_extract for precise matching. Previous LIKE-based match
  // swept up Chinese-quote tweets (extra has quote_of but content is zh),
  // which extractTasks then rejected via isLikelyChinese — wasting slots.
  //
  // ORDER BY RANDOM() spreads sampling across the ~760 candidates. DESC
  // biased to freshest tweets where zh-quote-zh dominates, producing 0 tasks
  // every cron slot. Random hits the ~5-10% English-quote gems in the tail.
  const rows = await env.DB.prepare(
    `SELECT id, source_id, content, lang, content_translated, extra
     FROM items
     WHERE source_type = 'x_list'
       AND is_relevant = 1
       AND (
         (content_translated IS NULL AND (lang IS NULL OR lang != 'zh') AND content IS NOT NULL)
         OR (
           json_extract(extra, '$.quote_of.content') IS NOT NULL
           AND json_extract(extra, '$.quote_of.content_translated') IS NULL
         )
         OR (
           json_extract(extra, '$.link_card.title') IS NOT NULL
           AND json_extract(extra, '$.link_card.title_translated') IS NULL
         )
         OR (
           json_extract(extra, '$.link_card.description') IS NOT NULL
           AND json_extract(extra, '$.link_card.description_translated') IS NULL
         )
       )
     ORDER BY RANDOM()
     LIMIT ?`,
  )
    .bind(fetchBatch)
    .all<TranslationRow>();
  return rows.results;
}

function extractTasks(row: TranslationRow): TranslationTask[] {
  const tasks: TranslationTask[] = [];
  // Main content
  if (
    row.content_translated === null &&
    row.lang !== "zh" &&
    row.content &&
    !isLikelyChinese(row.content)
  ) {
    tasks.push({ itemId: row.id, field: "content", text: row.content });
  }
  // Extra
  let extra: Record<string, unknown> = {};
  if (row.extra) {
    try {
      // Legacy rows can store the literal string "null" (from
      // JSON.stringify(undefined ?? null) at ingest); parse yields null,
      // not an object. Guard against that + arrays.
      const parsed = JSON.parse(row.extra);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        extra = parsed as Record<string, unknown>;
      }
    } catch {
      extra = {};
    }
  }
  const qo = extra.quote_of as Record<string, unknown> | null | undefined;
  if (qo && typeof qo === "object") {
    const qc = qo.content as string | null | undefined;
    const qt = qo.content_translated as string | null | undefined;
    if (qc && !qt && !isLikelyChinese(qc)) {
      tasks.push({ itemId: row.id, field: "quote_of", text: qc });
    }
  }
  const lc = extra.link_card as Record<string, unknown> | null | undefined;
  if (lc && typeof lc === "object") {
    const title = lc.title as string | null | undefined;
    const tTr = lc.title_translated as string | null | undefined;
    if (title && !tTr && !isLikelyChinese(title)) {
      tasks.push({ itemId: row.id, field: "link_card_title", text: title });
    }
    const desc = lc.description as string | null | undefined;
    const dTr = lc.description_translated as string | null | undefined;
    if (desc && !dTr && !isLikelyChinese(desc)) {
      tasks.push({ itemId: row.id, field: "link_card_desc", text: desc });
    }
  }
  return tasks;
}

async function callDeepSeek(
  apiKey: string,
  prompt: string,
  maxTokens: number,
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);
    const resp = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) {
      console.error(`DeepSeek HTTP ${resp.status}`);
      return null;
    }
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    return text || null;
  } catch (e) {
    const name = e instanceof Error ? e.name : "unknown";
    console.error(`DeepSeek call failed: ${name}`);
    return null;
  }
}

// Multi-paragraph tweets (e.g. note_tweet long-form) embed real \n inside the
// text. We can't use \n as a record separator in either prompt or response, so
// we replace it with a sentinel marker and ask the model to preserve it.
const NL_MARK = "⟪NL⟫";

async function translateBatch(
  apiKey: string,
  texts: string[],
): Promise<Map<number, string>> {
  const numbered = texts
    .map((t, i) => `${i}:${t.replace(/\r\n/g, "\n").replace(/\n/g, NL_MARK)}`)
    .join("\n");
  const prompt =
    TRANSLATION_PROMPT_HEADER +
    `Each tweet is one line in 'index:text' form. The marker ${NL_MARK} stands ` +
    `for a real line break inside the original text — preserve every ${NL_MARK} ` +
    `verbatim in your output (do NOT replace with actual newlines).\n\n` +
    numbered;
  const maxTokens = Math.max(
    texts.reduce((sum, t) => sum + Math.ceil(t.length / 2), 0),
    500,
  );
  const raw = await callDeepSeek(apiKey, prompt, maxTokens);
  const out = new Map<number, string>();
  if (!raw) return out;
  // Accumulate: each line beginning with `<digit>+:` starts a new entry; any
  // following lines without that prefix are appended (the model occasionally
  // emits a real \n despite instructions). Final \n→NL_MARK→\n round-trip
  // preserves intended paragraph breaks while ignoring stray ones.
  let curIdx: number | null = null;
  let curParts: string[] = [];
  const flush = (): void => {
    if (curIdx === null) return;
    const text = curParts.join("\n").replace(/⟪NL⟫/g, "\n").trim();
    if (text) out.set(curIdx, text);
    curIdx = null;
    curParts = [];
  };
  for (const rawLine of raw.split("\n")) {
    const m = /^(\d+)\s*:\s*(.*)$/.exec(rawLine);
    if (m) {
      flush();
      curIdx = parseInt(m[1], 10);
      curParts = [m[2]];
    } else if (curIdx !== null) {
      curParts.push(rawLine);
    }
  }
  flush();
  return out;
}

interface TranslationItemPatch {
  content_translated?: string;
  quote_content_translated?: string;
  link_title_translated?: string;
  link_desc_translated?: string;
  translation_quality?: string;
  translation_attempts?: number;
}

async function applyTranslationPatch(
  env: EnrichEnv,
  row: TranslationRow,
  patch: TranslationItemPatch,
): Promise<void> {
  let extra: Record<string, unknown> = {};
  if (row.extra) {
    try {
      // Legacy rows can store the literal string "null" (from
      // JSON.stringify(undefined ?? null) at ingest); parse yields null,
      // not an object. Guard against that + arrays.
      const parsed = JSON.parse(row.extra);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        extra = parsed as Record<string, unknown>;
      }
    } catch {
      extra = {};
    }
  }
  if (patch.quote_content_translated) {
    const qo = extra.quote_of as Record<string, unknown> | null | undefined;
    if (qo && typeof qo === "object") {
      qo.content_translated = patch.quote_content_translated;
    }
  }
  if (patch.link_title_translated || patch.link_desc_translated) {
    const lc = extra.link_card as Record<string, unknown> | null | undefined;
    if (lc && typeof lc === "object") {
      if (patch.link_title_translated) {
        lc.title_translated = patch.link_title_translated;
      }
      if (patch.link_desc_translated) {
        lc.description_translated = patch.link_desc_translated;
      }
    }
  }
  const updates: string[] = ["extra = ?"];
  const vals: unknown[] = [JSON.stringify(extra)];
  if (patch.content_translated) {
    updates.push("content_translated = ?");
    vals.push(patch.content_translated);
  }
  if (patch.translation_quality) {
    updates.push("translation_quality = ?");
    vals.push(patch.translation_quality);
  }
  if (patch.translation_attempts !== undefined) {
    updates.push("translation_attempts = ?");
    vals.push(patch.translation_attempts);
  }
  vals.push(row.id);
  await env.DB.prepare(
    `UPDATE items SET ${updates.join(", ")} WHERE id = ?`,
  )
    .bind(...vals)
    .run();
}

export interface TranslateResult {
  mode: string;
  candidates: number;
  tasks: number;
  translated: number;
  items_updated: number;
  api_calls: number;
  sanity_suspect: number;
  sanity_retried: number;
  sanity_remained_suspect: number;
  items_marked_ok: number;
  items_marked_suspect: number;
  elapsed_ms: number;
  skipped_no_key?: boolean;
}

export async function runFillTranslations(
  env: EnrichEnv,
  limit = 30,
  batchSize = 5,
): Promise<TranslateResult> {
  const mode = "fill-translations";
  const t0 = Date.now();
  const base: TranslateResult = {
    mode,
    candidates: 0,
    tasks: 0,
    translated: 0,
    items_updated: 0,
    api_calls: 0,
    sanity_suspect: 0,
    sanity_retried: 0,
    sanity_remained_suspect: 0,
    items_marked_ok: 0,
    items_marked_suspect: 0,
    elapsed_ms: 0,
  };
  if (!env.DEEPSEEK_API_KEY) {
    console.warn("fill-translations: DEEPSEEK_API_KEY missing, skipping");
    return { ...base, skipped_no_key: true, elapsed_ms: Date.now() - t0 };
  }

  const rows = await selectTranslationCandidates(env, limit);
  base.candidates = rows.length;
  const rowMap = new Map<string, TranslationRow>();
  const tasks: TranslationTask[] = [];
  for (const row of rows) {
    rowMap.set(row.id, row);
    const rowTasks = extractTasks(row);
    // Only take up to `limit` distinct items with tasks, to bound work.
    if (rowTasks.length === 0) continue;
    tasks.push(...rowTasks);
    if (rowMap.size >= limit && tasks.length >= limit) break;
  }
  base.tasks = tasks.length;
  if (tasks.length === 0) {
    return { ...base, elapsed_ms: Date.now() - t0 };
  }

  const translations = new Map<number, string>();
  for (let start = 0; start < tasks.length; start += batchSize) {
    const batch = tasks.slice(start, start + batchSize);
    base.api_calls++;
    const result = await translateBatch(
      env.DEEPSEEK_API_KEY,
      batch.map((t) => t.text),
    );
    for (let i = 0; i < batch.length; i++) {
      const tr = result.get(i);
      if (tr) {
        translations.set(start + i, tr);
        base.translated++;
      }
    }
  }

  // Sanity check: retry suspect translations once.
  const suspectIndices: number[] = [];
  for (const [idx, tr] of translations) {
    if (sanityHit(tasks[idx].text, tr)) suspectIndices.push(idx);
  }
  base.sanity_suspect = suspectIndices.length;

  if (suspectIndices.length > 0) {
    console.log(`sanity check: ${suspectIndices.length} suspect, retrying once`);
    for (let start = 0; start < suspectIndices.length; start += batchSize) {
      const idxBatch = suspectIndices.slice(start, start + batchSize);
      const retryBatch = idxBatch.map((i) => tasks[i]);
      base.api_calls++;
      base.sanity_retried += idxBatch.length;
      const result = await translateBatch(
        env.DEEPSEEK_API_KEY,
        retryBatch.map((t) => t.text),
      );
      for (let j = 0; j < idxBatch.length; j++) {
        const retryTr = result.get(j);
        if (retryTr) translations.set(idxBatch[j], retryTr);
      }
    }
  }

  // Group translations into patches + assess item-level quality.
  const patches = new Map<string, TranslationItemPatch>();
  const retriedItemIds = new Set<string>(
    suspectIndices.map((i) => tasks[i].itemId),
  );
  const suspectItemIds = new Set<string>();
  const itemsWithAnyTr = new Set<string>();

  for (let i = 0; i < tasks.length; i++) {
    const tr = translations.get(i);
    if (!tr) continue;
    const task = tasks[i];
    itemsWithAnyTr.add(task.itemId);
    const p = patches.get(task.itemId) || {};
    if (task.field === "content") p.content_translated = tr;
    else if (task.field === "quote_of") p.quote_content_translated = tr;
    else if (task.field === "link_card_title") p.link_title_translated = tr;
    else if (task.field === "link_card_desc") p.link_desc_translated = tr;
    patches.set(task.itemId, p);
    if (sanityHit(task.text, tr)) suspectItemIds.add(task.itemId);
  }
  base.sanity_remained_suspect = 0;
  for (const i of suspectIndices) {
    const tr = translations.get(i);
    if (tr && sanityHit(tasks[i].text, tr)) base.sanity_remained_suspect++;
  }

  for (const itemId of itemsWithAnyTr) {
    const p = patches.get(itemId);
    if (!p) continue;
    const suspect = suspectItemIds.has(itemId);
    p.translation_quality = suspect ? "suspect" : "ok";
    p.translation_attempts = retriedItemIds.has(itemId) ? 2 : 1;
    if (suspect) base.items_marked_suspect++;
    else base.items_marked_ok++;
  }

  for (const [itemId, patch] of patches) {
    const row = rowMap.get(itemId);
    if (!row) continue;
    await applyTranslationPatch(env, row, patch);
    base.items_updated++;
  }

  return { ...base, elapsed_ms: Date.now() - t0 };
}

// ─── Long-form (X Premium note_tweet) detection + serve ────────
// X Premium users can post tweets up to 25k chars. The DOM and the public
// syndication API both surface only the 280-char teaser; the full body sits
// behind a NoteTweetResults entity that's reachable only via the auth'd
// GraphQL API. So we split the work:
//
//   1. Detection (here, on Worker): heuristic-pick suspect items
//      (length 270-290, mid-word ending), call syndication, look for
//      `note_tweet.id`. Mark detection result on items.extra.longform.
//   2. Browser fetch (local Mac script): poll /api/longform/pending,
//      open x.com/{handle}/status/{id} with cookies, scrape full text,
//      POST back via /api/longform/submit.
//
// extra.longform shape:
//   {
//     detected_at: ISO,
//     note_id?: string,        // present iff X says it's a long-form tweet
//     fetched_at?: ISO,        // set by /submit on success
//     fetch_error?: string,    // set by /submit on failure
//     fetch_attempts?: number, // for retry budget
//   }

interface LongformDetection {
  detected_at: string;
  note_id?: string;
  fetched_at?: string;
  fetch_error?: string;
  fetch_attempts?: number;
}

const SENTENCE_END_CHARS = new Set([
  '.', '!', '?', '。', '！', '？',
  '"', '”', "'", '’',
  ')', ']', '}', '~',
  ' ', '\n', '\t',
]);

function noteIdFromTweet(data: Record<string, unknown>): string | null {
  const nt = data.note_tweet as Record<string, unknown> | undefined;
  if (!nt) return null;
  const id = nt.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function readLongform(extra: string | null): LongformDetection | null {
  if (!extra) return null;
  try {
    const parsed = JSON.parse(extra) as Record<string, unknown>;
    const lf = parsed.longform as Record<string, unknown> | undefined;
    if (!lf) return null;
    return lf as unknown as LongformDetection;
  } catch {
    return null;
  }
}

async function writeLongform(
  env: EnrichEnv,
  itemId: string,
  rowExtra: string | null,
  detection: LongformDetection,
): Promise<void> {
  let extra: Record<string, unknown> = {};
  if (rowExtra) {
    try { extra = JSON.parse(rowExtra); } catch { extra = {}; }
  }
  extra.longform = detection;
  await env.DB.prepare("UPDATE items SET extra = ? WHERE id = ?")
    .bind(JSON.stringify(extra), itemId)
    .run();
}

interface DetectCandidateRow {
  id: string;
  source_id: string;
  content: string;
  extra: string | null;
}

/** Pick suspect-truncated items: length around 280 chars, ending mid-word,
 *  with no longform marker yet. Filter is index-friendly via length() on
 *  content; the 'NOT LIKE' clause is acceptable because the suspect bucket is
 *  small (<5k items) and runs once historical seed completes. */
async function selectLongformCandidates(
  env: EnrichEnv,
  limit: number,
): Promise<DetectCandidateRow[]> {
  const rows = await env.DB.prepare(
    `SELECT id, source_id, content, extra
     FROM items
     WHERE source_type = 'x_list'
       AND length(content) BETWEEN 270 AND 290
       AND (extra IS NULL OR extra NOT LIKE '%"longform"%')
     ORDER BY scraped_at DESC
     LIMIT ?`,
  )
    .bind(Math.min(Math.max(limit * 3, 60), 600))
    .all<DetectCandidateRow>();

  const out: DetectCandidateRow[] = [];
  for (const r of rows.results) {
    const last = r.content.charAt(r.content.length - 1);
    if (SENTENCE_END_CHARS.has(last)) continue;
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

export interface LongformDetectResult {
  mode: string;
  scanned: number;
  with_note: number;
  no_note: number;
  not_found: number;
  failed: number;
  elapsed_ms: number;
  remaining_hint?: number;
}

export async function runDetectLongform(
  env: EnrichEnv,
  limit = 30,
  rateSleepMs = 400,
): Promise<LongformDetectResult> {
  const mode = "detect-longform";
  const t0 = Date.now();
  const candidates = await selectLongformCandidates(env, limit);
  const counts = {
    scanned: 0,
    with_note: 0,
    no_note: 0,
    not_found: 0,
    failed: 0,
  };
  const nowIso = (): string => new Date().toISOString();

  for (const row of candidates) {
    const tid = row.source_id;
    const res = await fetchTweet(tid);
    if (res === null) {
      counts.failed++;
    } else if (res.notFound) {
      // Tweet deleted or private — record as checked (no note) so we don't
      // re-scan; the local fetcher won't pick it up because note_id is unset.
      await writeLongform(env, row.id, row.extra, {
        detected_at: nowIso(),
        fetch_error: "syndication_404",
      });
      counts.not_found++;
      counts.scanned++;
    } else if (res.data) {
      const noteId = noteIdFromTweet(res.data);
      const det: LongformDetection = { detected_at: nowIso() };
      if (noteId) {
        det.note_id = noteId;
        counts.with_note++;
      } else {
        counts.no_note++;
      }
      await writeLongform(env, row.id, row.extra, det);
      counts.scanned++;
    }
    if (rateSleepMs > 0) await sleep(rateSleepMs);
  }

  return {
    mode,
    scanned: counts.scanned,
    with_note: counts.with_note,
    no_note: counts.no_note,
    not_found: counts.not_found,
    failed: counts.failed,
    elapsed_ms: Date.now() - t0,
    remaining_hint: Math.max(0, candidates.length - counts.scanned),
  };
}

// ─── Pending list + submit (paired with local browser fetcher) ─

export interface PendingLongformItem {
  id: string;
  source_id: string;
  handle: string;
  url: string;
  content_len: number;
  note_id: string;
  attempts: number;
}

export async function listPendingLongform(
  env: EnrichEnv,
  limit = 20,
  maxAttempts = 3,
): Promise<PendingLongformItem[]> {
  // SQL pre-filter narrows by JSON markers; in-app validate to avoid
  // false positives from string-matching on unrelated fields.
  const rows = await env.DB.prepare(
    `SELECT id, source_id, handle, url, content, extra
     FROM items
     WHERE extra LIKE '%"note_id"%'
       AND extra NOT LIKE '%"fetched_at"%'
     ORDER BY scraped_at DESC
     LIMIT ?`,
  )
    .bind(Math.min(Math.max(limit * 2, 20), 200))
    .all<{
      id: string;
      source_id: string;
      handle: string;
      url: string;
      content: string;
      extra: string | null;
    }>();

  const out: PendingLongformItem[] = [];
  for (const r of rows.results) {
    const lf = readLongform(r.extra);
    if (!lf || !lf.note_id) continue;
    if (lf.fetched_at) continue;
    const attempts = lf.fetch_attempts ?? 0;
    if (attempts >= maxAttempts) continue;
    out.push({
      id: r.id,
      source_id: r.source_id,
      handle: r.handle,
      url: r.url,
      content_len: r.content.length,
      note_id: lf.note_id,
      attempts,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export interface SubmitResult {
  updated: boolean;
  reason?: string;
  new_len?: number;
  prev_len?: number;
  translated?: boolean;
}

export async function submitLongformText(
  env: EnrichEnv,
  itemId: string,
  fullText: string | null,
  fetchError?: string,
): Promise<SubmitResult> {
  const row = await env.DB.prepare(
    "SELECT id, content, extra FROM items WHERE id = ?",
  )
    .bind(itemId)
    .first<{ id: string; content: string; extra: string | null }>();
  if (!row) return { updated: false, reason: "item_not_found" };

  let extra: Record<string, unknown> = {};
  if (row.extra) {
    try { extra = JSON.parse(row.extra); } catch { extra = {}; }
  }
  const lf = (extra.longform as LongformDetection | undefined) ?? {
    detected_at: new Date().toISOString(),
  };
  lf.fetch_attempts = (lf.fetch_attempts ?? 0) + 1;

  const trimmed = (fullText ?? "").trim();
  if (!trimmed || fetchError) {
    lf.fetch_error = fetchError || "empty_text";
    extra.longform = lf;
    await env.DB.prepare("UPDATE items SET extra = ? WHERE id = ?")
      .bind(JSON.stringify(extra), itemId)
      .run();
    return {
      updated: false,
      reason: lf.fetch_error,
      prev_len: row.content.length,
    };
  }

  // Sanity: only accept text that's longer than what we have. Otherwise the
  // browser likely captured a teaser-equivalent or something went wrong.
  if (trimmed.length <= row.content.length) {
    lf.fetch_error = "not_longer";
    extra.longform = lf;
    await env.DB.prepare("UPDATE items SET extra = ? WHERE id = ?")
      .bind(JSON.stringify(extra), itemId)
      .run();
    return {
      updated: false,
      reason: "not_longer",
      prev_len: row.content.length,
      new_len: trimmed.length,
    };
  }

  lf.fetched_at = new Date().toISOString();
  delete lf.fetch_error;
  extra.longform = lf;

  await env.DB.prepare(
    `UPDATE items
       SET content = ?,
           content_translated = NULL,
           translation_quality = NULL,
           translation_attempts = 0,
           extra = ?
     WHERE id = ?`,
  )
    .bind(trimmed, JSON.stringify(extra), itemId)
    .run();

  // Translate inline. Without this the item would sit with content_translated
  // = NULL and rely on the random-sampled fill-translations cron to catch it,
  // which can take hours. Coupling submit→translate makes "longform fetched
  // but not translated" structurally impossible. Failure here is non-fatal —
  // the cron will pick it up via normal flow.
  const translated = await translateLongformContent(env, trimmed);
  if (translated) {
    await env.DB.prepare(
      `UPDATE items
         SET content_translated = ?,
             translation_quality = ?,
             translation_attempts = 1
       WHERE id = ?`,
    )
      .bind(translated.text, translated.quality, itemId)
      .run();
  }

  return {
    updated: true,
    prev_len: row.content.length,
    new_len: trimmed.length,
    translated: !!translated,
  };
}

async function translateLongformContent(
  env: EnrichEnv,
  text: string,
): Promise<{ text: string; quality: "ok" | "suspect" } | null> {
  if (!env.DEEPSEEK_API_KEY) return null;
  try {
    const result = await translateBatch(env.DEEPSEEK_API_KEY, [text]);
    const tr = result.get(0);
    if (!tr) return null;
    const quality = sanityHit(text, tr) ? "suspect" : "ok";
    return { text: tr, quality };
  } catch (e) {
    console.warn(
      "[longform-submit] inline translation failed:",
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}
