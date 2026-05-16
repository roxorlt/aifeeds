// Enrich module: pull missing quote_of / link_card / metrics for items in D1
// by calling cdn.syndication.twimg.com (same API react-tweet uses).
// Replaces the local Python enrich_from_syndication.py for cloud-side runs.

import { fetchTweetsScrapeBadger, fetchListTweetsPage, sbTweetToIngestItem } from './scrapebadger';

export interface EnrichEnv {
  DB: D1Database;
  DEEPSEEK_API_KEY?: string;
  // 可选：配置后 refresh-metrics 优先走 ScrapeBadger 批量（覆盖 syndication
  // 不返 retweet_count/view_count 的死角），失败/未命中再回落到 syndication。
  SCRAPEBADGER_API_KEY?: string;
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
// 四源策略：
//   - x_list：syndication API 拉 metrics + quote_of + link_card（1-3s）
//   - github：GitHub REST API 拉 stars/forks/watchers/issues/PRs/contributors（<1s）
//   - clawhub：Convex skills:getBySlug 拉 stars/downloads/installs/comments（<1s）
//   - product_hunt：PH GraphQL by-slug 拉 votes/comments/reviews/makers/comments（1-2s）
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
  env: EnrichEnv & {
    AUTH_KV?: KVNamespace;
    GITHUB_TOKEN?: string;
    PH_CLIENT_ID?: string;
    PH_CLIENT_SECRET?: string;
  },
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

  // 3. 按 source_type 分发
  if (item.source_type === 'x_list') {
    // 优先走 SB 拿全量 metrics（含 retweets/views）；没配 key 时回落 syndication
    let merged: Metrics;
    if (env.SCRAPEBADGER_API_KEY) {
      const sb = await fetchTweetsScrapeBadger(env, [item.source_id]);
      const m = sb.metrics.get(item.source_id);
      if (!m || sb.error) {
        return { refreshed: false, source_type: 'x_list', reason: 'fetch_failed' };
      }
      // SB 已经返 5 个字段全套，但仍 merge 旧值兜底（极少数情况下 SB 漏字段）
      const oldRow = await env.DB.prepare(
        `SELECT metrics FROM items WHERE id = ?`,
      ).bind(item.id).first<{ metrics: string | null }>();
      let oldMetrics: Record<string, number | undefined> = {};
      if (oldRow?.metrics) {
        try { oldMetrics = JSON.parse(oldRow.metrics) || {}; } catch { /* ignore */ }
      }
      merged = { ...oldMetrics, ...prunedNonUndefined(m as unknown as Record<string, unknown>) } as Metrics;
    } else {
      // Fallback：syndication（已不返 retweet_count/view_count）
      const r = await fetchTweet(item.source_id);
      if (!r || r.notFound || !r.data) {
        return { refreshed: false, source_type: 'x_list', reason: 'fetch_failed' };
      }
      const newPart = apiToMetrics(r.data);
      const oldRow = await env.DB.prepare(
        `SELECT metrics FROM items WHERE id = ?`,
      ).bind(item.id).first<{ metrics: string | null }>();
      let oldMetrics: Record<string, number | undefined> = {};
      if (oldRow?.metrics) {
        try { oldMetrics = JSON.parse(oldRow.metrics) || {}; } catch { /* ignore */ }
      }
      merged = { ...oldMetrics, ...prunedNonUndefined(newPart as unknown as Record<string, unknown>) } as Metrics;
    }
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

  if (item.source_type === 'clawhub') {
    const extraRow = await env.DB.prepare(
      `SELECT extra FROM items WHERE id = ?`,
    ).bind(item.id).first<{ extra: string | null }>();
    const { refreshClawhubItem } = await import('./clawhub');
    const r = await refreshClawhubItem(env, {
      id: item.id,
      source_id: item.source_id,
      extra: extraRow?.extra ?? null,
    });
    // 把 clawhub 自己的 reason 映射到 SingleItemRefreshResult 的窄类型 union
    if (!r.refreshed) {
      const reason: SingleItemRefreshResult['reason'] = r.reason === 'not_found'
        ? 'item_not_found'
        : 'fetch_failed';
      return { refreshed: false, source_type: 'clawhub', reason };
    }
    if (env.AUTH_KV) {
      await env.AUTH_KV.put(REFRESH_THROTTLE_KEY_PREFIX + itemId, String(Date.now()), {
        expirationTtl: REFRESH_THROTTLE_TTL,
      });
    }
    return { refreshed: true, source_type: 'clawhub', reason: 'success', metrics: r.metrics };
  }

  if (item.source_type === 'product_hunt') {
    // refreshPhItem 必须有 AUTH_KV（getPhAccessToken 用 KV 缓存 token）
    if (!env.AUTH_KV) {
      return { refreshed: false, source_type: 'product_hunt', reason: 'fetch_failed' };
    }
    const { refreshPhItem } = await import('./scrapers/ph');
    const r = await refreshPhItem(
      {
        DB: env.DB,
        AUTH_KV: env.AUTH_KV,
        PH_CLIENT_ID: env.PH_CLIENT_ID,
        PH_CLIENT_SECRET: env.PH_CLIENT_SECRET,
      },
      item.id,
      item.source_id,
    );
    if (!r.refreshed) {
      const reason: SingleItemRefreshResult['reason'] = r.reason === 'not_found'
        ? 'item_not_found'
        : 'fetch_failed';
      return { refreshed: false, source_type: 'product_hunt', reason };
    }
    await env.AUTH_KV.put(REFRESH_THROTTLE_KEY_PREFIX + itemId, String(Date.now()), {
      expirationTtl: REFRESH_THROTTLE_TTL,
    });
    return { refreshed: true, source_type: 'product_hunt', reason: 'success', metrics: r.metrics };
  }

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
  recover = false,
): Promise<CandidateRow[]> {
  const fetchBatch = Math.min(Math.max(limit * 2, 100), 1000);
  // recover=true: 选 "quote_of_id 有但 quote_of 没" 的 row（被 list-poll
  // UPSERT 洗过 quote_of 但 quote_of_id 仍在）。绕开 enriched_at sentinel —
  // 那些 row 之前 backfill 跑过留 enriched_at，被洗后老 SQL 不再选回。
  // 默认 recover=false：选未跑过 backfill 的 row（首次回填）。
  const sql = recover
    ? `SELECT id, source_id, extra
       FROM items
       WHERE source_type = 'x_list'
         AND deleted_at IS NULL
         AND extra ->> '$.quote_of_id' IS NOT NULL
         AND extra ->> '$.quote_of' IS NULL
       ORDER BY scraped_at DESC
       LIMIT ?`
    : `SELECT id, source_id, extra
       FROM items
       WHERE source_type = 'x_list'
         AND is_relevant = 1
         AND (extra IS NULL
              OR (extra NOT LIKE '%"enriched_at"%'
                  AND extra NOT LIKE '%"quote_of"%'
                  AND extra NOT LIKE '%"link_card"%'))
       ORDER BY scraped_at DESC
       LIMIT ?`;
  const rows = await env.DB.prepare(sql).bind(fetchBatch).all<CandidateRow>();

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
  // F1: retweet 父推完整快照（被转推作者头像/名字/handle/✓/published_at/content）
  // SB API 给的是 retweeted_status_id (extra.retweeted_status_id)，
  // 内容需要通过 syndication API on-demand 拉。retweet_of 是回填字段，
  // 跟 quote_of 共用 QuoteOf 形状，前端识别 is_retweet=1 时优先用它当主卡。
  retweet_of?: QuoteOf | null;
  retweet_enriched?: boolean;
  // F5: 反向 — set extra.thread_root_id 为 reply chain root（同作者 self-reply
  // 链）。配合 clearThreadRoot：set_thread_root_id 设值；clearThreadRoot 删字段。
  // 同时存在时 set_thread_root_id 胜出（先 clear 再 set 等价直接 set）。
  set_thread_root_id?: string;
}

/** Apply patch to an item: merge into extra JSON + update metrics column. */
export async function applyPatch(
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
  if (patch.retweet_of !== undefined) extra.retweet_of = patch.retweet_of;
  if (patch.retweet_enriched) {
    extra.retweet_enriched_at = new Date().toISOString();
  }
  if (patch.set_thread_root_id) extra.thread_root_id = patch.set_thread_root_id;
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
  recover = false,
): Promise<RunResult> {
  const mode = "backfill-quotes";
  const t0 = Date.now();
  // recover=true 时不读 state KV（绕开 sentinel），不写 processed_ids
  const state: EnrichState = recover
    ? { processed_ids: [], not_found_ids: [], failed_ids: [], started_at: new Date().toISOString(), last_update: null }
    : await loadState(env, mode);
  const done = new Set<string>(recover ? [] : [
    ...state.processed_ids,
    ...state.not_found_ids,
  ]);

  const candidates = await selectBackfillCandidates(env, done, limit, recover);
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

    // Save state every 25 items to survive cron timeout (recover 模式不写 state)
    if (!recover && counts.processed % 25 === 0 && counts.processed > 0) {
      await saveState(env, mode, state);
    }
  }

