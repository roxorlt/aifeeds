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
  // 可选：阶段 4 X 主链 Workflow binding。runListPollIngest 拉完 list 后
  // 对每条新 tweet 触发 instance；缺失时降级到「写 D1 + 等老 preempt cron」
  // 兜底（不会破坏老路径）。设计：docs/plans/2026-05-16-x-main-pipeline-workflows-design.md
  X_TWEET_PIPELINE_WORKFLOW?: Workflow;
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
  metrics?: {
    replies?: number;
    retweets?: number;
    likes?: number;
    views?: number;
  };
  // 2026-05-17 嵌套引用:原推自身可能引用了另一条推。
  // quote_of_id 是嵌套引用的 ID,quote_of 是 inline 嵌套对象(syndication 偶发返)。
  // FE 看到 quote_of_id 但 quote_of 缺时可以显示"引用了另一推"占位 + link to view。
  quote_of_id?: string | null;
  quote_of?: QuoteOf | null;
}

// 从 syndication API tweet data 提取 media 数组(photo + video + animated_gif),
// 跟 apiToQuoteOf 内部 media 解析同逻辑,抽出来给 backfillMediaForXTweet 共用。
// video 优先用 video_info.variants[mp4 最高码率] url,fallback 用 thumbnail。
export function mediaFromSyndicationData(data: Record<string, unknown>): Array<{
  type: string;
  url: string;
  width?: number;
  height?: number;
  poster?: string;
  alt?: null;
}> {
  const mediaDetails = (data.mediaDetails as Array<Record<string, unknown>>) || [];
  const result: Array<{ type: string; url: string; width?: number; height?: number; poster?: string; alt?: null }> = [];
  for (const m of mediaDetails) {
    const rawUrl = (m.media_url_https as string) || "";
    if (!rawUrl) continue;
    const oi = (m.original_info as Record<string, unknown>) || {};
    const mediaType =
      m.type === "photo"
        ? "image"
        : m.type === "video" || m.type === "animated_gif"
          ? "video"
          : ((m.type as string) || "image");
    let url = normalizeMediaUrl(rawUrl);
    let poster: string | undefined;
    if (mediaType === "video") {
      // 取 video_info.variants 里 mp4 最高码率
      const videoInfo = m.video_info as { variants?: Array<{ content_type?: string; url?: string; bitrate?: number }> } | undefined;
      const variants = videoInfo?.variants || [];
      const mp4Variants = variants
        .filter((v) => v.content_type === "video/mp4" && typeof v.url === "string")
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (mp4Variants.length > 0 && mp4Variants[0].url) {
        url = mp4Variants[0].url;
      }
      poster = rawUrl; // thumbnail 当封面
    }
    result.push({
      type: mediaType,
      url,
      width: oi.width as number | undefined,
      height: oi.height as number | undefined,
      alt: null,
      ...(poster ? { poster } : {}),
    });
  }
  return result;
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
  // 2026-05-17 嵌套引用:syndication API 返的 tweet 内部可能含 quoted_status_id_str
  // (X 原推自身又引用了另一条推)。之前 apiToQuoteOf 漏解析,导致 retweet_of / quote_of 内
  // 嵌套引用丢失(user sample 2055856657389785210:Peter 转 Blake,Blake 推可能含嵌套)。
  // 同时尝试取 inline quoted_tweet 对象(X API 有时直接返一层 inline)。
  const nestedQuoteId =
    (qt.quoted_status_id_str as string) ||
    (qt.quoted_status_id as string) ||
    null;
  const inlineQuotedTweet = qt.quoted_tweet as Record<string, unknown> | undefined;
  const verified =
    (user.verified as boolean) || (user.is_blue_verified as boolean);
  // metrics:任一字段有值就返 metrics object,全无就 undefined(FE 不显示 row)
  const metrics: NonNullable<QuoteOf["metrics"]> = {};
  if (typeof qt.conversation_count === "number") metrics.replies = qt.conversation_count;
  if (typeof qt.retweet_count === "number") metrics.retweets = qt.retweet_count;
  if (typeof qt.favorite_count === "number") metrics.likes = qt.favorite_count;
  if (typeof qt.view_count === "number") metrics.views = qt.view_count;
  const hasMetrics = Object.keys(metrics).length > 0;
  return {
    id: (qt.id_str as string) || null,
    author: (user.name as string) || null,
    handle: (user.screen_name as string) || null,
    content: (qt.text as string) || null,
    profile_image_url: (user.profile_image_url_https as string) || null,
    is_verified: verified ? 1 : 0,
    media,
    published_at: (qt.created_at as string) || null,
    ...(hasMetrics ? { metrics } : {}),
    // 嵌套引用:有 ID 就写;有 inline 对象 recursive parse
    ...(nestedQuoteId ? { quote_of_id: nestedQuoteId } : {}),
    ...(inlineQuotedTweet ? { quote_of: apiToQuoteOf(inlineQuotedTweet) } : {}),
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
    GITHUB_PIPELINE_WORKFLOW?: Workflow;
    HUODONGXING_DETAIL_WORKFLOW?: Workflow;
    READMES?: R2Bucket;
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
    // 治本 C：drawer 打开时如果检测到 stuck（未分类 / 未翻译 / 长推没拉 / 引用没回填），
    // trigger workflow 补全（helper 内部有 marker 30min 防重）。不 block refresh 响应。
    const xStuck = await env.DB.prepare(
      `SELECT extra FROM items WHERE id = ?
        AND source_type='x_list'
        AND (
          is_relevant IS NULL
          OR (is_relevant=1 AND content_translated IS NULL AND lang IS NOT NULL AND lang != 'zh' AND content IS NOT NULL AND length(content) > 0)
          OR (json_extract(extra,'$.longform.note_id') IS NOT NULL AND json_extract(extra,'$.longform.fetched_at') IS NULL)
          OR (json_extract(extra,'$.quote_of_id') IS NOT NULL AND json_extract(extra,'$.quote_of') IS NULL)
          OR (json_extract(extra,'$.reply_to_id') IS NOT NULL AND json_extract(extra,'$.reply_of') IS NULL)
        )`,
    ).bind(itemId).first<{ extra: string | null }>();
    if (xStuck) {
      const extraObj = xStuck.extra ? JSON.parse(xStuck.extra) as Record<string, unknown> : {};
      await triggerXWorkflowForItem(env, itemId, {
        hasQuoteRef: !!(extraObj.quote_of_id || extraObj.quote_of),
        hasReplyRef: !!(extraObj.reply_to_id || extraObj.reply_of_id || extraObj.reply_of),
        hasLinkCard: !!extraObj.link_card,
        hasRetweetRef: !!(extraObj.is_retweet || extraObj.retweeted_status_id || extraObj.retweet_of_id || extraObj.retweet_of),
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
    // 治本 C：drawer 检测 GH stuck（未分类 / README 没译 / R2 没迁），trigger workflow
    const ghStuck = await env.DB.prepare(
      `SELECT 1 FROM items WHERE id = ?
        AND source_type='github'
        AND (
          COALESCE(json_extract(extra, '$.gh_pending'), 0) IN (1, 'true')
          OR is_relevant IS NULL
          OR (is_relevant=1 AND json_extract(extra, '$.readme_translated') IS NULL
              AND COALESCE(json_extract(extra, '$.readme_lang'), 'other') != 'zh'
              AND json_extract(extra, '$.readme_excerpt') IS NOT NULL)
          OR (is_relevant=1 AND json_extract(extra, '$.r2_migrated_at') IS NULL
              AND json_extract(extra, '$.readme_excerpt') IS NOT NULL)
        )`,
    ).bind(itemId).first();
    if (ghStuck) {
      const { triggerGhWorkflowForItem: triggerGh } = await import('./github');
      await triggerGh(env, itemId);
    }
    return { refreshed: true, source_type: 'github', reason: 'success', metrics: r.metrics };
  }

  if (item.source_type === 'huodongxing') {
    // 治本 C：drawer 触发 hdx workflow（throttleSec=0 用户优先，无 metrics refresh）
    if (env.HUODONGXING_DETAIL_WORKFLOW) {
      const hdxStuck = await env.DB.prepare(
        `SELECT 1 FROM items WHERE id = ?
          AND source_type='huodongxing'
          AND json_extract(extra, '$.detail_enriched_at') IS NULL`,
      ).bind(itemId).first();
      if (hdxStuck) {
        const { triggerHdxWorkflowForItem } = await import('./scrapers/huodongxing');
        await triggerHdxWorkflowForItem(env, itemId, 0);  // 0 throttle = 立即 fetch
        return { refreshed: true, source_type: 'huodongxing', reason: 'success' };
      }
    }
    // 已 enriched 或 binding 缺失 — drawer 不做事
    return { refreshed: false, source_type: 'huodongxing', reason: 'throttled' };
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
    // 治本 C 阶段 6：drawer 检测 CH stuck (ch_pending=true) → trigger workflow
    const chStuck = await env.DB.prepare(
      `SELECT 1 FROM items WHERE id = ? AND source_type='clawhub'
        AND json_extract(extra, '$.ch_pending') = 1`,
    ).bind(itemId).first();
    if (chStuck && (env as { CH_PIPELINE_WORKFLOW?: Workflow }).CH_PIPELINE_WORKFLOW) {
      const { triggerChWorkflowForItem } = await import('./clawhub');
      await triggerChWorkflowForItem(env as { DB: D1Database; CH_PIPELINE_WORKFLOW?: Workflow }, itemId);
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
    // 治本 C 阶段 6：drawer 检测 PH stuck → trigger workflow
    const phStuck = await env.DB.prepare(
      `SELECT 1 FROM items WHERE id = ? AND source_type='product_hunt'
        AND (
          is_relevant IS NULL
          OR (is_relevant=1 AND json_extract(extra, '$.r2_migrated_at') IS NULL)
          OR (is_relevant=1 AND content IS NOT NULL AND content_translated IS NULL)
        )`,
    ).bind(itemId).first();
    if (phStuck && (env as { PH_PIPELINE_WORKFLOW?: Workflow }).PH_PIPELINE_WORKFLOW) {
      const { triggerPhWorkflowForItem } = await import('./scrapers/ph');
      await triggerPhWorkflowForItem(env as { DB: D1Database; PH_PIPELINE_WORKFLOW?: Workflow }, itemId);
    }
    return { refreshed: true, source_type: 'product_hunt', reason: 'success', metrics: r.metrics };
  }

  if (item.source_type === 'hf_paper') {
    // hf_paper:复用 workflow Step 0/Step 1 的 refresh helper(动态 import 避免循环依赖)
    // 1. HF API /papers/<arxiv_id> 刷 detail(upvotes / githubRepo / githubStars / paper_authors / ai_summary)
    // 2. 如果 hasGhRepo → 调 GitHub API 拿最新 stars(覆盖 HF API 的旧 stars)
    const arxivId = String(item.source_id);
    try {
      const { refreshPaperDetailForHf } = await import('./hf-paper/api');
      await refreshPaperDetailForHf(env as Parameters<typeof refreshPaperDetailForHf>[0], item.id, arxivId);
    } catch (e) {
      console.error(`[refresh-single:hf_paper] ${item.id} refreshPaperDetail exception`, e);
    }
    // GH stars(若 hasGhRepo)
    try {
      const hasRepo = await env.DB.prepare(
        `SELECT json_extract(extra, '$.github_repo') AS repo FROM items WHERE id = ?`,
      ).bind(item.id).first<{ repo: string | null }>();
      if (hasRepo?.repo) {
        const { refreshGhStarForHfPaper } = await import('./hf-paper/media');
        await refreshGhStarForHfPaper(env as Parameters<typeof refreshGhStarForHfPaper>[0], item.id);
      }
    } catch (e) {
      console.error(`[refresh-single:hf_paper] ${item.id} refreshGhStar exception`, e);
    }
    // discussion + 翻译 + comment 内 <img> 抓 R2 已拆到独立 endpoint
    // POST /api/items/:id/refresh-hf-discussion(FE drawer mount 并发调用,
    // 单独 15s timeout 避开通用 /refresh 的 5s FETCH_TIMEOUT_MS cap)
    // 拉刷新后的 metrics 给 FE(同其他 source 模式)
    const updated = await env.DB.prepare(
      `SELECT metrics FROM items WHERE id = ?`,
    ).bind(item.id).first<{ metrics: string | null }>();
    let metrics: Metrics = {};
    if (updated?.metrics) {
      try { metrics = JSON.parse(updated.metrics) || {}; } catch { /* ignore */ }
    }
    if (env.AUTH_KV) {
      await env.AUTH_KV.put(REFRESH_THROTTLE_KEY_PREFIX + itemId, String(Date.now()), {
        expirationTtl: REFRESH_THROTTLE_TTL,
      });
    }
    return { refreshed: true, source_type: 'hf_paper', reason: 'success', metrics };
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
  // 数据失效级联(2026-05-17 批 2):关联字段(quote/reply/retweet/link_card)更新时,
  // 清掉 main content_translated + translated_at,让 stuck 检测命中 → workflow trigger → 重翻所有字段。
  // 关联字段自身的 content_translated 已经被 extra.quote_of = patch.quote_of 等"整体覆盖"隐式清掉。
  // 不动 stuck 检测条件,完全依赖 main content_translated NULL 作为触发信号。
  const hasContentChange =
    patch.quote_of !== undefined ||
    patch.reply_of !== undefined ||
    patch.retweet_of !== undefined ||
    patch.link_card !== undefined;
  if (hasContentChange) {
    updates.push("content_translated = NULL");
    updates.push("translated_at = NULL");
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
    const newItemsForWorkflow: Array<{
      itemId: string;
      hasQuoteRef: boolean;
      hasReplyRef: boolean;
      hasLinkCard: boolean;
      hasRetweetRef: boolean;
    }> = [];
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
      if (!existingSet.has(id)) {
        newCount++;
        // 解析 item.extra 拿 workflow signals（quote / reply / link_card / retweet）
        let extraObj: Record<string, unknown> = {};
        try {
          extraObj = JSON.parse(item.extra || '{}') as Record<string, unknown>;
        } catch { /* ignore */ }
        newItemsForWorkflow.push({
          itemId: id,
          hasQuoteRef: !!(extraObj.quote_of_id || extraObj.quote_of),
          hasReplyRef: !!(extraObj.reply_to_id || extraObj.reply_of_id || extraObj.reply_of),
          hasLinkCard: !!extraObj.link_card,
          hasRetweetRef: !!(extraObj.is_retweet || extraObj.retweeted_status_id || extraObj.retweet_of_id || extraObj.retweet_of),
        });
      } else {
        inserted++; // 实际是 update
      }
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

    // 阶段 4 cutover：D1 batch 成功后，对每条新 tweet 触发 XTweetPipelineWorkflow
    // instance（helper 写 marker + create）。
    if (env.X_TWEET_PIPELINE_WORKFLOW && newItemsForWorkflow.length > 0) {
      for (const n of newItemsForWorkflow) {
        await triggerXWorkflowForItem(env, n.itemId, {
          hasQuoteRef: n.hasQuoteRef,
          hasReplyRef: n.hasReplyRef,
          hasLinkCard: n.hasLinkCard,
          hasRetweetRef: n.hasRetweetRef,
        });
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
        model: 'deepseek-v4-flash',
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
export const DEEPSEEK_URL = "https://gateway.ai.cloudflare.com/v1/0d13b65d05d5d29fe06998141f3b0f9a/aifeeds-deepseek/deepseek/chat/completions";
const DEEPSEEK_MODEL = "deepseek-v4-flash";

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

export const PH_ENRICH_PROMPT = `你是 AI 产品分类员。判断每个 Product Hunt 产品是否 AI 相关，是 AI 相关时给出分类和一句中文解读。

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
        model: 'deepseek-v4-flash',
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
      model: 'deepseek-v4-flash',
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
/**
 * Workflow Step 0: 检测 X scraper DOM 截断，从 syndication API 补全 content。
 *
 * 根因（2026-05-17）：SB list-poll mode 不返 full_text 字段，scrapebadger.ts
 * sbTweetToIngestItem fallback 到 t.text（X list 页 DOM 显示的 ~140 字符 "Show
 * more" 前内容）。导致 ~5% X tweets 入库时 content 末尾 …，下游 classify /
 * translate / feed 显示都是截断版。
 *
 * 治本：每条新 tweet 进 workflow 时 step 0 检查截断，调 syndication API
 * (cdn.syndication.twimg.com，免费 + 对老 tweet 仍有效) 拿完整 text，UPDATE content。
 * note_tweet 长推优先用 note_tweet.text（最长 25k）。
 *
 * 副作用：标 extra.longform.fetched_at (避免后续 backfill 重抓) +
 *         extra.longform.backfill_source ('note_tweet' | 'syndication')。
 *
 * 失败兜底：syndication 找不到（404）→ 标 fetch_error='syndication_404' 不再重试。
 * 异常（network etc）→ throw，让 workflow step retry 兜底。
 */
export async function backfillTruncatedTextForXTweet(
  env: EnrichEnv,
  itemId: string,
): Promise<{
  updated: boolean;
  from_chars: number;
  to_chars: number;
  source: 'note_tweet' | 'syndication' | 'skipped' | 'not_found';
}> {
  const row = await env.DB.prepare(
    `SELECT id, source_id, content, extra FROM items WHERE id = ? AND source_type = 'x_list'`,
  ).bind(itemId).first<{ id: string; source_id: string; content: string | null; extra: string | null }>();
  if (!row) throw new Error(`backfillTruncatedTextForXTweet: item not found ${itemId}`);

  const content = row.content || '';
  // 截断判定：末尾 unicode … (U+2026) + 长度 100-200（X list page DOM 截断区间，
  // 多数 140 字符，留一些容差给 emoji / 引号包围导致的 ±20 chars 偏差）。
  if (!content.endsWith('…') || content.length < 100 || content.length > 200) {
    return { updated: false, from_chars: content.length, to_chars: content.length, source: 'skipped' };
  }

  const res = await fetchTweet(row.source_id);
  if (res === null) {
    throw new Error(`backfillTruncatedTextForXTweet: fetchTweet failed ${row.source_id}`);
  }
  if (res.notFound || !res.data) {
    // tweet 删了 / 私密 / 受限 — 标 fetch_error 避免后续 backfill cron 重抓
    await env.DB.prepare(
      `UPDATE items
         SET extra = json_set(coalesce(extra,'{}'),
                              '$.longform.fetch_error', 'syndication_404',
                              '$.longform.fetched_at', ?)
         WHERE id = ?`,
    ).bind(new Date().toISOString(), itemId).run();
    return { updated: false, from_chars: content.length, to_chars: content.length, source: 'not_found' };
  }

  // 优先 note_tweet.text（X Premium 长推，最长 25k），fallback 普通 text（280 字 max）
  const nt = res.data.note_tweet as Record<string, unknown> | undefined;
  let fullText: string;
  let source: 'note_tweet' | 'syndication';
  if (nt) {
    const ntText = (nt.text as string) || '';
    if (ntText.length > content.length) {
      fullText = ntText;
      source = 'note_tweet';
    } else {
      fullText = (res.data.text as string) || '';
      source = 'syndication';
    }
  } else {
    fullText = (res.data.text as string) || '';
    source = 'syndication';
  }

  // 长度未增加 → 不更新（syndication 也返截断的退化场景；标 fetched_at 防重试）
  if (fullText.length <= content.length) {
    await env.DB.prepare(
      `UPDATE items
         SET extra = json_set(coalesce(extra,'{}'),
                              '$.longform.fetched_at', ?,
                              '$.longform.backfill_source', 'syndication_same_length')
         WHERE id = ?`,
    ).bind(new Date().toISOString(), itemId).run();
    return { updated: false, from_chars: content.length, to_chars: content.length, source: 'skipped' };
  }

  // 数据失效级联(2026-05-17 批 2):content 改了(短截断 → 完整长版),
  // 旧 content_translated 基于截断版翻译失效,清掉让 workflow 重翻。
  await env.DB.prepare(
    `UPDATE items
       SET content = ?,
           content_translated = NULL,
           translated_at = NULL,
           extra = json_set(coalesce(extra,'{}'),
                            '$.longform.fetched_at', ?,
                            '$.longform.backfill_source', ?)
       WHERE id = ?`,
  ).bind(fullText, new Date().toISOString(), source, itemId).run();
  console.log(`[x-workflow:step0] ${itemId}: ${content.length} → ${fullText.length} chars (${source}) + cleared translation`);
  return { updated: true, from_chars: content.length, to_chars: fullText.length, source };
}

// ═══════════════════════════════════════════════════════════════════════════
// backfillMediaForXTweet — 2026-05-17 用户反馈"X 有图片/视频但 aifeeds media=[]"
//
// 根因:SB scraper sbTweetToIngestItem ingest 时 t.media 可能为空(SB API 偶发漏返
// 或某些 tweet 的 mediaDetails 在 SB 那边不全),mapMedia 返 [],workflow 不补 media。
// 解决:workflow step + cron 兜底用 syndication API 拉完整 mediaDetails 重填 media。
//
// 行为:
// - 调 fetchTweet(syndication API)拿完整 data
// - 提取 mediaDetails(photo / video / animated_gif)+ video mp4 url
// - 跟 D1 当前 media 比较,新提取的 >= 当前才覆盖(避免误删)
// - 标 extra.media_backfilled_at(成功 / 失败都标,防 cron 重复跑)
// - 失败兜底 — syndication 404 也标记 attempted,不阻塞 workflow
// ═══════════════════════════════════════════════════════════════════════════

export async function backfillMediaForXTweet(
  env: EnrichEnv,
  itemId: string,
): Promise<{
  updated: boolean;
  before_count: number;
  after_count: number;
  reason?: 'already_attempted' | 'syndication_not_found' | 'no_media' | 'no_improvement';
}> {
  const row = await env.DB.prepare(
    `SELECT id, source_id, media, extra FROM items WHERE id = ? AND source_type='x_list'`,
  ).bind(itemId).first<{ id: string; source_id: string; media: string | null; extra: string | null }>();
  if (!row) throw new Error(`backfillMediaForXTweet: item not found ${itemId}`);

  let extra: Record<string, unknown> = {};
  try { extra = row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : {}; } catch { /* ignore */ }
  if (extra.media_backfilled_at) {
    return { updated: false, before_count: 0, after_count: 0, reason: 'already_attempted' };
  }

  let currentMedia: Array<unknown> = [];
  try { currentMedia = row.media ? JSON.parse(row.media) : []; } catch { /* ignore */ }
  const beforeCount = currentMedia.length;

  const nowIso = new Date().toISOString();
  const res = await fetchTweet(row.source_id);
  if (!res || res.notFound || !res.data) {
    // syndication 404 / 网络失败 — 标 attempted 避免 cron 重复跑
    await env.DB.prepare(
      `UPDATE items SET extra = json_set(coalesce(extra,'{}'), '$.media_backfilled_at', ?) WHERE id = ?`,
    ).bind(nowIso, itemId).run();
    return { updated: false, before_count: beforeCount, after_count: beforeCount, reason: 'syndication_not_found' };
  }

  const newMedia = mediaFromSyndicationData(res.data as Record<string, unknown>);
  const afterCount = newMedia.length;

  // syndication 也没 media — 标 attempted 不重试(可能是纯文本推或 mediaDetails 缺)
  if (afterCount === 0) {
    await env.DB.prepare(
      `UPDATE items SET extra = json_set(coalesce(extra,'{}'), '$.media_backfilled_at', ?) WHERE id = ?`,
    ).bind(nowIso, itemId).run();
    return { updated: false, before_count: beforeCount, after_count: 0, reason: 'no_media' };
  }

  // syndication 更全(或当前空)→ 覆盖 + 标 attempted
  if (afterCount > beforeCount || beforeCount === 0) {
    await env.DB.prepare(
      `UPDATE items SET media = ?, extra = json_set(coalesce(extra,'{}'), '$.media_backfilled_at', ?) WHERE id = ?`,
    ).bind(JSON.stringify(newMedia), nowIso, itemId).run();
    console.log(`[x-workflow:backfill-media] ${itemId}: ${beforeCount} → ${afterCount} media items`);
    return { updated: true, before_count: beforeCount, after_count: afterCount };
  }

  // 当前 media 已 >= syndication,不动 — 标 attempted
  await env.DB.prepare(
    `UPDATE items SET extra = json_set(coalesce(extra,'{}'), '$.media_backfilled_at', ?) WHERE id = ?`,
  ).bind(nowIso, itemId).run();
  return { updated: false, before_count: beforeCount, after_count: afterCount, reason: 'no_improvement' };
}

// ═══════════════════════════════════════════════════════════════════════════
// backfillLinkCardForXTweet — 2026-05-17 user 反馈 dotey 推文 t.co 链接没卡片
//
// 根因:syndication API 对纯外链推文返 card=null + entities.urls=[],我们没数据。
// 但 X 网页端会自动抓外链 OG meta 渲染 link preview card。
// 解决:scan content 内 t.co URL → 跟随跳转 → 抓 HTML 解析 OG meta → 写 link_card。
//
// 行为:
// - 检查 extra.link_card_backfilled_at(防重复)+ 已有 link_card 跳过
// - regex 匹配 https://t.co/XXX,取最后一个(X 通常显示最后 URL 的预览)
// - HEAD t.co 拿 Location header redirect URL
// - GET redirect URL HTML(200KB 上限,8s timeout)
// - 正则解析 og:title / og:description / og:image / og:url
// - 写 extra.link_card = { url, display_url, title, description, domain, image_url }
// - 任何失败都标 backfilled_at 防 cron 重试
// ═══════════════════════════════════════════════════════════════════════════

function parseOgMeta(html: string): {
  title?: string;
  description?: string;
  image?: string;
  url?: string;
  video?: string;
} {
  const get = (prop: string): string | undefined => {
    // <meta property="og:image" content="...">
    const m1 = html.match(
      new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
    );
    if (m1) return m1[1];
    // content 在 property 之前的变体
    const m2 = html.match(
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'),
    );
    if (m2) return m2[1];
    return undefined;
  };
  return {
    title: get('og:title') || get('twitter:title'),
    description: get('og:description') || get('twitter:description'),
    image: get('og:image') || get('twitter:image'),
    url: get('og:url'),
    // 2026-05-18 加视频字段:外链是 YouTube / 视频站时,og:video 给可播放 URL
    video:
      get('og:video') ||
      get('og:video:url') ||
      get('og:video:secure_url') ||
      get('twitter:player:stream') ||
      get('twitter:player'),
  };
}

export async function backfillLinkCardForXTweet(
  env: EnrichEnv,
  itemId: string,
): Promise<{
  updated: boolean;
  reason?:
    | 'already_attempted'
    | 'no_url'
    | 'redirect_failed'
    | 'html_fetch_failed'
    | 'no_og_meta'
    | 'success';
}> {
  const row = await env.DB.prepare(
    `SELECT id, content, extra FROM items WHERE id = ? AND source_type='x_list'`,
  ).bind(itemId).first<{ id: string; content: string | null; extra: string | null }>();
  if (!row) throw new Error(`backfillLinkCardForXTweet: item not found ${itemId}`);

  let extra: Record<string, unknown> = {};
  try { extra = row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : {}; } catch { /* ignore */ }

  // 已尝试过 → 跳过
  if (extra.link_card_backfilled_at) {
    return { updated: false, reason: 'already_attempted' };
  }

  // 已有 link_card → 标记防 cron 重跑
  if (extra.link_card) {
    await env.DB.prepare(
      `UPDATE items SET extra = json_set(coalesce(extra,'{}'), '$.link_card_backfilled_at', ?) WHERE id = ?`,
    ).bind(new Date().toISOString(), itemId).run();
    return { updated: false, reason: 'already_attempted' };
  }

  const content = row.content || '';
  const tcoUrls = content.match(/https:\/\/t\.co\/\w+/g) || [];
  const nowIso = new Date().toISOString();

  if (tcoUrls.length === 0) {
    await env.DB.prepare(
      `UPDATE items SET extra = json_set(coalesce(extra,'{}'), '$.link_card_backfilled_at', ?) WHERE id = ?`,
    ).bind(nowIso, itemId).run();
    return { updated: false, reason: 'no_url' };
  }

  // X 通常 link preview 取最后一个 URL
  const tcoUrl = tcoUrls[tcoUrls.length - 1];

  // 1. HEAD t.co 拿 redirect URL
  let redirectUrl: string | null = null;
  try {
    const headRes = await fetch(tcoUrl, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    redirectUrl = headRes.headers.get('location') || null;
  } catch (e) {
    console.warn(`[backfill-link-card] HEAD ${tcoUrl} failed: ${String(e)}`);
  }

  if (!redirectUrl) {
    await env.DB.prepare(
      `UPDATE items SET extra = json_set(coalesce(extra,'{}'), '$.link_card_backfilled_at', ?) WHERE id = ?`,
    ).bind(nowIso, itemId).run();
    return { updated: false, reason: 'redirect_failed' };
  }

  // 2. GET HTML(200KB 上限)
  let html: string | null = null;
  try {
    const htmlRes = await fetch(redirectUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AifeedsLinkBot/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    if (htmlRes.ok) {
      const buf = await htmlRes.arrayBuffer();
      const slice = buf.slice(0, 200 * 1024); // 200KB
      html = new TextDecoder('utf-8').decode(slice);
    }
  } catch (e) {
    console.warn(`[backfill-link-card] GET ${redirectUrl} failed: ${String(e)}`);
  }

  if (!html) {
    await env.DB.prepare(
      `UPDATE items SET extra = json_set(coalesce(extra,'{}'), '$.link_card_backfilled_at', ?) WHERE id = ?`,
    ).bind(nowIso, itemId).run();
    return { updated: false, reason: 'html_fetch_failed' };
  }

  // 3. parse OG meta
  const og = parseOgMeta(html);
  if (!og.title && !og.image) {
    await env.DB.prepare(
      `UPDATE items SET extra = json_set(coalesce(extra,'{}'), '$.link_card_backfilled_at', ?) WHERE id = ?`,
    ).bind(nowIso, itemId).run();
    return { updated: false, reason: 'no_og_meta' };
  }

  // 4. domain
  let domain: string | null = null;
  try {
    const u = new URL(redirectUrl);
    domain = u.hostname.replace(/^www\./, '');
  } catch { /* ignore */ }

  const linkCard: Record<string, unknown> = {
    url: og.url || redirectUrl,
    display_url: domain || redirectUrl,
    title: og.title || null,
    description: og.description || null,
    domain,
    image_url: og.image || null,
  };
  // 2026-05-18 加视频地址:有 og:video 时 FE 用视频组件渲染(YouTube / Vimeo / 其他视频站)
  if (og.video) {
    linkCard.video_url = og.video;
  }

  // 5. 写 extra.link_card
  const newExtra = { ...extra, link_card: linkCard, link_card_backfilled_at: nowIso };
  await env.DB.prepare(
    `UPDATE items SET extra = ? WHERE id = ?`,
  ).bind(JSON.stringify(newExtra), itemId).run();
  console.log(`[backfill-link-card] ${itemId}: ${redirectUrl} → og.title=${og.title?.slice(0, 30) || ''} og.image=${og.image ? 'yes' : 'no'}`);
  return { updated: true, reason: 'success' };
}

// ═══════════════════════════════════════════════════════════════════════════
// backfillNestedXQuoteForXTweet — 2026-05-18 user 反馈 sample 2055798529327825294
//
// 根因:推文正文里嵌 x.com/.../status/(\d+) URL,X 原页面渲染成 quote tweet preview
// (完整原推 + 视频),但 SB ingest 时没识别这种"内嵌 X URL"为 quote → quote_of_id 空
// → 走外链卡片路径只抓到 og 截断(文案少 + 视频缺)。
//
// 修:scan content 找 x.com URL → 提取 status_id → 写 quote_of_id → inline 调
// backfillQuoteForXTweet 拉完整原推数据(含 media + 翻译)。
//
// 行为:
// - extra.quote_of_id 已存在 / extra.nested_x_quote_backfilled_at 已存在 → 跳过
// - 优先扫直接 x.com / twitter.com URL
// - fallback 扫 t.co URL → HEAD 跟随跳转 → match x.com pattern
// - 找到 status_id → 写 extra.quote_of_id + 立即调 backfillQuoteForXTweet
// - 任何情况都标 nested_x_quote_backfilled_at 防 cron 重试
// ═══════════════════════════════════════════════════════════════════════════

export async function backfillNestedXQuoteForXTweet(
  env: EnrichEnv,
  itemId: string,
): Promise<{
  updated: boolean;
  found_quote_id?: string;
  reason?:
    | 'already_attempted'
    | 'no_url'
    | 'no_x_url'
    | 'quote_filled'
    | 'quote_backfill_failed';
}> {
  const row = await env.DB.prepare(
    `SELECT id, source_id, content, extra FROM items WHERE id = ? AND source_type='x_list'`,
  ).bind(itemId).first<{ id: string; source_id: string; content: string | null; extra: string | null }>();
  if (!row) throw new Error(`backfillNestedXQuoteForXTweet: item not found ${itemId}`);

  let extra: Record<string, unknown> = {};
  try { extra = row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : {}; } catch { /* ignore */ }

  // 已尝试 → 跳过
  if (extra.nested_x_quote_backfilled_at) {
    return { updated: false, reason: 'already_attempted' };
  }
  // 已有 quote_of_id → 标记不重试(已通过其他路径写过)
  if (extra.quote_of_id) {
    await env.DB.prepare(
      `UPDATE items SET extra = json_set(coalesce(extra,'{}'), '$.nested_x_quote_backfilled_at', ?) WHERE id = ?`,
    ).bind(new Date().toISOString(), itemId).run();
    return { updated: false, reason: 'already_attempted' };
  }

  const content = row.content || '';
  const nowIso = new Date().toISOString();

  // 1. 优先扫直接 x.com / twitter.com URL
  const directXMatch = content.match(/https?:\/\/(?:x|twitter)\.com\/[^\s\/]+\/status\/(\d+)/i);
  let foundStatusId: string | null = directXMatch ? directXMatch[1] : null;

  // 2. fallback 扫 t.co URL → HEAD redirect → match x.com pattern
  if (!foundStatusId) {
    const tcoUrls = content.match(/https:\/\/t\.co\/\w+/g) || [];
    for (const tcoUrl of tcoUrls) {
      try {
        const headRes = await fetch(tcoUrl, {
          method: 'HEAD',
          redirect: 'manual',
          signal: AbortSignal.timeout(5000),
        });
        const location = headRes.headers.get('location');
        if (location) {
          const m = location.match(/^https?:\/\/(?:x|twitter)\.com\/[^\/]+\/status\/(\d+)/i);
          if (m) {
            foundStatusId = m[1];
            break;
          }
        }
      } catch (e) {
        console.warn(`[nested-x-quote] HEAD ${tcoUrl} failed: ${String(e)}`);
      }
    }
    if (!foundStatusId && tcoUrls.length === 0) {
      // 完全没 URL
      await env.DB.prepare(
        `UPDATE items SET extra = json_set(coalesce(extra,'{}'), '$.nested_x_quote_backfilled_at', ?) WHERE id = ?`,
      ).bind(nowIso, itemId).run();
      return { updated: false, reason: 'no_url' };
    }
  }

  if (!foundStatusId) {
    // 有 URL 但不是 x.com → 标 attempted 让 link_card 路径处理
    await env.DB.prepare(
      `UPDATE items SET extra = json_set(coalesce(extra,'{}'), '$.nested_x_quote_backfilled_at', ?) WHERE id = ?`,
    ).bind(nowIso, itemId).run();
    return { updated: false, reason: 'no_x_url' };
  }

  // 3. 找到嵌 X URL → 写 quote_of_id + 标 attempted
  const newExtra = { ...extra, quote_of_id: foundStatusId, nested_x_quote_backfilled_at: nowIso };
  await env.DB.prepare(
    `UPDATE items SET extra = ? WHERE id = ?`,
  ).bind(JSON.stringify(newExtra), itemId).run();

  // 4. 立即 inline 调 backfillQuoteForXTweet 拉完整原推数据(media + 翻译走 step 3)
  try {
    await backfillQuoteForXTweet(env, itemId);
  } catch (e) {
    console.warn(`[nested-x-quote] ${itemId}: backfillQuote failed: ${String(e)}`);
    return { updated: true, found_quote_id: foundStatusId, reason: 'quote_backfill_failed' };
  }

  console.log(`[nested-x-quote] ${itemId}: found X quote ${foundStatusId} + backfilled`);
  return { updated: true, found_quote_id: foundStatusId, reason: 'quote_filled' };
}

// ═══════════════════════════════════════════════════════════════════════════
// resolveTcoLinksForXTweet — 2026-05-21 user 反馈 t.co-only content L3 没翻译
//
// 根因:X tweet 内容只是一个 t.co 短链(典型情况是 retweet/quote 一个 X article,
// X DOM 把 article 链接转 t.co),syndication API 返的 content = "https://t.co/xxx"
// 一串。DeepSeek 拿不到 article 内容,翻译永远返 null → FE 显示一坨没意义的 t.co URL。
//
// 解决:逐个 path 检测 content === t.co-only,HEAD t.co 拿 redirect URL,写
// content_resolved_url 字段(指向 x.com/i/article/<id> 或外站 URL)。FE 后续
// 渲染 link card "查看原文 ↗" 而不是裸 t.co。
//
// 6 个 path 覆盖:L1 main + L2 (quote_of / reply_of / retweet_of) + L3 (各自的 quote_of)
// 已有 content_resolved_url / content_resolve_failed_at sentinel → 跳过
// 防 cron 重试。失败永久标 failed_at(t.co 一般稳定,失败大多是 deleted 短链)。
// ═══════════════════════════════════════════════════════════════════════════

const TCO_ONLY_RE = /^https?:\/\/t\.co\/[a-zA-Z0-9]+\s*$/i;

function isTcoOnlyContent(content: string | null | undefined): boolean {
  if (!content || typeof content !== 'string') return false;
  return TCO_ONLY_RE.test(content.trim());
}

async function resolveTcoToFinalUrl(tcoUrl: string): Promise<string | null> {
  try {
    const res = await fetch(tcoUrl, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    return res.headers.get('location');
  } catch (e) {
    console.warn(`[tco-resolve] HEAD ${tcoUrl} failed: ${String(e).slice(0, 200)}`);
    return null;
  }
}

export async function resolveTcoLinksForXTweet(
  env: EnrichEnv,
  itemId: string,
): Promise<{ resolved: number; failed: number; skipped: number; mutated: boolean }> {
  const row = await env.DB.prepare(
    `SELECT id, content, extra FROM items WHERE id = ? AND source_type='x_list'`,
  ).bind(itemId).first<{ id: string; content: string | null; extra: string | null }>();
  if (!row) throw new Error(`resolveTcoLinksForXTweet: item not found ${itemId}`);

  let extra: Record<string, unknown> = {};
  try { extra = row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : {}; } catch { /* ignore */ }

  const newExtra: Record<string, unknown> = { ...extra };
  const nowIso = new Date().toISOString();
  let resolved = 0;
  let failed = 0;
  let skipped = 0;
  let mutated = false;

  // 单字段处理 helper:isTcoOnly + 无 sentinel → HEAD → 写 resolved_url 或 failed_at
  // 返回新对象(若 mutated)或 null(若 skip)。caller 决定要不要写回 newExtra。
  const resolveContentField = async (
    obj: Record<string, unknown>,
    contentVal: string | null | undefined,
  ): Promise<Record<string, unknown> | null> => {
    if (!isTcoOnlyContent(contentVal)) return null;
    if (obj.content_resolved_url || obj.content_resolve_failed_at) {
      skipped++;
      return null;
    }
    const url = await resolveTcoToFinalUrl(contentVal!.trim());
    if (url) {
      resolved++;
      return { ...obj, content_resolved_url: url, content_resolved_at: nowIso };
    } else {
      failed++;
      return { ...obj, content_resolve_failed_at: nowIso };
    }
  };

  // L1 main content (extra root level field)
  if (isTcoOnlyContent(row.content)) {
    if (extra.content_resolved_url || extra.content_resolve_failed_at) {
      skipped++;
    } else {
      const url = await resolveTcoToFinalUrl(row.content!.trim());
      if (url) {
        newExtra.content_resolved_url = url;
        newExtra.content_resolved_at = nowIso;
        resolved++;
      } else {
        newExtra.content_resolve_failed_at = nowIso;
        failed++;
      }
      mutated = true;
    }
  }

  // L2 + L3:quote_of / reply_of / retweet_of 各自 + 其内嵌 quote_of
  for (const l2Key of ['quote_of', 'reply_of', 'retweet_of'] as const) {
    const l2 = extra[l2Key] as Record<string, unknown> | undefined;
    if (!l2) continue;
    let newL2 = l2;
    let l2Mutated = false;

    // L2 content
    const l2Updated = await resolveContentField(l2, l2.content as string | undefined);
    if (l2Updated) {
      newL2 = l2Updated;
      l2Mutated = true;
    }

    // L3 quote_of (nested inside L2)
    const l3 = newL2.quote_of as Record<string, unknown> | undefined;
    if (l3) {
      const l3Updated = await resolveContentField(l3, l3.content as string | undefined);
      if (l3Updated) {
        newL2 = { ...newL2, quote_of: l3Updated };
        l2Mutated = true;
      }
    }

    if (l2Mutated) {
      newExtra[l2Key] = newL2;
      mutated = true;
    }
  }

  if (mutated) {
    await env.DB.prepare(
      `UPDATE items SET extra = ? WHERE id = ?`,
    ).bind(JSON.stringify(newExtra), itemId).run();
    console.log(`[tco-resolve] ${itemId}: resolved=${resolved} failed=${failed} skipped=${skipped}`);
  }

  return { resolved, failed, skipped, mutated };
}

// ═══════════════════════════════════════════════════════════════════════════
// fetchXArticlesForXTweet — 2026-05-21 PR5
//
// 配套 PR #99 t.co resolve:扫 6 个 path 哪些 content_resolved_url 是
// https://x.com/i/article/<id>,调 SB endpoint 拿 article 内容 + author。
//
// 行为:
// - 每个 path 已有 content_resolved_url + 未有 x_article(也未标 fetch_failed_at)
// - 调 fetchXArticleViaSb(2 credit/article = detail + author search)
// - 写 extra.{path}.x_article = { article_id, title, excerpt, cover_image_url,
//                                  summary_text, author_handle, author_name,
//                                  fetched_at }
// - 失败 graceful:写 fetch_failed_at + reason,不抛
// - 老 article(SB 反索引)detail null 但 author 仍可拿 → 标 fetched_at + 部分字段 null,
//   FE 看到 author_handle 有 + title 无时降级 mid card
// ═══════════════════════════════════════════════════════════════════════════

interface XArticleStub {
  article_id: string;
  title: string | null;
  excerpt: string | null;
  cover_image_url: string | null;
  summary_text: string | null;
  author_handle: string | null;
  author_name: string | null;
  // Phase 1 (syndication, no auth): title/excerpt/cover/author
  fetched_at?: string;
  fetch_failed_at?: string;
  fetch_failed_reason?: string;
  // Phase 2 (X GraphQL, auth cookie required): article body 全文
  // body 字段独立成 mutex 集合 — title/excerpt 失败不影响 body 流程,反之亦然
  body?: string | null;
  body_fetched_at?: string;
  body_fetch_failed_at?: string;
  body_fetch_failed_reason?: string;
  // 翻译(title/excerpt/body 同一次 DeepSeek 调用,所以共用 translated_at/skipped/failed)
  title_translated?: string;
  excerpt_translated?: string;
  body_translated?: string;
  translated_at?: string;
  translate_skipped_at?: string;
  translate_failed_at?: string;
  translate_failed_reason?: string;
  // body 单字段 sentinel:超长 body(>15000 字符)跳过 body 翻译,不影响 title/excerpt
  body_translate_skipped_at?: string;
  body_translate_skipped_reason?: string;
}

export async function fetchXArticlesForXTweet(
  env: EnrichEnv,
  itemId: string,
): Promise<{ fetched: number; failed: number; skipped: number; mutated: boolean; credits: number }> {
  // 2026-05-21 重构:用 X public syndication API 替代 SB article endpoint。
  // 根因:SB tweets/article/<id> endpoint 极度不可靠 — lazy fetch + 极短 evict,
  // 实测 spike 验过的 article 几小时后重测 100% null content。
  // 解法:syndication tweet-result?id=<tweet_id> 公开 API,response.article 字段
  // 含 rest_id/title/preview_text/cover_media。免费 + 可靠 + 老 article 也工作。
  // 路径:对每个 path,用该 path 的 tweet id(L1=row.source_id / L2=obj.id /
  // L3=nested.id)调 syndication → article 字段 + user 字段(=article author)。
  const { extractXArticleId } = await import('./scrapebadger');

  const row = await env.DB.prepare(
    `SELECT id, source_id, extra FROM items WHERE id = ? AND source_type='x_list'`,
  ).bind(itemId).first<{ id: string; source_id: string; extra: string | null }>();
  if (!row) throw new Error(`fetchXArticlesForXTweet: item not found ${itemId}`);

  let extra: Record<string, unknown> = {};
  try { extra = row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : {}; } catch { /* ignore */ }

  const newExtra: Record<string, unknown> = { ...extra };
  const nowIso = new Date().toISOString();
  let fetched = 0;
  let failed = 0;
  let skipped = 0;
  let mutated = false;

  // 单字段处理:tweetId 是该 path 对应的 tweet id(L1 是 row.source_id,L2/L3 是 obj.id)。
  // 调 syndication on tweetId,从 response.article 抽 metadata,response.user 抽 author。
  const processField = async (
    obj: Record<string, unknown>,
    resolvedUrlKey: string,
    xArticleKey: string,
    tweetId: string | null | undefined,
  ): Promise<Record<string, unknown> | null> => {
    const resolvedUrl = obj[resolvedUrlKey] as string | undefined;
    const articleId = extractXArticleId(resolvedUrl);
    if (!articleId) return null;
    const existing = obj[xArticleKey] as XArticleStub | undefined;
    if (existing && (existing.fetched_at || existing.fetch_failed_at)) {
      skipped++;
      return null;
    }
    if (!tweetId) {
      // 该 path 没 tweet id 无法 syndication 查 — 标 failed
      const stub: XArticleStub = {
        article_id: articleId,
        title: null, excerpt: null, cover_image_url: null, summary_text: null,
        author_handle: null, author_name: null,
        fetch_failed_at: nowIso, fetch_failed_reason: 'no_tweet_id',
      };
      failed++;
      return { ...obj, [xArticleKey]: stub };
    }

    let synd;
    try {
      synd = await fetchTweet(tweetId);
    } catch {
      synd = null;
    }

    const stub: XArticleStub = {
      article_id: articleId,
      title: null, excerpt: null, cover_image_url: null, summary_text: null,
      author_handle: null, author_name: null,
    };

    if (!synd || synd.notFound || !synd.data) {
      stub.fetch_failed_at = nowIso;
      stub.fetch_failed_reason = synd?.notFound ? 'tweet_404' : 'syndication_http';
      failed++;
      return { ...obj, [xArticleKey]: stub };
    }

    const data = synd.data as Record<string, unknown>;
    const user = data.user as Record<string, unknown> | undefined;
    const article = data.article as Record<string, unknown> | undefined;

    // user 字段几乎总能拿到(tweet 存在则有 user) — 作 author 兜底
    stub.author_handle = (user?.screen_name as string) || null;
    stub.author_name = (user?.name as string) || null;

    if (!article) {
      // tweet 存在但没 article 字段 — 该 tweet 不是 article tweet(可能 t.co 指向 article
      // 但该 tweet 只是文本提到 article URL,article tweet 是另一条)。
      // 仍 mark failed 但 author 保留。
      stub.fetch_failed_at = nowIso;
      stub.fetch_failed_reason = 'no_article_in_tweet';
      failed++;
      return { ...obj, [xArticleKey]: stub };
    }

    // article rest_id 跟我们的 articleId 校对 — 一般一致,有差异说明不是同一篇
    const articleRestId = (article.rest_id as string) || null;
    if (articleRestId && articleRestId !== articleId) {
      stub.fetch_failed_at = nowIso;
      stub.fetch_failed_reason = `article_id_mismatch:${articleRestId}`;
      failed++;
      return { ...obj, [xArticleKey]: stub };
    }

    // 成功:抽 title/excerpt/cover
    stub.title = (article.title as string) || null;
    stub.excerpt = (article.preview_text as string) || null;
    const coverMedia = article.cover_media as Record<string, unknown> | undefined;
    const mediaInfo = coverMedia?.media_info as Record<string, unknown> | undefined;
    stub.cover_image_url = (mediaInfo?.original_img_url as string) || null;
    stub.fetched_at = nowIso;
    fetched++;
    return { ...obj, [xArticleKey]: stub };
  };

  // L1 main content (extra root level) — tweet id 是 row.source_id
  const l1Updated = await processField(extra, 'content_resolved_url', 'x_article', row.source_id);
  if (l1Updated) {
    Object.assign(newExtra, l1Updated);
    mutated = true;
  }

  // L2 + L3:quote_of / reply_of / retweet_of 各自 + 其内嵌 quote_of
  for (const l2Key of ['quote_of', 'reply_of', 'retweet_of'] as const) {
    const l2 = extra[l2Key] as Record<string, unknown> | undefined;
    if (!l2) continue;
    let newL2 = l2;
    let l2Mutated = false;
    const l2TweetId = (l2.id as string) || null;

    // L2 content
    const l2Updated = await processField(l2, 'content_resolved_url', 'x_article', l2TweetId);
    if (l2Updated) {
      newL2 = l2Updated;
      l2Mutated = true;
    }

    // L3 quote_of(nested)
    const l3 = newL2.quote_of as Record<string, unknown> | undefined;
    if (l3) {
      const l3TweetId = (l3.id as string) || null;
      const l3Updated = await processField(l3, 'content_resolved_url', 'x_article', l3TweetId);
      if (l3Updated) {
        newL2 = { ...newL2, quote_of: l3Updated };
        l2Mutated = true;
      }
    }

    if (l2Mutated) {
      newExtra[l2Key] = newL2;
      mutated = true;
    }
  }

  // 兼容性:旧 result type 有 credits 字段,syndication 不消 credit 总是 0
  const totalCredits = 0;

  if (mutated) {
    await env.DB.prepare(
      `UPDATE items SET extra = ? WHERE id = ?`,
    ).bind(JSON.stringify(newExtra), itemId).run();
    console.log(`[x-article] ${itemId}: fetched=${fetched} failed=${failed} skipped=${skipped} credits=${totalCredits}`);
  }

  return { fetched, failed, skipped, mutated, credits: totalCredits };
}

// ═══════════════════════════════════════════════════════════════════════════
// translateXArticlesForXTweet — 2026-05-21 PR5 follow-up
//
// fetchXArticlesForXTweet 写 x_article.title / excerpt(syndication 原文),但
// 大部分 article 是英文。FE 渲染 Rich card 时希望显示中文标题/摘要 一致体验。
// 这个 step 扫 6 个 path 的 x_article,把 title + excerpt 整批 DeepSeek 翻译。
//
// 单 DeepSeek 调用处理一个 item 内所有 path 的 article 翻译。
// 已翻译(title_translated 有) 或已标 translate_failed_at 的跳过。
// 中文原文 → DeepSeek 返 null _zh → 标 _translate_skipped_at 防重试。
// ═══════════════════════════════════════════════════════════════════════════

const X_ARTICLE_TRANSLATE_PROMPT = `把下面 X article 的 title / excerpt / body 翻译成自然中文。

规则:
- 专有名词保留英文(API / OpenAI / RAG / Transformer / Cloudflare / Codex 等)
- 已经是中文 / 中英混合的字段返回 null(不需翻译)
- 输出自然口语化中文,避免直译腔
- 输入字段为空或不存在时对应 _zh 返回 null
- body 是正文全文,翻译完整保留段落结构(原文 \\n 用 \\n 保留)

输入(JSON 对象):
%INPUT%

只返回一个 JSON 对象,不要其他文字:
{ "title_zh": "..." 或 null, "excerpt_zh": "..." 或 null, "body_zh": "..." 或 null }`;

interface ArticleTranslateTask {
  pathRef: { l1: true } | { l2Key: 'quote_of' | 'reply_of' | 'retweet_of' } | { l2Key: 'quote_of' | 'reply_of' | 'retweet_of'; isL3: true };
  title: string | null;
  excerpt: string | null;
  body: string | null;
}

export async function translateXArticlesForXTweet(
  env: EnrichEnv,
  itemId: string,
): Promise<{ translated: number; skipped: number; failed: number; mutated: boolean }> {
  if (!env.DEEPSEEK_API_KEY) {
    return { translated: 0, skipped: 0, failed: 0, mutated: false };
  }

  const row = await env.DB.prepare(
    `SELECT id, extra FROM items WHERE id = ? AND source_type='x_list'`,
  ).bind(itemId).first<{ id: string; extra: string | null }>();
  if (!row) throw new Error(`translateXArticlesForXTweet: item not found ${itemId}`);

  let extra: Record<string, unknown> = {};
  try { extra = row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : {}; } catch { /* ignore */ }

  // 收集 tasks:每个 path 的 x_article 若 title/excerpt 存在且 _translated 未写 + 未 skip,放进任务
  const tasks: ArticleTranslateTask[] = [];
  const stubs: Array<Record<string, unknown> | undefined> = [];

  const collectIfPending = (
    stub: Record<string, unknown> | undefined,
    ref: ArticleTranslateTask['pathRef'],
  ) => {
    if (!stub) return;
    const title = stub.title as string | null;
    const excerpt = stub.excerpt as string | null;
    const body = (stub.body as string | null) ?? null;
    if (!title && !excerpt && !body) return;
    // 已 translated(任一字段)或已 skip 不重做。
    // 注意:body 后于 title/excerpt 抓取,所以已翻译过 title/excerpt 但 body 后到的 case,
    // 也要进入翻译(stub.body_translated 缺 + stub.body 有 = 需翻 body)。
    const titleDone = !!stub.title_translated || !title;
    const excerptDone = !!stub.excerpt_translated || !excerpt;
    // body 也算 done 的情况:已翻译 OR 无 body OR 已标 body_translate_skipped_at(超长跳过)
    const bodyDone = !!stub.body_translated || !body || !!stub.body_translate_skipped_at;
    if (titleDone && excerptDone && bodyDone) return;
    if (stub.translate_failed_at) return;
    // translate_skipped_at 是"中文原文" sentinel,如果 body 后到且非中文需重翻
    if (stub.translate_skipped_at && titleDone && excerptDone && bodyDone) return;
    tasks.push({ pathRef: ref, title, excerpt, body });
    stubs.push(stub);
  };

  collectIfPending(extra.x_article as Record<string, unknown> | undefined, { l1: true });
  for (const l2Key of ['quote_of', 'reply_of', 'retweet_of'] as const) {
    const l2 = extra[l2Key] as Record<string, unknown> | undefined;
    if (!l2) continue;
    collectIfPending(l2.x_article as Record<string, unknown> | undefined, { l2Key });
    const l3 = l2.quote_of as Record<string, unknown> | undefined;
    if (l3) {
      collectIfPending(l3.x_article as Record<string, unknown> | undefined, { l2Key, isL3: true });
    }
  }

  if (tasks.length === 0) {
    return { translated: 0, skipped: 0, failed: 0, mutated: false };
  }

  // 单 task 单调用,串行。每 task body 可能 6k 字符 ≈ 4k token 输出,
  // 加 title + excerpt 拼起来一次调用 max_tokens=8000 够。
  const nowIso = new Date().toISOString();
  let translated = 0, skipped = 0, failed = 0;

  // 超长 body 阈值:>= 15000 字符英文 ~ 4000 tokens 输入 + 4000-6000 输出,
  // DeepSeek 处理 ~30-60s,撞 worker wall + curl 30s timeout。
  // 这种 article 先翻 title+excerpt,body 标 too_long 失败,
  // FE 渲染时降级到原文(英文 body 也仍能读)。
  const LONG_BODY_THRESHOLD = 15000;

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const stub = stubs[i];
    if (!stub) continue;

    const bodyTooLong = !!(t.body && t.body.length >= LONG_BODY_THRESHOLD);
    // 超长 body 提前跳过 body 字段翻译,只翻 title+excerpt
    const taskBody = bodyTooLong ? null : t.body;
    const input = { title: t.title, excerpt: t.excerpt, body: taskBody };
    const prompt = X_ARTICLE_TRANSLATE_PROMPT.replace('%INPUT%', JSON.stringify(input));

    let parsed: { title_zh?: string | null; excerpt_zh?: string | null; body_zh?: string | null } | null = null;
    let attempts = 0;
    let lastError: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      attempts++;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000);
      try {
        const res = await fetch(DEEPSEEK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
          body: JSON.stringify({
            model: 'deepseek-v4-flash',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
            response_format: { type: 'json_object' },
            max_tokens: 8000,
          }),
          signal: controller.signal,
        });
        if (!res.ok) { lastError = `http_${res.status}`; continue; }
        const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
        const raw = body.choices?.[0]?.message?.content || '';
        parsed = JSON.parse(raw);
        break;
      } catch (e) {
        // AbortError = 25s timeout;其他 = 网络/JSON parse 错误
        lastError = e instanceof Error && e.name === 'AbortError' ? 'timeout_25s' : `error:${String(e).slice(0,80)}`;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    if (!parsed) {
      stub.translate_failed_at = nowIso;
      stub.translate_failed_reason = lastError || 'http_or_parse';
      failed++;
      continue;
    }

    const titleZh = parsed.title_zh ?? null;
    const excerptZh = parsed.excerpt_zh ?? null;
    const bodyZh = parsed.body_zh ?? null;
    let didTranslate = false;
    if (titleZh && t.title) {
      stub.title_translated = titleZh;
      didTranslate = true;
    }
    if (excerptZh && t.excerpt) {
      stub.excerpt_translated = excerptZh;
      didTranslate = true;
    }
    if (bodyZh && t.body) {
      stub.body_translated = bodyZh;
      didTranslate = true;
    }
    // 超长 body 单独标 fail(不阻塞 title/excerpt 翻译 + 不进 ping-pong),
    // 用 body_fetch_failed_at 风格的 sentinel 短路 SQL,但跟 fetch fail 隔离
    if (bodyTooLong && t.body) {
      // body 字段翻译标失败,但允许 title/excerpt 已被翻译(didTranslate=true)
      // 用专门的 sentinel,不污染整体 translate_failed_at
      stub.body_translate_skipped_at = nowIso;
      stub.body_translate_skipped_reason = `body_too_long:${t.body.length}`;
    }
    if (didTranslate) {
      stub.translated_at = nowIso;
      // 清 skip sentinel(body 后到时此前可能被标过)
      delete stub.translate_skipped_at;
      translated++;
    } else {
      stub.translate_skipped_at = nowIso;
      skipped++;
    }
    console.log(`[x-article-translate] ${itemId} task#${i} attempts=${attempts} translated=${didTranslate} body_too_long=${bodyTooLong}`);
  }

  await env.DB.prepare(
    `UPDATE items SET extra = ? WHERE id = ?`,
  ).bind(JSON.stringify(extra), itemId).run();
  console.log(`[x-article-translate] ${itemId}: translated=${translated} skipped=${skipped} failed=${failed}`);

  return { translated, skipped, failed, mutated: true };
}

/**
 * Backfill 历史 x_article 翻译。SQL filter 找有 title/excerpt 但缺
 * title_translated/excerpt_translated 且没标 translate_skipped/failed 的 path。
 */
export async function runBackfillXArticleTranslations(
  env: EnrichEnv,
  limit: number,
  rateSleepMs: number = 200,
): Promise<{
  scanned: number;
  processed: number;
  total_translated: number;
  total_skipped: number;
  total_failed: number;
  errors: Array<{ id: string; reason: string }>;
  remaining: number;
}> {
  // 候选:任一 path x_article 有 title 但无 title_translated + 没 skip / fail marker
  // 2026-05-22 PR6:加 body 字段后,SQL 选 "任一字段(title/excerpt/body) 存在 + 对应 _translated 缺"。
  // 2026-05-25 hotfix #1:必须短路 translate_skipped_at(中文原文 ping-pong 死循环)。
  // 2026-05-25 hotfix #2:body 单字段加 body_translate_skipped_at 短路(超长 body 跳过翻译)。
  //
  // body 短路逻辑:body 子句必须独立 short-circuit body_translate_skipped_at,
  // 否则超长 body 标 skip 后,SQL 因为 title/excerpt 翻译完整仍可能选中(实际不会,
  // 因为整体 skip 标了,但 future-proof 写清)。
  const TR = (path: string) => `(
    (
      (json_extract(extra, '$.${path}x_article.title') IS NOT NULL AND json_extract(extra, '$.${path}x_article.title_translated') IS NULL)
      OR (json_extract(extra, '$.${path}x_article.excerpt') IS NOT NULL AND json_extract(extra, '$.${path}x_article.excerpt_translated') IS NULL)
      OR (json_extract(extra, '$.${path}x_article.body') IS NOT NULL AND json_extract(extra, '$.${path}x_article.body_translated') IS NULL AND json_extract(extra, '$.${path}x_article.body_translate_skipped_at') IS NULL)
    )
    AND json_extract(extra, '$.${path}x_article.translate_failed_at') IS NULL
    AND json_extract(extra, '$.${path}x_article.translate_skipped_at') IS NULL
  )`;
  const HAS_PENDING = `(
    ${TR('')} OR
    ${TR('quote_of.')} OR
    ${TR('reply_of.')} OR
    ${TR('retweet_of.')} OR
    ${TR('quote_of.quote_of.')} OR
    ${TR('reply_of.quote_of.')} OR
    ${TR('retweet_of.quote_of.')}
  )`;

  const candidates = await env.DB.prepare(
    `SELECT id FROM items
      WHERE source_type='x_list' AND ${HAS_PENDING}
      ORDER BY scraped_at DESC LIMIT ?`,
  ).bind(limit).all<{ id: string }>();

  const remainingRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM items
      WHERE source_type='x_list' AND ${HAS_PENDING}`,
  ).first<{ n: number }>();

  let processed = 0;
  let totalTranslated = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  const errors: Array<{ id: string; reason: string }> = [];

  for (const c of candidates.results) {
    processed++;
    try {
      const r = await translateXArticlesForXTweet(env, c.id);
      totalTranslated += r.translated;
      totalSkipped += r.skipped;
      totalFailed += r.failed;
    } catch (e) {
      errors.push({ id: c.id, reason: String(e).slice(0, 200) });
    }
    if (rateSleepMs > 0 && processed < candidates.results.length) {
      await new Promise((r) => setTimeout(r, rateSleepMs));
    }
  }

  return {
    scanned: candidates.results.length,
    processed,
    total_translated: totalTranslated,
    total_skipped: totalSkipped,
    total_failed: totalFailed,
    errors: errors.slice(0, 20),
    remaining: (remainingRow?.n || 0) - processed,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// fetchXArticleBodiesForXTweet — 2026-05-22 PR6
//
// 抓 X article 正文 body(全文,login-gated)。
// 前置:fetchXArticlesForXTweet 已经写了 x_article.title/excerpt/cover/author,
// 这里在已 fetched_at 的 path 上调 X GraphQL TweetResultByRestId 拿 plain_text。
//
// 风控:
// - 单 item 内串行(多 path 时 5-10s jitter)
// - 日总量 cap(默认 50/天,X_GRAPHQL_DAILY_CAP env override)
// - Cookie 失效(401/403)→ 标 cookie_invalid + 中断 + PushDeer 报警
// - RateLimit(429)→ 中断当前 item,workflow 等下次 cron 续跑
//
// 路径覆盖:6 个(同 fetchXArticlesForXTweet)。
// ═══════════════════════════════════════════════════════════════════════════

interface XArticleBodyEnv extends EnrichEnv {
  AUTH_KV?: KVNamespace;
  PUSHDEER_ADMIN_KEYS?: string;
  X_GRAPHQL_DAILY_CAP?: string;
}

export async function fetchXArticleBodiesForXTweet(
  env: XArticleBodyEnv,
  itemId: string,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<{
  fetched: number;
  failed: number;
  skipped: number;
  mutated: boolean;
  cap_hit?: boolean;
  cookie_invalid?: boolean;
  rate_limited?: boolean;
}> {
  if (!env.AUTH_KV) {
    // 无 KV binding(本地 dev 没绑)— 静默 skip
    return { fetched: 0, failed: 0, skipped: 0, mutated: false };
  }

  const {
    fetchTweetResultByRestId,
    extractArticleBodyFromTweet,
    getXCookie,
    getDailyCount,
    incrDailyCount,
    getDailyCap,
    CookieInvalidError,
    CookieMissingError,
    RateLimitError,
    TweetNotFoundError,
  } = await import('./x-graphql');

  const cookie = await getXCookie({ AUTH_KV: env.AUTH_KV });
  if (!cookie || cookie.invalid_at) {
    // 无 cookie 或已知失效 — 不报警(那是 markCookieInvalid 的事),静默 skip
    return { fetched: 0, failed: 0, skipped: 0, mutated: false, cookie_invalid: !!cookie?.invalid_at };
  }

  const row = await env.DB.prepare(
    `SELECT id, source_id, extra FROM items WHERE id = ? AND source_type='x_list'`,
  ).bind(itemId).first<{ id: string; source_id: string; extra: string | null }>();
  if (!row) throw new Error(`fetchXArticleBodiesForXTweet: item not found ${itemId}`);

  let extra: Record<string, unknown> = {};
  try { extra = row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : {}; } catch { /* ignore */ }

  const cap = getDailyCap({ AUTH_KV: env.AUTH_KV, X_GRAPHQL_DAILY_CAP: env.X_GRAPHQL_DAILY_CAP });
  let used = await getDailyCount({ AUTH_KV: env.AUTH_KV });

  const nowIso = new Date().toISOString();
  let fetched = 0;
  let failed = 0;
  let skipped = 0;
  let mutated = false;
  let capHit = false;
  let cookieInvalid = false;
  let rateLimited = false;

  // 收集所有候选(stub, tweetId)— stub 是 x_article obj,tweetId 是该 path 的 tweet id
  interface Candidate {
    stub: Record<string, unknown>;
    tweetId: string;
    path: string;
  }
  const candidates: Candidate[] = [];

  const collect = (stub: Record<string, unknown> | undefined, tweetId: string | null | undefined, path: string) => {
    if (!stub || !tweetId) return;
    // 必须已 fetched_at(title/excerpt 流跑过)+ body 字段未 set + 未标 body_fetch_failed_at
    if (!stub.fetched_at) return;
    if (stub.body !== undefined && stub.body !== null) return;
    if (stub.body_fetched_at || stub.body_fetch_failed_at) return;
    candidates.push({ stub, tweetId, path });
  };

  collect(extra.x_article as Record<string, unknown> | undefined, row.source_id, 'L1');
  for (const l2Key of ['quote_of', 'reply_of', 'retweet_of'] as const) {
    const l2 = extra[l2Key] as Record<string, unknown> | undefined;
    if (!l2) continue;
    collect(l2.x_article as Record<string, unknown> | undefined, (l2.id as string) || undefined, `L2.${l2Key}`);
    const l3 = l2.quote_of as Record<string, unknown> | undefined;
    if (l3) collect(l3.x_article as Record<string, unknown> | undefined, (l3.id as string) || undefined, `L3.${l2Key}.quote_of`);
  }

  if (candidates.length === 0) {
    return { fetched: 0, failed: 0, skipped: 0, mutated: false };
  }

  // 串行处理候选,失败模式短路
  for (let i = 0; i < candidates.length; i++) {
    if (used >= cap) {
      capHit = true;
      break;
    }
    const { stub, tweetId } = candidates[i];
    try {
      // 把 DB 传给 fetchTweetResultByRestId,让 markCookieInvalid 失效时可跑 SQL 统计影响范围
      const tweetResult = await fetchTweetResultByRestId(
        { AUTH_KV: env.AUTH_KV, PUSHDEER_ADMIN_KEYS: env.PUSHDEER_ADMIN_KEYS, DB: env.DB },
        tweetId,
        ctx,
      );
      const articleData = extractArticleBodyFromTweet(tweetResult);
      used = await incrDailyCount({ AUTH_KV: env.AUTH_KV });

      if (!articleData || !articleData.plain_text) {
        stub.body_fetch_failed_at = nowIso;
        stub.body_fetch_failed_reason = articleData ? 'no_plain_text_in_response' : 'no_article_in_tweet';
        failed++;
      } else {
        stub.body = articleData.plain_text;
        stub.body_fetched_at = nowIso;
        // 顺手 update 别的字段(更准确版本)
        if (articleData.title && !stub.title) stub.title = articleData.title;
        if (articleData.cover_image_url && !stub.cover_image_url) stub.cover_image_url = articleData.cover_image_url;
        // body 后到 → 清 translate_skipped_at 让 translate step 重评估
        // (之前可能只基于 title/excerpt 判定中文标 skip,但 body 可能英文需翻)
        if (stub.translate_skipped_at) delete stub.translate_skipped_at;
        fetched++;
      }
      mutated = true;
    } catch (e) {
      if (e instanceof CookieInvalidError || e instanceof CookieMissingError) {
        cookieInvalid = true;
        // markCookieInvalid 已在 fetchTweetResultByRestId 内调用
        break; // 后续 path 没意义,直接中断
      }
      if (e instanceof RateLimitError) {
        rateLimited = true;
        break;
      }
      if (e instanceof TweetNotFoundError) {
        stub.body_fetch_failed_at = nowIso;
        stub.body_fetch_failed_reason = 'tweet_404';
        failed++;
        mutated = true;
      } else {
        stub.body_fetch_failed_at = nowIso;
        stub.body_fetch_failed_reason = `error:${String(e).slice(0, 100)}`;
        failed++;
        mutated = true;
      }
    }

    // jitter 间隔 5-10s(除最后一个不 sleep)
    if (i < candidates.length - 1 && !cookieInvalid && !rateLimited) {
      const jitter = 5000 + Math.random() * 5000;
      await new Promise((r) => setTimeout(r, jitter));
    }
  }

  if (mutated) {
    await env.DB.prepare(
      `UPDATE items SET extra = ? WHERE id = ?`,
    ).bind(JSON.stringify(extra), itemId).run();
    console.log(
      `[x-article-body] ${itemId}: fetched=${fetched} failed=${failed} skipped=${skipped}` +
      `${capHit ? ' CAP_HIT' : ''}${cookieInvalid ? ' COOKIE_INVALID' : ''}${rateLimited ? ' RATE_LIMITED' : ''}`,
    );
  }

  return { fetched, failed, skipped, mutated, cap_hit: capHit, cookie_invalid: cookieInvalid, rate_limited: rateLimited };
}

/**
 * Backfill 历史 x_article body。SQL filter 找有 x_article.fetched_at 但
 * 缺 body / body_fetched_at / body_fetch_failed_at 的 path。
 *
 * 单 worker request 内串行 + 5-10s 每篇 jitter + 日总量 cap。
 * cap 触底 / cookie 失效 / rate limit → 中断返 stopped_reason。
 */
export async function runBackfillXArticleBodies(
  env: XArticleBodyEnv,
  limit: number,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<{
  scanned: number;
  processed: number;
  total_fetched: number;
  total_failed: number;
  total_skipped: number;
  errors: Array<{ id: string; reason: string }>;
  remaining: number;
  stopped_reason?: 'cap_hit' | 'cookie_invalid' | 'rate_limited' | null;
  daily_used?: number;
  daily_cap?: number;
}> {
  // 候选 SQL:任一 path x_article.fetched_at 存在 + (body IS NULL 或不存在) + body_fetched_at / body_fetch_failed_at 也都不存在
  const PE = (path: string) => `(
    json_extract(extra, '$.${path}x_article.fetched_at') IS NOT NULL
    AND json_extract(extra, '$.${path}x_article.body') IS NULL
    AND json_extract(extra, '$.${path}x_article.body_fetched_at') IS NULL
    AND json_extract(extra, '$.${path}x_article.body_fetch_failed_at') IS NULL
  )`;
  const HAS_PENDING = `(
    ${PE('')} OR
    ${PE('quote_of.')} OR
    ${PE('reply_of.')} OR
    ${PE('retweet_of.')} OR
    ${PE('quote_of.quote_of.')} OR
    ${PE('reply_of.quote_of.')} OR
    ${PE('retweet_of.quote_of.')}
  )`;

  const candidates = await env.DB.prepare(
    `SELECT id FROM items
      WHERE source_type='x_list' AND ${HAS_PENDING}
      ORDER BY scraped_at DESC LIMIT ?`,
  ).bind(limit).all<{ id: string }>();

  const remainingRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM items
      WHERE source_type='x_list' AND ${HAS_PENDING}`,
  ).first<{ n: number }>();

  let processed = 0;
  let totalFetched = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  const errors: Array<{ id: string; reason: string }> = [];
  let stopReason: 'cap_hit' | 'cookie_invalid' | 'rate_limited' | null = null;

  for (const c of candidates.results) {
    processed++;
    try {
      const r = await fetchXArticleBodiesForXTweet(env, c.id, ctx);
      totalFetched += r.fetched;
      totalFailed += r.failed;
      totalSkipped += r.skipped;
      if (r.cap_hit) { stopReason = 'cap_hit'; break; }
      if (r.cookie_invalid) { stopReason = 'cookie_invalid'; break; }
      if (r.rate_limited) { stopReason = 'rate_limited'; break; }
    } catch (e) {
      errors.push({ id: c.id, reason: String(e).slice(0, 200) });
    }
    // items 间不额外 sleep(本身 single item 内已经 jitter,跨 item 累计已分散)
  }

  let dailyUsed: number | undefined;
  let dailyCap: number | undefined;
  if (env.AUTH_KV) {
    const { getDailyCount, getDailyCap } = await import('./x-graphql');
    dailyUsed = await getDailyCount({ AUTH_KV: env.AUTH_KV });
    dailyCap = getDailyCap({ AUTH_KV: env.AUTH_KV, X_GRAPHQL_DAILY_CAP: env.X_GRAPHQL_DAILY_CAP });
  }

  return {
    scanned: candidates.results.length,
    processed,
    total_fetched: totalFetched,
    total_failed: totalFailed,
    total_skipped: totalSkipped,
    errors: errors.slice(0, 20),
    remaining: (remainingRow?.n || 0) - processed,
    stopped_reason: stopReason,
    daily_used: dailyUsed,
    daily_cap: dailyCap,
  };
}

export interface BackfillTruncatedResult {
  mode: string;
  selected: number;
  updated: number;
  not_found: number;
  skipped: number;
  failed: number;
  duration_ms: number;
}

/**
 * Batch backfill：扫所有截断 + 未 fetched 的 X tweets，逐个走 syndication 补全。
 * 给 enrich/run?mode=backfill-truncated-text + cron 兜底用。单 item 调
 * backfillTruncatedTextForXTweet 共用逻辑。
 *
 * SQL filter：content 末尾 … + 长度 130-150 + 未 fetched 也未 errored。
 * rateSleepMs 400 → syndication ~2.5 qps 避免被限流（X public endpoint）。
 */
export async function runBackfillTruncatedFromSyndication(
  env: EnrichEnv,
  limit: number,
  rateSleepMs: number = 400,
): Promise<BackfillTruncatedResult> {
  const t0 = Date.now();
  const rows = await env.DB.prepare(
    `SELECT id FROM items
       WHERE source_type = 'x_list'
         AND content LIKE '%…'
         AND length(content) BETWEEN 130 AND 150
         AND (extra IS NULL
              OR (json_extract(extra, '$.longform.fetched_at') IS NULL
                  AND json_extract(extra, '$.longform.fetch_error') IS NULL))
       ORDER BY scraped_at DESC
       LIMIT ?`,
  ).bind(limit).all<{ id: string }>();
  const selected = rows.results.length;
  let updated = 0;
  let notFound = 0;
  let skipped = 0;
  let failed = 0;
  for (const r of rows.results) {
    try {
      const res = await backfillTruncatedTextForXTweet(env, r.id);
      if (res.updated) updated++;
      else if (res.source === 'not_found') notFound++;
      else skipped++;
    } catch (e) {
      console.error(`[backfill-truncated-text] ${r.id} failed:`, e);
      failed++;
    }
    if (rateSleepMs > 0) await new Promise((res) => setTimeout(res, rateSleepMs));
  }
  return {
    mode: 'backfill-truncated-text',
    selected,
    updated,
    not_found: notFound,
    skipped,
    failed,
    duration_ms: Date.now() - t0,
  };
}

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
 * Workflow Step 2c: 通过 syndication API 回填 retweet_of snapshot。
 * 跟老 runBackfillRetweets 一条 loop body 同逻辑。
 *
 * 2026-05-17 bug fix：阶段 4 X workflow cutover 漏写本 step，导致 retweet 推文
 * 的 retweet_of 永远 null → frontend TweetCard 翻转逻辑 fallback 显示转推者
 * （Peter）而不是原推作者（Christoph）。
 *
 * 跟 backfillQuoteForXTweet 平行，用 extra.retweeted_status_id 调 syndication
 * 拿原推 snapshot（content / author / handle / published_at / profile_image_url）
 * 写入 extra.retweet_of。frontend 看到 retweet_of 完整数据后翻转主卡作者。
 */
export async function backfillRetweetForXTweet(
  env: EnrichEnv,
  itemId: string,
): Promise<{ has_retweet: boolean; not_found: boolean }> {
  const row = await env.DB.prepare(
    `SELECT id, source_id, extra FROM items WHERE id = ? AND source_type = 'x_list'`,
  ).bind(itemId).first<{ id: string; source_id: string; extra: string | null }>();
  if (!row) throw new Error(`backfillRetweetForXTweet: item not found ${itemId}`);

  let extraObj: Record<string, unknown> = {};
  if (row.extra) {
    try { extraObj = JSON.parse(row.extra); } catch { /* fallthrough */ }
  }
  const targetId = extraObj.retweeted_status_id;
  if (typeof targetId !== 'string' || !targetId) {
    // 不是 retweet（或 extra 缺 retweeted_status_id）— hasRetweetRef 信号假阳
    return { has_retweet: false, not_found: false };
  }

  const res = await fetchTweet(targetId);
  if (res === null) {
    throw new Error(`backfillRetweetForXTweet: fetchTweet failed ${targetId}`);
  }
  if (res.notFound || !res.data) {
    // 原推被删 / 账号封 / 私密 → sentinel 标 retweet_of=null + retweet_enriched=true 防重试
    await applyPatch(env, row as CandidateRow, { retweet_enriched: true, retweet_of: null });
    console.log(`[x-workflow:step2c] ${itemId}: retweet origin ${targetId} not found`);
    return { has_retweet: false, not_found: true };
  }

  await applyPatch(env, row as CandidateRow, {
    retweet_enriched: true,
    retweet_of: apiToQuoteOf(res.data as unknown as Record<string, unknown>),
  });
  console.log(`[x-workflow:step2c] ${itemId}: retweet_of filled from ${targetId}`);
  return { has_retweet: true, not_found: false };
}

/**
 * Workflow Step 2d: 检测 longform 标记（note_tweet.id 有则是长推待 fetch）。
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
  // 数据失效级联(2026-05-17 批 2):content 真正更新时(CASE WHEN 命中),
  // 同步清 content_translated + translated_at 让 workflow 重翻。
  await env.DB.prepare(
    `UPDATE items
        SET content = CASE
              WHEN content IS NULL OR length(?) >= length(content) THEN ?
              ELSE content
            END,
            content_translated = CASE
              WHEN content IS NULL OR length(?) >= length(content) THEN NULL
              ELSE content_translated
            END,
            translated_at = CASE
              WHEN content IS NULL OR length(?) >= length(content) THEN NULL
              ELSE translated_at
            END,
            extra = json_set(coalesce(extra, '{}'), '$.longform.fetched_at', ?)
      WHERE id = ?`,
  ).bind(ft, ft, ft, ft, nowIso, row.id).run();
  console.log(`[x-workflow:step3] ${itemId}: longform fetched ${ft.length}c (cascade-clear if updated)`);
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
    // task #8: 写 translated_at 给 C 端「N 条新译文可加载」横条用
    await env.DB.prepare(
      `UPDATE items
          SET content_translated = ?,
              translation_quality = ?,
              translation_attempts = COALESCE(translation_attempts, 0) + ?,
              translated_at = ?
        WHERE id = ?`,
    ).bind(finalText, quality, attempts, nowTs, itemId).run();
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

// ═══════════════════════════════════════════════════════════════════════════
// classifyAndTranslateForXTweet — 2026-05-17 重构:1 次 DeepSeek JSON Mode 调用
// 合并 classify + translate 6 字段(原 classifyXTweetWithLlm + translateXTweetField × 6
// 共 7 次调用 → 1 次合并),降本 ~87%。
//
// 调用方:x-tweet-pipeline.ts 新 step 3(关联数据回填后)。
// 老函数 classifyXTweetWithLlm / translateXTweetField 保留给 /api/items/:id/translate-now
// + admin 兜底 endpoint 用。
//
// 失败兜底:JSON parse / 必字段 missing → retry 1 次 → 仍失败标
// extra.translation_failed_at + is_relevant=0,workflow 继续到 step 4 完整性 gate。
// ═══════════════════════════════════════════════════════════════════════════

const CLASSIFY_TRANSLATE_PROMPT = `你是 AI 资讯整理助手,对推文做两件事:
1. 判断 is_relevant(0 或 1):推文是否属于 AI / LLM / agent / 产品 / 工程 / 创业 / dev tooling 等技术议题
2. is_relevant=1 时,把英文字段翻译成中文(纯英文 → 中文;中文 / 中英混合 / 已经是中文的字段返回 null)

输入字段(JSON):
- main.text:主推正文(必给)
- main.handle:作者 handle
- quote_of.content:引用的推文正文(可能没有)
- quote_of.quote_of.content:引用推内部又嵌套的引用(L3,可能没有)
- reply_of.content:回复的父推正文(可能没有)
- reply_of.quote_of.content:父推内部嵌套的引用(L3,可能没有)
- retweet_of.content:转推原文(可能没有)
- retweet_of.quote_of.content:转推原文内部嵌套的引用(L3,可能没有)
- link_card.title / .description:外链卡(可能没有)

返回 JSON 对象(只返回一个 JSON 对象,不要其他文字):
{
  "is_relevant": 0 或 1,
  "reason": "一句话给出 is_relevant 判断的依据(≤ 30 字)",
  "ai_summary": "主推 1 行中文摘要(≤ 40 字,仅 is_relevant=1 时给,否则空字符串)",
  "content_zh": "主推中文翻译" 或 null,
  "quote_of_zh": "引用推中文翻译" 或 null,
  "quote_of_quote_of_zh": "引用推嵌套引用的中文翻译(L3)" 或 null,
  "reply_of_zh": "父推中文翻译" 或 null,
  "reply_of_quote_of_zh": "父推嵌套引用的中文翻译(L3)" 或 null,
  "retweet_of_zh": "转推原文中文翻译" 或 null,
  "retweet_of_quote_of_zh": "转推嵌套引用的中文翻译(L3)" 或 null,
  "link_card_title_zh": "外链标题中文" 或 null,
  "link_card_desc_zh": "外链描述中文" 或 null
}

is_relevant 判断标准:
- 1:AI / LLM / agent / 产品设计 / 软件工程 / 创业 / dev tooling 相关
- 0:纯个人生活 / 政治 / 广告 / 不相干吐槽

翻译规则:
- 专有名词保留原文(API / OpenAI / Transformer / RAG / Cloudflare 等)
- 链接 URL 保留不翻译
- 中文 / 中英混合字段直接返回 null(不需翻译)
- is_relevant=0 时所有 _zh 字段返回 null
- 输入字段不存在时对应 _zh 字段返回 null
- 翻译要流畅,符合中文表达习惯

输入:
%INPUT%`;

interface ClassifyTranslateInput {
  main: { handle: string; text: string };
  quote_of?: { content: string; quote_of?: { content: string } };
  reply_of?: { content: string; quote_of?: { content: string } };
  retweet_of?: { content: string; quote_of?: { content: string } };
  link_card?: { title?: string; description?: string };
}

interface ClassifyTranslateResponse {
  is_relevant: 0 | 1;
  reason?: string;
  ai_summary?: string;
  content_zh?: string | null;
  quote_of_zh?: string | null;
  quote_of_quote_of_zh?: string | null;
  reply_of_zh?: string | null;
  reply_of_quote_of_zh?: string | null;
  retweet_of_zh?: string | null;
  retweet_of_quote_of_zh?: string | null;
  link_card_title_zh?: string | null;
  link_card_desc_zh?: string | null;
}

export interface ClassifyTranslateResult {
  is_relevant: 0 | 1;
  fields_translated: string[];
  attempts: number;
  failed?: 'json_parse' | 'missing_fields' | 'http' | 'no_content';
}

export async function classifyAndTranslateForXTweet(
  env: EnrichEnv,
  itemId: string,
  opts: { lang: 'zh' | 'en' | 'ja'; preserveIsRelevant?: boolean } = { lang: 'zh' },
): Promise<ClassifyTranslateResult> {
  if (!env.DEEPSEEK_API_KEY) {
    throw new Error('classifyAndTranslateForXTweet: DEEPSEEK_API_KEY missing');
  }
  if (opts.lang !== 'zh') {
    throw new Error(`classifyAndTranslateForXTweet: lang=${opts.lang} not yet supported`);
  }

  const row = await env.DB.prepare(
    `SELECT id, content, handle, lang, extra, is_relevant
       FROM items
      WHERE id = ? AND source_type = 'x_list'`,
  ).bind(itemId).first<{
    id: string;
    content: string | null;
    handle: string | null;
    lang: string | null;
    extra: string | null;
    is_relevant: number | null;
  }>();

  if (!row) throw new Error(`classifyAndTranslateForXTweet: item not found ${itemId}`);
  if (!row.content) {
    return { is_relevant: 0, fields_translated: [], attempts: 0, failed: 'no_content' };
  }

  // preserveIsRelevant=true(backfill 模式):不再让 DeepSeek 重判 is_relevant,只补翻译。
  // 历史 item 已经被前一次 classify-translate 判过 is_relevant,backfill 重跑只是补漏字段的
  // 翻译,不应该让 DeepSeek 重新分类(模型 non-determinism / borderline case 可能 1→0 误降级)。
  // 用法:runBackfillL3Translations 传 preserveIsRelevant=true。
  const preserveIsRelevant = opts.preserveIsRelevant === true;
  const existingIsRel = typeof row.is_relevant === 'number' ? row.is_relevant : 0;

  const extra: Record<string, unknown> = row.extra
    ? (JSON.parse(row.extra) as Record<string, unknown>)
    : {};

  // 构建合并输入(只传有值的字段,节省 prompt tokens)
  const input: ClassifyTranslateInput = {
    main: {
      handle: row.handle || '',
      text: row.content.slice(0, 4000), // 长推已 step 0 backfill,但截断防 prompt 过长
    },
  };

  // L2 + L3 嵌套字段:apiToQuoteOf 递归解析 inline quoted_tweet → extra.{quote_of,reply_of,retweet_of}.quote_of
  // syndication 返 retweet 时常 inline 嵌一层 quote(prod 数据 30 天里 27 条 RT→Q + 53 条 Rep→Q + 0 条 Q→Q)。
  // L3 字段也要发给 DeepSeek 翻译,否则 FE 渲染 L3 时显示英文(bug #1 根因)。
  type L2Field = { content?: string; quote_of?: { content?: string } };

  const qo = extra.quote_of as L2Field | undefined;
  if (qo?.content) {
    input.quote_of = { content: qo.content.slice(0, 1000) };
    if (qo.quote_of?.content) {
      input.quote_of.quote_of = { content: qo.quote_of.content.slice(0, 1000) };
    }
  }

  const ro = extra.reply_of as L2Field | undefined;
  if (ro?.content) {
    input.reply_of = { content: ro.content.slice(0, 1000) };
    if (ro.quote_of?.content) {
      input.reply_of.quote_of = { content: ro.quote_of.content.slice(0, 1000) };
    }
  }

  const rto = extra.retweet_of as L2Field | undefined;
  if (rto?.content) {
    input.retweet_of = { content: rto.content.slice(0, 1000) };
    if (rto.quote_of?.content) {
      input.retweet_of.quote_of = { content: rto.quote_of.content.slice(0, 1000) };
    }
  }

  const lc = extra.link_card as { title?: string; description?: string } | undefined;
  if (lc?.title || lc?.description) {
    input.link_card = {
      title: lc.title?.slice(0, 200),
      description: lc.description?.slice(0, 500),
    };
  }

  const isMainZh = row.lang === 'zh' || row.lang === 'zh-cn' || row.lang === 'zh-tw';

  // ── 调 DeepSeek JSON Mode(retry 1 次) ──────────────────────
  let parsed: ClassifyTranslateResponse | null = null;
  let attempts = 0;
  let lastError: ClassifyTranslateResult['failed'] | undefined;

  for (let i = 0; i < 2; i++) {
    attempts++;
    const prompt = CLASSIFY_TRANSLATE_PROMPT.replace('%INPUT%', JSON.stringify(input));

    let res: Response;
    try {
      res = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          response_format: { type: 'json_object' },
          max_tokens: 4000,
        }),
      });
    } catch {
      lastError = 'http';
      continue;
    }

    if (!res.ok) {
      lastError = 'http';
      continue;
    }

    const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const raw = body.choices?.[0]?.message?.content || '';

    let candidate: ClassifyTranslateResponse;
    try {
      candidate = JSON.parse(raw);
    } catch {
      lastError = 'json_parse';
      continue;
    }

    // 必字段 check:is_relevant 必有且为 0|1
    if (candidate.is_relevant !== 0 && candidate.is_relevant !== 1) {
      lastError = 'missing_fields';
      continue;
    }
    // is_relevant=1 + 主推是英文 → content_zh 必须有
    // 例外:preserveIsRelevant(backfill 模式)放宽此检查 —— 主推可能是 degenerate
    // (裸 URL / "来源：" / 短词)无法翻译,但 L3 内容仍可处理(中文→skip,英文→翻译)。
    // 严格 check 会让这种 item 永远卡 missing_fields,反复 picked 浪费 DeepSeek call。
    if (!preserveIsRelevant && candidate.is_relevant === 1 && !isMainZh && !candidate.content_zh) {
      lastError = 'missing_fields';
      continue;
    }

    parsed = candidate;
    lastError = undefined;
    break;
  }

  if (!parsed) {
    // 仍失败:标 translation_failed_at。preserveIsRelevant=true 时保留原 is_relevant
    // (backfill 失败不该影响 feed 可见性);否则按老逻辑 is_relevant=0 + matched_by 兜底。
    const nowIsoFail = new Date().toISOString();
    if (preserveIsRelevant) {
      await env.DB.prepare(
        `UPDATE items
            SET extra = json_set(coalesce(extra, '{}'),
                                 '$.translation_failed_at', ?,
                                 '$.translation_failed_reason', ?)
          WHERE id = ?`,
      ).bind(nowIsoFail, lastError || 'unknown', itemId).run();
    } else {
      await env.DB.prepare(
        `UPDATE items
            SET is_relevant = 0,
                matched_by = COALESCE(matched_by, 'workflow-classify-translate'),
                extra = json_set(coalesce(extra, '{}'),
                                 '$.translation_failed_at', ?,
                                 '$.translation_failed_reason', ?)
          WHERE id = ?`,
      ).bind(nowIsoFail, lastError || 'unknown', itemId).run();
    }
    console.log(`[x-workflow:step3] ${itemId}: classify+translate failed after ${attempts} attempts, reason=${lastError} preserve=${preserveIsRelevant}`);
    return {
      is_relevant: preserveIsRelevant ? (existingIsRel === 1 ? 1 : 0) : 0,
      fields_translated: [],
      attempts,
      failed: lastError || 'http',
    };
  }

  // ── 写回 D1 ────────────────────────────────────────────────
  // preserveIsRelevant=true 时用旧 is_relevant 决定是否翻译相关字段(因为 DeepSeek
  // 在 backfill 重跑时可能 1→0,但实际项已经在 feed 里,不该误降)。is_relevant 的 DB
  // 写入也保留旧值。
  const isRel = preserveIsRelevant ? (existingIsRel === 1 ? 1 : 0) : parsed.is_relevant;
  const summary = (parsed.ai_summary || '').trim();
  const fieldsTranslated: string[] = [];
  const nowTs = Math.floor(Date.now() / 1000);
  const nowIso = new Date().toISOString();

  // 构建新 extra(增量更新关联字段的翻译)
  const newExtra: Record<string, unknown> = { ...extra };
  // backfill 模式不覆盖 ai_summary / classified_at(那些是 classify 元数据,
  // 老值是上次正经 classify 的结果,backfill 不该洗掉)
  if (!preserveIsRelevant) {
    newExtra.ai_summary = summary;
    newExtra.classified_at = nowIso;
  }

  if (isRel === 1) {
    // L2 + L3 嵌套写回:每个 L2 容器(quote_of/reply_of/retweet_of)可能同时需要写
    // L2 content_translated + L3 quote_of.content_translated。L2 是中文不翻译(parsed.X_zh=null)
    // 但 L3 是英文(parsed.X_quote_of_zh 有值)时,仍要进入分支补 L3 翻译。
    const writeL2WithL3 = (
      l2Key: 'quote_of' | 'reply_of' | 'retweet_of',
      l2Zh: string | null | undefined,
      l3Zh: string | null | undefined,
    ): void => {
      const l2Obj = extra[l2Key] as Record<string, unknown> | undefined;
      if (!l2Obj) return;
      const nestedQO = (l2Obj.quote_of || {}) as Record<string, unknown>;
      const newL2: Record<string, unknown> = { ...l2Obj };
      let mutated = false;

      if (l2Zh) {
        newL2.content_translated = l2Zh;
        newL2.translated_at = nowTs;
        fieldsTranslated.push(`${l2Key}.content`);
        mutated = true;
      } else if (preserveIsRelevant && typeof l2Obj.content === 'string' && l2Obj.content.length > 0 && !l2Obj.content_translated) {
        // backfill 已确认 L2 内容不需翻译(已经是中文 / 不可译),打 skip marker 防 SQL 反复挑
        newL2.translation_skipped_at = nowIso;
        mutated = true;
      }

      if (l3Zh && nestedQO.content) {
        newL2.quote_of = {
          ...nestedQO,
          content_translated: l3Zh,
          translated_at: nowTs,
        };
        fieldsTranslated.push(`${l2Key}.quote_of.content`);
        mutated = true;
      } else if (preserveIsRelevant && typeof nestedQO.content === 'string' && nestedQO.content.length > 0 && !nestedQO.content_translated) {
        // L3 已确认无需翻译,同上 skip marker
        newL2.quote_of = { ...nestedQO, translation_skipped_at: nowIso };
        mutated = true;
      }

      if (mutated) newExtra[l2Key] = newL2;
    };

    writeL2WithL3('quote_of', parsed.quote_of_zh, parsed.quote_of_quote_of_zh);
    writeL2WithL3('reply_of', parsed.reply_of_zh, parsed.reply_of_quote_of_zh);
    writeL2WithL3('retweet_of', parsed.retweet_of_zh, parsed.retweet_of_quote_of_zh);

    if ((parsed.link_card_title_zh || parsed.link_card_desc_zh) && extra.link_card) {
      const lcObj = (extra.link_card || {}) as Record<string, unknown>;
      const lcNew: Record<string, unknown> = { ...lcObj };
      if (parsed.link_card_title_zh) {
        lcNew.title_translated = parsed.link_card_title_zh;
        fieldsTranslated.push('link_card.title');
      }
      if (parsed.link_card_desc_zh) {
        lcNew.description_translated = parsed.link_card_desc_zh;
        fieldsTranslated.push('link_card.description');
      }
      newExtra.link_card = lcNew;
    }
  }

  const contentTranslated = isRel === 1 && !isMainZh ? parsed.content_zh : null;
  if (contentTranslated) {
    fieldsTranslated.push('content');
    await env.DB.prepare(
      `UPDATE items
          SET is_relevant = ?,
              matched_by = COALESCE(matched_by, 'workflow-classify-translate'),
              content_translated = ?,
              translation_quality = 'ok',
              translation_attempts = COALESCE(translation_attempts, 0) + ?,
              translated_at = ?,
              extra = ?
        WHERE id = ?`,
    ).bind(isRel, contentTranslated, attempts, nowTs, JSON.stringify(newExtra), itemId).run();
  } else {
    await env.DB.prepare(
      `UPDATE items
          SET is_relevant = ?,
              matched_by = COALESCE(matched_by, 'workflow-classify-translate'),
              translation_attempts = COALESCE(translation_attempts, 0) + ?,
              extra = ?
        WHERE id = ?`,
    ).bind(isRel, attempts, JSON.stringify(newExtra), itemId).run();
  }

  console.log(`[x-workflow:step3] ${itemId}: is_relevant=${isRel} fields=[${fieldsTranslated.join(',')}] attempts=${attempts}`);
  return { is_relevant: isRel, fields_translated: fieldsTranslated, attempts };
}

/**
 * 治本幂等：写 extra.workflow_triggered_at + create X workflow instance。
 * 调用方：drain endpoint + Phase 1 runListPollIngest + drawer refreshSingleItem。
 */
export interface XWorkflowSignals {
  hasQuoteRef: boolean;
  hasReplyRef: boolean;
  hasLinkCard: boolean;
  hasRetweetRef: boolean;
}

/**
 * Bug #1 backfill (2026-05-20):一次性扫存量 X items 漏 L3 嵌套翻译,重跑 classify-translate。
 * Prompt + 入库逻辑现在覆盖 retweet_of.quote_of / reply_of.quote_of / quote_of.quote_of 的 content
 * 翻译,跑一遍即可补齐历史。函数内不删 workflow_completed_at(已经完成的其它步骤不重做),
 * 只调用 classifyAndTranslateForXTweet 拿新版翻译写入 D1。
 *
 * 选择条件:is_relevant=1 + workflow_completed_at 有 + 任一 L3 path 有 content 但 content_translated=null。
 * 不过滤 lang(主推可能是 zh / L3 可能是 en,函数内部 isMainZh 判断不影响 L3 翻译)。
 */
export async function runBackfillL3Translations(
  env: EnrichEnv,
  limit: number,
  rateSleepMs: number,
): Promise<{
  scanned: number;
  processed: number;
  succeeded: number;
  failed: number;
  errors: Array<{ id: string; reason: string }>;
  remaining: number;
}> {
  // SQL 排除 t.co-only L3 content(DeepSeek 拿不到真实文章内容,翻译永远返 null,
  // 每批重复 pick 浪费 DeepSeek 调用)。t.co 单独 PR 用 URL resolve + link card 渲染。
  // 同时排除已被 backfill 标记 translation_skipped_at 的(中文 L3 无需翻译,markered 后跳过)。
  const HAS_L3_NEED_TRANSLATE = `(
    (json_type(extra, '$.retweet_of.quote_of') = 'object'
     AND json_extract(extra, '$.retweet_of.quote_of.content_translated') IS NULL
     AND json_extract(extra, '$.retweet_of.quote_of.translation_skipped_at') IS NULL
     AND length(json_extract(extra, '$.retweet_of.quote_of.content')) > 0
     AND json_extract(extra, '$.retweet_of.quote_of.content') NOT LIKE 'https://t.co/%')
    OR
    (json_type(extra, '$.reply_of.quote_of') = 'object'
     AND json_extract(extra, '$.reply_of.quote_of.content_translated') IS NULL
     AND json_extract(extra, '$.reply_of.quote_of.translation_skipped_at') IS NULL
     AND length(json_extract(extra, '$.reply_of.quote_of.content')) > 0
     AND json_extract(extra, '$.reply_of.quote_of.content') NOT LIKE 'https://t.co/%')
    OR
    (json_type(extra, '$.quote_of.quote_of') = 'object'
     AND json_extract(extra, '$.quote_of.quote_of.content_translated') IS NULL
     AND json_extract(extra, '$.quote_of.quote_of.translation_skipped_at') IS NULL
     AND length(json_extract(extra, '$.quote_of.quote_of.content')) > 0
     AND json_extract(extra, '$.quote_of.quote_of.content') NOT LIKE 'https://t.co/%')
  )`;

  const candidates = await env.DB.prepare(
    `SELECT id FROM items
      WHERE source_type='x_list'
        AND is_relevant=1
        AND json_extract(extra, '$.workflow_completed_at') IS NOT NULL
        AND ${HAS_L3_NEED_TRANSLATE}
      ORDER BY scraped_at DESC
      LIMIT ?`,
  ).bind(limit).all<{ id: string }>();

  // 同条件下未处理的总数(给 caller 看还剩多少)
  const remainingRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM items
      WHERE source_type='x_list'
        AND is_relevant=1
        AND json_extract(extra, '$.workflow_completed_at') IS NOT NULL
        AND ${HAS_L3_NEED_TRANSLATE}`,
  ).first<{ n: number }>();

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  const errors: Array<{ id: string; reason: string }> = [];

  for (const c of candidates.results) {
    processed++;
    try {
      // preserveIsRelevant=true 防止 DeepSeek 在 backfill 重跑时把老 is_relevant=1 误降为 0
      // (staging 12 条试跑时观察到 3 条降级,改用此标志后保留原值)
      const r = await classifyAndTranslateForXTweet(env, c.id, { lang: 'zh', preserveIsRelevant: true });
      if (r.failed) {
        failed++;
        errors.push({ id: c.id, reason: r.failed });
      } else {
        succeeded++;
      }
    } catch (e) {
      failed++;
      errors.push({ id: c.id, reason: String(e).slice(0, 200) });
    }
    if (rateSleepMs > 0 && processed < candidates.results.length) {
      await new Promise((r) => setTimeout(r, rateSleepMs));
    }
  }

  return {
    scanned: candidates.results.length,
    processed,
    succeeded,
    failed,
    errors: errors.slice(0, 20), // 限 20 条避免 response 过大
    remaining: (remainingRow?.n || 0) - succeeded,
  };
}

/**
 * Bug t.co resolve backfill (2026-05-21):一次性扫存量 X items 哪些 content
 * 是裸 t.co 短链,resolve HEAD → write content_resolved_url。
 *
 * SQL filter:any path (L1 content / L2 *.content / L3 *.quote_of.content) 是
 * t.co-only(LIKE 'https://t.co/%' + length < 40)且未 resolved 也未标 failed。
 * 单 item 调 resolveTcoLinksForXTweet,函数内 6 个 path 逐个处理。
 */
export async function runBackfillTcoResolutions(
  env: EnrichEnv,
  limit: number,
  rateSleepMs: number = 200,
): Promise<{
  scanned: number;
  processed: number;
  total_resolved: number;
  total_failed: number;
  errors: Array<{ id: string; reason: string }>;
  remaining: number;
}> {
  // 任一 path content 是 t.co-only + 未 resolved + 未 failed → candidate
  const TCO_CANDIDATE = `(
    (content LIKE 'https://t.co/%' AND length(content) < 40
     AND json_extract(extra, '$.content_resolved_url') IS NULL
     AND json_extract(extra, '$.content_resolve_failed_at') IS NULL)
    OR (json_extract(extra, '$.quote_of.content') LIKE 'https://t.co/%'
        AND length(json_extract(extra, '$.quote_of.content')) < 40
        AND json_extract(extra, '$.quote_of.content_resolved_url') IS NULL
        AND json_extract(extra, '$.quote_of.content_resolve_failed_at') IS NULL)
    OR (json_extract(extra, '$.reply_of.content') LIKE 'https://t.co/%'
        AND length(json_extract(extra, '$.reply_of.content')) < 40
        AND json_extract(extra, '$.reply_of.content_resolved_url') IS NULL
        AND json_extract(extra, '$.reply_of.content_resolve_failed_at') IS NULL)
    OR (json_extract(extra, '$.retweet_of.content') LIKE 'https://t.co/%'
        AND length(json_extract(extra, '$.retweet_of.content')) < 40
        AND json_extract(extra, '$.retweet_of.content_resolved_url') IS NULL
        AND json_extract(extra, '$.retweet_of.content_resolve_failed_at') IS NULL)
    OR (json_extract(extra, '$.quote_of.quote_of.content') LIKE 'https://t.co/%'
        AND length(json_extract(extra, '$.quote_of.quote_of.content')) < 40
        AND json_extract(extra, '$.quote_of.quote_of.content_resolved_url') IS NULL
        AND json_extract(extra, '$.quote_of.quote_of.content_resolve_failed_at') IS NULL)
    OR (json_extract(extra, '$.reply_of.quote_of.content') LIKE 'https://t.co/%'
        AND length(json_extract(extra, '$.reply_of.quote_of.content')) < 40
        AND json_extract(extra, '$.reply_of.quote_of.content_resolved_url') IS NULL
        AND json_extract(extra, '$.reply_of.quote_of.content_resolve_failed_at') IS NULL)
    OR (json_extract(extra, '$.retweet_of.quote_of.content') LIKE 'https://t.co/%'
        AND length(json_extract(extra, '$.retweet_of.quote_of.content')) < 40
        AND json_extract(extra, '$.retweet_of.quote_of.content_resolved_url') IS NULL
        AND json_extract(extra, '$.retweet_of.quote_of.content_resolve_failed_at') IS NULL)
  )`;

  const candidates = await env.DB.prepare(
    `SELECT id FROM items
      WHERE source_type='x_list'
        AND is_relevant=1
        AND ${TCO_CANDIDATE}
      ORDER BY scraped_at DESC
      LIMIT ?`,
  ).bind(limit).all<{ id: string }>();

  const remainingRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM items
      WHERE source_type='x_list'
        AND is_relevant=1
        AND ${TCO_CANDIDATE}`,
  ).first<{ n: number }>();

  let processed = 0;
  let totalResolved = 0;
  let totalFailed = 0;
  const errors: Array<{ id: string; reason: string }> = [];

  for (const c of candidates.results) {
    processed++;
    try {
      const r = await resolveTcoLinksForXTweet(env, c.id);
      totalResolved += r.resolved;
      totalFailed += r.failed;
    } catch (e) {
      errors.push({ id: c.id, reason: String(e).slice(0, 200) });
    }
    if (rateSleepMs > 0 && processed < candidates.results.length) {
      await new Promise((r) => setTimeout(r, rateSleepMs));
    }
  }

  return {
    scanned: candidates.results.length,
    processed,
    total_resolved: totalResolved,
    total_failed: totalFailed,
    errors: errors.slice(0, 20),
    remaining: (remainingRow?.n || 0) - processed,
  };
}

/**
 * PR5 backfill (2026-05-21):扫存量 X items 哪些 path 已有 content_resolved_url
 * 匹配 /i/article/<id> 但缺 x_article(未 fetched 也未标 failed)。SB 调用拿
 * detail + author search 写入。
 *
 * 用法:每条 item 内 6 path 各自处理(L1 + L2*3 + L3*3)。fetchXArticlesForXTweet
 * 处理一个 item 内所有 path。
 */
// 2026-05-21 fix(post-PR5):移除 is_relevant=1 filter
// FE 反馈 jxnlco "Getting the most out of Codex"(source_id 2057250417638035555)L1 case
// main content 只是 t.co URL → DeepSeek 分类得 is_relevant=0 → 被原 backfill 漏掉。
// workflow step 1.6 本身没 is_relevant gate(step 1.6 在 step 3 classify 之前跑),
// backfill 应该跟 workflow 行为一致 — 即便 is_relevant=0 也写 x_article 给 FE 渲染。
export async function runBackfillXArticles(
  env: EnrichEnv & { SCRAPEBADGER_API_KEY?: string },
  limit: number,
  rateSleepMs: number = 200,
): Promise<{
  scanned: number;
  processed: number;
  total_fetched: number;
  total_failed: number;
  total_credits: number;
  errors: Array<{ id: string; reason: string }>;
  remaining: number;
}> {
  // 候选:任一 path content_resolved_url 含 /i/article/ + 该 path 缺 x_article(or 标记缺 fetched_at/fail_at)
  const HAS_ARTICLE_NEED_FETCH = `(
    (json_extract(extra, '$.content_resolved_url') LIKE '%/i/article/%'
     AND json_extract(extra, '$.x_article.fetched_at') IS NULL
     AND json_extract(extra, '$.x_article.fetch_failed_at') IS NULL)
    OR (json_extract(extra, '$.quote_of.content_resolved_url') LIKE '%/i/article/%'
        AND json_extract(extra, '$.quote_of.x_article.fetched_at') IS NULL
        AND json_extract(extra, '$.quote_of.x_article.fetch_failed_at') IS NULL)
    OR (json_extract(extra, '$.reply_of.content_resolved_url') LIKE '%/i/article/%'
        AND json_extract(extra, '$.reply_of.x_article.fetched_at') IS NULL
        AND json_extract(extra, '$.reply_of.x_article.fetch_failed_at') IS NULL)
    OR (json_extract(extra, '$.retweet_of.content_resolved_url') LIKE '%/i/article/%'
        AND json_extract(extra, '$.retweet_of.x_article.fetched_at') IS NULL
        AND json_extract(extra, '$.retweet_of.x_article.fetch_failed_at') IS NULL)
    OR (json_extract(extra, '$.quote_of.quote_of.content_resolved_url') LIKE '%/i/article/%'
        AND json_extract(extra, '$.quote_of.quote_of.x_article.fetched_at') IS NULL
        AND json_extract(extra, '$.quote_of.quote_of.x_article.fetch_failed_at') IS NULL)
    OR (json_extract(extra, '$.reply_of.quote_of.content_resolved_url') LIKE '%/i/article/%'
        AND json_extract(extra, '$.reply_of.quote_of.x_article.fetched_at') IS NULL
        AND json_extract(extra, '$.reply_of.quote_of.x_article.fetch_failed_at') IS NULL)
    OR (json_extract(extra, '$.retweet_of.quote_of.content_resolved_url') LIKE '%/i/article/%'
        AND json_extract(extra, '$.retweet_of.quote_of.x_article.fetched_at') IS NULL
        AND json_extract(extra, '$.retweet_of.quote_of.x_article.fetch_failed_at') IS NULL)
  )`;

  const candidates = await env.DB.prepare(
    `SELECT id FROM items
      WHERE source_type='x_list'
        AND ${HAS_ARTICLE_NEED_FETCH}
      ORDER BY scraped_at DESC
      LIMIT ?`,
  ).bind(limit).all<{ id: string }>();

  const remainingRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM items
      WHERE source_type='x_list'
        AND ${HAS_ARTICLE_NEED_FETCH}`,
  ).first<{ n: number }>();

  let processed = 0;
  let totalFetched = 0;
  let totalFailed = 0;
  let totalCredits = 0;
  const errors: Array<{ id: string; reason: string }> = [];

  for (const c of candidates.results) {
    processed++;
    try {
      const r = await fetchXArticlesForXTweet(env, c.id);
      totalFetched += r.fetched;
      totalFailed += r.failed;
      totalCredits += r.credits;
    } catch (e) {
      errors.push({ id: c.id, reason: String(e).slice(0, 200) });
    }
    if (rateSleepMs > 0 && processed < candidates.results.length) {
      await new Promise((r) => setTimeout(r, rateSleepMs));
    }
  }

  return {
    scanned: candidates.results.length,
    processed,
    total_fetched: totalFetched,
    total_failed: totalFailed,
    total_credits: totalCredits,
    errors: errors.slice(0, 20),
    remaining: (remainingRow?.n || 0) - processed,
  };
}

export async function triggerXWorkflowForItem(
  env: { DB: D1Database; X_TWEET_PIPELINE_WORKFLOW?: Workflow },
  itemId: string,
  signals: XWorkflowSignals,
): Promise<'triggered' | 'already_exists' | 'binding_missing' | 'failed'> {
  if (!env.X_TWEET_PIPELINE_WORKFLOW) return 'binding_missing';
  const nowUnix = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      `UPDATE items SET extra = json_set(coalesce(extra, '{}'), '$.workflow_triggered_at', ?) WHERE id = ?`,
    ).bind(nowUnix, itemId).run();
  } catch (e) {
    console.error(`[x-trigger] mark failed for ${itemId}:`, e);
  }
  // 2026-05-17 fix workflow instance reuse:加 hour-bucket suffix,每小时同 item 可重 trigger 新 instance。
  // 之前 instance ID deterministic 导致 stuck old instance 永远阻塞新 trigger(retweet bug + hdx 卡死同病)。
  const hourBucket = new Date().toISOString().slice(0, 13).replace('T', '-'); // YYYY-MM-DD-HH
  const instanceId = `x-${itemId.replace(/[^a-zA-Z0-9-]/g, '-')}-${hourBucket}`;
  try {
    await env.X_TWEET_PIPELINE_WORKFLOW.create({
      id: instanceId,
      params: { itemId, ...signals, lang: 'zh' as const },
    });
    return 'triggered';
  } catch (e) {
    if (String(e).toLowerCase().includes('already exists')) {
      return 'already_exists';
    }
    console.error(`[x-trigger] create failed for ${itemId}:`, e);
    return 'failed';
  }
}
