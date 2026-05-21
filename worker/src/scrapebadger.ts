// ScrapeBadger Twitter API 接入。
// 目的：替代 cdn.syndication.twimg.com 的 refresh-metrics 路径，拿回 syndication
// 不再返回的 retweet_count + view_count（外加全套 favorite/reply/quote/bookmark）。
//
// API base: https://scrapebadger.com/v1
// Auth: x-api-key header
// Pricing: ~1 credit base + 1 per tweet（5 IDs/call 实测扣 6 credits）
// Rate limit: 5 requests/min（响应头 x-ratelimit-{limit,remaining,reset}）
// 响应延迟：3-7s/call（JS 渲染走反爬），所以 cron 每个 tick 只发 1 个 batch 不会撞 30s 上限

import type { Metrics } from './enrich';

const SB_BASE = 'https://scrapebadger.com/v1';
const SB_BATCH_PATH = '/twitter/tweets/'; // GET ?tweets=id1,id2,...

export interface ScrapeBadgerEnv {
  SCRAPEBADGER_API_KEY?: string;
}

interface ScrapeBadgerTweet {
  id: string;
  text?: string;
  full_text?: string;
  favorite_count?: number;
  retweet_count?: number;
  reply_count?: number;
  quote_count?: number;
  view_count?: string | number | null;
  bookmark_count?: number | null;
  quoted_status_id?: string | null;
  retweeted_status_id?: string | null;
  in_reply_to_status_id?: string | null;
}

interface ScrapeBadgerBatchResponse {
  data?: ScrapeBadgerTweet[];
}

export interface ScrapeBadgerBatchResult {
  // 命中的：tweet_id → 解析好的 metrics
  metrics: Map<string, Metrics>;
  // 漏的：API 没返回（已删除 / 私密 / 配额炸）
  missing: string[];
  // API 元数据（用于 cron log + 配额监控）
  creditsUsed?: number;
  rateLimitRemaining?: number;
  durationMs?: number;
  error?: 'no_key' | 'rate_limit' | 'no_credits' | 'http_error' | 'fetch_failed';
  status?: number;
}

function parseIntStrict(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : undefined;
}

function tweetToMetrics(t: ScrapeBadgerTweet): Metrics {
  return {
    replies: parseIntStrict(t.reply_count),
    retweets: parseIntStrict(t.retweet_count),
    likes: parseIntStrict(t.favorite_count),
    bookmarks: parseIntStrict(t.bookmark_count),
    views: parseIntStrict(t.view_count), // view_count 是字符串如 "7344"
  };
}

/**
 * 批量拉 tweets。`ids` 上限按 ScrapeBadger 文档没明说，实测 5 OK；保守 50/批。
 * 调用方负责按 cron tick 节流（rate limit 5/min）。
 */
export async function fetchTweetsScrapeBadger(
  env: ScrapeBadgerEnv,
  ids: string[],
): Promise<ScrapeBadgerBatchResult> {
  if (!env.SCRAPEBADGER_API_KEY) {
    return { metrics: new Map(), missing: ids, error: 'no_key' };
  }
  if (ids.length === 0) {
    return { metrics: new Map(), missing: [] };
  }
  const url = `${SB_BASE}${SB_BATCH_PATH}?tweets=${ids.join(',')}`;
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-api-key': env.SCRAPEBADGER_API_KEY,
        Accept: 'application/json',
      },
    });
  } catch (e) {
    console.error('[scrapebadger] fetch error:', e);
    return {
      metrics: new Map(),
      missing: ids,
      error: 'fetch_failed',
      durationMs: Date.now() - t0,
    };
  }

  const durationMs = Date.now() - t0;
  const creditsUsed = Number(res.headers.get('x-credits-used')) || undefined;
  const rateLimitRemaining =
    Number(res.headers.get('x-ratelimit-remaining')) || undefined;

  if (res.status === 402) {
    console.warn('[scrapebadger] 402 no credits');
    return {
      metrics: new Map(),
      missing: ids,
      error: 'no_credits',
      status: 402,
      creditsUsed,
      rateLimitRemaining,
      durationMs,
    };
  }
  if (res.status === 429) {
    console.warn('[scrapebadger] 429 rate limit; remaining', rateLimitRemaining);
    return {
      metrics: new Map(),
      missing: ids,
      error: 'rate_limit',
      status: 429,
      creditsUsed,
      rateLimitRemaining,
      durationMs,
    };
  }
  if (!res.ok) {
    console.warn(`[scrapebadger] HTTP ${res.status}`);
    return {
      metrics: new Map(),
      missing: ids,
      error: 'http_error',
      status: res.status,
      creditsUsed,
      rateLimitRemaining,
      durationMs,
    };
  }

  let body: ScrapeBadgerBatchResponse;
  try {
    body = (await res.json()) as ScrapeBadgerBatchResponse;
  } catch (e) {
    console.error('[scrapebadger] json parse:', e);
    return {
      metrics: new Map(),
      missing: ids,
      error: 'http_error',
      status: res.status,
      creditsUsed,
      rateLimitRemaining,
      durationMs,
    };
  }

  const metrics = new Map<string, Metrics>();
  for (const t of body.data || []) {
    if (t.id) metrics.set(t.id, tweetToMetrics(t));
  }
  const missing = ids.filter((id) => !metrics.has(id));
  return {
    metrics,
    missing,
    creditsUsed,
    rateLimitRemaining,
    durationMs,
  };
}