  if (!recover) await saveState(env, mode, state);

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

// ─── backfill-retweets mode ────────────────────────────────────
// F1: 抓 is_retweet=1 推的被转推者完整快照（头像/名字/handle/✓/内容）。
// SB API 不返回被转推的 user 对象，只给 retweeted_status_id。需要拿这个
// id 去 syndication API 拉原推。
//
// 跟 backfill-quotes 关键区别：candidates 里的 tid 是转推者的 status id，
// 但 fetchTweet 用的是 retweeted_status_id（即被转推那条），把那条的 user/
// content 当 retweet_of 快照写回到转推者 item 上。

interface RetweetCandidate extends CandidateRow {
  retweeted_status_id: string;
}

async function selectRetweetBackfillCandidates(
  env: EnrichEnv,
  done: Set<string>,
  limit: number,
  recover = false,
): Promise<RetweetCandidate[]> {
  const fetchBatch = Math.min(Math.max(limit * 2, 100), 1000);
  // recover=true 时只看 is_retweet + retweet_of IS NULL（去掉 retweet_enriched_at
  // 哨兵），覆盖被 list-poll 洗过的 row。
  const conditions = recover
    ? `json_extract(extra, '$.is_retweet') = 1
       AND json_extract(extra, '$.retweeted_status_id') IS NOT NULL
       AND extra ->> '$.retweet_of' IS NULL`
    : `json_extract(extra, '$.is_retweet') = 1
       AND json_extract(extra, '$.retweeted_status_id') IS NOT NULL
       AND (extra NOT LIKE '%"retweet_enriched_at"%' AND extra NOT LIKE '%"retweet_of"%')`;
  const rows = await env.DB.prepare(
    `SELECT id, source_id, extra FROM items
     WHERE source_type = 'x_list' AND ${conditions}
     ORDER BY scraped_at DESC LIMIT ?`,
  )
    .bind(fetchBatch)
    .all<CandidateRow>();

  const out: RetweetCandidate[] = [];
  for (const r of rows.results) {
    if (done.has(r.source_id)) continue;
    let rtsId: string | null = null;
    try {
      const ex = JSON.parse(r.extra || '{}') as Record<string, unknown>;
      if (typeof ex.retweeted_status_id === 'string') {
        rtsId = ex.retweeted_status_id;
      }
    } catch {
      // skip 解析失败的
    }
    if (!rtsId) continue;
    out.push({ ...r, retweeted_status_id: rtsId });
    if (out.length >= limit) break;
  }
  return out;
}

export async function runBackfillRetweets(
  env: EnrichEnv,
  limit = 20,
  rateSleepMs = 400,
  recover = false,
): Promise<RunResult> {
  const mode = 'backfill-retweets';
  const t0 = Date.now();
  const state: EnrichState = recover
    ? { processed_ids: [], not_found_ids: [], failed_ids: [], started_at: new Date().toISOString(), last_update: null }
    : await loadState(env, mode);
  const done = new Set<string>(recover ? [] : [
    ...state.processed_ids,
    ...state.not_found_ids,
  ]);

  const candidates = await selectRetweetBackfillCandidates(env, done, limit, recover);
  const counts = {
    processed: 0,
    with_retweet: 0,
    not_found: 0,
    failed: 0,
  };

  for (const row of candidates) {
    // 注意：fetchTweet 用 retweeted_status_id（被转推那条），不是 row.source_id
    const targetId = row.retweeted_status_id;
    const res = await fetchTweet(targetId);
    if (res === null) {
      state.failed_ids.push(row.source_id);
      counts.failed++;
    } else if (res.notFound) {
      // 原推被删 / 账号被封 / 私密 → 记 not_found 标记 sentinel 避免反复重试
      state.not_found_ids.push(row.source_id);
      counts.not_found++;
      try {
        await applyPatch(env, row, { retweet_enriched: true, retweet_of: null });
        state.processed_ids.push(row.source_id);
        counts.processed++;
      } catch (e) {
        console.error(`[backfill-retweets] applyPatch (notFound sentinel) failed for ${row.source_id}:`, e);
      }
    } else if (res.data) {
      const patch: Patch = {
        retweet_enriched: true,
        retweet_of: apiToQuoteOf(res.data as unknown as Record<string, unknown>),
      };
      counts.with_retweet++;
      try {
        await applyPatch(env, row, patch);
        state.processed_ids.push(row.source_id);
        counts.processed++;
      } catch (e) {
        console.error(`[backfill-retweets] applyPatch failed for ${row.source_id}:`, e);
        state.failed_ids.push(row.source_id);
        counts.failed++;
      }
    }

    if (rateSleepMs > 0) await sleep(rateSleepMs);

    if (!recover && counts.processed % 25 === 0 && counts.processed > 0) {
      await saveState(env, mode, state);
    }
  }

  if (!recover) await saveState(env, mode, state);

  return {
    mode,
    processed: counts.processed,
    with_quote: counts.with_retweet, // 复用 RunResult 字段：with_quote → with_retweet
    with_card: 0,
    empty: 0,
    not_found: counts.not_found,
    failed: counts.failed,
    elapsed_ms: Date.now() - t0,
    remaining_hint: Math.max(0, candidates.length - counts.processed),
  };
}

// ─── reconstruct-threads mode ──────────────────────────────────
// F5: 反向于 reclassify-threads（清错的 thread root）。这个 mode 给那些
// 自回复 chain (handle == reply_to_handle) 但 thread_root_id 为 null 的
// items 反向设上 thread_root_id。
//
// 触发场景：当前 SB scraper 抓取根本不写 extra.thread_root_id（只有老
// chrome scraper 时代写过）。1043 条复合关系数据（含 quote_of_id +
// reply_to_id + thread_root_id null）由这个 mode 一次性回填。
//
// 算法：multi-pass 扫描。每 pass 处理所有 candidate（reply_to_id IS NOT
// NULL AND thread_root_id IS NULL），查父推：
//   - 父推不存在 D1 / handle 不同 → 不是 self-thread，skip（不动）
//   - 父推存在 + handle 相同：
//       * 父推 thread_root_id 已经有 → 设当前 = 父推 root（chain 延长）
//       * 父推 thread_root_id 空但父推也是 self-reply → 等下一 pass
//       * 父推 thread_root_id 空且父推无 reply_to_id（=chain root）→
//         设当前 thread_root_id = 父推 source_id
// 迭代直到一 pass 没新填，或达 max_passes（默认 5，覆盖普通 thread 链长）。

interface ReconstructResult {
  mode: 'reconstruct-threads';
  candidates_total: number;
  filled: number;
  not_self_reply: number;
  parent_missing: number;
  passes: number;
  dry_run: boolean;
  elapsed_ms: number;
}

interface ThreadCandidateRow {
  id: string;
  source_id: string;
  handle: string | null;
  extra: string | null;
}

export async function runReconstructThreads(
  env: EnrichEnv,
  dryRun = true,
  maxPasses = 5,
): Promise<ReconstructResult> {
  const t0 = Date.now();
  // 拉所有 candidate：reply_to_id 有 + thread_root_id 空
  const cands = await env.DB.prepare(
    `SELECT id, source_id, handle, extra
     FROM items
     WHERE source_type = 'x_list'
       AND extra ->> '$.reply_to_id' IS NOT NULL
       AND extra ->> '$.thread_root_id' IS NULL`,
  ).all<ThreadCandidateRow>();

  const candTotal = cands.results.length;

  // 拿这些 candidate reply_to_id 指向的父推一次性查回来（lookup map）
  const parentIds = new Set<string>();
  const candParsed: Array<{ row: ThreadCandidateRow; extra: Record<string, unknown>; replyToId: string }> = [];
  for (const r of cands.results) {
    try {
      const ex = JSON.parse(r.extra || '{}') as Record<string, unknown>;
      const replyToId = ex.reply_to_id as string | undefined;
      if (!replyToId) continue;
      parentIds.add(replyToId);
      candParsed.push({ row: r, extra: ex, replyToId });
    } catch {
      // skip 解析失败
    }
  }

  // 父推 lookup map：source_id → { handle, thread_root_id, has_reply_to_id, exists }
  // 分批查（D1 IN list 长度限制）。exists=false 表示父推不在 D1（可能在 list 外
  // 或被删），fallback 用 candidate.extra.reply_to_handle 判定是否 self-reply。
  const parentMap = new Map<string, { handle: string | null; threadRoot: string | null; hasReplyTo: boolean; exists: boolean }>();
  const parentArr = [...parentIds];
  const CHUNK = 100;
  for (let i = 0; i < parentArr.length; i += CHUNK) {
    const chunk = parentArr.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await env.DB.prepare(
      `SELECT source_id, handle, extra FROM items WHERE source_type='x_list' AND source_id IN (${placeholders})`,
    ).bind(...chunk).all<{ source_id: string; handle: string | null; extra: string | null }>();
    for (const r of rows.results) {
      try {
        const ex = JSON.parse(r.extra || '{}') as Record<string, unknown>;
        parentMap.set(r.source_id, {
          handle: r.handle,
          threadRoot: (ex.thread_root_id as string | undefined) ?? null,
          hasReplyTo: Boolean(ex.reply_to_id),
          exists: true,
        });
      } catch {
        parentMap.set(r.source_id, { handle: r.handle, threadRoot: null, hasReplyTo: false, exists: true });
      }
    }
  }

  let filled = 0;
  let notSelfReply = 0;
  let parentMissing = 0;
  const updates: Array<{ id: string; rootId: string }> = [];

  // Multi-pass：未填的 candidate 等父推 thread_root 填好后下一 pass 再尝试
  const resolved = new Set<string>(); // candidate source_id 已 resolve（filled 或 skip）

  let pass = 0;
  for (pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    for (const c of candParsed) {
      if (resolved.has(c.row.source_id)) continue;
      const parent = parentMap.get(c.replyToId);
      // 父推不在 D1 时，看 extra.reply_to_handle / reply_to_screen_name
      // 是否等于自己 handle（self-reply 判定不依赖父推数据）
      const replyToHandle = (c.extra.reply_to_handle || c.extra.reply_to_screen_name) as string | undefined;
      if (!parent || !parent.exists) {
        if (replyToHandle && c.row.handle && replyToHandle === c.row.handle) {
          // self-reply 但父推不在 D1（list 外 / 被删 / 私密）→ 用 replyToId
          // 当虚拟 root（链断在这）
          updates.push({ id: c.row.id, rootId: c.replyToId });
          resolved.add(c.row.source_id);
          parentMap.set(c.row.source_id, {
            handle: c.row.handle,
            threadRoot: c.replyToId,
            hasReplyTo: true,
            exists: true,
          });
          filled++;
          changed = true;
        } else {
          // 父推不在 D1 + reply_to_handle 不一致（或缺失）→ 真的判不了
          resolved.add(c.row.source_id);
          parentMissing++;
        }
        continue;
      }
      if (parent.handle !== c.row.handle) {
        resolved.add(c.row.source_id);
        notSelfReply++;
        continue;
      }
      // self-reply + 父推在 D1。决定 thread_root：
      let rootId: string | null = null;
      if (parent.threadRoot) {
        rootId = parent.threadRoot;
      } else if (!parent.hasReplyTo) {
        // 父推自己是 chain 根
        rootId = c.replyToId;
      } else {
        // 父推也是 self-reply 但还没填 root → 等下一 pass
        continue;
      }
      updates.push({ id: c.row.id, rootId });
      resolved.add(c.row.source_id);
      parentMap.set(c.row.source_id, {
        handle: c.row.handle,
        threadRoot: rootId,
        hasReplyTo: true,
        exists: true,
      });
      filled++;
      changed = true;
    }
    if (!changed) break;
  }

  if (!dryRun && updates.length > 0) {
    // batch update — D1 不支持单条 prepared 多 binding 高效 batch，逐条 UPDATE
    // 但用 batch API 走一个 transaction 减少 RTT
    const stmts: D1PreparedStatement[] = [];
    for (const u of updates) {
      stmts.push(
        env.DB.prepare(
          `UPDATE items SET extra = json_set(coalesce(extra, '{}'), '$.thread_root_id', ?) WHERE id = ?`,
        ).bind(u.rootId, u.id),
      );
    }
    const BATCH_SIZE = 50;
    for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
      await env.DB.batch(stmts.slice(i, i + BATCH_SIZE));
    }
  }

  return {
    mode: 'reconstruct-threads',
    candidates_total: candTotal,
    filled,
    not_self_reply: notSelfReply,
    parent_missing: parentMissing,
    passes: pass,
    dry_run: dryRun,
    elapsed_ms: Date.now() - t0,
  };
}

// ─── dedupe-quote-content mode ─────────────────────────────────
// D2: 老 chrome scraper (matched_by=keyword/null) 抓 X 网页 DOM 时没排除
// nested quoted preview 的 tweetText，把被引用推内容也包进主推 content。
// 这条扫所有 row，识别 main.content == extra.quote_of.content 完全相同的
// （脏数据），把原 content 备份到 extra.original_content（避免覆盖已备份）
// + 把 main.content 改为空（前端会渲染嵌套小卡作为正文上下文）。
//
// 安全：dry_run 默认 + 备份用 extra.original_content 单条可逆。
// 还原命令: UPDATE items SET content = extra->>'$.original_content',
//   extra = json_remove(extra, '$.original_content')
//   WHERE extra->>'$.original_content' IS NOT NULL

export interface DedupeResult {
  mode: 'dedupe-quote-content';
  candidates_total: number;
  updated: number;
  skipped_already_backed_up: number;
  dry_run: boolean;
  elapsed_ms: number;
}

export async function runDedupeQuoteContent(
  env: EnrichEnv,
  dryRun = true,
  limit = 500,
): Promise<DedupeResult> {
  const t0 = Date.now();
  // D5 v2: 同时识别两种脏数据 case：
  // Case A (新)：content 跟 quote_of.content 前 100 字符相同 + 长度差<50
  //   → 备份 content + content_translated 都到 extra → 清空两者
  // Case B (已 dedupe v1 跑过但漏清 translated)：content='' + extra.original_content
  //   有 + content_translated 还在 + 未备份 translated
  //   → 仅备份 + 清 translated
  // 两种 case 都用 OR 选回，更新逻辑 SQL 端用 json_set 智能处理（coalesce 保留
  // 已有备份，不二次覆盖）。
  const rows = await env.DB.prepare(
    `SELECT id, content, content_translated
     FROM items
     WHERE source_type = 'x_list'
       AND deleted_at IS NULL
       AND (
         -- Case A: 新发现的脏 row
         (length(content) > 80
          AND content IS NOT NULL
          AND json_extract(extra, '$.quote_of.content') IS NOT NULL
          AND substr(content, 1, 100) = substr(json_extract(extra, '$.quote_of.content'), 1, 100)
          AND abs(length(content) - length(json_extract(extra, '$.quote_of.content'))) < 50
          AND json_extract(extra, '$.original_content') IS NULL)
         OR
         -- Case B: 之前 dedupe v1 已处理 content 但 content_translated 漏清
         (content = ''
          AND json_extract(extra, '$.original_content') IS NOT NULL
          AND content_translated IS NOT NULL
          AND content_translated != ''
          AND json_extract(extra, '$.original_content_translated') IS NULL)
       )
     LIMIT ?`,
  ).bind(limit).all<{ id: string; content: string; content_translated: string | null }>();

  const candidates = rows.results;
  let updated = 0;

  if (!dryRun && candidates.length > 0) {
    const stmts: D1PreparedStatement[] = [];
    for (const r of candidates) {
      // 用 json_set 双层嵌套：第一层备份 original_content（保留已有），第二层
      // 备份 original_content_translated（保留已有）。SQL 端 coalesce 防覆盖。
      stmts.push(
        env.DB.prepare(
          `UPDATE items
           SET content = '',
               content_translated = '',
               extra = json_set(
                 json_set(
                   coalesce(extra, '{}'),
                   '$.original_content',
                   coalesce(json_extract(coalesce(extra, '{}'), '$.original_content'), ?)
                 ),
                 '$.original_content_translated',
                 coalesce(json_extract(coalesce(extra, '{}'), '$.original_content_translated'), ?)
               )
           WHERE id = ?`,
        ).bind(r.content, r.content_translated || '', r.id),
      );
    }
    const BATCH = 50;
    for (let i = 0; i < stmts.length; i += BATCH) {
      await env.DB.batch(stmts.slice(i, i + BATCH));
    }
    updated = candidates.length;
  }

  return {
    mode: 'dedupe-quote-content',
    candidates_total: candidates.length,
    updated,
    skipped_already_backed_up: 0,
    dry_run: dryRun,
    elapsed_ms: Date.now() - t0,
  };
}

// ─── longform-fetch-now: 单条强制重抓全文 ──────────────────────
// D3: SB API truncate 长推到 ~140 字符。这条调 syndication API 拿 self.text
// 全文，覆盖 D1 main.content。同时也备份原 truncated content 到 extra.
// 用户报 NousResearch /t/2055111083396899326 全文被截。

export interface LongformFetchResult {
  itemId: string;
  before_len: number;
  after_len: number;
  updated: boolean;
  reason?: string;
}