// ─── List timeline 抓取（替代本地 chrome 抓取） ──────────────────
// GET /v1/twitter/lists/{list_id}/tweets?cursor=...
// 一次 ~20 条 tweet（页大小未文档化，但实测约 20）；带 cursor 可翻页。
// 调用方决定何时停（典型策略：碰到已经在 DB 里的 ID 就 break，节省 credits）。

const SB_LIST_PATH_PREFIX = '/twitter/lists/'; // /{list_id}/tweets

// 完整 tweet 形状（list 端点和 by-ids 端点字段一致；这里把 by-ids 隐式接口
// 提升为对外 export，list-poll 路径要用全套字段不止 metrics）。
export interface SbTweet {
  id: string;
  text?: string;
  full_text?: string;
  created_at?: string;
  lang?: string;
  user_id?: string;
  username?: string;
  user_name?: string;
  user_profile_image_url?: string;
  user_is_blue_verified?: boolean;
  user_verified?: boolean;
  favorite_count?: number;
  retweet_count?: number;
  reply_count?: number;
  quote_count?: number;
  view_count?: string | number | null;
  bookmark_count?: number | null;
  is_quote_status?: boolean;
  is_retweet?: boolean;
  conversation_id?: string;
  in_reply_to_status_id?: string | null;
  in_reply_to_user_id?: string | null;
  in_reply_to_screen_name?: string | null;
  display_text_range?: number[];
  media?: Array<{
    media_key?: string;
    type?: string;
    url?: string;
    preview_image_url?: string | null;
    width?: number | null;
    height?: number | null;
  }>;
  urls?: Array<{ url?: string; expanded_url?: string | null; display_url?: string | null }>;
  hashtags?: Array<{ text?: string }>;
  user_mentions?: Array<{ id?: string; username?: string; name?: string }>;
  quoted_status_id?: string | null;
  retweeted_status_id?: string | null;
  has_card?: boolean;
  thumbnail_url?: string | null;
  thumbnail_title?: string | null;
}

interface ScrapeBadgerListPageResponse {
  data?: SbTweet[];
  next_cursor?: string | null;
}

export interface ScrapeBadgerListPageResult {
  tweets: SbTweet[];
  nextCursor: string | null;
  creditsUsed?: number;
  rateLimitRemaining?: number;
  durationMs?: number;
  error?: 'no_key' | 'rate_limit' | 'no_credits' | 'http_error' | 'fetch_failed';
  status?: number;
}

// ─── SB tweet → 我们 items 表的 ingest 形状映射 ─────────────────
// 与本地 list_scraper.py + tweet_processor.py 输出对齐，让现有 ingest /
// fill-translations / detect-longform / backfill-quotes 等下游 cron 沿用。
//
// 决策（用户拍板）：
//   - 列表本身已是 user-curated，全部 is_relevant=1，不再 inline LLM 过滤
//   - RT 也进 feed（X 转推 / Twitter retweet），覆盖原 chrome scraper 盲区
//   - matched_by='list-poll-sb' 标记来源便于回查
//   - long_form：SB 直接返 full_text（never truncated），content 放 full_text，
//     detect-longform cron 不会再补这条（length 已是真实长度）