export async function runLongformFetchOne(
  env: EnrichEnv,
  itemId: string,
): Promise<LongformFetchResult> {
  const item = await env.DB.prepare(
    `SELECT id, source_id, content, content_translated FROM items WHERE id = ?`,
  ).bind(itemId).first<{ id: string; source_id: string; content: string | null; content_translated: string | null }>();
  if (!item) return { itemId, before_len: 0, after_len: 0, updated: false, reason: 'item_not_found' };

  const res = await fetchTweet(item.source_id);
  if (!res || res.notFound || !res.data) {
    return { itemId, before_len: (item.content || '').length, after_len: 0, updated: false, reason: 'syndication_fetch_failed' };
  }
  const newText = (res.data.text as string) || '';
  if (!newText) {
    return { itemId, before_len: (item.content || '').length, after_len: 0, updated: false, reason: 'empty_text' };
  }
  if (newText.length <= (item.content || '').length) {
    return { itemId, before_len: (item.content || '').length, after_len: newText.length, updated: false, reason: 'no_longer_content' };
  }

  // D5: 同步清 content_translated（备份到 extra.original_truncated_content_translated）
  // 旧 translated 是基于截断 content 翻译的，新 content 长度变化后必须重译
  // (fill-translations cron 会扫 content_translated IS NULL 自动重译)
  await env.DB.prepare(
    `UPDATE items
     SET content = ?,
         content_translated = NULL,
         extra = json_set(
           json_set(
             coalesce(extra, '{}'),
             '$.original_truncated_content',
             coalesce(json_extract(coalesce(extra, '{}'), '$.original_truncated_content'), ?)
           ),
           '$.original_truncated_content_translated',
           coalesce(json_extract(coalesce(extra, '{}'), '$.original_truncated_content_translated'), ?)
         )
     WHERE id = ?`,
  ).bind(newText, item.content, item.content_translated || '', item.id).run();

  return { itemId, before_len: (item.content || '').length, after_len: newText.length, updated: true };
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
// ─── list-poll-ingest（替代本地 chrome 抓取） ───────────────────
// 调 ScrapeBadger get-list-tweets 一次拿 ~56 条，分页直到 known IDs（早停）。
// 每条 tweet upsert 进 items 表（is_relevant=1，matched_by='list-poll-sb'）。
// 与本地 launchd chrome 共存阶段：双写不冲突，items.id PK + INSERT...ON
// CONFLICT DO UPDATE 自然去重，content 长度 monotonic 增长，metrics 后写者赢。
//
// 频率：cron minute=25/55（30 min 一次，跟本地 chrome 频率持平）。
// 早停：当前页全部 ID 在 D1 → 不翻下一页，避免无谓花 credits。

export interface ListPollIngestResult {
  mode: 'list-poll-ingest';
  list_id: string;
  pages: number;
  tweets_seen: number;
  inserted_or_updated: number;
  newly_inserted: number;
  credits_used: number;
  rate_limit_remaining: number | undefined;
  duration_ms: number;
  early_stop: boolean;
  error?: string;
}

export async function runListPollIngest(
  env: EnrichEnv & { SCRAPEBADGER_API_KEY?: string },
  listId: string,
  maxPages = 3,
): Promise<ListPollIngestResult> {
  const t0 = Date.now();
  let cursor: string | null = null;
  let totalCredits = 0;
  let totalSeen = 0;
  let inserted = 0;
  let newCount = 0;
  let earlyStop = false;
  let pages = 0;
  let lastRateRemaining: number | undefined;
  let firstError: string | undefined;

  for (let p = 0; p < maxPages; p++) {
    const r = await fetchListTweetsPage(env, listId, cursor);
    pages++;
    totalCredits += r.creditsUsed || 0;
    totalSeen += r.tweets.length;
    lastRateRemaining = r.rateLimitRemaining;
    if (r.error) {
      firstError = r.error;
      break;
    }
    if (r.tweets.length === 0) break;

    const composedIds = r.tweets.map((t) => `x_list:${t.id}`).filter(Boolean);
    if (composedIds.length === 0) break;

    // 哪些已经在 D1 — 用来判断 early stop + 区分 insert vs update
    const placeholders = composedIds.map(() => '?').join(',');
    const existingRows = await env.DB.prepare(
      `SELECT id FROM items WHERE id IN (${placeholders})`,
    )
      .bind(...composedIds)
      .all<{ id: string }>();
    const existingSet = new Set(existingRows.results.map((row) => row.id));

    // 视频补全：SB get-tweets-by-ids/lists 都不返 mp4 url，只给缩略图。
    // 找出本页带视频的 tweet，逐条调免费的 syndication API 拿 mp4 variants。
    // 数量小（典型 3-8 视频/页），串行调用即可，免费不计 SB credits。
    //
    // Lookup key 用 tweet_id 而非 SB media_key：syndication mediaDetails 里
    // id_str/id 经常返 null（实测过），用它当 key 永远 miss。一个 tweet
    // 99% 只有 1 个 video，用 tweet_id 简单可靠；多 video 推 fallback 取首条。
    const videoMp4Map = new Map<string, string>();
    const videoTweets = r.tweets.filter((t) =>
      (t.media || []).some((m) => m.type === 'video' || m.type === 'animated_gif'),
    );
    for (const vt of videoTweets) {
      if (!vt.id) continue;
      try {
        const fr = await fetchTweet(vt.id);
        if (!fr?.data) continue;
        const mediaDetails = (fr.data as Record<string, unknown>).mediaDetails as
          | Array<Record<string, unknown>>
          | undefined;
        if (!mediaDetails) continue;
        for (const md of mediaDetails) {
          if (md.type !== 'video' && md.type !== 'animated_gif') continue;
          const variants =
            ((md.video_info as Record<string, unknown>)?.variants as Array<{
              content_type?: string;
              bitrate?: number;
              url?: string;
            }>) || [];
          const mp4s = variants.filter((v) => v.content_type === 'video/mp4' && v.url);
          mp4s.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          const best = mp4s[0]?.url;
          if (best && !videoMp4Map.has(vt.id)) videoMp4Map.set(vt.id, best);
        }
      } catch {
        // 单条失败不影响其它，下次 cron 还会再试
      }
    }

    // upsert 整页（已存在的也走，让 metrics 跟着 SB 实时刷新）
    const stmts: D1PreparedStatement[] = [];
    for (const t of r.tweets) {
      const item = sbTweetToIngestItem(t, videoMp4Map);
      if (!item) continue;
      const id = `x_list:${item.source_id}`;
      stmts.push(
        env.DB.prepare(`
          INSERT INTO items (id, source_type, source_id, title, content,
            content_translated, author, handle, url, media, metrics, published_at,
            scraped_at, is_relevant, matched_by, lang, extra)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            content = CASE
              WHEN items.content IS NULL OR length(coalesce(excluded.content, '')) >= length(items.content)
                THEN excluded.content
              ELSE items.content
            END,
            media = excluded.media,
            metrics = excluded.metrics,
            -- extra merge：以 items.extra（旧）为基础，excluded.extra（新 SB
            -- 抓取）覆盖同名字段。旧 extra 里 backfill 写入的字段（quote_of,
            -- reply_of, retweet_of, link_card, thread_root_id, longform,
            -- enriched_at, reply_enriched_at, retweet_enriched_at 等）会被
            -- 完整保留，不再被新 SB 数据洗掉。
            -- 之前的实现只保留 longform/enriched_at 两个字段，导致每次
            -- list-poll 重抓同一推都把 backfill 的嵌套数据擦掉（用户报
            -- /t/2055058976530919843 quote_of 丢失的根因）。
            extra = CASE
              WHEN items.extra IS NULL THEN excluded.extra
              WHEN excluded.extra IS NULL THEN items.extra
              ELSE json_patch(items.extra, excluded.extra)
            END
        `).bind(
          id,
          item.source_type,
          item.source_id,
          item.title,
          item.content,
          item.content_translated,
          item.author,
          item.handle,
          item.url,
          item.media,
          item.metrics,
          item.published_at,
          item.scraped_at,
          item.is_relevant,
          item.matched_by,
          item.lang,
          item.extra,
        ),
      );
      if (!existingSet.has(id)) newCount++;
      else inserted++; // 实际是 update
    }

    if (stmts.length > 0) {
      try {
        await env.DB.batch(stmts);
      } catch (e) {
        console.error('[list-poll-ingest] batch error:', e);
        firstError = e instanceof Error ? e.message : 'batch_error';
        break;
      }
    }

    // 全部都 already known → early stop
    if (existingSet.size === composedIds.length) {
      earlyStop = true;
      break;
    }
    cursor = r.nextCursor;
    if (!cursor) break;
  }

  return {
    mode: 'list-poll-ingest',
    list_id: listId,
    pages,
    tweets_seen: totalSeen,
    inserted_or_updated: inserted + newCount,
    newly_inserted: newCount,
    credits_used: totalCredits,
    rate_limit_remaining: lastRateRemaining,
    duration_ms: Date.now() - t0,
    early_stop: earlyStop,
    error: firstError,
  };
}

// ─── classify-pending：DeepSeek 批量判 is_relevant + ai_summary ───
// SB list-poll-ingest 写 is_relevant=NULL 后，由这条 cron 把 NULL 项过一遍
// DeepSeek，相关性命中(=1)的同时给 1 行中文 ai_summary。
//
// 跟本地 tweet_processor.py 同样的语义：列表里都是 AI 圈用户，但他们也会
// 发吐槽 / 广告 / 个人事项；这里只放跟 AI / 工程 / 产品 / 技术相关的。
//
// 翻译不在这里做：fill-translations cron 会 select content_translated IS NULL
// AND lang != 'zh' AND is_relevant=1 自动接力。

const CLASSIFY_PROMPT = `你判断每条推文是否属于 AI / 软件工程 / 产品 / 创业 / 技术议题。
对每条返回 JSON 对象 { idx, is_relevant: 0|1, ai_summary }。
- is_relevant=1：跟 AI / LLM / agent / 产品 / 工程 / 创业 / dev tooling 相关
- is_relevant=0：纯个人生活、政治、广告、不相干吐槽
- ai_summary：仅 is_relevant=1 时给 1 行中文摘要（≤ 40 字），抓核心信息；
  否则空字符串

输入推文（JSON 数组，每条 { idx, handle, text }）：
%INPUT%

只返回一个 JSON 对象 { items: [{ idx, is_relevant, ai_summary }, ...] }，不要任何其他文字。`;

export interface ClassifyPendingResult {
  mode: 'classify-pending';
  selected: number;
  classified: number;
  relevant: number;
  irrelevant: number;
  duration_ms: number;
  error?: string;
}

interface ClassifyResponse {
  items?: Array<{ idx: number; is_relevant: 0 | 1; ai_summary?: string }>;
}

export async function runClassifyPending(
  env: EnrichEnv,
  limit = 15,
): Promise<ClassifyPendingResult> {
  const t0 = Date.now();
  if (!env.DEEPSEEK_API_KEY) {
    return { mode: 'classify-pending', selected: 0, classified: 0, relevant: 0, irrelevant: 0, duration_ms: 0, error: 'no_deepseek_key' };
  }

  const rows = await env.DB.prepare(
    `SELECT id, source_id, content, handle, extra
       FROM items
      WHERE source_type = 'x_list'
        AND deleted_at IS NULL
        AND is_relevant IS NULL
      ORDER BY scraped_at DESC
      LIMIT ?`,
  ).bind(limit).all<{ id: string; source_id: string; content: string | null; handle: string | null; extra: string | null }>();

  const selected = rows.results.length;
  if (selected === 0) {
    return { mode: 'classify-pending', selected: 0, classified: 0, relevant: 0, irrelevant: 0, duration_ms: Date.now() - t0 };
  }

  const input = rows.results.map((r, i) => ({
    idx: i,
    handle: r.handle || '',
    text: (r.content || '').slice(0, 600), // 截断防止 prompt 太长
  }));
  const prompt = CLASSIFY_PROMPT.replace('%INPUT%', JSON.stringify(input));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  let res: Response;
  try {
    res = await fetch('https://gateway.ai.cloudflare.com/v1/0d13b65d05d5d29fe06998141f3b0f9a/aifeeds-deepseek/deepseek/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        response_format: { type: 'json_object' },
        max_tokens: 4000,
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    return { mode: 'classify-pending', selected, classified: 0, relevant: 0, irrelevant: 0, duration_ms: Date.now() - t0, error: 'fetch_failed' };
  }
  clearTimeout(timer);

  if (!res.ok) {
    return { mode: 'classify-pending', selected, classified: 0, relevant: 0, irrelevant: 0, duration_ms: Date.now() - t0, error: `http_${res.status}` };
  }

  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = body.choices?.[0]?.message?.content || '';
  let parsed: ClassifyResponse;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { mode: 'classify-pending', selected, classified: 0, relevant: 0, irrelevant: 0, duration_ms: Date.now() - t0, error: 'json_parse' };
  }
  const results = parsed.items || [];

  const nowIso = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  let relevant = 0;
  let irrelevant = 0;
  let classified = 0;
  for (const item of results) {
    const idx = item.idx;
    if (idx == null || idx < 0 || idx >= rows.results.length) continue;
    const row = rows.results[idx];
    const isRel = item.is_relevant === 1 ? 1 : 0;
    const summary = (item.ai_summary || '').trim();
    classified++;
    if (isRel) relevant++; else irrelevant++;
    stmts.push(
      env.DB.prepare(
        `UPDATE items
            SET is_relevant = ?,
                matched_by = COALESCE(matched_by, 'classify-pending'),
                extra = json_set(coalesce(extra, '{}'),
                                 '$.ai_summary', ?,
                                 '$.classified_at', ?)
          WHERE id = ?`,
      ).bind(isRel, summary, nowIso, row.id),
    );
  }

  if (stmts.length > 0) {
    try {
      await env.DB.batch(stmts);
    } catch (e) {
      console.error('[classify-pending] batch error:', e);
      return { mode: 'classify-pending', selected, classified: 0, relevant, irrelevant, duration_ms: Date.now() - t0, error: 'batch_error' };
    }
  }

  return {
    mode: 'classify-pending',
    selected,
    classified,
    relevant,
    irrelevant,
    duration_ms: Date.now() - t0,
  };
}

// ─── longform-via-sb：替代本地 chrome longform-cron 的批量补全 ───
// SB get-tweets-by-ids 直接返 full_text（never truncated），50 IDs/call ≈ 51 credits。
// 把 D1 里 extra.longform.note_id 标过但 fetched_at 还空的 item 一锅端：
//   1. SELECT 一批
//   2. 一次 SB batch
//   3. 对每条命中：UPDATE content = full_text，extra.longform.fetched_at = now
//   4. 没命中（X 已删 / 私密等）→ extra.longform.fetch_error
// 用法：cron 每 5 min 跑一次 limit=50（清完后 cap 不再扣 credits 因为 SELECT 0 行）；
// 或 /api/enrich/run?mode=longform-via-sb&limit=200 一次性清 backlog。

// ─── backfill-video-mp4 mode ──────────────────────────────────
// 一次性补齐：SB list-poll-ingest 之前 video item 全是 jpg thumbnail（mp4
// lookup key bug 导致 syndication 兜底永远失效）。修代码后新视频会带 mp4，
// 这个 mode 用 syndication 把存量 video item 的 url 也补上 mp4。
//
// 选条件：source_type='x_list'、media 里有 video 类型、url 还是 thumbnail
// 域名（pbs.twimg.com 而不是 video.twimg.com）。
export interface BackfillVideoMp4Result {
  mode: 'backfill-video-mp4';
  selected: number;
  updated: number;
  no_mp4: number;
  fetch_failed: number;
  duration_ms: number;
}

export async function runBackfillVideoMp4(
  env: EnrichEnv,
  limit = 30,
): Promise<BackfillVideoMp4Result> {
  const t0 = Date.now();
  const rows = await env.DB.prepare(
    `SELECT id, source_id, media
       FROM items
      WHERE source_type = 'x_list'
        AND deleted_at IS NULL
        AND media LIKE '%"type":"video"%'
        AND media NOT LIKE '%video.twimg.com%'
      ORDER BY scraped_at DESC
      LIMIT ?`,
  ).bind(limit).all<{ id: string; source_id: string; media: string }>();

  const selected = rows.results.length;
  let updated = 0;
  let noMp4 = 0;
  let fetchFailed = 0;

  for (const row of rows.results) {
    try {
      const fr = await fetchTweet(row.source_id);
      if (!fr?.data) {
        fetchFailed++;
        continue;
      }
      const mediaDetails = (fr.data as Record<string, unknown>).mediaDetails as
        | Array<Record<string, unknown>>
        | undefined;
      let bestMp4: string | undefined;
      if (mediaDetails) {
        for (const md of mediaDetails) {
          if (md.type !== 'video' && md.type !== 'animated_gif') continue;
          const variants =
            ((md.video_info as Record<string, unknown>)?.variants as Array<{
              content_type?: string;
              bitrate?: number;
              url?: string;
            }>) || [];
          const mp4s = variants.filter((v) => v.content_type === 'video/mp4' && v.url);
          mp4s.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          if (mp4s[0]?.url) {
            bestMp4 = mp4s[0].url;
            break;
          }
        }
      }
      if (!bestMp4) {
        noMp4++;
        continue;
      }

      // 替换 media JSON 里第一个 video item 的 url
      let arr: Array<Record<string, unknown>>;
      try {
        arr = JSON.parse(row.media) as Array<Record<string, unknown>>;
      } catch {
        fetchFailed++;
        continue;
      }
      let mp4Used = false;
      for (const m of arr) {
        if (m.type === 'video' && !mp4Used) {
          m.url = bestMp4;
          mp4Used = true;
        }
      }
      if (!mp4Used) {
        noMp4++;
        continue;
      }
      const newMedia = JSON.stringify(arr);
      await env.DB.prepare(`UPDATE items SET media = ? WHERE id = ?`)
        .bind(newMedia, row.id)
        .run();
      updated++;
    } catch {
      fetchFailed++;
    }
  }

  return {
    mode: 'backfill-video-mp4',
    selected,
    updated,
    no_mp4: noMp4,
    fetch_failed: fetchFailed,
    duration_ms: Date.now() - t0,
  };
}

export interface LongformViaSbResult {
  mode: 'longform-via-sb';
  selected: number;
  updated: number;
  not_found: number;
  credits_used: number;
  duration_ms: number;
  error?: string;
}

export async function runLongformViaSb(
  env: EnrichEnv & { SCRAPEBADGER_API_KEY?: string },
  limit = 50,
): Promise<LongformViaSbResult> {
  const t0 = Date.now();

  const rows = await env.DB.prepare(
    `SELECT id, source_id, content, extra
       FROM items
      WHERE source_type = 'x_list'
        AND deleted_at IS NULL
        AND json_extract(extra, '$.longform.note_id') IS NOT NULL
        AND json_extract(extra, '$.longform.fetched_at') IS NULL
      ORDER BY scraped_at DESC
      LIMIT ?`,
  ).bind(limit).all<{ id: string; source_id: string; content: string | null; extra: string | null }>();

  const selected = rows.results.length;
  if (selected === 0) {
    return { mode: 'longform-via-sb', selected: 0, updated: 0, not_found: 0, credits_used: 0, duration_ms: Date.now() - t0 };
  }
  if (!env.SCRAPEBADGER_API_KEY) {
    return { mode: 'longform-via-sb', selected, updated: 0, not_found: 0, credits_used: 0, duration_ms: Date.now() - t0, error: 'no_key' };
  }

  const ids = rows.results.map((r) => r.source_id);
  const sb = await fetchTweetsScrapeBadger(env, ids);

  if (sb.error) {
    return {
      mode: 'longform-via-sb',
      selected,
      updated: 0,
      not_found: 0,
      credits_used: sb.creditsUsed ?? 0,
      duration_ms: Date.now() - t0,
      error: sb.error,
    };
  }

  // SB by-ids 返 metrics shape，但 full_text 我们额外要。
  // 直接 raw 调一次更省事 — 但已经走过 fetchTweetsScrapeBadger 拿到 metrics map，
  // 还得 raw fetch 一次取 full_text。两次浪费 credits。
  // 简单做法：再调一次 raw，按 50 IDs 一批，从原始响应里读 full_text。
  // ✱ 但 sb.metrics 已经 cost 了，重复一次成本 double。
  // 折中：直接 raw curl，一次拿 full_text 同时也覆盖 metrics（通过 applyTieredUpdate 路径不走，因为这条
  // 我们其实不更新 metrics）— 只为 full_text 走一次 fetch，避免 fetchTweetsScrapeBadger 的简化输出。
  // → 下面用 raw fetch 实现。

  const url = `https://scrapebadger.com/v1/twitter/tweets/?tweets=${ids.join(',')}`;
  const t1 = Date.now();
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'x-api-key': env.SCRAPEBADGER_API_KEY, Accept: 'application/json' },
  });
  const creditsUsed = Number(res.headers.get('x-credits-used')) || 0;
  if (!res.ok) {
    return {
      mode: 'longform-via-sb',
      selected,
      updated: 0,
      not_found: 0,
      credits_used: creditsUsed,
      duration_ms: Date.now() - t0,
      error: `http_${res.status}`,
    };
  }
  const body = (await res.json()) as { data?: Array<{ id?: string; full_text?: string; text?: string }> };
  const fullTextById = new Map<string, string>();
  for (const t of body.data || []) {
    if (!t.id) continue;
    const ft = t.full_text || t.text || '';
    if (ft) fullTextById.set(t.id, ft);
  }

  const nowIso = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  let updated = 0;
  let notFound = 0;
  for (const r of rows.results) {
    const ft = fullTextById.get(r.source_id);
    if (ft) {
      // 更新 content（仅在 SB 给的更长时才覆盖；同 ingest 的 monotonic 规则）
      stmts.push(
        env.DB.prepare(
          `UPDATE items
              SET content = CASE
                    WHEN content IS NULL OR length(?) >= length(content) THEN ?
                    ELSE content
                  END,
                  extra = json_set(coalesce(extra, '{}'), '$.longform.fetched_at', ?)
            WHERE id = ?`,
        ).bind(ft, ft, nowIso, r.id),
      );
      updated++;
    } else {
      // SB 没返该条（已删 / 私密 / 受限），记 fetch_error 避免下次再选中
      stmts.push(
        env.DB.prepare(
          `UPDATE items
              SET extra = json_set(coalesce(extra, '{}'), '$.longform.fetch_error', ?,
                                                          '$.longform.fetched_at', ?)
            WHERE id = ?`,
        ).bind('not_returned_by_sb', nowIso, r.id),
      );
      notFound++;
    }
  }

  if (stmts.length > 0) {
    try {
      await env.DB.batch(stmts);
    } catch (e) {
      console.error('[longform-via-sb] batch error:', e);
      return {
        mode: 'longform-via-sb',
        selected,
        updated: 0,
        not_found: 0,
        credits_used: creditsUsed,
        duration_ms: Date.now() - t0,
        error: e instanceof Error ? e.message : 'batch_error',
      };
    }
  }

  console.log(`[longform-via-sb] selected=${selected} updated=${updated} not_found=${notFound} credits=${creditsUsed} dur=${Date.now() - t1}ms`);

  return {
    mode: 'longform-via-sb',
    selected,
    updated,
    not_found: notFound,
    credits_used: creditsUsed,
    duration_ms: Date.now() - t0,
  };
}

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

  // ── 批量预取（如配置 SCRAPEBADGER_API_KEY）──
  // ScrapeBadger get-tweets-by-ids 单次 N 个 ID = 1 call ≈ 1+N credits，
  // 替代 N 次 syndication subrequest（同时还能拿回 retweet_count/view_count，
  // syndication 已经不返这两字段）。失败/未命中的 ID fall back 走原来的
  // syndication 单条路径，零行为变化。
  const sbBatch = env.SCRAPEBADGER_API_KEY
    ? await fetchTweetsScrapeBadger(env, candidates.map((c) => c.source_id))
    : null;
  if (sbBatch?.error) {
    console.warn(
      `[refresh-tiered] scrapebadger ${sbBatch.error} status=${sbBatch.status} dur=${sbBatch.durationMs}ms; fallback to syndication`,
    );
  } else if (sbBatch) {
    console.log(
      `[refresh-tiered] scrapebadger hit=${sbBatch.metrics.size}/${candidates.length} miss=${sbBatch.missing.length} credits=${sbBatch.creditsUsed} ratelimit_remaining=${sbBatch.rateLimitRemaining} dur=${sbBatch.durationMs}ms`,
    );
  }

  for (const row of candidates) {
    const ageSec = Math.max(
      0,
      nowSec - Math.floor(new Date(row.published_at).getTime() / 1000),
    );

    // 优先走 SB 批量结果；命中即走完整 tier/velocity/snapshot 链路。
    const sbMetrics = sbBatch?.metrics.get(row.source_id);
    if (sbMetrics) {
      const newLikes = sbMetrics.likes ?? 0;
      const velocity = computeVelocity(
        newLikes,
        row.prev_likes,
        row.prev_captured_at,
        ageSec,
        nowSec,
      );
      const { tier, intervalSec } = determineTier(ageSec, velocity);
      await applyTieredUpdate(env, row.id, sbMetrics, tier, velocity, intervalSec, nowSec);
      counts.updated++;
      tierCount[String(tier)] = (tierCount[String(tier)] || 0) + 1;
      // SB batch 是 1 个 subreq 平摊到所有命中项，记账不必精确
      bumpTier(tier, 1, 1, 0);
      // SB 已拿到，不再睡眠（API 自身延迟 3-7s 已经是天然 pacing）
      continue;
    }

    // 未命中：可能 SB 漏了 / 没配 key / 失败回落 → 走原 syndication 路径
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

// 走 CF AI Gateway（slug：aifeeds-deepseek），dashboard 看 token / cost / 缓存命中。
// 回滚直连：改回 "https://api.deepseek.com/v1/chat/completions"。
const DEEPSEEK_URL = "https://gateway.ai.cloudflare.com/v1/0d13b65d05d5d29fe06998141f3b0f9a/aifeeds-deepseek/deepseek/chat/completions";
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
  | "link_card_desc"
  // PH-specific:
  | "ph_maker_post"     // extra.maker_post_text → extra.maker_post_translated
  | "ph_top_comment";   // extra.top_comments[i].text → extra.top_comments[i].translated

interface TranslationTask {
  itemId: string;
  field: TaskField;
  text: string;
  commentIdx?: number; // for ph_top_comment: index into extra.top_comments[]
}

interface TranslationRow {
  id: string;
  source_id: string;
  source_type: string;
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
  // 优先 content 未翻译的（命中率 ~100%，没 isLikelyChinese 浪费），
  // 其次是 quote_of/link_card 边角；同优先级里 RANDOM 散布。
  const rows = await env.DB.prepare(
    `SELECT id, source_id, source_type, content, lang, content_translated, extra
     FROM items
     WHERE is_relevant = 1
       AND (
         (
           source_type = 'x_list'
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
         )
         OR (
           source_type = 'product_hunt'
           AND (
             (content_translated IS NULL AND content IS NOT NULL)
             OR (
               json_extract(extra, '$.maker_post_text') IS NOT NULL
               AND json_extract(extra, '$.maker_post_translated') IS NULL
             )
             OR (
               json_extract(extra, '$.top_comments') IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM json_each(json_extract(extra, '$.top_comments')) AS c
                 WHERE json_extract(c.value, '$.text') IS NOT NULL
                   AND json_extract(c.value, '$.translated') IS NULL
               )
             )
           )
         )
       )
     ORDER BY
       CASE WHEN content_translated IS NULL AND content IS NOT NULL THEN 0 ELSE 1 END,
       RANDOM()
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
  // PH-specific extraction
  if (row.source_type === "product_hunt") {
    const mpText = extra.maker_post_text as string | null | undefined;
    const mpTr = extra.maker_post_translated as string | null | undefined;
    if (mpText && !mpTr && !isLikelyChinese(mpText)) {
      tasks.push({ itemId: row.id, field: "ph_maker_post", text: mpText });
    }
    const topComments = extra.top_comments as
      | Array<{ text?: string; translated?: string }>
      | undefined;
    if (Array.isArray(topComments)) {
      topComments.forEach((c, i) => {
        if (c.text && !c.translated && !isLikelyChinese(c.text)) {
          tasks.push({
            itemId: row.id,
            field: "ph_top_comment",
            text: c.text,
            commentIdx: i,
          });
        }
      });
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
  // PH-specific:
  ph_maker_post_translated?: string;
  ph_top_comments_translated?: Map<number, string>; // commentIdx → translated
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
  // PH: maker_post_translated → extra.maker_post_translated
  if (patch.ph_maker_post_translated) {
    extra.maker_post_translated = patch.ph_maker_post_translated;
  }
  // PH: top_comments[i].translated mutation
  if (patch.ph_top_comments_translated && patch.ph_top_comments_translated.size > 0) {
    const tc = extra.top_comments as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(tc)) {
      for (const [idx, tr] of patch.ph_top_comments_translated) {
        if (tc[idx] && typeof tc[idx] === "object") {
          tc[idx].translated = tr;
        }
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
    else if (task.field === "ph_maker_post") p.ph_maker_post_translated = tr;
    else if (task.field === "ph_top_comment" && task.commentIdx !== undefined) {
      const m = p.ph_top_comments_translated || new Map<number, string>();
      m.set(task.commentIdx, tr);
      p.ph_top_comments_translated = m;
    }
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

export function noteIdFromTweet(data: Record<string, unknown>): string | null {
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

export async function writeLongform(
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

// ─── ph-enrich：DeepSeek 一次性产 is_ai + ai_category + ai_summary ───
//
// 仿 github-enrich 模式（一锅端，不走 X 流程的 classify-pending），因为 PH 跟
// GH 一样需要 ai_category；X 没有该字段所以 classify-pending 不输出。
//
// ai_category 7 类对齐前端 PH_CATEGORY_STYLE：
//   ai_agent / ai_code_editor / ai_image_gen / ai_audio /
//   ai_voice_agent / ai_data_analysis / ai_other

const PH_ENRICH_PROMPT = `你是 AI 产品分类员。判断每个 Product Hunt 产品是否 AI 相关，是 AI 相关时给出分类和一句中文解读。

输入：JSON 数组 [{idx, name, tagline, description, topics}]

判断规则：
- AI 相关：产品核心功能依赖 LLM / 图像生成 / 语音模型 / 智能体框架 / AI 工具链 / AI 基础设施
- 不 AI 相关：纯 SaaS / 运营工具 / 没有 AI 能力的功能型软件

分类（is_relevant=1 时必填一个）：
- ai_agent: 智能体 / autonomous workflow / 多步任务自动化
- ai_code_editor: AI 编程编辑器 / 代码补全 / IDE 插件
- ai_image_gen: 图像生成 / 编辑 / 设计工具
- ai_audio: 音乐 / TTS / 音频编辑
- ai_voice_agent: 语音对话智能体 / call center bot
- ai_data_analysis: 数据分析 / BI / SQL 助手
- ai_other: 不在以上 6 类的 AI 产品

ai_summary（is_relevant=1 时必填，中文一句话 30-60 字，说明产品是什么 + 给谁用 + 核心价值）。
is_relevant=0 时 ai_category=null, ai_summary=""。

输入：%INPUT%

只返回一个 JSON 对象 { items: [{ idx, is_relevant, ai_category, ai_summary }, ...] }，不要任何其他文字。`;

export interface PhEnrichResult {
  mode: 'ph-enrich';
  selected: number;
  classified: number;
  relevant: number;
  irrelevant: number;
  duration_ms: number;
  error?: string;
}

interface PhEnrichRow {
  id: string;
  source_id: string;
  title: string | null;
  content: string | null;
  extra: string | null;
}

interface PhEnrichResponse {
  items?: Array<{
    idx: number;
    is_relevant: 0 | 1;
    ai_category?: string | null;
    ai_summary?: string;
  }>;
}

export async function runPhEnrich(env: EnrichEnv, limit = 10): Promise<PhEnrichResult> {
  const t0 = Date.now();
  if (!env.DEEPSEEK_API_KEY) {
    return { mode: 'ph-enrich', selected: 0, classified: 0, relevant: 0, irrelevant: 0, duration_ms: 0, error: 'no_deepseek_key' };
  }

  const rows = await env.DB.prepare(
    `SELECT id, source_id, title, content, extra
       FROM items
      WHERE source_type = 'product_hunt'
        AND deleted_at IS NULL
        AND is_relevant IS NULL
      ORDER BY scraped_at DESC
      LIMIT ?`,
  ).bind(limit).all<PhEnrichRow>();

  const selected = rows.results.length;
  if (selected === 0) {
    return { mode: 'ph-enrich', selected: 0, classified: 0, relevant: 0, irrelevant: 0, duration_ms: Date.now() - t0 };
  }

  const input = rows.results.map((r, i) => {
    let extra: { description?: string; topics?: string[] } = {};
    try {
      const p = JSON.parse(r.extra || '{}');
      if (p && typeof p === 'object') extra = p;
    } catch { /* noop */ }
    return {
      idx: i,
      name: r.title || '',
      tagline: r.content || '',
      description: (extra.description || '').slice(0, 400),
      topics: (extra.topics || []).slice(0, 5),
    };
  });
  const prompt = PH_ENRICH_PROMPT.replace('%INPUT%', JSON.stringify(input));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  let res: Response;
  try {
    res = await fetch('https://gateway.ai.cloudflare.com/v1/0d13b65d05d5d29fe06998141f3b0f9a/aifeeds-deepseek/deepseek/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        response_format: { type: 'json_object' },
        max_tokens: 4000,
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    return { mode: 'ph-enrich', selected, classified: 0, relevant: 0, irrelevant: 0, duration_ms: Date.now() - t0, error: 'fetch_failed' };
  }
  clearTimeout(timer);

  if (!res.ok) {
    return { mode: 'ph-enrich', selected, classified: 0, relevant: 0, irrelevant: 0, duration_ms: Date.now() - t0, error: `http_${res.status}` };
  }

  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = body.choices?.[0]?.message?.content || '';
  let parsed: PhEnrichResponse;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { mode: 'ph-enrich', selected, classified: 0, relevant: 0, irrelevant: 0, duration_ms: Date.now() - t0, error: 'json_parse' };
  }

  const nowIso = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  let relevant = 0;
  let irrelevant = 0;
  let classified = 0;
  for (const out of parsed.items || []) {
    const idx = out.idx;
    if (idx == null || idx < 0 || idx >= rows.results.length) continue;
    const row = rows.results[idx];
    const isAi = out.is_relevant === 1 ? 1 : 0;
    const cat = isAi ? (out.ai_category || 'ai_other') : null;
    const summary = isAi ? (out.ai_summary || '').trim() : '';
    classified++;
    if (isAi) relevant++; else irrelevant++;
    stmts.push(
      env.DB.prepare(
        `UPDATE items
            SET is_relevant = ?,
                matched_by = COALESCE(matched_by, 'ph-enrich'),
                extra = json_set(coalesce(extra, '{}'),
                                 '$.ai_category', ?,
                                 '$.ai_summary', ?,
                                 '$.classified_at', ?)
          WHERE id = ?`,
      ).bind(isAi, cat, summary, nowIso, row.id),
    );
  }
  if (stmts.length > 0) {
    try {
      await env.DB.batch(stmts);
    } catch (e) {
      console.error('[ph-enrich] batch error:', e);
      return { mode: 'ph-enrich', selected, classified, relevant, irrelevant, duration_ms: Date.now() - t0, error: 'batch_error' };
    }
  }
  return { mode: 'ph-enrich', selected, classified, relevant, irrelevant, duration_ms: Date.now() - t0 };
}

// ═══════════════════════════════════════════════════════════════════════════
//
// 阶段 4 X 主链 Workflow 单 itemId 函数
//
// 设计：docs/plans/2026-05-16-x-main-pipeline-workflows-design.md
// 给 worker/src/workflows/x-tweet-pipeline.ts 的 step.do 调用。
//
// 每个函数完成一个 Workflow step 的工作 —— SELECT row by id → do work → UPDATE。
// 失败 throw（让 step.do 按 retry config 重试）。
//
// 老 batch 函数（runClassifyPending / runFillTranslations / runBackfillQuotes /
// runBackfillReplies / runDetectLongform / runLongformViaSb）保留，给 admin
// endpoint 兜底用（backfill 老数据 / Workflow 出问题时手动批量补救）。
//
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Workflow Step 1: DeepSeek LLM 判断 is_relevant + 生成 ai_summary。
 * 单条调 LLM（vs batch 模式 N 条 1 call）。系统 prompt 重复成本可忽略。
 */
export async function classifyXTweetWithLlm(
  env: EnrichEnv,
  itemId: string,
): Promise<{ is_relevant: 0 | 1; ai_summary: string }> {
  if (!env.DEEPSEEK_API_KEY) {
    throw new Error('classifyXTweetWithLlm: DEEPSEEK_API_KEY missing');
  }

  const row = await env.DB.prepare(
    `SELECT id, content, handle
       FROM items
      WHERE id = ? AND source_type = 'x_list'`,
  ).bind(itemId).first<{ id: string; content: string | null; handle: string | null }>();

  if (!row) {
    throw new Error(`classifyXTweetWithLlm: item not found ${itemId}`);
  }

  const input = [{
    idx: 0,
    handle: row.handle || '',
    text: (row.content || '').slice(0, 600),
  }];
  const prompt = CLASSIFY_PROMPT.replace('%INPUT%', JSON.stringify(input));

  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      response_format: { type: 'json_object' },
      max_tokens: 500,  // 单条不需要 4000
    }),
  });

  if (!res.ok) {
    throw new Error(`classifyXTweetWithLlm: HTTP ${res.status} for ${itemId}`);
  }

  const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const raw = body.choices?.[0]?.message?.content || '';
  let parsed: ClassifyResponse;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`classifyXTweetWithLlm: JSON parse failed for ${itemId}`);
  }

  const item = (parsed.items || [])[0];
  if (!item) {
    throw new Error(`classifyXTweetWithLlm: empty items array for ${itemId}`);
  }

  const isRel = item.is_relevant === 1 ? 1 : 0;
  const summary = (item.ai_summary || '').trim();

  await env.DB.prepare(
    `UPDATE items
        SET is_relevant = ?,
            matched_by = COALESCE(matched_by, 'workflow-classify'),
            extra = json_set(coalesce(extra, '{}'),
                             '$.ai_summary', ?,
                             '$.classified_at', ?)
      WHERE id = ?`,
  ).bind(isRel, summary, new Date().toISOString(), itemId).run();

  console.log(`[x-workflow:step1] ${itemId}: is_relevant=${isRel}`);
  return { is_relevant: isRel, ai_summary: summary };
}

/**
 * Workflow Step 2a: 通过 syndication API 回填 quote_of / link_card。
 * 跟老 runBackfillQuotes 一条 loop body 同逻辑，去掉 state KV bookkeeping。
 */
export async function backfillQuoteForXTweet(
  env: EnrichEnv,
  itemId: string,
): Promise<{ has_quote: boolean; has_link_card: boolean }> {
  const row = await env.DB.prepare(
    `SELECT id, source_id, extra FROM items WHERE id = ? AND source_type = 'x_list'`,
  ).bind(itemId).first<{ id: string; source_id: string; extra: string | null }>();
  if (!row) throw new Error(`backfillQuoteForXTweet: item not found ${itemId}`);

  const res = await fetchTweet(row.source_id);
  if (res === null) {
    throw new Error(`backfillQuoteForXTweet: fetchTweet failed ${row.source_id}`);
  }
  if (res.notFound || !res.data) {
    console.log(`[x-workflow:step2a] ${itemId}: tweet not found via syndication`);
    return { has_quote: false, has_link_card: false };
  }

  const qt = res.data.quoted_tweet as Record<string, unknown> | undefined;
  const card = apiToLinkCard(res.data);
  const apiReplyTo = res.data.in_reply_to_status_id_str as string | undefined;

  const patch: Patch = {};
  let hasQuote = false;
  let hasLinkCard = false;
  if (qt && qt.id_str) {
    patch.quote_of_id = qt.id_str as string;
    patch.quote_of = apiToQuoteOf(qt);
    hasQuote = true;
  }
  if (card) {
    patch.link_card = card;
    hasLinkCard = true;
  }
  if (!apiReplyTo) patch.clearThreadRoot = true;

  await applyPatch(env, row as CandidateRow, patch);
  console.log(`[x-workflow:step2a] ${itemId}: quote=${hasQuote} link_card=${hasLinkCard}`);
  return { has_quote: hasQuote, has_link_card: hasLinkCard };
}

/**
 * Workflow Step 2b: 通过 syndication API 回填 reply_of_id / reply_of snapshot。
 * 跟老 runBackfillReplies 一条 loop body 同逻辑。
 */
export async function backfillReplyForXTweet(
  env: EnrichEnv,
  itemId: string,
): Promise<{ has_reply: boolean }> {
  const row = await env.DB.prepare(
    `SELECT id, source_id, extra FROM items WHERE id = ? AND source_type = 'x_list'`,
  ).bind(itemId).first<{ id: string; source_id: string; extra: string | null }>();
  if (!row) throw new Error(`backfillReplyForXTweet: item not found ${itemId}`);

  const res = await fetchTweet(row.source_id);
  if (res === null) {
    throw new Error(`backfillReplyForXTweet: fetchTweet failed ${row.source_id}`);
  }
  if (res.notFound || !res.data) {
    console.log(`[x-workflow:step2b] ${itemId}: tweet not found via syndication`);
    return { has_reply: false };
  }

  const apiReplyToId = res.data.in_reply_to_status_id_str as string | undefined;
  const apiReplyToHandle = res.data.in_reply_to_screen_name as string | undefined;
  const parent = res.data.parent as Record<string, unknown> | undefined;

  const patch: Patch = { reply_enriched: true };
  let hasReply = false;
  if (apiReplyToId) {
    patch.reply_of_id = apiReplyToId;
    patch.reply_to_screen_name = apiReplyToHandle ?? null;
    if (parent && parent.id_str) {
      patch.reply_of = apiToQuoteOf(parent);
    } else {
      // Parent suppressed (deleted/protected) — keep id+handle 但 reply_of null
      patch.reply_of = null;
    }
    hasReply = true;
  }

  await applyPatch(env, row as CandidateRow, patch);
  console.log(`[x-workflow:step2b] ${itemId}: reply=${hasReply}`);
  return { has_reply: hasReply };
}

/**
 * Workflow Step 2c: 检测 longform 标记（note_tweet.id 有则是长推待 fetch）。
 * 跟老 runDetectLongform 一条 loop body 同逻辑。
 */
export async function checkLongformForXTweet(
  env: EnrichEnv,
  itemId: string,
): Promise<{ is_longform: boolean; note_id: string | null }> {
  const row = await env.DB.prepare(
    `SELECT id, source_id, extra FROM items WHERE id = ? AND source_type = 'x_list'`,
  ).bind(itemId).first<{ id: string; source_id: string; extra: string | null }>();
  if (!row) throw new Error(`checkLongformForXTweet: item not found ${itemId}`);

  const res = await fetchTweet(row.source_id);
  const nowIso = new Date().toISOString();

  if (res === null) {
    throw new Error(`checkLongformForXTweet: fetchTweet failed ${row.source_id}`);
  }
  if (res.notFound) {
    await writeLongform(env, row.id, row.extra, {
      detected_at: nowIso,
      fetch_error: 'syndication_404',
    });
    return { is_longform: false, note_id: null };
  }
  if (!res.data) {
    return { is_longform: false, note_id: null };
  }

  const noteId = noteIdFromTweet(res.data);
  const det: LongformDetection = { detected_at: nowIso };
  if (noteId) det.note_id = noteId;
  await writeLongform(env, row.id, row.extra, det);

  console.log(`[x-workflow:step2c] ${itemId}: longform=${!!noteId}`);
  return { is_longform: !!noteId, note_id: noteId };
}

/**
 * Workflow Step 3: ScrapeBadger 拉长推完整文本，写 content。
 * 老 runLongformViaSb 是 batch N 条 1 call（省 credits），单 itemId 是 2 credits/条。
 * 长推占比 < 1% (80 条/天约 1 条)，单 itemId 额外 cost <$0.0005/月，可忽略。
 */
export async function fetchLongformViaScrapeBadger(
  env: EnrichEnv & { SCRAPEBADGER_API_KEY?: string },
  itemId: string,
): Promise<{ updated: boolean; full_text_len: number }> {
  if (!env.SCRAPEBADGER_API_KEY) {
    throw new Error('fetchLongformViaScrapeBadger: SCRAPEBADGER_API_KEY missing');
  }

  const row = await env.DB.prepare(
    `SELECT id, source_id, content, extra
       FROM items
      WHERE id = ? AND source_type = 'x_list'`,
  ).bind(itemId).first<{ id: string; source_id: string; content: string | null; extra: string | null }>();
  if (!row) throw new Error(`fetchLongformViaScrapeBadger: item not found ${itemId}`);

  // 直接 SB raw endpoint 拿 full_text（同老 runLongformViaSb 的简化版）
  const url = `https://scrapebadger.com/v1/twitter/tweets/?tweets=${row.source_id}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'x-api-key': env.SCRAPEBADGER_API_KEY, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`fetchLongformViaScrapeBadger: SB HTTP ${res.status} for ${row.source_id}`);
  }
  const body = (await res.json()) as { data?: Array<{ id?: string; full_text?: string; text?: string }> };
  const ft = body.data?.[0]?.full_text || body.data?.[0]?.text || '';

  const nowIso = new Date().toISOString();
  if (!ft) {
    // SB 没返（已删/私密/受限）→ 记 fetch_error 避免下次再选
    await env.DB.prepare(
      `UPDATE items
          SET extra = json_set(coalesce(extra, '{}'),
                               '$.longform.fetch_error', ?,
                               '$.longform.fetched_at', ?)
        WHERE id = ?`,
    ).bind('not_returned_by_sb', nowIso, row.id).run();
    console.log(`[x-workflow:step3] ${itemId}: SB no full_text returned`);
    return { updated: false, full_text_len: 0 };
  }

  // 仅在 SB 给的更长时才覆盖（monotonic 规则同 ingest）
  await env.DB.prepare(
    `UPDATE items
        SET content = CASE
              WHEN content IS NULL OR length(?) >= length(content) THEN ?
              ELSE content
            END,
            extra = json_set(coalesce(extra, '{}'), '$.longform.fetched_at', ?)
      WHERE id = ?`,
  ).bind(ft, ft, nowIso, row.id).run();
  console.log(`[x-workflow:step3] ${itemId}: longform fetched ${ft.length}c`);
  return { updated: true, full_text_len: ft.length };
}

/**
 * Workflow Step 4 (任一字段): 通用单字段翻译 dispatch。
 * 6 个 field 类型对应 fan-out 6 个独立 step.do。每个 step 独立 retry，
 * 任一失败不影响其他字段。
 *
 * task #7 i18n 友好：opts.lang 参数预留多语言扩展，当前只支持 'zh'。
 * 未来扩 en/ja/etc 时改这里的 prompt 模板，不动 schema。
 *
 * task #6 reply/retweet 覆盖：把老 fill-translations 不扫的 reply_of.content
 * 和 retweet_of.content 加进 dispatch，跟 Phase 1 ingest 信号联动跑。
 */
export type XTweetTranslateField =
  | 'content'
  | 'quote_of.content'
  | 'link_card.title'
  | 'link_card.description'
  | 'reply_of.content'
  | 'retweet_of.content';

export async function translateXTweetField(
  env: EnrichEnv,
  itemId: string,
  field: XTweetTranslateField,
  opts: { lang: 'zh' | 'en' | 'ja' } = { lang: 'zh' },
): Promise<{ translated: boolean; chars: number }> {
  if (!env.DEEPSEEK_API_KEY) {
    throw new Error('translateXTweetField: DEEPSEEK_API_KEY missing');
  }
  if (opts.lang !== 'zh') {
    // task #7 接口预留 lang 参数，当前 prompt 模板只支持 zh
    throw new Error(`translateXTweetField: lang=${opts.lang} not yet supported (only 'zh')`);
  }

  const row = await env.DB.prepare(
    `SELECT id, content, content_translated, lang, extra
       FROM items
      WHERE id = ? AND source_type = 'x_list'`,
  ).bind(itemId).first<{
    id: string;
    content: string | null;
    content_translated: string | null;
    lang: string | null;
    extra: string | null;
  }>();
  if (!row) throw new Error(`translateXTweetField: item not found ${itemId}`);

  const extra: Record<string, unknown> = row.extra
    ? (JSON.parse(row.extra) as Record<string, unknown>)
    : {};

  // ── 取 source text + 判断是否需要翻译 ─────────────────────────
  let sourceText: string;
  let alreadyDone: boolean;
  let isAlreadyZh = false;

  if (field === 'content') {
    if (!row.content) return { translated: false, chars: 0 };
    sourceText = row.content;
    alreadyDone = !!row.content_translated;
    isAlreadyZh = row.lang === 'zh' || row.lang === 'zh-cn' || row.lang === 'zh-tw';
  } else if (field === 'quote_of.content') {
    const qo = extra.quote_of as { content?: string; content_translated?: string } | undefined;
    if (!qo?.content) return { translated: false, chars: 0 };
    sourceText = qo.content;
    alreadyDone = !!qo.content_translated;
  } else if (field === 'link_card.title') {
    const lc = extra.link_card as { title?: string; title_translated?: string } | undefined;
    if (!lc?.title) return { translated: false, chars: 0 };
    sourceText = lc.title;
    alreadyDone = !!lc.title_translated;
  } else if (field === 'link_card.description') {
    const lc = extra.link_card as { description?: string; description_translated?: string } | undefined;
    if (!lc?.description) return { translated: false, chars: 0 };
    sourceText = lc.description;
    alreadyDone = !!lc.description_translated;
  } else if (field === 'reply_of.content') {
    const ro = extra.reply_of as { content?: string; content_translated?: string } | undefined;
    if (!ro?.content) return { translated: false, chars: 0 };
    sourceText = ro.content;
    alreadyDone = !!ro.content_translated;
  } else if (field === 'retweet_of.content') {
    const rto = extra.retweet_of as { content?: string; content_translated?: string } | undefined;
    if (!rto?.content) return { translated: false, chars: 0 };
    sourceText = rto.content;
    alreadyDone = !!rto.content_translated;
  } else {
    throw new Error(`translateXTweetField: unknown field ${field}`);
  }

  if (alreadyDone) {
    console.log(`[x-workflow:step4:${field}] ${itemId}: already translated, skip`);
    return { translated: false, chars: 0 };
  }
  if (isAlreadyZh) {
    console.log(`[x-workflow:step4:${field}] ${itemId}: source already zh, skip`);
    return { translated: false, chars: 0 };
  }
  if (!sourceText.trim()) return { translated: false, chars: 0 };

  // ── 翻译（复用现有 translateBatch，单 text 包成 1 元素数组）──
  const result = await translateBatch(env.DEEPSEEK_API_KEY, [sourceText]);
  const translated = result.get(0);
  if (!translated) {
    throw new Error(`translateXTweetField: empty translation for ${itemId} ${field}`);
  }

  // sanity check（suspect 时单次 retry，仍 suspect 留 suspect 标记）
  let finalText = translated;
  let attempts = 1;
  let quality: 'ok' | 'suspect' = sanityHit(sourceText, translated) ? 'suspect' : 'ok';
  if (quality === 'suspect') {
    const retry = await translateBatch(env.DEEPSEEK_API_KEY, [sourceText]);
    const retryTr = retry.get(0);
    if (retryTr) {
      attempts = 2;
      if (!sanityHit(sourceText, retryTr)) {
        finalText = retryTr;
        quality = 'ok';
      } else {
        finalText = retryTr; // 保留 retry 结果，仍 suspect 由人工 review
      }
    }
  }

  // ── 写回（按 field 类型分支写到 D1 column 或 extra JSON 路径）──
  const nowTs = Math.floor(Date.now() / 1000);
  if (field === 'content') {
    await env.DB.prepare(
      `UPDATE items
          SET content_translated = ?,
              translation_quality = ?,
              translation_attempts = COALESCE(translation_attempts, 0) + ?
        WHERE id = ?`,
    ).bind(finalText, quality, attempts, itemId).run();
  } else {
    // 写到 extra JSON 子路径
    const newExtra = { ...extra } as Record<string, unknown>;
    if (field === 'quote_of.content') {
      const qo = (newExtra.quote_of || {}) as Record<string, unknown>;
      newExtra.quote_of = { ...qo, content_translated: finalText, translated_at: nowTs };
    } else if (field === 'link_card.title') {
      const lc = (newExtra.link_card || {}) as Record<string, unknown>;
      newExtra.link_card = { ...lc, title_translated: finalText };
    } else if (field === 'link_card.description') {
      const lc = (newExtra.link_card || {}) as Record<string, unknown>;
      newExtra.link_card = { ...lc, description_translated: finalText };
    } else if (field === 'reply_of.content') {
      const ro = (newExtra.reply_of || {}) as Record<string, unknown>;
      newExtra.reply_of = { ...ro, content_translated: finalText, translated_at: nowTs };
    } else if (field === 'retweet_of.content') {
      const rto = (newExtra.retweet_of || {}) as Record<string, unknown>;
      newExtra.retweet_of = { ...rto, content_translated: finalText, translated_at: nowTs };
    }
    await env.DB.prepare(
      `UPDATE items SET extra = ? WHERE id = ?`,
    ).bind(JSON.stringify(newExtra), itemId).run();
  }

  console.log(`[x-workflow:step4:${field}] ${itemId}: translated ${finalText.length}c quality=${quality}`);
  return { translated: true, chars: finalText.length };
}