export interface IngestItem {
  source_type: 'x_list';
  source_id: string;
  title: null;
  content: string;
  content_translated: null;
  author: string | null;
  handle: string | null;
  url: string | null;
  media: string;
  metrics: string;
  published_at: string | null;
  scraped_at: string;
  // is_relevant=NULL：等 classify-pending cron 跑 DeepSeek 判定，
  // 命中(=1)再走 fill-translations cron。是这里**一定要 null** 而不是 1，
  // 否则 dashboard feed 直接展示未分类内容。
  is_relevant: number | null;
  matched_by: string;
  lang: string | null;
  extra: string;
}

// X created_at 形如 "Tue May 05 23:16:48 +0000 2026"。JS Date() 能直接 parse。
// 输出 D1 datetime 友好的 "YYYY-MM-DD HH:MM:SS"（其它 cron 拿这个字段做对齐）。
function twitterDateToD1(s?: string): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function nowD1(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// SB media[] 形状 → 现有 MediaItem 形状
// SB type: 'photo' | 'video' | 'animated_gif'
// 我们：'image' | 'video'，video 带 poster
function mapMedia(
  m: NonNullable<SbTweet['media']>,
  tweetMp4?: string, // 这个 tweet 的最佳 mp4 url（syndication 兜底拿的，per-tweet 粒度）
): Array<Record<string, unknown>> {
  let mp4Used = false;
  return (m || []).map((x) => {
    const type = x.type === 'photo' ? 'image' : x.type === 'video' || x.type === 'animated_gif' ? 'video' : x.type || 'image';
    // 视频：默认 url 是 SB 给的 thumbnail jpg（无法播放）。
    // 第一个 video item 用 mp4 覆盖；多 video 推罕见，余下 fallback thumbnail。
    let finalUrl = x.url;
    if (type === 'video' && tweetMp4 && !mp4Used) {
      finalUrl = tweetMp4;
      mp4Used = true;
    }
    return {
      type,
      url: finalUrl,
      width: x.width ?? null,
      height: x.height ?? null,
      alt: null,
      poster: type === 'video' ? x.preview_image_url ?? x.url ?? null : null,
    };
  });
}

export function sbTweetToIngestItem(t: SbTweet, videoMp4Override?: Map<string, string>): IngestItem | null {
  if (!t.id) return null;
  const handle = t.username || null;
  const author = t.user_name || null;

  const metrics = {
    replies: t.reply_count,
    retweets: t.retweet_count,
    likes: t.favorite_count,
    views: parseIntStrict(t.view_count),
    bookmarks: t.bookmark_count,
  };

  const extra: Record<string, unknown> = {};
  if (t.quoted_status_id) extra.quote_of_id = t.quoted_status_id;
  if (t.in_reply_to_status_id) extra.reply_to_id = t.in_reply_to_status_id;
  if (t.in_reply_to_user_id) extra.reply_to_user_id = t.in_reply_to_user_id;
  if (t.in_reply_to_screen_name) extra.reply_to_handle = t.in_reply_to_screen_name;
  if (t.is_retweet) extra.is_retweet = true;
  if (t.retweeted_status_id) extra.retweeted_status_id = t.retweeted_status_id;
  if (t.is_quote_status) extra.is_quote_status = true;
  if (t.user_is_blue_verified) extra.is_verified = true;
  if (t.user_profile_image_url) extra.profile_image_url = t.user_profile_image_url;
  if (t.has_card && t.thumbnail_title) extra.card_title = t.thumbnail_title;
  if (t.thumbnail_url) extra.card_thumbnail = t.thumbnail_url;
  if (t.hashtags && t.hashtags.length) extra.hashtags = t.hashtags.map((h) => h.text).filter(Boolean);
  if (t.user_mentions && t.user_mentions.length) {
    extra.user_mentions = t.user_mentions.map((m) => m.username).filter(Boolean);
  }
  if (t.urls && t.urls.length) {
    const expanded = t.urls.map((u) => u.expanded_url).filter(Boolean);
    if (expanded.length) extra.urls = expanded;
  }

  return {
    source_type: 'x_list',
    source_id: t.id,
    title: null,
    content: t.full_text || t.text || '',
    content_translated: null,
    author,
    handle,
    url: handle ? `https://x.com/${handle}/status/${t.id}` : null,
    media: JSON.stringify(mapMedia(t.media || [], t.id ? videoMp4Override?.get(t.id) : undefined)),
    metrics: JSON.stringify(metrics),
    published_at: twitterDateToD1(t.created_at),
    scraped_at: nowD1(),
    is_relevant: null,
    matched_by: 'list-poll-sb',
    lang: t.lang || null,
    extra: JSON.stringify(extra),
  };
}

export async function fetchListTweetsPage(
  env: ScrapeBadgerEnv,
  listId: string,
  cursor?: string | null,
): Promise<ScrapeBadgerListPageResult> {
  if (!env.SCRAPEBADGER_API_KEY) {
    return { tweets: [], nextCursor: null, error: 'no_key' };
  }
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  const url = `${SB_BASE}${SB_LIST_PATH_PREFIX}${encodeURIComponent(listId)}/tweets${qs}`;
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-api-key': env.SCRAPEBADGER_API_KEY,
        Accept: 'application/json',
      },
    });
  } catch (e) {
    console.error('[scrapebadger.list] fetch error:', e);
    return { tweets: [], nextCursor: null, error: 'fetch_failed', durationMs: Date.now() - t0 };
  }

  const durationMs = Date.now() - t0;
  const creditsUsed = Number(res.headers.get('x-credits-used')) || undefined;
  const rateLimitRemaining = Number(res.headers.get('x-ratelimit-remaining')) || undefined;

  if (res.status === 402) {
    return { tweets: [], nextCursor: null, error: 'no_credits', status: 402, creditsUsed, rateLimitRemaining, durationMs };
  }
  if (res.status === 429) {
    return { tweets: [], nextCursor: null, error: 'rate_limit', status: 429, creditsUsed, rateLimitRemaining, durationMs };
  }
  if (!res.ok) {
    return { tweets: [], nextCursor: null, error: 'http_error', status: res.status, creditsUsed, rateLimitRemaining, durationMs };
  }

  let body: ScrapeBadgerListPageResponse;
  try {
    body = (await res.json()) as ScrapeBadgerListPageResponse;
  } catch (e) {
    console.error('[scrapebadger.list] json parse:', e);
    return { tweets: [], nextCursor: null, error: 'http_error', status: res.status, creditsUsed, rateLimitRemaining, durationMs };
  }

  return {
    tweets: body.data || [],
    nextCursor: body.next_cursor ?? null,
    creditsUsed,
    rateLimitRemaining,
    durationMs,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// X Article 抓取(2026-05-21):配合 PR #99 t.co resolve,把 /i/article/<id>
// 的内容 + author 写入 extra.{path}.x_article。
//
// SB endpoint:
// - GET /v1/twitter/tweets/article/{article_id} 拿 title/preview_text/body/cover
// - GET /v1/twitter/tweets/advanced_search?query=<article_id> 拿 article tweet
//   (author 不在 article detail response 里,要 search 反查)
//
// Cost: 2 credits/article (detail + search)。0.15 USD / 1000 credit = $0.00003/article。
// 老 article(~5+天) detail 返 null content 是正常的(X 反索引/已删),
// search 即便 detail null 也能返 author tweet → 降级 link card 也能显示 author。
// ═══════════════════════════════════════════════════════════════════════════

const SB_ARTICLE_DETAIL_PATH = '/twitter/tweets/article/'; // GET /<article_id>
const SB_ADVANCED_SEARCH_PATH = '/twitter/tweets/advanced_search'; // GET ?query=...

export interface XArticleDetail {
  article_id: string;
  title: string | null;
  excerpt: string | null;       // preview_text(SB) 或 body[:200] 截断
  cover_image_url: string | null;
  summary_text: string | null;  // bonus: Grok 5-bullet,可空
  created_at: string | null;
  // author 字段单独 search 获取
}

export interface XArticleAuthor {
  user_id: string | null;
  username: string | null; // handle 不带 @
  user_name: string | null; // 显示名
}

export interface XArticleFetchResult {
  ok: boolean;
  detail: XArticleDetail | null;
  author: XArticleAuthor | null;
  detail_credits: number;
  search_credits: number;
  reason?: 'no_key' | 'detail_http' | 'detail_null_content' | 'search_http' | 'fetch_failed';
}

async function fetchXArticleDetail(
  env: ScrapeBadgerEnv,
  articleId: string,
): Promise<{ detail: XArticleDetail | null; credits: number; reason?: string }> {
  if (!env.SCRAPEBADGER_API_KEY) {
    return { detail: null, credits: 0, reason: 'no_key' };
  }
  const url = `${SB_BASE}${SB_ARTICLE_DETAIL_PATH}${encodeURIComponent(articleId)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { 'x-api-key': env.SCRAPEBADGER_API_KEY, Accept: 'application/json' },
    });
  } catch (e) {
    console.warn(`[sb-article] detail fetch error ${articleId}:`, e);
    return { detail: null, credits: 0, reason: 'detail_http' };
  }
  const credits = Number(res.headers.get('x-credits-used')) || 0;
  if (!res.ok) {
    return { detail: null, credits, reason: 'detail_http' };
  }
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return { detail: null, credits, reason: 'detail_http' };
  }
  const title = (body.title as string | null) || null;
  // title null = SB 没拿到内容(老 article 反索引 / 已删) — 标 detail_null_content,caller 决定是否仍 search author
  if (!title) {
    return { detail: null, credits, reason: 'detail_null_content' };
  }
  // excerpt: 优先 preview_text,fallback body 前 200 字
  let excerpt = (body.preview_text as string | null) || null;
  if (!excerpt && typeof body.body === 'string') {
    excerpt = (body.body as string).slice(0, 200);
  }
  return {
    detail: {
      article_id: articleId,
      title,
      excerpt,
      cover_image_url: (body.cover_image_url as string | null) || (body.cover_media_url as string | null) || null,
      summary_text: (body.summary_text as string | null) || null,
      created_at: (body.created_at as string | null) || null,
    },
    credits,
  };
}

async function fetchXArticleAuthor(
  env: ScrapeBadgerEnv,
  articleId: string,
): Promise<{ author: XArticleAuthor | null; credits: number; reason?: string }> {
  if (!env.SCRAPEBADGER_API_KEY) {
    return { author: null, credits: 0, reason: 'no_key' };
  }
  // advanced_search 用 article_id 当 query 找 article tweet — 第一条结果的 author 就是真作者
  const url = `${SB_BASE}${SB_ADVANCED_SEARCH_PATH}?query=${encodeURIComponent(articleId)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { 'x-api-key': env.SCRAPEBADGER_API_KEY, Accept: 'application/json' },
    });
  } catch (e) {
    console.warn(`[sb-article] author search error ${articleId}:`, e);
    return { author: null, credits: 0, reason: 'search_http' };
  }
  const credits = Number(res.headers.get('x-credits-used')) || 0;
  if (!res.ok) {
    return { author: null, credits, reason: 'search_http' };
  }
  let body: { data?: Array<Record<string, unknown>> };
  try {
    body = (await res.json()) as { data?: Array<Record<string, unknown>> };
  } catch {
    return { author: null, credits, reason: 'search_http' };
  }
  const first = body.data?.[0];
  if (!first) {
    return { author: null, credits };
  }
  return {
    author: {
      user_id: (first.user_id as string | null) || null,
      username: (first.username as string | null) || null,
      user_name: (first.user_name as string | null) || null,
    },
    credits,
  };
}

/**
 * 拉 X article 完整信息(detail + author)。失败 graceful return ok=false + reason。
 * Caller 决定是否仍 write fetched_at(成功)或 fetch_failed_at(失败)。
 * 即便 detail null,author 仍尝试 search — 老 article 没正文但能显示 "X 文章 by @xxx"。
 */
export async function fetchXArticleViaSb(
  env: ScrapeBadgerEnv,
  articleId: string,
): Promise<XArticleFetchResult> {
  if (!env.SCRAPEBADGER_API_KEY) {
    return { ok: false, detail: null, author: null, detail_credits: 0, search_credits: 0, reason: 'no_key' };
  }
  const detailRes = await fetchXArticleDetail(env, articleId);
  const authorRes = await fetchXArticleAuthor(env, articleId);
  return {
    ok: !!detailRes.detail, // 只有 detail 拿到才算 ok;detail null + author 有的情况算 partial(reason: detail_null_content)
    detail: detailRes.detail,
    author: authorRes.author,
    detail_credits: detailRes.credits,
    search_credits: authorRes.credits,
    reason: detailRes.reason as XArticleFetchResult['reason'],
  };
}

const X_ARTICLE_URL_RE = /^https?:\/\/(?:www\.)?x\.com\/i\/article\/(\d+)/i;

export function extractXArticleId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(X_ARTICLE_URL_RE);
  return m ? m[1] : null;
}
